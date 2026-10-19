import { randomUUID } from 'node:crypto'
import { effectiveStatus } from '@shared/finance'
import type { AgentRef, FinanceData, KbItem } from '@shared/types'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import type { AIService } from '../ai/service'
import { aiReady } from '../ai/service'
import type { UnderstandService } from '../ai/understand'
import type { AgentService } from '../ai/agent'
import type { InsightsService } from '../ai/insights'
import type { FinanceService } from '../finance/service'
import type { ProjectService } from '../projects/service'
import type { AttachmentService } from '../attachments/service'
import { attachmentText } from '../attachments/text'
import { allowsAI } from '../attachments/access'
import { KB_LEARN, JSON_RETRY_NUDGE } from '../ai/prompts'
import type { ActivityStore } from './activity'
import { isBudgetError, type AiBudget } from './budget'
import { DAY_MS } from './schedule'
import { dedupeDecision, kbContent, mergeKb, pickKnowledge, type KbCandidateInput } from './kb-pick'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 自动任务与首次整理共用的「干活」函数：全部复用现有服务（理解 / 待办收集 / 财务 / 附件 / 项目 / 知识库 / 记忆），
 * 这里只负责挑范围、计数、生成活动记录用的 refs。
 */
export interface WorkDeps {
  store: MailStore
  appStore: AppStore
  ai: AIService
  understand: UnderstandService
  agent: AgentService
  insights: InsightsService
  finance(): FinanceService | null
  projects(): ProjectService | null
  attachments(): AttachmentService | null
  activity: ActivityStore
  budget: AiBudget
  event(payload: unknown): void
}

const yieldLoop = () => new Promise(r => setImmediate(r))

function accountFilter(accountIds: string[] | null | undefined, col = 'm.account_id'): { sql: string; params: string[] } {
  if (!accountIds?.length) return { sql: '', params: [] }
  return { sql: ` AND ${col} IN (${accountIds.map(() => '?').join(',')})`, params: accountIds }
}

function myAddrs(store: MailStore): Set<string> {
  const set = new Set<string>()
  for (const a of store.listAccounts()) {
    if (a.email) set.add(a.email.toLowerCase())
    if (a.user?.includes('@')) set.add(a.user.toLowerCase())
  }
  return set
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/** 后台 AI 当前能不能用（AI 已配置 + 没超额 / 没在用电池）；不能时返回原因 */
export function aiBlockedReason(deps: Pick<WorkDeps, 'appStore' | 'budget'>): string | null {
  if (!aiReady(deps.appStore.getAI(), false)) return 'AI 未配置'
  return deps.budget.blocked()
}

// ---------------------------------------------------------------- 待办

export interface TodoSweepResult {
  checked: number
  ai: number
  stopped: string | null
  /** 本轮新收集的待办 */
  todos: { id: string; title: string }[]
  /** 扫描范围内邮件上所有未完成的待办（含之前已收集的） */
  linked: { id: string; title: string }[]
}

/** 扫描一段时间内的收件箱邮件：启发式理解 + 待办 / 会议待办收集；AI 可用时补跑值得的（最多 maxAi 封） */
export async function sweepTodos(deps: WorkDeps, opts: { since: number; accountIds?: string[] | null; ai: boolean; maxAi: number; limit?: number }): Promise<TodoSweepResult> {
  const startedAt = Date.now() - 1
  const af = accountFilter(opts.accountIds)
  const ids = (deps.store.db
    .prepare(
      `SELECT m.id FROM messages m LEFT JOIN folders f ON f.id = m.folder_id
       WHERE m.date >= ? AND (f.special = 'inbox' OR upper(m.folder_path) = 'INBOX')${af.sql}
       ORDER BY m.date DESC LIMIT ?`
    )
    .all(opts.since, ...af.params, opts.limit ?? 600) as { id: string }[]).map(r => r.id)
  let checked = 0
  let ai = 0
  let stopped: string | null = null
  // 先全部跑一遍启发式（便宜），AI 名额留给最后一批里最紧急的
  for (let i = 0; i < ids.length; i += 200) {
    const res = await deps.understand.sweep(ids.slice(i, i + 200), { ai: false, maxAi: 0 })
    checked += res.checked
    await yieldLoop()
  }
  if (opts.ai && opts.maxAi > 0 && ids.length) {
    // AI 补跑：按紧急度挑（sweep 内部排序），只看前 400 封
    const res = await deps.understand.sweep(ids.slice(0, 400), { ai: true, maxAi: opts.maxAi })
    ai = res.ai
    stopped = res.stopped
  }
  const todos = deps.store.db
    .prepare(`SELECT id, title FROM insights WHERE kind = 'todo' AND created_at >= ?${accountFilter(opts.accountIds, 'account_id').sql} ORDER BY created_at DESC`)
    .all(startedAt, ...(opts.accountIds ?? [])) as { id: string; title: string }[]
  if (todos.length) deps.event({ type: 'todos-changed' })
  const linked: { id: string; title: string }[] = []
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400)
    linked.push(...(deps.store.db.prepare(`SELECT id, title FROM insights WHERE kind = 'todo' AND status = 'open' AND message_id IN (${part.map(() => '?').join(',')})`).all(...part) as { id: string; title: string }[]))
  }
  return { checked, ai, stopped, todos, linked }
}

// ---------------------------------------------------------------- 财务

export interface FinanceWorkResult {
  ok: boolean
  error?: string
  scanned: number
  created: { id: string; title: string; kind: string }[]
  merged: number
  overdue: { id: string; title: string }[]
  rolled: number
}

export async function organizeFinance(deps: WorkDeps, days: number): Promise<FinanceWorkResult> {
  const fin = deps.finance()
  if (!fin) return { ok: false, error: '财务模块未就绪', scanned: 0, created: [], merged: 0, overdue: [], rolled: 0 }
  const before = new Set(fin.rows().map(r => r.id))
  const res = await fin.scan(days)
  if (!res.ok) return { ok: false, error: res.error, scanned: res.scanned, created: [], merged: res.merged, overdue: [], rolled: 0 }
  // 对账已在 scan 结束时重算；再顺延过期的订阅续费日
  const rolled = fin.rollRenewals().rolled
  const now = Date.now()
  const rows = fin.rows(false)
  const created = rows.filter(r => !before.has(r.id)).map(r => ({ id: r.id, title: r.title || r.data.counterparty, kind: r.data.kind }))
  const overdue = rows
    .filter(r => r.data.direction === 'out' && effectiveStatus(r.data as FinanceData, r.dueAt, now) === 'overdue')
    .map(r => ({ id: r.id, title: r.title || r.data.counterparty }))
  return { ok: true, scanned: res.scanned, created, merged: res.merged, overdue, rolled }
}

export function financeBreakdown(created: { kind: string }[]): string {
  const bills = created.filter(c => c.kind === 'bill' || c.kind === 'invoice' || c.kind === 'payment' || c.kind === 'receipt').length
  const subs = created.filter(c => c.kind === 'subscription').length
  const orders = created.filter(c => c.kind === 'order').length
  const parts: string[] = []
  if (bills) parts.push(`${bills} 笔账单`)
  if (subs) parts.push(`${subs} 个订阅`)
  if (orders) parts.push(`${orders} 个订单`)
  const rest = created.length - bills - subs - orders
  if (rest > 0) parts.push(`${rest} 笔其他款项`)
  return parts.join('、')
}

// ---------------------------------------------------------------- 附件

export interface AttachmentWorkResult {
  ok: boolean
  error?: string
  count: number
  bytes: number
  fresh: { id: string; filename: string }[]
  freshBytes: number
  releasable: number
  needDownload: number
}

/** 增量索引 + 分类 + 自动归档规则（scan 内含）；统计 since 之后的附件与可释放空间（只给建议，不自动释放） */
export async function organizeAttachments(deps: WorkDeps, opts: { since: number; accountIds?: string[] | null }): Promise<AttachmentWorkResult> {
  const svc = deps.attachments()
  if (!svc) return { ok: false, error: '附件中心未就绪', count: 0, bytes: 0, fresh: [], freshBytes: 0, releasable: 0, needDownload: 0 }
  const af = accountFilter(opts.accountIds, 'account_id')
  const ids = () =>
    new Set((deps.store.db.prepare(`SELECT id FROM attachment_index WHERE skip = 0${af.sql}`).all(...af.params) as { id: string }[]).map(r => r.id))
  const before = ids()
  await svc.scan()
  // 顺带为新的 PDF / 纯文本附件提取正文（有上限、逐个让出，不等它完成）
  void attachmentText()?.backfill({ limit: 20 }).catch(() => {})
  const rows = deps.store.db
    .prepare(`SELECT id, filename, size, date FROM attachment_index WHERE skip = 0 AND date >= ?${af.sql} ORDER BY date DESC`)
    .all(opts.since, ...af.params) as { id: string; filename: string; size: number; date: number }[]
  const freshRows = (deps.store.db.prepare(`SELECT id, filename, size FROM attachment_index WHERE skip = 0${af.sql} ORDER BY date DESC LIMIT 2000`).all(...af.params) as { id: string; filename: string; size: number }[]).filter(
    r => !before.has(r.id) && !r.id.startsWith('r:')
  )
  let releasable = 0
  let needDownload = 0
  try {
    const s = svc.suggest(Math.max(1, Math.round((Date.now() - opts.since) / DAY_MS)))
    releasable = s.releasableBytes
    needDownload = s.needDownload
  } catch {
    /* 建议只是附带信息 */
  }
  return {
    ok: true,
    count: rows.length,
    bytes: rows.reduce((s, r) => s + (r.size || 0), 0),
    fresh: freshRows.map(r => ({ id: r.id, filename: r.filename })),
    freshBytes: freshRows.reduce((s, r) => s + (r.size || 0), 0),
    releasable,
    needDownload
  }
}

// ---------------------------------------------------------------- 项目

export function organizeProjects(deps: WorkDeps, opts: { days: number; accountIds?: string[] | null; discoverDays?: number }): { ok: boolean; error?: string; added: number; suggested: number; projectIds: string[]; candidates: number; names: string[] } {
  const p = deps.projects()
  if (!p) return { ok: false, error: '项目模块未就绪', added: 0, suggested: 0, projectIds: [], candidates: 0, names: [] }
  const r = p.sweepRecent(opts.days, opts.accountIds)
  const d = opts.discoverDays ? p.discoverCount(opts.discoverDays) : { count: 0, names: [] }
  return { ok: true, ...r, candidates: d.count, names: d.names }
}

export function projectLabel(deps: WorkDeps, id: string): string {
  try {
    return deps.projects()?.get(id)?.data.name ?? '项目'
  } catch {
    return '项目'
  }
}

// ---------------------------------------------------------------- 知识库自主学习

export interface KbLearnResult {
  picked: number
  learned: KbItem[]
  merged: KbItem[]
  skipped: number
  unworthy: number
  memories: number
  stopped: string | null
  errors: number
}

function jsonFromText(text: string): any {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('AI 未返回 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

/** 候选邮件（只看正文已下载的；跳过垃圾 / 草稿 / 已发送 / 已存知识库 / 学过的） */
export function knowledgeCandidates(deps: WorkDeps, opts: { since: number; accountIds?: string[] | null }): KbCandidateInput[] {
  const af = accountFilter(opts.accountIds)
  const rows = deps.store.db
    .prepare(
      `SELECT m.id, m.subject, m.snippet, substr(coalesce(m.text,''), 1, 6000) AS text, m.from_addr, m.from_name, m.category,
              m.is_newsletter, m.flags, m.has_attachments, m.date
       FROM messages m LEFT JOIN folders f ON f.id = m.folder_id
       WHERE m.date >= ? AND coalesce(f.special,'') NOT IN ('trash','junk','drafts','sent')
         AND coalesce(m.saved_kb, 0) = 0 AND m.body_fetched = 1${af.sql}
       ORDER BY m.date DESC LIMIT 800`
    )
    .all(opts.since, ...af.params) as any[]
  if (!rows.length) return []
  const learned = deps.activity.learnedIds(rows.map(r => r.id))
  const fresh = rows.filter(r => !learned.has(r.id))
  const pdf = new Set<string>()
  const withAtt = fresh.filter(r => r.has_attachments).map(r => r.id)
  for (let i = 0; i < withAtt.length; i += 400) {
    const part = withAtt.slice(i, i + 400)
    const q = part.map(() => '?').join(',')
    for (const r of deps.store.db
      .prepare(`SELECT DISTINCT message_id FROM attachments WHERE message_id IN (${q}) AND (lower(filename) LIKE '%.pdf' OR lower(content_type) LIKE '%pdf%')`)
      .all(...part) as any[])
      pdf.add(r.message_id)
    try {
      // PDF 与 Word / PowerPoint 文档都算「资料」（正文由附件正文服务提取，Office 同样经过授权闸门）
      for (const r of deps.store.db.prepare(`SELECT DISTINCT message_id FROM attachment_index WHERE message_id IN (${q}) AND ext IN ('pdf', 'docx', 'doc', 'pptx', 'odt', 'odp') AND skip = 0`).all(...part) as any[]) pdf.add(r.message_id)
    } catch {
      /* 附件索引表未建（附件中心未启动） */
    }
  }
  const mine = myAddrs(deps.store)
  const pdfTexts = pdfTextsOf([...pdf])
  // 同一会话里有我的回信也算「有来回」：按主题粗判，标志位优先
  return fresh.map(r => ({
    id: r.id,
    subject: r.subject ?? '',
    text: String(r.text || r.snippet || ''),
    fromAddr: r.from_addr ?? '',
    fromName: r.from_name ?? '',
    category: r.category ?? 'personal',
    isNewsletter: !!r.is_newsletter,
    fromMe: mine.has(String(r.from_addr ?? '').toLowerCase()),
    replied: String(r.flags ?? '').includes('\\Answered'),
    hasPdf: pdf.has(r.id),
    ...(pdfTexts.has(r.id) ? { pdfText: pdfTexts.get(r.id) } : {}),
    hasAttachments: !!r.has_attachments,
    date: Number(r.date) || 0
  }))
}

/** 已提取过的 PDF 正文节选（只读缓存，不触发提取；附件正文服务未就绪时为空） */
function pdfTextsOf(messageIds: string[]): Map<string, string> {
  try {
    return attachmentText()?.cachedTextsForMessages(messageIds, 6000) ?? new Map()
  } catch {
    return new Map()
  }
}

/** 挑中的邮件带 PDF 时：取正文节选一并交给 AI 提炼（必要时现提取，单封最多 2 个 PDF） */
async function pdfExcerptFor(messageId: string, maxChars: number): Promise<string> {
  // PDF 正文要交给 AI 提炼：需要允许发给当前 AI（本机读取授权由正文服务把关）
  if (!allowsAI()) return ''
  try {
    const r = await attachmentText()?.pdfExcerpt(messageId, maxChars)
    return r?.text ? `\n\n附件 PDF 正文（节选）：\n${r.text}` : ''
  } catch {
    return ''
  }
}

/**
 * 挑高价值邮件 → AI 提炼知识条目 → 与已有条目去重（相似的合并、几乎相同的跳过）→ 存知识库 →
 * 用 Agent 记忆学习沉淀长期记忆。limit = 本轮最多学几封（每封 1 次 AI 请求，记忆学习另计、最多 3 封）。
 */
export async function learnKnowledge(deps: WorkDeps, opts: { since: number; limit: number; accountIds?: string[] | null; memoryMax?: number }): Promise<KbLearnResult> {
  const out: KbLearnResult = { picked: 0, learned: [], merged: [], skipped: 0, unworthy: 0, memories: 0, stopped: null, errors: 0 }
  if (opts.limit <= 0) return out
  const picked = pickKnowledge(knowledgeCandidates(deps, opts), { limit: opts.limit })
  out.picked = picked.length
  if (!picked.length) return out
  const existing = deps.store.listKbItems()
  const learnedMsgIds: string[] = []
  for (const p of picked) {
    const why = deps.budget.blocked()
    if (why) {
      out.stopped = why
      break
    }
    const row = deps.store.getMessageRow(p.id)
    if (!row) continue
    const pdfPart = p.reasons.includes('PDF 资料') ? await pdfExcerptFor(p.id, 3000) : ''
    const user =
      `发件人：${row.from_name ?? ''} <${row.from_addr ?? ''}>\n日期：${new Date(row.date ?? Date.now()).toLocaleDateString('zh-CN')}\n主题：${row.subject ?? ''}\n` +
      `（规则判断的价值信号：${p.reasons.join('、') || '—'}）\n\n正文：\n${String(row.text || row.snippet || '').slice(0, 5000)}${pdfPart}`
    let parsed: any
    try {
      const ask = (extra: string) =>
        deps.ai.complete(
          [
            { role: 'system', content: KB_LEARN + (extra ? `\n\n${extra}` : '') },
            { role: 'user', content: user }
          ],
          900
        )
      try {
        parsed = jsonFromText(await ask(''))
      } catch (err) {
        if (isBudgetError(err)) throw err
        parsed = jsonFromText(await ask(JSON_RETRY_NUDGE))
      }
    } catch (err) {
      if (isBudgetError(err)) {
        out.stopped = err instanceof Error ? err.message : String(err)
        break
      }
      out.errors++
      // 网络 / 模型错误：不记「学过」，下次还能再试；连续出错就别再烧请求了
      if (out.errors >= 3) {
        out.stopped = err instanceof Error ? err.message : String(err)
        break
      }
      continue
    }
    if (!parsed || parsed.worth === false) {
      out.unworthy++
      deps.activity.markLearned(p.id, 'unworthy')
      continue
    }
    const points: string[] = (Array.isArray(parsed.points) ? parsed.points : []).map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 8)
    const title = String(parsed.title || row.subject || '').trim().slice(0, 60)
    if (!title || !points.length) {
      out.unworthy++
      deps.activity.markLearned(p.id, 'unworthy')
      continue
    }
    const tags: string[] = (Array.isArray(parsed.tags) ? parsed.tags : []).map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 5)
    const sourceLabel = `${row.from_addr ?? ''} · ${row.subject ?? ''}`
    const decision = dedupeDecision({ title, points, tags, sourceMessageId: p.id }, existing)
    if (decision.action === 'skip') {
      out.skipped++
      deps.activity.markLearned(p.id, 'skip', decision.id)
      continue
    }
    if (decision.action === 'merge') {
      const old = existing.find(e => e.id === decision.id)!
      const m = mergeKb(old, { points, tags, sourceLabel: row.subject ?? null })
      if (!m.added) {
        out.skipped++
        deps.activity.markLearned(p.id, 'skip', old.id)
        continue
      }
      deps.store.updateKbItem(old.id, { content: m.content, tags: m.tags })
      old.content = m.content
      old.tags = m.tags
      out.merged.push(old)
      deps.activity.markLearned(p.id, 'merge', old.id)
      learnedMsgIds.push(p.id)
      continue
    }
    const item: KbItem = {
      id: randomUUID(),
      kind: 'summary',
      title,
      content: kbContent(points),
      sourceMessageId: p.id,
      sourceLabel,
      tags,
      createdAt: Date.now()
    }
    deps.store.saveKbItem(item)
    deps.store.setSavedKb(p.id, true)
    existing.unshift(item)
    out.learned.push(item)
    deps.activity.markLearned(p.id, 'new', item.id)
    learnedMsgIds.push(p.id)
  }
  // 长期记忆：从学到的邮件里沉淀人物 / 承诺 / 惯例（每封 1 次请求，限 memoryMax 封）
  const memMax = opts.memoryMax ?? 3
  if (learnedMsgIds.length && memMax > 0 && !out.stopped && !deps.budget.blocked()) {
    try {
      const mem = await deps.agent.learnFromMessages(learnedMsgIds, memMax)
      out.memories = mem.length
    } catch {
      /* 记忆只是附带 */
    }
  }
  if (out.learned.length || out.merged.length) deps.event({ type: 'kb-changed' })
  return out
}

export function kbRefs(r: KbLearnResult): AgentRef[] {
  const seen = new Set<string>()
  return [...r.learned, ...r.merged]
    .filter(k => !seen.has(k.id) && !!seen.add(k.id))
    .slice(0, 10)
    .map(k => ({ type: 'kb' as const, id: k.id, label: k.title }))
}
