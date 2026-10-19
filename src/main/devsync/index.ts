/**
 * 跨设备同步（账户与凭据 + Agent 与各中心数据）：经同步邮箱里的隐藏文件夹 LinkTo-Vault 交换加密记录。
 * 与待办同步共用同一个同步邮箱、同一个口令、同一个设备名（设置 → 同步与备份）。协议见 ./protocol.ts。
 *
 * 新设备流程：手动添加任意一个账户（或用备份文件恢复）→ 开启同步并输入同一口令 → 拉取其余账户：
 * 自动写入配置与凭据并立即做连接测试；成功的直接可用，失败的标出原因；设备相关账户（Proton Bridge、
 * localhost 服务器）只同步配置，另一台设备的密码存为候选、默认不启用，提示「这台电脑需要填写本机 Bridge 的密码」。
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { app, ipcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { AccountConfig } from '@shared/types'
import {
  DEVSYNC_CATEGORIES,
  defaultDevSyncCategories,
  type DevSyncAccountIssue,
  type DevSyncCategory,
  type DevSyncConfigureInput,
  type DevSyncPendingDelete,
  type DevSyncStats,
  type DevSyncStatus
} from '@shared/devsync'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import type { SyncEngine } from '../mail/sync-engine'
import { friendlyError } from '../mail/sync-engine'
import type { MailSender } from '../mail/sender'
import type { OAuthService } from '../oauth'
import type { TodoSyncService } from '../todo-sync'
import { logActivity } from '../agent/hooks'
import { KeyRing, TodoSyncError, VAULT_FOLDER, hashData, type StateRow, type VaultRefs } from './protocol'
import { vaultRound, newVaultStats, type ApplyContext, type VaultStateStore } from './engine'
import { buildAdapters, readDevices, writeDevice, CANDIDATE_SECRET, UI_PREFS_KEY, type Adapter } from './adapters'
import { accountKeyOf, collectRefs, isDeviceBoundAccount, remapRefs } from './refs'

/* eslint-disable @typescript-eslint/no-explicit-any */

const SETTINGS_KEY = 'devSync'
const ISSUES_KEY = 'devsyncIssues'
const PENDING_KEY = 'devsyncPendingDeletes'
const TODO_KEY = 'todoSync'
const PASS_SECRET = 'todosync:passphrase'
const HASH_SECRET = 'devsync:hashkey'
const POLL_MS = 5 * 60_000
const DIRTY_MS = 60_000
const DEBOUNCE_MS = 4000
const ROUND_LIMIT = 300

interface Settings {
  enabled: boolean
  categories: Record<DevSyncCategory, boolean>
  deviceId: string
  lastSyncAt: number | null
  lastError: string | null
  lastStats: DevSyncStats | null
  /** 口令 / 同步邮箱的指纹：变了就清空同步状态（旧状态里的 wireId 不再适用） */
  scope: string | null
}

interface StoredIssue {
  kind: DevSyncAccountIssue['kind']
  text: string
  at: number
  /** 出问题时凭据的指纹：用户改了密码 / 重新授权后自动消失 */
  credSig: string
}

type AccountAction = { kind: 'created' | 'cred' | 'restart'; accountId: string; device: string | null; how?: 'password' | 'oauth' }

class SqliteState implements VaultStateStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS devsync_state (
      type TEXT NOT NULL,
      id TEXT NOT NULL,
      wire TEXT NOT NULL,
      hash TEXT,
      local_ver INTEGER NOT NULL DEFAULT 0,
      remote_ver INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (type, id)
    )`)
  }
  all(): StateRow[] {
    return (this.db.prepare('SELECT * FROM devsync_state').all() as any[]).map(r => ({
      type: r.type,
      id: r.id,
      wire: r.wire,
      hash: r.hash ?? null,
      localVer: Number(r.local_ver) || 0,
      remoteVer: Number(r.remote_ver) || 0,
      deleted: !!r.deleted,
      skipped: !!r.skipped
    }))
  }
  set(s: StateRow) {
    this.db
      .prepare(
        `INSERT INTO devsync_state (type, id, wire, hash, local_ver, remote_ver, deleted, skipped) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(type, id) DO UPDATE SET wire=excluded.wire, hash=excluded.hash, local_ver=excluded.local_ver, remote_ver=excluded.remote_ver,
           deleted=excluded.deleted, skipped=excluded.skipped`
      )
      .run(s.type, s.id, s.wire, s.hash, Math.floor(s.localVer), Math.floor(s.remoteVer), s.deleted ? 1 : 0, s.skipped ? 1 : 0)
  }
  delete(type: string, id: string) {
    this.db.prepare('DELETE FROM devsync_state WHERE type = ? AND id = ?').run(type, id)
  }
  get(type: string, id: string): StateRow | undefined {
    return this.all().find(s => s.type === type && s.id === id)
  }
  clear() {
    this.db.exec('DELETE FROM devsync_state')
  }
}

export interface DevSyncDeps {
  db: DatabaseSync
  store: MailStore
  appStore: AppStore
  engine: SyncEngine
  sender: MailSender
  oauth: OAuthService
  todoSync: TodoSyncService
  /** 留痕同步（可能尚未初始化） */
  traceSync(): { status(): { enabled: boolean; lastSyncAt: number | null; lastError: string | null }; configure(input: { enabled: boolean }): Promise<unknown> } | null
  /** 同步 / 恢复改写了本地数据（各中心有内存缓存的在这里失效） */
  afterApply?(types: string[]): void
  setStatus(accountId: string, status: 'connected' | 'syncing' | 'error' | 'disabled', text: string): void
  event(payload: unknown): void
}

let instance: DevSyncService | null = null
export const devSyncService = () => instance

export class DevSyncService {
  readonly state: SqliteState
  readonly adapters: Adapter[]
  private running = false
  private rerun = false
  private pollTimer: NodeJS.Timeout | null = null
  private dirtyTimer: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private keyring: { pass: string; ring: KeyRing } | null = null
  private actions: AccountAction[] = []
  private notes: string[] = []
  /** 备份导出时临时覆盖「含密钥」开关 */
  private flagOverride: { shareSecrets: boolean; aiKey: boolean } | null = null

  constructor(private deps: DevSyncDeps) {
    this.state = new SqliteState(deps.db)
    this.adapters = buildAdapters({
      store: deps.store,
      db: deps.db,
      appStore: deps.appStore,
      oauth: deps.oauth,
      flags: () => this.flagOverride ?? { shareSecrets: this.catOn('shareSecrets'), aiKey: this.catOn('aiKey') },
      deviceId: () => this.settings().deviceId,
      event: deps.event,
      accounts: {
        created: (id, ctx) => this.actions.push({ kind: 'created', accountId: id, device: ctx.device }),
        configChanged: (id, restart) => restart && this.actions.push({ kind: 'restart', accountId: id, device: null }),
        credChanged: (id, ctx, how) => this.actions.push({ kind: 'cred', accountId: id, device: ctx.device, how }),
        candidateSaved: (id, ctx) => this.actions.push({ kind: 'cred', accountId: id, device: ctx.device }),
        requestDelete: (key, accountId, email, device) => this.addPendingDelete({ key, accountId, email, device, at: Date.now() })
      }
    })
  }

  // ================================================================ 设置

  settings(): Settings {
    const raw = this.deps.appStore.getRaw<Partial<Settings>>(SETTINGS_KEY, {}) ?? {}
    const s: Settings = {
      enabled: !!raw.enabled,
      categories: { ...defaultDevSyncCategories(), ...(raw.categories ?? {}) },
      deviceId: raw.deviceId || '',
      lastSyncAt: raw.lastSyncAt ?? null,
      lastError: raw.lastError ?? null,
      lastStats: raw.lastStats ?? null,
      scope: raw.scope ?? null
    }
    if (!s.deviceId) {
      s.deviceId = `dev-${randomUUID().slice(0, 12)}`
      this.deps.appStore.set(SETTINGS_KEY, s)
    }
    return s
  }

  private save(patch: Partial<Settings>) {
    this.deps.appStore.set(SETTINGS_KEY, { ...this.settings(), ...patch })
  }

  private catOn(c: DevSyncCategory): boolean {
    const cats = this.settings().categories
    const info = DEVSYNC_CATEGORIES.find(x => x.id === c)
    return !!cats[c] && (!info?.parent || !!cats[info.parent])
  }

  private todoSettings(): { enabled?: boolean; accountId?: string | null; encrypt?: boolean; deviceName?: string } {
    return this.deps.appStore.getRaw<any>(TODO_KEY, {}) ?? {}
  }

  private deviceName(): string {
    return this.todoSettings().deviceName || hostname().replace(/\.local$/, '') || 'LinkTo'
  }

  private hashKey(): Buffer {
    let k = this.deps.appStore.loadSecret(HASH_SECRET)
    if (!k) {
      k = randomBytes(32).toString('base64')
      this.deps.appStore.saveSecret(HASH_SECRET, k)
    }
    return Buffer.from(k, 'base64')
  }

  private hash = (data: unknown) => hashData(this.hashKey(), data)

  private credSig(a: AccountConfig): string {
    const v = a.authType === 'oauth' ? this.deps.oauth.loadTokens(a.id)?.refreshToken ?? '' : this.deps.appStore.loadSecret(`acct:${a.id}`)
    return createHmac('sha256', this.hashKey()).update(`cred\n${v}`).digest('hex').slice(0, 16)
  }

  private account(id: string) {
    return this.deps.store.listAccounts().find(a => a.id === id) ?? null
  }

  private hasCred(a: AccountConfig): boolean {
    return a.authType === 'oauth' ? !!this.deps.oauth.loadTokens(a.id) : !!this.deps.appStore.loadSecret(`acct:${a.id}`)
  }

  // ================================================================ 状态

  private enabledAdapters(): Adapter[] {
    return this.adapters.filter(a => a.vault && (a.category === 'device' || this.catOn(a.category as DevSyncCategory)))
  }

  counts(): Partial<Record<DevSyncCategory, number>> {
    const out: Partial<Record<DevSyncCategory, number>> = {}
    for (const a of this.adapters) {
      if (a.category === 'device') continue
      if (a.type.startsWith('setting.') || a.type === 'ui-prefs' || a.type === 'job-enabled' || a.type === 'secret.feed-search' || a.type === 'oauth-clients' || a.type === 'cred') continue
      try {
        out[a.category as DevSyncCategory] = (out[a.category as DevSyncCategory] ?? 0) + a.list().length
      } catch {
        /* 表还没建好 */
      }
    }
    return out
  }

  private issues(): DevSyncAccountIssue[] {
    const stored = this.deps.appStore.getRaw<Record<string, StoredIssue>>(ISSUES_KEY, {}) ?? {}
    const out: DevSyncAccountIssue[] = []
    for (const a of this.deps.store.listAccounts()) {
      const candRaw = this.deps.appStore.loadSecret(CANDIDATE_SECRET(a.id))
      let candidateDevice: string | null = null
      if (candRaw) {
        try {
          candidateDevice = JSON.parse(candRaw).device ?? null
        } catch {
          /* ignore */
        }
      }
      if (isDeviceBoundAccount(a) && !this.hasCred(a)) {
        out.push({
          accountId: a.id,
          email: a.email,
          kind: 'device-local',
          text: a.provider === 'proton' ? '这台电脑需要填写本机 Bridge 的密码（Bridge 生成的密码每台电脑不同）' : '这台电脑需要填写本机服务的密码（本机服务器的凭据每台电脑不同）',
          hasCandidate: !!candRaw,
          candidateDevice,
          at: Date.now()
        })
        continue
      }
      const s = stored[a.id]
      if (s && s.credSig === this.credSig(a)) out.push({ accountId: a.id, email: a.email, kind: s.kind, text: s.text, at: s.at, hasCandidate: false })
    }
    return out
  }

  private setIssue(a: AccountConfig, issue: { kind: DevSyncAccountIssue['kind']; text: string } | null) {
    const all = this.deps.appStore.getRaw<Record<string, StoredIssue>>(ISSUES_KEY, {}) ?? {}
    if (issue) all[a.id] = { ...issue, at: Date.now(), credSig: this.credSig(a) }
    else delete all[a.id]
    this.deps.appStore.set(ISSUES_KEY, all)
  }

  private pendingDeletes(): DevSyncPendingDelete[] {
    const l = this.deps.appStore.getRaw<DevSyncPendingDelete[]>(PENDING_KEY, []) ?? []
    const ids = new Set(this.deps.store.listAccounts().map(a => a.id))
    return (Array.isArray(l) ? l : []).filter(p => ids.has(p.accountId))
  }

  private addPendingDelete(p: DevSyncPendingDelete) {
    const l = this.pendingDeletes().filter(x => x.key !== p.key)
    l.push(p)
    this.deps.appStore.set(PENDING_KEY, l)
    this.notes.push(`${p.device ? `「${p.device}」` : '另一台设备'}删除了账户 ${p.email}：本机暂时保留，请在「设置 → 同步与备份」确认`)
  }

  status(): DevSyncStatus {
    const s = this.settings()
    const t = this.todoSettings()
    const tr = this.deps.traceSync()?.status()
    const devices = Object.values(readDevices(this.deps.appStore))
      .map(d => ({ ...d, self: d.id === s.deviceId }))
      .sort((a, b) => Number(b.self) - Number(a.self) || (b.lastSyncAt ?? 0) - (a.lastSyncAt ?? 0))
    const todoStatus = this.deps.todoSync.status()
    return {
      enabled: s.enabled,
      accountId: t.accountId ?? null,
      deviceId: s.deviceId,
      deviceName: this.deviceName(),
      hasPassphrase: !!this.deps.appStore.loadSecret(PASS_SECRET),
      running: this.running,
      lastSyncAt: s.lastSyncAt,
      lastError: s.lastError,
      lastStats: s.lastStats,
      folder: VAULT_FOLDER,
      categories: { ...s.categories, todo: !!t.enabled, trace: !!tr?.enabled },
      counts: this.counts(),
      devices,
      pendingDeletes: this.pendingDeletes(),
      accountIssues: this.issues(),
      legacy: {
        todo: { enabled: !!todoStatus.enabled, lastSyncAt: todoStatus.lastSyncAt, lastError: todoStatus.lastError },
        trace: { enabled: !!tr?.enabled, lastSyncAt: tr?.lastSyncAt ?? null, lastError: tr?.lastError ?? null }
      }
    }
  }

  private emit() {
    this.deps.event({ type: 'devsync-status', status: this.status() })
  }

  // ================================================================ 配置

  async configure(input: DevSyncConfigureInput): Promise<{ ok: boolean; error?: string; status: DevSyncStatus }> {
    const fail = (error: string) => ({ ok: false, error, status: this.status() })
    const prev = this.settings()
    const t = this.todoSettings()
    const accountId = input.accountId !== undefined ? input.accountId : t.accountId ?? null
    const pass = input.passphrase ?? ''
    if (pass && pass.length < 6) return fail('同步口令至少 6 位')
    if (input.enabled) {
      if (!accountId || !this.account(accountId)) return fail('请选择用于同步的邮箱')
      if (!pass && !this.deps.appStore.loadSecret(PASS_SECRET)) return fail('请先设置同步口令（所有设备用同一个）')
    }
    const categories = { ...prev.categories, ...(input.categories ?? {}) }
    // 待办 / 留痕沿用各自的通道：类别开关 = 它们的开关；邮箱 / 口令 / 设备名与待办同步共用
    const todoOn = input.enabled && !!categories.todo
    const todoRes = await this.deps.todoSync.configure({
      enabled: !!todoOn,
      accountId,
      passphrase: pass || undefined,
      encrypt: t.encrypt ?? true,
      deviceName: input.deviceName
    })
    if (!todoRes.ok && todoOn) {
      // 待办同步失败（如口令不对）不阻止其余类别，错误在待办状态里展示
    }
    this.save({ enabled: input.enabled, categories, lastError: null })
    const trace = this.deps.traceSync()
    if (trace) {
      const traceOn = !!input.enabled && !!categories.trace
      if (traceOn !== trace.status().enabled) await trace.configure({ enabled: traceOn }).catch(() => {})
    }
    this.emit()
    if (!input.enabled) return { ok: true, status: this.status() }
    await this.run(true)
    const st = this.status()
    return st.lastError ? { ok: false, error: st.lastError, status: st } : { ok: true, status: st }
  }

  /** 首次开启时把待办 / 留痕类别默认打开 */
  async enableAll(input: Omit<DevSyncConfigureInput, 'categories'> & { categories?: Partial<Record<DevSyncCategory, boolean>> }) {
    const cats = { ...defaultDevSyncCategories(), ...this.settings().categories, ...(input.categories ?? {}) }
    return this.configure({ ...input, categories: cats })
  }

  async syncNow(): Promise<DevSyncStatus> {
    await this.run(true)
    // 待办 / 留痕也顺带同步一次
    if (this.todoSettings().enabled) await this.deps.todoSync.syncNow().catch(() => {})
    return this.status()
  }

  /** 设置窗 / 主窗口推来的界面偏好（localStorage）：变了才记，下一轮推送 */
  pushUiPrefs(data: unknown) {
    if (!data || typeof data !== 'object') return
    const cur = this.deps.appStore.getRaw<{ data?: unknown } | null>(UI_PREFS_KEY, null)
    if (cur && this.hash(cur.data) === this.hash(data)) return
    this.deps.appStore.set(UI_PREFS_KEY, { data, at: Date.now() })
    this.schedule()
  }

  uiPrefs(): unknown {
    return this.deps.appStore.getRaw<{ data?: unknown } | null>(UI_PREFS_KEY, null)?.data ?? null
  }

  // ================================================================ 账户：删除确认 / 本机专用凭据

  async resolveDelete(key: string, action: 'delete' | 'keep'): Promise<DevSyncStatus> {
    const p = this.pendingDeletes().find(x => x.key === key)
    this.deps.appStore.set(
      PENDING_KEY,
      this.pendingDeletes().filter(x => x.key !== key)
    )
    if (p && action === 'delete') {
      const a = this.account(p.accountId)
      if (a) {
        this.deps.engine.stopAccount(a.id)
        this.deps.sender.drop(a.id)
        for (const k of [`acct:${a.id}`, `oauth:${a.id}`, CANDIDATE_SECRET(a.id)]) this.deps.appStore.deleteSecret(k)
        this.deps.store.deleteAccount(a.id)
        const st = this.state.get('account', key)
        if (st) this.state.set({ ...st, hash: null, deleted: true, localVer: Math.max(st.localVer, st.remoteVer) })
        this.deps.event({ type: 'accounts-changed' })
        logActivity({ source: 'job', title: '跨设备同步：已删除账户', detail: `${a.email}（${p.device ? `「${p.device}」` : '另一台设备'}上已删除，你确认在本机也删除）` })
      }
    }
    this.emit()
    return this.status()
  }

  /** 试用另一台设备同步来的本机专用凭据（用户确认后） */
  async useCandidate(accountId: string): Promise<{ ok: boolean; error?: string }> {
    const a = this.account(accountId)
    const raw = this.deps.appStore.loadSecret(CANDIDATE_SECRET(accountId))
    if (!a || !raw) return { ok: false, error: '没有可用的候选凭据' }
    let cand: { kind?: string; secret?: string; tokens?: any } = {}
    try {
      cand = JSON.parse(raw)
    } catch {
      return { ok: false, error: '候选凭据已损坏' }
    }
    if (a.authType === 'oauth') {
      if (!cand.tokens) return { ok: false, error: '候选凭据不是授权令牌' }
      this.deps.oauth.saveTokens(a.id, cand.tokens)
    } else {
      if (!cand.secret) return { ok: false, error: '候选凭据为空' }
      const r = await testImap(a, { pass: cand.secret })
      if (!r.ok) return { ok: false, error: `另一台设备的密码在这台电脑上不能用：${r.error}。请打开本机的 Bridge 复制它显示的密码，在账户页填写。` }
      this.deps.appStore.saveSecret(`acct:${a.id}`, cand.secret)
    }
    this.deps.sender.drop(a.id)
    if (a.enabled) this.deps.engine.startAccount(a)
    this.setIssue(a, null)
    this.deps.event({ type: 'accounts-changed' })
    this.emit()
    return { ok: true }
  }

  // ================================================================ 调度

  start() {
    instance = this
    this.settings()
    setTimeout(() => void this.run(), 30_000)
    this.pollTimer = setInterval(() => void this.run(), POLL_MS)
    // 本地改动探测：快照哈希与上次同步不同就提前跑一轮（不侵入各模块写路径）
    this.dirtyTimer = setInterval(() => {
      if (this.settings().enabled && !this.running && this.isDirty()) this.schedule()
    }, DIRTY_MS)
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.dirtyTimer) clearInterval(this.dirtyTimer)
    if (this.debounce) clearTimeout(this.debounce)
    if (instance === this) instance = null
  }

  schedule() {
    if (!this.settings().enabled) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.run()
    }, DEBOUNCE_MS)
  }

  private isDirty(): boolean {
    try {
      const rows = new Map(this.state.all().map(s => [`${s.type}\n${s.id}`, s]))
      for (const a of this.enabledAdapters()) {
        if (a.type === 'device') continue
        const seen = new Set<string>()
        for (const item of a.list()) {
          seen.add(item.id)
          const st = rows.get(`${a.type}\n${item.id}`)
          if (!st || st.deleted || st.hash !== this.hash(item.sig ?? item.data)) return true
        }
        if (!a.noLocalTombstones) for (const st of rows.values()) if (st.type === a.type && !st.deleted && !seen.has(st.id)) return true
      }
    } catch {
      /* 下一轮兜底 */
    }
    return false
  }

  private ring(): KeyRing {
    const pass = this.deps.appStore.loadSecret(PASS_SECRET)
    if (!pass) throw new TodoSyncError('need-passphrase', '尚未设置同步口令')
    if (!this.keyring || this.keyring.pass !== pass) this.keyring = { pass, ring: new KeyRing(pass) }
    return this.keyring.ring
  }

  private async run(manual = false): Promise<void> {
    const s = this.settings()
    if (!s.enabled) return
    if (this.running) {
      this.rerun = true
      return
    }
    this.running = true
    this.emit()
    try {
      const more = await this.round(s)
      this.save({ lastSyncAt: Date.now(), lastError: null })
      if (more) this.rerun = true
    } catch (err) {
      this.save({ lastError: describe(err) })
      if (!manual) console.error('[devsync]', err instanceof TodoSyncError ? err.code : describe(err))
    } finally {
      this.running = false
      this.emit()
      if (this.rerun) {
        this.rerun = false
        this.schedule()
      }
    }
  }

  private async round(s: Settings): Promise<boolean> {
    const t = this.todoSettings()
    if (!t.accountId) throw new Error('请先选择同步邮箱')
    const worker = this.deps.engine.getWorker(t.accountId)
    if (!worker) throw new Error('同步邮箱未启用或尚未连接')
    const ring = this.ring()
    // 口令或同步邮箱变了：旧的同步状态作废，按首次接触重新对账
    const pass = this.deps.appStore.loadSecret(PASS_SECRET)
    const scope = createHmac('sha256', this.hashKey()).update(`scope\n${pass}\n${t.accountId}`).digest('hex').slice(0, 16)
    if (s.scope !== scope) {
      this.state.clear()
      this.save({ scope })
    }
    // 本机设备记录（最近同步时间每 30 分钟更新一次，避免每轮都推送）
    const devs = readDevices(this.deps.appStore)
    const me = devs[s.deviceId]
    const now = Date.now()
    if (!me || me.name !== this.deviceName() || !me.lastSyncAt || now - me.lastSyncAt > 30 * 60_000)
      writeDevice(this.deps.appStore, { id: s.deviceId, name: this.deviceName(), platform: process.platform, appVersion: app.getVersion(), lastSyncAt: now })

    const accounts = this.deps.store.listAccounts()
    const keyOfId = new Map(accounts.map(a => [a.id, accountKeyOf(a)]))
    const idOfKey = new Map(accounts.map(a => [accountKeyOf(a), a.id]))
    const lookup = {
      accountKey: (id: string) => keyOfId.get(id) ?? null,
      messageHeader: (id: string) => (this.deps.store.getMessageRow(id) as any)?.message_id ?? null
    }
    const resolveMessage = (header: string) =>
      ((this.deps.db.prepare('SELECT id FROM messages WHERE message_id = ? LIMIT 1').get(header) as any)?.id as string | undefined) ?? null
    this.actions = []
    this.notes = []
    const stats = newVaultStats()
    try {
      await vaultRound({
        transport: {
          ensureFolder: name => worker.ensureHiddenFolder(name),
          fetchHeaders: (folder, names) => worker.fetchFolderHeaders(folder, names),
          download: (folder, uid) => worker.downloadFromFolder(folder, uid),
          append: (folder, raw) => worker.appendToFolder(folder, raw, ['\\Seen']),
          remove: (folder, uids) => worker.deleteFromFolder(folder, uids)
        },
        adapters: this.enabledAdapters(),
        state: this.state,
        keyring: ring,
        hash: this.hash,
        refsOf: data => collectRefs(data, lookup),
        remap: (data, refs: VaultRefs | undefined) =>
          remapRefs(data, refs, {
            // 新账户在同一轮里创建：每次现查
            account: key => idOfKey.get(key) ?? this.deps.store.listAccounts().find(a => accountKeyOf(a) === key)?.id ?? null,
            message: resolveMessage
          }).data,
        device: this.deviceName(),
        deviceId: s.deviceId,
        limit: ROUND_LIMIT,
        stats
      })
    } finally {
      await worker.returnToInbox().catch(() => {})
      this.save({
        lastStats: { pulled: stats.pulled, pushed: stats.pushed, removed: stats.removed, conflicts: stats.conflicts, oversize: stats.oversize, at: Date.now() }
      })
      if (stats.changedLocal) this.broadcastChanges(stats.applied.map(a => a.type))
    }
    const accountNotes = await this.processAccountActions()
    this.logRound(stats, accountNotes)
    return stats.more
  }

  broadcastChanges(types: string[]) {
    try {
      this.deps.afterApply?.(types)
    } catch {
      /* 缓存失效失败不影响同步 */
    }
    const set = new Set(types)
    const ev = (type: string) => this.deps.event({ type })
    if (set.has('account') || set.has('cred')) ev('accounts-changed')
    if (set.has('ins.finance')) ev('finance-changed')
    if (set.has('ins.project')) ev('projects-changed')
    if (set.has('ins.life')) ev('life-changed')
    if (set.has('ins.followup')) ev('followups-changed')
    if (set.has('ins.reading')) ev('insights-changed')
    if (set.has('kb')) ev('kb-changed')
    if (set.has('memory')) ev('agent-changed')
  }

  /** 一轮结束后：新账户 / 凭据变化做连接测试，配置变化重启同步（不在一轮中途重启同步邮箱的连接） */
  private async processAccountActions(): Promise<string[]> {
    const out: string[] = [...this.notes]
    // 同一账户多个动作取最强的：新建 > 凭据变化 > 仅重启
    const rank = { created: 3, cred: 2, restart: 1 } as const
    const byAccount = new Map<string, AccountAction>()
    for (const act of this.actions) {
      const cur = byAccount.get(act.accountId)
      if (!cur || rank[act.kind] > rank[cur.kind]) byAccount.set(act.accountId, act)
    }
    for (const act of byAccount.values()) {
      const a = this.account(act.accountId)
      if (!a) continue
      this.deps.sender.drop(a.id)
      if (isDeviceBoundAccount(a) && !this.hasCred(a)) {
        this.deps.setStatus(a.id, 'error', a.provider === 'proton' ? '待填写本机 Bridge 密码' : '待填写本机密码')
        out.push(`${a.email}：${act.kind === 'created' ? '已同步配置，' : ''}这台电脑需要填写本机 Bridge 的密码（已收到「${act.device ?? '另一台设备'}」的密码，默认不启用）`)
        continue
      }
      if (!this.hasCred(a)) {
        this.deps.setStatus(a.id, 'error', a.authType === 'oauth' ? '待重新授权' : '待补密码')
        if (act.kind === 'created') out.push(`${a.email}：已同步配置，但没有可用凭据，请在账户页${a.authType === 'oauth' ? '重新授权' : '输入密码'}`)
        continue
      }
      if (!a.enabled) {
        this.deps.engine.stopAccount(a.id)
        this.deps.setStatus(a.id, 'disabled', '已停用')
        continue
      }
      if (act.kind === 'restart') {
        this.deps.engine.startAccount(a)
        continue
      }
      const r = await this.testAccount(a)
      if (r.ok) {
        this.setIssue(a, null)
        this.deps.engine.startAccount(a)
        if (act.kind === 'created') out.push(`${a.email}：已自动连上`)
        else if (act.kind === 'cred') out.push(`${a.email}：${act.how === 'oauth' ? '授权令牌' : '密码'}已在「${act.device ?? '另一台设备'}」更新，已同步并连上`)
      } else {
        this.setIssue(a, { kind: r.kind, text: r.text })
        this.deps.setStatus(a.id, 'error', r.text)
        out.push(`${a.email}：${r.text}`)
      }
    }
    if (this.actions.length) this.deps.event({ type: 'accounts-changed' })
    this.actions = []
    this.notes = []
    return out
  }

  private async testAccount(a: AccountConfig): Promise<{ ok: true } | { ok: false; kind: DevSyncAccountIssue['kind']; text: string }> {
    if (a.authType === 'oauth') {
      let token = ''
      try {
        token = await this.deps.oauth.validToken(a.id, a.provider, false)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          kind: 'oauth',
          text: /客户端未配置/.test(msg)
            ? '需要重新授权：这台电脑还没配置 OAuth 应用（设置 → 账户 → OAuth 应用），或直接点「重新授权」'
            : '需要重新授权：令牌可能已在另一台设备刷新或被撤销。重新授权后新令牌会自动同步回其他设备'
        }
      }
      const r = await testImap(a, { accessToken: token })
      if (r.ok) return { ok: true }
      return { ok: false, kind: r.auth ? 'oauth' : 'network', text: r.auth ? '需要重新授权：同步来的令牌已失效' : `暂时连不上：${r.error}` }
    }
    const r = await testImap(a, { pass: this.deps.appStore.loadSecret(`acct:${a.id}`) })
    if (r.ok) return { ok: true }
    return r.auth
      ? { ok: false, kind: 'auth', text: '登录失败：密码可能已在另一台设备修改，或同步 / 恢复来的密码已失效——请在账户页重新输入' }
      : { ok: false, kind: 'network', text: `暂时连不上：${r.error}` }
  }

  private logRound(stats: ReturnType<typeof newVaultStats>, accountNotes: string[]) {
    const meaningful = stats.applied.filter(a => a.type !== 'device')
    if (!meaningful.length && !stats.conflicts && !accountNotes.length && !stats.oversize) return
    const labelOf = (type: string) => {
      const ad = this.adapters.find(x => x.type === type)
      return DEVSYNC_CATEGORIES.find(c => c.id === ad?.category)?.label ?? type
    }
    const per = new Map<string, number>()
    for (const a of meaningful) per.set(labelOf(a.type), (per.get(labelOf(a.type)) ?? 0) + 1)
    const from = [...new Set(meaningful.map(a => a.device).filter(Boolean))]
    const lines: string[] = []
    if (meaningful.length) lines.push(`收到 ${meaningful.length} 条${from.length ? `（来自 ${from.map(d => `「${d}」`).join('、')}）` : ''}：${[...per].map(([k, n]) => `${k} ${n}`).join('、')}`)
    if (stats.pushed) lines.push(`发出 ${stats.pushed} 条本机改动`)
    if (stats.conflicts)
      lines.push(
        `${stats.conflicts} 条两台设备都改过，按最后修改为准：${stats.conflictItems
          .slice(0, 5)
          .map(c => `${labelOf(c.type)}（${c.winner === 'remote' ? '采用另一台设备的' : '保留本机的'}）`)
          .join('、')}`
      )
    if (stats.oversize) lines.push(`${stats.oversize} 条超过 512 KB 未同步（如很长的知识库条目 / 对话）`)
    lines.push(...accountNotes)
    logActivity({ source: 'job', title: '跨设备同步', detail: lines.join('\n'), stats: { synced: meaningful.length } } as any)
  }

  // ================================================================ 备份用：导出 / 落地记录

  /** 导出某些类别的全部记录（备份用；不受同步开关影响） */
  exportRecords(categories: Set<DevSyncCategory>, includeSecrets: boolean) {
    const accounts = this.deps.store.listAccounts()
    const keyOfId = new Map(accounts.map(a => [a.id, accountKeyOf(a)]))
    const lookup = {
      accountKey: (id: string) => keyOfId.get(id) ?? null,
      messageHeader: (id: string) => (this.deps.store.getMessageRow(id) as any)?.message_id ?? null
    }
    this.flagOverride = { shareSecrets: includeSecrets && categories.has('shareSecrets'), aiKey: includeSecrets && categories.has('aiKey') }
    try {
      const out: { type: string; id: string; category: DevSyncCategory; updatedAt: number; data: unknown; refs?: VaultRefs }[] = []
      const now = Date.now()
      for (const a of this.adapters) {
        if (a.category === 'device' || a.category === 'accounts' || !categories.has(a.category as DevSyncCategory)) continue
        for (const item of a.list()) out.push({ type: a.type, id: item.id, category: a.category as DevSyncCategory, updatedAt: item.mtime || now, data: item.data, refs: collectRefs(item.data, lookup) })
      }
      return out
    } finally {
      this.flagOverride = null
    }
  }

  /** 恢复时落地一条记录；返回 add / update / skip */
  async restoreRecord(
    rec: { type: string; id: string; updatedAt: number; data: unknown; refs?: VaultRefs },
    decide: (local: { mtime?: number } | null) => 'add' | 'update' | 'skip',
    allowSecrets: { shareSecrets: boolean; aiKey: boolean }
  ): Promise<'add' | 'update' | 'skip'> {
    const a = this.adapters.find(x => x.type === rec.type)
    if (!a || a.category === 'device') return 'skip'
    const local = a.list().find(i => i.id === rec.id) ?? null
    const d = decide(local)
    if (d === 'skip') return d
    const data = remapRefs(rec.data, rec.refs, {
      account: key => this.deps.store.listAccounts().find(x => accountKeyOf(x) === key)?.id ?? null,
      message: header => ((this.deps.db.prepare('SELECT id FROM messages WHERE message_id = ? LIMIT 1').get(header) as any)?.id as string | undefined) ?? null
    }).data
    this.flagOverride = allowSecrets
    try {
      const ctx: ApplyContext = { updatedAt: rec.updatedAt, device: null, deviceId: null, first: !local }
      await a.apply(rec.id, data, ctx)
    } finally {
      this.flagOverride = null
    }
    return d
  }

  /** 恢复账户（备份文件里的 v1 形状）：merge = 已有的跳过（缺凭据时补上）；overwrite = 以备份为准更新配置与凭据 */
  async restoreAccounts(
    entries: { config: any; secret?: string; oauth?: any; extra?: { folderPrefs?: Record<string, unknown> } }[],
    strategy: 'merge' | 'overwrite'
  ): Promise<{ added: string[]; updated: string[]; skipped: string[]; failed: string[]; pending: string[] }> {
    const res = { added: [] as string[], updated: [] as string[], skipped: [] as string[], failed: [] as string[], pending: [] as string[] }
    this.actions = []
    this.notes = []
    const accAdapter = this.adapters.find(a => a.type === 'account')!
    const credAdapter = this.adapters.find(a => a.type === 'cred')!
    for (const e of entries) {
      const c = e.config
      if (!c?.email || !c.imap?.host) continue
      const key = accountKeyOf(c)
      const local = this.deps.store.listAccounts().find(a => accountKeyOf(a) === key)
      try {
        const ctx: ApplyContext = { updatedAt: Date.now(), device: '备份文件', deviceId: null, first: !local }
        if (local && strategy === 'merge') {
          if (!this.hasCred(local) && (e.secret || e.oauth)) {
            await credAdapter.apply(key, e.oauth ? { kind: 'oauth', tokens: e.oauth, deviceBound: isDeviceBoundAccount(c) } : { kind: 'password', secret: e.secret, deviceBound: isDeviceBoundAccount(c) }, ctx)
            res.updated.push(`${c.email}（补上凭据）`)
          } else res.skipped.push(`${c.email}（已存在）`)
          continue
        }
        await accAdapter.apply(key, { ...c, deviceBound: isDeviceBoundAccount(c), folderPrefs: e.extra?.folderPrefs }, ctx)
        if (e.secret || e.oauth)
          await credAdapter.apply(key, e.oauth ? { kind: 'oauth', tokens: e.oauth, deviceBound: isDeviceBoundAccount(c) } : { kind: 'password', secret: e.secret, deviceBound: isDeviceBoundAccount(c) }, ctx)
        const now = this.deps.store.listAccounts().find(a => accountKeyOf(a) === key)
        if (now && !this.hasCred(now)) res.pending.push(`${c.email}（${isDeviceBoundAccount(now) ? '这台电脑需要填写本机 Bridge 的密码' : now.authType === 'oauth' ? '请在账户页重新授权' : '请在账户页输入密码'}）`)
        if (local) res.updated.push(c.email)
        else {
          res.added.push(c.email)
          if (!this.actions.some(x => x.accountId === now?.id) && now) this.actions.push({ kind: 'created', accountId: now.id, device: '备份文件' })
        }
      } catch (err) {
        res.failed.push(`${c.email}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const notes = await this.processAccountActions()
    for (const n of notes) if (/登录失败|重新授权|连不上/.test(n)) res.pending.push(n)
    this.deps.event({ type: 'accounts-changed' })
    return res
  }

  oauthClientsForBackup(): unknown {
    return this.deps.appStore.getRaw('oauthClients', null)
  }

  restoreOAuthClients(c: unknown, strategy: 'merge' | 'overwrite') {
    if (!c || typeof c !== 'object') return
    const cur = this.deps.appStore.getRaw<any>('oauthClients', null)
    if (strategy === 'overwrite' || !cur || (!cur.google?.clientId && !cur.ms?.clientId)) this.deps.appStore.set('oauthClients', c)
  }
}

/** 短连接测试 IMAP 登录（不打印凭据） */
async function testImap(a: AccountConfig, auth: { pass?: string; accessToken?: string }): Promise<{ ok: true } | { ok: false; auth: boolean; error: string }> {
  const { ImapFlow } = await import('imapflow')
  const client = new ImapFlow({
    host: a.imap.host,
    port: a.imap.port,
    secure: a.imap.secure,
    auth: auth.accessToken ? { user: a.user || a.email, accessToken: auth.accessToken } : { user: a.user || a.email, pass: auth.pass ?? '' },
    logger: false,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    clientInfo: { name: 'LinkTo', vendor: 'LinkTo', version: app.getVersion() }
  })
  client.on('error', () => {})
  try {
    await client.connect()
    await client.mailboxOpen('INBOX', { readOnly: true })
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const authFail = /auth|login|credentials|invalid|password/i.test(msg) || (err as { authenticationFailed?: boolean })?.authenticationFailed === true
    return { ok: false, auth: authFail, error: authFail ? '登录失败' : friendlyError(err) }
  } finally {
    try {
      client.close()
    } catch {
      /* ignore */
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof TodoSyncError) {
    if (err.code === 'passphrase') return '同步口令不正确：同步文件夹里的数据是用另一个口令加密的。请在这台设备上输入与其他设备相同的口令。'
    if (err.code === 'need-passphrase') return '请先设置同步口令（所有设备用同一个）'
    return `同步数据格式错误：${err.message}`
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/not connected/i.test(msg)) return '同步邮箱尚未连接，稍后自动重试'
  if (/同步邮箱|口令/.test(msg)) return msg
  return friendlyError(err)
}

/** IPC：devsync*（只增不改） */
export function registerDevSyncIpc(svc: DevSyncService) {
  const handlers: Record<string, (...args: any[]) => unknown> = {
    devsyncStatus: () => svc.status(),
    devsyncConfigure: (input: DevSyncConfigureInput) => svc.configure(input ?? { enabled: false }),
    devsyncNow: () => svc.syncNow(),
    devsyncResolveDelete: (key: string, action: 'delete' | 'keep') => svc.resolveDelete(String(key), action === 'delete' ? 'delete' : 'keep'),
    devsyncUseCandidate: (accountId: string) => svc.useCandidate(String(accountId)),
    devsyncPushUiPrefs: (data: unknown) => svc.pushUiPrefs(data),
    devsyncUiPrefs: () => svc.uiPrefs()
  }
  for (const [method, handler] of Object.entries(handlers)) {
    ipcMain.handle(`api:${method}`, async (_e, ...args) => {
      try {
        return await handler(...args)
      } catch (err) {
        console.error(`[ipc:${method}]`, err instanceof Error ? err.message : String(err))
        throw err
      }
    })
  }
}
