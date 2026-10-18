/**
 * 待办 ⇄ 外部服务的纯逻辑：字段映射 + 同步计划（无 IO，便于单测）。
 * 执行由 engine.ts 负责：先按这里的计划调用适配器，再经 store 写回本地。
 */
import type { TodoChecklistItem, TodoData, TodoProvider, TodoSyncDirection } from '@shared/types'
import type { CalendarEventFields, ChecklistLine, RemoteTask, TaskDue, TaskFields } from './types'

export interface LocalTodo {
  id: string
  title: string
  status: string
  dueAt: number | null
  createdAt?: number
  data: TodoData
}

export type ExternalRef = NonNullable<TodoData['external']>[TodoProvider]

export interface Tombstone {
  provider: TodoProvider
  id: string
  listId?: string
  at: number
}

// ---------- 正文 ⇄ 备注 + 子项（Reminders / Google Tasks 没有原生子项，用 ☐/☑ 行） ----------

const BOX_OPEN = '☐'
const BOX_DONE = '☑'

export function encodeBody(notes: string, checklist: ChecklistLine[]): string {
  const n = (notes ?? '').trimEnd()
  if (!checklist.length) return n
  const lines = checklist.map(c => `${c.done ? BOX_DONE : BOX_OPEN} ${c.text}`)
  return n ? `${n}\n\n${lines.join('\n')}` : lines.join('\n')
}

export function decodeBody(body: string | null | undefined): { notes: string; checklist: ChecklistLine[] } {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n')
  const checklist: ChecklistLine[] = []
  // 只认尾部连续的 ☐/☑ 行，避免误伤正文里偶然出现的符号
  while (lines.length) {
    const last = lines[lines.length - 1]
    const m = last.match(/^\s*([☐☑✓✔]|\[( |x|X)\])\s+(.*)$/)
    if (!m) {
      if (last.trim() === '' && checklist.length === 0) {
        lines.pop()
        continue
      }
      break
    }
    lines.pop()
    const done = m[1] === BOX_DONE || m[1] === '✓' || m[1] === '✔' || /x/i.test(m[2] ?? '')
    checklist.unshift({ text: m[3].trim(), done })
  }
  return { notes: lines.join('\n').trimEnd(), checklist }
}

// ---------- 截止时间 ----------

const pad = (n: number) => String(n).padStart(2, '0')

/** 本地日期 YYYY-MM-DD */
export function localDateKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function isLocalMidnight(ms: number): boolean {
  const d = new Date(ms)
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0
}

/** 本地日期字符串（YYYY-MM-DD）→ 本地零点 ms */
export function localMidnightOf(dateKey: string): number {
  const [y, m, d] = dateKey.slice(0, 10).split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1).getTime()
}

/** 待办的截止：dueAt 优先，其次固定开始时间 */
export function dueFromLocal(t: LocalTodo): TaskDue | null {
  const at = t.dueAt ?? t.data.fixedAt ?? null
  if (at == null || !Number.isFinite(at)) return null
  return { at, allDay: isLocalMidnight(at) }
}

/** 远端截止 → 本地 dueAt：远端只有日期且与本地同一天时保留本地的具体时刻（Google / To Do 会丢掉时间） */
export function localDueFromRemote(due: TaskDue | null, prevDueAt: number | null): number | null {
  if (!due) return null
  if (due.allDay && prevDueAt != null && localDateKey(prevDueAt) === localDateKey(due.at)) return prevDueAt
  return due.at
}

// ---------- 优先级 ----------

/** 提醒事项：0 无 · 1–4 高 · 5 中 · 6–9 低 */
export function priorityFromReminders(p: number | null | undefined): 1 | 2 | 3 | null {
  if (!p) return null
  if (p <= 4) return 1
  if (p === 5) return 2
  return 3
}

export function priorityToReminders(p: 1 | 2 | 3 | null | undefined): number {
  return p === 1 ? 1 : p === 2 ? 5 : p === 3 ? 9 : 0
}

/** Graph importance：low / normal / high。normal 既可能是「中」也可能是「无」，映射为 null 并标记 priorityLoose */
export function priorityFromImportance(i: string | null | undefined): 1 | 2 | 3 | null {
  if (i === 'high') return 1
  if (i === 'low') return 3
  return null
}

export function priorityToImportance(p: 1 | 2 | 3 | null | undefined): 'low' | 'normal' | 'high' {
  return p === 1 ? 'high' : p === 3 ? 'low' : 'normal'
}

// ---------- 本地 ⇄ 远端字段 ----------

export function localToFields(t: LocalTodo): TaskFields {
  return {
    title: t.title || '（无标题）',
    notes: t.data.notes ?? '',
    due: dueFromLocal(t),
    completed: t.status === 'done',
    priority: t.data.priority ?? null,
    checklist: (t.data.checklist ?? []).map(c => ({ text: c.text, done: !!c.done }))
  }
}

/** 远端子项 → 本地子项：按文字匹配沿用原 id，避免界面闪动 */
export function mergeChecklist(remote: ChecklistLine[], prev: TodoChecklistItem[] | undefined, newId: () => string): TodoChecklistItem[] {
  const pool = [...(prev ?? [])]
  return remote.map(r => {
    const i = pool.findIndex(p => p.text === r.text)
    const id = i >= 0 ? pool.splice(i, 1)[0].id : newId()
    return { id, text: r.text, done: r.done }
  })
}

export interface LocalPatch {
  title: string
  dueAt: number | null
  status: 'open' | 'done'
  data: Partial<TodoData>
}

/** 远端任务 → 本地更新（data 不含 updatedAt / external，由执行器补） */
export function remoteToLocalPatch(r: RemoteTask, prev: LocalTodo | null, newId: () => string): LocalPatch {
  const data: Partial<TodoData> = {}
  // 没有原生子项的服务：从备注尾部解析
  let notes = r.notes ?? ''
  let checklist = r.checklist ?? null
  if (r.checklist === undefined) {
    const parsed = decodeBody(notes)
    notes = parsed.notes
    checklist = parsed.checklist
  }
  if (notes || prev?.data.notes) data.notes = notes
  if (checklist && (checklist.length || prev?.data.checklist?.length)) data.checklist = mergeChecklist(checklist, prev?.data.checklist, newId)
  if (r.priority !== undefined) {
    if (r.priority != null) data.priority = r.priority
    // 「普通」重要性：本地是「中」时保持不变
    else if (r.priorityLoose && prev?.data.priority === 2) { /* keep */ }
    else if (prev?.data.priority != null) data.priority = undefined
  }
  if (r.completed) data.doneAt = r.completedAt ?? prev?.data.doneAt ?? r.modifiedAt
  return {
    title: (r.title || '').slice(0, 200) || '（无标题）',
    dueAt: localDueFromRemote(r.due, prev?.dueAt ?? null),
    status: r.completed ? 'done' : 'open',
    data
  }
}

/** 本地与远端内容是否一致（一致时只更新映射，不改动待办） */
export function sameContent(t: LocalTodo, r: RemoteTask): boolean {
  const p = remoteToLocalPatch(r, t, () => 'x')
  const localStatus = t.status === 'done' ? 'done' : 'open'
  if (p.title !== (t.title || '（无标题）') || p.status !== localStatus || p.dueAt !== t.dueAt) return false
  if ((p.data.notes ?? '') !== (t.data.notes ?? '')) return false
  const prio = 'priority' in p.data ? (p.data.priority ?? null) : (t.data.priority ?? null)
  if (r.priority !== undefined && prio !== (t.data.priority ?? null)) return false
  const a = (p.data.checklist ?? []).map(c => `${c.done ? 1 : 0}${c.text}`).join('\n')
  const b = (t.data.checklist ?? []).map(c => `${c.done ? 1 : 0}${c.text}`).join('\n')
  return a === b
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

// ---------- 任务清单同步计划 ----------

export type TaskOp =
  | { op: 'push-create'; local: LocalTodo }
  | { op: 'push-update'; local: LocalTodo; remoteId: string; prev: RemoteTask | null }
  | { op: 'push-delete'; local: LocalTodo | null; remoteId: string }
  | { op: 'pull-create'; remote: RemoteTask }
  | { op: 'pull-update'; local: LocalTodo; remote: RemoteTask }
  | { op: 'pull-delete'; local: LocalTodo }
  /** 只更新 / 清除映射（内容一致、或无需动作的失联映射） */
  | { op: 'link'; local: LocalTodo; remote: RemoteTask }
  | { op: 'unlink'; local: LocalTodo }

export interface TaskPlanInput {
  provider: TodoProvider
  listId: string
  direction: TodoSyncDirection
  local: LocalTodo[]
  remote: { items: RemoteTask[]; complete: boolean }
  tombstones: Tombstone[]
  /** 首次导出时的上限，避免一口气把几百条历史待办推出去 */
  maxCreates?: number
}

export function refOf(t: LocalTodo, provider: TodoProvider, listId: string): ExternalRef | null {
  const ref = t.data.external?.[provider]
  return ref && ref.id && (!ref.listId || ref.listId === listId) ? ref : null
}

export function planTaskSync(input: TaskPlanInput): TaskOp[] {
  const { provider, listId, direction, local, remote } = input
  const canPush = direction !== 'import'
  const canPull = direction !== 'export'
  const ops: TaskOp[] = []
  const byId = new Map(remote.items.map(r => [r.id, r]))
  const seen = new Set<string>()
  const tomb = new Set(input.tombstones.filter(t => t.provider === provider && (!t.listId || t.listId === listId)).map(t => t.id))
  const unmappedLocal: LocalTodo[] = []

  for (const t of local) {
    const ref = refOf(t, provider, listId)
    if (!ref) {
      if (t.status === 'open') unmappedLocal.push(t)
      continue
    }
    seen.add(ref.id)
    const r = byId.get(ref.id)
    const localChanged = (t.data.updatedAt ?? 0) > ref.syncedAt
    const gone = r ? !!r.deleted : remote.complete

    if (gone) {
      // 远端删了：只导出 / 本地之后又改过 → 重建；否则本地跟着移除
      if (t.status === 'open' && canPush && (!canPull || localChanged)) ops.push({ op: 'push-create', local: t })
      else if (canPull && t.status !== 'dismissed') ops.push({ op: 'pull-delete', local: t })
      else ops.push({ op: 'unlink', local: t })
      continue
    }

    if (!r) {
      // 增量列表里没出现 = 远端没改过
      if (localChanged && canPush) {
        if (t.status === 'dismissed') ops.push({ op: 'push-delete', local: t, remoteId: ref.id })
        else ops.push({ op: 'push-update', local: t, remoteId: ref.id, prev: null })
      }
      continue
    }

    const remoteChanged = r.etag !== (ref.etag ?? '')
    // 冲突：后写者胜（本地 updatedAt vs 远端修改时间）
    const localWins = !remoteChanged || (localChanged && (t.data.updatedAt ?? 0) >= r.modifiedAt)

    if (t.status === 'dismissed') {
      // 本地已移除：远端在那之后又改过 → 复活本地；否则删除远端（只导入时不动远端）
      if (canPull && !localWins) ops.push({ op: 'pull-update', local: t, remote: r })
      else if (canPush) ops.push({ op: 'push-delete', local: t, remoteId: r.id })
      continue
    }

    if (localChanged && remoteChanged) {
      // 只导出时以本地为准、只导入时以远端为准，双向按后写者胜
      const preferPush = localWins ? canPush : !canPull
      if (sameContent(t, r)) ops.push({ op: 'link', local: t, remote: r })
      else if (preferPush) ops.push({ op: 'push-update', local: t, remoteId: r.id, prev: r })
      else ops.push({ op: 'pull-update', local: t, remote: r })
    } else if (localChanged) {
      if (canPush) ops.push({ op: 'push-update', local: t, remoteId: r.id, prev: r })
    } else if (remoteChanged) {
      if (canPull) ops.push(sameContent(t, r) ? { op: 'link', local: t, remote: r } : { op: 'pull-update', local: t, remote: r })
      // 只导出：远端被手动改过，不回写也不覆盖，保持外部修改
    }
  }

  // 本地删除过的（墓碑）：同步删除远端；只导入时墓碑保留，用来阻止重新导入
  for (const id of tomb) {
    seen.add(id)
    if (canPush) ops.push({ op: 'push-delete', local: null, remoteId: id })
  }

  // 远端新条目：同名的未关联本地待办直接关联（避免首连时重复），否则导入
  const freeLocal = new Map<string, LocalTodo[]>()
  for (const t of unmappedLocal) {
    const k = norm(t.title)
    freeLocal.set(k, [...(freeLocal.get(k) ?? []), t])
  }
  const linked = new Set<string>()
  for (const r of remote.items) {
    if (seen.has(r.id) || r.deleted) continue
    const cands = freeLocal.get(norm(r.title))
    const match = !r.completed && cands?.length ? cands.shift()! : null
    if (match) {
      linked.add(match.id)
      ops.push({ op: 'link', local: match, remote: r })
      continue
    }
    if (canPull && !r.completed) ops.push({ op: 'pull-create', remote: r })
  }

  if (canPush) {
    let budget = input.maxCreates ?? 200
    for (const t of unmappedLocal) {
      if (linked.has(t.id)) continue
      if (budget-- <= 0) break
      ops.push({ op: 'push-create', local: t })
    }
  }
  return ops
}

// ---------- 日历（只导出）同步计划 ----------

export type CalendarOp =
  | { op: 'event-create'; local: LocalTodo; fields: CalendarEventFields }
  | { op: 'event-update'; local: LocalTodo; remoteId: string; fields: CalendarEventFields }
  | { op: 'event-delete'; local: LocalTodo | null; remoteId: string }

/** 有固定时间的待办（会议 / 约好的时间）→ 日历事件字段；没有则 null */
export function calendarFieldsOf(t: LocalTodo): CalendarEventFields | null {
  const start = t.data.fixedAt ?? t.data.meeting?.startsAt ?? null
  if (start == null || !Number.isFinite(start)) return null
  const minutes = Math.max(5, Math.min(12 * 60, t.data.minutes ?? 30))
  const endRaw = t.data.meeting?.endsAt ?? null
  const end = endRaw && endRaw > start ? endRaw : start + minutes * 60_000
  const url = t.data.meeting?.url ?? null
  const notes = [t.data.notes ?? '', url ? `入会链接：${url}` : '', t.data.meeting?.code ? `会议号 / 密码：${t.data.meeting.code}` : '']
    .filter(Boolean)
    .join('\n')
  return { title: t.title || '（无标题）', notes, start, end, url }
}

export function planCalendarSync(input: {
  provider: TodoProvider
  listId: string
  local: LocalTodo[]
  tombstones: Tombstone[]
  now: number
}): CalendarOp[] {
  const { provider, listId, local, now } = input
  const ops: CalendarOp[] = []
  for (const t of local) {
    const ref = refOf(t, provider, listId)
    const fields = t.status === 'dismissed' ? null : calendarFieldsOf(t)
    if (!ref) {
      // 只为未来（含今天）的未完成待办建事件
      if (fields && t.status === 'open' && fields.end > now - 86_400_000) ops.push({ op: 'event-create', local: t, fields })
      continue
    }
    if (!fields) {
      ops.push({ op: 'event-delete', local: t, remoteId: ref.id })
      continue
    }
    if ((t.data.updatedAt ?? 0) > ref.syncedAt) ops.push({ op: 'event-update', local: t, remoteId: ref.id, fields })
  }
  for (const tb of input.tombstones) {
    if (tb.provider === provider && (!tb.listId || tb.listId === listId)) ops.push({ op: 'event-delete', local: null, remoteId: tb.id })
  }
  return ops
}
