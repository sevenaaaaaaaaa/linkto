import { durationOf, plannedAt, type WorkItem } from './model'
export interface Planning { start: number; end: number; breakStart: number; breakEnd: number; buffer: number }
export const defaultPlanning: Planning = { start: 9 * 60, end: 20 * 60, breakStart: 12 * 60, breakEnd: 13 * 60, buffer: 0 }
export const minuteText = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
export function parseMinute(text: string): number {
  const match = text.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('请使用 HH:mm 时间格式')
  return Number(match[1]) * 60 + Number(match[2])
}
export function validatePlanning(value: Planning) {
  if (Object.values(value).some(n => !Number.isFinite(n)) || value.start < 0 || value.end >= 1440 || value.end <= value.start || value.breakStart < 0 || value.breakEnd >= 1440 || value.breakEnd < value.breakStart || value.buffer < 0 || value.buffer > 60) throw new Error('结束时间需晚于开始时间；休息时间需有效，间隔为 0–60 分钟')
  return value
}
export function conflictsFor(item: WorkItem, items: WorkItem[]): WorkItem[] {
  const start = plannedAt(item)
  if (!start || item.status !== 'open' || item.kind !== 'todo') return []
  const end = start + durationOf(item) * 60000
  return items.filter(other => {
    const at = plannedAt(other)
    return other.id !== item.id && other.kind === 'todo' && other.status === 'open' && !!at && at < end && at + durationOf(other) * 60000 > start
  })
}
/** Drop against actual measured row centers, supporting cards with different heights. */
export function reorderTarget(index: number, distance: number, heights: number[]) {
  let target = index, remaining = Math.abs(distance)
  const direction = distance > 0 ? 1 : -1
  while (target + direction >= 0 && target + direction < heights.length) {
    const threshold = ((heights[target] || 120) + (heights[target + direction] || 120)) / 2
    if (remaining < threshold / 2) break
    remaining -= threshold
    target += direction
  }
  return target
}
