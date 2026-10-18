/**
 * 待办与日历同步：Apple 提醒事项 / 日历（JXA）、Google Tasks / Calendar、Microsoft To Do / Outlook 日历。
 * 每个服务选一个目标清单 / 日历 + 方向；按需、每 10 分钟、以及本地改动后 5 秒防抖同步。
 * 设置存 appStore 'todoIntegrations'；本地删除的映射存 'todoIntegrationTombstones'。
 */
import type {
  AccountConfig,
  CalendarBusyBlock,
  TodoData,
  TodoIntegrationConfig,
  TodoIntegrationStatus,
  TodoProvider,
  TodoSyncDirection
} from '@shared/types'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import { GOOGLE_CALENDAR_SCOPES, GOOGLE_TASKS_SCOPE, MS_CALENDAR_SCOPE, MS_TASKS_SCOPE, type OAuthService } from '../oauth'
import type { Adapter, SyncTarget } from './types'
import { AppleCalendarAdapter, RemindersAdapter } from './apple'
import { GoogleCalendarAdapter, GoogleTasksAdapter } from './google'
import { MsCalendarAdapter, MsTodoAdapter } from './microsoft'
import { runCalendarSync, runTaskSync, type LocalTodoStore } from './engine'
import type { LocalTodo, Tombstone } from './merge'
import { notifyLocalChange as notifyTodoSync } from '../todo-sync'

const SETTINGS_KEY = 'todoIntegrations'
const TOMB_KEY = 'todoIntegrationTombstones'
const INTERVAL_MS = 10 * 60_000
const DEBOUNCE_MS = 5_000
/** 增量同步间隔超过这个就做一次完整快照（兜底漏掉的删除） */
const FULL_SYNC_MS = 6 * 3600_000

interface ProviderMeta {
  provider: TodoProvider
  label: string
  kind: 'tasks' | 'calendar'
  oauth: 'google' | 'ms' | null
  /** 必需的 scope（判断已授权用） */
  scope?: string
  /** 授权时申请的 scope（可含可选项） */
  requestScope?: string
}

const PROVIDERS: ProviderMeta[] = [
  { provider: 'apple-reminders', label: '提醒事项', kind: 'tasks', oauth: null },
  { provider: 'apple-calendar', label: '日历', kind: 'calendar', oauth: null },
  { provider: 'google-tasks', label: 'Google Tasks', kind: 'tasks', oauth: 'google', scope: GOOGLE_TASKS_SCOPE },
  {
    provider: 'google-calendar',
    label: 'Google 日历',
    kind: 'calendar',
    oauth: 'google',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    requestScope: GOOGLE_CALENDAR_SCOPES
  },
  { provider: 'ms-todo', label: 'Microsoft To Do', kind: 'tasks', oauth: 'ms', scope: MS_TASKS_SCOPE },
  { provider: 'ms-calendar', label: 'Outlook 日历', kind: 'calendar', oauth: 'ms', scope: MS_CALENDAR_SCOPE }
]

const metaOf = (p: TodoProvider) => PROVIDERS.find(m => m.provider === p)!

const DEFAULT_CONFIG: TodoIntegrationConfig = { enabled: false, direction: 'two-way' }

export interface IntegrationDeps {
  store: MailStore
  appStore: AppStore
  oauth: OAuthService
  emit(payload: unknown): void
  /** 微软设备码：推给 UI 展示 */
  onDevice(info: { userCode: string; verificationUri: string }): void
}

export class TodoIntegrations {
  private timer: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  /** 串行队列；排队中的全量同步合并为一次 */
  private chain: Promise<void> = Promise.resolve()
  private pendingFull: Promise<void> | null = null
  private syncing = new Set<TodoProvider>()
  private lastFull = new Map<TodoProvider, number>()
  private busyCache: { key: string; at: number; blocks: CalendarBusyBlock[] } | null = null

  constructor(private deps: IntegrationDeps) {}

  // ---------- 设置 ----------

  private all(): Partial<Record<TodoProvider, TodoIntegrationConfig>> {
    return this.deps.appStore.getRaw<Partial<Record<TodoProvider, TodoIntegrationConfig>>>(SETTINGS_KEY, {})
  }

  config(p: TodoProvider): TodoIntegrationConfig {
    const c = { ...DEFAULT_CONFIG, ...(this.all()[p] ?? {}) }
    // 日历只支持导出
    if (metaOf(p).kind === 'calendar') c.direction = 'export'
    return c
  }

  private save(p: TodoProvider, patch: Partial<TodoIntegrationConfig>) {
    const all = this.all()
    all[p] = { ...this.config(p), ...patch }
    this.deps.appStore.set(SETTINGS_KEY, all)
    this.deps.emit({ type: 'todo-integrations-changed' })
  }

  private tombstones(): Tombstone[] {
    return this.deps.appStore.getRaw<Tombstone[]>(TOMB_KEY, [])
  }

  private dropTombstones(done: Tombstone[]) {
    if (!done.length) return
    const keys = new Set(done.map(t => `${t.provider}\u0000${t.id}`))
    this.deps.appStore.set(TOMB_KEY, this.tombstones().filter(t => !keys.has(`${t.provider}\u0000${t.id}`)))
  }

  // ---------- 账户 / 授权 ----------

  private accountsFor(meta: ProviderMeta): AccountConfig[] {
    if (!meta.oauth) return []
    const ok = meta.oauth === 'google' ? ['gmail'] : ['outlook', 'hotmail', 'office365']
    return this.deps.store.listAccounts().filter(a => ok.includes(a.provider))
  }

  private authorized(meta: ProviderMeta, accountId: string): boolean {
    if (!meta.oauth) return true
    const t = this.deps.oauth.loadScopedTokens(accountId, meta.oauth)
    if (!t?.accessToken) return false
    const granted = new Set((t.scope ?? '').split(/\s+/))
    return (meta.scope ?? '').split(/\s+/).filter(Boolean).every(s => granted.has(s) || granted.has(s.replace('https://graph.microsoft.com/', '')))
  }

  private adapter(p: TodoProvider, accountId?: string | null): Adapter {
    const meta = metaOf(p)
    if (meta.oauth && !accountId) throw new Error('请先选择邮箱账户')
    const token = (force?: boolean) => this.deps.oauth.validScopedToken(accountId as string, meta.oauth as 'google' | 'ms', !!force)
    switch (p) {
      case 'apple-reminders':
        return new RemindersAdapter()
      case 'apple-calendar':
        return new AppleCalendarAdapter()
      case 'google-tasks':
        return new GoogleTasksAdapter(token)
      case 'google-calendar':
        return new GoogleCalendarAdapter(token)
      case 'ms-todo':
        return new MsTodoAdapter(token)
      case 'ms-calendar':
        return new MsCalendarAdapter(token)
    }
  }

  status(): TodoIntegrationStatus[] {
    const oauthCfg = this.deps.oauth.clients()
    return PROVIDERS.map(meta => {
      const config = this.config(meta.provider)
      let available = true
      let unavailableReason: string | undefined
      if (!meta.oauth && process.platform !== 'darwin') {
        available = false
        unavailableReason = '仅 macOS 可用'
      } else if (meta.oauth === 'google' && !(oauthCfg.google?.clientId && oauthCfg.google?.clientSecret)) {
        available = false
        unavailableReason = '未配置 Google OAuth 客户端（设置 → 账户 → OAuth 应用凭据）'
      } else if (meta.oauth === 'ms' && !oauthCfg.ms?.clientId) {
        available = false
        unavailableReason = '未配置 Microsoft OAuth 客户端（设置 → 账户 → OAuth 应用凭据）'
      }
      const accounts = this.accountsFor(meta).map(a => ({ id: a.id, email: a.email, authorized: this.authorized(meta, a.id) }))
      if (available && meta.oauth && !accounts.length) {
        available = false
        unavailableReason = meta.oauth === 'google' ? '需要先用 OAuth 添加一个 Gmail 账户' : '需要先用 OAuth 添加一个 Outlook / Microsoft 365 账户'
      }
      const connected = meta.oauth ? !!config.accountId && this.authorized(meta, config.accountId) : config.enabled
      return {
        provider: meta.provider,
        label: meta.label,
        kind: meta.kind,
        available,
        unavailableReason,
        needsAccount: !!meta.oauth,
        accounts,
        connected,
        syncing: this.syncing.has(meta.provider),
        config
      }
    })
  }

  async listTargets(p: TodoProvider, accountId?: string | null): Promise<{ ok: boolean; error?: string; targets: SyncTarget[] }> {
    try {
      const a = this.adapter(p, accountId ?? this.config(p).accountId)
      return { ok: true, targets: await a.listTargets() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), targets: [] }
    }
  }

  /** 连接：OAuth 服务对所选账户做增量授权；Apple 读一次清单以触发系统授权框 */
  async connect(
    p: TodoProvider,
    opts: { accountId?: string | null; listId?: string | null; listName?: string | null; direction?: TodoSyncDirection } = {}
  ): Promise<{ ok: boolean; error?: string }> {
    const meta = metaOf(p)
    try {
      if (meta.oauth) {
        const accountId = opts.accountId ?? this.config(p).accountId
        const account = this.deps.store.listAccounts().find(a => a.id === accountId)
        if (!account) return { ok: false, error: '请先选择邮箱账户' }
        if (!this.authorized(meta, account.id)) {
          const prev = this.deps.oauth.loadScopedTokens(account.id, meta.oauth)
          if (meta.oauth === 'google') {
            const res = await this.deps.oauth.authorizeGoogle({ scope: meta.requestScope ?? meta.scope, loginHint: account.email })
            if (!res.ok || !res.tokens) return { ok: false, error: res.error ?? '授权失败' }
            if (res.email && res.email.toLowerCase() !== account.email.toLowerCase()) {
              return { ok: false, error: `授权的账户（${res.email}）与所选邮箱（${account.email}）不一致` }
            }
            // include_granted_scopes：返回的 token 已含此前授予的全部 scope；以 Google 实际返回的为准（用户可能取消勾选）
            const granted = res.scope ? `${res.scope} ${prev?.scope ?? ''}` : `${prev?.scope ?? ''} ${meta.requestScope ?? meta.scope ?? ''}`
            const scope = [...new Set(granted.split(/\s+/).filter(Boolean))].join(' ')
            this.deps.oauth.saveScopedTokens(account.id, 'google', { ...res.tokens, scope })
            if (!this.authorized(meta, account.id)) return { ok: false, error: `授权时未勾选「${meta.label}」所需的权限，请重新连接并全部勾选` }
          } else {
            // 微软：一次申请该账户已有 + 新增的 Graph scope，刷新时按同一组 scope 换 token
            const graphScopes = [...new Set([...(prev?.scope ?? '').split(/\s+/), ...(meta.scope ?? '').split(/\s+/)])]
              .filter(s => s.startsWith('https://graph.microsoft.com/'))
              .join(' ')
            const res = await this.deps.oauth.authorizeMicrosoft(this.deps.onDevice, graphScopes)
            if (!res.ok || !res.tokens) return { ok: false, error: res.error ?? '授权失败' }
            this.deps.oauth.saveScopedTokens(account.id, 'ms', { ...res.tokens, scope: `openid profile email offline_access ${graphScopes}` })
          }
        }
        this.save(p, { accountId: account.id })
      } else {
        // 触发 macOS 自动化授权；被拒绝时 runJxa 抛出带设置路径的中文提示
        await this.adapter(p).listTargets()
      }
      const patch: Partial<TodoIntegrationConfig> = { enabled: true, lastError: null }
      if (opts.listId !== undefined) {
        patch.listId = opts.listId
        patch.listName = opts.listName ?? null
      }
      if (opts.direction) patch.direction = opts.direction
      this.save(p, patch)
      if (this.config(p).listId) void this.syncNow(p)
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.save(p, { lastError: msg })
      return { ok: false, error: msg }
    }
  }

  update(p: TodoProvider, patch: Partial<TodoIntegrationConfig>): TodoIntegrationStatus[] {
    const prev = this.config(p)
    const next: Partial<TodoIntegrationConfig> = {}
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled
    if (patch.direction && ['two-way', 'export', 'import'].includes(patch.direction)) next.direction = patch.direction
    if (patch.busy !== undefined) next.busy = !!patch.busy
    if (patch.accountId !== undefined) next.accountId = patch.accountId
    if (patch.listId !== undefined) {
      next.listId = patch.listId
      next.listName = patch.listName ?? null
      // 换了目标清单：从完整快照重新开始
      if (patch.listId !== prev.listId) {
        next.lastSyncAt = null
        this.lastFull.delete(p)
      }
    }
    this.save(p, next)
    this.busyCache = null
    const cfg = this.config(p)
    if (cfg.enabled && cfg.listId && (next.listId !== undefined || next.direction || next.enabled)) void this.syncNow(p)
    return this.status()
  }

  disconnect(p: TodoProvider): TodoIntegrationStatus[] {
    const meta = metaOf(p)
    const cfg = this.config(p)
    // 同一账户的另一个同源服务仍在用时保留 token
    if (meta.oauth && cfg.accountId) {
      const sibling = PROVIDERS.find(m => m.oauth === meta.oauth && m.provider !== p)
      const siblingCfg = sibling ? this.config(sibling.provider) : null
      if (!(siblingCfg?.enabled && siblingCfg.accountId === cfg.accountId)) this.deps.oauth.deleteScopedTokens(cfg.accountId, meta.oauth)
    }
    this.save(p, { enabled: false, lastError: null })
    this.busyCache = null
    return this.status()
  }

  /** 账户被删除：清掉它的额外授权并停用相关服务 */
  forgetAccount(accountId: string) {
    this.deps.oauth.deleteScopedTokens(accountId)
    for (const m of PROVIDERS) if (this.config(m.provider).accountId === accountId) this.save(m.provider, { enabled: false, accountId: null })
  }

  // ---------- 本地删除钩子 ----------

  /** 删除待办前调用：记下外部映射，下轮同步删掉远端 */
  noteLocalDelete(id: string) {
    const row = this.deps.store.getInsight(id)
    if (!row || row.kind !== 'todo') return
    const ext = (row.data as TodoData).external ?? {}
    const add: Tombstone[] = []
    for (const [provider, ref] of Object.entries(ext)) {
      if (ref?.id) add.push({ provider: provider as TodoProvider, id: ref.id, listId: ref.listId, at: Date.now() })
    }
    if (!add.length) return
    const keep = this.tombstones().filter(t => Date.now() - t.at < 30 * 86_400_000)
    this.deps.appStore.set(TOMB_KEY, [...keep, ...add].slice(-500))
  }

  // ---------- 调度 ----------

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.syncAll(), INTERVAL_MS)
    this.timer.unref?.()
    setTimeout(() => void this.syncAll(), 30_000).unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
    this.timer = null
    this.debounce = null
  }

  /** 本地待办改动后调用：5 秒防抖；没有可导出的服务时不做事 */
  notifyLocalChange() {
    const any = PROVIDERS.some(m => {
      const c = this.config(m.provider)
      return c.enabled && c.listId && c.direction !== 'import'
    })
    if (!any) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.syncAll()
    }, DEBOUNCE_MS)
  }

  async syncNow(p?: TodoProvider | null): Promise<{ ok: boolean; error?: string }> {
    await this.syncAll(p ?? undefined)
    const errs = (p ? [p] : PROVIDERS.map(m => m.provider))
      .map(x => this.config(x))
      .filter(c => c.enabled && c.lastError)
      .map(c => c.lastError as string)
    return errs.length ? { ok: false, error: errs[0] } : { ok: true }
  }

  /** 串行执行：进行中再被触发则排到后面；排队中的全量同步合并为一次 */
  private syncAll(only?: TodoProvider): Promise<void> {
    if (!only && this.pendingFull) return this.pendingFull
    const run = this.chain.then(async () => {
      if (!only) this.pendingFull = null
      for (const m of PROVIDERS) {
        if (only && m.provider !== only) continue
        const cfg = this.config(m.provider)
        if (!cfg.enabled || !cfg.listId) continue
        await this.syncOne(m, cfg)
      }
    })
    if (!only) this.pendingFull = run
    this.chain = run.catch(() => {})
    return run
  }

  private localStore(): LocalTodoStore {
    const { store } = this.deps
    const toLocal = (r: { id: string; title: string; status: string; dueAt: number | null; createdAt?: number; data: Record<string, unknown> }): LocalTodo => ({
      id: r.id,
      title: r.title,
      status: r.status,
      dueAt: r.dueAt,
      createdAt: r.createdAt,
      data: r.data as TodoData
    })
    return {
      list: () => store.listInsights('todo').map(toLocal),
      get: id => {
        const r = store.getInsight(id)
        return r && r.kind === 'todo' ? toLocal(r) : null
      },
      update: (id, patch) => store.updateInsight(id, patch),
      insertIfAbsent: row => store.insertInsightIfAbsent({ id: row.id, kind: 'todo', title: row.title, dueAt: row.dueAt, data: row.data })
    }
  }

  private async syncOne(meta: ProviderMeta, cfg: TodoIntegrationConfig) {
    const p = meta.provider
    const startedAt = Date.now()
    this.syncing.add(p)
    this.deps.emit({ type: 'todo-integrations-changed' })
    try {
      const adapter = this.adapter(p, cfg.accountId)
      const tombstones = this.tombstones()
      const store = this.localStore()
      let res
      if (adapter.kind === 'tasks') {
        const full = Date.now() - (this.lastFull.get(p) ?? 0) > FULL_SYNC_MS
        const since = !full && cfg.lastSyncAt ? cfg.lastSyncAt : null
        res = await runTaskSync({ adapter, store, listId: cfg.listId as string, direction: cfg.direction, since, tombstones, fromLabel: meta.label })
        if (since == null && !res.errors.length) this.lastFull.set(p, startedAt)
      } else {
        res = await runCalendarSync({ adapter, store, listId: cfg.listId as string, tombstones })
      }
      this.dropTombstones(res.doneTombstones)
      this.save(p, {
        // 有失败时不推进增量起点，下轮重扫
        lastSyncAt: res.errors.length ? (cfg.lastSyncAt ?? null) : startedAt,
        lastError: res.errors.length ? `${res.errors.length} 条未同步：${res.errors[0]}` : null,
        lastStats: { pushed: res.pushed, pulled: res.pulled, removed: res.removed }
      })
      if (res.localChanged) {
        this.deps.emit({ type: 'todos-changed' })
        // 从外部服务导入的改动也传到其他设备
        notifyTodoSync()
      }
    } catch (err) {
      this.save(p, { lastError: err instanceof Error ? err.message : String(err) })
    } finally {
      this.syncing.delete(p)
      this.deps.emit({ type: 'todo-integrations-changed' })
    }
  }

  // ---------- 忙碌时段 ----------

  async busyBlocks(from: number, to: number): Promise<CalendarBusyBlock[]> {
    const key = `${from}-${to}`
    if (this.busyCache && this.busyCache.key === key && Date.now() - this.busyCache.at < 120_000) return this.busyCache.blocks
    const out: CalendarBusyBlock[] = []
    for (const m of PROVIDERS) {
      if (m.kind !== 'calendar') continue
      const cfg = this.config(m.provider)
      if (!cfg.enabled || !cfg.busy) continue
      try {
        const a = this.adapter(m.provider, cfg.accountId)
        if (a.kind !== 'calendar') continue
        for (const b of await a.busyBlocks(from, to, cfg.listId ?? null)) out.push({ ...b, provider: m.provider })
      } catch (err) {
        console.error(`[todo-integrations] busy blocks ${m.provider} failed:`, err instanceof Error ? err.message : err)
      }
    }
    out.sort((a, b) => a.start - b.start)
    this.busyCache = { key, at: Date.now(), blocks: out }
    return out
  }
}

// ---------- 单例：ipc.ts 初始化，其他地方只需 notifyLocalChange ----------

let instance: TodoIntegrations | null = null

export function initTodoIntegrations(deps: IntegrationDeps): TodoIntegrations {
  if (!instance) {
    instance = new TodoIntegrations(deps)
    instance.start()
  }
  return instance
}

/** 本地待办有改动（新建 / 编辑 / 完成 / 移除）：防抖触发一次导出同步 */
export function notifyLocalChange() {
  instance?.notifyLocalChange()
}
