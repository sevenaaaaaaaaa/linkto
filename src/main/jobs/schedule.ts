/**
 * 调度计算（纯函数，无 Electron 依赖，可单测）：下次运行时间、是否到期、错过补跑、空闲等待、每日额度。
 * 时间一律用本地时区（「每天 08:00」指用户所在时区的 08:00）。
 */

export type JobCadence =
  /** 距上次运行满 ms 毫秒（从没跑过 = 立即） */
  | { kind: 'every'; ms: number }
  /** 每天 at（HH:MM）之后首次 */
  | { kind: 'daily'; at: string }
  /** 每周 weekday（0=周日）at 之后首次 */
  | { kind: 'weekly'; weekday: number; at: string }

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六']

/** 'HH:MM' → 当天的分钟数；非法返回 null */
export function parseAt(at: string | undefined | null): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 某个时刻所在那天的 at 时刻 */
export function slotOfDay(t: number, at: string): number {
  const d = new Date(t)
  const mins = parseAt(at) ?? 0
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0)
  return d.getTime()
}

/** 某个时刻所在那一周（周日起）weekday 的 at 时刻 */
export function slotOfWeek(t: number, weekday: number, at: string): number {
  const d = new Date(slotOfDay(t, at))
  d.setDate(d.getDate() - d.getDay() + (((weekday % 7) + 7) % 7))
  return d.getTime()
}

function addDays(t: number, n: number): number {
  const d = new Date(t)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

/**
 * 下一次应运行的时刻。返回值 ≤ now 表示已到期（含错过的：休眠、关机、离线期间没跑的会立即补一次，
 * 但只补一次——每天的任务错过三天也只跑一轮，不会连跑三次）。
 */
export function nextRunAt(c: JobCadence, lastRunAt: number | null, now: number): number {
  if (c.kind === 'every') return lastRunAt == null ? now : lastRunAt + Math.max(60_000, c.ms)
  if (c.kind === 'daily') {
    const today = slotOfDay(now, c.at)
    if (lastRunAt == null) return today
    // 今天的时刻已跑过 → 明天；否则今天（已过 = 到期补跑）
    return lastRunAt >= today ? addDays(today, 1) : today
  }
  const thisWeek = slotOfWeek(now, c.weekday, c.at)
  if (lastRunAt == null) return thisWeek
  if (lastRunAt >= thisWeek) return addDays(thisWeek, 7)
  return thisWeek
}

/** 叠加「稍后重试」（离线跳过 / 出错退避）后的下次运行时刻 */
export function effectiveNextRun(c: JobCadence, lastRunAt: number | null, retryAfter: number | null, now: number): number {
  const n = nextRunAt(c, lastRunAt, now)
  return retryAfter && retryAfter > n ? retryAfter : n
}

export function isDue(c: JobCadence, lastRunAt: number | null, retryAfter: number | null, now: number): boolean {
  return effectiveNextRun(c, lastRunAt, retryAfter, now) <= now
}

/**
 * 偏好空闲时运行的任务：到期后用户正忙（系统空闲不足 minIdleSec 秒）就再等等，
 * 但最多等 maxDelayMs（避免一直忙就永远不跑）。
 */
export function shouldWaitForIdle(dueAt: number, now: number, idleSec: number, opts: { minIdleSec?: number; maxDelayMs?: number } = {}): boolean {
  const minIdle = opts.minIdleSec ?? 60
  const maxDelay = opts.maxDelayMs ?? 90 * 60_000
  if (idleSec >= minIdle) return false
  return now - dueAt < maxDelay
}

/** 出错退避：连续失败 n 次后的重试间隔（5 分钟起，翻倍，最多 6 小时） */
export function backoffMs(failures: number): number {
  return Math.min(6 * HOUR_MS, 5 * 60_000 * 2 ** Math.max(0, failures - 1))
}

/** 人话频率 */
export function cadenceLabel(c: JobCadence): string {
  if (c.kind === 'every') {
    if (c.ms % DAY_MS === 0) return c.ms === DAY_MS ? '每天' : `每 ${c.ms / DAY_MS} 天`
    if (c.ms % HOUR_MS === 0) return c.ms === HOUR_MS ? '每小时' : `每 ${c.ms / HOUR_MS} 小时`
    return `每 ${Math.round(c.ms / 60_000)} 分钟`
  }
  if (c.kind === 'daily') return `每天 ${c.at}`
  return `每周${WEEK_CN[((c.weekday % 7) + 7) % 7]} ${c.at}`
}

/** 技能的 schedule 字段 → 调度频率 */
export function skillCadence(s: { every: 'hour' | 'day' | 'week'; at?: string; weekday?: number } | null | undefined): JobCadence | null {
  if (!s) return null
  const at = parseAt(s.at) != null ? (s.at as string) : '09:00'
  if (s.every === 'hour') return { kind: 'every', ms: HOUR_MS }
  if (s.every === 'day') return { kind: 'daily', at }
  if (s.every === 'week') return { kind: 'weekly', weekday: typeof s.weekday === 'number' ? s.weekday : 1, at }
  return null
}

// ---------------------------------------------------------------- 每日额度

/** 本地日期键 YYYY-MM-DD */
export function dayKey(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface DailyUsage {
  day: string
  count: number
}

/** 今天已用（跨天自动归零） */
export function usedToday(u: DailyUsage | null | undefined, now: number): number {
  return u && u.day === dayKey(now) ? Math.max(0, u.count) : 0
}

/** 今天剩余额度；limit ≤ 0 视为不允许 */
export function budgetLeft(u: DailyUsage | null | undefined, limit: number, now: number): number {
  return Math.max(0, Math.floor(limit) - usedToday(u, now))
}

/** 记一次用量（跨天从 0 开始） */
export function consume(u: DailyUsage | null | undefined, now: number, n = 1): DailyUsage {
  return { day: dayKey(now), count: usedToday(u, now) + n }
}

/** 一轮补扫应回看的时间窗：至少 minMs（默认 2 小时），离上次运行更久（离线 / 休眠）就补到上次运行前一点，最多 maxMs */
export function sweepWindow(lastRunAt: number | null, now: number, minMs = 2 * HOUR_MS, maxMs = 2 * DAY_MS): number {
  if (lastRunAt == null) return minMs
  return Math.min(maxMs, Math.max(minMs, now - lastRunAt + 10 * 60_000))
}
