/**
 * 待办跨设备同步：经用户自己邮箱里的隐藏文件夹 LinkTo-Sync 交换待办（零额外基础设施，不经过任何第三方服务器）。
 * 线格式与合并规则见 ./protocol.ts 顶部注释（mobile/ 按同一协议实现即可互通）。
 */
import { hostname } from 'node:os'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import type { SyncEngine } from '../mail/sync-engine'
import { friendlyError } from '../mail/sync-engine'
import type { TodoSyncStatus } from '@shared/ipc'
import { SYNC_FOLDER_NAME, KeyRing, TodoSyncError } from './protocol'
import { syncRound, newStats } from './engine'

export interface TodoSyncSettings {
  enabled: boolean
  accountId: string | null
  encrypt: boolean
  lastSyncAt: number | null
  lastError: string | null
  deviceName: string
}

const SETTINGS_KEY = 'todoSync'
const SECRET_KEY = 'todosync:passphrase'
const DEBOUNCE_MS = 3000
const POLL_MS = 5 * 60_000
/** 每轮最多下载 / 上传的条数（首次开启时分几轮完成，避免单轮占用连接太久） */
const ROUND_LIMIT = 200

const defaults = (): TodoSyncSettings => ({
  enabled: false,
  accountId: null,
  encrypt: true,
  lastSyncAt: null,
  lastError: null,
  deviceName: hostname().replace(/\.local$/, '') || 'LinkTo'
})

let instance: TodoSyncService | null = null

/** 本地待办有变动（新建 / 编辑 / 完成 / 自动收集）：防抖 3 秒后推送。未开启同步时为空操作 */
export function notifyLocalChange(id?: string) {
  instance?.notifyLocalChange(id)
}

/** 是否已开启待办同步（删除待办时改写墓碑而非硬删，才能传播到其他设备） */
export function isTodoSyncEnabled(): boolean {
  return !!instance?.settings().enabled
}

export class TodoSyncService {
  private running = false
  private rerun = false
  private debounceTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private keyring: { pass: string; ring: KeyRing } | null = null
  private lastStats: TodoSyncStatus['lastStats'] = null

  constructor(
    private deps: {
      store: MailStore
      appStore: AppStore
      engine: SyncEngine
      event(payload: unknown): void
    }
  ) {}

  start() {
    instance = this
    // 启动后等账户连上再跑第一轮；之后每 5 分钟一轮
    setTimeout(() => void this.runRound(), 20_000)
    this.pollTimer = setInterval(() => void this.runRound(), POLL_MS)
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (instance === this) instance = null
  }

  settings(): TodoSyncSettings {
    return this.deps.appStore.get<TodoSyncSettings>(SETTINGS_KEY, defaults())
  }

  private save(patch: Partial<TodoSyncSettings>) {
    this.deps.appStore.set(SETTINGS_KEY, { ...this.settings(), ...patch })
  }

  status(): TodoSyncStatus {
    const s = this.settings()
    return {
      ...s,
      hasPassphrase: !!this.deps.appStore.loadSecret(SECRET_KEY),
      running: this.running,
      folder: SYNC_FOLDER_NAME,
      lastStats: this.lastStats
    }
  }

  notifyLocalChange(_id?: string) {
    if (!this.settings().enabled) return
    this.schedule()
  }

  /** 同步文件夹收到 EXISTS（另一台设备刚写入） */
  onRemoteExists(accountId: string) {
    const s = this.settings()
    if (s.enabled && s.accountId === accountId) this.schedule()
  }

  private schedule() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.runRound()
    }, DEBOUNCE_MS)
  }

  async configure(input: { enabled: boolean; accountId: string | null; passphrase?: string; encrypt?: boolean; deviceName?: string }): Promise<{ ok: boolean; error?: string; status: TodoSyncStatus }> {
    const fail = (error: string) => ({ ok: false, error, status: this.status() })
    const encrypt = input.encrypt ?? this.settings().encrypt
    if (input.passphrase !== undefined && input.passphrase !== '') {
      if (input.passphrase.length < 6) return fail('同步口令至少 6 位')
      this.deps.appStore.saveSecret(SECRET_KEY, input.passphrase)
      this.keyring = null
    }
    if (input.enabled) {
      if (!input.accountId || !this.deps.store.listAccounts().some(a => a.id === input.accountId)) return fail('请选择用于同步的邮箱')
      if (encrypt && !this.deps.appStore.loadSecret(SECRET_KEY)) return fail('请先设置同步口令')
    }
    const prev = this.settings()
    this.save({
      enabled: input.enabled,
      accountId: input.accountId,
      encrypt,
      ...(input.deviceName?.trim() ? { deviceName: input.deviceName.trim().slice(0, 60) } : {}),
      // 换邮箱 / 换口令后旧错误不再适用
      lastError: null,
      ...(prev.accountId !== input.accountId ? { lastSyncAt: null } : {})
    })
    this.emitStatus()
    if (!input.enabled) return { ok: true, status: this.status() }
    await this.runRound()
    const st = this.status()
    return st.lastError ? { ok: false, error: st.lastError, status: st } : { ok: true, status: st }
  }

  /** 立即同步一轮（UI「立即同步」）；返回结束后的状态 */
  async syncNow(): Promise<TodoSyncStatus> {
    await this.runRound(true)
    return this.status()
  }

  private emitStatus() {
    this.deps.event({ type: 'todo-sync-status', status: this.status() })
  }

  private ring(): KeyRing | null {
    if (!this.settings().encrypt) return null
    const pass = this.deps.appStore.loadSecret(SECRET_KEY)
    if (!pass) throw new TodoSyncError('need-passphrase', '尚未设置同步口令')
    if (!this.keyring || this.keyring.pass !== pass) this.keyring = { pass, ring: new KeyRing(pass) }
    return this.keyring.ring
  }

  private async runRound(manual = false): Promise<void> {
    const s = this.settings()
    if (!s.enabled || !s.accountId) return
    if (this.running) {
      this.rerun = true
      return
    }
    this.running = true
    this.emitStatus()
    try {
      const more = await this.round(s)
      this.save({ lastSyncAt: Date.now(), lastError: null })
      if (more) this.rerun = true
    } catch (err) {
      this.save({ lastError: describe(err) })
      if (!manual) console.error('[todo-sync]', err instanceof TodoSyncError ? err.code : describe(err))
    } finally {
      this.running = false
      this.emitStatus()
      if (this.rerun) {
        this.rerun = false
        this.schedule()
      }
    }
  }

  /** 一轮：拉头 → 拉新 → 推新 → 清理。返回 true 表示还有剩余（分轮继续） */
  private async round(s: TodoSyncSettings): Promise<boolean> {
    const worker = this.deps.engine.getWorker(s.accountId!)
    if (!worker) throw new Error('同步邮箱未启用或尚未连接')
    const ring = this.ring()
    const store = this.deps.store
    const accountIds = new Set(store.listAccounts().map(a => a.id))
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
          list: () => store.listTodosForSync(),
          upsert: t => store.upsertTodoFromSync({ ...t, accountId: t.accountId ?? null, messageId: t.messageId ?? null }),
          hasAccount: id => accountIds.has(id),
          hasMessage: id => !!store.getMessageRow(id)
        },
        keyring: ring,
        device: s.deviceName,
        limit: ROUND_LIMIT,
        stats
      })
    } finally {
      await worker.returnToInbox().catch(() => {})
      this.lastStats = { pulled: stats.pulled, pushed: stats.pushed, removed: stats.removed, at: Date.now() }
      if (stats.changedLocal) this.deps.event({ type: 'todos-changed' })
    }
    return stats.more
  }
}

function describe(err: unknown): string {
  if (err instanceof TodoSyncError) {
    if (err.code === 'passphrase')
      return '同步口令不正确：同步文件夹里的待办是用另一个口令加密的。请在这台设备上输入与其他设备相同的口令。'
    if (err.code === 'need-passphrase') return '同步文件夹里的待办已加密：请开启加密并填写与其他设备相同的同步口令'
    return `同步数据格式错误：${err.message}`
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/not connected/i.test(msg)) return '同步邮箱尚未连接，稍后自动重试'
  if (/同步邮箱/.test(msg)) return msg
  return friendlyError(err)
}

