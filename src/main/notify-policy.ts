/**
 * 新邮件通知的纯决策逻辑（无 Electron / DB 依赖，可单独做单元测试）。
 * sync-engine 用 isNotifiableArrival 判断「这封是不是真正新到的邮件」，
 * Notifier 用 decideNotify / inQuietHours / planBurst 决定「要不要弹、怎么弹」。
 */
import type { MailBundle, MailSection, NotificationSettings, QuietHours } from '@shared/types'

/** 真实到达后多久内仍值得通知（Bridge 延迟 / 睡眠唤醒补拉都在此窗口内） */
export const ARRIVAL_MAX_AGE_MS = 24 * 3600_000
/** 突发合并：窗口内超过 BURST_MAX 封即合并成一条汇总通知 */
export const BURST_WINDOW_MS = 10_000
export const BURST_MAX = 3

export interface ArrivalInput {
  /** 本次是否新插入（重复抓取不算） */
  inserted: boolean
  /** 是否落在收件箱 */
  inbox: boolean
  /** 增量抓取（非首次同步 / 历史回填） */
  arrival: boolean
  seen: boolean
  /** Screener 待审 / 已拒发件人 */
  held: boolean
  /** 邮件时间（internalDate） */
  date: number
  now: number
  maxAgeMs?: number
}

/** 是否是一封「真正新到达、值得提醒」的邮件——由增量到达驱动，而不是 internalDate 是否在 2 分钟内 */
export function isNotifiableArrival(a: ArrivalInput): boolean {
  if (!a.inserted || !a.inbox || !a.arrival) return false
  if (a.seen || a.held) return false
  // 时钟偏差导致 date 略晚于 now 时 age 为负，视为刚到
  const age = a.now - a.date
  return age <= (a.maxAgeMs ?? ARRIVAL_MAX_AGE_MS)
}

/** "HH:MM" → 当天分钟数；非法返回 null */
export function parseHm(s: string | undefined | null): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 是否处于免打扰时段（支持跨午夜，如 22:00 → 08:00；start === end 视为未设置） */
export function inQuietHours(q: QuietHours | undefined | null, at: Date): boolean {
  if (!q || !q.enabled) return false
  const start = parseHm(q.start)
  const end = parseHm(q.end)
  if (start === null || end === null || start === end) return false
  const cur = at.getHours() * 60 + at.getMinutes()
  return start < end ? cur >= start && cur < end : cur >= start || cur < end
}

export interface NotifyCandidate {
  accountId: string
  /** 启发式 / AI 分类 */
  category: string
  /** 邮件理解结果（AI 未就绪时用启发式），可缺省 */
  insight?: { section: MailSection; bundle: MailBundle | null } | null
  /** 稍后处理到期时间；未来时间表示仍在 snooze 中 */
  snoozedUntil?: number | null
}

export type NotifySkipReason = 'disabled' | 'account-muted' | 'quiet-hours' | 'snoozed' | 'screener' | 'smart-filtered'

export type NotifyDecision = { notify: true; silent: boolean } | { notify: false; reason: NotifySkipReason }

/** 智能通知：个人邮件或「需要你处理」才打扰；订阅 / 系统通知 / 待审发件人一律不打扰 */
export function passesSmart(c: NotifyCandidate): boolean {
  const bundle = c.insight?.bundle ?? null
  if (bundle === 'newsletter' || bundle === 'notification' || bundle === 'screener') return false
  if (c.insight?.section === 'bundle') return false
  return c.category === 'personal' || c.insight?.section === 'act'
}

/**
 * 按通知设置决定是否弹出。force（规则「通知我」/ 测试通知）跳过全部过滤，只保留声音设置。
 */
export function decideNotify(s: NotificationSettings, c: NotifyCandidate, now: Date, force = false): NotifyDecision {
  const per = s.perAccount?.[c.accountId]
  const silent = !s.sound || per?.sound === 'silent'
  if (force) return { notify: true, silent }
  if (!s.enabled) return { notify: false, reason: 'disabled' }
  if (per && per.enabled === false) return { notify: false, reason: 'account-muted' }
  if (c.snoozedUntil && c.snoozedUntil > now.getTime()) return { notify: false, reason: 'snoozed' }
  if (c.insight?.bundle === 'screener') return { notify: false, reason: 'screener' }
  if (s.smart && !passesSmart(c)) return { notify: false, reason: 'smart-filtered' }
  if (inQuietHours(s.quietHours, now)) return { notify: false, reason: 'quiet-hours' }
  return { notify: true, silent }
}

/**
 * 突发合并：pending 为本轮待弹数量，recent 为窗口内已弹出的时间戳。
 * 窗口内总量超过 max → 本轮合并成一条汇总通知。
 */
export function planBurst(
  pending: number,
  recent: number[],
  now: number,
  opts: { windowMs?: number; max?: number } = {}
): 'individual' | 'summary' | 'none' {
  if (pending <= 0) return 'none'
  const windowMs = opts.windowMs ?? BURST_WINDOW_MS
  const max = opts.max ?? BURST_MAX
  const inWindow = recent.filter(t => now - t < windowMs).length
  return inWindow + pending > max ? 'summary' : 'individual'
}
