/**
 * AI 抽取结果（LIFE_EXTRACT）→ 生活事务候选。纯函数：AI 只补启发式拿不准的部分，
 * 字段逐一校验——日期 / 金额 / 编号必须在原文里出现过（防编造），否则回退到启发式结果。
 */
import type { LifeCategory } from '../../shared/types'
import { defaultRepeat, LIFE_CATEGORIES, maskReference, scrubSensitive } from '../../shared/life'
import { findAmounts, findDates } from '../finance/detect'
import type { LifeCandidate, LifeEvent } from './detect'

const EVENTS: LifeEvent[] = ['notice', 'renewed', 'appointment', 'expired']

const str = (v: unknown, max = 60): string | null => {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t && t.toLowerCase() !== 'null' ? t.slice(0, max) : null
}

export function jsonFromText(text: string): unknown {
  const cleaned = String(text ?? '').replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('AI 未返回 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

/** AI 给的 YYYY-MM-DD 必须对应原文里出现过的某个日期（同年同月同日） */
export function dateInText(v: unknown, hay: string, base: number): number | null {
  const s = str(v, 20)
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  const hit = findDates(hay, base).find(x => {
    const t = new Date(x.ts)
    return t.getFullYear() === y && t.getMonth() + 1 === m && t.getDate() === d
  })
  return hit ? hit.ts : null
}

/** AI 结果与启发式合并；AI 判定不是生活事务且启发式也没把握时返回 null */
export function lifeFromAi(raw: unknown, h: LifeCandidate | null, hay: string, base: number): LifeCandidate | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (r.isLife === false) return h && h.confidence >= 0.7 && h.expiresAt ? h : null
  const category = (LIFE_CATEGORIES as string[]).includes(String(r.category)) ? (r.category as LifeCategory) : h?.category
  if (!category) return null
  const event = EVENTS.includes(r.event as LifeEvent) ? (r.event as LifeEvent) : h?.event ?? 'notice'
  const expiresAt = dateInText(r.expiresAt, hay, base) ?? h?.expiresAt ?? null
  const amountRaw = typeof r.amount === 'number' ? r.amount : typeof r.amount === 'string' ? Number(r.amount.replace(/[^\d.]/g, '')) : NaN
  const amountOk = Number.isFinite(amountRaw) && amountRaw > 0 && findAmounts(hay).some(a => Math.abs(a.amount - amountRaw) < 0.005)
  const currency = (str(r.currency, 3) ?? '').toUpperCase()
  // 编号：去掉非字母数字后必须在原文里出现过；写库前只留尾号
  const refRaw = str(r.reference, 40)
  const refOk = !!refRaw && refRaw.replace(/[^0-9A-Za-z]/g, '').length >= 4 && hay.replace(/[^0-9A-Za-z]/g, '').toUpperCase().includes(refRaw.replace(/[^0-9A-Za-z]/g, '').toUpperCase())
  const repeat = r.repeat === 'year' ? ({ every: 'year', interval: 1 } as const) : r.repeat === 'month' ? ({ every: 'month', interval: 1 } as const) : r.repeat === 'none' ? null : h?.repeat ?? defaultRepeat(category)
  const subject = scrubSensitive(str(r.subject, 30) ?? h?.subject ?? '').slice(0, 60)
  const provider = str(r.provider, 40)
  return {
    category,
    event,
    subject: subject || h?.subject || '生活事务',
    provider: provider && !provider.includes('@') ? provider : h?.provider ?? null,
    domain: h?.domain ?? null,
    expiresAt,
    amount: amountOk ? Math.round(amountRaw * 100) / 100 : h?.amount ?? null,
    currency: amountOk ? (/^[A-Z]{3}$/.test(currency) ? currency : 'CNY') : h?.currency ?? null,
    reference: refOk ? maskReference(refRaw, category) : h?.reference ?? null,
    repeat,
    confidence: Math.max(h?.confidence ?? 0, expiresAt ? 0.75 : 0.5),
    uncertain: !expiresAt,
    reason: `${h ? `${h.reason}；` : ''}AI 补充`
  }
}
