/**
 * AI 抽取结果（FINANCE_EXTRACT）→ 款项候选。纯函数：AI 只补启发式拿不准的部分，
 * 字段逐一校验，编造不出的数值一律回退到启发式结果。
 */
import type { FinanceCycle, FinanceEventKind, FinanceKind, FinanceStatus } from '../../shared/types'
import { rootDomain, type FinanceCandidate, type FinanceMailInput } from './detect'

const KINDS: FinanceKind[] = ['bill', 'subscription', 'order', 'invoice', 'payment', 'receipt', 'refund']
const EVENTS: FinanceEventKind[] = ['billed', 'reminder', 'paid', 'received', 'invoiced', 'refunded', 'overdue', 'ordered', 'shipped', 'in_transit', 'delivered', 'renewed', 'trial', 'price_change', 'cancelled', 'receipt']
const STATUSES: FinanceStatus[] = ['pending', 'paid', 'overdue', 'cancelled', 'refunded']
const CYCLES: FinanceCycle[] = ['weekly', 'monthly', 'quarterly', 'yearly', 'once']

const str = (v: unknown, max = 60): string | null => {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t && t.toLowerCase() !== 'null' ? t.slice(0, max) : null
}

const day = (v: unknown): number | null => {
  const s = str(v, 20)
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const t = new Date(`${s}T23:59:00`).getTime()
  return Number.isFinite(t) ? t : null
}

export function jsonFromText(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('AI 未返回 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

/** AI 结果与启发式合并；AI 判定不是款项且启发式也没把握时返回 null */
export function candidateFromAi(raw: unknown, h: FinanceCandidate | null, input: FinanceMailInput, hay: string): FinanceCandidate | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (r.isFinance === false) return h && h.confidence >= 0.7 ? h : null
  const kind = KINDS.includes(r.kind as FinanceKind) ? (r.kind as FinanceKind) : h?.kind
  if (!kind) return null
  const amountRaw = typeof r.amount === 'number' ? r.amount : typeof r.amount === 'string' ? Number(r.amount.replace(/[^\d.]/g, '')) : NaN
  // 金额必须真的出现在邮件里（防编造）
  const digits = hay.replace(/,/g, '')
  const amountOk = Number.isFinite(amountRaw) && amountRaw > 0 && (digits.includes(String(amountRaw)) || digits.includes(amountRaw.toFixed(2)))
  const currency = (str(r.currency, 3) ?? '').toUpperCase()
  const pick = <T,>(a: T | null | undefined, b: T | null | undefined): T | null => (a ?? b ?? null) as T | null
  const items = Array.isArray(r.items)
    ? (r.items as Record<string, unknown>[])
        .map(i => ({ name: str(i?.name, 60) ?? '', qty: typeof i?.qty === 'number' ? i.qty : undefined, price: typeof i?.price === 'number' && i.price > 0 ? i.price : undefined }))
        .filter(i => i.name)
        .slice(0, 5)
    : []
  const direction = r.direction === 'in' || r.direction === 'out' ? r.direction : h?.direction ?? (kind === 'refund' ? 'in' : 'out')
  const status = STATUSES.includes(r.status as FinanceStatus) ? (r.status as FinanceStatus) : h?.status ?? 'pending'
  const cycle = CYCLES.includes(r.cycle as FinanceCycle) ? (r.cycle as FinanceCycle) : h?.cycle ?? null
  const counterparty = str(r.counterparty, 40)
  return {
    kind,
    event: EVENTS.includes(r.event as FinanceEventKind) ? (r.event as FinanceEventKind) : h?.event ?? 'note',
    direction,
    counterparty: counterparty && !counterparty.includes('@') ? counterparty : h?.counterparty ?? (input.fromName || rootDomain(input.fromAddr) || '未知商家'),
    domain: h?.domain ?? rootDomain(input.fromAddr),
    amount: amountOk ? Math.round(amountRaw * 100) / 100 : h?.amount ?? null,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : h?.currency ?? 'CNY',
    status,
    dueAt: pick(day(r.dueDate), h?.dueAt) ?? (kind === 'subscription' ? day(r.nextRenewal) : null),
    paidAt: status === 'paid' ? h?.paidAt ?? input.date : null,
    periodStart: pick(day(r.periodStart), h?.periodStart),
    periodEnd: pick(day(r.periodEnd), h?.periodEnd),
    category: str(r.category, 12) ?? h?.category ?? null,
    cycle: kind === 'subscription' ? cycle : null,
    nextRenewalAt: kind === 'subscription' ? pick(day(r.nextRenewal), h?.nextRenewalAt) : null,
    trialEndsAt: pick(day(r.trialEnds), h?.trialEndsAt),
    manageUrl: h?.manageUrl ?? null,
    shop: kind === 'order' ? h?.shop ?? counterparty : null,
    orderNo: pick(str(r.orderNo, 40), h?.orderNo),
    items: items.length ? items : h?.items ?? [],
    tracking: pick(str(r.tracking, 30), h?.tracking),
    logistics: h?.logistics ?? (r.event === 'delivered' ? 'delivered' : r.event === 'shipped' ? 'shipped' : r.event === 'in_transit' ? 'in_transit' : kind === 'order' ? 'ordered' : null),
    invoiceNo: pick(str(r.invoiceNo, 40), h?.invoiceNo),
    poNo: pick(str(r.poNo, 40), h?.poNo),
    contractNo: pick(str(r.contractNo, 40), h?.contractNo),
    enterprise: h?.enterprise ?? (kind === 'invoice' || kind === 'receipt'),
    previousAmount: h?.previousAmount ?? null,
    confidence: Math.max(h?.confidence ?? 0, 0.75),
    uncertain: false
  }
}
