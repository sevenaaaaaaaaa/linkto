/**
 * 同步执行器：按 merge.ts 的计划调用适配器，再把结果写回本地待办。
 * 本地写入只走 LocalTodoStore（生产环境 = MailStore 的 insights 方法），便于用内存实现做端到端单测。
 */
import { createHash } from 'node:crypto'
import type { TodoData, TodoProvider, TodoSyncDirection } from '@shared/types'
import type { CalendarAdapter, RemoteTask, TasksAdapter } from './types'
import { NotFoundError } from './types'
import { localToFields, planCalendarSync, planTaskSync, remoteToLocalPatch, type LocalTodo, type Tombstone } from './merge'

export interface LocalTodoStore {
  list(): LocalTodo[]
  get(id: string): LocalTodo | null
  update(id: string, patch: { title?: string; dueAt?: number | null; status?: string; data?: Record<string, unknown> }): void
  insertIfAbsent(row: { id: string; title: string; dueAt: number | null; data: Record<string, unknown> }): boolean
}

export interface SyncResult {
  pushed: number
  pulled: number
  removed: number
  /** 本地有改动（需要广播 todos-changed） */
  localChanged: boolean
  /** 已处理（可清除）的墓碑 */
  doneTombstones: Tombstone[]
  errors: string[]
}

const newChecklistId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export function localIdForRemote(provider: TodoProvider, remoteId: string): string {
  return `todo-ext-${provider}-${createHash('sha1').update(remoteId).digest('hex').slice(0, 16)}`
}

/** 本地写入助手：写映射时尽量不打扰用户在同步期间的新改动 */
class Writer {
  constructor(
    private store: LocalTodoStore,
    private provider: TodoProvider,
    private listId: string,
    private now: () => number
  ) {}

  private extWithout(data: TodoData): TodoData['external'] {
    const ext = { ...(data.external ?? {}) }
    delete ext[this.provider]
    return ext
  }

  /** 推送成功后记映射：期间本地又被改过则 syncedAt 停在计划时的 updatedAt，下轮继续推 */
  ref(planned: LocalTodo, remote: { id: string; etag: string }) {
    const fresh = this.store.get(planned.id)
    if (!fresh) return
    const plannedAt = planned.data.updatedAt ?? 0
    const freshAt = fresh.data.updatedAt ?? 0
    const updatedAt = freshAt || this.now()
    const syncedAt = freshAt > plannedAt ? plannedAt : Math.max(this.now(), updatedAt)
    this.store.update(planned.id, {
      data: {
        external: { ...(fresh.data.external ?? {}), [this.provider]: { id: remote.id, listId: this.listId, etag: remote.etag, syncedAt } },
        updatedAt
      }
    })
  }

  unlink(planned: LocalTodo, extra?: { status?: string }) {
    const fresh = this.store.get(planned.id)
    if (!fresh) return
    const status = extra?.status
    this.store.update(planned.id, {
      ...(status ? { status } : {}),
      data: { external: this.extWithout(fresh.data), updatedAt: status ? this.now() : (fresh.data.updatedAt ?? this.now()) }
    })
  }

  /** 远端 → 本地：updatedAt 用远端修改时间（store 不再自增），返回是否写入 */
  pull(planned: LocalTodo, r: RemoteTask): boolean {
    const fresh = this.store.get(planned.id)
    if (!fresh) return false
    // 同步期间用户刚改过：这轮不覆盖，下轮按后写者胜重新判断
    if ((fresh.data.updatedAt ?? 0) > (planned.data.updatedAt ?? 0)) return false
    const p = remoteToLocalPatch(r, fresh, newChecklistId)
    const updatedAt = r.modifiedAt || this.now()
    this.store.update(planned.id, {
      title: p.title,
      dueAt: p.dueAt,
      status: p.status,
      data: {
        ...p.data,
        external: { ...(fresh.data.external ?? {}), [this.provider]: { id: r.id, listId: this.listId, etag: r.etag, syncedAt: Math.max(this.now(), updatedAt) } },
        updatedAt
      }
    })
    return true
  }

  create(r: RemoteTask, fromLabel: string): boolean {
    const id = localIdForRemote(this.provider, r.id)
    const p = remoteToLocalPatch(r, null, newChecklistId)
    const updatedAt = r.modifiedAt || this.now()
    const external = { [this.provider]: { id: r.id, listId: this.listId, etag: r.etag, syncedAt: Math.max(this.now(), updatedAt) } }
    const inserted = this.store.insertIfAbsent({
      id,
      title: p.title,
      dueAt: p.dueAt,
      data: { from: fromLabel, todoKind: 'task', inbox: true, ...p.data, external, updatedAt }
    })
    if (inserted) {
      if (p.status !== 'open') this.store.update(id, { status: p.status, data: { updatedAt } })
      return true
    }
    // 之前导入过、后来失联的同一条：复活并重新关联
    const fresh = this.store.get(id)
    if (!fresh) return false
    this.store.update(id, {
      title: p.title,
      dueAt: p.dueAt,
      status: p.status,
      data: { ...p.data, external: { ...(fresh.data.external ?? {}), ...external }, updatedAt }
    })
    return true
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function runTaskSync(opts: {
  adapter: TasksAdapter
  store: LocalTodoStore
  listId: string
  direction: TodoSyncDirection
  since: number | null
  tombstones: Tombstone[]
  fromLabel: string
  now?: () => number
}): Promise<SyncResult> {
  const { adapter, store, listId, direction } = opts
  const now = opts.now ?? Date.now
  const provider = adapter.provider
  const w = new Writer(store, provider, listId, now)
  const res: SyncResult = { pushed: 0, pulled: 0, removed: 0, localChanged: false, doneTombstones: [], errors: [] }

  const remote = await adapter.listItems(listId, opts.since)
  const tombs = opts.tombstones.filter(t => t.provider === provider && (!t.listId || t.listId === listId))
  const ops = planTaskSync({ provider, listId, direction, local: store.list(), remote, tombstones: tombs })

  const pushCreate = async (local: LocalTodo) => {
    const r = await adapter.create(listId, localToFields(local))
    w.ref(local, r)
    res.pushed++
  }

  for (const op of ops) {
    try {
      switch (op.op) {
        case 'push-create':
          await pushCreate(op.local)
          res.localChanged = true
          break
        case 'push-update':
          try {
            const r = await adapter.update(listId, op.remoteId, localToFields(op.local), op.prev)
            w.ref(op.local, r)
            res.pushed++
          } catch (err) {
            if (!(err instanceof NotFoundError)) throw err
            await pushCreate(op.local)
          }
          res.localChanged = true
          break
        case 'push-delete':
          await adapter.remove(listId, op.remoteId)
          if (op.local) w.unlink(op.local)
          res.removed++
          res.localChanged = res.localChanged || !!op.local
          break
        case 'pull-create':
          if (w.create(op.remote, opts.fromLabel)) {
            res.pulled++
            res.localChanged = true
          }
          break
        case 'pull-update':
          if (w.pull(op.local, op.remote)) {
            res.pulled++
            res.localChanged = true
          }
          break
        case 'pull-delete':
          w.unlink(op.local, { status: 'dismissed' })
          res.removed++
          res.localChanged = true
          break
        case 'link':
          w.ref(op.local, op.remote)
          break
        case 'unlink':
          w.unlink(op.local)
          break
      }
    } catch (err) {
      res.errors.push(errText(err))
      // 权限问题每条都会失败：直接中止本轮
      if (err instanceof Error && err.name === 'PermissionError') break
    }
  }
  // 只导入时墓碑保留（阻止已删的再被导入）；其余情况处理完即清
  if (direction !== 'import' && !res.errors.length) res.doneTombstones = tombs
  return res
}

export async function runCalendarSync(opts: {
  adapter: CalendarAdapter
  store: LocalTodoStore
  listId: string
  tombstones: Tombstone[]
  now?: () => number
}): Promise<SyncResult> {
  const { adapter, store, listId } = opts
  const now = opts.now ?? Date.now
  const provider = adapter.provider
  const w = new Writer(store, provider, listId, now)
  const res: SyncResult = { pushed: 0, pulled: 0, removed: 0, localChanged: false, doneTombstones: [], errors: [] }
  const tombs = opts.tombstones.filter(t => t.provider === provider && (!t.listId || t.listId === listId))
  const ops = planCalendarSync({ provider, listId, local: store.list(), tombstones: tombs, now: now() })

  for (const op of ops) {
    try {
      if (op.op === 'event-create') {
        w.ref(op.local, await adapter.createEvent(listId, op.fields))
        res.pushed++
      } else if (op.op === 'event-update') {
        let r: { id: string; etag: string }
        try {
          r = await adapter.updateEvent(listId, op.remoteId, op.fields)
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err
          r = await adapter.createEvent(listId, op.fields)
        }
        w.ref(op.local, r)
        res.pushed++
      } else {
        await adapter.removeEvent(listId, op.remoteId)
        if (op.local) w.unlink(op.local)
        res.removed++
      }
      res.localChanged = res.localChanged || !!(op as { local: LocalTodo | null }).local
    } catch (err) {
      res.errors.push(errText(err))
      if (err instanceof Error && err.name === 'PermissionError') break
    }
  }
  if (!res.errors.length) res.doneTombstones = tombs
  return res
}
