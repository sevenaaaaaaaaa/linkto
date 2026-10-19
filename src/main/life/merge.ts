/**
 * 生活档案归并 · 纯函数：同一对象（类别 + 对象 + 机构 + 编号）的多封邮件 → 一条事务；
 * 续期成功 → 有新到期日就换成新日期，否则按循环滚到下一期，不循环的标为已办妥。
 * 只依赖类型与纯函数，便于独立打包做单测。
 */
import type { LifeData } from '../../shared/types'
import { actionFromOf, addRepeat, rollForward, DEFAULT_REMIND_DAYS, DAY_MS } from '../../shared/life'
import type { LifeCandidate } from './detect'

export interface LifeRow {
  id: string
  title: string
  /** insights 行状态：open / done / dismissed */
  status: string
  dueAt: number | null
  createdAt: number
  accountId: string | null
  data: LifeData
}

const norm = (s: string | null | undefined) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[\s·•・\-_/（）()【】[\]「」:：,，.。]/g, '')
    .replace(/(有限公司|股份|集团|公司|inc|ltd|llc|co)$/g, '')
const refKey = (s: string | null | undefined) => String(s ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase()

/** 对象相同：完全相同，或一方包含另一方（「护照」⊂「护照（张三）」不算——带持有人的要人名一致） */
function sameSubject(a: string, b: string): boolean {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  if (x === y) return true
  const holder = (s: string) => s.match(/（([^）]+)）|\(([^)]+)\)/)?.slice(1).find(Boolean) ?? null
  const ha = holder(a)
  const hb = holder(b)
  if (ha && hb && ha !== hb) return false
  return (x.length >= 2 && y.includes(x)) || (y.length >= 2 && x.includes(y))
}

function sameProvider(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return true
  return x === y || x.includes(y) || y.includes(x)
}

/** 找这封邮件该并入的事务（没有则 null → 新建） */
export function findLifeMerge(c: Pick<LifeCandidate, 'category' | 'subject' | 'provider' | 'reference'>, rows: LifeRow[]): LifeRow | null {
  const same = rows.filter(r => r.data.category === c.category)
  // 1) 编号命中（保单号 / 尾号 / 合同号）
  const rk = refKey(c.reference)
  if (rk.length >= 4) {
    const hit = same.find(r => refKey(r.data.reference) === rk && sameSubjectLoose(r.data.subject, c.subject))
    if (hit) return hit
  }
  // 2) 同对象 + 同机构（证件 / 银行卡：编号都有且不同的不合并；保单 / 合同续期后编号会变，不拦）
  const strictRef = c.category === 'id-document' || c.category === 'card'
  const hit = same.find(r => {
    const a = refKey(r.data.reference)
    if (strictRef && a.length >= 4 && rk.length >= 4 && a !== rk) return false
    return sameSubject(r.data.subject, c.subject) && sameProvider(r.data.provider, c.provider)
  })
  return hit ?? null
}

/** 编号命中时对象只需大类一致（「车险 · 苏A·12345」与「交强险 · 苏A·12345」都在同一张保单上时也会合） */
function sameSubjectLoose(a: string, b: string): boolean {
  const plate = (s: string) => s.match(/[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z]·?[A-Z0-9]{5,6}/)?.[0]?.replace('·', '') ?? null
  const pa = plate(a)
  const pb = plate(b)
  if (pa && pb) return pa === pb
  return true
}

/** 新建：候选 → LifeData + 标题 + dueAt */
export function newLifeData(c: LifeCandidate, messageId: string, mailDate: number, source: 'heuristic' | 'ai', extra?: { attachmentIds?: string[]; financeId?: string | null }): { title: string; dueAt: number | null; data: LifeData; status: 'open' | 'done' } {
  const now = Date.now()
  let expiresAt = c.expiresAt
  let status: 'open' | 'done' = 'open'
  // 新建时就是「已续期」且只有过去的日期：按循环滚到下一期
  if (c.event === 'renewed' && expiresAt && expiresAt < mailDate && c.repeat) expiresAt = rollForward(expiresAt, c.repeat, mailDate)
  if (c.event === 'renewed' && !expiresAt) status = 'done'
  const data: LifeData = {
    category: c.category,
    subject: c.subject,
    provider: c.provider,
    expiresAt,
    actionFrom: actionFromOf(expiresAt, c.category, c.subject),
    repeat: c.repeat,
    remindDays: [...(DEFAULT_REMIND_DAYS[c.category] ?? [14, 3, 1])],
    reminded: [],
    reference: c.reference,
    amount: c.amount,
    currency: c.amount != null ? c.currency ?? 'CNY' : null,
    messageIds: [messageId],
    attachmentIds: extra?.attachmentIds?.length ? [...new Set(extra.attachmentIds)] : [],
    financeId: extra?.financeId ?? null,
    todoId: null,
    source,
    confidence: c.confidence,
    notes: null,
    updatedAt: now
  }
  return { title: titleOf(c), dueAt: expiresAt, data, status }
}

export function titleOf(c: Pick<LifeCandidate, 'subject' | 'provider' | 'category' | 'event'>): string {
  const verb = c.category === 'health' ? '预约' : c.category === 'tax' ? '申报截止' : c.category === 'education' ? '截止' : c.category === 'vehicle' ? '' : '到期'
  return `${c.subject}${verb ? ` ${verb}` : ''}`.slice(0, 120)
}

/**
 * 并入：补齐机构 / 编号 / 费用，到期日按事件推进：
 *  - renewed：有晚于原到期日的新日期 → 换新；否则有循环 → 滚到下一期；不循环 → 已办妥
 *  - notice / appointment / expired：原来没有日期就用新的；新日期晚于原日期（提醒的是下一期）也换新
 * 返回要写回的 data patch、dueAt、行状态。
 */
export function mergeLife(row: LifeRow, c: LifeCandidate, messageId: string, mailDate: number): { patch: Partial<LifeData>; dueAt: number | null; status: 'open' | 'done' | null } {
  const d = row.data
  const patch: Partial<LifeData> = {}
  const ids = [...new Set([...(d.messageIds ?? []), messageId])]
  patch.messageIds = ids
  if (!d.provider && c.provider) patch.provider = c.provider
  if (c.reference && (!d.reference || (c.event === 'renewed' && c.category !== 'id-document' && c.category !== 'card'))) patch.reference = c.reference
  if (c.amount != null && (d.amount == null || c.event === 'renewed' || c.event === 'notice')) {
    patch.amount = c.amount
    patch.currency = c.currency ?? d.currency ?? 'CNY'
  }
  let expiresAt = row.dueAt ?? d.expiresAt ?? null
  let status: 'open' | 'done' | null = null
  const repeat = d.repeat === undefined ? c.repeat : d.repeat
  if (c.event === 'renewed') {
    if (c.expiresAt && (!expiresAt || c.expiresAt > expiresAt + DAY_MS)) {
      expiresAt = c.expiresAt
      status = 'open'
    } else if (repeat && expiresAt) {
      // 续期成功、邮件里没写新日期：原日期还在未来 30 天以外的，说明已经滚过了（重复通知），不再滚
      if (expiresAt < mailDate + 45 * DAY_MS) expiresAt = rollForward(expiresAt, repeat, Math.max(mailDate, expiresAt))
      status = 'open'
    } else if (!repeat) status = 'done'
  } else if (c.expiresAt) {
    if (!expiresAt) expiresAt = c.expiresAt
    // 新提醒的日期更晚（下一期）：换新；更早的旧通知不回退
    else if (c.expiresAt > expiresAt + DAY_MS && row.status !== 'done') expiresAt = c.expiresAt
    if (row.status === 'done' && c.expiresAt > (d.expiresAt ?? 0) + DAY_MS) {
      expiresAt = c.expiresAt
      status = 'open'
    }
  }
  if (expiresAt !== (row.dueAt ?? d.expiresAt ?? null)) {
    patch.expiresAt = expiresAt
    patch.actionFrom = actionFromOf(expiresAt, d.category, d.subject)
  }
  patch.updatedAt = Date.now()
  return { patch, dueAt: expiresAt, status }
}

/** 标记「已办妥」：循环事务滚到下一期（继续 open），不循环的标 done */
export function completeLife(row: Pick<LifeRow, 'dueAt' | 'data'>, now: number): { expiresAt: number | null; status: 'open' | 'done' } {
  const t = row.dueAt ?? row.data.expiresAt ?? null
  if (row.data.repeat && t) {
    const next = t > now ? addRepeat(t, row.data.repeat) : rollForward(t, row.data.repeat, now)
    return { expiresAt: next, status: 'open' }
  }
  return { expiresAt: t, status: 'done' }
}
