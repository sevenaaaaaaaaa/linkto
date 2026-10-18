import { randomUUID } from 'node:crypto'
import type { AISettings, CompanyInsight, DailyDigest } from '@shared/types'
import {
  EXTRACT_MESSAGE, DAILY_DIGEST, COMPANY_PROFILE, RANK_MESSAGES, ASK_BULK,
  SCREEN_SUGGEST, SCREEN_BATCH, COMPOSE_QUERY, SNOOZE_SUGGEST,
  JUDGE_FOLLOWUPS, FOLLOWUP_DRAFT, JSON_RETRY_NUDGE
} from './prompts'
import type { MailStore } from '../db'
import { aiReady, type AIService } from './service'

const BILL_RE = /(账单|还款|信用卡|扣款|发票|收据|对账单|invoice|statement|payment due|billing)/i
const MEETING_RE = /(会议|日程|日历邀请|议程|邀请你参加|meeting invitation|calendar invite|zoom|teams meet|腾讯会议|飞书会议)/i

function jsonFromText(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('AI 未返回 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

export function domainOf(addr: string | null | undefined): string {
  if (!addr) return ''
  return addr.split('@').pop()?.toLowerCase() ?? ''
}

function todayPeriod(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 智能洞察：基于用户自配 AI 的结构化提炼层。
 *  - 账单/会议邮件 → 待办；Newsletter → 阅读清单（自动，正则预过滤控制成本）
 *  - 每日商情：当日重点 + 主题 digest + 备忘录 + 清理建议
 *  - 公司洞察：时间线 + 运营策略 + 品牌可信度 + 转化指数
 */
export class InsightsService {
  private runningDaily = false
  private runningCompany = new Set<string>()

  constructor(
    private deps: {
      ai: AIService
      store: MailStore
      getAISettings(): AISettings
      event(payload: unknown): void
      /** 可选：Agent 长期记忆注入（query 检索相关记忆） */
      getMemoryContext?(query: string): string | null
      /** 可选：每日商情生成后回调（用于 Agent 自动学习近期邮件） */
      onDailyGenerated?(messageIds: string[]): void
    }
  ) {}

  private ready(): boolean {
    return aiReady(this.deps.getAISettings())
  }

  private async json<T>(system: string, user: string): Promise<T> {
    const ask = (extra: string) => {
      const sys = system + (extra ? `\n\n${extra}` : '')
      return this.deps.ai.complete(
        [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ],
        3000
      )
    }
    // 端侧小模型首轮可能跑题：首轮失败则带着「只输出JSON」强化重试一次
    try {
      const first = await ask('')
      return jsonFromText(first) as T
    } catch {
      const retry = await ask(JSON_RETRY_NUDGE)
      return jsonFromText(retry) as T
    }
  }

  private emitChanged() {
    this.deps.event({ type: 'insights-changed' })
  }

  // ---------- 单封提炼 ----------

  /** 廉价预过滤：是否值得花一次 AI 调用 */
  static worthExtracting(subject: string, snippet: string, isNewsletter: boolean): boolean {
    if (isNewsletter) return true
    const s = `${subject} ${snippet}`
    return BILL_RE.test(s) || MEETING_RE.test(s)
  }

  async extractFromMessage(messageId: string): Promise<{ ok: boolean; error?: string; created: string[] }> {
    if (!this.ready()) return { ok: false, error: 'AI 未启用（设置 → AI 配置后可用）', created: [] }
    const row = this.deps.store.getMessageRow(messageId)
    if (!row) return { ok: false, error: '邮件不存在', created: [] }
    const created: string[] = []
    try {
      const text = String(row.text || row.snippet || '').slice(0, 6000)
      const result = await this.json<{
        type: string
        todos?: { title: string; due?: string; amount?: string; link?: string }[]
        reading?: { title: string; url?: string; summary?: string }[]
      }>(
        EXTRACT_MESSAGE,
        `发件人：${row.from_name ?? ''} <${row.from_addr ?? ''}>\n主题：${row.subject}\n\n正文：\n${text}`
      )
      for (const t of result.todos ?? []) {
        if (!t.title) continue
        const id = `todo-${randomUUID()}`
        this.deps.store.insertInsight({
          id,
          kind: 'todo',
          accountId: row.account_id,
          messageId,
          title: t.title,
          data: { amount: t.amount ?? null, link: t.link ?? null, from: row.from_name ?? row.from_addr ?? '' },
          dueAt: t.due ? Date.parse(t.due) || null : null
        })
        created.push('待办')
      }
      for (const r of result.reading ?? []) {
        if (!r.title) continue
        const id = `reading-${randomUUID()}`
        this.deps.store.insertInsight({
          id,
          kind: 'reading',
          accountId: row.account_id,
          messageId,
          title: r.title,
          data: { url: r.url ?? null, summary: r.summary ?? null, from: row.from_name ?? row.from_addr ?? '' }
        })
        created.push('阅读清单')
      }
      if (created.length) this.emitChanged()
      return { ok: true, created: [...new Set(created)] }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), created: [] }
    }
  }

  // ---------- 每日商情 ----------

  async generateDaily(force = false): Promise<{ ok: boolean; error?: string; digest?: DailyDigest }> {
    if (!this.ready()) return { ok: false, error: 'AI 未启用（设置 → AI 配置后可用）' }
    if (this.runningDaily) return { ok: false, error: '正在生成中' }
    const period = todayPeriod()
    if (!force) {
      const existing = this.deps.store.latestInsight('daily', period)
      if (existing) return { ok: true, digest: existing.data as unknown as DailyDigest }
    }
    this.runningDaily = true
    try {
      const since = Date.now() - 36 * 3600_000
      const rows = this.deps.store.db
        .prepare(
          `SELECT id, subject, snippet, from_name, from_addr, category, date FROM messages
           WHERE date > ? AND category != 'noise' ORDER BY date DESC LIMIT 100`
        )
        .all(since) as { id: string; subject: string; snippet: string; from_name: string; from_addr: string; category: string; date: number }[]
      if (!rows.length) return { ok: false, error: '近期没有邮件可整理' }
      const validIds = new Set(rows.map(r => r.id))
      const lines = rows
        .map(
          (r, i) =>
            `${i}. [${r.id}] ${r.from_name || r.from_addr} · ${r.subject} · ${new Date(r.date).toLocaleString('zh-CN')} · ${r.snippet.slice(0, 100)}`
        )
        .join('\n')
      const senders = new Set(rows.map(r => r.from_addr)).size
      const memoryBlock = this.deps.getMemoryContext?.(rows.map(r => r.subject).join(' ')) ?? ''
      const digest = await this.json<DailyDigest>(
        DAILY_DIGEST +
          (memoryBlock ? `分析时主动利用你对用户的长期记忆（人、事、偏好、承诺），重点照会承诺类记忆。${memoryBlock}` : ''),
        `今天是 ${new Date().toLocaleDateString('zh-CN')}。近 36 小时邮件 ${rows.length} 封、${senders} 个发件人：\n${lines}`
      )
      const clean: DailyDigest = {
        highlights: (digest.highlights ?? []).slice(0, 8).map(String),
        themes: (digest.themes ?? []).slice(0, 6).map(t => ({ theme: String(t.theme ?? ''), summary: String(t.summary ?? ''), count: Number(t.count ?? 0) })),
        memo: String(digest.memo ?? ''),
        deleteSuggestions: (digest.deleteSuggestions ?? [])
          .filter(d => validIds.has(d.messageId))
          .slice(0, 6)
          .map(d => ({ messageId: d.messageId, subject: String(d.subject ?? ''), from: String(d.from ?? ''), reason: String(d.reason ?? '') })),
        stats: { total: rows.length, senders },
        generatedAt: Date.now()
      }
      this.deps.store.deleteInsight(`daily-${period}`)
      this.deps.store.insertInsight({
        id: `daily-${period}`,
        kind: 'daily',
        title: `每日商情 ${period}`,
        data: clean as unknown as Record<string, unknown>,
        period
      })
      // 商情生成后，让 Agent 自动学习今日重点邮件（日积月累）
      const learnIds = rows
        .filter(r => clean.highlights.some(h => r.subject && h.includes(r.subject.slice(0, 10))) || clean.themes.some(t => r.subject && t.theme && r.subject.includes(t.theme)))
        .map(r => r.id)
        .slice(0, 6)
      this.deps.onDailyGenerated?.(learnIds)
      this.emitChanged()
      return { ok: true, digest: clean }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.runningDaily = false
    }
  }

  /** 定时钩子（主进程每 30 分钟调用）：AI 开启且当日未生成则自动生成 */
  async maybeAutoDaily() {
    const s = this.deps.getAISettings()
    if (!s.enabled || !s.autoDigest) return
    const apiKeyOk = s.baseURL === 'builtin-local' || !!s.apiKey
    if (!apiKeyOk) return
    const hour = new Date().getHours()
    if (hour < 8) return
    if (this.deps.store.latestInsight('daily', todayPeriod())) return
    await this.generateDaily().catch(() => {})
  }

  // ---------- 公司洞察 ----------

  async companyProfile(domain: string): Promise<{ ok: boolean; error?: string; insight?: CompanyInsight }> {
    if (!this.ready()) return { ok: false, error: 'AI 未启用（设置 → AI 配置后可用）' }
    const d = domain.trim().toLowerCase()
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return { ok: false, error: '请输入有效域名（如 stripe.com）' }
    if (this.runningCompany.has(d)) return { ok: false, error: '正在分析中' }
    this.runningCompany.add(d)
    try {
      const rows = this.deps.store.db
        .prepare(
          `SELECT id, subject, snippet, from_name, from_addr, date FROM messages
           WHERE lower(from_addr) LIKE ? ORDER BY date ASC LIMIT 60`
        )
        .all(`%@${d}`) as { id: string; subject: string; snippet: string; from_name: string; from_addr: string; date: number }[]
      if (rows.length < 2) return { ok: false, error: `来自 ${d} 的邮件太少（${rows.length} 封），至少需要 2 封才能分析` }
      const lines = rows
        .map(r => `${new Date(r.date).toLocaleDateString('zh-CN')} · ${r.subject} · ${r.snippet.slice(0, 80)}`)
        .join('\n')
      const company = rows.find(r => r.from_name)?.from_name ?? d
      const result = await this.json<{
        company: string
        summary: string
        timeline: { period: string; event: string }[]
        strategy: string
        credibility: { score: number; reasons: string }
        conversionIndex: { score: number; reasons: string }
      }>(
        COMPANY_PROFILE,
        `公司域名：${d}\n共 ${rows.length} 封邮件（时间正序）：\n${lines}`
      )
      const insight: CompanyInsight = {
        company: String(result.company || company),
        domain: d,
        summary: String(result.summary ?? ''),
        timeline: (result.timeline ?? []).slice(0, 10).map(t => ({ period: String(t.period ?? ''), event: String(t.event ?? '') })),
        strategy: String(result.strategy ?? ''),
        credibility: {
          score: Math.max(0, Math.min(100, Number(result.credibility?.score ?? 50))),
          reasons: String(result.credibility?.reasons ?? '')
        },
        conversionIndex: {
          score: Math.max(0, Math.min(100, Number(result.conversionIndex?.score ?? 50))),
          reasons: String(result.conversionIndex?.reasons ?? '')
        },
        mailCount: rows.length,
        generatedAt: Date.now()
      }
      this.deps.store.deleteInsight(`company-${d}`)
      this.deps.store.insertInsight({
        id: `company-${d}`,
        kind: 'company',
        title: d,
        data: insight as unknown as Record<string, unknown>,
        period: d
      })
      this.emitChanged()
      return { ok: true, insight }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.runningCompany.delete(d)
    }
  }

  latestCompany(domain: string): CompanyInsight | undefined {
    const r = this.deps.store.latestInsight('company', domain.trim().toLowerCase())
    return r?.data as unknown as CompanyInsight | undefined
  }

  // ---------- Screener AI 建议（AI 版筛选：代理先替你看一眼） ----------

  async screenSuggest(addr: string): Promise<{ ok: boolean; error?: string; verdict: 'allow' | 'deny'; reason: string }> {
    const empty = { verdict: 'allow' as const, reason: '' }
    if (!this.ready()) return { ok: false, error: 'AI 未启用', ...empty }
    const rows = this.deps.store.db
      .prepare(
        `SELECT subject, snippet, date, category, is_newsletter FROM messages
         WHERE lower(from_addr) = ? ORDER BY date DESC LIMIT 2`
      )
      .all(addr.toLowerCase()) as { subject: string; snippet: string; date: number; category: string; is_newsletter: number }[]
    if (!rows.length) return { ok: false, error: '该发件人暂无邮件', ...empty }
    try {
      const local = rows[0].category === 'newsletter' || rows[0].is_newsletter ? 'newsletter' : rows[0].category
      const result = await this.json<{ verdict: 'allow' | 'deny'; reason: string }>(
        SCREEN_SUGGEST,
        `发件人：${addr}\n本地分类：${local}\n` +
          rows.map(r => `主题：${r.subject}\n摘要：${String(r.snippet).slice(0, 160)}`).join('\n---\n')
      )
      const verdict = result.verdict === 'deny' ? 'deny' : 'allow'
      return { ok: true, verdict, reason: String(result.reason ?? '').slice(0, 60) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ...empty }
    }
  }

  // ---------- AI 纪律解法 ----------

  /** 自然语言问句 → 结构化邮件查询（AI 版搜索：问问题而不是猜关键词） */
  async composeQuery(question: string): Promise<{ ok: boolean; error?: string; query: import('@shared/types').NLQuery }> {
    const empty = { text: '', sender: '', subject: '', category: null, isNewsletter: null, hasAttachment: null, unreadOnly: null, withinDays: null, after: null, before: null, fallbackText: '' }
    if (!this.ready()) return { ok: false, error: 'AI 未启用（设置 → AI 配置后可用）', query: empty }
    if (!question.trim()) return { ok: false, error: '请输入问题', query: empty }
    try {
      const today = new Date().toISOString().slice(0, 10)
      const q = await this.json<Record<string, unknown>>(
        '把用户问题编译成邮件查询 JSON。输出格式：{"text":"","sender":"","subject":"","category":null,"isNewsletter":null,"hasAttachment":null,"unreadOnly":null,"withinDays":null,"after":null,"before":null,"fallbackText":""}。字段含义：sender=发件人关键词，subject=主题关键词，category=personal/notification/newsletter/noise，withinDays=最近N天。只填问题里明确提到的字段，其余保持 null/空串。只输出 JSON。\n\n示例1：问"上周王小明发的邮件"→{"sender":"王小明","withinDays":7}\n示例2：问"最近三天带附件的账单"→{"subject":"账单","hasAttachment":true,"withinDays":3}\n示例3：问"未读的订阅邮件"→{"isNewsletter":true,"unreadOnly":true}\n示例4：问"上个月的会议邀请"→{"subject":"会议","withinDays":30}',
        `今天 ${today}。用户的问题：${question}`
      )
      const query = {
        text: typeof q.text === 'string' ? q.text : '',
        sender: typeof q.sender === 'string' ? q.sender : '',
        subject: typeof q.subject === 'string' ? q.subject : '',
        category: (typeof q.category === 'string' && ['personal','notification','newsletter','noise'].includes(q.category) ? q.category : null) as import('@shared/types').NLQuery['category'],
        isNewsletter: typeof q.isNewsletter === 'boolean' ? q.isNewsletter : null,
        hasAttachment: typeof q.hasAttachment === 'boolean' ? q.hasAttachment : null,
        unreadOnly: typeof q.unreadOnly === 'boolean' ? q.unreadOnly : null,
        withinDays: typeof q.withinDays === 'number' ? q.withinDays : null,
        after: typeof q.after === 'string' ? q.after : null,
        before: typeof q.before === 'string' ? q.before : null,
        fallbackText: typeof q.fallbackText === 'string' ? q.fallbackText : ''
      }
      return { ok: true, query }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), query: empty }
    }
  }

  /** Snooze AI 建议：读内容判断什么时候该回来（账单→还款日前、会议→会前1小时、通知→今晚） */
  async snoozeSuggest(messageId: string): Promise<{ ok: boolean; error?: string; at: number; reason: string }> {
    const now = Date.now()
    if (!this.ready()) return { ok: false, error: 'AI 未启用', at: now + 3600_000, reason: '' }
    const row = this.deps.store.getMessageRow(messageId)
    if (!row) return { ok: false, error: '邮件不存在', at: now + 3600_000, reason: '' }
    try {
      const r = await this.json<{ hours: number; reason: string }>(
        SNOOZE_SUGGEST,
        `现在时间：${new Date().toLocaleString('zh-CN')}\n主题：${row.subject}\n摘要：${String(row.snippet).slice(0, 300)}\n正文：${String(row.text || '').slice(0, 1200)}`
      )
      let hours = Math.max(0.5, Math.min(336, Number(r.hours ?? 24)))
      if (!Number.isFinite(hours)) hours = 24
      return { ok: true, at: Date.now() + hours * 3600_000, reason: String(r.reason ?? '').slice(0, 40) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), at: now + 3600_000, reason: '' }
    }
  }

  /** 待跟进批量判断：结合上下文判断哪些真的需要催（避免催已解决的事） */
  async judgeFollowups(ids: string[]): Promise<{ ok: boolean; error?: string; judgements: import('@shared/types').FollowupJudgement[] }> {
    if (!this.ready()) return { ok: false, error: 'AI 未启用（设置 → AI 配置后可用）', judgements: [] }
    try {
      const rows = ids
        .map(id => this.deps.store.getMessageRow(id))
        .filter(Boolean)
        .map(r => ({
          id: r.id,
          subject: r.subject,
          to: r.to_json,
          date: new Date(r.date).toLocaleDateString('zh-CN'),
          text: String(r.text || r.snippet || '').slice(0, 300)
        }))
      if (!rows.length) return { ok: true, judgements: [] }
      const memoryBlock = this.deps.getMemoryContext?.(rows.map(r => r.subject).join(' ')) ?? ''
      const lines = rows.map((r, i) => `${i}. [${r.id}] ${r.subject}（发给 ${r.to}，${r.date}）\n   ${r.text}`).join('\n')
      const result = await this.json<{ judgements: { index: number; needsFollowup: boolean; urgency: string; reason: string }[] }>(
        JUDGE_FOLLOWUPS
          + (memoryBlock ? `\n\n结合用户长期记忆判断（注意承诺类记忆）。${memoryBlock}` : ''),
        lines
      )
      const judgements: import('@shared/types').FollowupJudgement[] = []
      for (const j of result.judgements ?? []) {
        const row = rows[j.index]
        if (!row) continue
        judgements.push({
          messageId: row.id,
          needsFollowup: j.needsFollowup !== false,
          urgency: j.urgency === 'high' ? 'high' : j.urgency === 'low' ? 'low' : 'medium',
          reason: String(j.reason ?? '').slice(0, 50)
        })
      }
      return { ok: true, judgements }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), judgements: [] }
    }
  }

  /** 催促信草稿：基于原邮件 + 线程上下文写一封得体的 nudge */
  async followupDraft(messageId: string): Promise<{ ok: boolean; error?: string; subject: string; body: string }> {
    if (!this.ready()) return { ok: false, error: 'AI 未启用', subject: '', body: '' }
    const row = this.deps.store.getMessageRow(messageId)
    if (!row) return { ok: false, error: '邮件不存在', subject: '', body: '' }
    try {
      const r = await this.json<{ subject: string; body: string }>(
        FOLLOWUP_DRAFT,
        `原邮件：${row.subject}\n时间：${new Date(row.date).toLocaleDateString('zh-CN')}\n收件人：${row.to_json}\n内容：${String(row.text || row.snippet || '').slice(0, 1200)}`
      )
      return { ok: true, subject: String(r.subject || `Re: ${row.subject}`), body: String(r.body ?? '') }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), subject: '', body: '' }
    }
  }

  /** Screener 批量 AI 审批：一次调用判完整个待审队列 */
  async screenBatch(addrs: string[]): Promise<{ ok: boolean; error?: string; verdicts: { addr: string; verdict: 'allow' | 'deny'; reason: string }[] }> {
    if (!this.ready()) return { ok: false, error: 'AI 未启用（设置 → AI 配置后可用）', verdicts: [] }
    if (!addrs.length) return { ok: true, verdicts: [] }
    try {
      const parts: string[] = []
      addrs.forEach((addr, i) => {
        const rows = this.deps.store.db
          .prepare('SELECT subject, snippet, category, is_newsletter FROM messages WHERE lower(from_addr) = ? ORDER BY date DESC LIMIT 2')
          .all(addr.toLowerCase()) as { subject: string; snippet: string; category: string; is_newsletter: number }[]
        const sample = rows.map(r => `  主题：${r.subject}｜${String(r.snippet).slice(0, 80)}`).join('\n') || '  （无样本）'
        parts.push(`[${i}] ${addr}\n${sample}`)
      })
      const result = await this.json<{ verdicts: { index: number; verdict: string; reason: string }[] }>(
        SCREEN_BATCH,
        parts.join('\n'))
      const verdicts = (result.verdicts ?? [])
        .map(v => ({ addr: addrs[v.index], verdict: (v.verdict === 'deny' ? 'deny' : 'allow') as 'allow' | 'deny', reason: String(v.reason ?? '').slice(0, 40) }))
        .filter(v => v.addr)
      return { ok: true, verdicts }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), verdicts: [] }
    }
  }

  // ---------- 魔法排序 / 批量提问 ----------

  /** 魔法排序：AI 按重要性/紧急度给选中邮件排序，写入 pin 顺序（同时自动置顶） */
  async rankMessages(ids: string[]): Promise<{ ok: boolean; error?: string; ranked: { id: string; reason: string }[] }> {
    if (!this.ready()) return { ok: false, error: 'AI 未启用（设置 → AI 配置后可用）', ranked: [] }
    if (ids.length < 2) return { ok: false, error: '至少选择两封邮件再魔法排序', ranked: [] }
    try {
      const rows = ids
        .map(id => this.deps.store.getMessageRow(id))
        .filter(Boolean)
        .map(r => ({
          id: r.id,
          subject: r.subject,
          from: r.from_name || r.from_addr,
          date: new Date(r.date).toLocaleDateString('zh-CN'),
          snippet: String(r.snippet ?? '').slice(0, 90),
          unread: !(r.flags ?? '').includes('\\Seen'),
          flagged: (r.flags ?? '').includes('\\Flagged')
        }))
      const lines = rows
        .map((r, i) => `${i}. [${r.id}] ${r.subject} · ${r.from} · ${r.date}${r.unread ? ' · 未读' : ''}${r.flagged ? ' · 已旗标' : ''}\n   ${r.snippet}`)
        .join('\n')
      const result = await this.json<{ ranked: { id: string; reason: string }[] }>(
        RANK_MESSAGES,
        `共 ${rows.length} 封：\n${lines}`
      )
      const given = new Set(ids)
      const ranked = (result.ranked ?? []).filter(r => given.has(r.id))
      // AI 漏掉的追加在末尾，保持原顺序
      const seen = new Set(ranked.map(r => r.id))
      for (const id of ids) {
        if (!seen.has(id)) ranked.push({ id, reason: '' })
      }
      this.deps.store.setPinnedOrder(ranked.map(r => r.id))
      return { ok: true, ranked }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), ranked: [] }
    }
  }

  /** 批量提问：基于选中邮件回答问题，并顺手提炼 todo 清单（支持记忆注入） */
  async askBulk(
    ids: string[],
    question: string,
    memoryBlock = ''
  ): Promise<{ ok: boolean; error?: string; answer: string; todos: { title: string; due?: string | null }[] }> {
    if (!this.ready()) return { ok: false, error: 'AI 未启用（设置 → AI 配置后可用）', answer: '', todos: [] }
    if (!ids.length) return { ok: false, error: '请先选择邮件', answer: '', todos: [] }
    try {
      const rows = ids
        .map(id => this.deps.store.getMessageRow(id))
        .filter(Boolean)
        .map(r => ({
          id: r.id,
          subject: r.subject,
          from: r.from_name || r.from_addr,
          date: new Date(r.date).toLocaleDateString('zh-CN'),
          text: String(r.text || r.snippet || '').slice(0, 1200)
        }))
      const lines = rows.map((r, i) => `【邮件${i + 1}】${r.subject}（${r.from}，${r.date}）\n${r.text}`).join('\n\n')
      const result = await this.json<{ answer: string; todos: { title: string; due?: string | null }[] }>(
        ASK_BULK +
          (memoryBlock ? `\n\n回答时主动利用你对用户的长期记忆，但不要逐条罗列。${memoryBlock}` : ''),
        `用户的问题：${question}\n\n选中的 ${rows.length} 封邮件：\n${lines}`
      )
      return { ok: true, answer: String(result.answer ?? ''), todos: (result.todos ?? []).slice(0, 12).filter(t => t.title) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), answer: '', todos: [] }
    }
  }
}
