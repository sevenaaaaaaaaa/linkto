// 项目 / 时间线：主进程与渲染进程共用的形状与纯函数（归并打分、时间线聚合、规则版摘要）
// 纯函数不碰数据库与 DOM，便于单测；数据由主进程从 SQLite 取出后喂进来

import type { Address, FinanceData, FinanceKind, InsightRecord, ProjectData, ProjectMilestone, ProjectSummary } from './types'

// =====================================================================
// 一、IPC 形状
// =====================================================================

/** insights 表 kind='project' 的一行（data 即 ProjectData） */
export interface ProjectRecord {
  id: string
  title: string
  /** insights.status：active / paused → open；done / archived → done */
  status: 'open' | 'done'
  createdAt: number
  dueAt: number | null
  data: ProjectData
}

export interface ProjectMoneyTotal {
  currency: string
  /** 我收到的（应收 + 已收） */
  in: number
  /** 我付出的（应付 + 已付） */
  out: number
  /** 未结清（pending / overdue） */
  pending: number
}

export interface ProjectStats {
  messageCount: number
  threadCount: number
  unread: number
  lastAt: number | null
  lastSubject: string
  lastFrom: string
  lastGist: string | null
  openTodos: number
  doneTodos: number
  /** 关联款项合计（没有 finance 记录时为 null，界面不显示） */
  finance: { count: number; totals: ProjectMoneyTotal[] } | null
  attachments: number
}

export interface ProjectListItem extends ProjectRecord {
  stats: ProjectStats
}

export interface ProjectConversation {
  threadId: string
  latestId: string
  accountId: string
  subject: string
  participants: string[]
  count: number
  unread: number
  lastAt: number
  gist: string | null
  gistKey: string | null
  hasAttachments: boolean
  /** 最后一封是我发的 */
  fromMe: boolean
}

export type AttachmentKind = 'quote' | 'contract' | 'invoice' | 'receipt' | 'po' | 'delivery' | 'file'

export interface ProjectAttachment {
  id: string
  messageId: string
  filename: string
  contentType: string
  size: number
  date: number
  kind: AttachmentKind
}

export interface ProjectDetail extends ProjectListItem {
  conversations: ProjectConversation[]
  todos: InsightRecord[]
  finance: InsightRecord[]
  attachments: ProjectAttachment[]
  /** 规则版摘要（每次即时计算）；AI 版在 data.summary */
  ruleSummary: ProjectSummary
}

/** 「发现项目」候选（AI 聚类或按对方域名的规则聚类），用户确认后才建 */
export interface ProjectCandidate {
  key: string
  name: string
  /** 对方显示名（公司 / 人） */
  counterparty: string
  counterparties: string[]
  keywords: string[]
  threadIds: string[]
  messageIds: string[]
  subjects: string[]
  firstAt: number
  lastAt: number
  messageCount: number
  why: string
  source: 'ai' | 'heuristic'
}

export type TimelineKind = 'mail' | 'attachment' | 'todo' | 'finance' | 'milestone'

export interface TimelineEvent {
  id: string
  kind: TimelineKind
  at: number
  title: string
  /** 关键短语（AI 要点里荧光标出的部分，必须是 title 的子串） */
  titleKey?: string | null
  /** 谁 → 谁 / 金额说明 / 附件大小 */
  detail?: string
  /** mail：in 收到 · out 我发出；finance：in 收款 · out 付款 */
  direction?: 'in' | 'out'
  /** 细分：附件类型 / created|done（待办）/ 款项类型 */
  sub?: string
  status?: string
  messageId?: string
  threadId?: string
  todoId?: string
  financeId?: string
  milestoneId?: string
  attachmentId?: string
  amount?: { value: number; currency: string } | null
  unread?: boolean
}

export interface ContactTimeline {
  key: string
  /** 地址或域名 */
  mode: 'address' | 'domain'
  name: string
  domain: string | null
  messageCount: number
  events: TimelineEvent[]
  /** 这个联系人 / 公司已在哪些项目里 */
  projects: { id: string; name: string; color: string | null }[]
}

// =====================================================================
// 二、地址 / 主题工具
// =====================================================================

/** 个人邮箱服务商：这些域名不能当「公司」，只能按完整地址归并 */
export const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sina.cn', 'sohu.com',
  '139.com', '189.cn', 'aliyun.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'yahoo.com', 'yahoo.co.jp', 'proton.me', 'protonmail.com', 'pm.me', 'zoho.com', 'mail.com', 'gmx.com', 'yandex.com'
])

const ROBOT_ADDR = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|notice|news(letter)?|marketing|hello)([+.-]|@)/i

export function domainOf(addr: string | null | undefined): string {
  if (!addr) return ''
  const i = addr.lastIndexOf('@')
  return i < 0 ? '' : addr.slice(i + 1).trim().toLowerCase()
}

export function isPublicDomain(domain: string): boolean {
  return PUBLIC_MAIL_DOMAINS.has(domain.toLowerCase())
}

export function isRobotAddr(addr: string): boolean {
  return ROBOT_ADDR.test(addr)
}

/** 对方「主键」：公司域名（企业邮箱）或完整地址（个人邮箱） */
export function counterpartyKey(addr: string): string {
  const a = addr.trim().toLowerCase()
  const d = domainOf(a)
  if (!d) return a
  return isPublicDomain(d) ? a : d
}

/** 域名命中：完全相同，或是子域（news.acme.example 命中 acme.example） */
export function domainMatches(domain: string, key: string): boolean {
  if (!domain || !key || key.includes('@')) return false
  return domain === key || domain.endsWith(`.${key}`)
}

/** 去掉 Re: / Fwd: / 回复： / 转发： 等前缀 */
export function normalizeSubject(subject: string): string {
  let s = (subject || '').trim()
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/^\s*(re|fw|fwd|aw|wg|sv|答复|回复|转发|回覆|轉寄)\s*(\[\d+\])?\s*[:：]\s*/i, '').trim()
    if (next === s) break
    s = next
  }
  return s.replace(/^(\[[^\]]{1,24}\]|【[^】]{1,24}】)\s*/, '').trim()
}

const KW_STOP = new Set([
  '回复', '转发', '关于', '请查收', '查收', '附件', '通知', '你好', '您好', '谢谢', '感谢', '确认', '一下', '问题', '邮件', '更新', '跟进',
  're', 'fw', 'fwd', 'the', 'and', 'for', 'with', 'from', 'your', 'our', 'update', 'hello', 'hi', 'thanks', 'please', 'question'
])

/** 主题 → 关键词（项目名 / 编号类优先）：最多 n 个，每个 2~16 字 */
export function extractKeywords(subject: string, n = 3): string[] {
  const s = normalizeSubject(subject)
  const out: string[] = []
  const push = (k: string) => {
    const t = k.trim().replace(/^[#\s]+|[\s.。]+$/g, '')
    if ([...t].length < 2 || [...t].length > 16) return
    if (KW_STOP.has(t.toLowerCase())) return
    if (/^\d+([./-]\d+)*$/.test(t)) return // 纯数字 / 日期
    if (out.some(o => o.toLowerCase() === t.toLowerCase() || o.includes(t))) return
    out.push(t)
  }
  // 编号：PO-2026-018 / HT2026001 / #1042
  const CODE = /\b[A-Z]{2,}[-_]?\d{2,}(?:[-_]\d+)*\b/g
  for (const m of s.matchAll(CODE)) push(m[0])
  // 去掉时间说法（明天 15:00 / 周三 / 下午），它们不是「这件事」的特征
  const rest = s
    .replace(CODE, ' ')
    .replace(/\d{1,2}[:：]\d{2}/g, ' ')
    .replace(/(今天|明天|后天|昨天|本周|下周|上周|周[一二三四五六日天]|星期[一二三四五六日天]|上午|下午|晚上|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?)/g, ' ')
  for (const seg of rest.split(/[，,。:：|/\\()（）【】[\]！!？?;；~·—–\-_"“”'‘’<>《》]+/)) {
    const t = seg.trim()
    if (!t) continue
    // 中文整段保留（≤16 字，切词不稳妥）；中英混排的长段再按空格拆
    if ([...t].length > 8 && /\s/.test(t)) for (const w of t.split(/\s+/)) push(w)
    else push(t)
    if (out.length >= n) break
  }
  return out.slice(0, n)
}

// =====================================================================
// 三、自动归并打分
// =====================================================================

export interface MatchMessage {
  id: string
  threadId: string
  subject: string
  /** 正文片段（≤2000 字即可） */
  body: string
  /** 对方地址（已去掉自己的地址），小写 */
  participants: string[]
  isNewsletter?: boolean
  category?: string
  date?: number
}

export interface MatchProject {
  id: string
  name: string
  status: ProjectData['status']
  auto: boolean
  counterparties: string[]
  keywords: string[]
  members?: string[]
  threadIds: string[]
  messageIds: string[]
  excludedThreadIds?: string[]
  /** 项目开始时间：早于它 30 天以上的邮件只认同一会话，不按对方 / 关键词归入 */
  startedAt?: number | null
}

export interface MatchScore {
  projectId: string
  score: number
  reasons: string[]
  /** 命中了对方（地址或域名） */
  partyHit: boolean
  thread: boolean
}

/** 自动归入阈值 / 建议阈值 / 第一名领先第二名至少多少分才敢自动归 */
export const MATCH_AUTO = 70
export const MATCH_SUGGEST = 35
export const MATCH_MARGIN = 15

/**
 * 单个项目的归并分（0~100）：
 *  线程已在项目中 = 100（确定）
 *  > 对方完整地址 55 · 项目成员 45 · 对方企业域名命中 40
 *  > 关键词：主题命中 35（每多一个 +10，上限 55）· 正文命中 12（每多一个 +6，上限 24）
 *  订阅 / 噪声邮件分数减半
 */
export function scoreProject(m: MatchMessage, p: MatchProject): MatchScore {
  const base: MatchScore = { projectId: p.id, score: 0, reasons: [], partyHit: false, thread: false }
  if (p.excludedThreadIds?.includes(m.threadId)) return base
  if (p.threadIds.includes(m.threadId) || p.messageIds.includes(m.id)) return { ...base, score: 100, reasons: ['同一会话'], thread: true }
  if (p.startedAt && m.date && m.date < p.startedAt - 30 * 86_400_000) return base
  let score = 0
  const reasons: string[] = []
  const cps = p.counterparties.map(c => c.trim().toLowerCase()).filter(Boolean)
  const members = (p.members ?? []).map(a => a.toLowerCase())
  // 明确设为「对方」的地址 55；只是会话里出现过的成员 45（同一个人也可能聊别的事）
  const addrHit = m.participants.find(a => cps.includes(a))
  const memberHit = addrHit ? null : m.participants.find(a => members.includes(a))
  let partyHit = false
  if (addrHit || memberHit) {
    score += addrHit ? 55 : 45
    reasons.push(`对方 ${addrHit ?? memberHit}`)
    partyHit = true
  } else {
    for (const a of m.participants) {
      const d = domainOf(a)
      if (!d || isPublicDomain(d)) continue
      const hit = cps.find(c => domainMatches(d, c))
      if (hit) {
        score += 40
        reasons.push(`对方域名 ${hit}`)
        partyHit = true
        break
      }
    }
  }
  const subj = normalizeSubject(m.subject).toLowerCase()
  const body = (m.body || '').toLowerCase()
  const kws = p.keywords.map(k => k.trim()).filter(k => [...k].length >= 2)
  const subjHits = kws.filter(k => subj.includes(k.toLowerCase()))
  const bodyHits = kws.filter(k => !subjHits.includes(k) && body.includes(k.toLowerCase()))
  if (subjHits.length) {
    score += Math.min(55, 35 + (subjHits.length - 1) * 10)
    reasons.push(`主题含「${subjHits.slice(0, 2).join('」「')}」`)
  }
  if (bodyHits.length) {
    score += Math.min(24, 12 + (bodyHits.length - 1) * 6)
    reasons.push(`正文提到「${bodyHits.slice(0, 2).join('」「')}」`)
  }
  if (m.isNewsletter || m.category === 'noise' || m.category === 'newsletter') score = Math.round(score / 2)
  return { ...base, score: Math.min(99, score), reasons, partyHit }
}

export type MatchDecision =
  | { action: 'none' }
  | { action: 'auto' | 'suggest'; projectId: string; score: number; reason: string }

/**
 * 在所有可归的项目里挑一个：
 *  - 同一会话 → 直接归入
 *  - 只有一个项目命中对方时 +15（对方专属）
 *  - 分数 ≥ 70、项目允许自动、且领先第二名 ≥ 15 → 自动归入
 *  - 分数 ≥ 35 → 进「建议归入」队列
 *  - 已归档 / 已完成的项目不参与
 */
export function decideMatch(m: MatchMessage, projects: MatchProject[]): MatchDecision {
  const live = projects.filter(p => p.status === 'active' || p.status === 'paused')
  const scored = live.map(p => scoreProject(m, p)).filter(s => s.score > 0)
  if (!scored.length) return { action: 'none' }
  const thread = scored.find(s => s.thread)
  if (thread) return { action: 'auto', projectId: thread.projectId, score: 100, reason: '同一会话' }
  const partyHits = scored.filter(s => s.partyHit)
  if (partyHits.length === 1) {
    partyHits[0].score = Math.min(99, partyHits[0].score + 15)
    partyHits[0].reasons.push('对方只在这个项目里')
  }
  scored.sort((a, b) => b.score - a.score)
  const [top, second] = scored
  const proj = live.find(p => p.id === top.projectId)!
  const reason = top.reasons.join(' · ')
  const lead = second ? top.score - second.score : top.score
  if (top.score >= MATCH_AUTO && proj.auto && proj.status === 'active' && lead >= MATCH_MARGIN) return { action: 'auto', projectId: top.projectId, score: top.score, reason }
  if (top.score >= MATCH_SUGGEST) return { action: 'suggest', projectId: top.projectId, score: top.score, reason }
  return { action: 'none' }
}

// =====================================================================
// 四、时间线：事件构建 + 按天 / 周分组 + 折叠空白期
// =====================================================================

export function classifyAttachment(filename: string): AttachmentKind {
  const f = (filename || '').toLowerCase()
  if (/发票|invoice|fapiao|\binv[-_ ]?\d/.test(f)) return 'invoice'
  if (/回单|水单|收据|receipt|remittance|付款凭证|银行回执/.test(f)) return 'receipt'
  if (/合同|协议|contract|agreement|\bsow\b|nda/.test(f)) return 'contract'
  if (/报价|询价|quotation|quote|\bqtn\b|price ?list|价目/.test(f)) return 'quote'
  if (/采购订单|订单|purchase ?order|\bpo[-_ ]?\d/.test(f)) return 'po'
  if (/交付|验收|delivery|acceptance|交接|里程碑/.test(f)) return 'delivery'
  return 'file'
}

export const ATTACHMENT_KIND_LABEL: Record<AttachmentKind, string> = {
  quote: '报价',
  contract: '合同',
  invoice: '发票',
  receipt: '回单',
  po: '订单',
  delivery: '交付',
  file: '文件'
}

export const FINANCE_KIND_LABEL: Record<FinanceKind, string> = {
  bill: '账单',
  subscription: '订阅',
  order: '订单',
  invoice: '开票',
  payment: '付款',
  receipt: '回单',
  refund: '退款'
}

export interface TLMessage {
  id: string
  threadId: string
  date: number
  fromAddr: string
  fromName: string
  to: Address[]
  subject: string
  gist?: string | null
  gistKey?: string | null
  fromMe: boolean
  unread?: boolean
}

export interface TLAttachment {
  id: string
  messageId: string
  filename: string
  size: number
}

export interface TLTodo {
  id: string
  title: string
  createdAt: number
  status: string
  dueAt: number | null
  doneAt?: number | null
  messageId?: string | null
}

export interface TLFinance {
  id: string
  title: string
  createdAt: number
  data: FinanceData
}

const shortName = (name: string, addr: string) => (name || '').trim() || (addr || '').split('@')[0] || addr

export function buildTimeline(input: {
  messages: TLMessage[]
  attachments?: TLAttachment[]
  todos?: TLTodo[]
  finance?: TLFinance[]
  milestones?: ProjectMilestone[]
}): TimelineEvent[] {
  const out: TimelineEvent[] = []
  const msgById = new Map(input.messages.map(m => [m.id, m]))
  for (const m of input.messages) {
    const toNames = m.to.map(a => shortName(a.name ?? '', a.address))
    const to = toNames.length > 2 ? `${toNames.slice(0, 2).join('、')} 等 ${toNames.length} 人` : toNames.join('、')
    const gist = m.gist?.trim()
    out.push({
      id: `m:${m.id}`,
      kind: 'mail',
      at: m.date,
      title: gist || normalizeSubject(m.subject) || '（无主题）',
      titleKey: gist && m.gistKey && gist.includes(m.gistKey) ? m.gistKey : null,
      detail: `${m.fromMe ? '我' : shortName(m.fromName, m.fromAddr)} → ${to || '—'}`,
      direction: m.fromMe ? 'out' : 'in',
      messageId: m.id,
      threadId: m.threadId,
      unread: !!m.unread
    })
  }
  for (const a of input.attachments ?? []) {
    const m = msgById.get(a.messageId)
    if (!m) continue
    const kind = classifyAttachment(a.filename)
    out.push({
      id: `a:${a.id}`,
      kind: 'attachment',
      at: m.date,
      title: a.filename,
      detail: `${ATTACHMENT_KIND_LABEL[kind]} · ${fmtBytes(a.size)}`,
      direction: m.fromMe ? 'out' : 'in',
      sub: kind,
      messageId: m.id,
      threadId: m.threadId,
      attachmentId: a.id
    })
  }
  for (const t of input.todos ?? []) {
    if (t.status === 'dismissed') continue
    out.push({ id: `t:${t.id}:c`, kind: 'todo', at: t.createdAt, title: t.title, detail: t.dueAt ? `新待办 · 截止 ${fmtMonthDay(t.dueAt)}` : '新待办', sub: 'created', status: t.status, todoId: t.id, messageId: t.messageId ?? undefined })
    if (t.status === 'done' && t.doneAt) out.push({ id: `t:${t.id}:d`, kind: 'todo', at: t.doneAt, title: t.title, detail: '已完成', sub: 'done', status: 'done', todoId: t.id })
  }
  for (const f of input.finance ?? []) {
    const d = f.data
    const first = d.messageIds?.map(id => msgById.get(id)).find(Boolean)
    const at = first?.date ?? f.createdAt
    const amount = typeof d.amount === 'number' ? { value: d.amount, currency: d.currency || 'CNY' } : null
    const label = FINANCE_KIND_LABEL[d.kind] ?? '款项'
    out.push({
      id: `f:${f.id}`,
      kind: 'finance',
      at,
      title: `${label} · ${d.counterparty || f.title}`,
      detail: [amount ? fmtMoney(amount.value, amount.currency) : null, FINANCE_STATUS_LABEL[d.status] ?? d.status, d.invoiceNo ? `发票号 ${d.invoiceNo}` : d.contractNo ? `合同号 ${d.contractNo}` : null].filter(Boolean).join(' · '),
      direction: d.direction,
      sub: d.kind,
      status: d.status,
      financeId: f.id,
      messageId: first?.id,
      amount
    })
  }
  for (const ms of input.milestones ?? []) {
    out.push({ id: `ms:${ms.id}`, kind: 'milestone', at: ms.at, title: ms.title, detail: ms.done ? '已达成' : ms.at > Date.now() ? '计划' : '里程碑', status: ms.done ? 'done' : 'open', milestoneId: ms.id })
  }
  return out
}

export const FINANCE_STATUS_LABEL: Record<string, string> = {
  pending: '待结清',
  paid: '已结清',
  overdue: '已逾期',
  cancelled: '已取消',
  refunded: '已退款',
  disputed: '有争议'
}

export interface TimelineGroup {
  type: 'group'
  key: string
  label: string
  /** 「今天」「本周」等相对说明 */
  hint: string
  start: number
  events: TimelineEvent[]
}

export interface TimelineGap {
  type: 'gap'
  key: string
  days: number
  from: number
  to: number
}

export type TimelineRow = TimelineGroup | TimelineGap

const KIND_RANK: Record<TimelineKind, number> = { milestone: 0, mail: 1, attachment: 2, finance: 3, todo: 4 }
const DAY = 86_400_000
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六']

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 周一为一周开始 */
function startOfWeek(ts: number): number {
  const d = new Date(startOfDay(ts))
  const dow = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - dow)
  return d.getTime()
}

/** 两个本地零点之间相差的天数（跨夏令时也按日历天算） */
function dayDiff(a: number, b: number): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY)
}

function md(ts: number, withYear: boolean): string {
  const d = new Date(ts)
  return `${withYear ? `${d.getFullYear()}年` : ''}${d.getMonth() + 1}月${d.getDate()}日`
}

/**
 * 分组：按天 / 周归桶，组内按时间排；相邻两组之间空了 ≥ gapDays 天就插一条「空白期」折叠行。
 * order=desc 最新在上。kinds 为空表示不过滤。
 */
export function groupTimeline(
  events: TimelineEvent[],
  opts: { unit: 'day' | 'week'; kinds?: TimelineKind[] | null; order?: 'asc' | 'desc'; gapDays?: number; now?: number }
): TimelineRow[] {
  const order = opts.order ?? 'desc'
  const now = opts.now ?? Date.now()
  const gapDays = opts.gapDays ?? (opts.unit === 'week' ? 21 : 7)
  const kinds = opts.kinds && opts.kinds.length ? new Set(opts.kinds) : null
  const list = events.filter(e => !kinds || kinds.has(e.kind))
  const sign = order === 'asc' ? 1 : -1
  list.sort((a, b) => (a.at !== b.at ? (a.at - b.at) * sign : KIND_RANK[a.kind] - KIND_RANK[b.kind]))
  const bucketOf = opts.unit === 'week' ? startOfWeek : startOfDay
  const groups: TimelineGroup[] = []
  const byKey = new Map<number, TimelineGroup>()
  const thisYear = new Date(now).getFullYear()
  for (const e of list) {
    const start = bucketOf(e.at)
    let g = byKey.get(start)
    if (!g) {
      const withYear = new Date(start).getFullYear() !== thisYear
      let label: string
      let hint = ''
      if (opts.unit === 'week') {
        const end = start + 6 * DAY
        label = `${md(start, withYear)} – ${md(end, withYear && new Date(end).getFullYear() !== new Date(start).getFullYear())}`
        const w = Math.round((startOfWeek(now) - start) / (7 * DAY))
        hint = w === 0 ? '本周' : w === 1 ? '上周' : w === -1 ? '下周' : ''
      } else {
        label = `${md(start, withYear)} 周${WEEK_CN[new Date(start).getDay()]}`
        const d = dayDiff(start, now)
        hint = d === 0 ? '今天' : d === 1 ? '昨天' : d === -1 ? '明天' : ''
      }
      g = { type: 'group', key: `g:${start}`, label, hint, start, events: [] }
      byKey.set(start, g)
      groups.push(g)
    }
    g.events.push(e)
  }
  const rows: TimelineRow[] = []
  const unitDays = opts.unit === 'week' ? 7 : 1
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    if (i > 0) {
      const prev = groups[i - 1]
      const [early, late] = prev.start < g.start ? [prev, g] : [g, prev]
      const empty = dayDiff(early.start, late.start) - unitDays
      if (empty >= gapDays) rows.push({ type: 'gap', key: `gap:${early.start}:${late.start}`, days: empty, from: early.start + unitDays * DAY, to: late.start })
    }
    rows.push(g)
  }
  return rows
}

/** 各类型事件计数（筛选 chip 用） */
export function countKinds(events: TimelineEvent[]): Record<TimelineKind, number> {
  const out: Record<TimelineKind, number> = { mail: 0, attachment: 0, todo: 0, finance: 0, milestone: 0 }
  for (const e of events) out[e.kind]++
  return out
}

// =====================================================================
// 五、规则版摘要（未配置 AI 时）
// =====================================================================

export function ruleSummary(input: {
  messages: TLMessage[]
  openTodos: { title: string; dueAt: number | null }[]
  financePending?: { amount: number | null; currency: string; dueAt?: number | null; counterparty: string }[]
  now?: number
}): ProjectSummary {
  const now = input.now ?? Date.now()
  const msgs = [...input.messages].sort((a, b) => a.date - b.date)
  const last = msgs[msgs.length - 1]
  const sources: ProjectSummary['sources'] = []
  const cite = (m: TLMessage) => {
    let i = sources.findIndex(s => s.messageId === m.id)
    if (i < 0) {
      sources.push({ messageId: m.id, subject: normalizeSubject(m.subject) || '（无主题）', date: m.date })
      i = sources.length - 1
    }
    return `[${i + 1}]`
  }
  if (!last) {
    return { source: 'rule', progress: '项目里还没有邮件。', blocker: null, waitingOn: 'none', next: ['把相关邮件「加入项目」，或在设置里补上对方域名与关键词'], sources: [], lastMail: null, openTodos: input.openTodos.length, generatedAt: now }
  }
  const days = Math.max(0, dayDiff(last.date, now))
  const ago = days === 0 ? '今天' : days === 1 ? '昨天' : `${days} 天前`
  const toName = last.to.map(a => shortName(a.name ?? '', a.address))[0] ?? '对方'
  const lastFrom = last.fromMe ? '我' : shortName(last.fromName, last.fromAddr)
  const progress = `最后一封往来是 ${ago}${lastFrom}${last.fromMe ? `发给 ${toName}` : '发来'}的「${normalizeSubject(last.subject) || '（无主题）'}」${cite(last)}${last.gist ? `：${last.gist}` : ''}。共 ${msgs.length} 封邮件。`
  let waitingOn: ProjectSummary['waitingOn'] = 'none'
  let blocker: string | null = null
  if (last.fromMe) {
    waitingOn = 'them'
    blocker = days >= 3 ? `等 ${toName} 回复，已经 ${days} 天没动静 ${cite(last)}` : `等 ${toName} 回复 ${cite(last)}`
  } else {
    waitingOn = 'me'
    blocker = `${lastFrom} 的最新来信还没回 ${cite(last)}`
  }
  const next: string[] = []
  const todos = [...input.openTodos].sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
  if (waitingOn === 'me') next.push(`回复 ${lastFrom}：${normalizeSubject(last.subject)}`)
  if (waitingOn === 'them' && days >= 3) next.push(`跟进 ${toName}（已 ${days} 天未回）`)
  for (const t of todos.slice(0, 3)) next.push(t.dueAt ? `${t.title}（${t.dueAt < now ? '已逾期' : `截止 ${fmtMonthDay(t.dueAt)}`}）` : t.title)
  for (const f of (input.financePending ?? []).slice(0, 2)) {
    next.push(`款项待结清：${f.counterparty}${f.amount != null ? ` ${fmtMoney(f.amount, f.currency)}` : ''}${f.dueAt ? `（${f.dueAt < now ? '已逾期' : `应付 ${fmtMonthDay(f.dueAt)}`}）` : ''}`)
  }
  if (input.openTodos.length) blocker = `${blocker ?? ''}${blocker ? '；' : ''}还有 ${input.openTodos.length} 个待办未完成`
  return {
    source: 'rule',
    progress,
    blocker,
    waitingOn,
    next: next.slice(0, 5),
    sources,
    lastMail: { messageId: last.id, from: lastFrom, to: toName, subject: last.subject, date: last.date, fromMe: last.fromMe },
    openTodos: input.openTodos.length,
    generatedAt: now
  }
}

// =====================================================================
// 六、格式化（主进程与渲染进程共用）
// =====================================================================

export function fmtBytes(n: number): string {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function fmtMonthDay(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

const CURRENCY_SIGN: Record<string, string> = { CNY: '¥', RMB: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$' }

export function fmtMoney(value: number, currency = 'CNY'): string {
  const sign = CURRENCY_SIGN[currency.toUpperCase()]
  const num = value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  return sign ? `${sign}${num}` : `${num} ${currency}`
}

/** 项目色：存色名，界面用 --proj-l / --proj-c token + 色相拼 oklch（明暗由 token 决定） */
export const PROJECT_COLORS: { key: string; label: string; hue: number }[] = [
  { key: 'teal', label: '青', hue: 190 },
  { key: 'indigo', label: '靛', hue: 268 },
  { key: 'amber', label: '琥珀', hue: 70 },
  { key: 'rose', label: '玫瑰', hue: 12 },
  { key: 'green', label: '绿', hue: 148 },
  { key: 'violet', label: '紫', hue: 305 },
  { key: 'sky', label: '天蓝', hue: 232 },
  { key: 'clay', label: '陶土', hue: 40 }
]

export function projectHue(color: string | null | undefined, seed = ''): number {
  const hit = PROJECT_COLORS.find(c => c.key === color)
  if (hit) return hit.hue
  let h = 0
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % PROJECT_COLORS.length
  return PROJECT_COLORS[h].hue
}
