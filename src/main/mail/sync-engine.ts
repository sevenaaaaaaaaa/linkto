import { ImapFlow, ListResponse } from 'imapflow'
import { simpleParser, ParsedMail } from 'mailparser'
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import type { AccountConfig, Address, Folder, MessageCategory, SpecialFolder } from '@shared/types'
import type { MailStore, MessageInsert } from '../db'
import type { AppStore } from '../store'
import { heuristicClassify, normalizeSubject } from './classify'
import { evalRules } from '../rules/engine'
import type { Rule } from '@shared/types'

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
  [/^(archive|归档|所有邮件|all mail)$/i, 'archive']
]

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
}

export interface SyncEvents {
  status(accountId: string, status: 'connected' | 'syncing' | 'error' | 'disabled', text: string): void
  progress(accountId: string, text: string): void
  changed(accountId?: string): void
  newMail(accountId: string, messageId: string, subject: string, from: string, category: string): void
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

  start() {
    this.loop().catch(() => {})
  }

  stop() {
    this.running = false
    this.stopWatchdog()
    this.client?.close()
  }

  private async loop() {
    let backoff = 3000
    let forceRefresh = false
    while (this.running) {
      try {
        this.events.status(this.account.id, 'syncing', '连接中…')
        await this.connect(forceRefresh)
        forceRefresh = false
        this.startWatchdog()
        this.events.status(this.account.id, 'syncing', '同步中…')
        await this.syncAllFolders()
        this.events.status(this.account.id, 'connected', '已连接')
        backoff = 3000
        while (this.running && this.client?.usable) {
          await this.sleepInterruptible(this.cycle % 4 === 0 ? 30_000 : 60_000)
          if (!this.running || !this.client?.usable) break
          this.kickRequested = false
          await this.syncAllFolders(true)
          this.events.status(this.account.id, 'connected', '已连接')
        }
      } catch (err) {
        if (!this.running) return
        this.stopWatchdog()
        const msg = err instanceof Error ? err.message : String(err)
        // OAuth 认证失败 → 下次强制刷新 token 重试；密码错误则原样提示
        if (this.getToken && /auth|login|credentials|invalid|AUTHENTICATE/i.test(msg)) forceRefresh = true
        this.events.status(this.account.id, 'error', friendlyError(err))
        try {
          this.client?.close()
        } catch { /* ignore */ }
        this.client = null
        await this.sleepInterruptible(backoff)
        this.kickRequested = false
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
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
      socketTimeout: 30 * 60_000
    })
    client.on('exists', (e: { path?: string; count: number }) => {
      if (e.path?.toUpperCase() === 'INBOX' && this.running) {
        this.kickSync()
      }
    })
    await client.connect()
    this.client = client
  }

  private kickRequested = false
  /** 新邮件踢同步：只置标志，由主循环可中断 sleep 提前醒来执行（避免与 loop 并发 SELECT 穿插） */
  private kickSync() {
    this.kickRequested = true
  }

  /** 看门狗：同步活动超过 5 分钟无进展 → 强制断线重连（兜底任何未知挂起，绝不永久卡死） */
  private watchdogTimer: NodeJS.Timeout | null = null
  private lastActivity = 0
  private touchActivity() {
    this.lastActivity = Date.now()
  }
  private startWatchdog() {
    this.stopWatchdog()
    this.lastActivity = Date.now()
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > 5 * 60_000) {
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
    const step = 500
    let waited = 0
    while (waited < ms && this.running && !this.kickRequested) {
      await sleep(Math.min(step, ms - waited))
      waited += step
    }
  }

  /** 所有操作经此串行化，避免与同步循环争用 */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  // ---------- 文件夹与同步 ----------

  private async syncAllFolders(light = false) {
    const client = this.client
    if (!client) throw new Error('not connected')
    const folders = await client.list()
    let order = 0
    const priority: Record<string, number> = { inbox: 0, sent: 1, archive: 2, all: 3, junk: 4, trash: 5, drafts: 6, null: 7 }
    const sorted = [...folders].sort(
      (a, b) => (priority[String(specialFor(a))] ?? 9) - (priority[String(specialFor(b))] ?? 9)
    )
    for (const f of sorted) {
      if (!this.running) return
      this.touchActivity()
      const special = specialFor(f)
      if (special === 'drafts' || special === 'all') {
        // 本地管理草稿；All Mail 与 INBOX 重复，跳过同步
        continue
      }
      const id = folderIdOf(this.account.id, f.path)
      const name = f.path.toUpperCase() === 'INBOX' ? '收件箱' : f.path.split(/[/.]/).pop() || f.path
      let uidValidity = 0
      try {
        const st = await client.status(f.path, { uidNext: true, uidValidity: true })
        if (st) uidValidity = Number((st as { uidValidity?: bigint | number }).uidValidity ?? 0)
      } catch { /* 部分服务器不支持 */ }
      this.store.upsertFolder({
        id,
        accountId: this.account.id,
        path: f.path,
        name,
        special,
        sortOrder: order++,
        hidden: false,
        uidValidity
      })
      if (light && this.cycle % 4 !== 0 && special !== 'inbox') continue
      await this.syncFolder(f.path, special, light)
    }
    this.cycle++
    this.events.changed(this.account.id)
  }

  private async syncFolder(path: string, special: SpecialFolder, light = false) {
    const client = this.client
    if (!client) return
    const fid = folderIdOf(this.account.id, path)
    const last = this.store.getFolderLastSync(fid)
    const lock = await client.getMailboxLock(path)
    try {
      const mailbox = client.mailbox
      if (!mailbox || typeof mailbox === 'boolean') return
      const uidNext = Number(mailbox.uidNext ?? 1)
      if (uidNext - 1 > last.lastSyncUid) {
        let uids: number[] = []
        if (last.lastSyncUid === 0) {
          const cap = special === 'inbox' ? 300 : 150
          const from = Math.max(1, uidNext - cap)
          uids = ((await client.search({ uid: `${from}:*` }, { uid: true })) || []) as number[]
          uids = uids.filter(u => u >= from)
        } else {
          uids = ((await client.search({ uid: `${last.lastSyncUid + 1}:*` }, { uid: true })) || []) as number[]
          uids = uids.filter(u => u > last.lastSyncUid)
        }
        if (uids.length) {
          this.events.progress(this.account.id, `${path} +${uids.length}`)
          await this.fetchEnvelopes(path, special, uids.sort((a, b) => a - b))
        }
        this.store.setFolderLastSync(fid, uidNext - 1)
      }
      // 性能：旗标刷新开销大（全量 FETCH FLAGS），非收件箱文件夹仅在完整轮次执行
      if (!light || this.cycle % 4 === 0 || special === 'inbox') {
        await this.refreshFlags(path)
      }
      const total = Number(mailbox.exists ?? 0)
      const unseen = ((await client.search({ seen: false }, { uid: true })) || []) as number[]
      this.store.updateFolderCounters(fid, total, unseen.length)
    } finally {
      lock.release()
    }
  }

  /** 仅在 syncFolder 已持有 mailbox lock 时调用（imapflow 锁不可重入，嵌套获取会破坏 currentLock） */
  private async fetchEnvelopes(folderPath: string, special: SpecialFolder, uids: number[]) {
    const client = this.client
    if (!client) return
    const fetchRange = uids.join(',')
    const batch: EnvelopeData[] = []
    try {
      for await (const msg of client.fetch(
        fetchRange,
        { uid: true, flags: true, size: true, internalDate: true, envelope: true, headers: true, bodyStructure: true },
        { uid: true }
      )) {
        const headers = headersToPlain(msg.headers as unknown as Map<string, unknown> | Buffer)
        const referencesRaw = headers['references'] ?? ''
        const references = referencesRaw.split(/\s+/).filter(s => /<.+>/.test(s))
        const attachmentCount = countAttachments(msg.bodyStructure)
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
          attachmentCount
        })
      }
    } catch {
      // 网络中断等：由外层 loop 统一进入重试
    }

    for (const env of batch) {
      if (!this.running) return
      this.persistEnvelope(folderPath, special, env)
    }
  }

  private persistEnvelope(folderPath: string, special: SpecialFolder, env: EnvelopeData) {
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
    if (inserted && isNewsletter && env.from) {
      this.store.upsertNewsletterSender(this.account.id, env.from.address)
    }
    if (inserted && special === 'inbox' && Date.now() - env.date < 120_000 && env.flags.every(f => f !== '\\Seen')) {
      this.events.newMail(this.account.id, id, env.subject, env.from ? (env.from.name ?? env.from.address) : '', category)
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
    let parsed: ParsedMail
    try {
      parsed = await simpleParser(raw)
    } catch {
      return
    }
    const text = (typeof parsed.text === 'string' && parsed.text ? parsed.text : stripHtml(typeof parsed.html === 'string' ? parsed.html : '')).slice(0, 200_000)
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
    this.store.updateMessageBody(id, { html: typeof parsed.html === 'string' ? parsed.html : null, text, snippet })
    this.bodyQueued.delete(`${folderPath}${SEP}${uid}`)
  }

  // ---------- 命令（渲染进程调用） ----------

  async setFlags(folderPath: string, uid: number, add: string[], remove: string[]) {
    await this.serialized(async () => {
      const client = this.client
      if (!client?.usable) return
      const lock = await client.getMailboxLock(folderPath)
      try {
        if (add.length) await client.messageFlagsAdd(String(uid), add, { uid: true })
        if (remove.length) await client.messageFlagsRemove(String(uid), remove, { uid: true })
      } finally {
        lock.release()
      }
      const id = messageIdOf(this.account.id, folderPath, uid)
      const row = this.store.getMessageRow(id)
      if (row) {
        const flags = new Set(String(row.flags ?? '').split(' ').filter(Boolean))
        for (const f of add) flags.add(f)
        for (const f of remove) flags.delete(f)
        this.store.updateMessageFlags(id, [...flags])
      }
    })
  }

  async moveToFolder(folderPath: string, uid: number, targetPath: string) {
    await this.serialized(async () => {
      const client = this.client
      if (!client?.usable) return
      const lock = await client.getMailboxLock(folderPath)
      try {
        await client.messageMove(String(uid), targetPath, { uid: true })
      } finally {
        lock.release()
      }
      this.store.deleteMessageCascade(messageIdOf(this.account.id, folderPath, uid))
      this.events.changed(this.account.id)
    })
  }

  async deletePermanent(folderPath: string, uid: number) {
    await this.serialized(async () => {
      const client = this.client
      if (!client?.usable) return
      const lock = await client.getMailboxLock(folderPath)
      try {
        await client.messageDelete(String(uid), { uid: true })
      } finally {
        lock.release()
      }
      this.store.deleteMessageCascade(messageIdOf(this.account.id, folderPath, uid))
      this.events.changed(this.account.id)
    })
  }

  /** 拉取目标文件夹（如废纸篓）的路径 */
  async specialFolderPath(special: Exclude<SpecialFolder, null>): Promise<string | null> {
    const rows = this.store.listFolders().filter(f => f.accountId === this.account.id && f.special === special)
    return rows[0]?.path ?? null
  }

  /** 发送后存入已发送文件夹 */
  async appendRaw(folderPath: string, raw: string) {
    await this.serialized(async () => {
      const client = this.client
      if (!client?.usable) return
      await client.append(folderPath, Buffer.from(raw, 'utf8'), ['\\Seen'])
    })
  }

  /** 仅在 syncFolder 已持有 mailbox lock 时调用 */
  private async refreshFlags(folderPath: string) {
    const client = this.client
    if (!client) return
    const fid = folderIdOf(this.account.id, folderPath)
    const mailbox = client.mailbox
    if (!mailbox || typeof mailbox === 'boolean') return
    const from = Math.max(1, Number(mailbox.uidNext ?? 1) - 500)
    const uids = ((await client.search({ uid: `${from}:*` }, { uid: true })) || []) as number[]
    if (!uids.length) return
    for await (const msg of client.fetch(uids.join(','), { uid: true, flags: true }, { uid: true })) {
      this.store.updateMessageFlags(
        messageIdOf(this.account.id, folderPath, msg.uid),
        [...(msg.flags ?? [])].map(String)
      )
    }
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
  if (/auth|login|credentials|invalid/i.test(msg)) return '登录失败：请检查用户名与授权码/应用专用密码'
  if (/timeout|ETIMEDOUT/i.test(msg)) return '连接超时，请检查网络或服务器地址'
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return '无法解析服务器地址'
  if (/ECONNREFUSED/i.test(msg)) return '连接被拒绝，请检查端口与加密方式'
  if (/WRONG_VERSION_NUMBER|WRONG_VERSION|tls|ssl|certificate|handshake/i.test(msg))
    return 'TLS 加密握手失败：服务器端口可能不是 SSL/TLS——请在服务器设置里把加密方式改为 STARTTLS 或无加密'
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
    private getCredentials: (account: AccountConfig, force?: boolean) => Promise<{ pass?: string; accessToken?: string }> = async () => ({})
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

  getWorker(id: string): AccountWorker | undefined {
    return this.workers.get(id)
  }

  applyRulesAll(rules: Rule[]) {
    for (const w of this.workers.values()) w.setRules(rules)
  }
}
