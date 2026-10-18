/**
 * 财务中心 · 主进程与渲染层共用的纯逻辑（无 IO）：
 *  - 状态归一（insights 行 open/done ↔ FinanceStatus）、有效状态（到期未付 → 逾期）
 *  - 订阅成本（月均 / 年化）、周期推断
 *  - 企业对账：发票 ↔ 付款 ↔ 回单自动配对（matchId）、待对账清单、往来台账
 * 只允许 `import type`，便于独立打包做单测。
 */
import type { FinanceCycle, FinanceData, FinanceKind, FinanceStatus } from './types'

export const DAY_MS = 864e5

export interface FinanceItem {
  id: string
  dueAt: number | null
  createdAt: number
  accountId?: string | null
  title?: string
  data: FinanceData
}

export const FINANCE_KIND_LABEL: Record<FinanceKind, string> = {
  bill: '账单',
  subscription: '订阅',
  order: '订单',
  invoice: '发票',
  payment: '付款',
  receipt: '回单',
  refund: '退款'
}

export const FINANCE_STATUS_LABEL: Record<FinanceStatus, string> = {
  pending: '待付',
  paid: '已付',
  overdue: '逾期',
  cancelled: '已取消',
  refunded: '已退款',
  disputed: '有争议'
}

export const FINANCE_CYCLE_LABEL: Record<FinanceCycle, string> = {
  weekly: '每周',
  monthly: '每月',
  quarterly: '每季',
  yearly: '每年',
  once: '一次性'
}

/** insights 行状态：open = 未结清（订阅 = 仍在续费），done = 已结清 / 已取消 */
export function rowStatusOf(d: Pick<FinanceData, 'kind' | 'status'>): 'open' | 'done' {
  if (d.kind === 'subscription') return d.status === 'cancelled' || d.status === 'refunded' ? 'done' : 'open'
  return d.status === 'pending' || d.status === 'overdue' || d.status === 'disputed' ? 'open' : 'done'
}

/** 有效状态：待付且已过应付日 → 逾期（不落库，随时间变化） */
export function effectiveStatus(d: FinanceData, dueAt: number | null, now = Date.now()): FinanceStatus {
  if (d.status === 'pending' && dueAt && dueAt < now && d.kind !== 'subscription') return 'overdue'
  return d.status
}

/** 订阅每年成本（不做汇率换算，按原币种） */
export function annualCost(d: Pick<FinanceData, 'amount' | 'cycle'>): number | null {
  if (d.amount == null) return null
  switch (d.cycle) {
    case 'weekly':
      return d.amount * 52
    case 'monthly':
      return d.amount * 12
    case 'quarterly':
      return d.amount * 4
    case 'yearly':
      return d.amount
    default:
      return null
  }
}

/** 由多次扣费时间推断周期（取相邻间隔的中位数） */
export function inferCycle(times: number[]): FinanceCycle | null {
  const ts = [...new Set(times)].sort((a, b) => a - b)
  if (ts.length < 2) return null
  const gaps = ts.slice(1).map((t, i) => (t - ts[i]) / DAY_MS).filter(g => g >= 3).sort((a, b) => a - b)
  if (!gaps.length) return null
  const g = gaps[Math.floor(gaps.length / 2)]
  if (g >= 5 && g <= 9) return 'weekly'
  if (g >= 25 && g <= 35) return 'monthly'
  if (g >= 80 && g <= 100) return 'quarterly'
  if (g >= 340 && g <= 390) return 'yearly'
  return null
}

/** 一笔款项的「发生时间」：第一步事件 → 付款时间 → 入库时间 */
export function itemAt(it: Pick<FinanceItem, 'createdAt' | 'data'>): number {
  return it.data.events?.[0]?.at ?? it.data.paidAt ?? it.createdAt
}

// ---------------------------------------------------------------- 对账

/** 公司名归一：去掉「有限公司 / Ltd / Inc」等后缀与空白标点 */
export function normParty(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/(有限责任公司|股份有限公司|有限公司|分公司|集团|公司|co\.?,?\s*ltd\.?|ltd\.?|limited|inc\.?|llc|gmbh|corp(oration)?\.?)/g, '')
    .replace(/[\s()（）·.,，「」"'&-]/g, '')
}

export function sameParty(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normParty(a)
  const y = normParty(b)
  if (!x || !y) return false
  if (x === y) return true
  const [s, l] = x.length <= y.length ? [x, y] : [y, x]
  return s.length >= 2 && l.includes(s)
}

const normRef = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

export function refsOf(d: FinanceData): Set<string> {
  const out = new Set<string>()
  for (const r of [d.invoiceNo, d.poNo, d.contractNo, d.orderNo]) {
    const n = normRef(r)
    if (n.length >= 4) out.add(n)
  }
  return out
}

function sharesRef(a: FinanceData, b: FinanceData): boolean {
  const ra = refsOf(a)
  for (const r of refsOf(b)) if (ra.has(r)) return true
  return false
}

const eqAmount = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && Math.abs(a - b) < 0.005 + Math.max(a, b) * 1e-6

/** 参与对账的记录：企业往来的发票 / 付款 / 回单（已删除的不算） */
export function isReconKind(d: FinanceData): boolean {
  return (d.kind === 'invoice' || d.kind === 'payment' || d.kind === 'receipt') && d.business !== false
}

/**
 * 自动配对：同一笔交易的发票 / 付款 / 回单 → 同一个 matchId。
 * 规则：同方向 + 同一对方（或回单没写对方）+（发票号 / PO / 合同号命中，或金额相等且时间窗口内）。
 * 返回每条（未锁定）记录应有的 matchId；锁定的（手动配对 / 拆开过）保持原样，并占住其组。
 */
export function autoMatch(items: FinanceItem[]): Map<string, string | null> {
  const recon = items.filter(it => isReconKind(it.data))
  const result = new Map<string, string | null>()
  const taken = new Set<string>()
  // 锁定的记录：组保持不动
  for (const it of recon) if (it.data.matchLocked) taken.add(it.id)
  const free = recon.filter(it => !it.data.matchLocked)
  const byKind = (k: FinanceKind) => free.filter(it => it.data.kind === k).sort((a, b) => itemAt(a) - itemAt(b))
  const invoices = byKind('invoice')
  const payments = byKind('payment')
  const receipts = byKind('receipt')

  const pickBest = (pool: FinanceItem[], score: (c: FinanceItem) => number): FinanceItem | null => {
    let best: FinanceItem | null = null
    let bestScore = 0
    for (const c of pool) {
      if (taken.has(c.id)) continue
      const s = score(c)
      if (s > bestScore) {
        best = c
        bestScore = s
      }
    }
    return best
  }
  const partyOk = (a: FinanceData, b: FinanceData, loose = false) => sameParty(a.counterparty, b.counterparty) || (loose && (!normParty(a.counterparty) || !normParty(b.counterparty)))

  const payScore = (inv: FinanceItem) => (p: FinanceItem) => {
    if (p.data.direction !== inv.data.direction) return 0
    const ref = sharesRef(inv.data, p.data)
    if (ref) return 100 - Math.abs(itemAt(p) - itemAt(inv)) / DAY_MS / 1000
    if (!partyOk(inv.data, p.data)) return 0
    const gap = (itemAt(p) - itemAt(inv)) / DAY_MS
    if (!eqAmount(inv.data.amount, p.data.amount) || p.data.currency !== inv.data.currency || gap < -45 || gap > 120) return 0
    return 50 - Math.abs(gap) / 10
  }
  const receiptScore = (anchor: FinanceItem) => (r: FinanceItem) => {
    if (r.data.direction !== anchor.data.direction) return 0
    if (sharesRef(anchor.data, r.data)) return 100
    if (!partyOk(anchor.data, r.data, true)) return 0
    // 以发票为锚（没有付款通知）时窗口放宽到与付款相同
    const gap = (itemAt(r) - itemAt(anchor)) / DAY_MS
    const okGap = anchor.data.kind === 'invoice' ? gap >= -45 && gap <= 120 : Math.abs(gap) <= 15
    if (!eqAmount(anchor.data.amount, r.data.amount) || !okGap) return 0
    return 50 - Math.abs(gap) / 10
  }

  const groups: FinanceItem[][] = []
  for (const inv of invoices) {
    if (taken.has(inv.id)) continue
    taken.add(inv.id)
    const g = [inv]
    const pay = pickBest(payments, payScore(inv))
    if (pay) {
      taken.add(pay.id)
      g.push(pay)
    }
    const rec = pickBest(receipts, receiptScore(pay ?? inv))
    if (rec) {
      taken.add(rec.id)
      g.push(rec)
    }
    groups.push(g)
  }
  for (const pay of payments) {
    if (taken.has(pay.id)) continue
    taken.add(pay.id)
    const g = [pay]
    const rec = pickBest(receipts, receiptScore(pay))
    if (rec) {
      taken.add(rec.id)
      g.push(rec)
    }
    groups.push(g)
  }
  for (const r of receipts) if (!taken.has(r.id)) groups.push([r])

  for (const g of groups) {
    const mid = g.length > 1 ? `mt-${g[0].id}`.slice(0, 80) : null
    for (const it of g) result.set(it.id, mid)
  }
  return result
}

export type ReconIssueType = 'missing_invoice' | 'missing_payment' | 'amount_mismatch' | 'missing_receipt'

export const RECON_ISSUE_LABEL: Record<ReconIssueType, string> = {
  missing_invoice: '缺发票',
  missing_payment: '缺付款',
  amount_mismatch: '金额不符',
  missing_receipt: '缺回单'
}

export interface ReconGroup {
  /** matchId；单条记录时为 `solo-<id>` */
  key: string
  matchId: string | null
  counterparty: string
  direction: 'out' | 'in'
  currency: string
  invoices: FinanceItem[]
  payments: FinanceItem[]
  receipts: FinanceItem[]
  at: number
  issues: { type: ReconIssueType; detail: string }[]
}

const sum = (list: FinanceItem[]) => list.reduce((s, it) => s + (it.data.amount ?? 0), 0)
const round2 = (n: number) => Math.round(n * 100) / 100

/** 按 matchId 分组并给出差异（缺发票 / 缺付款 / 金额不符；缺回单仅作提示） */
export function reconGroups(items: FinanceItem[]): ReconGroup[] {
  const recon = items.filter(it => isReconKind(it.data))
  const map = new Map<string, FinanceItem[]>()
  for (const it of recon) {
    const key = it.data.matchId || `solo-${it.id}`
    map.set(key, [...(map.get(key) ?? []), it])
  }
  const out: ReconGroup[] = []
  for (const [key, list] of map) {
    const invoices = list.filter(i => i.data.kind === 'invoice')
    const payments = list.filter(i => i.data.kind === 'payment')
    const receipts = list.filter(i => i.data.kind === 'receipt')
    const head = invoices[0] ?? payments[0] ?? receipts[0]
    const issues: ReconGroup['issues'] = []
    const settledByUser = invoices.length > 0 && invoices.every(i => i.data.status === 'paid' || i.data.status === 'cancelled') && !payments.length && !receipts.length
    if (invoices.length && !payments.length && !receipts.length && !settledByUser) {
      issues.push({ type: 'missing_payment', detail: head.data.direction === 'in' ? '已开票，未见对方付款' : '收到发票，未见付款记录' })
    }
    if (!invoices.length && (payments.length || receipts.length)) {
      issues.push({ type: 'missing_invoice', detail: head.data.direction === 'in' ? '已收款，还没开发票' : '已付款，还没收到发票' })
    }
    const paid = payments.length ? sum(payments) : receipts.length ? sum(receipts) : null
    if (invoices.length && paid != null && invoices.every(i => i.data.amount != null) && Math.abs(sum(invoices) - paid) >= 0.01) {
      issues.push({ type: 'amount_mismatch', detail: `发票 ${round2(sum(invoices))} · 付款 ${round2(paid)} · 差 ${round2(paid - sum(invoices))}` })
    } else if (payments.length && receipts.length && Math.abs(sum(payments) - sum(receipts)) >= 0.01) {
      issues.push({ type: 'amount_mismatch', detail: `付款 ${round2(sum(payments))} · 回单 ${round2(sum(receipts))}` })
    }
    if (payments.length && !receipts.length) issues.push({ type: 'missing_receipt', detail: '未见银行回单' })
    out.push({
      key,
      matchId: list[0].data.matchId ?? null,
      counterparty: (invoices[0] ?? payments[0] ?? receipts[0]).data.counterparty,
      direction: head.data.direction,
      currency: head.data.currency,
      invoices,
      payments,
      receipts,
      at: Math.min(...list.map(itemAt)),
      issues
    })
  }
  return out.sort((a, b) => b.at - a.at)
}

export interface LedgerRow {
  counterparty: string
  /** 币种 → 金额 */
  payable: Record<string, number>
  paid: Record<string, number>
  receivable: Record<string, number>
  received: Record<string, number>
  count: number
  issues: number
  lastAt: number
}

/** 往来台账：按对方公司汇总应付 / 已付 / 应收 / 已收（按币种分列，不换汇） */
export function ledger(items: FinanceItem[], groups = reconGroups(items)): LedgerRow[] {
  const rows: LedgerRow[] = []
  const rowOf = (name: string): LedgerRow => {
    let r = rows.find(x => sameParty(x.counterparty, name))
    if (!r) {
      r = { counterparty: name, payable: {}, paid: {}, receivable: {}, received: {}, count: 0, issues: 0, lastAt: 0 }
      rows.push(r)
    }
    return r
  }
  const add = (bag: Record<string, number>, cur: string, n: number | null | undefined) => {
    if (n == null) return
    bag[cur] = round2((bag[cur] ?? 0) + n)
  }
  for (const g of groups) {
    const r = rowOf(g.counterparty)
    r.issues += g.issues.filter(i => i.type !== 'missing_receipt').length
    for (const it of [...g.invoices, ...g.payments, ...g.receipts]) {
      r.count++
      r.lastAt = Math.max(r.lastAt, itemAt(it))
    }
    const out = g.direction === 'out'
    for (const inv of g.invoices) add(out ? r.payable : r.receivable, inv.data.currency, inv.data.amount)
    const settled = g.payments.length ? g.payments : g.receipts
    for (const p of settled) add(out ? r.paid : r.received, p.data.currency, p.data.amount)
  }
  return rows.sort((a, b) => b.lastAt - a.lastAt)
}
