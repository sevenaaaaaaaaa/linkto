import { ImapFlow, ListResponse } from 'imapflow'
import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import type { AccountConfig, Address, Folder, MessageCategory, SpecialFolder } from '@shared/types'
import type { MailStore, MessageInsert } from '../db'
import type { AppStore } from '../store'
import { DEFAULT_GENERAL } from '../store'
import { heuristicClassify, normalizeSubject } from './classify'
import { evalRules } from '../rules/engine'
import { isNotifiableArrival } from '../notify-policy'
import { parseEmailRaw } from './parse-pool'
import type { FolderPref, Rule, RuleAction } from '@shared/types'
import { isTodoSyncFolder } from '../todo-sync/protocol'
import { isTraceSyncFolder } from '@shared/trace'
import { isVaultFolder } from '../devsync/protocol'

const SEP = '::'
export const folderIdOf = (accountId: string, path: string) => `${accountId}${SEP}${path}`
export const messageIdOf = (accountId: string, folderPath: string, uid: number) =>
  `${accountId}${SEP}${folderPath}${SEP}${uid}`

const SPECIAL_MAP: Record<string, SpecialFolder> = {
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\all': 'all',
  '\\archive': 'archive',
  '\\flagged': null
}

const NAME_HEURISTICS: [RegExp, SpecialFolder][] = [
  [/^(sent|sent messages|sent items|已发送|已发送邮件)$/i, 'sent'],
  [/^(drafts?|草稿箱?|草稿)$/i, 'drafts'],
  [/^(trash|deleted( items| messages)?|废纸篓|已删除)$/i, 'trash'],
  [/^(junk|spam|垃圾邮件|垃圾)$/i, 'junk'],
  [/^(all mail|所有邮件)$/i, 'all'],
  [/^(archive|归档)$/i, 'archive']
]

/** 轻量轮询间隔（仅收件箱；IDLE 推送失效时的兜底） */
const POLL_MS = 30_000
/** 完整同步间隔（LIST + 全部文件夹 + 删除对账 + 历史回填） */
const FULL_SYNC_MS = 5 * 60_000
/** 单次 FETCH 的 UID 数：分片落库，断线只丢当前片 */
const FETCH_CHUNK = 100
/** 每轮完整同步回填的历史邮件数 */
const BACKFILL_CHUNK = 200
/** 本地保留的历史上限（收件箱 / 其他文件夹） */
const backfillLimit = (special: SpecialFolder) => (special === 'inbox' ? 5000 : 1000)
/** 看门狗：同步活动超过此时长无进展即强制重连 */
const STALL_MS = 3 * 60_000

function specialFor(f: { path: string; specialUse?: string | boolean }): SpecialFolder {
  if (f.path.toUpperCase() === 'INBOX') return 'inbox'
  const su = typeof f.specialUse === 'string' ? f.specialUse.toLowerCase() : ''
  if (su && su in SPECIAL_MAP) return SPECIAL_MAP[su]
  const name = f.path.split(/[/.]/).pop() ?? f.path
  for (const [re, sp] of NAME_HEURISTICS) if (re.test(name)) return sp
  return null
}

function headersToPlain(headers: Map<string, unknown> | Buffer | undefined): Record<string, string> {
  if (!headers) return {}
  if (Buffer.isBuffer(headers)) return parseRawHeaders(headers)
  const out: Record<string, string> = {}
  for (const [k, v] of headers) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : ''
  }
  return out
}

/** 解析原始头（含折行延续），供 envelope 批量抓取时使用 */
function parseRawHeaders(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = buf.toString('utf8').split(/\r?\n/)
  let lastKey = ''
  for (const line of lines) {
    if (/^[ \t]/.test(line) && lastKey) {
      out[lastKey] += ' ' + line.trim()
      continue
    }
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    out[key] = line.slice(idx + 1).trim()
    lastKey = key
  }
  return out
}

function addrList(entries: { name?: string; address?: string }[] | undefined): Address[] {
  return (entries ?? [])
    .filter(e => e.address)
    .map(e => ({ name: e.name, address: e.address! }))
}

interface EnvelopeData {
  uid: number
  flags: string[]
  size: number
  date: number
  subject: string
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  from: Address | null
  to: Address[]
  cc: Address[]
  replyTo: Address | null
  headers: Record<string, string>
  attachmentCount: number
  /** BODYSTRUCTURE 里的附件元数据（附件中心为未下载的附件建索引） */
  attachmentParts: AttachmentPart[]
}

/** 附件元数据（来自 IMAP BODYSTRUCTURE，不下载正文） */
export interface AttachmentPart {
  part: string
  filename: string
  contentType: string
  /** 估算的解码后大小（base64 按 3/4 折算） */
  size: number
  inline: boolean
  contentId: string | null
}

export interface SyncEvents {
  status(accountId: string, status: 'connected' | 'syncing' | 'error' | 'disabled', text: string): void
  progress(accountId: string, text: string): void
  changed(accountId?: string): void
  newMail(accountId: string, messageId: string, subject: string, from: string, category: string): void
  /** 新到达的收件箱邮件（不含首次同步/历史回填）：执行规则动作、AI 条件规则 */
  arrived(accountId: string, messageId: string, ruleActions: RuleAction[]): void
  /** 待办同步文件夹（LinkTo-Sync）在选中期间收到 EXISTS：其他设备写入了新版本 */
  todoSyncExists?(accountId: string): void
  /** 新入库邮件的附件元数据（BODYSTRUCTURE）：附件中心据此为尚未下载的附件建索引 */
  attachmentParts?(accountId: string, messageId: string, parts: AttachmentPart[]): void
}

/** 单账户 IMAP 工作线程：连接、文件夹、增量同步、按需正文、命令 */
export class AccountWorker {
  private client: ImapFlow | null = null
  private running = true
  private queue: Promise<unknown> = Promise.resolve()
  private bodyQueue: { folderPath: string; uid: number; messageId: string | null; attempt?: number }[] = []
  private bodyQueued = new Set<string>()
  private processingBody = false
  private cycle = 0
  private rules: Rule[] = []
  /** 文件夹偏好读取器（sync=false 的文件夹只登记不同步；收件箱永远同步） */
  private getFolderPrefs: () => Record<string, FolderPref> = () => ({})
  /** 上次完整同步时间；0 表示下一轮必须完整同步 */
  private lastFullSync = 0
  /** IDLE 收到 EXPUNGE：下一轮收件箱同步需要做删除对账 */
  private expungeSeen = false
  /** 主动断线重连（唤醒/手动刷新）：本次断开不算错误，不退避 */
  private reconnecting = false
  /** 历史已回填完毕的文件夹（进程内缓存，重启后重新判断） */
  private backfillDone = new Set<string>()
  /** All Mail 路径（不同步，但 Gmail 归档 = 移入 All Mail） */
  private allMailPath: string | null = null

  constructor(
    public readonly account: { id: string; name: string; email: string; user: string },
    private imap: { host: string; port: number; secure: boolean },
    private store: MailStore,
    private appStore: AppStore,
    private events: SyncEvents,
    /** OAuth 账户：取有效 access token（force=true 表示认证失败后强制刷新重试）；空则走密码 */
    private getToken?: (accountId: string, force?: boolean) => Promise<string>
  ) {}

  setRules(rules: Rule[]) {
    this.rules = rules
  }

  setFolderPrefsGetter(getter: () => Record<string, FolderPref>) {
    this.getFolderPrefs = getter
  }

  start() {
    this.loop().catch(() => {})
  }

  stop() {
    this.running = false
    this.stopWatchdog()
    this.client?.close()
  }

  /** 立即完整同步（手动刷新）：已连接则直接跑一轮，退避等待中则马上重连 */
  syncNow() {
    this.lastFullSync = 0
    this.kickSync()
  }

  /** 丢弃当前连接并立刻重连（系统唤醒/网络切换后旧 socket 多半已半死，等超时太久） */
  reconnect() {
    if (!this.running) return
    const client = this.client
    this.lastFullSync = 0
    this.kickSync()
    if (!client) return
    this.reconnecting = true
    this.client = null
    try { client.close() } catch { /* ignore */ }
  }

  private async loop() {
    let backoff = 3000
    let forceRefresh = false
    while (this.running) {
      try {
        this.events.status(this.account.id, 'syncing', '连接中…')
        await this.connect(forceRefresh)
        forceRefresh = false
        this.reconnecting = false
        this.startWatchdog()
        this.events.status(this.account.id, 'syncing', '同步中…')
        await this.runCycle(true)
        backoff = 3000
        while (this.running && this.client?.usable) {
          await this.sleepInterruptible(POLL_MS)
          if (!this.running || !this.client?.usable) break
          this.kickRequested = false
          await this.runCycle(Date.now() - this.lastFullSync >= FULL_SYNC_MS)
        }
        // 服务器主动断开：稍等再连，避免「连上即被踢」时空转
        if (this.running && !this.reconnecting) await this.sleepInterruptible(2000)
      } catch (err) {
        if (!this.running) return
        this.stopWatchdog()
        const old = this.client
        this.client = null
        try { old?.close() } catch { /* ignore */ }
        if (this.reconnecting) {
          // 主动重连：不报错、不退避
          this.reconnecting = false
          this.kickRequested = false
          continue
        }
        const msg = err instanceof Error ? err.message : String(err)
        // OAuth 认证失败 → 下次强制刷新 token 重试；密码错误则原样提示
        if (this.getToken && /auth|login|credentials|invalid|AUTHENTICATE/i.test(msg)) forceRefresh = true
        this.events.status(this.account.id, 'error', this.describeError(err))
        // 服务器限流（Gmail 常见）：退避拉长，避免越重试越被限
        if (/THROTTLED|bandwidth|too many|rate limit|OVERQUOTA/i.test(msg)) backoff = Math.max(backoff, 5 * 60_000)
        this.kickRequested = false
        await this.sleepInterruptible(backoff)
        this.kickRequested = false
        backoff = Math.min(backoff * 2, 5 * 60_000)
      }
    }
    this.stopWatchdog()
  }

  /** 一轮同步：完整轮次刷新全部文件夹，否则只看收件箱；结束后回到 INBOX 让 IDLE 盯住新邮件 */
  private async runCycle(full: boolean) {
    this.touchActivity()
    if (full) {
      await this.syncAllFolders()
      this.lastFullSync = Date.now()
    } else {
      const reconcile = this.expungeSeen
      this.expungeSeen = false
      await this.syncInbox(reconcile)
    }
    await this.replayPendingOps()
    this.requeueMissingBodies()
    await this.watchInbox()
    this.events.status(this.account.id, 'connected', '已连接')
  }

  private describeError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err)
    const local = /^(127\.0\.0\.1|localhost|::1)$/i.test(this.imap.host)
    if (local && /ECONNREFUSED|ECONNRESET|closed/i.test(msg))
      return '本地 IMAP 桥未运行（如 Proton Mail Bridge）：请先启动 Bridge，林可兔会自动重连'
    return friendlyError(err)
  }

  private async connect(tryForceRefresh = false) {
    let auth: { user: string; pass?: string; accessToken?: string }
    if (this.getToken) {
      try {
        auth = { user: this.account.user, accessToken: await this.getToken(this.account.id, tryForceRefresh) }
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err))
      }
    } else {
      const pass = this.appStore.loadSecret(`acct:${this.account.id}`)
      if (!pass) throw new Error('未找到登录凭证，请重新输入密码')
      auth = { user: this.account.user, pass }
    }
    const client = new ImapFlow({
      host: this.imap.host,
      port: this.imap.port,
      secure: this.imap.secure,
      auth,
      logger: false,
      tls: { rejectUnauthorized: false },
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      // IDLE 每 4 分钟重发一次（保活 NAT/防服务器踢 IDLE），所以 10 分钟无数据即可判定 socket 已死
      socketTimeout: 10 * 60_000,
      maxIdleTime: 4 * 60_000,
      // RFC 2971 ID：163/126 等 Coremail 不识别客户端会拒绝 SELECT（Unsafe Login）
      clientInfo: { name: 'LinkTo', vendor: 'LinkTo', version: app.getVersion() }
    })
    const isInbox = (path?: string) => path?.toUpperCase() === 'INBOX'
    client.on('exists', (e: { path?: string }) => {
      if (isInbox(e.path) && this.running) this.kickSync()
      else if (isTodoSyncFolder(e.path) && this.running) this.events.todoSyncExists?.(this.account.id)
    })
    client.on('expunge', (e: { path?: string }) => {
      if (isInbox(e.path) && this.running) {
        this.expungeSeen = true
        this.kickSync()
      }
    })
    client.on('flags', (e: { path?: string }) => {
      if (isInbox(e.path) && this.running) this.kickSync()
    })
    // 连接意外关闭：唤醒主循环立即重连，而不是睡满轮询间隔
    client.on('close', () => {
      if (this.client === client && this.running) this.kickSync()
    })
    // ImapFlow 的套接字错误（含超时）是异步 emit 的 error 事件，不走任何被 await 的 promise，
    // 不挂监听会以 uncaughtException 击穿主进程；这里兜住事件并断开，重连交给主循环的 backoff
    client.on('error', () => {
      try { client.close() } catch { /* ignore */ }
    })
    await client.connect()
    this.client = client
  }

  private kickRequested = false
  /** 新邮件踢同步：只置标志，由主循环可中断 sleep 提前醒来执行（避免与 loop 并发 SELECT 穿插） */
  private kickSync() {
    this.kickRequested = true
  }

  /** 看门狗：同步活动超过 STALL_MS 无进展 → 强制断线重连（兜底任何未知挂起，绝不永久卡死） */
  private watchdogTimer: NodeJS.Timeout | null = null
  private lastActivity = 0
  private busy = false
  private touchActivity() {
    this.lastActivity = Date.now()
  }
  private startWatchdog() {
    this.stopWatchdog()
    this.lastActivity = Date.now()
    this.busy = true
    this.watchdogTimer = setInterval(() => {
      if (this.busy && Date.now() - this.lastActivity > STALL_MS) {
        try { this.client?.close() } catch { /* ignore */ }
      }
    }, 30_000)
  }
  private stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  /** 分片 sleep：running=false 或 kick 立即返回 */
  private async sleepInterruptible(ms: number) {
    this.busy = false
    const step = 500
    let waited = 0
    while (waited < ms && this.running && !this.kickRequested) {
      await sleep(Math.min(step, ms - waited))
      waited += step
    }
    this.busy = true
    this.touchActivity()
  }

  /** 所有操作经此串行化，避免与同步循环争用 */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  // ---------- 文件夹与同步 ----------

  private async searchUids(query: Record<string, unknown>): Promise<number[]> {
    const client = this.client
    if (!client) throw new Error('not connected')
    const res = await client.search(query, { uid: true })
    return ((res || []) as number[]).map(Number).sort((a, b) => a - b)
  }

  /** 选中 INBOX 并留在那里：ImapFlow 自动 IDLE 只监听当前选中的文件夹 */
  private async watchInbox() {
    const client = this.client
    if (!client?.usable) return
    const lock = await client.getMailboxLock('INBOX')
    lock.release()
  }

  private async syncInbox(reconcile: boolean) {
    await this.syncFolder('INBOX', 'inbox', reconcile)
    this.cycle++
    this.events.changed(this.account.id)
  }

  private async syncAllFolders() {
    const client = this.client
    if (!client) throw new Error('not connected')
    const folders = await client.list()
    this.touchActivity()
    let order = 0
    const priority: Record<string, number> = { inbox: 0, sent: 1, archive: 2, all: 3, junk: 4, trash: 5, drafts: 6, null: 7 }
    const sorted = [...folders].sort(
      (a, b) => (priority[String(specialFor(a))] ?? 9) - (priority[String(specialFor(b))] ?? 9)
    )
    const seen = new Set<string>()
    const failed: string[] = []
    // 每轮完整同步重新读取文件夹偏好（用户在 UI 中关闭同步后下一轮即生效）
    let prefs: Record<string, FolderPref> = {}
    try {
      prefs = this.getFolderPrefs()
    } catch { /* 偏好读取失败按全部同步处理 */ }
    for (const f of sorted) {
      if (!this.running) return
      this.touchActivity()
      const special = specialFor(f)
      const id = folderIdOf(this.account.id, f.path)
      seen.add(id)
      // Gmail 的 Starred(\\Flagged) / Important 只是标签视图，同步会让邮件重复出现
      const virtual = f.specialUse === '\\Flagged' || f.flags?.has('\\Important')
      if (special === 'all') this.allMailPath = f.path
      // 待办同步的隐藏文件夹：不当邮件同步、不进侧栏 / 文件夹管理（顺带清掉可能存在的旧行）
      if (special === 'drafts' || special === 'all' || virtual || isTodoSyncFolder(f.path) || isTraceSyncFolder(f.path) || isVaultFolder(f.path)) {
        // 本地管理草稿；All Mail 与其他文件夹重复，不同步（顺带清掉旧版本误同步的副本）
        this.store.deleteFolder(id)
        continue
      }
      const name = f.path.toUpperCase() === 'INBOX' ? '收件箱' : f.path.split(/[/.]/).pop() || f.path
      // UIDVALIDITY 以 SELECT 返回为准（syncFolder 内处理），这里沿用已存值，避免 STATUS 偶发失败把游标清零
      this.store.upsertFolder({
        id,
        accountId: this.account.id,
        path: f.path,
        name,
        special,
        sortOrder: order++,
        hidden: false,
        uidValidity: this.store.getFolderLastSync(id).uidValidity
      })
      // Gmail 的 [Gmail]、Proton 的 Folders/Labels 等容器不可 SELECT，强行进入会让整轮同步失败
      if (f.flags?.has('\\Noselect') || f.flags?.has('\\NonExistent')) continue
      // 用户关闭同步的文件夹：保留文件夹行，跳过拉取（收件箱不可关闭）
      if (special !== 'inbox' && prefs[id]?.sync === false) continue
      try {
        await this.syncFolder(f.path, special, true)
      } catch (err) {
        // 单个文件夹出错不拖垮整轮；连接已坏或收件箱失败才交给主循环重连
        if (!client.usable || special === 'inbox') throw err
        failed.push(f.path)
      }
    }
    // 服务器上已删除/改名的文件夹：本地同步移除（列表异常为空时不动，防误删）
    if (seen.has(folderIdOf(this.account.id, 'INBOX')) || folders.some(f => f.path.toUpperCase() === 'INBOX')) {
      for (const row of this.store.listFolders()) {
        if (row.accountId === this.account.id && !seen.has(row.id)) this.store.deleteFolder(row.id)
      }
    }
    if (failed.length) this.events.progress(this.account.id, `${failed.length} 个文件夹暂时同步失败，稍后自动重试`)
    this.cycle++
    this.events.changed(this.account.id)
  }

  /**
   * 同步单个文件夹。不依赖 SELECT 时的 UIDNEXT（INBOX 常驻选中时它不会刷新），
   * 一律用 UID SEARCH 取新邮件；full=true 时额外做删除对账与历史回填。
   */
  private async syncFolder(path: string, special: SpecialFolder, full: boolean) {
    const client = this.client
    if (!client) return
    const fid = folderIdOf(this.account.id, path)
    const lock = await client.getMailboxLock(path)
    try {
      const mailbox = client.mailbox
      if (!mailbox || typeof mailbox === 'boolean') return
      this.touchActivity()
      const prev = this.store.getFolderLastSync(fid)
      let last = prev.lastSyncUid
      const validity = Number(mailbox.uidValidity ?? 0)
      if (validity && validity !== prev.uidValidity) {
        if (prev.uidValidity) {
          // UID 被服务器整体重编号（Proton Bridge 重建缓存时常见）：本地按旧 UID 存的邮件全部作废，重新拉
          this.store.clearFolderMessages(fid)
          this.backfillDone.delete(fid)
          last = 0
          this.store.setFolderLastSync(fid, 0)
        }
        this.store.setFolderUidValidity(fid, validity)
      }

      let serverUids: number[] | null = null
      let newUids: number[]
      if (last === 0) {
        serverUids = await this.searchUids({ all: true })
        newUids = serverUids.slice(-(special === 'inbox' ? 300 : 150))
      } else {
        newUids = (await this.searchUids({ uid: `${last + 1}:*` })).filter(u => u > last)
      }
      if (newUids.length) {
        this.events.progress(this.account.id, `${path} +${newUids.length}`)
        await this.fetchEnvelopes(path, special, newUids, true)
      }

      if (full) {
        serverUids ??= await this.searchUids({ all: true })
        this.reconcileExpunged(path, fid, serverUids, Number(mailbox.exists ?? 0))
        await this.backfill(path, special, fid, serverUids)
      }
      // 性能：旗标刷新开销大，非收件箱文件夹仅在完整轮次执行
      if (full || special === 'inbox') await this.refreshFlags(path)
      const total = Number(mailbox.exists ?? 0)
      const unseen = await this.searchUids({ seen: false })
      this.store.updateFolderCounters(fid, total, unseen.length)
    } finally {
      lock.release()
    }
  }

  /** 服务器上已不存在的邮件（在别的客户端/网页端删除或移走）从本地移除 */
  private reconcileExpunged(path: string, fid: string, serverUids: number[], exists: number) {
    if (!serverUids.length && exists > 0) return // 结果与计数矛盾：宁可不删
    const server = new Set(serverUids)
    const pending = this.store.pendingOpMessageIds(this.account.id)
    let removed = 0
    for (const uid of this.store.listFolderUids(fid)) {
      if (server.has(uid)) continue
      const id = messageIdOf(this.account.id, path, uid)
      if (pending.has(id)) continue
      this.store.deleteMessageCascade(id)
      removed++
    }
    if (removed) this.events.changed(this.account.id)
  }

  /**
   * 历史回填：首次同步只拉最近一批，之后每轮完整同步再往前补 BACKFILL_CHUNK 封，
   * 同时补上历史上因断线遗漏的缺口，直到达到本地保留上限。
   */
  private async backfill(path: string, special: SpecialFolder, fid: string, serverUids: number[]) {
    if (this.backfillDone.has(fid)) return
    const localUids = this.store.listFolderUids(fid)
    const local = new Set(localUids)
    const limit = backfillLimit(special)
    const last = this.store.getFolderLastSync(fid).lastSyncUid
    const pending = this.store.pendingOpMessageIds(this.account.id)
    let missing = serverUids.filter(
      u => u <= last && !local.has(u) && !pending.has(messageIdOf(this.account.id, path, u))
    )
    // 已到上限：只补本地范围内的缺口，不再向更早扩展
    if (localUids.length >= limit) missing = missing.filter(u => u > localUids[0])
    if (!missing.length) {
      this.backfillDone.add(fid)
      return
    }
    const size = localUids.length >= limit ? BACKFILL_CHUNK : Math.min(BACKFILL_CHUNK, limit - localUids.length)
    const chunk = missing.slice(-size)
    this.events.progress(this.account.id, `${path} 补齐历史邮件 ${chunk.length} 封`)
    await this.fetchEnvelopes(path, special, chunk, false)
  }

  /**
   * 仅在 syncFolder 已持有 mailbox lock 时调用（imapflow 锁不可重入，嵌套获取会破坏 currentLock）。
   * 分片抓取、逐片落库；advanceCursor 时每片成功后推进 last_sync_uid——断线只会重抓当前片，绝不跳过邮件。
   */
  private async fetchEnvelopes(folderPath: string, special: SpecialFolder, uids: number[], advanceCursor: boolean) {
    const client = this.client
    if (!client) return
    const fid = folderIdOf(this.account.id, folderPath)
    // 只有增量抓取（且不是首次同步）的邮件才算「新到达」，规则动作只作用于它们
    const arrival = advanceCursor && this.store.getFolderLastSync(fid).lastSyncUid > 0
    for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
      if (!this.running) return
      const part = uids.slice(i, i + FETCH_CHUNK)
      const batch: EnvelopeData[] = []
      for await (const msg of client.fetch(
        part.join(','),
        { uid: true, flags: true, size: true, internalDate: true, envelope: true, headers: true, bodyStructure: true },
        { uid: true }
      )) {
        const headers = headersToPlain(msg.headers as unknown as Map<string, unknown> | Buffer)
        const referencesRaw = headers['references'] ?? ''
        const references = referencesRaw.split(/\s+/).filter(s => /<.+>/.test(s))
        const attachmentCount = countAttachments(msg.bodyStructure)
        const attachmentParts = attachmentCount ? extractAttachmentParts(msg.bodyStructure) : []
        batch.push({
          uid: msg.uid,
          flags: [...(msg.flags ?? [])].map(String),
          size: Number(msg.size ?? 0),
          date: msg.internalDate ? new Date(msg.internalDate).getTime() : msg.envelope?.date ? new Date(msg.envelope.date).getTime() : Date.now(),
          subject: msg.envelope?.subject ?? '',
          messageId: msg.envelope?.messageId ?? headers['message-id'] ?? null,
          inReplyTo: msg.envelope?.inReplyTo ?? null,
          references,
          from: addrList(msg.envelope?.from)[0] ?? null,
          to: addrList(msg.envelope?.to),
          cc: addrList(msg.envelope?.cc),
          replyTo: addrList(msg.envelope?.replyTo)[0] ?? null,
          headers,
          attachmentCount,
          attachmentParts
        })
      }
      this.touchActivity()
      for (const env of batch) {
        if (!this.running) return
        this.persistEnvelope(folderPath, special, env, arrival)
      }
      if (advanceCursor) this.store.setFolderLastSync(fid, part[part.length - 1])
      if (uids.length > FETCH_CHUNK) this.events.changed(this.account.id)
    }
  }

  private persistEnvelope(folderPath: string, special: SpecialFolder, env: EnvelopeData, arrival = false) {
    const id = messageIdOf(this.account.id, folderPath, env.uid)
    const norm = normalizeSubject(env.subject)
    const listUnsub = env.headers['list-unsubscribe'] ?? null
    const listId = env.headers['list-id'] ?? null
    const heuristic = heuristicClassify({
      subject: env.subject,
      fromAddress: env.from?.address ?? '',
      fromName: env.from?.name,
      listUnsubscribe: listUnsub,
      listId,
      precedence: env.headers['precedence'] ?? null,
      autoSubmitted: env.headers['auto-submitted'] ?? null
    })
    const threadId = this.store.resolveThreadId(
      this.account.id,
      norm,
      env.references,
      env.inReplyTo,
      `${this.account.id}${SEP}t${norm || env.uid}`
    )
    let category: MessageCategory = heuristic.category
    let isNewsletter = heuristic.isNewsletter

    const actions = evalRules(this.rules, {
      from: env.from?.address ?? '',
      to: env.to.map(a => a.address).join(','),
      subject: env.subject,
      listId,
      isNewsletter: isNewsletter,
      hasAttachment: env.attachmentCount > 0,
      snippet: ''
    })
    for (const action of actions) {
      if (action.type === 'setCategory' && action.value) category = action.value as MessageCategory
      if (action.type === 'markNewsletter') isNewsletter = true
    }

    const insert: MessageInsert = {
      id,
      accountId: this.account.id,
      folderId: folderIdOf(this.account.id, folderPath),
      folderPath,
      uid: env.uid,
      threadId,
      messageId: env.messageId,
      inReplyTo: env.inReplyTo,
      references: env.references,
      from: env.from,
      to: env.to,
      cc: env.cc,
      replyTo: env.replyTo,
      subject: env.subject,
      normSubject: norm,
      snippet: env.subject,
      text: '',
      html: null,
      date: env.date,
      size: env.size,
      flags: env.flags,
      hasAttachments: env.attachmentCount > 0,
      category,
      isNewsletter,
      listUnsubscribe: listUnsub,
      listId
    }
    const inserted = this.store.insertMessage(insert)
    if (inserted && env.attachmentParts.length) {
      try {
        this.events.attachmentParts?.(this.account.id, id, env.attachmentParts)
      } catch { /* 附件索引失败不影响同步 */ }
    }
    if (inserted && isNewsletter && env.from) {
      this.store.upsertNewsletterSender(this.account.id, env.from.address)
    }
    // Screener：新发件人登记（存量往来自动放行，新面孔进待审队列）。
    // 已登记为待审 / 已拒的发件人，后续来信同样视为被拦（之前只拦第一封）
    let held = false
    if (inserted && special === 'inbox' && env.from?.address) {
      const screenerEnabled = this.appStore.get('general', DEFAULT_GENERAL).screenerEnabled
      held = this.store.ensureSenderScreened(env.from.address, screenerEnabled) === 'pending'
      if (!held) {
        const st = this.store.senderScreeningStatus(env.from.address)
        held = st === 'pending' || st === 'deny'
      }
    }
    // 新邮件通知由「真正到达」驱动（增量抓取、未读、24h 内），不再要求 internalDate 在 2 分钟内——
    // Bridge 延迟、睡眠唤醒补拉、时钟偏差都会让真实新邮件超出 2 分钟窗口而永远不通知
    if (
      isNotifiableArrival({
        inserted,
        inbox: special === 'inbox',
        arrival,
        seen: env.flags.some(f => f === '\\Seen'),
        held,
        date: env.date,
        now: Date.now()
      })
    ) {
      this.events.newMail(this.account.id, id, env.subject, env.from ? (env.from.name || env.from.address) : '', category)
    }
    if (inserted && special === 'inbox' && arrival) {
      this.events.arrived(this.account.id, id, actions.filter(a => a.type !== 'setCategory' && a.type !== 'markNewsletter'))
    }
    // 性能：近期收件箱邮件限量预取正文，其余在打开时按需拉取（getMessage 触发），
    // 避免初始同步串行下载全量正文拖慢列表可见时间
    const recentInbox = special === 'inbox' && Date.now() - env.date < 7 * 864e5
    if (recentInbox && this.bodyQueued.size < 120) {
      this.enqueueBody(folderPath, env.uid, env.date)
    }
  }

  private enqueueBody(folderPath: string, uid: number, date: number) {
    // 最近的优先下载正文；过旧的排队靠后
    const key = `${folderPath}${SEP}${uid}`
    if (this.bodyQueued.has(key)) return
    this.bodyQueued.add(key)
    const item = { folderPath, uid, messageId: null, date }
    if (Date.now() - date < 7 * 864e5) this.bodyQueue.unshift(item as never)
    else this.bodyQueue.push(item as never)
    void this.pumpBodyQueue()
  }

  /** 近 7 天收件箱里仍缺正文的邮件重新入队（预取被断线/锁超时打断后自愈） */
  private requeueMissingBodies() {
    const fid = folderIdOf(this.account.id, 'INBOX')
    for (const m of this.store.listRecentWithoutBody(fid, Date.now() - 7 * 864e5, 40)) {
      this.enqueueBody('INBOX', m.uid, m.date)
    }
  }

  private async pumpBodyQueue() {
    if (this.processingBody || !this.running) return
    this.processingBody = true
    try {
      while (this.bodyQueue.length && this.running) {
        const item = this.bodyQueue.shift()! as { folderPath: string; uid: number; messageId: string | null; attempt?: number }
        try {
          await this.downloadBody(item.folderPath, item.uid)
        } catch {
          // 单条失败重试（最多 2 次，放回队尾），避免同步高峰期一次性失败全部沦为空正文
          const attempt = (item.attempt ?? 0) + 1
          if (attempt < 3) this.bodyQueue.push({ ...item, attempt })
          // 放弃后解除占位，下一轮同步的 requeueMissingBodies 会再补
          else this.bodyQueued.delete(`${item.folderPath}${SEP}${item.uid}`)
        }
        await sleep(20)
      }
    } finally {
      this.processingBody = false
    }
  }

  async downloadBody(folderPath: string, uid: number): Promise<void> {
    await this.serialized(async () => {
      const client = this.client
      if (!client?.usable) throw new Error('not connected')
      const raw = await this.downloadRaw(client, folderPath, uid)
      if (!raw) return
      await this.parseAndStore(folderPath, uid, raw)
    })
  }

  /** 离线水化：从本地 eml 镜像解析正文入库（零网络，断网可用）。返回是否命中镜像 */
  async hydrateFromLocalEml(folderPath: string, uid: number): Promise<boolean> {
    const path = this.appStore.emlPath(this.account.id, folderPath, uid)
    if (!existsSync(path)) return false
    try {
      const raw = readFileSync(path)
      if (!raw.length) return false
      await this.parseAndStore(folderPath, uid, raw)
      return true
    } catch {
      return false
    }
  }

  private async downloadRaw(client: ImapFlow, folderPath: string, uid: number): Promise<Buffer | null> {
    // 同步循环可能正持有该 mailbox 的锁（首次同步 300 封要数分钟）；排队 30s 拿不到即失败，
    // 由上层报错并可重试，避免 UI 无限等待后静默显示空正文
    const lock = await client.getMailboxLock(folderPath, { acquireTimeout: 30_000 })
    try {
      const res = await client.download(String(uid), undefined, { uid: true })
      if (!res?.content) return null
      const chunks: Buffer[] = []
      for await (const chunk of res.content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
      return Buffer.concat(chunks)
    } finally {
      lock.release()
    }
  }

  private async parseAndStore(folderPath: string, uid: number, raw: Buffer) {
    const id = messageIdOf(this.account.id, folderPath, uid)
    const row = this.store.getMessageRow(id)
    if (!row) return
    // eml 原文镜像落盘：离线可读、断网可解析、可导入导出（本地优先的数据资产）
    try {
      writeFileSync(this.appStore.emlPath(this.account.id, folderPath, uid), raw)
    } catch { /* 磁盘失败仅影响离线镜像，不阻塞入库 */ }
    let parsed
    try {
      parsed = await parseEmailRaw(raw)
    } catch {
      return
    }
    const text = (parsed.text && parsed.text.trim() ? parsed.text : stripHtml(parsed.html ?? '')).slice(0, 200_000)
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 180)
    for (const [i, att] of (parsed.attachments ?? []).entries()) {
      const attId = createHash('sha1')
        .update(`${id}#${i}#${att.filename ?? ''}#${att.size ?? 0}`)
        .digest('hex')
        .slice(0, 24)
      const path = this.appStore.attachmentPath(attId)
      try {
        writeFileSync(path, att.content)
      } catch { /* 磁盘失败则附件不可用 */ }
      this.store.addAttachment({
        id: attId,
        messageId: id,
        filename: att.filename ?? `attachment-${i + 1}`,
        contentType: att.contentType ?? 'application/octet-stream',
        size: att.size ?? att.content?.length ?? 0,
        inline: !!att.cid,
        contentId: att.cid,
        path
      })
    }
    this.store.updateMessageBody(id, { html: parsed.html ?? null, text, snippet })
    this.bodyQueued.delete(`${folderPath}${SEP}${uid}`)
  }

  // ---------- 命令（渲染进程调用） ----------

  /** 断网/网络失败时入队待同步操作，并提示用户 */
  private queueOfflineOp(op: string, folderPath: string, uid: number, args: Record<string, unknown>, messageId?: string) {
    this.store.addPendingOp({ accountId: this.account.id, folderPath, uid, op, args, messageId })
    const count = this.store.listPendingOps(this.account.id).length
    this.events.progress(this.account.id, `离线暂存：${count} 项操作待同步`)
  }

  async setFlags(folderPath: string, uid: number, add: string[], remove: string[]) {
    const id = messageIdOf(this.account.id, folderPath, uid)
    // 本地乐观更新（离线也立即生效；重放/后续同步以服务器为准收敛）
    const row = this.store.getMessageRow(id)
    if (row) {
      const flags = new Set(String(row.flags ?? '').split(' ').filter(Boolean))
      for (const f of add) flags.add(f)
      for (const f of remove) flags.delete(f)
      this.store.updateMessageFlags(id, [...flags])
    }
    await this.serialized(async () => {
      const client = this.client
      if (!client?.usable) {
        this.queueOfflineOp('flags', folderPath, uid, { add, remove }, id)
        return
      }
      const lock = await client.getMailboxLock(folderPath)
      try {
        if (add.length) await client.messageFlagsAdd(String(uid), add, { uid: true })
        if (remove.length) await client.messageFlagsRemove(String(uid), remove, { uid: true })
      } catch (err) {
        // 网络抖动：入队稍后重放（本地已乐观生效）
        this.queueOfflineOp('flags', folderPath, uid, { add, remove }, id)
        throw err
      } finally {
        lock.release()
      }
    })
  }

  async moveToFolder(folderPath: string, uid: number, targetPath: string) {
    const id = messageIdOf(this.account.id, folderPath, uid)
    try {
      await this.serialized(async () => {
        const client = this.client
        if (!client?.usable) {
          this.queueOfflineOp('move', folderPath, uid, { target: targetPath }, id)
          return
        }
        const lock = await client.getMailboxLock(folderPath)
        try {
          await client.messageMove(String(uid), targetPath, { uid: true })
        } catch (err) {
          this.queueOfflineOp('move', folderPath, uid, { target: targetPath }, id)
          throw err
        } finally {
          lock.release()
        }
      })
    } catch { /* 网络错误已入队，保持乐观视图 */ }
    // 无论服务器成功还是离线入队：本地立即移除（重放成功后由同步拉取新位置）
    this.store.deleteMessageCascade(id)
    this.events.changed(this.account.id)
  }

  async deletePermanent(folderPath: string, uid: number) {
    const id = messageIdOf(this.account.id, folderPath, uid)
    try {
      await this.serialized(async () => {
        const client = this.client
        if (!client?.usable) {
          this.queueOfflineOp('delete', folderPath, uid, {}, id)
          return
        }
        const lock = await client.getMailboxLock(folderPath)
        try {
          await client.messageDelete(String(uid), { uid: true })
        } catch (err) {
          this.queueOfflineOp('delete', folderPath, uid, {}, id)
          throw err
        } finally {
          lock.release()
        }
      })
    } catch { /* 网络错误已入队，保持乐观视图 */ }
    this.store.deleteMessageCascade(id)
    this.events.changed(this.account.id)
  }

  /** 连接恢复后重放断网期间的待同步操作（只做 IMAP 侧，本地视图已乐观更新） */
  private async replayPendingOps() {
    const ops = this.store.listPendingOps(this.account.id)
    if (!ops.length) return
    const client = this.client
    if (!client?.usable) return
    let done = 0
    for (const op of ops) {
      try {
        const lock = await client.getMailboxLock(op.folderPath)
        try {
          if (op.op === 'flags') {
            const { add = [], remove = [] } = op.args as { add?: string[]; remove?: string[] }
            if (add.length) await client.messageFlagsAdd(String(op.uid), add, { uid: true })
            if (remove.length) await client.messageFlagsRemove(String(op.uid), remove, { uid: true })
          } else if (op.op === 'move') {
            const { target } = op.args as { target?: string }
            if (target) await client.messageMove(String(op.uid), target, { uid: true })
          } else if (op.op === 'delete') {
            await client.messageDelete(String(op.uid), { uid: true })
          }
        } finally {
          lock.release()
        }
        this.store.deletePendingOp(op.id)
        done++
      } catch {
        // 服务器端失败（消息已不存在等）：重试 10 次后放弃
        this.store.bumpPendingOp(op.id)
        if (op.attempts >= 10) this.store.deletePendingOp(op.id)
      }
    }
    if (done) {
      const remain = this.store.listPendingOps(this.account.id).length
      this.events.progress(this.account.id, remain ? `离线操作已同步 ${done} 项，剩 ${remain} 项` : `离线操作已全部同步（${done} 项）`)
      this.events.changed(this.account.id)
    }
  }

  /** 拉取目标文件夹（如废纸篓）的路径 */
  async specialFolderPath(special: Exclude<SpecialFolder, null>): Promise<string | null> {
    const rows = this.store.listFolders().filter(f => f.accountId === this.account.id && f.special === special)
    return rows[0]?.path ?? null
  }

  /**
   * 归档目标：优先服务器的归档文件夹；Gmail 没有归档文件夹，移入 All Mail 即去掉收件箱标签；
   * QQ/163 等两者都没有时在服务器上建一个 Archive，否则只删本地、下次同步邮件又会回来。
   */
  async archiveTargetPath(): Promise<string | null> {
    const archive = await this.specialFolderPath('archive')
    if (archive) return archive
    if (this.allMailPath) return this.allMailPath
    return this.serialized(async () => {
      const client = this.client
      if (!client?.usable) return null
      try {
        const created = await client.mailboxCreate('Archive')
        this.lastFullSync = 0
        return created?.path ?? 'Archive'
      } catch {
        // 已存在（只是没被识别为归档）也直接用
        const list = await client.list().catch(() => [])
        const hit = list.find(f => /(^|[/.])archive$/i.test(f.path))
        return hit?.path ?? null
      }
    })
  }

  /** 发送后存入已发送文件夹 */
  async appendRaw(folderPath: string, raw: Buffer, messageId?: string) {
    // 给服务端自动保存留出时间，再按 Message-ID 查重，避免「已发送」出现两封
    if (messageId) await sleep(4000)
    await this.serialized(async () => {
      const client = this.client
      if (!client?.usable) return
      if (messageId) {
        const lock = await client.getMailboxLock(folderPath)
        try {
          const hit = await client.search({ header: { 'message-id': messageId } }, { uid: true })
          if (hit && hit.length) return
        } catch { /* 不支持 HEADER 搜索则照常追加 */ } finally {
          lock.release()
        }
      }
      await client.append(folderPath, raw, ['\\Seen'])
      this.lastFullSync = 0
    })
  }

  // ---------- 隐藏文件夹（待办跨设备同步，见 ../todo-sync）：全部经 serialized + mailbox lock，与邮件同步互不穿插 ----------

  private usableClient(): ImapFlow {
    const client = this.client
    if (!client?.usable) throw new Error('not connected')
    return client
  }

  /**
   * 确保隐藏文件夹存在并返回服务器上的真实路径：已有则按最后一段名字匹配（兼容 Proton Bridge 的
   * Folders/、INBOX. 命名空间前缀）；没有则创建（Proton 账户优先建在 Folders/ 下），并取消订阅以便其他客户端少显示它。
   */
  async ensureHiddenFolder(name: string): Promise<string> {
    // 每次都 LIST（每轮一次，开销很小）：用户在网页端删掉文件夹后能自动重建，不会用到过期路径
    return this.serialized(async () => {
      const client = this.usableClient()
      const lower = name.toLowerCase()
      const find = (list: ListResponse[]) =>
        list.find(
          f => (f.path.split(/[/.]/).pop() ?? f.path).toLowerCase() === lower && !f.flags?.has('\\Noselect') && !f.flags?.has('\\NonExistent')
        )
      let list = await client.list()
      let hit = find(list)
      if (!hit) {
        const proton = list.some(f => /^Folders([/.]|$)/.test(f.path))
        const candidates = proton ? [`Folders/${name}`, name] : [name, `Folders/${name}`]
        let lastErr: unknown = null
        for (const c of candidates) {
          try {
            await client.mailboxCreate(c)
            break
          } catch (err) {
            lastErr = err
          }
        }
        list = await client.list()
        hit = find(list)
        if (!hit) throw lastErr instanceof Error ? lastErr : new Error(`无法创建文件夹 ${name}`)
        try {
          await client.mailboxUnsubscribe(hit.path)
        } catch { /* 不支持订阅管理的服务器忽略 */ }
      }
      // 若此前被当作普通文件夹登记过，移除本地行
      this.store.deleteFolder(folderIdOf(this.account.id, hit.path))
      return hit.path
    })
  }

  /** 拉取文件夹内全部邮件的指定头（不下载正文） */
  async fetchFolderHeaders(path: string, headerNames: string[]): Promise<{ uid: number; headers: Record<string, string> }[]> {
    return this.serialized(async () => {
      const client = this.usableClient()
      const lock = await client.getMailboxLock(path, { acquireTimeout: 30_000 })
      try {
        const mailbox = client.mailbox
        if (!mailbox || typeof mailbox === 'boolean' || !Number(mailbox.exists ?? 0)) return []
        const out: { uid: number; headers: Record<string, string> }[] = []
        for await (const msg of client.fetch('1:*', { uid: true, headers: headerNames })) {
          out.push({ uid: msg.uid, headers: headersToPlain(msg.headers as unknown as Map<string, unknown> | Buffer) })
        }
        return out
      } finally {
        lock.release()
      }
    })
  }

  /** 拉取指定邮件的附件元数据（BODYSTRUCTURE，不下载正文）：附件中心为存量邮件补建索引 */
  async fetchAttachmentParts(path: string, uids: number[]): Promise<{ uid: number; parts: AttachmentPart[] }[]> {
    if (!uids.length) return []
    return this.serialized(async () => {
      const client = this.usableClient()
      const lock = await client.getMailboxLock(path, { acquireTimeout: 30_000 })
      try {
        const out: { uid: number; parts: AttachmentPart[] }[] = []
        for await (const msg of client.fetch(uids.join(','), { uid: true, bodyStructure: true }, { uid: true })) {
          out.push({ uid: msg.uid, parts: extractAttachmentParts(msg.bodyStructure) })
        }
        return out
      } finally {
        lock.release()
      }
    })
  }

  /** 下载隐藏文件夹里的一封原文 */
  async downloadFromFolder(path: string, uid: number): Promise<Buffer | null> {
    return this.serialized(async () => this.downloadRaw(this.usableClient(), path, uid))
  }

  /** 追加一封原文（不触发邮件同步刷新）；服务器支持 UIDPLUS 时返回新 UID */
  async appendToFolder(path: string, raw: Buffer, flags: string[] = ['\\Seen']): Promise<number | null> {
    return this.serialized(async () => {
      const res = await this.usableClient().append(path, raw, flags)
      return res && res.uid ? Number(res.uid) : null
    })
  }

  /** 按 UID 删除（\Deleted + EXPUNGE；支持 UIDPLUS 时只清除这些 UID） */
  async deleteFromFolder(path: string, uids: number[]): Promise<void> {
    if (!uids.length) return
    await this.serialized(async () => {
      const client = this.usableClient()
      const lock = await client.getMailboxLock(path, { acquireTimeout: 30_000 })
      try {
        await client.messageDelete(uids.join(','), { uid: true })
      } finally {
        lock.release()
      }
    })
  }

  /** 隐藏文件夹操作结束：重新选中 INBOX，让 IDLE 继续盯新邮件 */
  async returnToInbox(): Promise<void> {
    await this.serialized(async () => {
      try {
        await this.watchInbox()
      } catch { /* 下一轮同步会再选中 */ }
    })
  }

  /** 仅在 syncFolder 已持有 mailbox lock 时调用：刷新本地最近 500 封的旗标（已读/星标在别处改动后收敛） */
  private async refreshFlags(folderPath: string) {
    const client = this.client
    if (!client) return
    const uids = this.store.listFolderUids(folderIdOf(this.account.id, folderPath)).slice(-500)
    if (!uids.length) return
    // 断网期间乐观更新的消息：重放完成前不让服务器旧 flags 覆盖本地
    const pending = this.store.pendingOpMessageIds(this.account.id)
    for await (const msg of client.fetch(uids.join(','), { uid: true, flags: true }, { uid: true })) {
      const id = messageIdOf(this.account.id, folderPath, msg.uid)
      if (pending.has(id)) continue
      this.store.updateMessageFlags(id, [...(msg.flags ?? [])].map(String))
    }
    this.touchActivity()
  }
}

function countAttachments(node: any): number {
  let count = 0
  const walk = (n: any) => {
    if (!n) return
    if (n.disposition === 'attachment' && (n.filename || n.dispositionParameters?.filename)) count++
    else if (!n.disposition && n.filename && n.part) count++
    for (const child of n.childNodes ?? []) walk(child)
  }
  walk(node)
  return count
}

/** 从 BODYSTRUCTURE 提取附件元数据（与 countAttachments 同口径，另带 inline 图片供调用方过滤） */
export function extractAttachmentParts(node: any): AttachmentPart[] {
  const out: AttachmentPart[] = []
  const walk = (n: any) => {
    if (!n) return
    const filename: string = n.dispositionParameters?.filename || n.parameters?.name || ''
    const isAttachment = (n.disposition === 'attachment' && filename) || (!n.disposition && n.filename && n.part) || (n.disposition === 'inline' && filename && !String(n.type ?? '').startsWith('text/'))
    if (isAttachment && n.part) {
      const raw = Number(n.size ?? 0)
      out.push({
        part: String(n.part),
        filename: filename || String(n.filename ?? ''),
        contentType: String(n.type ?? 'application/octet-stream'),
        size: String(n.encoding ?? '').toLowerCase() === 'base64' ? Math.round(raw * 0.75) : raw,
        inline: n.disposition === 'inline' || !!n.id,
        contentId: n.id ? String(n.id).replace(/^<|>$/g, '') : null
      })
    }
    for (const child of n.childNodes ?? []) walk(child)
  }
  walk(node)
  return out
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // OAuth 类错误优先归因：token 过期/刷新失败/客户端未配置 ≠ 账号密码错误
  if (/oauth|refresh token|grant|授权|重新授权/i.test(msg))
    return '授权不可用：请在账户页重新授权（跨设备恢复后需在 设置→OAuth 应用 配置客户端）'
  if (/auth|login|credentials|invalid/i.test(msg)) return '登录失败：请检查用户名与授权码/应用专用密码'
  if (/THROTTLED|bandwidth|too many|rate limit|OVERQUOTA/i.test(msg)) return '服务器限流：连接或请求过于频繁，稍后自动重试'
  if (/timeout|ETIMEDOUT/i.test(msg)) return '连接超时，请检查网络或服务器地址'
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return '无法解析服务器地址'
  if (/ECONNREFUSED/i.test(msg)) return '连接被拒绝，请检查端口与加密方式'
  if (/WRONG_VERSION_NUMBER|WRONG_VERSION|tls|ssl|certificate|handshake/i.test(msg))
    return 'TLS 加密握手失败：服务器端口可能不是 SSL/TLS——请在服务器设置里把加密方式改为 STARTTLS 或无加密'
  // 网络层中断（断网 / 切换 Wi-Fi / 代理掉线）：与服务器配置无关，联网后自动重连
  if (/ENETUNREACH|EHOSTUNREACH|ECONNRESET|EPIPE|socket hang up|Connection not available|Connection closed|Unexpected close|network/i.test(msg))
    return '网络连接中断：联网后会自动重连'
  return msg.slice(0, 120)
}

export function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

/** 同步引擎：管理所有账户 worker */
export class SyncEngine {
  private workers = new Map<string, AccountWorker>()

  constructor(
    private store: MailStore,
    private appStore: AppStore,
    private events: SyncEvents,
    private getRules: () => Rule[],
    /** 账户凭据（密码 / OAuth access token），由宿主注入；force 表示 OAuth 强制刷新 */
    private getCredentials: (account: AccountConfig, force?: boolean) => Promise<{ pass?: string; accessToken?: string }> = async () => ({}),
    /** 文件夹偏好（每轮完整同步读取；sync=false 的非收件箱文件夹跳过拉取） */
    private getFolderPrefs: () => Record<string, FolderPref> = () => ({})
  ) {}

  startAccount(account: AccountConfig) {
    const existing = this.workers.get(account.id)
    if (existing) {
      existing.stop()
      this.workers.delete(account.id)
    }
    if (!account.enabled) {
      this.events.status(account.id, 'disabled', '已停用')
      return
    }
    const worker = new AccountWorker(
      { id: account.id, name: account.name, email: account.email, user: account.user },
      account.imap,
      this.store,
      this.appStore,
      this.events,
      account.authType === 'oauth' ? (id, force) => this.getCredentials(account, force).then(c => c.accessToken ?? '') : undefined
    )
    worker.setRules(this.getRules())
    worker.setFolderPrefsGetter(this.getFolderPrefs)
    this.workers.set(account.id, worker)
    worker.start()
  }

  stopAccount(id: string) {
    this.workers.get(id)?.stop()
    this.workers.delete(id)
    this.events.status(id, 'disabled', '已停用')
  }

  stopAll() {
    for (const w of this.workers.values()) w.stop()
    this.workers.clear()
  }

  /** 系统唤醒/解锁后：所有账户丢弃旧连接立即重连 */
  reconnectAll() {
    for (const w of this.workers.values()) w.reconnect()
  }

  getWorker(id: string): AccountWorker | undefined {
    return this.workers.get(id)
  }

  applyRulesAll(rules: Rule[]) {
    for (const w of this.workers.values()) w.setRules(rules)
  }
}
