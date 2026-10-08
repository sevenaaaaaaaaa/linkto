import { randomUUID } from 'node:crypto'
import type { AISettings, CompanyInsight, DailyDigest } from '@shared/types'
import type { MailStore } from '../db'
import type { AIService } from './service'

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
    }
  ) {}

  private ready(): boolean {
    const s = this.deps.getAISettings()
    return s.enabled && !!s.apiKey
  }

  private async json<T>(system: string, user: string): Promise<T> {
    const text = await this.deps.ai.complete([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ])
    return jsonFromText(text) as T
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
        '你是邮件智能助手。从邮件中提取结构化信息，只输出 JSON：{"type":"bill|meeting|newsletter|other","todos":[{"title":"待办事项","due":"YYYY-MM-DD HH:mm 或 null","amount":"金额或 null","link":"相关链接或 null"}],"reading":[{"title":"文章标题","url":"链接或 null","summary":"一句话摘要"}]}。规则：账单/缴费/发票类和会议邀请类提取 todos（每封 1-3 条）；Newsletter 提取 reading（列出主要文章，最多 5 条）；无关内容输出空数组。所有文本用中文。',
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
      const digest = await this.json<DailyDigest>(
        '你是邮件商情助手。分析用户近期邮件，只输出 JSON：{"highlights":["今日重点1","重点2"],"themes":[{"theme":"主题名","summary":"该主题串讲","count":3}],"memo":"给用户的一句话备忘","deleteSuggestions":[{"messageId":"必须来自列表","subject":"","from":"","reason":"为什么可以删"}]}。要求：highlights 3-6 条（按紧急/重要排序，提及截止时间）；themes 2-5 个（跨邮件按主题归纳，这是 digest 核心）；memo ≤50 字；deleteSuggestions 只挑明确无价值且可安全删除的（过期通知、旧验证码、营销噪声），最多 5 条，理由具体。全部中文。',
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
    if (!s.enabled || !s.autoDigest || !s.apiKey) return
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
        '你是商业情报分析师。根据某公司发给用户的全部邮件（按时间排列），只输出 JSON：{"company":"公司名","summary":"两句话概括双方关系","timeline":[{"period":"2026-01","event":"发生了什么"}],"strategy":"该公司的运营/触达策略剖析：节奏、渠道、转化漏斗设计、生命周期运营等","credibility":{"score":0-100整数,"reasons":"品牌价值可信度评分理由"},"conversionIndex":{"score":0-100整数,"reasons":"用户未来被该品牌转化（购买/付费升级）的概率评分理由"}}。要求：timeline 按月/周聚合 4-8 个节点；两个评分要有说服力且理由引用邮件证据；全部中文。',
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
        '你是邮件优先级助手。用户选中了一批邮件并希望获得「更合理的排序」。只输出 JSON：{"ranked":[{"id":"必须来自列表","reason":"一句话排序理由（≤20字）"}]}。排序依据：截止时间临近 > 需要用户行动/回复 > 未读 > 财务/账单/会议 > 通知类；同类按新鲜度。每封都要出现且只出现一次。',
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

  /** 批量提问：基于选中邮件回答问题，并顺手提炼 todo 清单 */
  async askBulk(
    ids: string[],
    question: string
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
        '你是邮件助手。用户选中了多封邮件并提出问题。只输出 JSON：{"answer":"基于这些邮件内容的中文回答（引用具体邮件，条理清晰，可用换行分点）","todos":[{"title":"从这些邮件中提炼的待办事项","due":"YYYY-MM-DD 或 null"}]}。todos 提炼邮件中明确需要用户行动的事项（还款、回复、参会、下单等），没有则为空数组。',
        `用户的问题：${question}\n\n选中的 ${rows.length} 封邮件：\n${lines}`
      )
      return { ok: true, answer: String(result.answer ?? ''), todos: (result.todos ?? []).slice(0, 12).filter(t => t.title) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), answer: '', todos: [] }
    }
  }
}
