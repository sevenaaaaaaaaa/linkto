import { hostname } from 'node:os'
import type { AppStore } from '../store'
import type { SyncEngine } from '../mail/sync-engine'
import { friendlyError } from '../mail/sync-engine'
import { KeyRing, TodoSyncError } from '../todo-sync/protocol'
import { syncRound, newStats } from '../todo-sync/engine'
import { TRACE_SYNC_FOLDER, type TraceSyncStatus } from '@shared/trace'
import type { TraceService } from './service'

/**
 * 留痕跨设备同步：复用待办同步的方案与设置——同一个同步邮箱、同一个口令（AES-256-GCM + scrypt）、
 * 同一套线格式与「后写者胜」合并（src/main/todo-sync/protocol.ts），只是放在另一个隐藏文件夹 LinkTo-Trace：
 * 旧版本 LinkTo / 手机端只读 LinkTo-Sync，不会把留痕当成待办导入。
 * 这里只多一个开关（默认关），邮箱与口令在「设置 → 待办 → 跨设备同步」里设。
 */

interface TraceSyncSettings {
  enabled: boolean
  lastSyncAt: number | null
  lastError: string | null
}

interface TodoSyncSettingsLite {
  enabled?: boolean
  accountId?: string | null
  encrypt?: boolean
  deviceName?: string
}

const KEY = 'traceSync'
const TODO_KEY = 'todoSync'
const SECRET_KEY = 'todosync:passphrase'
const DEBOUNCE_MS = 4000
const POLL_MS = 10 * 60_000
const ROUND_LIMIT = 100

export class TraceSync {
  private running = false
  private rerun = false
  private debounce: NodeJS.Timeout | null = null
  private poll: NodeJS.Timeout | null = null
  private keyring: { pass: string; ring: KeyRing } | null = null
  private lastStats: TraceSyncStatus['lastStats'] = null

  constructor(
    private deps: {
      appStore: AppStore
      engine: SyncEngine
      service: TraceService
      event(payload: unknown): void
    }
  ) {}

  start() {
    setTimeout(() => void this.run(), 45_000)
    this.poll = setInterval(() => void this.run(), POLL_MS)
  }

  stop() {
    if (this.poll) clearInterval(this.poll)
    if (this.debounce) clearTimeout(this.debounce)
  }

  private settings(): TraceSyncSettings {
    return { enabled: false, lastSyncAt: null, lastError: null, ...this.deps.appStore.get<Partial<TraceSyncSettings>>(KEY, {}) }
  }

  private save(patch: Partial<TraceSyncSettings>) {
    this.deps.appStore.set(KEY, { ...this.settings(), ...patch })
  }

  private todo(): TodoSyncSettingsLite {
    return this.deps.appStore.get<TodoSyncSettingsLite>(TODO_KEY, {})
  }

  /** 待办同步的邮箱 / 口令是否已设好 */
  private readiness(): { ready: boolean; reason: string | null } {
    const t = this.todo()
    if (!t.accountId) return { ready: false, reason: '先在「设置 → 待办 → 跨设备同步」里选好同步邮箱（留痕复用同一邮箱与口令）' }
    if (t.encrypt !== false && !this.deps.appStore.loadSecret(SECRET_KEY)) return { ready: false, reason: '先在「设置 → 待办 → 跨设备同步」里设置同步口令' }
    return { ready: true, reason: null }
  }

  status(): TraceSyncStatus {
    const s = this.settings()
    const t = this.todo()
    const r = this.readiness()
    return {
      enabled: s.enabled,
      ready: r.ready,
      readyReason: r.reason,
      accountId: t.accountId ?? null,
      encrypt: t.encrypt !== false,
      running: this.running,
      lastSyncAt: s.lastSyncAt,
      lastError: s.lastError,
      folder: TRACE_SYNC_FOLDER,
      lastStats: this.lastStats
    }
  }

  private emit() {
    this.deps.event({ type: 'trace-sync-status', status: this.status() })
  }

  async configure(input: { enabled: boolean }): Promise<{ ok: boolean; error?: string; status: TraceSyncStatus }> {
    if (input.enabled) {
      const r = this.readiness()
      if (!r.ready) return { ok: false, error: r.reason ?? '同步邮箱未设置', status: this.status() }
    }
    this.save({ enabled: !!input.enabled, lastError: null })
    this.emit()
    if (!input.enabled) return { ok: true, status: this.status() }
    await this.run(true)
    const st = this.status()
    return st.lastError ? { ok: false, error: st.lastError, status: st } : { ok: true, status: st }
  }

  async syncNow(): Promise<TraceSyncStatus> {
    await this.run(true)
    return this.status()
  }

  /** 本地留痕有改动：防抖后推送（未开启时为空操作） */
  notifyLocalChange() {
    if (!this.settings().enabled) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.run()
    }, DEBOUNCE_MS)
  }

  private ring(): KeyRing | null {
    if (this.todo().encrypt === false) return null
    const pass = this.deps.appStore.loadSecret(SECRET_KEY)
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
      const r = this.readiness()
      if (!r.ready) throw new Error(r.reason ?? '同步邮箱未设置')
      const t = this.todo()
      const worker = this.deps.engine.getWorker(t.accountId!)
      if (!worker) throw new Error('同步邮箱未启用或尚未连接')
      const stats = newStats()
      try {
        await syncRound({
          transport: {
            ensureFolder: name => worker.ensureHiddenFolder(name),
            fetchHeaders: (folder, names) => worker.fetchFolderHeaders(folder, names),
            download: (folder, uid) => worker.downloadFromFolder(folder, uid),
            append: (folder, raw) => worker.appendToFolder(folder, raw, ['\\Seen']),
            remove: (folder, uids) => worker.deleteFromFolder(folder, uids)
          },
          local: {
            list: () => this.deps.service.listForSync(),
            upsert: x => this.deps.service.upsertFromSync({ ...x, accountId: x.accountId ?? null, messageId: x.messageId ?? null }),
            // 留痕不依赖账户 / 邮件存在（关联在 data.links 里，缺失时界面显示「本机没有这封邮件」）
            hasAccount: () => true,
            hasMessage: () => true
          },
          keyring: this.ring(),
          device: t.deviceName || hostname().replace(/\.local$/, '') || 'LinkTo',
          limit: ROUND_LIMIT,
          stats,
          folder: TRACE_SYNC_FOLDER
        })
      } finally {
        await worker.returnToInbox().catch(() => {})
        this.lastStats = { pulled: stats.pulled, pushed: stats.pushed, removed: stats.removed, at: Date.now() }
        if (stats.changedLocal) this.deps.event({ type: 'trace-changed', id: null })
      }
      this.save({ lastSyncAt: Date.now(), lastError: null })
      if (stats.more) this.rerun = true
    } catch (err) {
      this.save({ lastError: describe(err) })
      if (!manual) console.error('[trace-sync]', describe(err))
    } finally {
      this.running = false
      this.emit()
      if (this.rerun) {
        this.rerun = false
        this.notifyLocalChange()
      }
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof TodoSyncError) {
    if (err.code === 'passphrase') return '同步口令不正确：留痕文件夹里的记录是用另一个口令加密的'
    if (err.code === 'need-passphrase') return '留痕文件夹里的记录已加密：请在待办同步里开启加密并填写相同的口令'
    return `同步数据格式错误：${err.message}`
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/not connected/i.test(msg)) return '同步邮箱尚未连接，稍后自动重试'
  if (/同步邮箱|设置/.test(msg)) return msg
  return friendlyError(err)
}
