import type { InsightRecord } from '@shared/types'

/**
 * 待办自动排布（确定性、纯函数）——「科学排布」的那一半：
 * 1) 打分：截止紧迫 45% · 重要度 35% · 能否快速清掉 12% · 搁置时长 8%
 * 2) 排时间：固定时间的事项先占位，其余按分数从高到低填进今天的空闲时段（避开午休），
 *    放不下的顺延到下一个工作日；逾期的自动挪到今天
 * 3) 每一项给出一句「为什么排在这里」
 * AI 只负责估时长 / 定优先级 / 写理由（aiPlanTodos），排布本身在这里瞬时完成，方便做动画。
 */

export type { TodoData } from '@shared/types'
import type { TodoData } from '@shared/types'

export type Bucket = 'overdue' | 'today' | 'tomorrow' | 'later' | 'someday'

export interface Planned {
  id: string
  todo: InsightRecord
  score: number
  factors: { due: number; importance: number; quick: number; age: number }
  bucket: Bucket
  start: number | null
  end: number | null
  minutes: number
  /** 排在这里的主要原因 */
  reason: string
  /** 排出来的完成时间晚于截止 */
  atRisk: boolean
}

export interface ScheduleConfig {
  dayStart: number // 小时
  dayEnd: number
  lunch: [number, number] | null
  workdays: number[] // 0=周日
}

export const DEFAULT_SCHEDULE: ScheduleConfig = { dayStart: 9, dayEnd: 18, lunch: [12, 13], workdays: [0, 1, 2, 3, 4, 5, 6] }

const CFG_KEY = 'ms_todo_schedule'
/** 工作时段（待办页可调，按设备保存） */
export function loadScheduleConfig(): ScheduleConfig {
  try {
    return { ...DEFAULT_SCHEDULE, ...(JSON.parse(localStorage.getItem(CFG_KEY) || '{}') as Partial<ScheduleConfig>) }
  } catch {
    return DEFAULT_SCHEDULE
  }
}
export function saveScheduleConfig(c: ScheduleConfig) {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(c))
  } catch {
    /* ignore */
  }
}

const H = 3600_000
const D = 24 * H
const data = (t: InsightRecord) => (t.data ?? {}) as TodoData

export function minutesOf(t: InsightRecord): number {
  const m = Number(data(t).minutes)
  return Number.isFinite(m) && m > 0 ? m : data(t).todoKind === 'reply' ? 10 : 25
}

function dayStartOf(ts: number, hour: number) {
  const d = new Date(ts)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

function nextWorkday(ts: number, cfg: ScheduleConfig) {
  let d = new Date(ts)
  for (let i = 0; i < 14; i++) {
    d = new Date(d.getTime() + D)
    if (cfg.workdays.includes(d.getDay())) break
  }
  return dayStartOf(d.getTime(), cfg.dayStart)
}

export function fmtClock(ts: number) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtDue(ts: number, now = Date.now()) {
  const d = new Date(ts)
  const days = Math.round((dayStartOf(ts, 0) - dayStartOf(now, 0)) / D)
  const day = days === 0 ? '今天' : days === 1 ? '明天' : days === 2 ? '后天' : days === -1 ? '昨天' : `${d.getMonth() + 1}/${d.getDate()}`
  return d.getHours() === 0 && d.getMinutes() === 0 ? day : `${day} ${fmtClock(ts)}`
}

export function factorsOf(t: InsightRecord, now: number) {
  let due = 0.1
  if (t.dueAt) {
    const hours = (t.dueAt - now) / H
    due = hours < 0 ? 1 : hours <= 24 ? 0.9 - (hours / 24) * 0.2 : hours <= 72 ? 0.6 : hours <= 168 ? 0.4 : 0.2
  }
  const p = data(t).priority ?? 2
  const importance = p === 1 ? 1 : p === 2 ? 0.6 : 0.25
  const m = minutesOf(t)
  const quick = m <= 15 ? 1 : m <= 30 ? 0.6 : m <= 60 ? 0.35 : 0.15
  const age = Math.min(1, (now - (t.createdAt || now)) / (7 * D))
  return { due, importance, quick, age }
}

export const scoreOf = (f: ReturnType<typeof factorsOf>) => 0.45 * f.due + 0.35 * f.importance + 0.12 * f.quick + 0.08 * f.age

function reasonOf(t: InsightRecord, f: ReturnType<typeof factorsOf>, now: number, start: number | null): string {
  const d = data(t)
  if (d.fixedAt) return `固定在 ${fmtClock(d.fixedAt)}`
  if (t.dueAt && t.dueAt < now) {
    const days = Math.max(1, Math.round((now - t.dueAt) / D))
    const today = start != null && new Date(start).toDateString() === new Date(now).toDateString()
    return today ? `已逾期 ${days} 天，挪到今天` : `已逾期 ${days} 天，排在最早的空档`
  }
  if (d.aiReason) return d.aiReason
  const top = Math.max(0.45 * f.due, 0.35 * f.importance, 0.12 * f.quick * 2.2)
  if (t.dueAt && top === 0.45 * f.due && f.due >= 0.4) return `${fmtDue(t.dueAt, now)} 截止`
  if ((d.priority ?? 2) === 1) return '高优先级'
  if (f.quick >= 0.6) return `只要 ${minutesOf(t)} 分钟，先清掉`
  if (t.dueAt) return `${fmtDue(t.dueAt, now)} 截止`
  return '没有截止时间，按重要度排'
}

/** 在 [cursor, …) 里找第一个放得下 minutes 的空档（避开午休、固定事项、下班时间） */
function place(cursor: number, minutes: number, busy: [number, number][], cfg: ScheduleConfig): [number, number] {
  let t = cursor
  for (let guard = 0; guard < 400; guard++) {
    const d = new Date(t)
    if (!cfg.workdays.includes(d.getDay())) {
      t = nextWorkday(t, cfg)
      continue
    }
    const open = dayStartOf(t, cfg.dayStart)
    const close = dayStartOf(t, cfg.dayEnd)
    if (t < open) t = open
    const end = t + minutes * 60_000
    if (end > close) {
      t = nextWorkday(t, cfg)
      continue
    }
    if (cfg.lunch) {
      const ls = dayStartOf(t, cfg.lunch[0])
      const le = dayStartOf(t, cfg.lunch[1])
      if (t < le && end > ls) {
        t = le
        continue
      }
    }
    const clash = busy.find(([s, e]) => t < e && end > s)
    if (clash) {
      t = clash[1]
      continue
    }
    return [t, end]
  }
  return [t, t + minutes * 60_000]
}

export function schedule(todos: InsightRecord[], now = Date.now(), cfg = DEFAULT_SCHEDULE, manualOrder?: string[]): { items: Planned[]; freeToday: number; movedToToday: number } {
  const open = todos.filter(t => t.status === 'open')
  const scored = open.map(t => {
    const f = factorsOf(t, now)
    return { t, f, score: scoreOf(f) }
  })
  const fixed = scored.filter(x => data(x.t).fixedAt)
  const flex = scored.filter(x => !data(x.t).fixedAt)
  if (manualOrder?.length) {
    const rank = new Map(manualOrder.map((id, i) => [id, i]))
    flex.sort((a, b) => (rank.get(a.t.id) ?? 1e6) - (rank.get(b.t.id) ?? 1e6) || b.score - a.score)
  } else {
    flex.sort((a, b) => b.score - a.score || (a.t.dueAt ?? Infinity) - (b.t.dueAt ?? Infinity))
  }

  const busy: [number, number][] = fixed.map(x => {
    const s = data(x.t).fixedAt as number
    return [s, s + minutesOf(x.t) * 60_000]
  })
  // 15 分钟对齐的起点
  let cursor = Math.ceil(now / (15 * 60_000)) * 15 * 60_000
  const todayEnd = dayStartOf(now, 24)
  const items: Planned[] = []
  for (const x of fixed) {
    const s = data(x.t).fixedAt as number
    items.push(build(x, s, s + minutesOf(x.t) * 60_000))
  }
  let movedToToday = 0
  for (const x of flex) {
    // 截止在一周以后、又不重要的事放进「以后再说」，不占今天的时间
    if (!x.t.dueAt && (data(x.t).priority ?? 2) === 3) {
      items.push({ ...build(x, null, null), bucket: 'someday', reason: '不急也没截止，放进以后再说' })
      continue
    }
    const [s, e] = place(cursor, minutesOf(x.t), busy, cfg)
    busy.push([s, e])
    // 严格按优先级先后排：下一项从这一项结束之后开始
    cursor = e
    if (x.t.dueAt && x.t.dueAt < now && s < todayEnd) movedToToday++
    items.push(build(x, s, e))
  }
  // 当天剩余空闲
  let freeToday = 0
  {
    const close = dayStartOf(now, cfg.dayEnd)
    const start = Math.max(Math.ceil(now / (15 * 60_000)) * 15 * 60_000, dayStartOf(now, cfg.dayStart))
    if (cfg.workdays.includes(new Date(now).getDay()) && close > start) {
      const lunch = cfg.lunch ? Math.max(0, Math.min(close, dayStartOf(now, cfg.lunch[1])) - Math.max(start, dayStartOf(now, cfg.lunch[0]))) : 0
      const used = items.filter(i => i.start && i.start < todayEnd).reduce((s, i) => s + Math.max(0, Math.min(close, i.end!) - Math.max(start, i.start!)), 0)
      freeToday = Math.max(0, close - start - lunch - used) / 60_000
    }
  }
  items.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || b.score - a.score)
  return { items, freeToday, movedToToday }

  function build(x: { t: InsightRecord; f: ReturnType<typeof factorsOf>; score: number }, start: number | null, end: number | null): Planned {
    const today = dayStartOf(now, 0)
    let bucket: Bucket = 'someday'
    if (start != null) {
      const day = Math.round((dayStartOf(start, 0) - today) / D)
      bucket = day <= 0 ? (x.t.dueAt && x.t.dueAt < now ? 'overdue' : 'today') : day === 1 ? 'tomorrow' : 'later'
    }
    return {
      id: x.t.id,
      todo: x.t,
      score: x.score,
      factors: x.f,
      bucket,
      start,
      end,
      minutes: minutesOf(x.t),
      reason: reasonOf(x.t, x.f, now, start),
      atRisk: !!(x.t.dueAt && end && end > x.t.dueAt && x.t.dueAt > now)
    }
  }
}

/**
 * 快速添加的自然语言解析：「明天下午3点 给王小明回电话 30分钟 !」
 * 识别 今天/明天/后天/周X、上午/下午 N 点(半)、HH:MM、N 分钟/小时、! 或「重要」= 高优先级
 */
export function parseQuickAdd(input: string, now = Date.now()): { title: string; dueAt: number | null; minutes?: number; priority?: 1 | 2 | 3; fixedAt?: number | null } {
  let s = ` ${input.trim()} `
  let day: number | null = null
  let hour: number | null = null
  let minute = 0
  let minutes: number | undefined
  let priority: 1 | 2 | 3 | undefined
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = s.match(re)
    if (m) {
      fn(m)
      s = s.replace(m[0], ' ')
    }
  }
  take(/(今天|明天|后天)/, m => (day = { 今天: 0, 明天: 1, 后天: 2 }[m[1] as '今天'] ?? 0))
  take(/(下?周|星期)([一二三四五六日天])/, m => {
    const target = '日一二三四五六'.indexOf(m[2] === '天' ? '日' : m[2])
    const cur = new Date(now).getDay()
    let diff = (target - cur + 7) % 7
    if (m[1] === '下周') diff += 7
    day = diff || 7
  })
  take(/(上午|早上|中午|下午|晚上)?\s*(\d{1,2})[点:：](半|(\d{1,2})分?)?/, m => {
    let h = Number(m[2])
    if ((m[1] === '下午' || m[1] === '晚上') && h < 12) h += 12
    hour = h
    minute = m[3] === '半' ? 30 : Number(m[4] ?? 0)
  })
  take(/(\d+(?:\.\d+)?)\s*(分钟|min|小时|h)/i, m => (minutes = Math.round(Number(m[1]) * (/小时|h/i.test(m[2]) ? 60 : 1))))
  take(/(!|！|重要|紧急)/, () => (priority = 1))
  const title = s.replace(/\s+/g, ' ').trim()
  let dueAt: number | null = null
  let fixedAt: number | null = null
  if (day !== null || hour !== null) {
    const d = new Date(now)
    d.setDate(d.getDate() + (day ?? 0))
    d.setHours(hour ?? 18, hour !== null ? minute : 0, 0, 0)
    if (hour !== null) fixedAt = d.getTime()
    dueAt = d.getTime()
  }
  return { title: title || input.trim(), dueAt, minutes, priority, fixedAt }
}
