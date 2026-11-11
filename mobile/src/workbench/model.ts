import type { Planning } from './planning'
export interface MailSource {
  accountEmail: string
  mailbox: string
  uid: number
  messageId?: string
  subject: string
  from: string
  date: number
}

/** Fields match desktop TodoData / WireTodo. Source survives device-local ID remapping. */
export interface WorkItem {
  id: string
  kind: 'todo' | 'memo'
  title: string
  status: 'open' | 'done' | 'dismissed'
  dueAt: number | null
  createdAt: number
  data: {
    updatedAt: number
    content?: string
    notes?: string
    minutes?: number
    priority?: 1 | 2 | 3
    fixedAt?: number | null
    unscheduled?: boolean
    scheduledAt?: number | null
    pinned?: boolean
    reminder?: boolean
    source?: MailSource
    [key: string]: unknown
  }
}

export const dayStart = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime() }
export const dayEnd = (at: number) => { const d = new Date(at); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d.getTime() }
export const plannedAt = (item: WorkItem) => item.data.unscheduled && !item.data.fixedAt ? null : Number(item.data.fixedAt || item.data.scheduledAt || item.dueAt) || null
export const estimateMinutes = (text: string) => /写|准备|方案|报告|整理|review|draft/i.test(text) ? 45 : /会议|开会|meeting|call/i.test(text) ? 30 : 15
export const durationOf = (item: WorkItem) => Math.max(5, Math.min(480, Number(item.data.minutes) || estimateMinutes(item.title)))

/** Strict local date parsing; reject JS Date's silent overflow (Feb 31 → March). */
export function parseSchedule(date: string, time: string): number | null {
  if (!date.trim() && !time.trim()) return null
  const m = `${date.trim()} ${time.trim() || '09:00'}`.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/)
  if (!m) throw new Error('请填写日期 YYYY-MM-DD 和时间 HH:mm')
  const [, ys, mos, ds, hs, ms] = m
  const [y, mo, d, h, min] = [ys, mos, ds, hs, ms].map(Number)
  const value = new Date(y, mo - 1, d, h, min)
  if (value.getFullYear() !== y || value.getMonth() !== mo - 1 || value.getDate() !== d || h > 23 || min > 59) throw new Error('日期或时间无效')
  return value.getTime()
}

/** Stable gap-filling schedule: preserve fixed blocks, never overlap or overflow the day. */
export function autoSchedule(items: WorkItem[], now: number, end: number, planning?: Planning): { scheduled: Map<string, number>; overflow: string[] } {
  const blocks = items.filter(i => i.kind === 'todo' && i.status === 'open' && i.data.fixedAt)
    .map(i => ({ start: Number(i.data.fixedAt), end: Number(i.data.fixedAt) + durationOf(i) * 60000 }))

  const date = new Date(now); date.setHours(0, 0, 0, 0)
  if (planning && planning.breakEnd > planning.breakStart) blocks.push({ start: date.getTime() + planning.breakStart * 60000, end: date.getTime() + planning.breakEnd * 60000 })
  blocks.sort((a, b) => a.start - b.start)
  const candidates = items.filter(i => i.kind === 'todo' && i.status === 'open' && !i.data.fixedAt && (!i.dueAt || i.dueAt < dayEnd(now)))
    .sort((a, b) => (Number(a.data.order ?? Infinity) - Number(b.data.order ?? Infinity) || 0) || (a.data.priority ?? 2) - (b.data.priority ?? 2) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const scheduled = new Map<string, number>(), overflow: string[] = []
  let cursor = Math.ceil(Math.max(now, planning ? date.getTime() + planning.start * 60000 : now) / 300000) * 300000
  for (const item of candidates) {
    const length = durationOf(item) * 60000
    let candidate = cursor
    for (const block of blocks) if (candidate < block.end && candidate + length > block.start) candidate = block.end
    if (candidate + length > end) { overflow.push(item.id); continue }
    scheduled.set(item.id, candidate)
    cursor = candidate + length + (planning?.buffer ?? 0) * 60000
  }
  return { scheduled, overflow }
}

export function mergeWorkItems(local: WorkItem[], remote: WorkItem[]): WorkItem[] {
  const byId = new Map(local.map(i => [i.id, i]))
  for (const item of remote) {
    const prev = byId.get(item.id)
    if (!prev || item.data.updatedAt > prev.data.updatedAt) byId.set(item.id, item)
  }
  return [...byId.values()]
}
