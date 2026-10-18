import type { AccountWithStatus, Folder, NLQuery, SpecialFolder } from '@shared/types'

/**
 * 邮件搜索的纯逻辑层（不碰 UI / store）：
 *  - 本地搜索语法解析（from: / to: / subject: / has: / is: / before: / after: / in:，中文别名同样认）
 *  - 判断输入是不是自然语言问句（决定要不要后台尝试 AI 编译）
 *  - 最近搜索（localStorage，读写都包 try/catch）
 *  - AI 失败原因 → 中文说明（绝不把英文原始错误抛给用户）
 */

/** 识别出的一条语法，用于结果头部的胶囊（可单独移除） */
export interface SearchToken {
  /** 原文片段（移除胶囊 = 从输入里删掉它） */
  raw: string
  label: string
}

export interface ParsedSearch {
  /** 纯文本关键词（引号短语算一个） */
  terms: string[]
  tokens: SearchToken[]
  /** 解析出的结构化条件（不含关键词） */
  query: NLQuery
}

type Ctx = { accounts: AccountWithStatus[]; folders: Folder[] }

const KEY_ALIAS: Record<string, string> = {
  from: 'from', 发件人: 'from', 来自: 'from', 发件: 'from',
  to: 'to', 收件人: 'to', 发给: 'to', cc: 'to',
  subject: 'subject', 主题: 'subject', 标题: 'subject',
  has: 'has', 有: 'has',
  is: 'is', 状态: 'is',
  before: 'before', 早于: 'before', 之前: 'before',
  after: 'after', since: 'after', 晚于: 'after', 之后: 'after',
  in: 'in', 在: 'in', 账户: 'in', 文件夹: 'in'
}

const FOLDER_ALIAS: Record<string, Exclude<SpecialFolder, null>> = {
  inbox: 'inbox', 收件箱: 'inbox',
  sent: 'sent', 已发送: 'sent', 发件箱: 'sent',
  drafts: 'drafts', draft: 'drafts', 草稿: 'drafts', 草稿箱: 'drafts',
  trash: 'trash', 垃圾箱: 'trash', 已删除: 'trash', 废纸篓: 'trash',
  junk: 'junk', spam: 'junk', 垃圾邮件: 'junk',
  archive: 'archive', 归档: 'archive', 存档: 'archive',
  all: 'all', 所有邮件: 'all'
}

/** 2026-10-01 / 2026/10/1 / 2026.10.1 / 10-01（今年） → YYYY-MM-DD；不合法返回 null */
export function normDate(s: string): string | null {
  const m = s.trim().match(/^(?:(\d{4})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?$/)
  if (!m) return null
  const y = Number(m[1] ?? new Date().getFullYear())
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const unquote = (v: string) => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v)

/** 解析搜索框输入：识别语法 → 结构化条件；其余部分作为关键词 */
export function parseSearch(input: string, ctx: Ctx): ParsedSearch {
  const src = input.replace(/：/g, ':').replace(/[“”]/g, '"')
  const terms: string[] = []
  const tokens: SearchToken[] = []
  const query: NLQuery = {}
  const re = /([^\s:"]+):("[^"]*"|\S*)|"[^"]*"|\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const raw = m[0]
    const key = m[1] ? KEY_ALIAS[m[1].toLowerCase()] : undefined
    const val = m[1] ? unquote(m[2] ?? '').trim() : ''
    // 正在输入语法前缀（如刚敲完「from:」）：先忽略，不当关键词
    if (key && !val) continue
    if (key && val) {
      const v = val.toLowerCase()
      if (key === 'from') {
        query.sender = val
        tokens.push({ raw, label: `发件人：${val}` })
        continue
      }
      if (key === 'to') {
        query.to = val
        tokens.push({ raw, label: `收件人：${val}` })
        continue
      }
      if (key === 'subject') {
        query.subject = val
        tokens.push({ raw, label: `主题含：${val}` })
        continue
      }
      if (key === 'has' && /^(attachments?|attach|附件|file)$/.test(v)) {
        query.hasAttachment = true
        tokens.push({ raw, label: '有附件' })
        continue
      }
      if (key === 'is' && /^(unread|未读)$/.test(v)) {
        query.unreadOnly = true
        tokens.push({ raw, label: '未读' })
        continue
      }
      if (key === 'is' && /^(flagged|starred|旗标|已加旗标|星标)$/.test(v)) {
        query.flaggedOnly = true
        tokens.push({ raw, label: '已加旗标' })
        continue
      }
      if (key === 'before' || key === 'after') {
        const d = normDate(val)
        if (d) {
          if (key === 'before') query.before = d
          else query.after = d
          tokens.push({ raw, label: `${key === 'before' ? '早于' : '晚于'} ${d}` })
          continue
        }
      }
      if (key === 'in') {
        const acc = ctx.accounts.find(a => a.name.toLowerCase() === v || a.email.toLowerCase() === v)
          ?? ctx.accounts.find(a => a.name.toLowerCase().includes(v) || a.email.toLowerCase().includes(v))
        if (acc) {
          query.accountId = acc.id
          tokens.push({ raw, label: `账户：${acc.name}` })
          continue
        }
        const special = FOLDER_ALIAS[v]
        const hits = ctx.folders.filter(f => (special ? f.special === special : false) || f.name.toLowerCase() === v || f.path.toLowerCase() === v)
        const fuzzy = hits.length ? hits : ctx.folders.filter(f => f.name.toLowerCase().includes(v))
        if (fuzzy.length) {
          query.folderIds = fuzzy.map(f => f.id)
          tokens.push({ raw, label: `文件夹：${special ? fuzzy[0].name : val}` })
          continue
        }
        // 找不到对应账户 / 文件夹：仍显示为胶囊，但不加条件，避免整页空白还说不清为什么
        tokens.push({ raw, label: `范围「${val}」未找到` })
        continue
      }
    }
    // 中文 / 简写的独立词
    const bare = raw.toLowerCase()
    if (/^(未读|unread)$/.test(bare)) {
      query.unreadOnly = true
      tokens.push({ raw, label: '未读' })
      continue
    }
    if (/^(有附件|带附件)$/.test(bare)) {
      query.hasAttachment = true
      tokens.push({ raw, label: '有附件' })
      continue
    }
    if (/^(旗标|已加旗标)$/.test(bare)) {
      query.flaggedOnly = true
      tokens.push({ raw, label: '已加旗标' })
      continue
    }
    const days = bare.match(/^(?:近|最近)(\d{1,3})天$/)
    if (days) {
      query.withinDays = Number(days[1])
      tokens.push({ raw, label: `近 ${days[1]} 天` })
      continue
    }
    const t = unquote(raw).trim()
    if (t) terms.push(t)
  }
  return { terms, tokens, query }
}

/** 从输入里移除某条语法原文（胶囊的 ×） */
export function removeToken(input: string, raw: string): string {
  const src = input.replace(/：/g, ':')
  const i = src.indexOf(raw)
  if (i < 0) return input
  return (src.slice(0, i) + src.slice(i + raw.length)).replace(/\s{2,}/g, ' ').trim()
}

/** 自然语言问句：含疑问 / 口语提示词，或是较长的一句话 */
const NL_HINTS = ['帮我', '找一下', '找找', '找出', '有没有', '上周', '上个月', '本周', '这周', '最近', '昨天', '前天', '今天', '谁', '哪些', '哪个', '哪封', '什么', '怎么', '吗', '呢', '关于', '给我', '所有', '的邮件', '？', '?']
export function looksNatural(terms: string[]): boolean {
  const text = terms.join(' ')
  if (!text) return false
  if (NL_HINTS.some(h => text.includes(h))) return true
  const cjk = (text.match(/[一-鿿]/g) ?? []).length
  if (cjk >= 12) return true
  return text.split(/\s+/).filter(Boolean).length >= 5
}

/**
 * 问句的宽松关键词：去掉口语 / 疑问 / 时间虚词，剩下的片段逐个 AND 匹配。
 * 「帮我找一下李若发的设计稿」→ [李若, 设计稿]。AI 不可用时，问句也不至于整页空白。
 */
const LOOSE_STOP = /帮我|帮忙|找一下|找找|找出|查一下|查查|看看|有没有|给我|一下|所有|关于|那封|哪封|哪些|哪个|什么|上个月|上周|本周|这周|最近|昨天|前天|今天|发来的|发来|发给我的|发的|邮件|的|了|吗|呢|吧|谁|[，。！？?!,.、]/g
export function looseTerms(terms: string[]): string[] {
  const out = terms
    .join(' ')
    .replace(LOOSE_STOP, ' ')
    .split(/\s+/)
    .map(s => s.trim())
    .filter(s => [...s].length >= 2)
  return [...new Set(out)].slice(0, 4)
}

/** 输入是否足以触发实时搜索（单个英文字母太泛，先不搜） */
export function worthSearching(input: string): boolean {
  const t = input.trim()
  if (!t) return false
  if (/[^\x00-\x7f]/.test(t) || t.includes(':')) return true
  return t.length >= 2
}

// —— 最近搜索 ——
const RECENT_KEY = 'ms_recent_searches'
export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 8) : []
  } catch {
    return []
  }
}
export function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)))
  } catch {
    /* 隐私模式 / 存储被禁：最近搜索只是便利功能，失败就算了 */
  }
}
export function pushRecent(q: string): string[] {
  const t = q.trim()
  if (!t) return loadRecent()
  const next = [t, ...loadRecent().filter(x => x !== t)].slice(0, 8)
  saveRecent(next)
  return next
}

/** 下拉里的语法提示：选中后把前缀填进输入框 */
export const SYNTAX_HINTS: { insert: string; label: string; example: string }[] = [
  { insert: 'from:', label: '发件人', example: 'from:李若' },
  { insert: 'to:', label: '收件人', example: 'to:周岚' },
  { insert: 'subject:', label: '主题', example: 'subject:周报' },
  { insert: 'has:attachment ', label: '有附件', example: '有附件' },
  { insert: 'is:unread ', label: '未读', example: '未读' },
  { insert: 'is:flagged ', label: '已加旗标', example: '旗标' },
  { insert: 'after:', label: '晚于某天', example: 'after:2026-10-01' },
  { insert: 'before:', label: '早于某天', example: 'before:2026-10-01' },
  { insert: 'in:', label: '账户或文件夹', example: 'in:已发送' }
]

/** AI 失败原因 → 中文说明；setup = 建议去设置 AI */
export function aiErrorText(err?: string): { text: string; setup: boolean } {
  const e = err ?? ''
  if (/未启用|未配置|not configured|api.?key|401|403|unauthori[sz]ed|forbidden/i.test(e)) return { text: 'AI 还没有配置好', setup: true }
  if (/超时|timeout|timed out|ETIMEDOUT|abort/i.test(e)) return { text: 'AI 响应超时', setup: false }
  if (/fetch failed|network|ENOTFOUND|ECONN|EAI_AGAIN|socket|网络|getaddrinfo/i.test(e)) return { text: '连不上 AI 服务（检查网络或服务地址）', setup: true }
  if (/429|rate|quota|余额|限流/i.test(e)) return { text: 'AI 服务繁忙或额度不足', setup: false }
  if (/json|parse|unexpected/i.test(e)) return { text: 'AI 没能理解这个问题', setup: false }
  return { text: 'AI 暂时不可用', setup: true }
}

/** AI 编译结果的人话描述（「AI 理解为：…」） */
export function describeNL(q: NLQuery): string {
  const parts: string[] = []
  if (q.sender) parts.push(`发件人 ${q.sender}`)
  if (q.subject) parts.push(`主题含「${q.subject}」`)
  if (q.category) parts.push({ personal: '个人', notification: '通知', newsletter: '订阅', noise: '噪声' }[q.category] ?? '')
  if (q.isNewsletter) parts.push('订阅邮件')
  if (q.hasAttachment) parts.push('带附件')
  if (q.unreadOnly) parts.push('未读')
  if (q.withinDays) parts.push(`最近 ${q.withinDays} 天`)
  if (q.after) parts.push(`${q.after} 之后`)
  if (q.before) parts.push(`${q.before} 之前`)
  const kw = (q.fallbackText || q.text || '').trim()
  if (kw) parts.push(`关键词「${kw}」`)
  return parts.filter(Boolean).join(' · ') || '全部邮件'
}

/** AI 编译结果是否什么条件都没有（等于没理解） */
export function nlIsEmpty(q: NLQuery): boolean {
  return !(q.sender || q.subject || q.category || q.isNewsletter != null || q.hasAttachment || q.unreadOnly || q.withinDays || q.after || q.before || (q.fallbackText || q.text || '').trim())
}

/** 把文本按命中词切开，供 <mark className="hl"> 高亮（大小写不敏感） */
export function splitHits(text: string, terms: string[]): { s: string; hit: boolean }[] {
  const ts = [...new Set(terms.map(t => t.trim()).filter(t => t.length > 0))].sort((a, b) => b.length - a.length)
  if (!text || !ts.length) return [{ s: text, hit: false }]
  const esc = ts.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${esc.join('|')})`, 'gi')
  const out: { s: string; hit: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0
    if (i > last) out.push({ s: text.slice(last, i), hit: false })
    out.push({ s: m[0], hit: true })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ s: text.slice(last), hit: false })
  return out
}
