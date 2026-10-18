/**
 * 财务归并 · 纯函数：多封邮件 → 一笔款项。
 *  - 账单 → 催缴 → 付款成功 → 发票：同一商家 + 同一账期 / 金额相近 → 一条，状态向前推进
 *  - 订单：订单号 / 运单号命中，或同店铺近期未签收订单 → 一条，物流进度只进不退
 *  - 订阅：同一商家的续费 / 提醒 / 试用 / 调价 / 取消 → 一条，推断周期与下次续费日
 *  - 企业发票 / 付款 / 回单彼此不合并（交给对账配对），只合并重复通知（同号同额）
 * 只允许 `import type`，便于独立打包做单测。
 */
import type { FinanceData, FinanceEvent, FinanceLogistics, FinanceStatus } from '../../shared/types'
import { inferCycle, rowStatusOf, sameParty, DAY_MS } from '../../shared/finance'
import { addCycle, type FinanceCandidate } from './detect'

export interface FinanceRow {
  id: string
  title: string
  /** insights 行状态：open / done / dismissed */
  status: string
  dueAt: number | null
  createdAt: number
  accountId: string | null
  data: FinanceData
}

const closeAmount = (a: number | null | undefined, b: number | null | undefined, tol = 0.01) =>
  a != null && b != null && Math.abs(a - b) <= Math.max(0.01, Math.max(a, b) * tol)

const lastAt = (r: FinanceRow) => r.data.events?.[r.data.events.length - 1]?.at ?? r.createdAt
const firstAt = (r: FinanceRow) => r.data.events?.[0]?.at ?? r.createdAt
const sameDomain = (r: FinanceRow, c: FinanceCandidate) => !!c.domain && r.data.domain === c.domain
const sameMerchant = (r: FinanceRow, c: FinanceCandidate) => sameDomain(r, c) || sameParty(r.data.counterparty, c.counterparty)
const norm = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const eqRef = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && norm(a).length >= 4 && norm(a) === norm(b)

const LOGI_RANK: Record<FinanceLogistics, number> = { ordered: 0, shipped: 1, in_transit: 2, delivered: 3 }

/** 找这封邮件该并入的那笔款项（没有则返回 null → 新建） */
export function findMergeTarget(c: FinanceCandidate, rows: FinanceRow[], mailDate: number): FinanceRow | null {
  const within = (r: FinanceRow, days: number) => Math.abs(mailDate - lastAt(r)) <= days * DAY_MS || Math.abs(mailDate - firstAt(r)) <= days * DAY_MS
  const consumerKinds = new Set(['bill', 'subscription', 'order'])

  // 1) 编号命中：订单号 / 运单号
  if (c.orderNo) {
    const hit = rows.find(r => eqRef(r.data.orderNo, c.orderNo) && (sameMerchant(r, c) || norm(c.orderNo).length >= 8))
    if (hit && (hit.data.kind !== 'invoice' && hit.data.kind !== 'payment' && hit.data.kind !== 'receipt' || hit.data.kind === c.kind)) return hit
  }
  if (c.tracking) {
    const hit = rows.find(r => eqRef(r.data.tracking, c.tracking))
    if (hit) return hit
  }

  // 2) 企业往来：只合并重复通知（同类型 + 同号 / 同额同日）
  if (c.enterprise) {
    const dup = rows.find(r => {
      if (r.data.kind !== c.kind) return false
      if (c.invoiceNo && eqRef(r.data.invoiceNo, c.invoiceNo)) return true
      return sameMerchant(r, c) && closeAmount(r.data.amount, c.amount, 0) && within(r, 3) && (!c.invoiceNo || !r.data.invoiceNo)
    })
    if (dup) return dup
    // 消费类账单的付款 / 发票（如云服务账单的付款成功、开票通知）仍并回账单
    if (c.kind === 'receipt') return null
  }

  // 3) 发票号命中（消费类：账单后的开票通知）
  if (c.invoiceNo) {
    const hit = rows.find(r => eqRef(r.data.invoiceNo, c.invoiceNo) && (r.data.kind === c.kind || consumerKinds.has(r.data.kind)))
    if (hit) return hit
  }

  switch (c.kind) {
    case 'subscription': {
      const subs = rows.filter(r => r.data.kind === 'subscription' && sameMerchant(r, c))
      if (!subs.length) return null
      // 同一商家多个订阅：金额相近者优先
      return subs.find(r => closeAmount(r.data.amount, c.amount, 0.35)) ?? subs.find(r => r.data.amount == null || c.amount == null) ?? subs[0]
    }
    case 'bill': {
      const bills = rows.filter(r => r.data.kind === 'bill' && sameMerchant(r, c))
      return (
        bills.find(r => c.dueAt && r.dueAt && Math.abs(c.dueAt - r.dueAt) <= 10 * DAY_MS) ??
        bills.find(r => c.periodEnd && r.data.periodEnd && Math.abs(c.periodEnd - r.data.periodEnd) <= 5 * DAY_MS) ??
        bills.find(r => (!c.dueAt || !r.dueAt) && closeAmount(r.data.amount, c.amount) && within(r, 25) && (r.data.status !== 'paid' || c.status === 'paid')) ??
        null
      )
    }
    case 'order': {
      if (c.orderNo) return null
      return (
        rows.find(
          r =>
            r.data.kind === 'order' &&
            sameMerchant(r, c) &&
            within(r, 14) &&
            r.data.logistics !== 'delivered' &&
            (c.amount == null || r.data.amount == null || closeAmount(r.data.amount, c.amount)) &&
            (!r.data.orderNo || !c.orderNo)
        ) ?? null
      )
    }
    case 'payment':
    case 'invoice': {
      // 消费类：付款成功 / 发票 → 并回同商家的账单 / 订阅 / 订单
      return (
        rows.find(
          r =>
            consumerKinds.has(r.data.kind) &&
            sameMerchant(r, c) &&
            within(r, r.data.kind === 'subscription' ? 400 : 60) &&
            (c.amount == null || r.data.amount == null || closeAmount(r.data.amount, c.amount, r.data.kind === 'subscription' ? 0.35 : 0.01))
        ) ??
        rows.find(r => r.data.kind === c.kind && sameMerchant(r, c) && closeAmount(r.data.amount, c.amount, 0) && within(r, 3)) ??
        null
      )
    }
    case 'refund': {
      return (
        rows.find(
          r =>
            r.data.kind !== 'refund' &&
            sameMerchant(r, c) &&
            within(r, 90) &&
            ((c.orderNo && eqRef(r.data.orderNo, c.orderNo)) || closeAmount(r.data.amount, c.amount) || (c.amount == null && r.data.kind === 'order'))
        ) ?? null
      )
    }
  }
  return null
}

const STATUS_RANK: Record<FinanceStatus, number> = { pending: 0, overdue: 1, disputed: 1, paid: 2, refunded: 3, cancelled: 3 }

function eventLabel(c: FinanceCandidate): string {
  switch (c.event) {
    case 'billed':
      return '出账'
    case 'reminder':
      return c.kind === 'subscription' ? '续费提醒' : '催缴 / 提醒'
    case 'paid':
      return '付款成功'
    case 'received':
      return '收到款项'
    case 'invoiced':
      return '开具发票'
    case 'refunded':
      return '退款'
    case 'overdue':
      return '逾期 / 扣款失败'
    case 'ordered':
      return '已下单'
    case 'shipped':
      return '已发货'
    case 'in_transit':
      return '派送中'
    case 'delivered':
      return '已签收'
    case 'renewed':
      return '续费扣款'
    case 'trial':
      return '试用'
    case 'price_change':
      return '调价'
    case 'cancelled':
      return '取消续费'
    case 'receipt':
      return '银行回单'
    default:
      return '相关邮件'
  }
}

export function eventOf(c: FinanceCandidate, messageId: string, at: number): FinanceEvent {
  return { at, kind: c.event, amount: c.amount, messageId, label: eventLabel(c) }
}

export function titleFor(c: Pick<FinanceCandidate, 'kind' | 'counterparty' | 'shop' | 'items' | 'invoiceNo' | 'periodEnd' | 'dueAt' | 'direction'> & { monthHint?: number | null }): string {
  const who = c.counterparty || '未知商家'
  switch (c.kind) {
    case 'bill': {
      // 账单月份：主题 / 正文里写的「N 月」优先，其次账期止、应付日
      const m = c.monthHint ?? (c.periodEnd ?? c.dueAt ? new Date((c.periodEnd ?? c.dueAt)!).getMonth() + 1 : null)
      return m ? `${who} ${m} 月账单` : `${who} 账单`
    }
    case 'subscription':
      return who
    case 'order':
      return c.items[0]?.name ? `${c.shop || who} · ${c.items[0].name}` : `${c.shop || who} 订单`
    case 'invoice':
      return c.invoiceNo ? `${who} 发票 ${c.invoiceNo}` : `${who} 发票`
    case 'payment':
      return c.direction === 'in' ? `${who} 来款` : `付款给 ${who}`
    case 'receipt':
      return `回单 · ${who}`
    case 'refund':
      return `${who} 退款`
  }
}

/** 新建一笔款项的数据 */
export function newRecordData(c: FinanceCandidate, messageId: string, mailDate: number, source: 'heuristic' | 'ai' = 'heuristic'): { title: string; dueAt: number | null; data: FinanceData } {
  const data: FinanceData = {
    kind: c.kind,
    direction: c.direction,
    counterparty: c.counterparty,
    domain: c.domain,
    amount: c.amount,
    currency: c.currency,
    status: c.status,
    dueAt: c.dueAt,
    paidAt: c.paidAt,
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    category: c.category,
    cycle: c.kind === 'subscription' ? c.cycle : c.kind === 'order' || c.kind === 'refund' ? 'once' : null,
    manageUrl: c.manageUrl,
    trialEndsAt: c.trialEndsAt,
    shop: c.shop,
    orderNo: c.orderNo,
    items: c.items.length ? c.items : undefined,
    tracking: c.tracking,
    invoiceNo: c.invoiceNo,
    poNo: c.poNo,
    contractNo: c.contractNo,
    matchId: null,
    business: c.kind === 'invoice' || c.kind === 'payment' || c.kind === 'receipt' ? c.enterprise : undefined,
    messageIds: [messageId],
    source,
    confidence: c.confidence,
    logistics: c.logistics,
    previousAmount: c.previousAmount,
    events: [eventOf(c, messageId, mailDate)],
    updatedAt: Date.now()
  }
  return { title: titleFor(c).slice(0, 120), dueAt: c.dueAt, data }
}

/**
 * 把一封邮件并入已有款项：追加 messageId / 事件，补齐缺失字段，状态只向前推进。
 * 用户改过的字段（非空）不覆盖；手动新建的记录不改金额。
 * 返回新的 data / dueAt / 行状态（null = 不变）。
 */
export function mergeInto(row: FinanceRow, c: FinanceCandidate, messageId: string, mailDate: number): { data: FinanceData; dueAt: number | null; rowStatus: 'open' | 'done' | null } {
  const d: FinanceData = { ...row.data, messageIds: [...(row.data.messageIds ?? [])] }
  if (!d.messageIds.includes(messageId)) d.messageIds.push(messageId)
  const events = [...(d.events ?? [])]
  if (!events.some(e => e.messageId === messageId)) events.push(eventOf(c, messageId, mailDate))
  events.sort((a, b) => a.at - b.at)
  d.events = events
  const newest = mailDate >= Math.max(...events.filter(e => e.messageId !== messageId).map(e => e.at), 0)
  const fill = <K extends keyof FinanceData>(k: K, v: FinanceData[K] | null | undefined) => {
    if (v == null || (Array.isArray(v) && !v.length)) return
    if (d[k] == null || (Array.isArray(d[k]) && !(d[k] as unknown[]).length)) d[k] = v as FinanceData[K]
  }
  fill('amount', c.amount)
  if (d.amount != null && c.amount != null && d.amount === c.amount) d.currency = d.currency || c.currency
  else if (row.data.amount == null && c.amount != null) d.currency = c.currency
  fill('orderNo', c.orderNo)
  fill('invoiceNo', c.invoiceNo)
  fill('poNo', c.poNo)
  fill('contractNo', c.contractNo)
  fill('tracking', c.tracking)
  fill('manageUrl', c.manageUrl)
  fill('category', c.category)
  fill('periodStart', c.periodStart)
  fill('periodEnd', c.periodEnd)
  fill('items', c.items.length ? c.items : null)
  fill('shop', c.shop)
  fill('domain', c.domain)
  if (c.trialEndsAt && (!d.trialEndsAt || newest)) d.trialEndsAt = c.trialEndsAt

  let dueAt = row.dueAt
  // —— 状态推进 ——
  if (d.kind === 'subscription') {
    if (c.cycle && !d.cycle) d.cycle = c.cycle
    const charges = events.filter(e => e.kind === 'renewed').map(e => e.at)
    const inferred = inferCycle(charges)
    if (inferred && (!d.cycle || d.cycle === 'once')) d.cycle = inferred
    if (newest) {
      if (c.event === 'cancelled') d.status = 'cancelled'
      else if (c.event === 'refunded') d.status = 'refunded'
      else if (d.status !== 'cancelled' || c.event === 'renewed') {
        if (c.event === 'renewed') {
          d.status = 'paid'
          d.paidAt = c.paidAt ?? mailDate
        } else if (c.event === 'overdue') d.status = 'overdue'
        else if (c.event === 'reminder' || c.event === 'trial' || c.event === 'price_change') d.status = d.status === 'paid' && !c.nextRenewalAt ? 'paid' : 'pending'
      }
      // 调价 / 续费后金额以最新为准（手动建的不改）
      if (c.amount != null && row.data.source !== 'manual' && (c.event === 'renewed' || c.event === 'price_change' || c.event === 'reminder')) {
        if (d.amount != null && Math.abs(d.amount - c.amount) > Math.max(0.01, d.amount * 0.005)) {
          d.previousAmount = c.previousAmount ?? d.amount
          if (c.event !== 'price_change') events.push({ at: mailDate + 1, kind: 'price_change', amount: c.amount, messageId, label: '金额变化' })
        }
        d.amount = c.amount
        d.currency = c.currency
      }
      if (c.previousAmount != null) d.previousAmount = c.previousAmount
      // 下次续费：邮件写明的日期 > 本次扣费 + 周期
      if (c.nextRenewalAt) dueAt = c.nextRenewalAt
      else if (c.event === 'renewed' && d.cycle) dueAt = addCycle(c.paidAt ?? mailDate, d.cycle)
    }
  } else if (d.kind === 'order') {
    if (c.logistics && (!d.logistics || LOGI_RANK[c.logistics] > LOGI_RANK[d.logistics])) d.logistics = c.logistics
    if (c.event === 'refunded') d.status = 'refunded'
    else if (STATUS_RANK[c.status] > STATUS_RANK[d.status] && c.status !== 'cancelled') d.status = c.status
  } else {
    // 账单 / 发票 / 付款：只向前推进（付款 → paid，退款 → refunded）
    let next: FinanceStatus = d.status
    if (c.event === 'paid' || c.event === 'received' || c.event === 'receipt' || (c.kind === 'payment' && c.status === 'paid')) next = 'paid'
    else if (c.event === 'refunded') next = 'refunded'
    else if (c.event === 'overdue' && d.status === 'pending') next = 'overdue'
    if (STATUS_RANK[next] >= STATUS_RANK[d.status]) d.status = next
    if (d.status === 'paid' && !d.paidAt) d.paidAt = c.paidAt ?? mailDate
    if (c.dueAt && (row.dueAt == null || (newest && d.status !== 'paid'))) dueAt = c.dueAt
  }
  d.events = events.sort((a, b) => a.at - b.at)
  d.updatedAt = Date.now()
  const before = row.status === 'dismissed' ? null : rowStatusOf(row.data)
  const after = rowStatusOf(d)
  return { data: d, dueAt, rowStatus: row.status === 'dismissed' ? null : after !== before || row.status !== after ? after : null }
}
