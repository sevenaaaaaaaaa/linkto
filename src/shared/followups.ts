import type { FollowupData, FollowupKind, FollowupStatus } from './types'

/**
 * 跟进闭环的纯函数（主进程服务 / 渲染端 / 单测共用，不依赖 electron 与数据库）：
 * 状态机、到期计算、回复匹配、规则推断（在等什么）、催促模板。
 */

export const DAY_MS = 864e5
export const DEFAULT_WAIT_DAYS = 3
export const DEFAULT_MAX_ATTEMPTS = 2
/** 回复匹配的时间容差：来信时间早于发出时间这么多以内仍算（时钟偏差 / 服务器时间） */
const SKEW_MS = 5 * 60_000

export const FOLLOWUP_KIND_LABEL: Record<FollowupKind, string> = {
  reply: '等回复',
  invoice: '等开票',
  payment: '等付款',
  document: '等资料',
  unsubscribe: '等退订确认',
  general: '其他'
}

/** 活动记录用的名词：「xx 回复了你的催开票邮件」 */
export const FOLLOWUP_KIND_NOUN: Record<FollowupKind, string> = {
  reply: '',
  invoice: '催开票',
  payment: '催付款',
  document: '要资料',
  unsubscribe: '退订',
  general: ''
}

export const FOLLOWUP_STATUS_LABEL: Record<FollowupStatus, string> = {
  drafted: '待发出',
  waiting: '等待中',
  overdue: '已逾期',
  replied: '已回复',
  closed: '已解决',
  cancelled: '已取消'
}

const KINDS: FollowupKind[] = ['reply', 'invoice', 'payment', 'document', 'unsubscribe', 'general']
export const isFollowupKind = (v: unknown): v is FollowupKind => typeof v === 'string' && (KINDS as string[]).includes(v)

/** 进行中（insights 行 status=open）：drafted / waiting / overdue / replied（回了但用户还没点「已解决」） */
export function isActive(s: FollowupStatus): boolean {
  return s === 'drafted' || s === 'waiting' || s === 'overdue' || s === 'replied'
}

export function rowStatusOf(s: FollowupStatus): 'open' | 'done' {
  return isActive(s) ? 'open' : 'done'
}

/** 等待天数：1~60，非法值回落到默认 3 天 */
export function clampWaitDays(v: unknown, fallback = DEFAULT_WAIT_DAYS): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(60, n)
}

export function clampMaxAttempts(v: unknown, fallback = DEFAULT_MAX_ATTEMPTS): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(5, n)
}

/** 到期时间 = 发出（或重新开始等待）的时刻 + 等待天数 */
export function dueAtFor(from: number, waitDays: number): number {
  return from + clampWaitDays(waitDays) * DAY_MS
}

/** 已经等了几天（整天，向下取整） */
export function waitedDays(sentAt: number | null | undefined, now: number): number {
  if (!sentAt) return 0
  return Math.max(0, Math.floor((now - sentAt) / DAY_MS))
}

/** 逾期几天（未到期为 0） */
export function overdueDays(dueAt: number | null | undefined, now: number): number {
  if (!dueAt || now < dueAt) return 0
  return Math.max(1, Math.floor((now - dueAt) / DAY_MS) + 1)
}

// ---------------------------------------------------------------- 状态机

export type FollowupEvent =
  /** 真正发出（首发或再催的那封）：drafted / waiting / overdue → waiting，重新计算 dueAt */
  | { type: 'sent'; at: number; sentHeaderId?: string | null; sentMessageId?: string | null; threadId?: string | null; nudge?: boolean }
  /** 对方来信：waiting / overdue → replied */
  | { type: 'reply'; at: number; messageId: string; matchedBy: 'header' | 'thread' | 'subject'; invoiceHint?: boolean }
  /** 到期检查：waiting 且 at ≥ dueAt → overdue */
  | { type: 'due'; at: number }
  /** 为逾期的跟进起草了下一封催促（未发送）：attempts+1 */
  | { type: 'nudged'; at: number; draftId: string }
  /** 延后 N 天：waiting / overdue / replied → waiting，dueAt = at + N 天 */
  | { type: 'snooze'; at: number; days: number }
  | { type: 'close'; at: number }
  | { type: 'cancel'; at: number }

export interface FollowupState {
  data: FollowupData
  dueAt: number | null
}

/**
 * 状态转移（纯函数）：不合法的转移返回 null（调用方忽略），合法时返回新的 data 与 dueAt。
 * drafted →(sent) waiting →(due) overdue →(nudged…sent) waiting …；waiting/overdue →(reply) replied；任何进行中 →(close) closed。
 */
export function transition(cur: FollowupState, ev: FollowupEvent): FollowupState | null {
  const d = cur.data
  const s = d.status
  switch (ev.type) {
    case 'sent': {
      if (s !== 'drafted' && s !== 'waiting' && s !== 'overdue') return null
      const isNudge = ev.nudge ?? s !== 'drafted'
      return {
        data: {
          ...d,
          status: 'waiting',
          sentAt: isNudge ? d.sentAt ?? ev.at : ev.at,
          sentHeaderId: isNudge ? d.sentHeaderId ?? ev.sentHeaderId ?? null : ev.sentHeaderId ?? d.sentHeaderId ?? null,
          sentMessageId: isNudge ? d.sentMessageId ?? ev.sentMessageId ?? null : ev.sentMessageId ?? d.sentMessageId ?? null,
          threadId: d.threadId ?? ev.threadId ?? null,
          draftId: null,
          nudgeDraftId: null,
          nudgesSent: (d.nudgesSent ?? 0) + (isNudge ? 1 : 0),
          lastNudgeAt: isNudge ? ev.at : d.lastNudgeAt ?? null
        },
        dueAt: dueAtFor(ev.at, d.waitDays)
      }
    }
    case 'reply': {
      if (s !== 'waiting' && s !== 'overdue') return null
      return {
        data: { ...d, status: 'replied', repliedMessageId: ev.messageId, repliedAt: ev.at, matchedBy: ev.matchedBy, ...(ev.invoiceHint ? { invoiceHint: true } : {}) },
        dueAt: cur.dueAt
      }
    }
    case 'due': {
      if (s !== 'waiting' || !cur.dueAt || ev.at < cur.dueAt) return null
      return { data: { ...d, status: 'overdue' }, dueAt: cur.dueAt }
    }
    case 'nudged': {
      if (s !== 'overdue') return null
      return { data: { ...d, attempts: (d.attempts ?? 0) + 1, lastNudgeAt: ev.at, nudgeDraftId: ev.draftId }, dueAt: cur.dueAt }
    }
    case 'snooze': {
      if (s !== 'waiting' && s !== 'overdue' && s !== 'replied') return null
      return { data: { ...d, status: 'waiting', repliedMessageId: s === 'replied' ? null : d.repliedMessageId ?? null }, dueAt: ev.at + Math.max(1, Math.round(ev.days)) * DAY_MS }
    }
    case 'close': {
      if (s === 'closed' || s === 'cancelled') return null
      return { data: { ...d, status: 'closed', closedAt: ev.at }, dueAt: cur.dueAt }
    }
    case 'cancel': {
      if (s === 'closed' || s === 'cancelled') return null
      return { data: { ...d, status: 'cancelled', closedAt: ev.at }, dueAt: cur.dueAt }
    }
  }
}

/** 该不该自动起草下一封催促：逾期、次数没用完、手里没有一封还没发的催促草稿 */
export function shouldAutoNudge(d: FollowupData, hasLiveNudgeDraft: boolean): boolean {
  return d.status === 'overdue' && (d.attempts ?? 0) < (d.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) && !hasLiveNudgeDraft
}

/** 这一次到期是否还没提醒过 */
export function shouldNotifyOverdue(d: FollowupData, dueAt: number | null): boolean {
  return d.status === 'overdue' && !!dueAt && d.notifiedDueAt !== dueAt
}

// ---------------------------------------------------------------- 回复匹配

/** Message-ID 规范化：去尖括号、空白，小写 */
export function normMsgId(v: string | null | undefined): string {
  return String(v ?? '')
    .trim()
    .replace(/^<|>$/g, '')
    .toLowerCase()
}

/** 主题规范化：去掉 Re / 回复 / Fwd / 转发 等前缀（可叠加）与首尾空白，小写 */
export function normSubject(s: string | null | undefined): string {
  let v = String(s ?? '').trim()
  for (let i = 0; i < 6; i++) {
    const next = v.replace(/^(re|fw|fwd|aw|sv|wg|回复|答复|回覆|转发|轉發)\s*(\[\d+\])?\s*[:：]\s*/i, '').trim()
    if (next === v) break
    v = next
  }
  return v.replace(/\s+/g, ' ').toLowerCase()
}

/** 自动回复 / 休假回复不算对方回了 */
export function isAutoReply(subject: string | null | undefined): boolean {
  return /自动回复|自動回覆|auto(matic)?[\s-]?reply|out of (the )?office|不在办公室|休假中|autoreply|abwesenheit/i.test(String(subject ?? ''))
}

const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|qq|163|126|foxmail|sina|sohu|yeah|aliyun|proton|protonmail)\./i

const domainOf = (addr: string) => addr.split('@')[1]?.toLowerCase() ?? ''

/** 来信地址算不算「对方」：在收件人里，或与某个收件人同一个公司域名（公共邮箱域名不算） */
export function isCounterparty(from: string, to: string[]): boolean {
  const f = from.trim().toLowerCase()
  if (!f) return false
  const list = to.map(x => x.trim().toLowerCase()).filter(Boolean)
  if (list.includes(f)) return true
  const dom = domainOf(f)
  return !!dom && !FREE_MAIL.test(dom) && list.some(t => domainOf(t) === dom)
}

export interface FollowupSent {
  sentHeaderId?: string | null
  sentMessageId?: string | null
  /** 起因邮件（回复的那封）：永远不算回复 */
  relatedMessageId?: string | null
  threadId?: string | null
  to: string[]
  subject: string
  sentAt?: number | null
}

export interface IncomingMail {
  id: string
  threadId?: string | null
  inReplyTo?: string | null
  references?: string[]
  from: string
  subject: string
  date: number
}

/**
 * 一封来信是不是对这条跟进的回复（纯函数）：
 * 必须来自「别人」（不是我自己的地址）、晚于发出时间、不是自动回复；然后按可信度依次看
 *  1) In-Reply-To / References 指向发出的那封（header）
 *  2) 同一会话 thread_id（thread）
 *  3) 规范化后同主题，且发件人是收件人之一 / 同公司域名（subject）
 */
export function matchReply(f: FollowupSent, m: IncomingMail, mine: Set<string>): 'header' | 'thread' | 'subject' | null {
  const from = m.from.trim().toLowerCase()
  if (!from || mine.has(from)) return null
  if (m.id === f.sentMessageId || m.id === f.relatedMessageId) return null
  if (f.sentAt && m.date < f.sentAt - SKEW_MS) return null
  if (isAutoReply(m.subject)) return null
  const hdr = normMsgId(f.sentHeaderId)
  if (hdr) {
    const refs = [m.inReplyTo, ...(m.references ?? [])].map(normMsgId)
    if (refs.includes(hdr)) return 'header'
  }
  // 会话 / 主题匹配没有直接证据：只认发出之后的来信（容差只给 header 匹配，避免把起因邮件本身当成回复）
  if (f.sentAt && m.date <= f.sentAt) return null
  if (f.threadId && m.threadId && f.threadId === m.threadId) return 'thread'
  const ns = normSubject(f.subject)
  if (ns.length >= 2 && ns === normSubject(m.subject) && isCounterparty(from, f.to)) return 'subject'
  return null
}

/** 回信像不像发票：带 PDF 附件，或主题 / 摘要提到发票 */
export function looksLikeInvoice(m: { subject?: string | null; snippet?: string | null; attachments?: { filename?: string | null; contentType?: string | null }[] }): boolean {
  if ((m.attachments ?? []).some(a => /pdf/i.test(a.contentType ?? '') || /\.(pdf|ofd)$/i.test(a.filename ?? ''))) return true
  return /发票|增值税|电子票|invoice|fapiao/i.test(`${m.subject ?? ''} ${m.snippet ?? ''}`)
}

// ---------------------------------------------------------------- 规则推断

/** 从主题 + 正文推断在等对方做什么类型的事 */
export function inferKind(text: string): FollowupKind {
  const t = text.slice(0, 4000)
  if (/退订|取消订阅|unsubscribe|注销账号|删除我的(数据|账号|信息)/i.test(t)) return 'unsubscribe'
  if (/开票|开具?发票|发票|invoice|fapiao/i.test(t)) return 'invoice'
  if (/付款|打款|汇款|回款|结算款|尾款|转账|payment|remit|wire/i.test(t)) return 'payment'
  if (/资料|材料|文件|附件|合同|报价|简历|截图|数据|清单|send (me|over)|share (the|your)|documents?|files?|quote/i.test(t)) return 'document'
  return 'reply'
}

const ASK_RE = /(请|麻烦|烦请|劳烦|能否|可否|是否可以|是否能|希望|尽快|帮忙|帮我|please|could you|can you|would you|kindly|let me know)/i

/** 从正文里挑出「在等对方做什么」的一句话；挑不出来时按类型给一个默认说法 */
export function inferAsk(text: string, kind: FollowupKind): string {
  const sentences = text
    .replace(/\r/g, '')
    .split(/(?<=[。！？!?；;\n])|(?<=\.)\s+/)
    .map(s =>
      s
        .replace(/^[>\s\-*•]+/, '')
        // 「您好，请帮我…」：去掉开头的称呼 / 问候，留下请求本身
        .replace(/^(您好|你好|hi|hello|dear)[^，,。！!\n]{0,12}[，,！!]\s*/i, '')
        .trim()
    )
    .filter(s => s.length >= 4 && s.length <= 160 && !/^(您好|你好|hi|hello|dear|谢谢|best|regards|此致)/i.test(s))
  const hit = sentences.find(s => ASK_RE.test(s))
  if (hit) {
    // 从请求词所在的分句开始（「附上方案，麻烦确认排期」→「麻烦确认排期」）
    const at = hit.search(ASK_RE)
    const cut = Math.max(hit.lastIndexOf('，', at), hit.lastIndexOf(',', at))
    const clean = (cut >= 0 ? hit.slice(cut + 1) : hit).replace(/[。！？!?；;]+$/, '').trim()
    return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean
  }
  return { reply: '对方回复', invoice: '对方开具发票', payment: '对方付款', document: '对方发来资料', unsubscribe: '对方确认退订', general: '对方处理' }[kind]
}

// ---------------------------------------------------------------- 催促模板（AI 不可用时）

const md = (t: number) => {
  const d = new Date(t)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 下一个工作日（跳过周末），给对方一个明确的时间点 */
export function nextWorkday(from: number, plusDays: number): number {
  const d = new Date(from + plusDays * DAY_MS)
  while (d.getDay() === 0 || d.getDay() === 6) d.setTime(d.getTime() + DAY_MS)
  return d.getTime()
}

/** 「在等什么」写给对方看：第三人称的「对方开具发票」→「请您开具发票」；本来就是请求句的保持原样 */
export function politeAsk(ask: string): string {
  const a = ask.trim().replace(/[。.!！]+$/, '')
  if (!a) return ''
  if (/^对方/.test(a)) return `请您${a.replace(/^对方/, '')}`
  if (/^(请|麻烦|烦请|劳烦|能否|可否|是否|希望|帮忙|帮我)/.test(a)) return a
  return `关于${a}，麻烦您看一下`
}

const normSubjectKeepCase = (s: string) => {
  let v = String(s ?? '').trim()
  for (let i = 0; i < 6; i++) {
    const next = v.replace(/^(re|fw|fwd|回复|答复|转发)\s*[:：]\s*/i, '').trim()
    if (next === v) break
    v = next
  }
  return v
}

/**
 * 模板催促（纯文本，段落之间空一行）：第 1 封礼貌提醒，第 2 封起更明确（给出时间点、说明卡着什么、给低门槛的回复方式）。
 */
export function nudgeTemplate(input: { kind: FollowupKind; ask: string; subject: string; sentAt?: number | null; attempt: number; toName?: string | null; now: number }): { subject: string; text: string } {
  const who = input.toName?.trim() ? `${input.toName.trim()}，您好` : '您好'
  const when = input.sentAt ? `${md(input.sentAt)}` : '之前'
  const what = politeAsk(input.ask) || '麻烦看一下这件事'
  const deadline = md(nextWorkday(input.now, input.attempt <= 1 ? 2 : 1))
  const base = /^(回复|re)\s*[:：]/i.test(input.subject) ? input.subject : `回复：${input.subject || '跟进'}`
  const lines =
    input.attempt <= 1
      ? [
          `${who}：`,
          `想跟进一下我在${when}发的「${normSubjectKeepCase(input.subject) || '此事'}」：${what}。`,
          `方便的话请在${deadline}前回复一下进展；如果已经处理了，直接回复「已处理」即可，谢谢！`
        ]
      : [
          `${who}：`,
          `再跟进一次${when}邮件里的事项：${what}。这件事目前卡着我们这边的后续安排，烦请在${deadline}前处理或告知预计时间。`,
          `如果需要我补充任何信息，或者应该找其他同事对接，直接回复这封邮件告诉我就好。谢谢！`
        ]
  return { subject: base, text: lines.join('\n\n') }
}
