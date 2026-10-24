import { randomUUID } from 'node:crypto'
import type { AISettings, CompanyInsight, DailyDigest } from '@shared/types'
import {
  EXTRACT_MESSAGE, DAILY_DIGEST, COMPANY_PROFILE, COMPANY_PLAYBOOK, RANK_MESSAGES, ASK_BULK,
  SCREEN_SUGGEST, SCREEN_BATCH, COMPOSE_QUERY, SNOOZE_SUGGEST,
  JUDGE_FOLLOWUPS, FOLLOWUP_DRAFT, JSON_RETRY_NUDGE, FEED_SUGGEST_TOPICS
} from './prompts'
import type { MailStore } from '../db'
import { aiReady, type AIService } from './service'

const BILL_RE = /(账单|还款|信用卡|扣款|发票|收据|对账单|invoice|statement|payment due|billing)/i
const MEETING_RE = /(会议|日程|日历邀请|议程|邀请你参加|meeting invitation|calendar invite|zoom|teams meet|腾讯会议|飞书会议)/i

export function jsonFromText(text: string): unknown {
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
      /** 可选：按需下载正文（公司营销拆解需要看到正文里的 CTA / 优惠） */
      downloadBody?(accountId: string, folderPath: string, uid: number): Promise<void>
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

  /** 公司洞察分析进度（渲染层显示「正在下载正文 12/36」之类） */
  private companyProgress(domain: string, text: string) {
    this.deps.event({ type: 'company-progress', domain, text })
  }

  async companyProfile(domain: string): Promise<{ ok: boolean; error?: string; insight?: CompanyInsight }> {
    if (!this.ready()) return { ok: false, error: 'AI 未启用（设置 → AI 配置后可用）' }
    // 允许直接粘贴邮箱地址：取 @ 后面的域名
    const d = domain.trim().toLowerCase().replace(/^.*@/, '').replace(/^\.+/, '')
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return { ok: false, error: '请输入有效域名或邮箱（如 stripe.com）' }
    if (this.runningCompany.has(d)) return { ok: false, error: '正在分析中' }
    this.runningCompany.add(d)
    try {
      // 子域名一起算：marketing.example.com、news.example.com 都归 example.com
      type Row = { id: string; account_id: string; folder_path: string; uid: number; subject: string; snippet: string; text: string; from_name: string; from_addr: string; date: number; body_fetched: number }
      const all = this.deps.store.db
        .prepare(
          `SELECT id, account_id, folder_path, uid, subject, snippet, text, from_name, from_addr, date, body_fetched FROM messages
           WHERE lower(from_addr) LIKE ? OR lower(from_addr) LIKE ? ORDER BY date ASC`
        )
        .all(`%@${d}`, `%.${d}`) as Row[]
      if (all.length < 2) return { ok: false, error: `来自 ${d} 的邮件太少（${all.length} 封），至少需要 2 封才能分析` }
      const pick = (n: number) => (all.length <= n ? all : Array.from({ length: n }, (_, i) => all[Math.round((i * (all.length - 1)) / (n - 1))]))
      const rows = pick(60)
      const sample = [...new Map(pick(36).map(r => [r.id, r])).values()]

      // 营销拆解要看正文（按钮文案、优惠、结构）：缺正文的先下载，单封失败不影响整体
      if (this.deps.downloadBody) {
        const missing = sample.filter(r => !r.body_fetched)
        let n = 0
        const deadline = Date.now() + 60_000
        for (const r of missing) {
          if (Date.now() > deadline) break
          this.companyProgress(d, `正在下载正文 ${++n}/${missing.length}`)
          await Promise.race([this.deps.downloadBody(r.account_id, r.folder_path, r.uid).catch(() => {}), new Promise(res => setTimeout(res, 12_000))])
        }
      }
      const fresh = new Map(
        (this.deps.store.db
          .prepare(`SELECT id, text, snippet FROM messages WHERE id IN (${sample.map(() => '?').join(',')})`)
          .all(...sample.map(r => r.id)) as { id: string; text: string; snippet: string }[]).map(r => [r.id, r])
      )
      const excerpt = (r: Row) => {
        const f = fresh.get(r.id)
        return String(f?.text || f?.snippet || r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 520)
      }
      const lines = rows
        .map(r => `${new Date(r.date).toLocaleDateString('zh-CN')} · ${r.subject} · ${String(r.snippet ?? '').slice(0, 80)}`)
        .join('\n')
      const playbookInput = sample
        .map((r, i) => `[E${i + 1}] ${new Date(r.date).toLocaleDateString('zh-CN')} ｜ ${r.subject}\n${excerpt(r)}`)
        .join('\n\n')
      const company = rows.find(r => r.from_name)?.from_name ?? d

      this.companyProgress(d, 'AI 正在拆解发布节奏、营销活动和转化点…')
      type Profile = {
        company: string
        summary: string
        timeline: { period: string; event: string }[]
        strategy: string
        credibility: { score: number; reasons: string }
        conversionIndex: { score: number; reasons: string }
      }
      type Playbook = {
        cadence?: string
        launches?: { ref: string; date: string; title: string; angle: string }[]
        campaigns?: { refs: string[]; period: string; theme: string; offer: string; tactics: string[] }[]
        conversionPoints?: { ref: string; stage: string; triggers: string[]; cta: string; why: string }[]
        bestPicks?: { ref: string; why: string; learn: string[]; stage: string; triggers: string[] }[]
      }
      const [result, play] = await Promise.all([
        this.json<Profile>(COMPANY_PROFILE, `公司域名：${d}\n共 ${all.length} 封邮件（以下为时间正序抽样 ${rows.length} 封）：\n${lines}`),
        // 拆解失败不拖垮基础报告
        this.json<Playbook>(COMPANY_PLAYBOOK, `公司：${company}（${d}），共 ${all.length} 封邮件，以下按时间均匀抽样 ${sample.length} 封：\n\n${playbookInput}`).catch(() => ({}) as Playbook)
      ])
      const refRow = (ref: unknown) => {
        const m = /^E(\d+)$/i.exec(String(ref ?? '').trim())
        return m ? sample[Number(m[1]) - 1] : undefined
      }
      const strs = (v: unknown, max = 6) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, max) : [])

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
        mailCount: all.length,
        generatedAt: Date.now(),
        cadence: play.cadence ? String(play.cadence) : undefined,
        launches: (play.launches ?? []).flatMap(l => {
          const r = refRow(l.ref)
          return r ? [{ messageId: r.id, subject: r.subject, date: String(l.date ?? ''), title: String(l.title ?? ''), angle: String(l.angle ?? '') }] : []
        }).slice(0, 8),
        campaigns: (play.campaigns ?? []).map(c => ({
          messageIds: strs(c.refs, 8).map(refRow).filter((r): r is Row => !!r).map(r => r.id),
          period: String(c.period ?? ''),
          theme: String(c.theme ?? ''),
          offer: String(c.offer ?? ''),
          tactics: strs(c.tactics)
        })).filter(c => c.theme).slice(0, 6),
        conversionPoints: (play.conversionPoints ?? []).flatMap(c => {
          const r = refRow(c.ref)
          return r ? [{ messageId: r.id, subject: r.subject, date: r.date, stage: String(c.stage ?? ''), triggers: strs(c.triggers), cta: String(c.cta ?? '').slice(0, 40), why: String(c.why ?? '') }] : []
        }).slice(0, 14),
        bestPicks: (play.bestPicks ?? []).flatMap(b => {
          const r = refRow(b.ref)
          return r ? [{ messageId: r.id, subject: r.subject, date: r.date, why: String(b.why ?? ''), learn: strs(b.learn, 5), stage: String(b.stage ?? ''), triggers: strs(b.triggers) }] : []
        }).slice(0, 5)
      }
      this.deps.store.deleteInsight(`company-${d}`)
      this.deps.store.insertInsight({
        id: `company-${d}`,
        kind: 'company',
        title: d,
        data: insight as unknown as Record<string, unknown>,
        period: d
      })
      // 最值得学的邮件 → 阅读清单里的「营销灵感」收藏（幂等；用户移出后不再自动加回）
      for (const b of insight.bestPicks ?? []) {
        this.deps.store.insertInsightIfAbsent({
          id: `swipe-${b.messageId}`.slice(0, 160),
          kind: 'swipe',
          messageId: b.messageId,
          title: b.subject || '（无主题）',
          data: { company: insight.company, domain: d, why: b.why, learn: b.learn, stage: b.stage, triggers: b.triggers, date: b.date }
        })
      }
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

  /** 订阅主题建议：从邮件统计（高频发件人 + 订阅类邮件）学习值得追踪的主题 */
  async feedSuggestTopics(): Promise<{ ok: boolean; error?: string; topics: { query: string; reason: string; cadence: 'daily' | 'weekly' }[] }> {
    const empty = { ok: false, topics: [] as { query: string; reason: string; cadence: 'daily' | 'weekly' }[] }
    if (!this.ready()) return { ...empty, error: 'AI 未启用（设置 → AI 配置后可用）' }
    try {
      const senders = this.deps.store.listNewsletterSenders().slice(0, 15) as { sender: string; count: number }[]
      const recent = this.deps.store.db
        .prepare(
          `SELECT from_name, from_addr, subject FROM messages
           WHERE (is_newsletter = 1 OR category = 'newsletter') ORDER BY date DESC LIMIT 40`
        )
        .all() as { from_name: string; from_addr: string; subject: string }[]
      const keywords = this.deps.store.db
        .prepare(`SELECT subject FROM messages WHERE date >= ? ORDER BY date DESC LIMIT 200`)
        .all(Date.now() - 30 * 86_400_000) as { subject: string }[]
      if (!senders.length && !recent.length) return { ...empty, error: '邮箱里还没有足够的订阅类邮件可以学习' }
      const user = [
        '高频订阅发件人：',
        ...senders.map(s => `- ${s.sender}（累计 ${s.count} 封）`),
        '',
        '最近的订阅类邮件：',
        ...recent.slice(0, 40).map(r => `- ${r.from_name || r.from_addr}：${r.subject}`),
        '',
        '近期主题关键词参考：',
        [...new Set(keywords.map(k => k.subject).filter(Boolean))].slice(0, 40).join(' / ')
      ].join('\n')
      const result = await this.json<{ topics?: { query?: unknown; reason?: unknown; cadence?: unknown }[] }>(FEED_SUGGEST_TOPICS, user)
      const seen = new Set<string>()
      const topics = (result.topics ?? [])
        .map(t => ({
          query: String(t.query ?? '').trim().slice(0, 60),
          reason: String(t.reason ?? '').trim().slice(0, 40),
          cadence: t.cadence === 'weekly' ? ('weekly' as const) : ('daily' as const)
        }))
        .filter(t => t.query && !seen.has(t.query) && seen.add(t.query))
        .slice(0, 4)
      return { ok: true, topics }
    } catch (err) {
      return { ...empty, error: err instanceof Error ? err.message : String(err) }
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
