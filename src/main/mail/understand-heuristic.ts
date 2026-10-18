/**
 * 邮件理解 · 启发式层（无 AI、同步、纯函数、无副作用）
 *
 * 许多用户不配置 AI，所以这一层必须单独可用：
 *  - 分区：需要你处理(act) / 等对方回复(wait) / 知悉(fyi) / 归堆(bundle)
 *  - 要点 gist：正文第一句有效句（去问候语、去样板话），≤60 字
 *  - 实体：验证码 / 金额 / 时间 / 截止 / 登录链接 / 运单号（正则）
 *  - 建议动作 next、紧急度 urgency、快速回复草稿
 * AI 理解（understand.ts）以本结果为提示并可覆盖；本文件只允许 `import type`，
 * 以便 `node --experimental-strip-types` 独立加载测试。
 */
import type {
  MailBundle,
  MailEntity,
  MailInsight,
  MailNextAction,
  MailSection,
  MessageCategory
} from '../../shared/types'

export interface HeuristicInput {
  messageId: string
  subject: string
  /** 纯文本正文（可能为空：正文尚未下载） */
  text: string
  snippet: string
  html?: string | null
  fromAddr: string
  fromName: string
  date: number
  category: MessageCategory
  isNewsletter: boolean
  unread: boolean
  flagged: boolean
  pinned: boolean
  answered: boolean
  /** 发件人在 Screener 中的状态 */
  screening: 'pending' | 'allow' | 'deny' | null
  /** 这封邮件是我（本机账户）发出的 */
  fromMe: boolean
  /** 线程最新一封是我发的、且超过 2 天没有回复 */
  awaitingReply: { since: number; toName: string } | null
  /** 计算基准时间（测试注入），默认 Date.now() */
  now?: number
}

const DAY = 864e5
const WEEK_CN = '日一二三四五六'

// ---------------- 工具 ----------------

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 本地时间 ISO（带时区偏移），如 2026-10-21T15:00:00+08:00 */
function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** snooze/todo 用的 'YYYY-MM-DD HH:mm' */
export function fmtMinute(d: Date): string {
  return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function startOfDay(t: number): Date {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return [...t].length > max ? [...t].slice(0, max - 1).join('') + '…' : t
}

function cnDow(ch: string): number {
  return ch === '天' ? 0 : WEEK_CN.indexOf(ch)
}

/** 解析实体值为时间戳（time / deadline 的 value 可能是日期或带时区的 ISO） */
export function entityTime(value: string): number | null {
  if (!value) return null
  const t = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:00`).getTime() : Date.parse(value)
  return Number.isFinite(t) ? t : null
}

/** 姓名展示：「王小明」/「alice」 */
export function displayName(name: string, addr: string): string {
  const n = (name || '').replace(/["']/g, '').trim()
  if (n && !n.includes('@')) return n
  return (addr || '').split('@')[0] || addr || ''
}

// ---------------- 实体：验证码 / 登录链接 ----------------

const CODE_HINT =
  /(验证码|校验码|动态码|确认码|安全码|verification code|security code|one[- ]time (?:code|password)|\botp\b|2fa|登录码|auth code|confirmation code|login code)/i
const AUTH_NEGATIVE = /(快递|物流|订单已发货|航班|行程|工资|对账单已生成)/
const CODE_PATTERNS: RegExp[] = [
  /(?:验证码|校验码|动态码|确认码|安全码|code|otp)[^\dA-Z]{0,24}([0-9]{6})(?!\d)/i,
  /(?<!\d)([0-9]{6})[^\dA-Z]{0,24}(?:验证码|校验码|动态码|确认码|is your)/i,
  /(?:验证码|校验码|动态码|确认码|安全码|code|otp)[^\dA-Z]{0,24}([0-9]{4,8})(?!\d)/i,
  /(?<!\d)([0-9]{4,8})[^\dA-Z]{0,24}(?:验证码|校验码|动态码|确认码|is your)/i,
  /(?:验证码|校验码|code|otp)[^\dA-Z]{0,24}\b([A-Z0-9]{5,8})\b/,
  /(?:code is|验证码[^\dA-Za-z]{0,8})\s*([A-Z0-9]{5,8})\b/
]
const LOGIN_HINT =
  /(登录|登陆|log ?in|sign[- ]?in|magic[- ]?link|verify|confirm|activate|账户验证|验证账户|验证邮箱|工作区|安全链接)/i
const LOGIN_URL_RE =
  /https?:\/\/[^\s"'<>]*\b(?:login|sign[- ]?in|signin|verify|verification|confirm|magic|activate|auth(?:enticate|orize)?|token|continue)\b[^\s"'<>]*/i

function providerFrom(url: string): string {
  try {
    const host = new URL(url).host
    const m = host.match(/(?:^|\.)([a-z0-9-]+)\.(?:com|cn|net|org|io|co|app|dev|ai|me|cc|tv)(?:\.[a-z]{2})?$/i)
    return (m?.[1] ?? host).replace(/^www\./, '')
  } catch {
    return ''
  }
}

function detectCode(hay: string): string | null {
  if (AUTH_NEGATIVE.test(hay) || !CODE_HINT.test(hay)) return null
  for (const re of CODE_PATTERNS) {
    const m = hay.match(re)
    if (!m?.[1]) continue
    const code = m[1]
    if (/^(19|20)\d{2}$/.test(code)) continue
    // 字母数字码至少要带一个数字（排除普通英文单词）
    if (/[A-Z]/.test(code) && !/\d/.test(code)) continue
    return code
  }
  return null
}

function detectLoginLink(subject: string, body: string, html?: string | null, fromAddr?: string): string | null {
  const hay = `${subject}\n${body.slice(0, 4000)}`
  if (AUTH_NEGATIVE.test(hay) || !LOGIN_HINT.test(hay)) return null
  const urls: string[] = []
  if (html) for (const m of html.matchAll(/href="(https?:\/\/[^"]+)"/gi)) urls.push(m[1].replace(/&amp;/g, '&'))
  urls.push(...(body.match(/https?:\/\/[^\s<>"'）)]+/g) ?? []))
  const candidates = urls.filter(u => LOGIN_URL_RE.test(u) && !/unsubscribe|privacy|terms|help|support/i.test(u))
  if (!candidates.length) return null
  const domain = fromAddr?.split('@')[1]
  return (domain ? candidates.find(u => u.includes(domain)) : undefined) ?? candidates[0]
}

// ---------------- 实体：运单号 ----------------

const TRACKING_RES: RegExp[] = [
  /(?:运单号|快递单号|物流单号|快递单号码|tracking (?:number|no\.?|#)|tracking id)[:：\s#]*([A-Z0-9]{8,24})\b/i,
  /\b(SF\d{12,13}|1Z[0-9A-Z]{16}|YT\d{13}|JD[0-9A-Z]{10,16}|JT\d{13})\b/
]

function detectTracking(hay: string): string | null {
  for (const re of TRACKING_RES) {
    const m = hay.match(re)
    if (m?.[1] && /\d/.test(m[1])) return m[1].toUpperCase()
  }
  return null
}

// ---------------- 实体：金额 ----------------

const MONEY_RE =
  /(?:(¥|￥|\$|€|£|RMB|CNY|USD|EUR)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?)|(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(万元|元|块钱|美元|欧元|RMB|CNY|USD))/gi
const BILL_CONTEXT = /(账单|还款|应还|缴费|付款|支付|扣款|发票|invoice|payment|amount due|balance|续费|订阅费|报价|预算|金额|合计|总计|total)/i

function detectMoney(hay: string): { label: string; value: string; billish: boolean }[] {
  const out: { label: string; value: string; billish: boolean }[] = []
  for (const m of hay.matchAll(MONEY_RE)) {
    const intPart = (m[2] ?? m[4] ?? '').replace(/,/g, '')
    const frac = m[3] ?? m[5] ?? ''
    let n = Number(frac ? `${intPart}.${frac}` : intPart)
    if (!Number.isFinite(n) || n <= 0) continue
    if (m[6] === '万元') n *= 10000
    const idx = m.index ?? 0
    const ctx = hay.slice(Math.max(0, idx - 24), idx + m[0].length + 12)
    out.push({ label: m[0].replace(/\s+/g, ''), value: String(Math.round(n * 100) / 100), billish: BILL_CONTEXT.test(ctx) })
    if (out.length >= 2) break
  }
  return out
}

// ---------------- 实体：时间 / 截止 ----------------

const DEADLINE_BEFORE = /(截止|到期|最晚|最后期限|还款日|缴费日|请于|务必在|需在|须在|deadline|due|by|before|until|no later than|expires?)\s*(?:时间|日期|日)?\s*[:：为是在]?\s*$/i
const DEADLINE_AFTER = /^\s*(?:前|之前|以前|截止|到期|前完成|前提交|前回复|前付款|前缴|内完成)/
const ROUTINE_BEFORE = /(每|每个|every)\s*$/i

interface TimeHit {
  index: number
  end: number
  raw: string
  date: Date
  hasHour: boolean
}

function applyHour(d: Date, period: string | undefined, hStr: string | undefined, mStr: string | undefined, half?: string): boolean {
  if (!hStr) return false
  let h = Number(hStr)
  let min = mStr ? Number(mStr) : 0
  if (half === '半') min = 30
  else if (half && /\d/.test(half)) min = Number(half.replace(/\D/g, ''))
  const p = (period ?? '').toLowerCase()
  if ((/下午|晚上|傍晚|pm/.test(p) && h < 12) || (p === '中午' && h < 11)) h += 12
  if (/am/.test(p) && h === 12) h = 0
  if (h > 23 || min > 59) return false
  d.setHours(h, min, 0, 0)
  return true
}

/** 以 base 为参照，求「周X」对应日期；week: 0=本周起（含当天）/ 1=下周 / 2=下下周 */
function weekdayFrom(base: Date, dow: number, mode: 'onOrAfter' | 'thisWeek' | 'nextWeek' | 'weekAfter'): Date {
  const d = startOfDay(base.getTime())
  if (mode === 'onOrAfter') {
    d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7))
    return d
  }
  // 周一为一周起点
  const mondayOffset = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - mondayOffset)
  const add = mode === 'thisWeek' ? 0 : mode === 'nextWeek' ? 7 : 14
  d.setDate(d.getDate() + add + ((dow + 6) % 7))
  return d
}

function inferYear(base: Date, month: number, day: number): Date {
  const d = new Date(base.getFullYear(), month - 1, day)
  // 明显早于参考日（> 60 天）多半指明年（如 12 月邮件里写「1月5日」）
  if (d.getTime() < base.getTime() - 60 * DAY) d.setFullYear(d.getFullYear() + 1)
  return d
}

const EN_MONTH = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const EN_DOW: Record<string, number> = { sun: 0, mon: 1, tues: 2, wednes: 3, thurs: 4, fri: 5, satur: 6 }

const PERIOD = '(上午|下午|晚上|中午|早上|傍晚)?'
const CN_CLOCK = '(\\d{1,2})(?:[:：](\\d{2})|点(半|\\d{1,2}分?)?)'

function collectTimes(hay: string, baseTs: number): TimeHit[] {
  const base = new Date(baseTs)
  const hits: TimeHit[] = []
  const add = (index: number, raw: string, date: Date, hasHour: boolean) => {
    const end = index + raw.length
    if (hits.some(h => index < h.end && end > h.index)) return
    if (!Number.isFinite(date.getTime())) return
    hits.push({ index, end, raw: raw.trim(), date, hasHour })
  }

  // 1) 2026-10-25 [15:00] / 2026年10月25日
  for (const m of hay.matchAll(new RegExp(`(\\d{4})[-/.年](\\d{1,2})[-/.月](\\d{1,2})日?(?:\\s*[（(]?(?:周|星期)[一二三四五六日天][)）]?)?(?:\\s*${PERIOD}\\s*${CN_CLOCK})?`, 'g'))) {
    const [, y, mo, da, period, h, mi, half] = m
    if (Number(mo) < 1 || Number(mo) > 12 || Number(da) < 1 || Number(da) > 31) continue
    const d = new Date(Number(y), Number(mo) - 1, Number(da))
    const hasHour = applyHour(d, period, h, mi, half)
    add(m.index ?? 0, m[0], d, hasHour)
  }
  // 2) 10月25日 [周五] [下午 3点]
  for (const m of hay.matchAll(new RegExp(`(\\d{1,2})月(\\d{1,2})[日号](?:\\s*[（(]?(?:周|星期)[一二三四五六日天][)）]?)?(?:\\s*${PERIOD}\\s*${CN_CLOCK})?`, 'g'))) {
    const [, mo, da, period, h, mi, half] = m
    if (Number(mo) < 1 || Number(mo) > 12 || Number(da) < 1 || Number(da) > 31) continue
    const d = inferYear(base, Number(mo), Number(da))
    const hasHour = applyHour(d, period, h, mi, half)
    add(m.index ?? 0, m[0], d, hasHour)
  }
  // 3) 今天/明天/后天/周三/下周三 [下午] [15:00 | 3点]
  for (const m of hay.matchAll(new RegExp(`(今天|今日|今晚|明天|明日|明晚|后天|(?:本周|这周|下下周|下周|周|星期|礼拜)[一二三四五六日天])(?:\\s*${PERIOD}\\s*${CN_CLOCK})?`, 'g'))) {
    const [raw, word, period, h, mi, half] = m
    const idx = m.index ?? 0
    if (ROUTINE_BEFORE.test(hay.slice(Math.max(0, idx - 3), idx))) continue
    let d: Date
    if (/^今/.test(word)) d = startOfDay(baseTs)
    else if (/^明/.test(word)) d = startOfDay(baseTs + DAY)
    else if (word === '后天') d = startOfDay(baseTs + 2 * DAY)
    else {
      const dow = cnDow(word.slice(-1))
      if (dow < 0) continue
      const mode = word.startsWith('下下周') ? 'weekAfter' : word.startsWith('下周') ? 'nextWeek' : /^(本周|这周)/.test(word) ? 'thisWeek' : 'onOrAfter'
      d = weekdayFrom(base, dow, mode)
    }
    const hasHour = applyHour(d, period ?? (/晚$/.test(word) ? '晚上' : undefined), h, mi, half)
    // 「今天/明天」单独出现太泛（「今天天气不错」）：需要具体钟点或截止语境
    if (!hasHour && /^(今|明|后天)/.test(word)) {
      const before = hay.slice(Math.max(0, idx - 12), idx)
      const after = hay.slice(idx + raw.length, idx + raw.length + 8)
      if (!DEADLINE_BEFORE.test(before) && !DEADLINE_AFTER.test(after)) continue
    }
    add(idx, raw, d, hasHour)
  }
  // 4) English: [next] Friday [at 3pm] / Oct 25 [, 2026] [at 3:00 pm] / tomorrow at 10am
  for (const m of hay.matchAll(/\b(?:(next|this)\s+)?(mon|tues|wednes|thurs|fri|satur|sun)day\b(?:,?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/gi)) {
    const [, which, dw, h, mi, ap] = m
    const idx = m.index ?? 0
    if (ROUTINE_BEFORE.test(hay.slice(Math.max(0, idx - 7), idx))) continue
    const d = weekdayFrom(base, EN_DOW[dw.toLowerCase()], which?.toLowerCase() === 'next' ? 'nextWeek' : 'onOrAfter')
    const hasHour = applyHour(d, ap, h, mi)
    add(idx, m[0], d, hasHour)
  }
  for (const m of hay.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(\d{4}))?(?:,?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/gi)) {
    const [, mon, da, y, h, mi, ap] = m
    const mo = EN_MONTH.indexOf(mon.slice(0, 3).toLowerCase()) + 1
    if (mo < 1 || Number(da) < 1 || Number(da) > 31) continue
    const d = y ? new Date(Number(y), mo - 1, Number(da)) : inferYear(base, mo, Number(da))
    const hasHour = applyHour(d, ap, h, mi)
    add(m.index ?? 0, m[0], d, hasHour)
  }
  for (const m of hay.matchAll(/\b(today|tonight|tomorrow)\b(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/gi)) {
    const [, word, h, mi, ap] = m
    const d = startOfDay(baseTs + (word.toLowerCase() === 'tomorrow' ? DAY : 0))
    const hasHour = applyHour(d, ap ?? (word.toLowerCase() === 'tonight' ? 'pm' : undefined), h, mi)
    const idx = m.index ?? 0
    if (!hasHour && !DEADLINE_BEFORE.test(hay.slice(Math.max(0, idx - 12), idx))) continue
    add(idx, m[0], d, hasHour)
  }
  // 5) 10/25（仅在截止语境下，避免分数/比例误报）
  for (const m of hay.matchAll(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/g)) {
    const idx = m.index ?? 0
    const before = hay.slice(Math.max(0, idx - 12), idx)
    const after = hay.slice(idx + m[0].length, idx + m[0].length + 8)
    if (!DEADLINE_BEFORE.test(before) && !DEADLINE_AFTER.test(after)) continue
    const mo = Number(m[1])
    const da = Number(m[2])
    if (mo < 1 || mo > 12 || da < 1 || da > 31) continue
    add(idx, m[0], inferYear(base, mo, da), false)
  }
  return hits.sort((a, b) => a.index - b.index)
}

function isDeadlineAt(hay: string, h: TimeHit): boolean {
  const before = hay.slice(Math.max(0, h.index - 16), h.index)
  const after = hay.slice(h.end, h.end + 10)
  return DEADLINE_BEFORE.test(before) || DEADLINE_AFTER.test(after) || /截止|到期|deadline|due/i.test(before)
}

/** 抽取全部实体（subject + 正文） */
export function extractEntities(input: Pick<HeuristicInput, 'subject' | 'text' | 'snippet' | 'html' | 'fromAddr' | 'date'>): MailEntity[] {
  const body = (input.text || input.snippet || '').slice(0, 8000)
  const hay = `${input.subject}\n${body}`
  const out: MailEntity[] = []

  const code = detectCode(hay)
  if (code) out.push({ kind: 'code', label: code, value: code, action: 'copy' })

  const link = detectLoginLink(input.subject, body, input.html, input.fromAddr)
  if (link) {
    const p = providerFrom(link)
    out.push({ kind: 'link', label: p ? `登录 ${p}` : '登录链接', value: link, action: 'open' })
  }

  const tracking = detectTracking(hay)
  if (tracking) out.push({ kind: 'tracking', label: `运单 ${tracking}`, value: tracking, action: 'copy' })

  // 时间：验证码邮件里的时间多半是「x 分钟内有效」之类的噪声，跳过
  if (!code) {
    let n = 0
    for (const h of collectTimes(hay, input.date || Date.now())) {
      const deadline = isDeadlineAt(hay, h)
      const value = h.hasHour ? isoLocal(h.date) : ymd(h.date)
      if (out.some(e => (e.kind === 'time' || e.kind === 'deadline') && e.value === value)) continue
      out.push({
        kind: deadline ? 'deadline' : 'time',
        label: clip(h.raw, 20),
        value,
        action: deadline ? 'todo' : 'calendar'
      })
      if (++n >= 3) break
    }
  }

  for (const m of detectMoney(hay)) {
    // 金额只在账单/付款语境下给「建待办」，其余仅展示
    out.push({ kind: 'money', label: clip(m.label, 20), value: m.value, action: m.billish ? 'todo' : null })
  }
  return out
}

// ---------------- 要点 gist ----------------

const QUOTE_CUT = /(^|\n)\s*(?:On .{4,80} wrote:|在 .{2,80} 写道[:：]|-{2,}\s*Original Message\s*-{2,}|-{2,}\s*原始邮件\s*-{2,}|发件人[:：].{0,80}\n\s*(?:发送时间|日期|Sent)[:：])/i
const GREETING_LINE =
  /^(?:hi|hello|hey|dear|greetings|你好|您好|hi there|尊敬的|亲爱的|各位|大家好|hello there)[^。.!！?？\n]{0,24}?[,，:：!！]?\s*$/i
const GREETING_PREFIX =
  /^(?:(?:hi|hello|hey|dear)\s+[^,，:：\n]{0,24}[,，:：]|[^\s,，。]{0,10}(?:你好|您好)[,，!！:：。]?|尊敬的[^,，:：]{0,24}[,，:：]|亲爱的[^,，:：]{0,24}[,，:：]|各位(?:好)?[,，:：]|大家好[,，:：!！]?)\s*/i
const BOILERPLATE =
  /(view (?:it |this )?(?:email )?in (?:your )?browser|在浏览器中(?:查看|打开)|如(?:果)?(?:无法|不能)正常显示|邮件(?:无法|不能)正常显示|请勿(?:直接)?回复|do not reply|don'?t reply|unsubscribe|退订|this (?:email|message) was sent|you(?:'re| are) receiving this|privacy policy|版权所有|copyright|©|感谢(?:您)?(?:使用|选择|订阅|关注)|thanks? for (?:using|choosing|subscribing)|系统邮件|自动发送)/i

function bodyForGist(text: string): string {
  let t = text.replace(/\r/g, '')
  const cut = t.search(QUOTE_CUT)
  if (cut > 0) t = t.slice(0, cut)
  return t
    .split('\n')
    .filter(l => !/^\s*>/.test(l))
    .join('\n')
}

function sentencesOf(text: string): string[] {
  const lines = bodyForGist(text)
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  const out: string[] = []
  for (let line of lines) {
    if (GREETING_LINE.test(line)) continue
    line = line.replace(GREETING_PREFIX, '').trim()
    if (!line) continue
    for (const s of line.split(/(?<=[。！？!?；;])|(?<=[a-z0-9)]\.)\s+(?=[A-Z0-9])/)) {
      const clean = s.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
      const meaningful = clean.replace(/[\s\p{P}\p{S}]/gu, '')
      if ([...meaningful].length < 4) continue
      if (BOILERPLATE.test(clean)) continue
      out.push(clean)
      if (out.length >= 12) return out
    }
  }
  return out
}

function clauseWindow(sentence: string, key: string | undefined, max: number): string {
  const parts = sentence.split(/(?<=[，,；;：:])/)
  if (parts.length < 2) return sentence
  let center = key ? parts.findIndex(p => p.includes(key)) : 0
  if (center < 0) center = 0
  let lo = center
  let hi = center
  const len = (a: number, b: number) => [...parts.slice(a, b + 1).join('')].length
  for (;;) {
    // 优先向前带上一分句（「应付金额 ¥x，请于 y 前完成支付」），再向后
    if (lo > 0 && len(lo - 1, hi) <= max) lo--
    else if (hi < parts.length - 1 && len(lo, hi + 1) <= max) hi++
    else break
  }
  return parts.slice(lo, hi + 1).join('').replace(/[，,；;：:]$/, '')
}

/** 一句话要点：优先含关键实体的句子（前 6 句内），否则第一句有效句；≤60 字 */
export function makeGist(subject: string, text: string, snippet: string, entities: MailEntity[]): string {
  const sentences = sentencesOf(text || snippet || '')
  const keyEntities = entities.filter(e => e.kind !== 'link')
  const priority: MailEntity['kind'][] = ['code', 'deadline', 'money', 'time', 'tracking']
  let pick: string | undefined
  let key: string | undefined
  for (const kind of priority) {
    const e = keyEntities.find(x => x.kind === kind)
    if (!e) continue
    pick = sentences.slice(0, 6).find(s => s.includes(e.label) || s.includes(e.value))
    if (pick) {
      key = pick.includes(e.label) ? e.label : e.value
      break
    }
  }
  pick ??= sentences[0]
  // 长句：以关键实体所在分句为中心，向两侧扩展到 60 字以内
  if (pick && [...pick].length > 60) pick = clauseWindow(pick, key, 60)
  // 第一句过短（「收到。」）时拼上第二句
  if (pick && [...pick].length < 10 && sentences[1] && pick === sentences[0]) pick = `${pick}${sentences[1]}`
  const subj = subject.replace(/^\s*((re|fw|fwd|答复|回复|转发)\s*[:：]\s*)+/i, '').trim()
  return clip(pick || subj || '（无内容）', 60)
}

function pickGistKey(gist: string, entities: MailEntity[]): string | null {
  for (const e of entities) {
    if (e.kind === 'link') continue
    if (e.label && gist.includes(e.label)) return e.label
    if (e.kind === 'code' && gist.includes(e.value)) return e.value
  }
  return null
}

// ---------------- 分区 / 归堆 ----------------

export function bundleOf(input: Pick<HeuristicInput, 'category' | 'isNewsletter' | 'screening'>): MailBundle | null {
  if (input.screening === 'pending') return 'screener'
  if (input.category === 'newsletter' || input.isNewsletter) return 'newsletter'
  if (input.category === 'notification' || input.category === 'noise') return 'notification'
  return null
}

function sectionOf(input: HeuristicInput, bundle: MailBundle | null, entities: MailEntity[], now: number): { section: MailSection; bundle: MailBundle | null } {
  if (input.awaitingReply) return { section: 'wait', bundle: bundle === 'screener' ? bundle : null }
  const recent = now - input.date <= 14 * DAY
  // 通知类但有临近截止（3 天内、未过期 2 天以上）或被用户标星/置顶：提升为「需要你处理」
  const urgentDeadline = entities.some(e => {
    if (e.kind !== 'deadline') return false
    const t = entityTime(e.value)
    return t != null && t - now <= 3 * DAY && now - t <= 2 * DAY
  })
  if (bundle === 'notification' && recent && (urgentDeadline || input.flagged || input.pinned)) return { section: 'act', bundle: null }
  if (bundle) return { section: 'bundle', bundle }
  if (input.fromMe) return { section: 'fyi', bundle: null }
  if (input.category === 'personal' && recent && ((input.unread && !input.answered) || input.flagged || input.pinned)) {
    return { section: 'act', bundle: null }
  }
  if (input.category === 'personal' && recent && urgentDeadline) return { section: 'act', bundle: null }
  return { section: 'fyi', bundle: null }
}

// ---------------- 建议动作 / 紧急度 ----------------

function dayLabel(target: Date, now: number): string {
  const diff = Math.round((startOfDay(target.getTime()).getTime() - startOfDay(now).getTime()) / DAY)
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === 2) return '后天'
  if (diff > 2 && diff < 7) return `周${WEEK_CN[target.getDay()]}`
  return `${target.getMonth() + 1}/${target.getDate()}`
}

function shortSubject(subject: string, max = 16): string {
  return clip(subject.replace(/^\s*((re|fw|fwd|答复|回复|转发)\s*[:：]\s*)+/i, '').replace(/[【\[][^】\]]{0,12}[】\]]/g, '').trim() || '这封邮件', max)
}

function buildNext(input: HeuristicInput, section: MailSection, bundle: MailBundle | null, entities: MailEntity[], now: number): { next: MailNextAction[]; quickReply: string } {
  const next: MailNextAction[] = []
  let quickReply = ''
  const upcoming = entities
    .filter(e => e.kind === 'time' || e.kind === 'deadline')
    .map(e => ({ e, t: entityTime(e.value) }))
    .filter((x): x is { e: MailEntity; t: number } => x.t != null && x.t > now - DAY)
  const meeting = upcoming.find(x => x.e.kind === 'time')
  const deadline = upcoming.find(x => x.e.kind === 'deadline')
  const link = entities.find(e => e.kind === 'link')

  if (section === 'act') {
    if (meeting) {
      quickReply = `好的，${meeting.e.label} 可以，到时见。`
      next.push({ kind: 'reply', label: clip(`回复：${meeting.e.label} 可以`, 24), body: quickReply })
    } else if (input.category === 'personal') {
      quickReply = '收到，我看一下，稍后回复你。'
      next.push({ kind: 'reply', label: '回复：收到，稍后细看', body: quickReply })
    }
  } else if (section === 'wait' && input.awaitingReply) {
    const who = input.awaitingReply.toName
    const body = `${who ? `${who}，` : ''}想跟进一下之前这封邮件，方便的时候回复一下？谢谢！`
    next.push({ kind: 'reply', label: who ? clip(`催一下 ${who}`, 24) : '催一下', body })
    quickReply = body
  }

  if (deadline) {
    const d = new Date(deadline.t)
    next.push({
      kind: 'todo',
      label: clip(`建待办：${shortSubject(input.subject, 12)}`, 24),
      title: clip(`${shortSubject(input.subject, 24)}（${deadline.e.label}）`, 60),
      due: ymd(d)
    })
  }

  if (section === 'act' || section === 'wait') {
    // 稍后：有未来的会议/截止 → 当天上午 9 点；等回复 → 2 天后；否则明早
    let target: Date
    const anchor = upcoming.find(x => x.t > now + 12 * 3600_000)
    if (section === 'wait') target = startOfDay(now + 2 * DAY)
    else if (anchor) target = startOfDay(anchor.e.kind === 'deadline' ? anchor.t - DAY : anchor.t)
    else target = startOfDay(now + DAY)
    target.setHours(9, 0, 0, 0)
    if (target.getTime() <= now) target = new Date(startOfDay(now + DAY).getTime() + 9 * 3600_000)
    next.push({ kind: 'snooze', label: `稍后到${dayLabel(target, now)}上午`, until: fmtMinute(target) })
  }

  if (link && bundle !== 'notification') next.push({ kind: 'open', label: '打开登录链接', url: link.value })
  else if (link && !entities.some(e => e.kind === 'code')) next.push({ kind: 'open', label: '打开登录链接', url: link.value })

  if (section === 'fyi' && !next.length) next.push({ kind: 'archive', label: '归档' })
  return { next: next.slice(0, 4), quickReply }
}

function urgencyOf(input: HeuristicInput, section: MailSection, entities: MailEntity[], now: number): number {
  let u = section === 'act' ? 40 : section === 'wait' ? 30 : section === 'fyi' ? 10 : 5
  for (const e of entities) {
    if (e.kind !== 'deadline' && e.kind !== 'time') continue
    const t = entityTime(e.value)
    if (t == null) continue
    const days = (startOfDay(t).getTime() - startOfDay(now).getTime()) / DAY
    const w = e.kind === 'deadline' ? 1 : 0.5
    if (days < 0 && days >= -2) u += 35 * w
    else if (days >= 0 && days <= 1) u += 45 * w
    else if (days > 1 && days <= 3) u += 30 * w
    else if (days > 3 && days <= 7) u += 15 * w
  }
  if (input.category === 'personal' && input.unread) u += 15
  if (input.flagged) u += 20
  if (input.pinned) u += 15
  if (input.awaitingReply) u += Math.min(20, Math.floor((now - input.awaitingReply.since) / DAY) * 3)
  if (entities.some(e => e.kind === 'code') && now - input.date < 15 * 60_000) u += 30
  if (now - input.date > 3 * DAY) u -= 10
  return Math.max(0, Math.min(100, Math.round(u)))
}

// ---------------- 入口 ----------------

/** 启发式邮件理解：纯函数，相同输入得到相同输出 */
export function heuristicInsight(input: HeuristicInput): MailInsight {
  const now = input.now ?? Date.now()
  const entities = extractEntities(input)
  const { section, bundle } = sectionOf(input, bundleOf(input), entities, now)
  const gist = makeGist(input.subject, input.text, input.snippet, entities)
  const { next, quickReply } = buildNext(input, section, bundle, entities, now)
  // 荧光句：含截止/金额/时间的原句（必须逐字出现在正文中）
  const body = input.text || ''
  const highlights = section === 'bundle' && bundle !== 'notification'
    ? []
    : sentencesOf(body)
        .filter(s => [...s].length <= 80 && body.includes(s))
        .filter(s => entities.some(e => (e.kind === 'deadline' || e.kind === 'money' || e.kind === 'time') && s.includes(e.label)))
        .slice(0, 3)
  return {
    messageId: input.messageId,
    section,
    bundle,
    gist,
    gistKey: pickGistKey(gist, entities),
    urgency: urgencyOf(input, section, entities, now),
    entities,
    highlights,
    next,
    quickReply,
    source: 'heuristic',
    updatedAt: now
  }
}
