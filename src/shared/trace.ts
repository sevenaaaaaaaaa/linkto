/**
 * 留痕：把电话 / 微信 / 会议 / 当面等轻量、非正式但需要留下凭据的沟通，整理成可追溯的记录。
 *
 * 本文件是主进程与渲染端共用的数据模型与纯函数（无 Electron / Node 依赖）：
 *  - IM 聊天文本解析（微信 / 企业微信 / 钉钉 / 飞书 / Slack / WhatsApp / QQ 复制或导出的常见格式）
 *  - AI 整理结果的防编造校验（金额 / 日期必须在原始材料里出现过，否则降级为「待确认」）
 *  - 无 AI 时的模板整理（关键词抽取约定句，金额 / 日期逐字摘录）
 *  - 书面确认邮件生成、对方回信的确认 / 异议判断、状态机、Markdown 存档
 * 内容哈希（SHA-256）在主进程 src/main/trace/core.ts 计算，这里只给出规范化的哈希输入。
 */

// ---------------------------------------------------------------- 数据模型

/** 场景 */
export type TraceChannel = 'phone' | 'wechat' | 'meeting' | 'in-person' | 'im' | 'other'
export const TRACE_CHANNELS: TraceChannel[] = ['phone', 'wechat', 'meeting', 'in-person', 'im', 'other']
export const TRACE_CHANNEL_LABEL: Record<TraceChannel, string> = {
  phone: '电话',
  wechat: '微信',
  meeting: '会议',
  'in-person': '当面',
  im: '其他 IM',
  other: '其他'
}

/** 状态：草稿 → 已整理 → 已发确认 → 对方已确认 / 有异议 */
export type TraceStatus = 'draft' | 'organized' | 'sent' | 'confirmed' | 'disputed'
export const TRACE_STATUSES: TraceStatus[] = ['draft', 'organized', 'sent', 'confirmed', 'disputed']
export const TRACE_STATUS_LABEL: Record<TraceStatus, string> = {
  draft: '草稿',
  organized: '已整理',
  sent: '已发确认',
  confirmed: '对方已确认',
  disputed: '有异议'
}

export interface TraceParty {
  name: string
  email?: string | null
  /** 用户本人 */
  me?: boolean
}

/** 解析出的一条聊天消息 */
export interface ChatLine {
  speaker: string
  /** 原文里的时间写法（如「10/18 14:32」「昨天 下午3:05」） */
  time: string | null
  /** 解析出的时间戳（解析不了为 null） */
  at: number | null
  text: string
}

export type TraceMaterialKind = 'chat' | 'text' | 'ocr' | 'note' | 'mail'
export const TRACE_MATERIAL_LABEL: Record<TraceMaterialKind, string> = {
  chat: '聊天记录',
  text: '粘贴文字',
  ocr: '截图识字',
  note: '手写备注',
  mail: '邮件'
}

/** 原始材料：只追加，整理结果必须能在这里找到依据 */
export interface TraceMaterial {
  id: string
  kind: TraceMaterialKind
  text: string
  label?: string | null
  /** kind=chat：解析出的消息 */
  lines?: ChatLine[] | null
  /** 识别到的聊天格式（说明用） */
  pattern?: string | null
  /** kind=mail：来源邮件 */
  messageId?: string | null
  /** kind=ocr：截图文件名 / 识字方式 */
  fileName?: string | null
  ocrMethod?: string | null
  addedAt: number
}

/** 一条约定事项：谁、做什么、何时、金额 */
export interface TraceAgreement {
  who: string
  what: string
  when?: string | null
  amount?: string | null
  /** 支撑这条的原文片段 */
  quote?: string | null
  /** 校验标记：amount-unverified / when-unverified / what-number */
  flags?: string[]
}

export interface TraceSummary {
  conclusion: string
  agreements: TraceAgreement[]
  /** 待确认点 */
  pending: string[]
  /** 风险提示 */
  risks: string[]
  by: 'ai' | 'template' | 'manual' | 'agent'
  at: number
  /** 校验提示（如「AI 给出的金额在材料里找不到，已改为待确认」） */
  warnings?: string[]
}

export interface TraceLinks {
  messageIds: string[]
  followupIds: string[]
  todoIds: string[]
  projectIds: string[]
  financeIds: string[]
}

/** 书面确认：起草 → 发出 → 对方回信（确认 / 异议） */
export interface TraceConfirm {
  followupId: string | null
  draftId: string | null
  to: string[]
  subject: string
  draftedAt: number
  sentAt?: number | null
  replyMessageId?: string | null
  replyAt?: number | null
  verdict?: 'confirmed' | 'disputed' | null
  /** 判断依据（命中的词） */
  evidence?: string[]
}

/** 参与哈希的内容（标题 + 场景 + 时间 + 参与人 + 原始材料 + 整理结果） */
export interface TraceContent {
  title: string
  channel: TraceChannel
  occurredAt: number | null
  parties: TraceParty[]
  materials: TraceMaterial[]
  summary: TraceSummary | null
}

/** 历史版本：修改前的完整内容 + 当时的哈希 */
export interface TraceVersion {
  at: number
  hash: string
  reason: string
  content: TraceContent
}

export interface TraceData {
  channel: TraceChannel
  occurredAt: number | null
  parties: TraceParty[]
  materials: TraceMaterial[]
  summary: TraceSummary | null
  status: TraceStatus
  links: TraceLinks
  confirm: TraceConfirm | null
  /** 之前几轮书面确认（有异议改正后重发时，旧的一轮留在这里） */
  confirmHistory?: TraceConfirm[]
  /** 当前内容的 SHA-256（hex） */
  hash: string
  hashAlgo: 'sha256'
  /** 首次记录时的哈希与时间（不随修改变化） */
  firstHash: string
  createdAt: number
  versions: TraceVersion[]
  source: 'manual' | 'mail' | 'agent' | 'capture'
  /** 已写入 Agent 记忆（承诺）的条目 */
  memoryIds?: string[]
  device?: string | null
  updatedAt?: number
}

/** 界面 / IPC 用的一条留痕 */
export interface TraceRecord {
  id: string
  title: string
  createdAt: number
  data: TraceData
}

/** 新建入参 */
export interface TraceInput {
  title?: string
  channel?: TraceChannel
  occurredAt?: number | null
  parties?: TraceParty[]
  materials?: Omit<TraceMaterial, 'id' | 'addedAt'>[]
  summary?: Omit<TraceSummary, 'at' | 'by'> & { by?: TraceSummary['by'] }
  messageIds?: string[]
  projectIds?: string[]
  financeIds?: string[]
  source?: TraceData['source']
}

/** 跨设备同步状态 */
export interface TraceSyncStatus {
  enabled: boolean
  /** 待办同步已设好同步邮箱（与口令）：留痕复用同一设置 */
  ready: boolean
  readyReason?: string | null
  accountId: string | null
  encrypt: boolean
  running: boolean
  lastSyncAt: number | null
  lastError: string | null
  folder: string
  lastStats?: { pulled: number; pushed: number; removed: number; at: number } | null
}

/** 留痕同步用的隐藏文件夹（与待办的 LinkTo-Sync 分开，旧版本 / 手机端不会把留痕当成待办） */
export const TRACE_SYNC_FOLDER = 'LinkTo-Trace'

export function isTraceSyncFolder(path: string | undefined | null): boolean {
  if (!path) return false
  const last = path.split(/[/.]/).pop() ?? path
  return last.toLowerCase() === TRACE_SYNC_FOLDER.toLowerCase()
}

export const emptyLinks = (): TraceLinks => ({ messageIds: [], followupIds: [], todoIds: [], projectIds: [], financeIds: [] })

export function isTraceChannel(v: unknown): v is TraceChannel {
  return typeof v === 'string' && (TRACE_CHANNELS as string[]).includes(v)
}
export function isTraceStatus(v: unknown): v is TraceStatus {
  return typeof v === 'string' && (TRACE_STATUSES as string[]).includes(v)
}

export const newMaterialId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

// ---------------------------------------------------------------- 规范化（哈希输入）

/** 稳定序列化：对象键排序，undefined 省略 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map(x => stableStringify(x === undefined ? null : x)).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter(k => o[k] !== undefined)
    .sort()
    .map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`
}

/** 从记录取出参与哈希的内容 */
export function contentOf(title: string, d: Pick<TraceData, 'channel' | 'occurredAt' | 'parties' | 'materials' | 'summary'>): TraceContent {
  return {
    title,
    channel: d.channel,
    occurredAt: d.occurredAt ?? null,
    parties: (d.parties ?? []).map(p => ({ name: p.name, email: p.email ?? null, me: !!p.me })),
    materials: (d.materials ?? []).map(m => ({
      id: m.id,
      kind: m.kind,
      text: m.text,
      label: m.label ?? null,
      messageId: m.messageId ?? null,
      fileName: m.fileName ?? null,
      addedAt: m.addedAt
    })),
    summary: d.summary
      ? {
          conclusion: d.summary.conclusion ?? '',
          agreements: (d.summary.agreements ?? []).map(a => ({ who: a.who ?? '', what: a.what ?? '', when: a.when ?? null, amount: a.amount ?? null, quote: a.quote ?? null })),
          pending: d.summary.pending ?? [],
          risks: d.summary.risks ?? [],
          by: d.summary.by,
          at: d.summary.at
        }
      : null
  }
}

/** 哈希输入：规范化后的内容 JSON（不含 lines / flags / warnings 这类可再生字段） */
export function canonicalContent(c: TraceContent): string {
  return stableStringify({ v: 1, ...c })
}

// ---------------------------------------------------------------- 状态机

export type TraceEvent =
  | { type: 'organized' }
  | { type: 'confirm-drafted' }
  | { type: 'confirm-sent' }
  | { type: 'reply'; verdict: 'confirmed' | 'disputed' }
  | { type: 'edited' }
  | { type: 'set'; status: TraceStatus }

/** 状态转换；不适用时返回 null（保持原状态） */
export function traceTransition(s: TraceStatus, e: TraceEvent): TraceStatus | null {
  switch (e.type) {
    case 'organized':
      return s === 'draft' ? 'organized' : null
    case 'confirm-drafted':
      return s === 'draft' ? 'organized' : null
    case 'confirm-sent':
      // 有异议改正后重新发确认 / 已确认后补发：回到「已发确认」
      return s === 'sent' ? null : 'sent'
    case 'reply':
      return s === 'sent' ? e.verdict : null
    case 'edited':
      // 已确认 / 有异议的内容被改动：需要重新确认
      return s === 'confirmed' || s === 'disputed' ? 'organized' : null
    case 'set':
      return e.status === s ? null : e.status
  }
}

// ---------------------------------------------------------------- IM 聊天文本解析

const REL_DAY = '(?:今天|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天]|礼拜[一二三四五六日天]|Today|Yesterday)'
const DATE_FULL = '\\d{4}\\s*[-/.年]\\s*\\d{1,2}\\s*[-/.月]\\s*\\d{1,2}\\s*日?'
const DATE_US = '\\d{1,2}/\\d{1,2}/\\d{2,4}'
const DATE_MD = '\\d{1,2}\\s*[-/月]\\s*\\d{1,2}\\s*[日号]?'
const TIME = '(?:(?:上午|下午|晚上|凌晨|中午|早上|傍晚)\\s*)?\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[AaPp]\\.?[Mm]\\.?)?'
const DATE_ANY = `(?:${DATE_FULL}|${DATE_US}|${DATE_MD}|${REL_DAY})`
const DT = `(?:${DATE_ANY}[\\s,，]*(?:${REL_DAY}\\s*)?)?${TIME}`

const RE_NAME_DT = new RegExp(`^(.{1,40}?)[\\s　]+(${DT})$`)
/** 截图识字常丢掉姓名与时间之间的空格：「林晓10月18日 下午3:07」（只认中文名 + 带日期的时间） */
const RE_NAME_DT_TIGHT = new RegExp(`^([\\u4e00-\\u9fff·]{1,10}?)((?:${DATE_FULL}|${DATE_MD})[\\s,，]*${TIME})$`)
const RE_DT_NAME = new RegExp(`^(${DATE_ANY}[\\s,，]*${TIME})[\\s　]+(.{1,40})$`)
const RE_INLINE = new RegExp(`^\\[?(${DT}|${DATE_ANY}[\\s,，]+${TIME})\\]?\\s*[-–—]?\\s*([^:：\\[\\]]{1,40}?)\\s*[:：]\\s*(.+)$`)
const RE_TIME_ONLY = new RegExp(`^\\[?(${DT})\\]?$`)
const RE_DATE_SEP = new RegExp(`^[-—=─_·\\s]*(${DATE_FULL}|${DATE_MD}|${REL_DAY})(?:\\s*(?:星期|周|礼拜)[一二三四五六日天])?[-—=─_·\\s]*$`)
const RE_PLAIN = /^([^:：\s\d][^:：]{0,15}?)\s*[:：]\s*(.+)$/

/** 「地址：xx」「时间：xx」这类字段行不是发言人 */
const FIELD_LABELS = new Set(
  '时间 日期 地点 地址 金额 价格 报价 费用 总价 单价 数量 备注 电话 手机 邮箱 联系人 联系方式 主题 事项 内容 结论 说明 注意 要求 附件 链接 网址 订单号 合同号 编号 账号 户名 开户行 开户银行 卡号 交期 工期 截止 付款方式 规格 型号 Note Subject Date Time Re Fw Fwd'.split(' ')
)

const SENTENCE_PUNCT = /[，。！？；,.!?;、…“”"]/

function cleanSpeaker(s: string): string {
  return s
    .replace(/^[\s\[【]+|[\s\]】]+$/g, '')
    .replace(/\s*[(（]\d{5,}[)）]$/, '') // QQ 号
    .replace(/\s*<[^<>]{1,60}>$/, '') // 导出里的 <id>
    .trim()
}

const WEEK_CN: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }

/** 解析时间写法；ref = 参考「今天」，ctx = 上文的日期分隔行 */
export function resolveChatTime(raw: string, ref: Date, ctx: Date | null = null): number | null {
  const s = raw.trim()
  let y: number | null = null
  let mo: number | null = null
  let d: number | null = null
  let m: RegExpExecArray | null
  if ((m = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(s))) {
    y = +m[1]
    mo = +m[2]
    d = +m[3]
  } else if ((m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s))) {
    const a = +m[1]
    const b = +m[2]
    y = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    // 18/10/2026 → 日/月/年；10/18/26 → 月/日/年（Slack / 美式）
    if (a > 12) {
      d = a
      mo = b
    } else {
      mo = a
      d = b
    }
  } else if ((m = /(\d{1,2})\s*[-/月]\s*(\d{1,2})/.exec(s.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')))) {
    mo = +m[1]
    d = +m[2]
    y = (ctx ?? ref).getFullYear()
  }
  let base: Date
  if (y != null && mo != null && d != null) base = new Date(y, mo - 1, d)
  else if (/今天|Today/i.test(s)) base = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate())
  else if (/昨天|Yesterday/i.test(s)) base = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 1)
  else if (/前天/.test(s)) base = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 2)
  else if ((m = /(?:星期|周|礼拜)([一二三四五六日天])/.exec(s))) {
    const want = WEEK_CN[m[1]]
    const t = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate())
    // 聊天里的「周三」指最近过去的那个周三（含今天）
    for (let i = 0; i < 7 && t.getDay() !== want; i++) t.setDate(t.getDate() - 1)
    base = t
  } else if (ctx) base = new Date(ctx.getFullYear(), ctx.getMonth(), ctx.getDate())
  else base = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate())
  if (Number.isNaN(base.getTime())) return null
  const t = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s)
  if (t) {
    let h = +t[1]
    const pm = /下午|晚上|傍晚|[Pp]\.?[Mm]/.test(s)
    const am = /上午|凌晨|早上|[Aa]\.?[Mm]/.test(s)
    if (pm && h < 12) h += 12
    if (am && h === 12) h = 0
    if (/中午/.test(s) && h < 11) h += 12
    base.setHours(h, +t[2], t[3] ? +t[3] : 0, 0)
  }
  return base.getTime()
}

export interface ParsedChat {
  lines: ChatLine[]
  speakers: string[]
  /** 识别到的格式说明（如「姓名 时间 / 内容」） */
  pattern: string | null
  firstAt: number | null
  lastAt: number | null
}

interface Header {
  idx: number
  speaker: string
  time: string | null
  inline?: string
  strong: boolean
}

/**
 * 解析从 IM 复制 / 导出的聊天文本：
 *  - 「姓名 时间」+ 下一行起是内容（微信 / 企业微信 / 钉钉 / 飞书桌面端复制，Slack「Name  2:32 PM」）
 *  - 「时间 姓名」+ 内容（QQ / 微信导出工具：「2026-10-18 14:32:05 张三」）
 *  - 单行「[时间] 姓名: 内容」「18/10/2026, 14:32 - 姓名: 内容」（WhatsApp / Slack 导出）
 *  - 「姓名\n时间\n内容」（Slack 网页复制）
 *  - 无时间的「姓名：内容」（手机端合并转发、随手整理）
 *  - 「—— 2026年10月18日 ——」这类日期分隔行作为后续时间的日期上下文
 * 认不出结构时返回空 lines（当作普通文字材料）。
 */
export function parseChat(text: string, refNow: number = Date.now()): ParsedChat {
  const ref = new Date(refNow)
  const raw = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[​‎‏﻿]/g, '')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
  // Slack 网页复制：「姓名」独占一行，下一行是时间 → 合并为「姓名 时间」
  const rows: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i].trim()
    const next = (raw[i + 1] ?? '').trim()
    if (cur && next && cur.length <= 40 && !/[:：]/.test(cur) && !SENTENCE_PUNCT.test(cur) && RE_TIME_ONLY.test(next) && !RE_TIME_ONLY.test(cur)) {
      rows.push(`${cur}  ${next.replace(/^\[|\]$/g, '')}`)
      i++
      continue
    }
    rows.push(raw[i])
  }

  const empty: ParsedChat = { lines: [], speakers: [], pattern: null, firstAt: null, lastAt: null }
  const nonEmpty = rows.filter(r => r.trim())
  if (!nonEmpty.length) return empty

  // ---- 候选：单行内联 / 标题行 / 无时间「姓名：内容」
  const inline: Header[] = []
  const heads: Header[] = []
  const plain: Header[] = []
  rows.forEach((r0, idx) => {
    const r = r0.trim()
    if (!r) return
    let m = RE_INLINE.exec(r)
    if (m && cleanSpeaker(m[2]) && !FIELD_LABELS.has(cleanSpeaker(m[2]))) {
      inline.push({ idx, speaker: cleanSpeaker(m[2]), time: m[1].trim(), inline: m[3].trim(), strong: true })
      return
    }
    if ((m = RE_DT_NAME.exec(r))) {
      const sp = cleanSpeaker(m[2])
      if (sp && !SENTENCE_PUNCT.test(sp) && sp.length <= 30) {
        heads.push({ idx, speaker: sp, time: m[1].trim(), strong: true })
        return
      }
    }
    if ((m = RE_NAME_DT_TIGHT.exec(r))) {
      const sp = cleanSpeaker(m[1])
      if (sp) {
        heads.push({ idx, speaker: sp, time: m[2].trim(), strong: true })
        return
      }
    }
    if ((m = RE_NAME_DT.exec(r))) {
      const sp = cleanSpeaker(m[1])
      const hasDate = new RegExp(DATE_ANY).test(m[2]) || /:\d{2}:\d{2}/.test(m[2])
      if (sp && sp.length <= 30 && !/[:：]$/.test(sp) && !/^\d/.test(sp) && !RE_DATE_SEP.test(r)) {
        heads.push({ idx, speaker: sp, time: m[2].trim(), strong: hasDate })
        return
      }
    }
    if ((m = RE_PLAIN.exec(r))) {
      const sp = cleanSpeaker(m[1])
      if (sp && !FIELD_LABELS.has(sp) && !SENTENCE_PUNCT.test(sp) && !/^https?$/i.test(sp) && !/\d{3,}/.test(sp)) plain.push({ idx, speaker: sp, time: null, inline: m[2].trim(), strong: false })
    }
  })

  const count = (list: Header[]) => {
    const c = new Map<string, number>()
    for (const h of list) c.set(h.speaker, (c.get(h.speaker) ?? 0) + 1)
    return c
  }

  const build = (list: Header[], pattern: string): ParsedChat => {
    const lines: ChatLine[] = []
    const marks = new Map(list.map(h => [h.idx, h]))
    let ctx: Date | null = null
    let cur: ChatLine | null = null
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].trim()
      const h = marks.get(i)
      if (h) {
        cur = { speaker: h.speaker, time: h.time, at: h.time ? resolveChatTime(h.time, ref, ctx) : null, text: h.inline ?? '' }
        lines.push(cur)
        continue
      }
      if (!r) continue
      const sep = RE_DATE_SEP.exec(r)
      if (sep) {
        const t = resolveChatTime(sep[1], ref, ctx)
        if (t != null) {
          ctx = new Date(t)
          continue
        }
      }
      if (cur) cur.text = cur.text ? `${cur.text}\n${r}` : r
    }
    const out = lines.map(l => ({ ...l, text: l.text.trim() })).filter(l => l.text)
    const speakers = [...new Set(out.map(l => l.speaker))]
    const ats = out.map(l => l.at).filter((x): x is number => x != null)
    return { lines: out, speakers, pattern, firstAt: ats.length ? Math.min(...ats) : null, lastAt: ats.length ? Math.max(...ats) : null }
  }

  // ---- 单行内联（WhatsApp / Slack 导出）
  if (inline.length >= 2 && inline.length >= heads.length) return build(inline, '[时间] 姓名: 内容')

  // ---- 标题行：同名出现 ≥2 次或带日期的是「强」标题；弱标题要求下一行不是标题（「会议改到 14:30」这类内容行不误判）
  if (heads.length) {
    const c = count(heads)
    const idxSet = new Set(heads.map(h => h.idx))
    const nextNonEmpty = (idx: number) => {
      for (let j = idx + 1; j < rows.length; j++) if (rows[j].trim()) return j
      return -1
    }
    const accepted: Header[] = []
    let lastAccepted = -2
    for (const h of heads) {
      const nx = nextNonEmpty(h.idx)
      // 紧跟在标题后的第一行一定是内容
      if (lastAccepted >= 0 && nextNonEmpty(lastAccepted) === h.idx) continue
      const strong = h.strong || (c.get(h.speaker) ?? 0) >= 2
      const weakOk = !SENTENCE_PUNCT.test(h.speaker) && h.speaker.length <= 16 && nx >= 0 && !idxSet.has(nx)
      if (!(strong ? nx >= 0 : weakOk)) continue
      accepted.push(h)
      lastAccepted = h.idx
    }
    const firstLine = nonEmpty[0]?.trim()
    const startsWithHead = accepted.length && rows[accepted[0].idx].trim() === firstLine
    if (accepted.length >= 2 || (accepted.length === 1 && startsWithHead)) {
      const timeFirst = accepted.some(h => RE_DT_NAME.test(rows[h.idx].trim()))
      return build(accepted, timeFirst ? '时间 姓名 / 内容' : '姓名 时间 / 内容')
    }
  }

  // ---- 无时间「姓名：内容」：至少两行，且有人说了不止一句或至少两人
  if (plain.length >= 2) {
    const c = count(plain)
    const names = [...c.keys()]
    const repeated = names.some(n => (c.get(n) ?? 0) >= 2)
    const share = plain.length / nonEmpty.length
    if (names.length <= 8 && (repeated || names.length >= 2) && share >= 0.4) return build(plain, '姓名：内容')
  }
  return empty
}

/** 粗判：这段文字像不像聊天记录 */
export function looksLikeChat(text: string): boolean {
  return parseChat(text).lines.length >= 2
}

/** 聊天消息 → AI / 存档用文本：「张三 [10/18 14:32]：内容」 */
export function chatToText(lines: ChatLine[]): string {
  return lines.map(l => `${l.speaker}${l.time ? ` [${l.time}]` : ''}：${l.text.replace(/\n/g, '\n  ')}`).join('\n')
}

/** 全部材料拼成一段（校验与模板整理共用） */
export function materialsText(materials: TraceMaterial[]): string {
  return materials.map(m => (m.lines?.length ? `${chatToText(m.lines)}\n${m.text}` : m.text)).join('\n\n')
}

// ---------------------------------------------------------------- 数字 / 金额 / 日期

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }

/** 中文数字（「一万二千八」「两千五」「三十」「1万2」）→ 数值；不是数字返回 null */
export function parseCnNumber(s: string): number | null {
  const t = s.trim()
  if (!t || !/^[零〇一二两三四五六七八九十百千万亿\d.]+$/.test(t)) return null
  // 阿拉伯 + 万：「1万2」= 12000，「3.5万」= 35000
  let m: RegExpExecArray | null
  if ((m = /^(\d+(?:\.\d+)?)万(\d)?$/.exec(t))) return Math.round((+m[1] * 10000 + (m[2] ? +m[2] * 1000 : 0)) * 100) / 100
  if ((m = /^(\d+(?:\.\d+)?)千(\d)?$/.exec(t))) return +m[1] * 1000 + (m[2] ? +m[2] * 100 : 0)
  if (/\d/.test(t)) return null
  const section = (x: string): number => {
    let total = 0
    let num = 0
    let lastUnit = 10000
    for (const ch of x) {
      if (ch in CN_DIGIT) num = CN_DIGIT[ch]
      else if (ch in CN_UNIT) {
        const u = CN_UNIT[ch]
        total += (num || (ch === '十' ? 1 : 0)) * u
        num = 0
        lastUnit = u
      }
    }
    // 「两千五」= 2500：末位省略的单位按上一个单位的十分之一
    if (num) total += lastUnit < 10000 && lastUnit >= 10 && x.length >= 3 && !/零/.test(x.slice(-2)) ? num * (lastUnit / 10) : num
    return total
  }
  let value = 0
  let rest = t
  const yi = rest.split('亿')
  if (yi.length === 2) {
    value += section(yi[0] || '一') * 1e8
    rest = yi[1]
  }
  const wan = rest.split('万')
  if (wan.length === 2) {
    value += section(wan[0] || '一') * 1e4
    const tail = wan[1]
    // 「一万二」= 12000
    if (tail.length === 1 && tail in CN_DIGIT) value += CN_DIGIT[tail] * 1000
    else value += section(tail)
  } else value += section(rest)
  return value
}

const MULT: Record<string, number> = { 万: 1e4, w: 1e4, W: 1e4, 千: 1e3, k: 1e3, K: 1e3, 亿: 1e8 }
const round2 = (n: number) => Math.round(n * 100) / 100

/** 文本里出现过的全部数值（含 1,280 / 3.5万 / 1万2 / 两千五 / 2k） */
export function numbersIn(text: string): number[] {
  const out: number[] = []
  const s = String(text ?? '')
  const re = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(万|千|k|K|w|W|亿)?(\d)?(?![\d:])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const base = Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`)
    if (!Number.isFinite(base)) continue
    const unit = m[3] ? MULT[m[3]] : 1
    let v = base * unit
    if (m[3] && m[4] && (m[3] === '万' || m[3] === '千')) v += Number(m[4]) * (unit / 10)
    out.push(round2(v))
    // 单位之外也收原数（「3万」也可能被写成「30000」）
    if (m[3]) out.push(round2(base))
  }
  const cn = /[零〇一二两三四五六七八九十百千万亿]{2,}|[一二两三四五六七八九][十百千万]/g
  while ((m = cn.exec(s))) {
    const v = parseCnNumber(m[0])
    if (v != null && v > 0) out.push(v)
  }
  return out
}

/** 金额片段：带货币符号 / 单位的数字 */
const MONEY_RE = /(?:押金|定金|订金|租金|房租|尾款|首付|预付款?|费用|报价|总价|单价|增项|借款|欠款|工资|物业费|服务费|设计费|清洁费)\s*(?:是|为|：|:)?\s*\d[\d,]*(?:\.\d+)?\s*(?:万|千|k|K|w|W)?(?:元|块钱|块)?|(?:[¥￥$€£]|RMB|USD|CNY|HKD)\s*\d[\d,]*(?:\.\d+)?\s*(?:万|千|k|K|w|W)?(?:\d)?|\d[\d,]*(?:\.\d+)?\s*(?:万|千|k|K|w|W)?\d?\s*(?:元|块钱|块|美元|美金|港币|欧元|rmb|RMB|USD)|[零〇一二两三四五六七八九十百千万]{2,}\s*(?:元|块钱|块)/g

/** 文本里的金额写法（逐字） */
export function moneyPhrases(text: string): string[] {
  return [...String(text ?? '').matchAll(MONEY_RE)].map(m => m[0].trim())
}

/** 日期 / 时间片段：明确日期、星期、相对日期、钟点 */
const WHEN_RE = new RegExp(
  [
    '\\d{4}\\s*[-/.年]\\s*\\d{1,2}\\s*[-/.月]\\s*\\d{1,2}\\s*[日号]?',
    '\\d{1,2}\\s*月\\s*\\d{1,2}\\s*[日号]?(?:\\s*(?:前|之前|以前|左右))?',
    '\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?',
    '(?:这|本|下下|下|上)?(?:周|星期|礼拜)[一二三四五六日天](?:\\s*(?:前|之前|以前))?',
    '(?:今天|明天|后天|大后天|今晚|明早|明晚)',
    '(?:本|这个|下个?|月)月?(?:底|初|中旬|下旬|上旬)(?:\\s*(?:前|之前))?',
    '(?:年底|年前|年后|节前|节后|国庆前|国庆后|春节前|春节后)',
    '(?:下个?月|本月|这个月)\\s*\\d{1,2}\\s*[号日](?:\\s*(?:前|之前|以前))?',
    '\\d{1,2}\\s*[号日](?:\\s*(?:前|之前|以前))?',
    '(?:上午|下午|晚上|中午)?\\s*\\d{1,2}\\s*(?::\\d{2}|点(?:半|\\d{1,2}分?)?)'
  ].join('|'),
  'g'
)

export function whenPhrases(text: string): string[] {
  return [...String(text ?? '').matchAll(WHEN_RE)].map(m => m[0].trim()).filter(Boolean)
}

const squash = (s: string) =>
  String(s ?? '')
    .replace(/\s+/g, '')
    .replace(/星期|礼拜/g, '周')
    .replace(/[，,]/g, '')
    .replace(/[：:]/g, ':')
    .toLowerCase()

/** (月, 日) 对：「10月25日」「10/25」「10-25」「2026-10-25」 */
function monthDays(text: string): { m: number; d: number }[] {
  const out: { m: number; d: number }[] = []
  for (const x of String(text).matchAll(/(?:\d{4}\s*[-/.年]\s*)?(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/g)) {
    const m = +x[1]
    const d = +x[2]
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) out.push({ m, d })
  }
  return out
}

/** 金额是否能在材料里找到（数值相同即可：¥12,800 ↔ 一万二千八 ↔ 1.28万） */
export function amountSupported(amount: string, materials: string): boolean {
  const a = String(amount ?? '').trim()
  if (!a) return true
  if (squash(materials).includes(squash(a))) return true
  const want = numbersIn(a).filter(v => v > 0)
  if (!want.length) return false
  const have = new Set(numbersIn(materials))
  // 金额里的主数值（最大的那个）必须出现过；「3万5」同时产生 35000 与 3，取最大
  return have.has(Math.max(...want))
}

/** 时间是否能在材料里找到：原样出现，或明确日期的月日相同，或相对说法（下周五 / 月底）原样出现 */
export function whenSupported(when: string, materials: string): boolean {
  const w = String(when ?? '').trim()
  if (!w) return true
  const mats = squash(materials)
  if (mats.includes(squash(w))) return true
  const mdWant = monthDays(w)
  if (mdWant.length) {
    const have = monthDays(materials)
    return mdWant.every(x => have.some(h => h.m === x.m && h.d === x.d))
  }
  const phrases = whenPhrases(w)
  if (!phrases.length) return false
  return phrases.every(p => {
    const q = squash(p).replace(/(之前|以前|前|左右)$/, '')
    if (!q) return true
    if (mats.includes(q)) return true
    // 「25号」↔「25日」
    const day = /^(\d{1,2})[号日]$/.exec(q)
    if (day) return new RegExp(`(?<!\\d)${day[1]}[号日]`).test(mats) || monthDays(materials).some(h => h.d === +day[1])
    // 「下午3点」↔「15:00」/「3点」
    const hour = /(\d{1,2})(?::\d{2}|点)/.exec(q)
    if (hour) return new RegExp(`(?<!\\d)${hour[1]}(?::|点)`).test(mats) || new RegExp(`(?<!\\d)${+hour[1] + 12}:`).test(mats)
    return false
  })
}

/** 校验整理结果（AI / Agent / 手工都过一遍）：编造的金额、日期改为待确认，并给出提示 */
export function validateSummary(sum: TraceSummary, materials: string): TraceSummary {
  const warnings: string[] = [...(sum.warnings ?? [])]
  const pending: string[] = [...(sum.pending ?? [])]
  const agreements: TraceAgreement[] = (sum.agreements ?? []).map(a0 => {
    const a: TraceAgreement = { ...a0, flags: [...new Set(a0.flags ?? [])].filter(f => f !== 'amount-unverified' && f !== 'when-unverified' && f !== 'what-number') }
    const label = `${a.who ? `${a.who}：` : ''}${(a.what ?? '').slice(0, 30)}`
    if (a.amount && !amountSupported(a.amount, materials)) {
      warnings.push(`「${label}」的金额「${a.amount}」在原始材料里找不到，已移到待确认`)
      pending.push(`「${label}」的金额（整理时给出「${a.amount}」，原始材料里没有）`)
      a.amount = null
      a.flags!.push('amount-unverified')
    }
    if (a.when && !whenSupported(a.when, materials)) {
      warnings.push(`「${label}」的时间「${a.when}」在原始材料里找不到，已移到待确认`)
      pending.push(`「${label}」的时间（整理时给出「${a.when}」，原始材料里没有）`)
      a.when = null
      a.flags!.push('when-unverified')
    }
    for (const p of moneyPhrases(a.what ?? '')) {
      if (!amountSupported(p, materials)) {
        warnings.push(`「${label}」里的金额「${p}」在原始材料里找不到，请核实`)
        a.flags!.push('what-number')
      }
    }
    if (!a.flags!.length) delete a.flags
    return a
  })
  for (const p of moneyPhrases(sum.conclusion ?? '')) if (!amountSupported(p, materials)) warnings.push(`结论里的金额「${p}」在原始材料里找不到，请核实`)
  return { ...sum, agreements, pending: [...new Set(pending.map(s => s.trim()).filter(Boolean))], warnings: [...new Set(warnings)] }
}

// ---------------------------------------------------------------- AI 结果映射

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '')
const strOrNull = (v: unknown, max = 80): string | null => {
  const s = str(v, max)
  return s && !/^(null|无|没有|未知|n\/a|none|-)$/i.test(s) ? s : null
}

export interface AiTraceResult {
  summary: TraceSummary
  title: string | null
  parties: string[]
  occurredAt: number | null
}

/** AI 返回的 JSON → 整理结果（再经 validateSummary 校验） */
export function summaryFromAi(json: unknown, materials: string, now = Date.now()): AiTraceResult {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const agreements: TraceAgreement[] = (Array.isArray(j.agreements) ? j.agreements : [])
    .slice(0, 12)
    .map(x => {
      const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
      return { who: str(o.who, 40), what: str(o.what, 240), when: strOrNull(o.when), amount: strOrNull(o.amount), quote: strOrNull(o.quote, 120) }
    })
    .filter(a => a.what)
  const list = (v: unknown) => (Array.isArray(v) ? v.map(x => str(x, 200)).filter(Boolean).slice(0, 12) : [])
  const summary = validateSummary({ conclusion: str(j.conclusion, 400), agreements, pending: list(j.pending), risks: list(j.risks), by: 'ai', at: now }, materials)
  let occurredAt: number | null = null
  const oa = str(j.occurredAt, 40)
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(oa)
  // 发生时间同样要有依据：日期在材料里出现过才采纳
  if (m && whenSupported(`${+m[2]}月${+m[3]}日`, materials)) occurredAt = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 9, m[5] ? +m[5] : 0).getTime()
  return { summary, title: strOrNull(j.title, 40), parties: list(j.parties).map(p => p.slice(0, 30)), occurredAt }
}

// ---------------------------------------------------------------- 无 AI：模板整理

const COMMIT_RE =
  /(答应|同意|确认|确定|约定|说定|说好|定了|就这么|就按|负责|保证|承诺|会在|之前|以前|交付|交货|发货|到货|付款|打款|转账|支付|报价|价格|费用|押金|租金|定金|订金|尾款|退还|退款|延期|推迟|改到|改成|调整为|增加|减少|包含|不含|完工|完成|开工|寄出|发你|发给|结清|签约|签合同|到位|上门|没问题|可以的|行的|好的|ok|OK|deal|agreed|confirm|will )/
const QUESTION_RE = /[?？]|吗$|吗[，,。]|待定|再确认|回头|再说|再看|再议|再商量|不确定|大概|差不多|可能|也许/

function sentencesOf(materials: TraceMaterial[]): { who: string; text: string }[] {
  const out: { who: string; text: string }[] = []
  for (const m of materials) {
    if (m.lines?.length) {
      for (const l of m.lines) for (const s of l.text.split(/\n|(?<=[。！!；;])/)) if (s.trim()) out.push({ who: l.speaker, text: s.trim() })
    } else {
      for (const s of m.text.split(/\n|(?<=[。！!；;])/)) if (s.trim()) out.push({ who: '', text: s.trim() })
    }
  }
  return out
}

/** 按模板整理（不用 AI）：抽出像约定的句子，金额 / 时间逐字摘录；含糊或带问号的放待确认 */
export function templateSummary(materials: TraceMaterial[], now = Date.now()): TraceSummary {
  const sents = sentencesOf(materials)
  const agreements: TraceAgreement[] = []
  const pending: string[] = []
  const seen = new Set<string>()
  for (const s of sents) {
    const t = s.text.replace(/^[-*•·\d.、)\s]+/, '').trim()
    if (t.length < 4 || seen.has(t)) continue
    seen.add(t)
    if (QUESTION_RE.test(t)) {
      if (COMMIT_RE.test(t) || moneyPhrases(t).length || whenPhrases(t).length || /(再看|待定|再确认|再商量|再议|回头)/.test(t)) pending.push(`${s.who ? `${s.who}：` : ''}${t}`.slice(0, 160))
      continue
    }
    if (!COMMIT_RE.test(t) && !moneyPhrases(t).length) continue
    if (agreements.length >= 10) continue
    agreements.push({ who: s.who, what: t.slice(0, 200), when: whenPhrases(t)[0] ?? null, amount: moneyPhrases(t)[0] ?? null, quote: t.slice(0, 80) })
  }
  const risks: string[] = []
  const all = materialsText(materials)
  if (moneyPhrases(all).length) risks.push('涉及金额的约定目前只有口头 / 聊天记录，建议发书面确认请对方回复确认')
  if (agreements.length && !agreements.some(a => a.when)) risks.push('约定里没有明确的时间节点')
  if (pending.length) risks.push('还有没说定的地方（见待确认），别当成已经约定')
  return {
    conclusion: agreements.length ? `共整理出 ${agreements.length} 条可能的约定（按模板摘录原话，请逐条核对、删改）` : '没有找到明确的约定句，请手动补充结论与约定事项',
    agreements,
    pending: pending.slice(0, 10),
    risks,
    by: 'template',
    at: now
  }
}

// ---------------------------------------------------------------- 书面确认邮件

const pad = (n: number) => String(n).padStart(2, '0')
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
export function fmtTraceTime(t: number | null | undefined, withTime = true): string {
  if (!t) return '（时间未记录）'
  const d = new Date(t)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）${withTime && (d.getHours() || d.getMinutes()) ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''}`
}

const CHANNEL_PHRASE: Record<TraceChannel, string> = {
  phone: '电话沟通',
  wechat: '微信沟通',
  meeting: '会议讨论',
  'in-person': '当面沟通',
  im: '在线沟通',
  other: '沟通'
}

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface ConfirmEmail {
  subject: string
  text: string
  html: string
}

/** 一条约定写成一句：「张三：周五前交付设计稿（时间：本周五；金额：¥3,000）」 */
export function agreementLine(a: TraceAgreement): string {
  const extra = [a.when ? `时间：${a.when}` : '', a.amount ? `金额：${a.amount}` : ''].filter(Boolean).join('；')
  return `${a.who ? `${a.who}：` : ''}${a.what}${extra ? `（${extra}）` : ''}`
}

/**
 * 书面确认邮件：正式、简洁——时间、事项、约定条款逐条、请对方回复确认或指正。
 * 只用记录里的内容，不增添；待确认点单列，让对方补充。
 */
export function buildConfirmEmail(input: { title: string; channel: TraceChannel; occurredAt: number | null; parties: TraceParty[]; summary: TraceSummary | null; myName?: string | null }): ConfirmEmail {
  const others = input.parties.filter(p => !p.me && p.name)
  const greet = others.length === 1 ? `${others[0].name}，您好：` : others.length > 1 ? `${others.map(p => p.name).slice(0, 4).join('、')}，各位好：` : '您好：'
  const when = input.occurredAt ? fmtTraceTime(input.occurredAt) : '此前'
  const s = input.summary
  const items = (s?.agreements ?? []).filter(a => a.what)
  const pending = s?.pending ?? []
  const lines: string[] = [greet, '', `${when}我们就「${input.title}」进行了${CHANNEL_PHRASE[input.channel]}。为免遗漏和误解，现将沟通结果书面整理如下，请您核对：`, '']
  if (s?.conclusion && s.by !== 'template') lines.push(`结论：${s.conclusion}`, '')
  if (items.length) {
    lines.push('约定事项：')
    items.forEach((a, i) => lines.push(`${i + 1}. ${agreementLine(a)}`))
    lines.push('')
  }
  if (pending.length) {
    lines.push('以下几点尚待确认，烦请一并告知：')
    pending.forEach(p => lines.push(`- ${p}`))
    lines.push('')
  }
  lines.push('如以上内容无误，请回复「确认」；如有出入，请直接指出需要更正之处，我会及时修改。', '', '谢谢！')
  if (input.myName) lines.push(input.myName)
  const text = lines.join('\n')
  const html: string[] = [`<p>${esc(greet)}</p>`, `<p>${esc(`${when}我们就「${input.title}」进行了${CHANNEL_PHRASE[input.channel]}。为免遗漏和误解，现将沟通结果书面整理如下，请您核对：`)}</p>`]
  if (s?.conclusion && s.by !== 'template') html.push(`<p><strong>结论：</strong>${esc(s.conclusion)}</p>`)
  if (items.length) html.push('<p><strong>约定事项：</strong></p>', `<ol>${items.map(a => `<li>${esc(agreementLine(a))}</li>`).join('')}</ol>`)
  if (pending.length) html.push('<p><strong>以下几点尚待确认，烦请一并告知：</strong></p>', `<ul>${pending.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`)
  html.push('<p>如以上内容无误，请回复「确认」；如有出入，请直接指出需要更正之处，我会及时修改。</p>', `<p>谢谢！${input.myName ? `<br>${esc(input.myName)}` : ''}</p>`)
  const dateTag = input.occurredAt ? `${new Date(input.occurredAt).getMonth() + 1}/${new Date(input.occurredAt).getDate()} ` : ''
  return { subject: `书面确认：${input.title}（${dateTag}${CHANNEL_PHRASE[input.channel]}）`.slice(0, 120), text, html: html.join('\n') }
}

// ---------------------------------------------------------------- 对方回信：确认 / 异议

/** 去掉回信里引用的原文（「> …」「在 … 写道：」「On … wrote:」「-----原始邮件-----」「发件人：」之后） */
export function stripQuoted(text: string): string {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  for (const l of lines) {
    const t = l.trim()
    if (/^>/.test(t)) break
    if (/^(在|于).{0,80}(写道|wrote)[:：]?$/.test(t) || /^On .{0,120}wrote:?$/i.test(t)) break
    if (/^-{2,}\s*(原始邮件|Original Message|Forwarded|转发)/i.test(t) || /^_{5,}$/.test(t)) break
    if (/^(发件人|From)\s*[:：]/i.test(t) && out.some(x => x.trim())) break
    out.push(l)
  }
  return out.join('\n').trim()
}

const AGREE_NEG = /(没有异议|无异议|没异议|没意见|没有意见|无意见|没有问题|没问题|无问题|无误|没有出入|无出入|没错|都对|没有要改|不用改|无需修改|no objection|no issues?|looks good)/gi
const DISSENT_RE =
  /(有异议|异议|不同意|不认可|不接受|不对|不准确|不正确|有误|有出入|出入|更正|纠正|需要修改|要修改|改一下|改为|应该是|不是这样|并非|没有答应|没答应|没说过|不确认|再商量|再议|还要再|不太对|错了|有问题|理解有偏差|disagree|incorrect|not correct|not accurate|correction|dispute|not agreed|should be)/gi
const CONFIRM_RE = /(确认|无误|没问题|同意|可以|好的|收到|认可|没错|ok|okay|confirmed|agree|correct|lgtm|👍)/gi

/** 判断对方回信是确认还是有异议（先去掉引用的原文；「没有异议」「确认无误」不算异议；两者都有时按异议处理，请用户查看） */
export function classifyReply(text: string): { verdict: 'confirmed' | 'disputed'; matched: string[] } {
  const body = stripQuoted(text)
  const positives = [...body.matchAll(AGREE_NEG)].map(m => m[0])
  const rest = body.replace(AGREE_NEG, ' ')
  const dissent = [...rest.matchAll(DISSENT_RE)].map(m => m[0])
  if (dissent.length) return { verdict: 'disputed', matched: [...new Set(dissent)].slice(0, 6) }
  const ok = [...rest.matchAll(CONFIRM_RE)].map(m => m[0])
  return { verdict: 'confirmed', matched: [...new Set([...positives, ...ok])].slice(0, 6) }
}

// ---------------------------------------------------------------- 存档（Markdown）

export function traceToMarkdown(r: TraceRecord, extra: { verified?: boolean | null; exportedAt?: number } = {}): string {
  const d = r.data
  const s = d.summary
  const md: string[] = [`# ${r.title}`, '']
  md.push(`- 场景：${TRACE_CHANNEL_LABEL[d.channel]}`)
  md.push(`- 发生时间：${fmtTraceTime(d.occurredAt)}`)
  md.push(`- 参与人：${d.parties.map(p => `${p.name}${p.email ? ` <${p.email}>` : ''}${p.me ? '（我）' : ''}`).join('、') || '—'}`)
  md.push(`- 状态：${TRACE_STATUS_LABEL[d.status]}`)
  md.push(`- 记录创建：${fmtTraceTime(d.createdAt)}`)
  md.push('')
  if (s) {
    md.push('## 整理结果', '')
    if (s.conclusion) md.push(`**结论**：${s.conclusion}`, '')
    if (s.agreements.length) {
      md.push('**约定事项**', '')
      s.agreements.forEach((a, i) => md.push(`${i + 1}. ${agreementLine(a)}${a.quote ? `\n   > 原文：${a.quote}` : ''}`))
      md.push('')
    }
    if (s.pending.length) md.push('**待确认**', '', ...s.pending.map(p => `- ${p}`), '')
    if (s.risks.length) md.push('**风险提示**', '', ...s.risks.map(p => `- ${p}`), '')
    md.push(`_整理方式：${s.by === 'ai' ? 'AI 整理' : s.by === 'template' ? '模板整理' : s.by === 'agent' ? 'Agent 整理' : '手动'} · ${fmtTraceTime(s.at)}_`, '')
  }
  if (d.confirm) {
    md.push('## 书面确认', '')
    md.push(`- 收件人：${d.confirm.to.join('、') || '—'}`)
    md.push(`- 主题：${d.confirm.subject}`)
    md.push(`- 起草：${fmtTraceTime(d.confirm.draftedAt)}`)
    if (d.confirm.sentAt) md.push(`- 发出：${fmtTraceTime(d.confirm.sentAt)}`)
    if (d.confirm.replyAt) md.push(`- 对方回信：${fmtTraceTime(d.confirm.replyAt)} · ${d.confirm.verdict === 'disputed' ? '有异议' : '已确认'}${d.confirm.evidence?.length ? `（${d.confirm.evidence.join('、')}）` : ''}`)
    md.push('')
  }
  md.push('## 原始材料', '')
  for (const m of d.materials) {
    md.push(`### ${TRACE_MATERIAL_LABEL[m.kind]}${m.label ? ` · ${m.label}` : ''}${m.fileName ? ` · ${m.fileName}` : ''}（${fmtTraceTime(m.addedAt)} 加入）`, '')
    const body = m.kind === 'chat' && m.lines?.length ? chatToText(m.lines) : m.text
    md.push('```text', body.replace(/```/g, 'ˋˋˋ'), '```', '')
  }
  md.push('## 完整性', '')
  md.push(`- 内容哈希（${d.hashAlgo.toUpperCase()}）：\`${d.hash}\``)
  md.push(`- 首次记录哈希：\`${d.firstHash}\``)
  if (extra.verified != null) md.push(`- 校验：${extra.verified ? '当前内容与哈希一致' : '当前内容与哈希不一致'}`)
  if (d.versions.length) {
    md.push(`- 修改历史（${d.versions.length} 个旧版本）：`)
    for (const v of d.versions) md.push(`  - ${fmtTraceTime(v.at)} · ${v.reason} · 修改前哈希 \`${v.hash.slice(0, 16)}…\``)
  }
  md.push('', `_由 LinkTo 留痕导出 · ${fmtTraceTime(extra.exportedAt ?? Date.now())}_`, '')
  return md.join('\n')
}

/** 阅读页 / 列表：一条记录里是否提到某人（姓名或邮箱） */
export function traceHasParty(r: TraceRecord, q: string): boolean {
  const k = q.trim().toLowerCase()
  if (!k) return true
  return r.data.parties.some(p => p.name.toLowerCase().includes(k) || (p.email ?? '').toLowerCase().includes(k))
}

/** 「这几天」的约定：发生在 [from, to] 的记录 */
export function inRange(r: TraceRecord, from: number | null, to: number | null): boolean {
  const t = r.data.occurredAt ?? r.createdAt
  return (from == null || t >= from) && (to == null || t <= to)
}

/** 一条约定里能解析出的明确日期（「10月25日」「2026-10-25」「10/25」）→ 时间戳；相对说法不推算 */
export function explicitDateOf(when: string | null | undefined, ref: number): number | null {
  if (!when) return null
  const r = new Date(ref)
  let m = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(when)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 18, 0).getTime()
  m = /(\d{1,2})\s*[月/-]\s*(\d{1,2})/.exec(when)
  if (m) {
    let t = new Date(r.getFullYear(), +m[1] - 1, +m[2], 18, 0)
    // 跨年：记录在 12 月、约定写「1月5日」
    if (t.getTime() < ref - 60 * 864e5) t = new Date(r.getFullYear() + 1, +m[1] - 1, +m[2], 18, 0)
    return t.getTime()
  }
  return null
}

// ---------------------------------------------------------------- 「我」= 用户本人

/** 用户本人的身份：账户显示名（发信时的 From 名）与邮箱 */
export interface SelfIdentity {
  /** 认作本人的名字（发信 From 名、账户名称） */
  names: string[]
  emails: string[]
  /** 「我」显示成的名字：已发邮件里最常用的 From 名；没有就保留「我」（账户名称常是「工作」这类标签，不拿来显示） */
  display?: string | null
}

/** IM 粘贴 / 导出里代表自己的写法（微信 / 企业微信复制时自己显示为「我」，导出工具的「我方」「本人」等） */
export const SELF_WORDS = ['我', '我方', '本人', '自己', 'me', 'myself']

const normName = (s: string) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/^[@＠]/, '')

/** 这个名字 / 邮箱是不是用户本人 */
export function isSelfParty(p: { name?: string | null; email?: string | null }, id: SelfIdentity): boolean {
  const email = normName(p.email ?? '')
  if (email && id.emails.some(e => normName(e) === email)) return true
  const name = normName(p.name ?? '').replace(/[（(]我[)）]$/, '').trim()
  if (!name) return false
  if (SELF_WORDS.includes(name)) return true
  if (/[（(]我[)）]$/.test(String(p.name ?? '').trim())) return true
  return id.names.some(n => normName(n) && normName(n) === name)
}

/**
 * 参与人里的「我」→ 用户本人：标 me，补上邮箱；名字是「我」这类代称时换成显示名（没有显示名就保留）。
 * 聊天材料里出现了「我」/ 显示名、但参与人里还没有本人时，补一个本人（只在 speakers 给出时）。
 */
export function markSelfParties(parties: TraceParty[], id: SelfIdentity, speakers: string[] = []): TraceParty[] {
  const display = String(id.display ?? '').trim()
  const email = id.emails.map(e => String(e ?? '').trim().toLowerCase()).find(Boolean) ?? null
  const out: TraceParty[] = []
  let hasMe = false
  for (const p of parties) {
    if (!isSelfParty(p, id)) {
      out.push(p)
      continue
    }
    if (hasMe) continue // 同一个人写了两遍（「我」和显示名）：合并
    hasMe = true
    const isWord = SELF_WORDS.includes(normName(p.name ?? '').replace(/[（(]我[)）]$/, '').trim())
    out.push({ name: (isWord && display ? display : String(p.name ?? '').replace(/[（(]我[)）]$/, '').trim()) || display || '我', email: p.email || email, me: true })
  }
  if (!hasMe && speakers.some(s => isSelfParty({ name: s }, id))) out.unshift({ name: display || '我', email, me: true })
  return out
}
