/**
 * 财务识别 · 启发式层（纯函数、无副作用、无 AI）
 *
 * 一封邮件 → 一个「款项候选」：账单 / 订阅 / 电商订单 / 发票 / 付款 / 回单 / 退款，
 * 带金额币种、应付日 / 续费日 / 试用结束、订单号 / 发票号 / PO / 合同号 / 运单号、物流进度、管理订阅链接等。
 * 归并（多封邮件 → 一笔款项）见 merge.ts；本文件只允许 `import type`，便于独立打包做单测。
 */
import type { FinanceCycle, FinanceEventKind, FinanceKind, FinanceLogistics, FinanceStatus } from '../../shared/types'

export interface FinanceMailInput {
  messageId: string
  subject: string
  /** 纯文本正文（可能为空：正文未下载时只有 snippet） */
  text: string
  snippet?: string
  html?: string | null
  fromAddr: string
  fromName: string
  date: number
  /** 这封是本机账户发出的 */
  fromMe?: boolean
  /** List-Unsubscribe 头（管理订阅链接要排除它） */
  listUnsubscribe?: string | null
  isNewsletter?: boolean
  category?: string | null
  /** 邮件理解给出的实体（AI 理解时更准，用来补金额 / 截止） */
  entities?: { kind: string; value: string; label?: string }[]
}

export interface FinanceCandidate {
  kind: FinanceKind
  /** 这封邮件在这笔钱的经过里是哪一步 */
  event: FinanceEventKind
  direction: 'out' | 'in'
  counterparty: string
  domain: string | null
  amount: number | null
  currency: string
  status: FinanceStatus
  dueAt: number | null
  paidAt: number | null
  periodStart: number | null
  periodEnd: number | null
  category: string | null
  cycle: FinanceCycle | null
  /** 订阅：下次续费日 */
  nextRenewalAt: number | null
  trialEndsAt: number | null
  manageUrl: string | null
  shop: string | null
  orderNo: string | null
  items: { name: string; qty?: number; price?: number }[]
  tracking: string | null
  logistics: FinanceLogistics | null
  invoiceNo: string | null
  poNo: string | null
  contractNo: string | null
  /** 企业往来（发票 / 付款 / 回单 / 对账单，参与对账） */
  enterprise: boolean
  /** 订阅调价：调价前金额 */
  previousAmount: number | null
  /** 账单所属月份（主题里的「9月账单」），用于标题 */
  monthHint?: number | null
  /** 0~1 */
  confidence: number
  /** 拿不准（关键词命中但缺金额 / 类型模糊）：AI 可用时值得补一次 */
  uncertain: boolean
}

const DAY = 864e5

// ---------------- 文本准备 ----------------

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&yen;/g, '¥')
    .replace(/&euro;/g, '€')
    .replace(/&pound;/g, '£')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
}

export function bodyOf(input: Pick<FinanceMailInput, 'text' | 'snippet' | 'html'>): string {
  const t = (input.text || '').trim()
  if (t.length > 40) return t.slice(0, 8000)
  if (input.html) return stripHtml(input.html).slice(0, 8000)
  return (t || input.snippet || '').slice(0, 8000)
}

// ---------------- 关键词 ----------------

export const FIN_RE = {
  refund: /(退款(成功|已|到账|已原路|处理完成|申请已通过)|已退款|refund(ed| issued| processed| has been| of)|been refunded)/i,
  orderPlaced: /(下单成功|订单已提交|订单(已)?确认|已下单|已付款.{0,6}订单|订单.{0,6}(已付款|支付成功)|order (confirmation|confirmed|placed|received)|thanks? (you )?for your order|your order (#|no|number|has been placed))/i,
  shipped: /(已发货|发货通知|卖家已发货|包裹已发出|商品已出库|has shipped|have shipped|been shipped|order shipped|dispatched|is on (its|the) way)/i,
  inTransit: /(派送中|正在派送|运输中|配送中|派件中|out for delivery|in transit)/i,
  delivered: /(已签收|签收成功|已送达|已妥投|has been delivered|was delivered|\bdelivered\b)/i,
  orderWord: /(订单|\border\b)/i,
  subStrong: /(自动续费|自动续订|续订|续费成功|续费提醒|订阅|会员续费|会员自动|subscription|renew(al|s|ed)?\b|membership|your plan|billing cycle|recurring)/i,
  trial: /(试用(期)?.{0,8}(即将|将于|将在|还剩|已)?.{0,12}(结束|到期)|免费试用|trial (ends?|will end|expires?|period|is ending)|free trial)/i,
  cancelSub: /(已取消(订阅|自动续费|自动续订|续订|会员)|订阅已取消|已关闭自动续费|不再续费|将不再(自动)?续|will not (be )?renew|won't renew|(subscription|plan|membership) (has been |was )?cancel(l)?ed|cancellation (confirmed|confirmation))/i,
  priceChange: /(价格调整|调价|提价|涨价|价格变更|price (increase|change|update)|new price|pricing (change|update))/i,
  bill: /(账单|应还|还款日|最低还款|缴费|对账单|月结单|电费|水费|燃气费|话费|statement|amount due|payment due|bill is ready|your bill|账期|待支付费用)/i,
  invoice: /(发票|\binvoice\b|tax invoice|增值税|开票)/i,
  payment: /(付款成功|支付成功|扣款成功|已扣款|还款成功|付款通知|收款通知|到账通知|已到账|已收到.{0,14}(付款|款项|货款|汇款)|付款已完成|payment (received|successful|confirmation|confirmed|complete)|we('ve| have) received your payment|thank you for your payment|you paid|your payment of|has been charged|was charged|we charged)/i,
  receipt: /(回单|电子回单|交易回单|银行回单|入账通知|转账成功|汇款成功|收据)/i,
  receiptEn: /\breceipt\b/i,
  overdue: /(已逾期|逾期未(付|还|缴)|逾期\s*\d+\s*天|产生逾期|已过期未付|滞纳金|overdue|past due|payment failed|扣款失败|支付失败|续费失败)/i,
  paidMark: /(已还清|已缴费|缴费成功|已付款|付款成功|支付成功|扣款成功|已扣款|还款成功|续费成功|payment (received|successful|complete)|paid in full|thank you for your payment|has been charged|was charged|you paid|renewed successfully|has been renewed|successfully renewed)/i,
  pendingPay: /(待付款|待支付|未付款|请于.{0,24}前.{0,4}(付款|支付|还款|缴费|续费)|payment due|amount due|awaiting payment|please pay)/i,
  upcoming: /(即将|将于|将在|提醒|还有\s*\d+\s*天|upcoming|will (be )?(renew|charged|billed)|reminder|is due|due (soon|on|by))/i,
  incoming: /(收款通知|收款回单|到账通知|入账|已到账|应收|贷记|向(您|贵司|你)(支付|付款|汇款)|payment received from|you('ve| have) received|we received payment from)/i,
  /** 对方确认收到「我的」付款（从我的角度仍是支出） */
  outConfirm: /(已收到(贵司|您|你)的?.{0,8}(付款|款项|货款|汇款)|收到(贵司|您)的?(付款|汇款)|we('ve| have) received your payment|thank you for your payment)/i,
  enterprise: /(有限公司|股份|集团|Ltd\.?\b|Limited|Inc\.?\b|GmbH|LLC|Co\.,|采购订单|采购单|合同(编)?号|PO[ -]?(No|#|号)|对账|应付|应收|货款|开票|增值税|税号|统一社会信用代码|付款方|收款方|purchase order|remittance)/i,
  marketing: /(限时|特惠|优惠券|折扣|大促|秒杀|新品上市|立即抢购|领券|\bsale\b|% off|discount|promo(tion)?|deal of|coupon|black friday)/i,
  travel: /(机票|航班|酒店|行程单|火车票|高铁|flight|hotel|booking confirmation|itinerary)/i
}

// ---------------- 金额 ----------------

const CUR_MAP: Record<string, string> = {
  'hk$': 'HKD', hkd: 'HKD', 港币: 'HKD', 港元: 'HKD',
  'us$': 'USD', usd: 'USD', $: 'USD', 美元: 'USD',
  's$': 'SGD', sgd: 'SGD',
  'a$': 'AUD', aud: 'AUD',
  'c$': 'CAD', cad: 'CAD',
  '€': 'EUR', eur: 'EUR', 欧元: 'EUR',
  '£': 'GBP', gbp: 'GBP', 英镑: 'GBP',
  jpy: 'JPY', 日元: 'JPY', 円: 'JPY',
  '¥': 'CNY', '￥': 'CNY', rmb: 'CNY', cny: 'CNY', 人民币: 'CNY', 元: 'CNY', 万元: 'CNY'
}

const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)'
const AMOUNT_RE = new RegExp(
  `(HK\\$|US\\$|S\\$|A\\$|C\\$|HKD|USD|SGD|AUD|CAD|EUR|GBP|JPY|RMB|CNY|人民币|¥|￥|\\$|€|£)\\s?(-)?\\s?${NUM}|${NUM}\\s?(万元|元|美元|欧元|港币|港元|英镑|日元|RMB|CNY|USD|EUR|HKD|GBP|JPY|SGD|AUD|CAD)(?![A-Za-z])`,
  'gi'
)

const LABEL_STRONG =
  /(应还金额|本期应还|本期账单金额|应付金额|应付总额|应缴金额|账单金额|实付款?|实际支付|支付金额|付款金额|扣款金额|收款金额|交易金额|入账金额|汇款金额|转账金额|价税合计|发票金额|含税金额|合计|总计|总额|订单金额|订单总额|续费金额|退款金额|金额|amount due|total due|balance due|grand total|order total|amount paid|amount charged|total amount|\btotal\b|charged|you paid|amount|price)[^\n\d]{0,16}$/i
const LABEL_WEAK = /(最低还款|minimum (payment|due)|原价|划线价|优惠|节省|立减|余额|积分|额度|credit limit|subtotal|小计|运费|shipping|税额|\btax\b|折扣|discount|免息|分期)[^\n\d]{0,14}$/i

export interface AmountHit {
  amount: number
  currency: string
  index: number
  score: number
}

/** 找出全部金额（带币种），按语境打分 */
export function findAmounts(hay: string): AmountHit[] {
  const out: AmountHit[] = []
  for (const m of hay.matchAll(AMOUNT_RE)) {
    const sym = (m[1] ?? m[5] ?? '').toLowerCase()
    const neg = !!m[2]
    const raw = (m[3] ?? m[4] ?? '').replace(/,/g, '')
    let n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) continue
    if (sym === '万元') n *= 10000
    // 年份 / 编号误报：无小数、四位整数、紧挨着「年」
    const idx = m.index ?? 0
    const after = hay.slice(idx + m[0].length, idx + m[0].length + 2)
    if (/^年|^月|^日|^号/.test(after)) continue
    const before = hay.slice(Math.max(0, idx - 30), idx)
    let score = 1
    if (LABEL_STRONG.test(before)) score += 3
    if (LABEL_WEAK.test(before)) score -= 3
    if (/[x×*]\s*$/.test(before)) score -= 1
    if (neg) score -= 1
    out.push({ amount: Math.round(n * 100) / 100, currency: CUR_MAP[sym] ?? 'CNY', index: idx, score })
    if (out.length >= 40) break
  }
  return out
}

/** 最可能的「这笔钱」：语境分最高者（同分取先出现的） */
export function pickAmount(hay: string): { amount: number; currency: string; labeled: boolean } | null {
  const hits = findAmounts(hay)
  if (!hits.length) return null
  const best = hits.reduce((a, b) => (b.score > a.score ? b : a))
  if (best.score < 0) return null
  return { amount: best.amount, currency: best.currency, labeled: best.score >= 3 }
}

/** 调价：「由 ¥30 调整为 ¥38」「from $10 to $12」 */
function detectPriceChange(hay: string): { from: number; to: number; currency: string } | null {
  const m = hay.match(
    /(?:从|由|from)\s*((?:HK\$|US\$|¥|￥|\$|€|£|RMB|CNY|USD)?\s?\d[\d,]*(?:\.\d{1,2})?\s?(?:元|美元)?)\s*(?:\/\s*(?:月|年|mo|month|yr|year))?\s*(?:调整为|调整至|调至|涨至|上调至|上调为|改为|变为|to|increases? to)\s*((?:HK\$|US\$|¥|￥|\$|€|£|RMB|CNY|USD)?\s?\d[\d,]*(?:\.\d{1,2})?\s?(?:元|美元)?)/i
  )
  if (!m) return null
  const a = findAmounts(m[1])[0] ?? null
  const b = findAmounts(m[2])[0] ?? null
  const num = (s: string) => Number(s.replace(/[^\d.]/g, ''))
  const from = a?.amount ?? num(m[1])
  const to = b?.amount ?? num(m[2])
  if (!(from > 0) || !(to > 0) || from === to) return null
  return { from, to, currency: b?.currency ?? a?.currency ?? 'CNY' }
}

// ---------------- 日期 ----------------

const EN_MONTH = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

interface DateHit {
  ts: number
  index: number
  end: number
}

/** 无年份的月日：取离参考时间最近的那一年（±6 个月内） */
function nearestYear(base: number, month: number, day: number): number {
  const y = new Date(base).getFullYear()
  let best = NaN
  for (const yy of [y - 1, y, y + 1]) {
    const t = new Date(yy, month - 1, day, 23, 59).getTime()
    if (Number.isNaN(best) || Math.abs(t - base) < Math.abs(best - base)) best = t
  }
  return best
}

function validMd(mo: number, d: number): boolean {
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31
}

/** 全部日期（到日；时刻统一按当天 23:59，作为截止更稳） */
export function findDates(hay: string, base: number): DateHit[] {
  const hits: DateHit[] = []
  const add = (index: number, len: number, ts: number) => {
    if (!Number.isFinite(ts)) return
    const end = index + len
    if (hits.some(h => index < h.end && end > h.index)) return
    hits.push({ ts, index, end })
  }
  for (const m of hay.matchAll(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/g)) {
    const [, y, mo, d] = m
    if (!validMd(+mo, +d)) continue
    add(m.index ?? 0, m[0].length, new Date(+y, +mo - 1, +d, 23, 59).getTime())
  }
  for (const m of hay.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g)) {
    const [, mo, d] = m
    if (!validMd(+mo, +d)) continue
    add(m.index ?? 0, m[0].length, nearestYear(base, +mo, +d))
  }
  for (const m of hay.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(20\d{2}))?/gi)) {
    const mo = EN_MONTH.indexOf(m[1].slice(0, 3).toLowerCase()) + 1
    const d = +m[2]
    if (!validMd(mo, d)) continue
    add(m.index ?? 0, m[0].length, m[3] ? new Date(+m[3], mo - 1, d, 23, 59).getTime() : nearestYear(base, mo, d))
  }
  for (const m of hay.matchAll(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})\b/gi)) {
    const mo = EN_MONTH.indexOf(m[2].slice(0, 3).toLowerCase()) + 1
    const d = +m[1]
    if (!validMd(mo, d)) continue
    add(m.index ?? 0, m[0].length, new Date(+m[3], mo - 1, d, 23, 59).getTime())
  }
  for (const m of hay.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})\/(20\d{2})(?![\d/])/g)) {
    const a = +m[1]
    const b = +m[2]
    // 美式 MM/DD/YYYY 优先；首段 > 12 时按 DD/MM/YYYY
    const [mo, d] = a > 12 ? [b, a] : [a, b]
    if (!validMd(mo, d)) continue
    add(m.index ?? 0, m[0].length, new Date(+m[3], mo - 1, d, 23, 59).getTime())
  }
  return hits.sort((x, y) => x.index - y.index)
}

/** 标签后（同一行、60 字内）的第一个日期 */
export function labeledDate(hay: string, label: RegExp, base: number, dates = findDates(hay, base)): number | null {
  const re = new RegExp(label.source, label.flags.includes('g') ? label.flags : label.flags + 'g')
  for (const m of hay.matchAll(re)) {
    const from = (m.index ?? 0) + m[0].length
    const lineEnd = hay.indexOf('\n', from)
    const limit = Math.min(from + 60, lineEnd < 0 ? hay.length : lineEnd + 1 + 30)
    const hit = dates.find(d => d.index >= from - 2 && d.index <= limit)
    if (hit) return hit.ts
  }
  return null
}

const DUE_LABEL = /(到期还款日|最后还款日|还款日|还款截止|缴费截止|截止日期|付款截止|付款期限|最晚付款|请于|应付日期|应付日|到期日|due date|payment due|due on|due by|pay by|is due)/i
const RENEW_LABEL =
  /(下次扣款|下次续费|下次扣费|下一次续费|下个扣费日|续费日期|续订日期|自动续费日|将于|将在|next (?:billing|payment|charge|renewal) date|renews on|will (?:auto-?)?renew(?:al)? on|will be renewed on|will be charged on|next billed|renewal date|renews|will renew)/i
const TRIAL_LABEL = /(试用(期)?.{0,6}(将于|将在|于)|试用(期)?(结束|到期)(日期|时间)?|trial (?:period )?(?:ends|will end|expires|is ending)(?: on)?|trial end date)/i
const PAID_LABEL = /(付款时间|支付时间|交易时间|扣款时间|入账时间|到账时间|还款时间|payment date|paid on|date paid|charged on|transaction date)/i

function detectPeriod(hay: string, base: number, dates: DateHit[]): { start: number; end: number } | null {
  const label = /(账单周期|账期|计费周期|服务周期|服务期|订阅周期|billing period|service period|period)/i
  const m = hay.match(label)
  const from = m ? (m.index ?? 0) : -1
  for (let i = 0; i < dates.length - 1; i++) {
    const a = dates[i]
    const b = dates[i + 1]
    const between = hay.slice(a.end, b.index)
    if (!/^\s*(至|到|~|-|–|—|to|through)\s*$/i.test(between)) continue
    if (from >= 0 && a.index >= from && a.index - from < 80) return { start: startOf(a.ts), end: b.ts }
    if (from < 0 && b.ts > a.ts && b.ts - a.ts < 400 * DAY) return { start: startOf(a.ts), end: b.ts }
  }
  return null
  function startOf(t: number) {
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
}

// ---------------- 编号 / 字段 ----------------

function grab(hay: string, re: RegExp, group = 1): string | null {
  const m = hay.match(re)
  const v = m?.[group]?.trim()
  return v || null
}

function refNo(hay: string, re: RegExp): string | null {
  for (const m of hay.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
    const v = ([...m].slice(1).reverse().find(g => g != null) ?? '').replace(/[。.,，;；)）]+$/, '')
    if (v && /\d/.test(v) && v.length >= 4) return v.toUpperCase()
  }
  return null
}

const ORDER_NO_RE = /(?:订单(?:编)?号(?:码)?|订单编码|订单|order\s*(?:number|no\.?|#|id)|order)\s*[:：#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{5,32})/i
const INVOICE_NO_RE = /(?:发票号码|发票号|发票代码|invoice\s*(?:number|no\.?|#|id)?)\s*[:：#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,32})/i
const PO_RE = /(?:采购订单号?|采购单号?|PO\s*(?:No\.?|#|number|号))\s*[:：#]?\s*([A-Z0-9][A-Z0-9-]{3,32})|\b(PO-?\d[A-Z0-9-]{2,30})\b/
const CONTRACT_RE = /(?:合同(?:编)?号|合同编码|contract\s*(?:no\.?|#|number))\s*[:：#]?\s*([A-Z0-9][A-Z0-9-]{3,32})/i
const TRACKING_RES: RegExp[] = [
  /(?:运单号|快递单号|物流单号|快递单号码|tracking (?:number|no\.?|#)|tracking id)[:：\s#]*([A-Z0-9]{8,24})\b/i,
  /\b(SF\d{12,13}|1Z[0-9A-Z]{16}|YT\d{13}|JD[0-9A-Z]{10,16}|JT\d{13}|ZTO\d{10,14})\b/
]

function detectTracking(hay: string): string | null {
  for (const re of TRACKING_RES) {
    const m = hay.match(re)
    if (m?.[1] && /\d/.test(m[1])) return m[1].toUpperCase()
  }
  return null
}

function detectItems(hay: string): { name: string; qty?: number; price?: number }[] {
  const out: { name: string; qty?: number; price?: number }[] = []
  const push = (name: string, qty?: string, price?: string) => {
    const n = name.replace(/\s+/g, ' ').replace(/^[-·•*\s]+/, '').trim()
    if (n.length < 2 || n.length > 60 || /^(合计|总计|运费|小计|订单|金额|total|subtotal|shipping)/i.test(n)) return
    if (out.some(o => o.name === n)) return
    const p = price ? findAmounts(price)[0]?.amount : undefined
    out.push({ name: n, qty: qty ? Number(qty) : undefined, price: p })
  }
  for (const m of hay.matchAll(/(?:商品(?:名称)?|宝贝|货品|item)\s*[:：]\s*([^\n]{2,60}?)(?:\s*[x×*]\s*(\d{1,3}))?(?=\s*(?:\n|$|[，,;；]|\s{2}|数量|单价|¥|￥|\$))/gi)) {
    push(m[1], m[2])
    if (out.length >= 5) return out
  }
  for (const m of hay.matchAll(/^\s*([^\n¥￥$]{2,48}?)\s*[x×]\s*(\d{1,3})\s+((?:¥|￥|\$|€|£|HK\$)\s?\d[\d,]*(?:\.\d{1,2})?)/gim)) {
    push(m[1], m[2], m[3])
    if (out.length >= 5) return out
  }
  return out
}

/** 管理 / 取消订阅入口（不是 List-Unsubscribe，也不是营销邮件的「退订」） */
export function detectManageUrl(input: Pick<FinanceMailInput, 'html' | 'text' | 'listUnsubscribe'>): string | null {
  const TEXT = /(管理订阅|管理会员|管理自动续费|关闭自动续费|取消自动续费|取消订阅|取消续订|管理套餐|manage (?:your )?(?:subscription|plan|membership|billing|account)|cancel (?:your )?(?:subscription|plan|membership|auto-?renew(?:al)?)|billing settings|subscription settings|turn off auto-?renew)/i
  const BAD = /unsubscribe|opt-?out|email-?preferences|list-manage|mailing|notification-settings/i
  const header = new Set((input.listUnsubscribe ?? '').match(/https?:\/\/[^\s<>,]+/g) ?? [])
  const ok = (url: string) => /^https?:\/\//i.test(url) && !header.has(url) && !BAD.test(url)
  if (input.html) {
    for (const m of input.html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
      const url = m[1].replace(/&amp;/g, '&')
      const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (TEXT.test(label) && ok(url)) return url
    }
    for (const m of input.html.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+\/(?:account\/)?(?:subscriptions?|billing|membership|manage-?plan)[^"']*)["']/gi)) {
      const url = m[1].replace(/&amp;/g, '&')
      if (ok(url)) return url
    }
  }
  const text = input.text || ''
  for (const m of text.matchAll(new RegExp(TEXT.source, 'gi'))) {
    const tail = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 160)
    const url = tail.match(/https?:\/\/[^\s<>"'）)]+/)?.[0]
    if (url && ok(url)) return url
  }
  return null
}

// ---------------- 对方 / 域名 / 分类 ----------------

const MULTI_TLD = /\.(com|net|org|gov|edu|co|ac)\.(cn|uk|hk|jp|au|nz|sg|tw)$/i

/** 发件域名归一到主域：billing.acme.example → acme.example */
export function rootDomain(addr: string): string | null {
  const host = (addr.split('@')[1] ?? '').toLowerCase().trim()
  if (!host) return null
  const parts = host.split('.')
  const keep = MULTI_TLD.test(host) ? 3 : 2
  return parts.slice(-keep).join('.')
}

const NAME_NOISE =
  /\s*(账单|账务|账单中心|通知|服务|客服|中心|服务号|官方|团队|billing|payments?|invoices?|receipts?|notifications?|notify|no-?reply|support|team|accounts?|orders?|shipping|subscriptions?|store)\s*$/i

function niceDomain(domain: string | null): string {
  if (!domain) return ''
  const label = domain.split('.')[0]
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : domain
}

const COMPANY_RE = /([一-龥A-Za-z0-9（）()·&]{2,32}?(?:有限责任公司|股份有限公司|有限公司|集团|Co\.,? ?Ltd\.?|Ltd\.?|Inc\.?|LLC|GmbH|Limited))/

function counterpartyOf(input: FinanceMailInput, hay: string, kind: FinanceKind, direction: 'out' | 'in', domain: string | null): string {
  // 银行回单 / 收付款通知：读对方户名
  if (kind === 'receipt' || kind === 'payment' || kind === 'invoice') {
    const payee = grab(hay, /(?:收款人|收款方|收款单位|收款户名|收款账户名|对方户名|对方单位|销售方|开票方|卖方|供应商|payee|beneficiary|seller|supplier)\s*(?:户名|名称|全称)?\s*[:：]\s*([^\n，,;；]{2,40})/i)
    const payer = grab(hay, /(?:付款人|付款方|付款单位|付款户名|付款账户名|汇款人|购买方|买方|客户|payer|buyer|bill to|customer)\s*(?:户名|名称|全称)?\s*[:：]\s*([^\n，,;；]{2,40})/i)
    const pick = direction === 'out' ? payee : payer
    const clean = (s: string | null) => (s ? s.replace(/\s*(账号|账户|开户行|税号|地址).*$/, '').trim() : null)
    const v = clean(pick) ?? (kind === 'receipt' ? clean(payee ?? payer) : null)
    if (v && v.length >= 2) return v.slice(0, 40)
  }
  const fromName = (input.fromName || '').replace(/["'<>]/g, '').trim()
  if (fromName && !fromName.includes('@')) {
    if (COMPANY_RE.test(fromName)) return fromName.match(COMPANY_RE)![1]
    const cleaned = fromName.replace(NAME_NOISE, '').replace(NAME_NOISE, '').trim()
    if (cleaned.length >= 2) return cleaned.slice(0, 40)
  }
  if (kind === 'invoice' || kind === 'payment' || kind === 'receipt') {
    const co = hay.match(COMPANY_RE)?.[1]
    if (co) return co.trim()
  }
  return niceDomain(domain) || fromName || '未知商家'
}

function categoryOf(kind: FinanceKind, hay: string, enterprise: boolean): string | null {
  if (FIN_RE.travel.test(hay)) return '差旅'
  if (/(信用卡|credit card|card statement)/i.test(hay)) return '信用卡'
  if (/(电费|水费|燃气|物业费|供暖)/.test(hay)) return '水电'
  if (/(话费|宽带|流量|手机账单|mobile plan|broadband)/i.test(hay)) return '通讯'
  if (/(云服务|云计算|云主机|服务器|cdn|对象存储|\bapi\b|compute|hosting|cloud)/i.test(hay)) return '云服务'
  if (kind === 'order') return '购物'
  if (kind === 'subscription') {
    if (/(视频|音乐|影音|music|video|streaming|播客)/i.test(hay)) return '影音会员'
    return '软件订阅'
  }
  if (enterprise || kind === 'invoice' || kind === 'payment' || kind === 'receipt') {
    if (/货款|采购|purchase order/i.test(hay)) return '货款'
    if (/(外包|设计费|服务费|咨询费|开发费|consulting|service fee)/i.test(hay)) return '外包'
    if (/(办公|文具|租金|房租|office)/i.test(hay)) return '办公'
    return '企业往来'
  }
  if (kind === 'bill' && /对账单/.test(hay)) return '对账'
  return null
}

function cycleOf(hay: string): FinanceCycle | null {
  if (/(每月|月度|按月|月付|月费|包月|连续包月|monthly|per month|a month|\/\s?mo(nth)?\b)/i.test(hay)) return 'monthly'
  if (/(每年|年度|按年|年付|年费|包年|连续包年|annual(ly)?|yearly|per year|a year|\/\s?(yr|year)\b)/i.test(hay)) return 'yearly'
  if (/(季度|每季|按季|quarterly|per quarter)/i.test(hay)) return 'quarterly'
  if (/(每周|按周|weekly|per week)/i.test(hay)) return 'weekly'
  return null
}

export function cycleDays(c: FinanceCycle | null | undefined): number {
  return c === 'weekly' ? 7 : c === 'monthly' ? 30 : c === 'quarterly' ? 91 : c === 'yearly' ? 365 : 0
}

/** 按周期顺延一期（月 / 季 / 年按日历月推，避免 30 天漂移） */
export function addCycle(ts: number, c: FinanceCycle | null | undefined, n = 1): number {
  const d = new Date(ts)
  if (c === 'weekly') d.setDate(d.getDate() + 7 * n)
  else if (c === 'monthly') d.setMonth(d.getMonth() + n)
  else if (c === 'quarterly') d.setMonth(d.getMonth() + 3 * n)
  else if (c === 'yearly') d.setFullYear(d.getFullYear() + n)
  else return ts
  return d.getTime()
}

// ---------------- 入口 ----------------

/** 快速预筛：主题 + 片段里有没有财务味（列表加载时每封都会过一遍，必须便宜） */
export function looksFinancial(subject: string, snippet: string): boolean {
  const hay = `${subject}\n${snippet}`
  return (
    FIN_RE.bill.test(hay) || FIN_RE.invoice.test(hay) || FIN_RE.payment.test(hay) || FIN_RE.receipt.test(hay) ||
    FIN_RE.refund.test(hay) || FIN_RE.subStrong.test(hay) || FIN_RE.trial.test(hay) || FIN_RE.orderWord.test(hay) ||
    FIN_RE.shipped.test(hay) || FIN_RE.delivered.test(hay) || FIN_RE.receiptEn.test(hay) || /[¥￥$€£]\s?\d/.test(hay)
  )
}

/** 一封邮件 → 款项候选（不是财务邮件返回 null） */
export function detectFinance(input: FinanceMailInput): FinanceCandidate | null {
  const body = bodyOf(input)
  const subject = input.subject || ''
  const hay = `${subject}\n${body}`
  const base = input.date || Date.now()
  const R = FIN_RE

  const has = {
    refund: R.refund.test(hay),
    receipt: R.receipt.test(hay),
    placed: R.orderPlaced.test(hay),
    shipped: R.shipped.test(hay),
    transit: R.inTransit.test(hay),
    delivered: R.delivered.test(hay) && (R.orderWord.test(hay) || !!detectTracking(hay) || /(包裹|快递|parcel|package)/i.test(hay)),
    orderWord: R.orderWord.test(hay),
    sub: R.subStrong.test(hay),
    trial: R.trial.test(hay),
    cancel: R.cancelSub.test(hay),
    price: R.priceChange.test(hay),
    bill: R.bill.test(hay),
    invoice: R.invoice.test(hay),
    payment: R.payment.test(hay),
    receiptEn: R.receiptEn.test(hay),
    marketing: R.marketing.test(hay),
    enterprise: R.enterprise.test(hay)
  }
  const tracking = detectTracking(hay)
  const logisticsHit = has.placed || has.shipped || has.transit || has.delivered || !!tracking
  const consumerOrder = logisticsHit && (has.orderWord || !!tracking) && !/(采购订单|purchase order)/i.test(hay)

  // —— 类型 ——
  let kind: FinanceKind | null = null
  if (has.refund) kind = 'refund'
  else if (has.receipt && (has.enterprise || /(银行|bank)/i.test(hay + input.fromAddr))) kind = 'receipt'
  else if (consumerOrder) kind = 'order'
  else if ((has.sub || has.trial || has.cancel) && !(has.enterprise && has.invoice && !has.trial)) kind = 'subscription'
  else if (has.bill) kind = 'bill'
  else if (has.invoice) kind = 'invoice'
  else if (has.payment) kind = 'payment'
  else if (has.receipt) kind = 'receipt'
  else if (has.receiptEn && /[¥￥$€£]\s?\d|\d\s?(元|USD)/.test(hay)) kind = 'payment'
  if (!kind) return null

  // 纯营销（价格只是促销）：没有交易性信号就放过
  const transactional = has.payment || has.bill || has.invoice || has.receipt || has.refund || has.placed || has.shipped || has.delivered || has.transit || has.trial || has.cancel || /(续费|renew|扣款|charged)/i.test(hay)
  if (has.marketing && !transactional) return null
  if (input.isNewsletter && !transactional) return null

  // —— 金额 ——
  const price = has.price ? detectPriceChange(hay) : null
  let amt = pickAmount(hay)
  if (price) amt = { amount: price.to, currency: price.currency, labeled: true }
  if (!amt && input.entities?.length) {
    const money = input.entities.find(e => e.kind === 'money')
    const n = money ? Number(String(money.value).replace(/[^\d.]/g, '')) : NaN
    if (Number.isFinite(n) && n > 0) {
      const cur = money?.label ? findAmounts(money.label)[0]?.currency : undefined
      amt = { amount: n, currency: cur ?? 'CNY', labeled: false }
    }
  }

  // —— 方向 ——
  let direction: 'out' | 'in' = 'out'
  if (kind === 'refund') direction = 'in'
  else if ((kind === 'payment' || kind === 'receipt') && R.incoming.test(hay) && !R.outConfirm.test(hay)) direction = 'in'
  else if ((kind === 'invoice' || kind === 'bill') && input.fromMe) direction = 'in'
  else if (kind === 'invoice' && /(应收|请(贵司|您)(尽快)?(付款|支付|安排付款)前|我司已开具)/.test(hay) && input.fromMe) direction = 'in'
  if (kind === 'receipt' && /(付款回单|转出|借记|支出)/.test(hay)) direction = 'out'

  // —— 日期 ——
  const dates = findDates(hay, base)
  let dueAt = labeledDate(hay, DUE_LABEL, base, dates)
  // 「请于明天 18:00 前」这类相对日期：借用邮件理解抽出的截止实体
  if (!dueAt && input.entities?.length) {
    const dl = input.entities.find(e => e.kind === 'deadline')
    const t = dl ? (/^\d{4}-\d{2}-\d{2}$/.test(dl.value) ? new Date(`${dl.value}T23:59:00`).getTime() : Date.parse(dl.value)) : NaN
    if (Number.isFinite(t)) dueAt = t
  }
  const renewAt = labeledDate(hay, RENEW_LABEL, base, dates)
  const trialEndsAt = has.trial ? labeledDate(hay, TRIAL_LABEL, base, dates) ?? renewAt : null
  const paidLabel = labeledDate(hay, PAID_LABEL, base, dates)
  const period = detectPeriod(hay, base, dates)

  // —— 这一步是什么 / 状态 ——
  let event: FinanceEventKind = 'note'
  let status: FinanceStatus = 'pending'
  let logistics: FinanceLogistics | null = null
  const paidNow = R.paidMark.test(hay)
  const pending = R.pendingPay.test(hay)
  switch (kind) {
    case 'refund':
      event = 'refunded'
      status = 'refunded'
      break
    case 'receipt':
      event = 'receipt'
      status = 'paid'
      break
    case 'order':
      logistics = has.delivered ? 'delivered' : has.transit ? 'in_transit' : has.shipped || tracking ? 'shipped' : 'ordered'
      event = logistics
      status = pending && !has.shipped && !has.delivered ? 'pending' : 'paid'
      break
    case 'subscription':
      if (has.cancel) {
        event = 'cancelled'
        status = 'cancelled'
      } else if (has.trial && !paidNow) {
        event = 'trial'
        status = 'pending'
      } else if (price) {
        event = 'price_change'
        status = 'pending'
      } else if (R.overdue.test(hay)) {
        event = 'overdue'
        status = 'overdue'
      } else if (paidNow || (!R.upcoming.test(hay) && (has.invoice || has.receiptEn || has.payment))) {
        event = 'renewed'
        status = 'paid'
      } else {
        event = 'reminder'
        status = 'pending'
      }
      break
    case 'bill':
      if (paidNow) {
        event = 'paid'
        status = 'paid'
      } else if (R.overdue.test(hay)) {
        event = 'overdue'
        status = 'overdue'
      } else if (/(提醒|催缴|催款|reminder|即将到期|还有\s*\d+\s*天)/i.test(hay)) {
        event = 'reminder'
        status = 'pending'
      } else event = 'billed'
      break
    case 'invoice':
      event = 'invoiced'
      status = paidNow && !has.enterprise ? 'paid' : 'pending'
      break
    case 'payment':
      event = direction === 'in' ? 'received' : 'paid'
      status = R.overdue.test(hay) && !paidNow ? 'overdue' : 'paid'
      break
  }

  const domain = rootDomain(input.fromAddr)
  const enterprise = (kind === 'invoice' || kind === 'payment' || kind === 'receipt') && (has.enterprise || kind === 'receipt')
  const counterparty = counterpartyOf(input, hay, kind, direction, domain)
  const cycle = kind === 'subscription' ? cycleOf(hay) : null
  const orderNo = refNo(hay, ORDER_NO_RE)
  const invoiceNo = refNo(hay, INVOICE_NO_RE)
  const poNo = refNo(hay, PO_RE)
  let contractNo = refNo(hay, CONTRACT_RE)
  // 银行回单 / 付款通知常把合同号写在摘要 / 附言里（没有「合同号」标签）
  if (!contractNo && (kind === 'receipt' || kind === 'payment')) {
    const memo = grab(hay, /(?:摘要|附言|用途|备注|memo|reference|remark)\s*[:：]\s*([^\n]{2,60})/i)
    const tok = memo?.match(/\b([A-Z]{2,4}-?\d{2,}(?:-\d{2,})*)\b/)?.[1]
    if (tok && !/^PO-?\d/.test(tok)) contractNo = tok
  }
  const shop = kind === 'order' ? grab(hay, /(?:店铺|商家|卖家|sold by|seller)\s*[:：]\s*([^\n，,]{2,30})/i) ?? counterparty : null
  const items = kind === 'order' ? detectItems(hay) : []

  let nextRenewalAt: number | null = null
  if (kind === 'subscription') {
    nextRenewalAt = renewAt ?? (event === 'renewed' && cycle ? addCycle(paidLabel ?? base, cycle) : null)
    if (event === 'trial' && trialEndsAt) nextRenewalAt = trialEndsAt
    if (nextRenewalAt && nextRenewalAt < base - DAY && event !== 'renewed') nextRenewalAt = null
  }

  // —— 把握 ——
  let confidence = 0.45
  if (amt) confidence += amt.labeled ? 0.3 : 0.2
  if (orderNo || invoiceNo || tracking || poNo || contractNo) confidence += 0.15
  if (dueAt || renewAt || trialEndsAt || period) confidence += 0.08
  if (has.marketing) confidence -= 0.2
  if (input.isNewsletter) confidence -= 0.15
  if (/^(re|回复|fw|fwd|转发)\s*[:：]/i.test(subject.trim())) confidence -= 0.1
  // 只有一个弱信号（如正文提到「订单」二字）
  const strongSignals = [has.refund, has.receipt, has.placed, has.shipped, has.delivered, has.sub, has.trial, has.bill, has.invoice, has.payment].filter(Boolean).length
  if (strongSignals === 0) confidence -= 0.15
  confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100))

  const needsAmount = kind !== 'order' && kind !== 'subscription' ? !amt : kind === 'subscription' ? !amt && event !== 'cancelled' && event !== 'trial' : false
  const uncertain = confidence < 0.6 || needsAmount

  return {
    kind,
    event,
    direction,
    counterparty,
    domain,
    amount: amt?.amount ?? null,
    currency: amt?.currency ?? 'CNY',
    status,
    dueAt: kind === 'subscription' ? nextRenewalAt : kind === 'bill' || kind === 'invoice' || (kind === 'order' && status === 'pending') ? dueAt : kind === 'payment' && status === 'overdue' ? dueAt : null,
    paidAt: status === 'paid' && (event === 'paid' || event === 'renewed' || event === 'received' || event === 'receipt' || kind === 'payment') ? paidLabel ?? base : null,
    periodStart: period?.start ?? null,
    periodEnd: period?.end ?? null,
    category: categoryOf(kind, hay, enterprise),
    cycle,
    nextRenewalAt,
    trialEndsAt,
    manageUrl: kind === 'subscription' ? detectManageUrl({ html: input.html, text: body, listUnsubscribe: input.listUnsubscribe }) : null,
    shop,
    orderNo: kind === 'order' || kind === 'refund' ? orderNo : orderNo && enterprise ? orderNo : kind === 'payment' ? orderNo : null,
    items,
    tracking,
    logistics,
    invoiceNo,
    poNo,
    contractNo,
    enterprise,
    previousAmount: price?.from ?? null,
    monthHint: kind === 'bill' ? Number(subject.match(/(?:^|[^\d])(\d{1,2})\s*月(?:份)?(?:电子)?(?:账单|电费|水费|话费|对账单|月结)/)?.[1] ?? body.match(/(\d{1,2})\s*月(?:份)?(?:电子)?账单/)?.[1]) || null : null,
    confidence,
    uncertain
  }
}

/** 收进财务的门槛：拿不准的（且没有 AI 兜底）宁可不收 */
export function acceptCandidate(c: FinanceCandidate | null): boolean {
  if (!c) return false
  if (c.kind === 'order') return c.confidence >= 0.45 && !!(c.orderNo || c.tracking || c.amount)
  if (c.kind === 'subscription') return c.confidence >= 0.5
  return c.confidence >= 0.55 && (c.amount != null || !!c.invoiceNo)
}
