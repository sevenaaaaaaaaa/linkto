import type { LifeCategory, LifeData } from './types'

/**
 * 生活档案 · 主进程与渲染端共用的常量与纯函数（类别、默认提醒、循环滚动、编号脱敏、紧急度）。
 * 只依赖类型，便于独立打包做单测。
 */

export const DAY_MS = 864e5

export const LIFE_CATEGORIES: LifeCategory[] = ['id-document', 'insurance', 'vehicle', 'membership', 'domain', 'warranty', 'contract', 'housing', 'tax', 'health', 'education', 'card', 'other']

export const LIFE_CATEGORY_LABEL: Record<LifeCategory, string> = {
  'id-document': '证件',
  insurance: '保险',
  vehicle: '车辆',
  membership: '会员',
  domain: '域名 / 主机',
  warranty: '保修',
  contract: '合同',
  housing: '住房',
  tax: '税务',
  health: '健康',
  education: '教育',
  card: '银行卡',
  other: '其他'
}

/** 类别说明（空类别的「手动添加」提示 / 空状态） */
export const LIFE_CATEGORY_HINT: Record<LifeCategory, string> = {
  'id-document': '护照、身份证、驾驶证、签证、通行证的有效期',
  insurance: '车险、医疗险、意外险、家财险的续保日',
  vehicle: '机动车年检、保养、检验有效期',
  membership: '健身房、会员年卡、俱乐部的到期与年费',
  domain: '域名、SSL 证书、云主机的续费日',
  warranty: '家电、数码产品的保修截止',
  contract: '服务合同、协议的到期与续签',
  housing: '租房合同、物业费、供暖费',
  tax: '个税汇算、纳税申报截止',
  health: '体检、复查、疫苗与预约',
  education: '学费、报名与注册截止',
  card: '信用卡年费、卡片到期换卡',
  other: '其他定期要办的事'
}

/** 默认提前几天提醒（护照常需提前半年） */
export const DEFAULT_REMIND_DAYS: Record<LifeCategory, number[]> = {
  'id-document': [180, 60, 30],
  insurance: [30, 7, 1],
  vehicle: [30, 7, 1],
  membership: [14, 3],
  domain: [30, 7, 1],
  warranty: [14, 3],
  contract: [30, 7, 1],
  housing: [30, 7, 1],
  tax: [14, 3, 1],
  health: [3, 1],
  education: [14, 3, 1],
  card: [30, 7],
  other: [14, 3, 1]
}

/** 建议提前多少天开始办（actionFrom = 到期日 − N 天） */
export const DEFAULT_LEAD_DAYS: Record<LifeCategory, number> = {
  'id-document': 90,
  insurance: 30,
  vehicle: 30,
  membership: 14,
  domain: 30,
  warranty: 14,
  contract: 30,
  housing: 30,
  tax: 14,
  health: 1,
  education: 14,
  card: 30,
  other: 14
}

/** 证件里护照 / 签证 / 居留许可要更早（很多国家要求剩余有效期 ≥ 6 个月） */
export function leadDaysOf(category: LifeCategory, subject?: string | null): number {
  if (category === 'id-document' && /(护照|passport|签证|visa|居留|residence)/i.test(subject ?? '')) return 180
  return DEFAULT_LEAD_DAYS[category] ?? 14
}

/** 默认循环：保单 / 年检 / 域名 / 会员 / 税务 / 体检 / 年费 / 租约按年 */
export function defaultRepeat(category: LifeCategory): LifeData['repeat'] {
  return ['insurance', 'vehicle', 'domain', 'membership', 'tax', 'health', 'card', 'housing'].includes(category) ? { every: 'year', interval: 1 } : null
}

export const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export const daysUntil = (t: number, now = Date.now()) => Math.round((startOfDay(t) - startOfDay(now)) / DAY_MS)

/** 按循环往后推一期（月末对齐：1/31 + 1 月 = 2/28） */
export function addRepeat(t: number, repeat: NonNullable<LifeData['repeat']>): number {
  const d = new Date(t)
  const n = Math.max(1, Math.round(repeat.interval || 1))
  const day = d.getDate()
  if (repeat.every === 'year') d.setFullYear(d.getFullYear() + n)
  else d.setMonth(d.getMonth() + n)
  // setMonth 溢出（31 号 → 下月 1/2/3 号）时退回到上月最后一天
  if (d.getDate() !== day) d.setDate(0)
  return d.getTime()
}

/** 滚到「晚于 after」的下一期（续期成功 / 标记已办妥后用） */
export function rollForward(t: number, repeat: NonNullable<LifeData['repeat']>, after: number): number {
  let next = addRepeat(t, repeat)
  for (let i = 0; i < 240 && next <= after; i++) next = addRepeat(next, repeat)
  return next
}

/** 建议开始办理的日期 */
export function actionFromOf(expiresAt: number | null | undefined, category: LifeCategory, subject?: string | null): number | null {
  if (!expiresAt) return null
  return startOfDay(expiresAt - leadDaysOf(category, subject) * DAY_MS)
}

export function repeatLabel(r: LifeData['repeat']): string {
  if (!r) return '不循环'
  const n = Math.max(1, r.interval || 1)
  if (r.every === 'year') return n === 1 ? '每年' : `每 ${n} 年`
  return n === 1 ? '每月' : `每 ${n} 个月`
}

/** 提醒天数：去重、去非法值、降序，最多 6 个 */
export function normRemindDays(v: unknown, category: LifeCategory): number[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，\s]+/) : []
  const out = [...new Set(list.map(x => Math.round(Number(x))).filter(n => Number.isFinite(n) && n >= 0 && n <= 730))].sort((a, b) => b - a).slice(0, 6)
  return out.length ? out : [...(DEFAULT_REMIND_DAYS[category] ?? [14, 3, 1])]
}

// ---------------------------------------------------------------- 敏感编号

/** 身份证 18 位 / 15 位、护照 / 通行证号、银行卡号：替换成只留尾号 */
const SENSITIVE_RE = /(?<![0-9A-Za-z])(\d{17}[\dXx]|\d{15}|[EeGgDdSsPpHhMmKkCc]\d{8}|[A-Z]{1,2}\d{7,9}|\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7})(?![0-9A-Za-z])/g

/** 一段自由文本里的完整证件号 / 卡号 → ****尾号（标题、备注、对象写库前都过一遍） */
export function scrubSensitive(text: string | null | undefined): string {
  return String(text ?? '').replace(SENSITIVE_RE, m => {
    const digits = m.replace(/[ -]/g, '')
    // 日期 / 金额样式的长数字（如 20261018）不算：8 位纯数字以下不处理
    if (/^\d+$/.test(digits) && digits.length < 12) return m
    return `****${digits.slice(-4)}`
  })
}

/**
 * 编号只存用户可见的部分：证件 / 银行卡只留尾号 4 位；其他编号超过 10 位只留后 6 位。
 * 已经是 ****1234 这种形式的保持不变。
 */
export function maskReference(ref: string | null | undefined, category: LifeCategory): string | null {
  const raw = String(ref ?? '').replace(/\s+/g, '').trim()
  if (!raw) return null
  if (/^[*•…]+/.test(raw)) return raw.slice(0, 16)
  const tail = raw.replace(/[^0-9A-Za-z]/g, '')
  if (!tail) return null
  if (category === 'id-document' || category === 'card') return `****${tail.slice(-4).toUpperCase()}`
  if (tail.length > 10) return `…${tail.slice(-6).toUpperCase()}`
  return raw.slice(0, 24)
}

// ---------------------------------------------------------------- 紧急度

export type LifeUrgency = 'overdue' | 'soon' | 'act' | 'later' | 'done' | 'undated'

/** overdue 已过期；soon 30 天内到期；act 已到建议办理期；later 还早；done 已办妥；undated 没有日期 */
export function lifeUrgency(rec: { status: string; dueAt: number | null; data: Pick<LifeData, 'actionFrom' | 'expiresAt'> }, now = Date.now()): LifeUrgency {
  if (rec.status === 'done') return 'done'
  const t = rec.dueAt ?? rec.data.expiresAt ?? null
  if (!t) return 'undated'
  const n = daysUntil(t, now)
  if (n < 0) return 'overdue'
  if (n <= 30) return 'soon'
  if (rec.data.actionFrom && startOfDay(rec.data.actionFrom) <= startOfDay(now)) return 'act'
  return 'later'
}

/** 常见生活事务里「没找到」的提示（Agent 体检 / 类别页用）：按类别是否出现过 */
export const COMMON_EXPECTED: { category: LifeCategory; label: string; test: RegExp }[] = [
  { category: 'id-document', label: '护照 / 身份证有效期', test: /(护照|身份证|passport|id)/i },
  { category: 'insurance', label: '车险续保', test: /(车险|交强|商业险|auto|car|motor)/i },
  { category: 'insurance', label: '医疗 / 意外保险', test: /(医疗|意外|重疾|健康|health|medical|accident)/i },
  { category: 'vehicle', label: '机动车年检', test: /(年检|年审|检验|inspection|mot)/i },
  { category: 'tax', label: '个税年度汇算', test: /(个税|所得税|汇算|tax)/i },
  { category: 'health', label: '年度体检', test: /(体检|check|physical)/i }
]

/** 预筛（渲染端阅读页也用）：主题 + 正文开头像不像到期 / 续期类事务 */
export const LIFE_HINT_RE =
  /(到期|过期|有效期|续保|续费|续期|续签|续租|年检|年审|换证|换领|期满|保修|质保|延保|汇算|纳税申报|体检|复查|学费|年费|expir|renewal|renew(s|ed)?\b|valid (until|through|thru)|warranty|tax (return|filing)|annual fee|appointment)/i

const LIFE_OBJECT_RE =
  /(护照|身份证|驾驶证|驾照|签证|通行证|居留|保险|保单|续保|年检|年审|域名|证书|主机|会员|年卡|保修|质保|延保|合同|租约|租房|物业|个税|汇算|纳税|体检|学费|信用卡|passport|visa|insurance|policy|domain|ssl|hosting|membership|warranty|lease|tenancy|tax|licen[cs]e|inspection)/i

/** 阅读页是否值得给「加入生活档案」：既有到期 / 续期类动词，又有生活事务的对象 */
export function looksLifeHint(text: string): boolean {
  const t = String(text ?? '').slice(0, 4000)
  return LIFE_HINT_RE.test(t) && LIFE_OBJECT_RE.test(t)
}
