import { app, dialog, nativeImage, shell, BrowserWindow } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ArchiveJobStatus,
  ArchivePreview,
  ArchivePreviewItem,
  ArchiveSuggestion,
  ArchiveTarget,
  AttachmentBucket,
  AttachmentCategory,
  AttachmentCloudCopy,
  AttachmentItem,
  AttachmentQuery,
  AttachmentSettings,
  AttachmentStats,
  ReleasePlan
} from '@shared/attachments'
import { ATTACHMENT_CATEGORIES, DEFAULT_ATTACHMENT_SETTINGS, attachmentCategoryLabel } from '@shared/attachments'
import type { AccountConfig, AISettings, CloudDriveConfig } from '@shared/types'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import type { SyncEngine, AttachmentPart } from '../mail/sync-engine'
import type { AIService } from '../ai/service'
import { aiReady } from '../ai/service'
import { ATTACHMENT_CLASSIFY } from '../ai/prompts'
import { parseEmailRaw } from '../mail/parse-pool'
import { driveDownload, driveExists, driveLocalPath, driveRootLabel, driveTest, driveUpload, driveWebUrl, listDrives, saveDrive } from '../cloud-drive'
import { detectProtonDriveFolders, PROTON_DRIVE_DOWNLOAD_URL } from '../cloud-drive/proton'
import { AttachmentIndexStore, rowToItem, type IndexRow } from './store'
import { classifyAttachment, counterpartyOf, extOf, isNoiseAttachment } from './classify'
import { renderPathTemplate, withSerial } from '@shared/attachment-paths'
import { assembleReleasePlan, planReleaseCandidates, releaseSafety, type PolicyItem, type SafetyResult } from './policy'

const KV_KEY = 'attachments'
const SEP = '::'
const VALID_CATEGORIES = new Set(ATTACHMENT_CATEGORIES.map(c => c.id))

export interface AttachmentDeps {
  db: DatabaseSync
  store: MailStore
  appStore: AppStore
  engine: () => SyncEngine | undefined
  ai: AIService
  getAISettings(): AISettings
  event(payload: unknown): void
}

interface MsgRow {
  id: string
  account_id: string
  folder_id: string
  folder_path: string
  uid: number
  subject: string | null
  date: number
  from_addr: string | null
  from_name: string | null
  to_json: string | null
}

interface JobItem {
  id: string
  driveId: string
  attempts: number
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', d => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function fileSize(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return -1
  }
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** 附件中心：索引 / 分类 / 占用统计 / 释放空间 / 网盘归档队列 / 自动规则 */
export class AttachmentService {
  readonly idx: AttachmentIndexStore
  private scanning: Promise<void> | null = null
  private lastScanAt: number | null = null
  private scanTimer: NodeJS.Timeout | null = null
  private interval: NodeJS.Timeout | null = null
  private partsTried = new Set<string>()
  /** 仅元数据行合并到真实行后的映射（归档队列里的 r: id 继续可用） */
  private merged = new Map<string, string>()
  private diskCache: { at: number; emlBytes: number; orphan: { count: number; bytes: number } } | null = null
  private autoQueued = new Set<string>()
  // —— 归档队列 ——
  private job: ArchiveJobStatus | null = null
  private queue: JobItem[] = []
  private running = false
  private paused = false
  private resumeWaiter: (() => void) | null = null
  private lastEmit = 0

  constructor(private deps: AttachmentDeps) {
    this.idx = new AttachmentIndexStore(deps.db)
  }

  // ================= 设置 =================

  getSettings(): AttachmentSettings {
    const s = this.deps.appStore.get<AttachmentSettings>(KV_KEY, DEFAULT_ATTACHMENT_SETTINGS)
    return {
      ...DEFAULT_ATTACHMENT_SETTINGS,
      ...s,
      keepCategories: (s.keepCategories ?? DEFAULT_ATTACHMENT_SETTINGS.keepCategories).filter(c => VALID_CATEGORIES.has(c)),
      autoRules: (s.autoRules ?? []).filter(r => VALID_CATEGORIES.has(r.category) && r.driveId)
    }
  }

  setSettings(patch: Partial<AttachmentSettings>): AttachmentSettings {
    const prev = this.getSettings()
    const next: AttachmentSettings = { ...prev, ...patch }
    next.keepDays = Math.max(0, Math.round(Number(next.keepDays) || 0))
    next.maxCacheGB = Math.max(0, Number(next.maxCacheGB) || 0)
    next.pathTemplate = (next.pathTemplate || '').trim() || DEFAULT_ATTACHMENT_SETTINGS.pathTemplate
    // 自动规则变化：只对之后到达的附件生效（不回溯归档历史附件）
    if (patch.autoRules && JSON.stringify(patch.autoRules) !== JSON.stringify(prev.autoRules)) next.autoSince = Date.now()
    this.deps.appStore.set(KV_KEY, next)
    this.changed()
    return next
  }

  // ================= 生命周期 =================

  start() {
    setTimeout(() => void this.scan().catch(err => console.error('[attachments] scan failed:', err)), 15_000)
    this.interval = setInterval(() => void this.scan().catch(() => {}), 3 * 60_000)
  }

  stop() {
    if (this.interval) clearInterval(this.interval)
    if (this.scanTimer) clearTimeout(this.scanTimer)
  }

  /** 防抖触发一次增量扫描 */
  scheduleScan(delay = 4000) {
    if (this.scanTimer) return
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null
      void this.scan().catch(() => {})
    }, delay)
  }

  private changed() {
    this.deps.event({ type: 'attachments-changed' })
  }

  // ================= 索引 =================

  private accounts(): Map<string, AccountConfig> {
    return new Map(this.deps.store.listAccounts().map(a => [a.id, a]))
  }

  private folderSpecial(): Map<string, string | null> {
    return new Map(this.deps.store.listFolders().map(f => [f.id, f.special ?? null]))
  }

  private describeMessage(m: MsgRow, accounts: Map<string, AccountConfig>, specials: Map<string, string | null>) {
    const acct = accounts.get(m.account_id)
    const self = (acct?.email ?? '').toLowerCase()
    const from = (m.from_addr ?? '').toLowerCase()
    const out = specials.get(m.folder_id) === 'sent' || (!!self && from === self)
    let addr = m.from_addr ?? ''
    let name = m.from_name ?? ''
    if (out) {
      try {
        const to = JSON.parse(m.to_json || '[]') as { name?: string; address: string }[]
        addr = to[0]?.address ?? ''
        name = to[0]?.name ?? ''
      } catch { /* 收件人解析失败按发件人算 */ }
    }
    return { direction: (out ? 'out' : 'in') as 'in' | 'out', counterparty: counterpartyOf(addr, name), counterpartyAddr: addr.toLowerCase() }
  }

  /** 仅元数据（BODYSTRUCTURE）入索引：同步引擎新邮件入库时回调，或存量补建 */
  indexParts(accountId: string, messageId: string, parts: AttachmentPart[]) {
    const m = this.deps.store.getMessageRow(messageId) as MsgRow | undefined
    if (!m) return
    // 已下载过正文（有真实附件行）就不再建占位
    const hasReal = (this.deps.db.prepare('SELECT 1 FROM attachments WHERE message_id = ? LIMIT 1').get(messageId) as unknown) != null
    if (hasReal) return
    const accounts = this.accounts()
    const specials = this.folderSpecial()
    const who = this.describeMessage(m, accounts, specials)
    for (const p of parts) {
      if (isNoiseAttachment({ filename: p.filename, contentType: p.contentType, size: p.size, inline: p.inline, contentId: p.contentId })) continue
      const c = classifyAttachment({ filename: p.filename, contentType: p.contentType, subject: m.subject })
      this.idx.upsert({
        id: `r:${messageId}:${p.part}`,
        messageId,
        accountId,
        filename: p.filename || '附件',
        contentType: p.contentType,
        size: p.size,
        ext: extOf(p.filename),
        category: c.category,
        confidence: c.confidence,
        ...who,
        subject: m.subject ?? '',
        date: m.date ?? 0,
        part: p.part,
        remoteOnly: true,
        cached: false,
        cachePath: null
      })
    }
    this.scheduleScan(8000)
  }

  /** 增量扫描：新下载的附件入索引、合并占位、刷新缓存状态、清理孤儿、补建元数据、算哈希、AI 补充分类、自动规则 */
  scan(): Promise<void> {
    if (this.scanning) return this.scanning
    this.scanning = this.doScan().finally(() => {
      this.scanning = null
      this.lastScanAt = Date.now()
    })
    return this.scanning
  }

  private async doScan() {
    const { db, appStore } = this.deps
    const accounts = this.accounts()
    const specials = this.folderSpecial()
    let dirty = false

    // 1) 新的真实附件
    const fresh = db
      .prepare(
        `SELECT a.id, a.message_id, a.filename, a.content_type, a.size, a.inline, a.content_id, a.path,
                m.account_id, m.folder_id, m.folder_path, m.uid, m.subject, m.date, m.from_addr, m.from_name, m.to_json
         FROM attachments a JOIN messages m ON m.id = a.message_id
         LEFT JOIN attachment_index i ON i.id = a.id
         WHERE i.id IS NULL LIMIT 5000`
      )
      .all() as any[]
    const touchedMessages = new Set<string>()
    const newIds: string[] = []
    for (const a of fresh) {
      const noise = isNoiseAttachment({ filename: a.filename ?? '', contentType: a.content_type, size: a.size ?? 0, inline: !!a.inline, contentId: a.content_id })
      const m = { ...a, id: a.message_id } as MsgRow
      const who = this.describeMessage(m, accounts, specials)
      const c = classifyAttachment({ filename: a.filename ?? '', contentType: a.content_type, subject: a.subject })
      const path = a.path || appStore.attachmentPath(a.id)
      this.idx.upsert({
        id: a.id,
        messageId: a.message_id,
        accountId: a.account_id,
        filename: a.filename ?? '附件',
        contentType: a.content_type ?? 'application/octet-stream',
        size: a.size ?? 0,
        ext: extOf(a.filename ?? ''),
        category: c.category,
        confidence: c.confidence,
        ...who,
        subject: a.subject ?? '',
        date: a.date ?? 0,
        part: null,
        remoteOnly: false,
        cached: existsSync(path),
        cachePath: path
      })
      if (noise) db.prepare('UPDATE attachment_index SET skip = 1 WHERE id = ?').run(a.id)
      else newIds.push(a.id)
      touchedMessages.add(a.message_id)
      dirty = true
    }
    // 2) 占位行合并到真实行（按文件名配对）
    for (const mid of touchedMessages) {
      const rows = this.idx.byMessage(mid)
      const remote = rows.filter(r => r.remote_only)
      if (!remote.length) continue
      const real = rows.filter(r => !r.remote_only && !r.skip)
      const used = new Set<string>()
      for (const r of remote) {
        const hit = real.find(x => !used.has(x.id) && x.filename === r.filename) ?? real.find(x => !used.has(x.id) && x.ext === r.ext)
        if (hit) {
          used.add(hit.id)
          this.idx.mergeRemote(r.id, hit.id)
          this.merged.set(r.id, hit.id)
        } else {
          this.idx.delete(r.id)
        }
      }
    }
    // 3) 孤儿清理：原邮件 / 原附件行已删除
    const r1 = db.prepare(`DELETE FROM attachment_index WHERE id NOT LIKE 'r:%' AND id NOT IN (SELECT id FROM attachments)`).run()
    const r2 = db.prepare(`DELETE FROM attachment_index WHERE id LIKE 'r:%' AND message_id NOT IN (SELECT id FROM messages)`).run()
    if (Number(r1.changes) + Number(r2.changes) > 0) dirty = true
    // 4) 缓存状态刷新（文件被外部删除 / 重新下载回来）
    const cachedRows = db.prepare(`SELECT id, cached, cache_path FROM attachment_index WHERE remote_only = 0 AND skip = 0`).all() as { id: string; cached: number; cache_path: string | null }[]
    for (const r of cachedRows) {
      const exists = !!r.cache_path && existsSync(r.cache_path)
      if (exists !== !!r.cached) {
        if (exists) this.idx.setCached(r.id, true, null)
        else this.idx.setCached(r.id, false)
        dirty = true
      }
    }
    // 5) 存量邮件补建元数据（有附件但正文没下载过）
    await this.backfillParts(accounts).catch(() => {})
    // 6) 内容哈希（去重 / 网盘同内容跳过）
    if (await this.hashPending()) dirty = true
    // 7) AI 补充分类
    if (await this.aiAssist().catch(() => false)) dirty = true
    // 8) 自动规则
    this.applyAutoRules()
    if (dirty) {
      this.diskCache = null
      this.changed()
    }
  }

  private async backfillParts(accounts: Map<string, AccountConfig>) {
    const engine = this.deps.engine()
    if (!engine) return
    const rows = this.deps.db
      .prepare(
        `SELECT m.id, m.account_id, m.folder_path, m.uid FROM messages m
         WHERE m.has_attachments = 1 AND m.body_fetched = 0
           AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM attachment_index i WHERE i.message_id = m.id)
         ORDER BY m.date DESC LIMIT 400`
      )
      .all() as { id: string; account_id: string; folder_path: string; uid: number }[]
    const groups = new Map<string, { accountId: string; folder: string; uids: number[] }>()
    for (const r of rows) {
      if (this.partsTried.has(r.id) || !accounts.get(r.account_id)?.enabled) continue
      this.partsTried.add(r.id)
      const key = r.account_id + SEP + r.folder_path
      const g = groups.get(key) ?? { accountId: r.account_id, folder: r.folder_path, uids: [] }
      g.uids.push(r.uid)
      groups.set(key, g)
    }
    for (const g of groups.values()) {
      const worker = engine.getWorker(g.accountId)
      if (!worker) continue
      try {
        const res = await worker.fetchAttachmentParts(g.folder, g.uids.slice(0, 200))
        for (const r of res) this.indexParts(g.accountId, `${g.accountId}${SEP}${g.folder}${SEP}${r.uid}`, r.parts)
      } catch {
        // 未连接：下次扫描再试
        for (const uid of g.uids) this.partsTried.delete(`${g.accountId}${SEP}${g.folder}${SEP}${uid}`)
      }
    }
  }

  private async hashPending(): Promise<boolean> {
    const rows = this.deps.db
      .prepare(`SELECT id, cache_path, size FROM attachment_index WHERE cached = 1 AND hash IS NULL AND skip = 0 ORDER BY date DESC LIMIT 400`)
      .all() as { id: string; cache_path: string; size: number }[]
    let budget = 400 * 1024 * 1024
    let any = false
    for (const r of rows) {
      if (budget <= 0) break
      try {
        this.idx.setHash(r.id, await sha256File(r.cache_path))
        budget -= r.size || 0
        any = true
      } catch { /* 文件刚被删除 */ }
    }
    return any
  }

  private async aiAssist(): Promise<boolean> {
    const settings = this.getSettings()
    const ai = this.deps.getAISettings()
    if (!settings.aiAssist || !aiReady(ai, false)) return false
    const rows = this.deps.db
      .prepare(
        `SELECT * FROM attachment_index WHERE skip = 0 AND ai_checked = 0 AND category_source = 'rule' AND confidence < 0.7
         ORDER BY date DESC LIMIT 40`
      )
      .all() as unknown as IndexRow[]
    if (!rows.length) return false
    const lines = rows.map((r, i) => `A${i + 1} | ${r.filename.slice(0, 120)} | ${(r.subject ?? '').slice(0, 80)} | ${r.counterparty}`)
    this.idx.markAiChecked(rows.map(r => r.id))
    const answer = await this.deps.ai.complete(
      [
        { role: 'system', content: ATTACHMENT_CLASSIFY },
        { role: 'user', content: lines.join('\n') }
      ],
      800
    )
    const m = /\{[\s\S]*\}/.exec(answer)
    if (!m) return false
    let parsed: Record<string, string> = {}
    try {
      parsed = JSON.parse(m[0]) as Record<string, string>
    } catch {
      return false
    }
    let changed = false
    rows.forEach((r, i) => {
      const cat = String(parsed[`A${i + 1}`] ?? '').trim() as AttachmentCategory
      if (VALID_CATEGORIES.has(cat) && cat !== r.category) {
        this.idx.setCategory([r.id], cat, 'ai', 0.75)
        changed = true
      }
    })
    return changed
  }

  private applyAutoRules() {
    const s = this.getSettings()
    if (!s.autoRules.length || !s.autoSince) return
    const drives = new Set(listDrives(this.deps.appStore).map(d => d.id))
    const rows = this.deps.db
      .prepare(`SELECT id, category, cloud_json FROM attachment_index WHERE skip = 0 AND date >= ? ORDER BY date DESC LIMIT 500`)
      .all(s.autoSince) as { id: string; category: string; cloud_json: string }[]
    const add: JobItem[] = []
    for (const r of rows) {
      for (const rule of s.autoRules) {
        if (rule.category !== r.category || !drives.has(rule.driveId)) continue
        const key = `${r.id}>${rule.driveId}`
        if (this.autoQueued.has(key)) continue
        let cloud: AttachmentCloudCopy[] = []
        try {
          cloud = JSON.parse(r.cloud_json || '[]')
        } catch { /* ignore */ }
        if (cloud.some(c => c.driveId === rule.driveId)) continue
        this.autoQueued.add(key)
        add.push({ id: r.id, driveId: rule.driveId, attempts: 0 })
      }
    }
    if (add.length) this.enqueue(add, 'auto')
  }

  // ================= 查询 / 统计 =================

  list(q: AttachmentQuery): { items: AttachmentItem[]; total: number } {
    const { rows, total } = this.idx.list({ ...q })
    return { items: rows.map(rowToItem), total }
  }

  getItem(id: string): AttachmentItem | null {
    const r = this.idx.get(this.merged.get(id) ?? id)
    return r ? rowToItem(r) : null
  }

  /** Reader 附件卡：按附件 id 取状态（已在哪些网盘 / 是否已释放） */
  status(ids: string[]): Record<string, { cached: boolean; releasedAt: number | null; cloud: AttachmentCloudCopy[]; category: AttachmentCategory; pinned: boolean }> {
    const out: Record<string, { cached: boolean; releasedAt: number | null; cloud: AttachmentCloudCopy[]; category: AttachmentCategory; pinned: boolean }> = {}
    for (const r of this.idx.getMany(ids)) {
      const it = rowToItem(r)
      out[r.id] = { cached: it.cached, releasedAt: it.releasedAt, cloud: it.cloud, category: it.category, pinned: it.pinned }
    }
    return out
  }

  private visibleRows(): IndexRow[] {
    return this.deps.db.prepare('SELECT * FROM attachment_index WHERE skip = 0').all() as unknown as IndexRow[]
  }

  private diskInfo() {
    if (this.diskCache && Date.now() - this.diskCache.at < 5 * 60_000) return this.diskCache
    const { appStore, db } = this.deps
    let emlBytes = 0
    const walk = (dir: string, depth: number) => {
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory() && depth < 4) walk(p, depth + 1)
        else if (e.isFile()) emlBytes += Math.max(0, fileSize(p))
      }
    }
    walk(appStore.emlDir, 0)
    const known = new Set((db.prepare('SELECT id FROM attachments').all() as { id: string }[]).map(r => r.id.replace(/[^a-zA-Z0-9_-]/g, '')))
    const orphan = { count: 0, bytes: 0 }
    try {
      for (const name of readdirSync(appStore.attachmentDir)) {
        if (known.has(name)) continue
        const sz = fileSize(join(appStore.attachmentDir, name))
        if (sz < 0) continue
        orphan.count++
        orphan.bytes += sz
      }
    } catch { /* 目录不存在 */ }
    this.diskCache = { at: Date.now(), emlBytes, orphan }
    return this.diskCache
  }

  stats(): AttachmentStats {
    const rows = this.visibleRows()
    const accounts = this.accounts()
    const sum = (list: IndexRow[]) => ({ count: list.length, bytes: list.reduce((s, r) => s + (r.size || 0), 0) })
    const bucket = (keyOf: (r: IndexRow) => string, labelOf: (k: string) => string): AttachmentBucket[] => {
      const map = new Map<string, AttachmentBucket>()
      for (const r of rows) {
        const k = keyOf(r)
        const b = map.get(k) ?? { key: k, label: labelOf(k), count: 0, bytes: 0, localBytes: 0 }
        b.count++
        b.bytes += r.size || 0
        if (r.cached) b.localBytes += r.size || 0
        map.set(k, b)
      }
      return [...map.values()]
    }
    const byCategory = bucket(r => r.category, k => attachmentCategoryLabel(k)).sort(
      (a, b) => ATTACHMENT_CATEGORIES.findIndex(c => c.id === a.key) - ATTACHMENT_CATEGORIES.findIndex(c => c.id === b.key)
    )
    const byAccount = bucket(r => r.account_id, k => accounts.get(k)?.name ?? k).sort((a, b) => b.bytes - a.bytes)
    const byYear = bucket(r => (r.date ? String(new Date(r.date).getFullYear()) : '未知'), k => k).sort((a, b) => b.key.localeCompare(a.key))
    const byCounterparty = bucket(r => r.counterparty || '未知', k => k)
      .sort((a, b) => b.count - a.count)
      .slice(0, 60)
    const local = rows.filter(r => r.cached)
    const largest = [...local].sort((a, b) => b.size - a.size).slice(0, 12).map(rowToItem)
    const groups = new Map<string, IndexRow[]>()
    for (const r of local) {
      if (!r.hash) continue
      const g = groups.get(r.hash) ?? []
      g.push(r)
      groups.set(r.hash, g)
    }
    const duplicates = [...groups.entries()]
      .filter(([, g]) => g.length > 1)
      .map(([hash, g]) => ({
        hash,
        size: g[0].size,
        count: g.length,
        wasted: g[0].size * (g.length - 1),
        items: g.map(r => ({ id: r.id, filename: r.filename, messageId: r.message_id }))
      }))
      .sort((a, b) => b.wasted - a.wasted)
      .slice(0, 30)
    const disk = this.diskInfo()
    return {
      total: sum(rows),
      local: sum(local),
      released: sum(rows.filter(r => !r.cached && !r.remote_only && r.released_at)),
      remote: sum(rows.filter(r => r.remote_only)),
      archived: sum(rows.filter(r => r.cloud_json && r.cloud_json !== '[]')),
      byCategory,
      byAccount,
      byYear,
      byCounterparty,
      largest,
      duplicates,
      emlBytes: disk.emlBytes,
      orphan: disk.orphan,
      lastScanAt: this.lastScanAt
    }
  }

  // ================= 网盘目标 =================

  targets(): ArchiveTarget[] {
    return listDrives(this.deps.appStore).map(d => ({
      driveId: d.id,
      name: d.name,
      kind: d.kind,
      root: driveRootLabel(d),
      isProton: /proton/i.test(d.name) || /protondrive|proton drive/i.test(d.localPath ?? '')
    }))
  }

  /** 一键添加 Proton Drive：检测 Proton Drive for macOS 的同步目录，复用网盘保存流程 */
  addProton(home?: string): { ok: boolean; error?: string; downloadUrl: string; driveId?: string } {
    const folders = detectProtonDriveFolders(home)
    if (!folders.length) return { ok: false, error: '未检测到 Proton Drive 同步目录', downloadUrl: PROTON_DRIVE_DOWNLOAD_URL }
    const existing = listDrives(this.deps.appStore).find(d => d.kind === 'local' && d.localPath === folders[0].path)
    if (existing) return { ok: true, downloadUrl: PROTON_DRIVE_DOWNLOAD_URL, driveId: existing.id }
    const cfg: CloudDriveConfig = { id: randomUUID(), kind: 'local', name: 'Proton Drive', url: '', username: '', remotePath: '/LinkTo', localPath: folders[0].path }
    const res = saveDrive(this.deps.appStore, cfg, '')
    return { ...res, downloadUrl: PROTON_DRIVE_DOWNLOAD_URL, driveId: res.ok ? cfg.id : undefined }
  }

  private pickTarget(targets: ArchiveTarget[]): string | null {
    const s = this.getSettings()
    if (s.defaultDriveId && targets.some(t => t.driveId === s.defaultDriveId)) return s.defaultDriveId
    return (targets.find(t => t.isProton) ?? targets.find(t => t.kind === 'dropbox') ?? targets[0])?.driveId ?? null
  }

  suggest(windowDays = 90): ArchiveSuggestion {
    const settings = this.getSettings()
    const keep = new Set(settings.keepCategories)
    const all = this.visibleRows().filter(r => !r.cloud_json || r.cloud_json === '[]')
    let days = windowDays
    let rows = days > 0 ? all.filter(r => r.date >= Date.now() - days * 864e5) : all
    if (!rows.length && days > 0) {
      days = 0
      rows = all
    }
    const counts = new Map<AttachmentCategory, number>()
    for (const r of rows) counts.set(r.category as AttachmentCategory, (counts.get(r.category as AttachmentCategory) ?? 0) + 1)
    const targets = this.targets()
    return {
      windowDays: days,
      count: rows.length,
      bytes: rows.reduce((s, r) => s + (r.size || 0), 0),
      byCategory: ATTACHMENT_CATEGORIES.filter(c => counts.has(c.id)).map(c => ({ category: c.id, count: counts.get(c.id) ?? 0 })),
      releasableBytes: rows.filter(r => r.cached && !r.pinned && !keep.has(r.category as AttachmentCategory)).reduce((s, r) => s + (r.size || 0), 0),
      needDownload: rows.filter(r => !r.cached).length,
      targets,
      recommended: this.pickTarget(targets),
      ids: rows.map(r => r.id)
    }
  }

  private targetPathFor(r: IndexRow, template: string, accounts: Map<string, AccountConfig>): string {
    return renderPathTemplate(template, {
      category: attachmentCategoryLabel(r.category),
      date: r.date,
      party: r.counterparty,
      sender: r.counterparty_addr || r.counterparty,
      account: accounts.get(r.account_id)?.name ?? r.account_id,
      filename: r.filename,
      subject: r.subject
    })
  }

  /** 归档预览：每个附件的目标路径与动作（上传 / 先下载再上传 / 已归档跳过 / 同内容跳过） */
  preview(driveId: string, ids: string[], template?: string): ArchivePreview {
    const drive = listDrives(this.deps.appStore).find(d => d.id === driveId)
    const tpl = template?.trim() || this.getSettings().pathTemplate
    const accounts = this.accounts()
    const rows = this.idx.getMany(ids.map(id => this.merged.get(id) ?? id)).filter(r => !r.skip)
    const seenHash = new Set<string>()
    const items: ArchivePreviewItem[] = rows
      .sort((a, b) => b.date - a.date)
      .map(r => {
        const it = rowToItem(r)
        let action: ArchivePreviewItem['action'] = r.cached ? 'upload' : 'download-upload'
        if (it.cloud.some(c => c.driveId === driveId)) action = 'skip-archived'
        else if (r.hash && (seenHash.has(r.hash) || this.idx.cloudByHash(r.hash, driveId))) action = 'skip-duplicate'
        if (r.hash) seenHash.add(r.hash)
        return { id: r.id, filename: r.filename, size: r.size, category: it.category, target: this.targetPathFor(r, tpl, accounts), action }
      })
    const up = items.filter(i => i.action === 'upload' || i.action === 'download-upload')
    return {
      driveId,
      driveName: drive?.name ?? '网盘',
      root: drive ? driveRootLabel(drive) : '',
      items,
      uploadCount: up.length,
      uploadBytes: up.reduce((s, i) => s + i.size, 0),
      skipCount: items.length - up.length
    }
  }

  // ================= 本地恢复（释放后的重新下载） =================

  private emlPathOf(accountId: string, folderPath: string, uid: number): string {
    // 与 AppStore.emlPath 同规则，但不建目录（只探测）
    const safeFolder = encodeURIComponent(folderPath).replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(this.deps.appStore.emlDir, accountId.replace(/[^a-zA-Z0-9_-]/g, ''), safeFolder, `${uid}.eml`)
  }

  /** 从 eml 原文镜像重新解析出附件写回缓存（离线、零网络）；附件 id 与同步引擎同算法 */
  private async restoreFromEml(m: MsgRow, wantIds: Set<string>): Promise<number> {
    const p = this.emlPathOf(m.account_id, m.folder_path, m.uid)
    if (!existsSync(p)) return 0
    const parsed = await parseEmailRaw(readFileSync(p))
    let n = 0
    for (const [i, att] of (parsed.attachments ?? []).entries()) {
      const attId = createHash('sha1')
        .update(`${m.id}#${i}#${att.filename ?? ''}#${att.size ?? 0}`)
        .digest('hex')
        .slice(0, 24)
      if (!wantIds.has(attId)) continue
      const target = this.deps.appStore.attachmentPath(attId)
      if (!existsSync(target)) {
        writeFileSync(target, att.content)
        n++
      }
    }
    return n
  }

  /**
   * 确保附件在本地：缓存在 → 直接返回；否则依次尝试 eml 镜像（离线）→ IMAP 重新下载整封 → 网盘副本。
   * 仅元数据的附件（r:）下载后换成真实 id。
   */
  async ensureLocal(id0: string): Promise<{ ok: boolean; id?: string; path?: string; error?: string; via?: 'cache' | 'eml' | 'imap' | 'cloud' }> {
    const id = this.merged.get(id0) ?? id0
    const { store, appStore } = this.deps
    const row = this.idx.get(id)
    const att = id.startsWith('r:') ? null : store.getAttachment(id)
    if (att && existsSync(att.path)) return { ok: true, id, path: att.path, via: 'cache' }
    const messageId = row?.message_id ?? att?.messageId
    if (!messageId) return { ok: false, error: '附件记录不存在' }
    const m = store.getMessageRow(messageId) as MsgRow | undefined
    if (!m) return this.restoreFromCloud(id, row, '原邮件已不在本地库')
    const finish = async (via: 'eml' | 'imap' | 'cloud') => {
      // 正在跑的扫描可能早于这次下载开始：等它结束再扫一轮，确保新附件行已入索引并完成占位合并
      if (this.scanning) await this.scanning.catch(() => {})
      await this.scan()
      const realId = id.startsWith('r:') ? this.merged.get(id) : id
      const real = realId ? store.getAttachment(realId) : null
      if (realId && real && existsSync(real.path)) {
        this.idx.setCached(realId, true, null)
        this.changed()
        return { ok: true, id: realId, path: real.path, via }
      }
      return null
    }
    // 1) eml 镜像（真实附件才能按 id 写回）
    if (att) {
      try {
        if ((await this.restoreFromEml(m, new Set([id]))) > 0) {
          const r = await finish('eml')
          if (r) return r
        }
      } catch { /* 镜像损坏：继续走网络 */ }
    }
    // 2) IMAP 重新下载整封（同步引擎会重新落盘全部附件与 eml 镜像）
    const worker = this.deps.engine()?.getWorker(m.account_id)
    let imapErr = ''
    if (worker) {
      try {
        await worker.downloadBody(m.folder_path, m.uid)
        const r = await finish('imap')
        if (r) return r
        imapErr = '服务器上已找不到这封邮件或附件'
      } catch (err) {
        imapErr = /not connected/i.test(String(err)) ? '账户未连接' : err instanceof Error ? err.message : String(err)
      }
    } else {
      imapErr = '账户未启用或未连接'
    }
    // 3) 网盘副本
    return this.restoreFromCloud(id, row, `无法从邮件服务器重新下载（${imapErr}）`)
  }

  private async restoreFromCloud(id: string, row: IndexRow | undefined, why: string) {
    if (row && !id.startsWith('r:')) {
      for (const c of rowToItem(row).cloud) {
        const data = await driveDownload(this.deps.appStore, c.driveId, c.path)
        if (!data) continue
        if (row.hash && sha256(data) !== row.hash) continue
        const target = row.cache_path || this.deps.appStore.attachmentPath(id)
        writeFileSync(target, data)
        this.idx.setCached(id, true, null)
        this.changed()
        return { ok: true, id, path: target, via: 'cloud' as const }
      }
    }
    return { ok: false, error: `${why}。联网并确认账户已连接后再试；已归档的附件也可在网盘里直接打开。` }
  }

  // ================= 释放空间 =================

  private safetyFor(rows: IndexRow[]): (id: string) => SafetyResult {
    const { appStore, store } = this.deps
    const cacheDir = realOrSelf(appStore.attachmentDir)
    const accounts = this.accounts()
    const specials = this.folderSpecial()
    const map = new Map(rows.map(r => [r.id, r]))
    return (id: string) => {
      const r = map.get(id)
      if (!r) return { safe: false, via: [], reason: '记录不存在' }
      const att = store.getAttachment(id)
      const path = att?.path ?? r.cache_path ?? ''
      const exists = !!path && existsSync(path)
      const m = store.getMessageRow(r.message_id) as MsgRow | undefined
      const it = rowToItem(r)
      const cloudVerified = it.cloud.some(c => {
        if (c.kind !== 'local') return true // 远端网盘：已登记；执行释放前会再探测一次
        const lp = c.localPath ?? driveLocalPath(appStore, c.driveId, c.path)
        return !!lp && fileSize(lp) === r.size
      })
      return releaseSafety({
        path: exists ? realOrSelf(path) : path,
        cacheDir,
        fileExists: exists,
        filename: r.filename,
        inline: !!att?.inline,
        messageExists: !!m,
        accountEnabled: !!(m && accounts.get(m.account_id)?.enabled),
        folderSpecial: m ? specials.get(m.folder_id) ?? null : null,
        emlMirror: !!m && existsSync(this.emlPathOf(m.account_id, m.folder_path, m.uid)),
        cloudVerified
      })
    }
  }

  /** 释放清单：ids 为空 = 按策略给建议；ids 非空 = 用户手动选择（仍过安全判定，钉住 / 保留分类排除） */
  releasePlan(ids?: string[] | null): ReleasePlan {
    const s = this.getSettings()
    const rows = ids && ids.length ? this.idx.getMany(ids.map(i => this.merged.get(i) ?? i)) : this.visibleRows()
    const items: PolicyItem[] = rows
      .filter(r => !r.skip)
      .map(r => ({
        id: r.id,
        filename: r.filename,
        size: r.size,
        date: r.date,
        category: r.category as AttachmentCategory,
        cached: !!r.cached,
        pinned: !!r.pinned,
        archived: !!r.cloud_json && r.cloud_json !== '[]'
      }))
    const { candidates, kept } = planReleaseCandidates(items, s, Date.now(), ids && ids.length ? ids.map(i => this.merged.get(i) ?? i) : null)
    return assembleReleasePlan(candidates, kept, this.safetyFor(rows), !!(ids && ids.length))
  }

  /** 执行释放：逐个重新做安全判定（远端网盘副本再探测一次），只删 LinkTo 附件缓存目录里的文件 */
  async release(ids: string[]): Promise<{ released: number; bytes: number; skipped: { id: string; filename: string; reason: string }[] }> {
    const rows = this.idx.getMany(ids.map(i => this.merged.get(i) ?? i))
    const safety = this.safetyFor(rows)
    const s = this.getSettings()
    const keep = new Set(s.keepCategories)
    let released = 0
    let bytes = 0
    const skipped: { id: string; filename: string; reason: string }[] = []
    for (const r of rows) {
      if (r.pinned) {
        skipped.push({ id: r.id, filename: r.filename, reason: '已钉住' })
        continue
      }
      if (keep.has(r.category as AttachmentCategory)) {
        skipped.push({ id: r.id, filename: r.filename, reason: '永久保留的分类' })
        continue
      }
      const v = safety(r.id)
      if (!v.safe) {
        skipped.push({ id: r.id, filename: r.filename, reason: v.reason })
        continue
      }
      // 只靠远端网盘副本兜底时：执行前再确认一次它确实还在
      if (v.via.length === 1 && v.via[0] === 'cloud') {
        let ok = false
        for (const c of rowToItem(r).cloud) {
          if (c.kind === 'local') {
            const lp = c.localPath ?? driveLocalPath(this.deps.appStore, c.driveId, c.path)
            if (lp && existsSync(lp) && (!r.hash || (await sha256File(lp).catch(() => '')) === r.hash)) ok = true
          } else if (await driveExists(this.deps.appStore, c.driveId, c.path)) ok = true
          if (ok) break
        }
        if (!ok) {
          skipped.push({ id: r.id, filename: r.filename, reason: '网盘副本无法确认存在' })
          continue
        }
      }
      const att = this.deps.store.getAttachment(r.id)
      const path = att?.path ?? r.cache_path
      if (!path) continue
      try {
        unlinkSync(path)
        this.idx.setCached(r.id, false, Date.now())
        released++
        bytes += r.size || 0
      } catch (err) {
        skipped.push({ id: r.id, filename: r.filename, reason: err instanceof Error ? err.message : String(err) })
      }
    }
    this.diskCache = null
    this.changed()
    return { released, bytes, skipped }
  }

  setPinned(ids: string[], pinned: boolean) {
    this.idx.setPinned(ids.map(i => this.merged.get(i) ?? i), pinned)
    this.changed()
  }

  setCategory(ids: string[], category: AttachmentCategory) {
    if (!VALID_CATEGORIES.has(category)) return
    this.idx.setCategory(ids.map(i => this.merged.get(i) ?? i), category, 'manual')
    this.changed()
  }

  // ================= 归档队列 =================

  startArchive(driveId: string, ids: string[]): ArchiveJobStatus | null {
    if (!listDrives(this.deps.appStore).some(d => d.id === driveId)) return this.job
    this.enqueue(
      ids.map(id => ({ id, driveId, attempts: 0 })),
      'manual'
    )
    return this.job
  }

  private enqueue(items: JobItem[], origin: 'manual' | 'auto') {
    const known = new Set(this.queue.map(q => `${q.id}>${q.driveId}`))
    const fresh = items.filter(i => !known.has(`${i.id}>${i.driveId}`))
    if (!fresh.length) return
    const drive = listDrives(this.deps.appStore).find(d => d.id === fresh[0].driveId)
    if (!this.job || this.job.state === 'done' || this.job.state === 'cancelled') {
      this.job = {
        id: randomUUID(),
        driveId: fresh[0].driveId,
        driveName: drive?.name ?? '网盘',
        state: 'running',
        total: 0,
        done: 0,
        uploaded: 0,
        skipped: 0,
        bytesDone: 0,
        current: null,
        failed: [],
        startedAt: Date.now(),
        finishedAt: null,
        origin
      }
    }
    if (this.job.driveId !== fresh[0].driveId) this.job.driveName = '多个网盘'
    this.job.total += fresh.length
    this.queue.push(...fresh)
    if (this.job.state !== 'paused') this.job.state = 'running'
    this.emitJob(true)
    void this.pump()
  }

  control(action: 'pause' | 'resume' | 'cancel' | 'retry'): ArchiveJobStatus | null {
    const job = this.job
    if (!job) return null
    if (action === 'pause' && job.state === 'running') {
      this.paused = true
      job.state = 'paused'
    } else if (action === 'resume' && job.state === 'paused') {
      this.paused = false
      job.state = 'running'
      this.resumeWaiter?.()
    } else if (action === 'cancel') {
      this.queue = []
      this.paused = false
      job.state = 'cancelled'
      job.current = null
      job.finishedAt = Date.now()
      this.resumeWaiter?.()
    } else if (action === 'retry' && job.failed.length) {
      const items = job.failed.map(f => ({ id: f.id, driveId: f.driveId ?? job.driveId, attempts: 0 }))
      job.failed = []
      job.done -= items.length
      job.total = Math.max(job.total, job.done + items.length)
      job.state = 'running'
      job.finishedAt = null
      this.paused = false
      this.queue.push(...items)
      void this.pump()
    }
    this.emitJob(true)
    return job
  }

  jobStatus(): ArchiveJobStatus | null {
    return this.job
  }

  private emitJob(force = false) {
    const now = Date.now()
    if (!force && now - this.lastEmit < 250) return
    this.lastEmit = now
    this.deps.event({ type: 'attachments-job', status: this.job })
  }

  private async pump() {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length && this.job && this.job.state !== 'cancelled') {
        if (this.paused) {
          await new Promise<void>(r => (this.resumeWaiter = r))
          this.resumeWaiter = null
          continue
        }
        const item = this.queue.shift()!
        const job = this.job
        const row = this.idx.get(this.merged.get(item.id) ?? item.id)
        job.current = row?.filename ?? item.id
        this.emitJob()
        try {
          const res = await this.archiveOne(item)
          if (res === 'uploaded') job.uploaded++
          else job.skipped++
          if (res === 'uploaded') job.bytesDone += row?.size ?? 0
        } catch (err) {
          job.failed.push({ id: item.id, filename: row?.filename ?? item.id, error: err instanceof Error ? err.message : String(err), driveId: item.driveId })
        }
        if (job.state === 'cancelled') break
        job.done++
        this.emitJob()
      }
      if (this.job && this.job.state === 'running') {
        this.job.state = 'done'
        this.job.current = null
        this.job.finishedAt = Date.now()
      }
    } finally {
      this.running = false
      this.emitJob(true)
      this.changed()
    }
  }

  /** 归档一个附件：确保本地 → 哈希 → 同盘同内容跳过 → 渲染目标路径 → 同名不同内容加序号 → 上传 → 登记位置 */
  private async archiveOne(item: JobItem): Promise<'uploaded' | 'skipped'> {
    const { appStore } = this.deps
    const drive = listDrives(appStore).find(d => d.id === item.driveId)
    if (!drive) throw new Error('网盘配置已被删除')
    const local = await this.ensureLocal(item.id)
    if (!local.ok || !local.id || !local.path) throw new Error(local.error ?? '附件无法取得')
    const id = local.id
    let row = this.idx.get(id)
    if (!row) throw new Error('附件索引不存在')
    if (rowToItem(row).cloud.some(c => c.driveId === drive.id)) return 'skipped'
    const data = readFileSync(local.path)
    const hash = row.hash ?? sha256(data)
    if (!row.hash) this.idx.setHash(id, hash)
    const dup = this.idx.cloudByHash(hash, drive.id)
    if (dup) {
      this.idx.addCloud(id, { ...dup, at: Date.now() })
      return 'skipped'
    }
    row = this.idx.get(id)!
    const base = this.targetPathFor(row, this.getSettings().pathTemplate, this.accounts())
    let target = base
    for (let n = 2; n < 50; n++) {
      if (drive.kind === 'local') {
        const abs = driveLocalPath(appStore, drive.id, target)
        if (!abs || !existsSync(abs)) break
        // 同名同内容：直接登记，不重复写
        if ((await sha256File(abs).catch(() => '')) === hash) {
          this.idx.addCloud(id, { driveId: drive.id, driveName: drive.name, kind: drive.kind, path: target, localPath: abs, hash, at: Date.now() })
          return 'skipped'
        }
      } else {
        const known = this.idx.hashAtCloudPath(drive.id, target)
        if (known === hash) {
          this.idx.addCloud(id, { driveId: drive.id, driveName: drive.name, kind: drive.kind, path: target, hash, at: Date.now() })
          return 'skipped'
        }
        if (!known && !(await driveExists(appStore, drive.id, target))) break
      }
      target = withSerial(base, n)
    }
    const res = await driveUpload(appStore, drive.id, target, data)
    if (!res.ok) throw new Error(res.error ?? '上传失败')
    const abs = drive.kind === 'local' ? driveLocalPath(appStore, drive.id, target) ?? undefined : undefined
    this.idx.addCloud(id, { driveId: drive.id, driveName: drive.name, kind: drive.kind, path: target, localPath: abs, hash, at: Date.now() })
    return 'uploaded'
  }

  /** 旧入口（阅读窗单个附件「上传到网盘」）成功后登记位置 */
  recordLegacyUpload(attachmentId: string, driveId: string, remotePath: string) {
    const drive = listDrives(this.deps.appStore).find(d => d.id === driveId)
    const row = this.idx.get(attachmentId)
    if (!drive || !row) return
    const abs = drive.kind === 'local' ? driveLocalPath(this.deps.appStore, driveId, remotePath) ?? undefined : undefined
    this.idx.addCloud(attachmentId, { driveId, driveName: drive.name, kind: drive.kind, path: remotePath, localPath: abs, hash: row.hash, at: Date.now() })
    this.changed()
  }

  // ================= 打开 / 显示 / 另存 / 缩略图 =================

  async reveal(id: string, driveId?: string): Promise<{ ok: boolean; error?: string }> {
    const it = this.getItem(id)
    if (!it) return { ok: false, error: '附件不存在' }
    const copy = driveId ? it.cloud.find(c => c.driveId === driveId) : it.cloud[0]
    if (!copy) return { ok: false, error: '还没有归档到网盘' }
    if (copy.kind === 'local') {
      const lp = copy.localPath ?? driveLocalPath(this.deps.appStore, copy.driveId, copy.path)
      if (!lp || !existsSync(lp)) return { ok: false, error: '网盘同步目录里找不到这个文件（可能被移动或删除）' }
      shell.showItemInFolder(lp)
      return { ok: true }
    }
    const url = driveWebUrl(this.deps.appStore, copy.driveId, copy.path)
    if (!url) return { ok: false, error: '无法定位云端位置' }
    await shell.openExternal(url)
    return { ok: true }
  }

  /** 用系统默认应用打开：缓存文件没有扩展名，复制一份带原文件名的临时副本 */
  async open(id: string): Promise<{ ok: boolean; error?: string }> {
    const local = await this.ensureLocal(id)
    if (!local.ok || !local.path || !local.id) return { ok: false, error: local.error }
    const it = this.getItem(local.id)
    const dir = join(app.getPath('temp'), 'linkto-open', local.id)
    mkdirSync(dir, { recursive: true })
    const target = join(dir, (it?.filename ?? 'attachment').replace(/[/\\:*?"<>|]/g, '_'))
    copyFileSync(local.path, target)
    const err = await shell.openPath(target)
    return err ? { ok: false, error: err } : { ok: true }
  }

  async saveMany(ids: string[]): Promise<{ ok: boolean; count: number; dir?: string; failed: number; error?: string }> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, { title: '保存附件到…', properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths[0]) return { ok: false, count: 0, failed: 0 }
    const dir = res.filePaths[0]
    let count = 0
    let failed = 0
    let lastErr = ''
    for (const id of ids) {
      const local = await this.ensureLocal(id)
      const it = local.id ? this.getItem(local.id) : null
      if (!local.ok || !local.path || !it) {
        failed++
        lastErr = local.error ?? ''
        continue
      }
      const safe = it.filename.replace(/[/\\:*?"<>|]/g, '_') || 'attachment'
      let target = join(dir, safe)
      for (let n = 2; existsSync(target) && n < 1000; n++) target = join(dir, withSerial('/' + safe, n).slice(1))
      try {
        copyFileSync(local.path, target)
        count++
      } catch (err) {
        failed++
        lastErr = String(err)
      }
    }
    return { ok: count > 0, count, dir, failed, error: failed ? lastErr : undefined }
  }

  thumbs(ids: string[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (const id of ids.slice(0, 80)) {
      const r = this.idx.get(id)
      if (!r || !r.cached || !r.cache_path || r.size > 15 * 1024 * 1024) continue
      if (!/^image\/(png|jpe?g|gif|webp|bmp)/i.test(r.content_type) && !/^(png|jpe?g|gif|webp|bmp)$/.test(r.ext)) continue
      try {
        const img = nativeImage.createFromBuffer(readFileSync(r.cache_path))
        if (img.isEmpty()) continue
        const sz = img.getSize()
        const t = sz.width > 320 ? img.resize({ width: 320, quality: 'good' }) : img
        out[id] = t.toDataURL()
      } catch { /* 非图片或损坏 */ }
    }
    return out
  }

  /** 测试网盘连通（目标面板里的「测试」） */
  testDrive(driveId: string) {
    return driveTest(this.deps.appStore, driveId)
  }
}
