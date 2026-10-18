/**
 * 知识库自主学习：挑「值得沉淀」的邮件 + 新条目与已有条目去重（纯函数，可单测）。
 * 只用规则打分：AI 预算只花在挑出来的少数邮件上。
 */

export interface KbCandidateInput {
  id: string
  subject: string
  /** 正文（纯文本，调用方截断到几千字即可） */
  text: string
  fromAddr: string
  fromName?: string
  /** personal / notification / newsletter / noise */
  category: string
  isNewsletter: boolean
  /** 我自己发出的 */
  fromMe: boolean
  /** 我回复过（\Answered）或同会话里有我的回信 */
  replied: boolean
  /** 带 PDF 资料 */
  hasPdf: boolean
  /** 已提取的 PDF 正文节选（附件正文缓存里有才带；没有时只按 hasPdf 加分） */
  pdfText?: string
  hasAttachments: boolean
  date: number
}

export interface KbScore {
  id: string
  score: number
  reasons: string[]
}

/** 高价值信号（命中组数越多越值得学） */
const SIGNALS: { key: string; label: string; re: RegExp }[] = [
  { key: 'decision', label: '决定 / 结论', re: /(决定|决策|结论|拍板|定下来|确认采用|最终方案|已批准|批准了|同意采用|decision|decided|approved|we will go with|final call)/i },
  { key: 'plan', label: '方案 / 计划', re: /(方案|提案|计划书|规划|路线图|排期|设计稿|技术方案|proposal|roadmap|plan for|design doc|RFC|spec\b|specification)/i },
  { key: 'data', label: '数据 / 报告', re: /(数据|报表|报告|指标|统计|同比|环比|增长率|营收|转化率|季度|月报|周报|report|metrics|KPI|dashboard|quarterly|analytics|benchmark)/i },
  { key: 'process', label: '流程 / 规范', re: /(流程|规范|步骤|操作手册|手册|指南|须知|注意事项|SOP|checklist|how to|step[- ]by[- ]step|guideline|playbook|onboarding)/i },
  { key: 'tutorial', label: '教程 / 方法', re: /(教程|入门|最佳实践|技巧|方法论|深度解读|实战|tutorial|best practices?|tips|lessons? learned|deep dive|explained|guide to)/i },
  { key: 'recap', label: '纪要 / 复盘', re: /(纪要|会议记录|复盘|总结|回顾|要点|minutes|recap|retro(spective)?|summary|takeaways|post-?mortem)/i }
]

/** 一眼无价值：验证码、登录提醒、物流、营销促销、系统退信 */
const JUNK = /(验证码|校验码|动态码|登录提醒|登录通知|异地登录|安全提醒|密码重置|verification code|one-time (pass)?code|OTP|sign-?in (alert|attempt)|reset your password|快递|物流|签收|派送|已发货|shipped|delivery|tracking number|优惠|促销|限时|折扣|领券|秒杀|大促|% off|sale ends|limited time|coupon|promo|undeliverable|delivery status notification|退信|自动回复|auto-?reply|out of office)/i

/** 给单封邮件打分；返回 -Infinity 表示直接排除 */
export function scoreKnowledge(m: KbCandidateInput): KbScore {
  const reasons: string[] = []
  const subject = m.subject ?? ''
  const text = m.text ?? ''
  if (m.category === 'noise') return { id: m.id, score: -Infinity, reasons: ['噪声'] }
  if (JUNK.test(subject)) return { id: m.id, score: -Infinity, reasons: ['一次性通知 / 营销'] }
  const len = text.replace(/\s+/g, '').length
  let score = 0
  let groups = 0
  const pdfText = m.pdfText ?? ''
  for (const s of SIGNALS) {
    const inSubject = s.re.test(subject)
    const inBody = s.re.test(text.slice(0, 6000)) || (!!pdfText && s.re.test(pdfText.slice(0, 6000)))
    if (inSubject || inBody) {
      groups++
      score += inSubject ? 3 : 2
      reasons.push(s.label)
    }
  }
  if (len >= 800) score += 1
  if (len >= 2500) score += 1
  if (len < 200 && !m.hasPdf) score -= 3
  if (m.hasPdf) {
    score += 2
    reasons.push('PDF 资料')
  }
  score += pdfTextBonus(pdfText, reasons)
  if (m.isNewsletter || m.category === 'newsletter') {
    // Newsletter 只要「精华」：要有实质主题、够长
    if (!groups || len < 1500) return { id: m.id, score: -Infinity, reasons: ['普通订阅'] }
    reasons.push('Newsletter 精华')
  } else if (m.category === 'personal') {
    score += 1
    if (m.replied) {
      score += 1
      reasons.push('有来回')
    }
  } else if (m.category === 'notification') {
    score -= 1
  }
  if (m.fromMe) score -= 1
  return { id: m.id, score, reasons }
}

/** PDF 正文加分：内容够长（≥1500 字）+1；读起来像发票 / 合同等事务性单据的不加（它们归财务 / 附件管，不是知识） */
function pdfTextBonus(pdfText: string, reasons: string[]): number {
  const len = pdfText.replace(/\s+/g, '').length
  if (len < 1500) return 0
  if (/(发票代码|发票号码|价税合计|invoice\s*no|amount\s*due)/i.test(pdfText.slice(0, 4000))) return 0
  reasons.push('PDF 正文充实')
  return len >= 6000 ? 2 : 1
}

/** 挑出最值得学的 limit 封：分数 ≥ minScore，同分取更新的 */
export function pickKnowledge(list: KbCandidateInput[], opts: { limit: number; minScore?: number }): KbScore[] {
  const min = opts.minScore ?? 4
  const byId = new Map(list.map(m => [m.id, m]))
  return list
    .map(scoreKnowledge)
    .filter(s => Number.isFinite(s.score) && s.score >= min)
    .sort((a, b) => b.score - a.score || (byId.get(b.id)?.date ?? 0) - (byId.get(a.id)?.date ?? 0))
    .slice(0, Math.max(0, opts.limit))
}

// ---------------------------------------------------------------- 去重

/** 归一化：去空白标点、转小写 */
function norm(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 字符二元组（中文按字、英文按字母），Dice 系数 0~1 */
export function similarity(a: string, b: string): number {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const grams = (s: string) => {
    const m = new Map<string, number>()
    const chars = [...s]
    if (chars.length === 1) m.set(chars[0], 1)
    for (let i = 0; i < chars.length - 1; i++) {
      const g = chars[i] + chars[i + 1]
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ga = grams(x)
  const gb = grams(y)
  let inter = 0
  let total = 0
  for (const [g, n] of ga) {
    inter += Math.min(n, gb.get(g) ?? 0)
    total += n
  }
  for (const n of gb.values()) total += n
  return total ? (2 * inter) / total : 0
}

function tagOverlap(a: string[], b: string[]): number {
  const x = new Set(a.map(norm).filter(Boolean))
  const y = new Set(b.map(norm).filter(Boolean))
  if (!x.size || !y.size) return 0
  let inter = 0
  for (const t of x) if (y.has(t)) inter++
  return inter / Math.min(x.size, y.size)
}

export interface KbLike {
  id: string
  title: string
  content: string
  tags: string[]
  sourceMessageId?: string | null
}

export type DedupeDecision = { action: 'new' } | { action: 'merge'; id: string; sim: number } | { action: 'skip'; id: string; sim: number }

/**
 * 新条目 vs 已有条目：同一来源邮件或几乎相同 → 跳过；主题相近（标题像、或标签重合且要点像）→ 合并进旧条目；否则新建。
 */
export function dedupeDecision(c: { title: string; points: string[]; tags: string[]; sourceMessageId?: string | null }, existing: KbLike[], th: { skip?: number; merge?: number } = {}): DedupeDecision {
  const skipAt = th.skip ?? 0.85
  const mergeAt = th.merge ?? 0.55
  const body = c.points.join('\n')
  let best: { id: string; sim: number; dup: boolean } | null = null
  for (const e of existing) {
    if (c.sourceMessageId && e.sourceMessageId === c.sourceMessageId) return { action: 'skip', id: e.id, sim: 1 }
    const t = similarity(c.title, e.title)
    const b = body ? similarity(body, e.content.slice(0, 1200)) : 0
    const tags = tagOverlap(c.tags, e.tags)
    const sim = Math.max(t, t * 0.6 + tags * 0.25 + b * 0.15, b >= 0.8 ? b : 0)
    // 几乎相同 = 标题几乎一样且要点也像，或要点本身高度重合；标题一样但带来新要点的走合并
    const dup = (t >= skipAt && b >= 0.5) || b >= 0.9
    if (!best || sim > best.sim) best = { id: e.id, sim, dup }
  }
  if (best && best.dup) return { action: 'skip', id: best.id, sim: best.sim }
  if (best && best.sim >= mergeAt) return { action: 'merge', id: best.id, sim: best.sim }
  return { action: 'new' }
}

/** 合并：只追加旧条目里没有的要点；标签取并集（最多 6 个） */
export function mergeKb(old: { content: string; tags: string[] }, add: { points: string[]; tags: string[]; sourceLabel?: string | null }): { content: string; tags: string[]; added: number } {
  const fresh = add.points.filter(p => p.trim() && !old.content.split('\n').some(line => similarity(line, p) >= 0.7))
  const tags = [...old.tags]
  for (const t of add.tags) if (t && !tags.some(x => norm(x) === norm(t))) tags.push(t)
  if (!fresh.length) return { content: old.content, tags: tags.slice(0, 6), added: 0 }
  const tail = fresh.map(p => `- ${p}`).join('\n')
  const src = add.sourceLabel ? `\n\n补充（${add.sourceLabel}）：\n` : '\n\n补充：\n'
  return { content: `${old.content.trimEnd()}${src}${tail}`, tags: tags.slice(0, 6), added: fresh.length }
}

/** 新条目正文（Markdown 要点） */
export function kbContent(points: string[], sourceLabel?: string | null): string {
  const list = points.filter(p => p.trim()).map(p => `- ${p.trim()}`).join('\n')
  return sourceLabel ? `${list}\n\n来源：${sourceLabel}` : list
}
