/**
 * 生活档案 · 提醒计划与 .ics 生成（纯函数，便于独立打包做单测）
 */
import type { LifeData } from '../../shared/types'
import { daysUntil, startOfDay, repeatLabel, LIFE_CATEGORY_LABEL } from '../../shared/life'

export interface LifeReminder {
  /** 本次要记进 reminded 的键（含被跨过的更早阈值，避免晚发现的条目连发多条） */
  keys: string[]
  title: string
  body: string
}

const md = (t: number) => {
  const d = new Date(t)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
const ymd = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 该不该提醒：到期日前 remindDays 里的每个阈值各提醒一次（键 = 阈值 + 目标日期，换期后重新提醒）；
 * 一次只发最紧的那个阈值，并把已跨过的更早阈值一起记下。过期后 7 天内再提醒一次「已过期」。
 * 已办妥 / 已删除的不提醒。
 */
export function lifeReminder(rec: { title: string; status: string; dueAt: number | null; data: LifeData }, now: number): LifeReminder | null {
  if (rec.status === 'done' || rec.status === 'dismissed') return null
  const target = rec.dueAt ?? rec.data.expiresAt ?? null
  if (!target) return null
  const d = rec.data
  const day = startOfDay(target)
  const done = new Set(d.reminded ?? [])
  const n = daysUntil(target, now)
  const what = d.subject || rec.title
  const who = d.provider ? ` · ${d.provider}` : ''
  const prep = d.actionFrom && startOfDay(d.actionFrom) <= startOfDay(now) && n > 0 ? '，该开始办了' : ''
  if (n < 0) {
    const key = `over-${day}`
    if (n < -7 || done.has(key)) return null
    return { keys: [key], title: `已过期 ${-n} 天：${what}`, body: `${LIFE_CATEGORY_LABEL[d.category]}${who} · ${md(target)} 到期${d.repeat ? '；已续期的话在生活档案里标记「已办妥」' : ''}` }
  }
  const crossed = [...new Set(d.remindDays ?? [])].filter(x => Number.isFinite(x) && x >= 0 && n <= x).sort((a, b) => a - b)
  if (!crossed.length) return null
  const fresh = crossed.filter(x => !done.has(`${x}-${day}`))
  if (!fresh.length) return null
  // 最紧的阈值没发过才发（发过最紧的 = 已提醒过，更早的阈值不必再补）
  if (done.has(`${crossed[0]}-${day}`)) return null
  const keys = fresh.map(x => `${x}-${day}`)
  const when = n === 0 ? '今天到期' : n === 1 ? '明天到期' : `${n} 天后到期`
  return {
    keys,
    title: `${when}：${what}`,
    body: `${LIFE_CATEGORY_LABEL[d.category]}${who} · ${md(target)}${prep}${d.reference ? ` · ${d.reference}` : ''}`
  }
}

// ---------------------------------------------------------------- .ics

const icsText = (s: string) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const icsDate = (t: number) => ymd(t).replace(/-/g, '')
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

/** 按 RFC 5545 折行：每行不超过 75 个字节（UTF-8，不拆多字节字符） */
export function foldLine(line: string): string {
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8')
    const limit = out.length ? 74 : 75
    if (bytes + b > limit) {
      out.push(cur)
      cur = ''
      bytes = 0
    }
    cur += ch
    bytes += b
  }
  out.push(cur)
  return out.join('\r\n ')
}

export interface IcsItem {
  id: string
  title: string
  dueAt: number | null
  data: LifeData
}

/** 生活事务 → .ics：每条一个全天事件（到期日），每个提醒天数一个 VALARM；循环事务带 RRULE */
export function buildLifeIcs(items: IcsItem[], now = Date.now()): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LinkTo//Life Admin//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:生活档案']
  for (const it of items) {
    const t = it.dueAt ?? it.data.expiresAt
    if (!t) continue
    const d = it.data
    const desc = [
      `${LIFE_CATEGORY_LABEL[d.category]}${d.provider ? ` · ${d.provider}` : ''}`,
      d.actionFrom ? `建议 ${ymd(d.actionFrom)} 起办理` : '',
      d.reference ? `编号：${d.reference}` : '',
      d.amount != null ? `预计费用：${d.currency ?? 'CNY'} ${d.amount}` : '',
      d.repeat ? `循环：${repeatLabel(d.repeat)}` : '',
      d.notes ? `备注：${d.notes}` : ''
    ].filter(Boolean)
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${it.id}@life.linkto`)
    lines.push(`DTSTAMP:${stamp(now)}`)
    lines.push(`DTSTART;VALUE=DATE:${icsDate(t)}`)
    lines.push(`DTEND;VALUE=DATE:${icsDate(startOfDay(t) + 36 * 3600_000)}`)
    lines.push(`SUMMARY:${icsText(it.title || d.subject)}`)
    if (desc.length) lines.push(`DESCRIPTION:${icsText(desc.join('\n'))}`)
    lines.push(`CATEGORIES:${icsText(LIFE_CATEGORY_LABEL[d.category])}`)
    lines.push('TRANSP:TRANSPARENT')
    if (d.repeat) lines.push(`RRULE:FREQ=${d.repeat.every === 'year' ? 'YEARLY' : 'MONTHLY'};INTERVAL=${Math.max(1, d.repeat.interval || 1)}`)
    for (const n of [...new Set(d.remindDays ?? [])].filter(x => Number.isFinite(x) && x >= 0).sort((a, b) => b - a)) {
      lines.push('BEGIN:VALARM')
      lines.push('ACTION:DISPLAY')
      // 全天事件从当天 00:00 起算：提前 n 天的上午 9 点
      lines.push(`TRIGGER:${n === 0 ? 'PT9H' : `-PT${n * 24 - 9}H`}`)
      lines.push(`DESCRIPTION:${icsText(`${n === 0 ? '今天' : `${n} 天后`}：${it.title || d.subject}`)}`)
      lines.push('END:VALARM')
    }
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
