import { randomUUID } from 'node:crypto'
import type { AgentMemory, AISettings, ContactProfile, MemoryScope } from '@shared/types'
import type { MailStore } from '../db'
import type { AIService } from './service'

const SCOPES: MemoryScope[] = ['fact', 'preference', 'person', 'commitment', 'routine']

const SCOPE_LABEL: Record<MemoryScope, string> = {
  fact: '事实',
  preference: '偏好',
  person: '人物关系',
  commitment: '承诺',
  routine: '惯例'
}

function jsonFromText(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const arrStart = cleaned.indexOf('[')
  const objStart = cleaned.indexOf('{')
  const start = arrStart !== -1 && (arrStart < objStart || objStart === -1) ? arrStart : objStart
  const arrEnd = cleaned.lastIndexOf(']')
  const objEnd = cleaned.lastIndexOf('}')
  const end = Math.max(arrEnd, objEnd)
  if (start === -1 || end === -1) throw new Error('AI 未返回 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

/**
 * LinkTo Agent —— 个人 AI Agent 的记忆与成长层。
 *
 * 与一次性 AI 调用不同，Agent 具备跨会话的长期记忆：
 *  - 学习：从邮件/交互中沉淀事实、偏好、人物关系、承诺、惯例（自动去重，重复出现置信度提升）
 *  - 注入：起草回复、知识库问答、批量提问、每日商情都携带相关记忆，越用越懂你
 *  - 画像：发件人关系档案（高频主题 + 我的回复率 + 关键事实）随时间累积
 *  全部记忆存本地 SQLite，可在 Agent 视图中查看、编辑、归档。
 */
export class AgentService {
  private learning = new Set<string>()
  private profiling = new Set<string>()

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

  private emitChanged() {
    this.deps.event({ type: 'agent-changed' })
  }

  // ---------- 记忆上下文构建（注入所有 AI 能力） ----------

  /**
   * 构建记忆上下文块：按「术语命中 > 置信度 × 使用频次 × 新近度」召回 topK 条。
   * 返回 null 表示没有可用记忆。
   */
  buildMemoryContext(query = '', limit = 10): { text: string; usedIds: string[] } | null {
    const memories = this.deps.store.listMemories('all').filter(m => m.status === 'active')
    if (!memories.length) return null
    const terms = query
      .toLowerCase()
      .split(/[\s,，。？?！!、:：;；]+/)
      .filter(t => t.length > 1)
    const now = Date.now()
    const scored = memories.map(m => {
      let score = m.confidence * 0.5 + Math.min(1, m.useCount / 10) * 0.3 + Math.max(0, 1 - (now - m.updatedAt) / (30 * 864e5)) * 0.2
      const hay = `${m.title} ${m.content} ${m.entity}`.toLowerCase()
      for (const t of terms) if (hay.includes(t)) score += 1
      if (m.entity && query.toLowerCase().includes(m.entity.toLowerCase())) score += 1.5
      return { m, score }
    })
    const top = scored
      .filter(s => s.score > 0.25 || s.m.confidence >= 0.9)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
    if (!top.length) return null
    const text = top
      .map((s, i) => `[M${i + 1}]（${SCOPE_LABEL[s.m.scope]}）${s.m.title}：${s.m.content}`)
      .join('\n')
    return { text, usedIds: top.map(s => s.m.id) }
  }

  /** 生成带记忆注入指令的 system 提示片段（供各 AI 能力注入） */
  memoryPrompt(query = '', limit = 10): { block: string; usedIds: string[] } {
    const ctx = this.buildMemoryContext(query, limit)
    if (!ctx) return { block: '', usedIds: [] }
    this.deps.store.touchMemories(ctx.usedIds)
    return {
      block: `\n\n【你对用户的长期记忆（日积月累，优先遵循）】\n${ctx.text}\n以上记忆来自用户过往邮件与交互，回答时主动利用，但不要逐条罗列。`,
      usedIds: ctx.usedIds
    }
  }

  /** 只取记忆注入文本（不关心引用编号时使用） */
  memoryBlock(query = '', limit = 10): string {
    return this.memoryPrompt(query, limit).block
  }

  // ---------- 学习：从邮件沉淀记忆 ----------

  /** 让 Agent 学习一封邮件：提取发件人事实、我的偏好、承诺、惯例 */
  async learnFromMessage(messageId: string): Promise<{ ok: boolean; error?: string; learned: AgentMemory[] }> {
    if (!this.ready()) return { ok: false, error: 'AI 未启用（设置 → AI 配置后可用）', learned: [] }
    if (this.learning.has(messageId)) return { ok: false, error: '这封邮件正在学习中', learned: [] }
    const row = this.deps.store.getMessageRow(messageId)
    if (!row) return { ok: false, error: '邮件不存在', learned: [] }
    this.learning.add(messageId)
    try {
      const text = String(row.text || row.snippet || '').slice(0, 6000)
      const result = await this.deps.ai.complete([
        {
          role: 'system',
          content:
            '你是个人邮件 Agent 的记忆提取器。从这封邮件中提炼值得长期记住的信息，只输出 JSON：{"memories":[{"scope":"fact|preference|person|commitment|routine","title":"≤18字标题","content":"一句话记忆内容","entity":"关联实体（发件人邮箱或域名，无则空串）"}]}。' +
            '判别标准：fact=用户/发件人的客观事实（职位、公司、产品、账号）；preference=用户表现出的偏好（沟通方式、时间、格式、喜欢/讨厌什么）；person=与该发件人的关系变化（新结识、合作进展、信任程度）；commitment=邮件中的明确承诺（谁答应在什么时候做什么，标题注明是「我承诺」还是「对方承诺」）；routine=周期性惯例（每周例会、月度账单等）。' +
            '只提取有长期价值的信息，宁缺毋滥（0-4 条），不要提取验证码/一次性通知。全部中文。'
        },
        {
          role: 'user',
          content: `发件人：${row.from_name ?? ''} <${row.from_addr ?? ''}>\n收件时间：${new Date(row.date).toLocaleString('zh-CN')}\n主题：${row.subject}\n\n正文：\n${text}`
        }
      ])
      const parsed = jsonFromText(result) as { memories?: { scope?: string; title?: string; content?: string; entity?: string }[] }
      const learned: AgentMemory[] = []
      for (const m of parsed.memories ?? []) {
        const scope = (SCOPES as string[]).includes(m.scope ?? '') ? (m.scope as MemoryScope) : 'fact'
        if (!m.title || !m.content) continue
        const entity = String(m.entity || row.from_addr || '').toLowerCase().trim()
        learned.push(
          this.deps.store.upsertMemory({
            scope,
            entity,
            title: String(m.title).slice(0, 60),
            content: String(m.content).slice(0, 500),
            source: 'auto',
            sourceMessageId: messageId,
            confidence: 0.8
          })
        )
      }
      if (learned.length) this.emitChanged()
      return { ok: true, learned }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), learned: [] }
    } finally {
      this.learning.delete(messageId)
    }
  }

  /** 从一批邮件批量学习（每日商情后自动调用，控制条数控制成本） */
  async learnFromMessages(messageIds: string[], max = 10): Promise<AgentMemory[]> {
    const learned: AgentMemory[] = []
    for (const id of messageIds.slice(0, max)) {
      const r = await this.learnFromMessage(id).catch(() => null)
      if (r?.learned?.length) learned.push(...r.learned)
    }
    return learned
  }

  // ---------- 发件人画像 ----------

  /** 发件人画像：邮件聚合 + 既有记忆 → 关系总结（结果沉淀为 person 记忆） */
  async profile(addr: string): Promise<{ ok: boolean; error?: string; profile?: ContactProfile }> {
    if (!this.ready()) return { ok: false, error: 'AI 未启用（设置 → AI 配置后可用）' }
    const a = addr.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(a)) {
      return { ok: false, error: '请输入有效邮箱或域名' }
    }
    if (this.profiling.has(a)) return { ok: false, error: '正在生成画像中' }
    this.profiling.add(a)
    try {
      const like = a.includes('@') ? a : `@${a}`
      const rows = this.deps.store.db
        .prepare(
          `SELECT id, subject, snippet, from_name, from_addr, date, flags FROM messages
           WHERE lower(from_addr) LIKE ? OR lower(to_json) LIKE ? ORDER BY date DESC LIMIT 80`
        )
        .all(like, `%${like}%`) as {
        id: string
        subject: string
        snippet: string
        from_name: string
        from_addr: string
        date: number
        flags: string
      }[]
      if (!rows.length) return { ok: false, error: `没有找到与 ${a} 相关的邮件` }
      const name = rows.find(r => r.from_name)?.from_name ?? a
      const myReplies = this.deps.store.db
        .prepare(
          `SELECT COUNT(*) c FROM messages WHERE lower(to_json) LIKE ? AND flags LIKE '%\\Sent%'`
        )
        .get(`%${like}%`) as { c: number }
      // 从我发出、发往该地址的邮件数（outbox 落库时 to_json 含地址）
      const sentRows = this.deps.store.db
        .prepare(`SELECT COUNT(DISTINCT norm_subject) c FROM messages WHERE lower(to_json) LIKE ? AND (flags LIKE '%Sent%' OR folder_path IN ('Sent','已发送','Sent Messages'))`)
        .get(`%${like}%`) as { c: number }
      const replyRate = rows.length ? Math.min(100, Math.round(((sentRows.c || myReplies.c) / rows.length) * 100)) : 0
      const lines = rows
        .slice(0, 40)
        .map(r => `${new Date(r.date).toLocaleDateString('zh-CN')} · ${r.subject} · ${r.snippet.slice(0, 60)}`)
        .join('\n')
      const memories = this.deps.store
        .listMemories('all')
        .filter(m => m.status === 'active' && (m.entity === like || m.entity.endsWith(`@${like}`) || m.entity.includes(a)))
        .map(m => `${SCOPE_LABEL[m.scope]}：${m.title}（${m.content}）`)
      const result = await this.deps.ai.complete([
        {
          role: 'system',
          content:
            '你是个人邮件 Agent 的关系分析师。基于用户与某发件人的全部往来邮件与长期记忆，只输出 JSON：{"summary":"两句话概括双方关系与当前状态","topTopics":["高频主题词"],"keyFacts":["值得记住的关键事实，最多5条"]}。全部中文。'
        },
        {
          role: 'user',
          content: `发件方：${name} <${like}>\n往来邮件 ${rows.length} 封（时间倒序）：\n${lines}\n\n${memories.length ? `已有记忆：\n${memories.join('\n')}` : ''}`
        }
      ])
      const parsed = jsonFromText(result) as { summary?: string; topTopics?: string[]; keyFacts?: string[] }
      const profile: ContactProfile = {
        addr: like,
        displayName: name,
        mailCount: rows.length,
        firstContact: rows[rows.length - 1]?.date ?? 0,
        lastContact: rows[0]?.date ?? 0,
        myReplyRate: replyRate,
        topTopics: (parsed.topTopics ?? []).slice(0, 6).map(String),
        summary: String(parsed.summary ?? ''),
        keyFacts: (parsed.keyFacts ?? []).slice(0, 5).map(String),
        generatedAt: Date.now()
      }
      // 关键事实沉淀为 person 记忆（按 title 去重，重复生成会提升置信度）
      for (const f of profile.keyFacts) {
        if (!f) continue
        this.deps.store.upsertMemory({
          scope: 'person',
          entity: like,
          title: f.slice(0, 60),
          content: f.slice(0, 500),
          source: 'auto',
          confidence: 0.7
        })
      }
      this.emitChanged()
      return { ok: true, profile }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.profiling.delete(a)
    }
  }

  // ---------- Agent 对话 ----------

  /** Agent 对话：长期记忆 + 知识库 + 近期邮件全文检索 共同支撑 */
  async chat(question: string): Promise<{ system: string; user: string; usedIds: string[] }> {
    const mem = this.memoryPrompt(question, 12)
    // 知识库检索（轻量打分）
    const kbItems = this.deps.store.listKbItems()
    const q = question.toLowerCase()
    const terms = q.split(/\s+/).filter(t => t.length > 1)
    const kb = kbItems
      .map(i => {
        const hay = `${i.title} ${i.content} ${i.tags.join(' ')}`.toLowerCase()
        return { i, score: terms.filter(t => hay.includes(t)).length }
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
    // 近期邮件检索（FTS 全文）
    let mailCtx = ''
    try {
      const page = this.deps.store.getMessages({ scope: 'search', search: question, limit: 8, offset: 0 })
      const hits = page.items ?? []
      if (hits.length) {
        mailCtx = `\n\n【相关近期邮件（来自全文检索）】\n${hits
          .map(
            (h, i) =>
              `[E${i + 1}] ${h.subject}（${h.from?.name || h.from?.address || ''}，${new Date(h.date).toLocaleDateString('zh-CN')}）：${h.snippet.slice(0, 120)}`
          )
          .join('\n')}`
      }
    } catch { /* 检索失败不影响回答 */ }
    const kbCtx = kb.length
      ? `\n\n【知识库相关条目】\n${kb.map((s, i) => `[K${i + 1}] ${s.i.title}：${s.i.content.slice(0, 800)}`).join('\n———\n')}`
      : ''
    const system =
      `你是 LinkTo——用户的个人邮件 Agent。你不是一次性助手：你拥有与用户日积月累的长期记忆，了解用户的人和事、偏好与惯例，也持续学习新的信息。` +
      `回答规则：优先基于【长期记忆】【知识库】【相关近期邮件】作答并标注来源（如 [M1] [K2] [E3]）；记忆与用户当前问题冲突时以用户本次表述为准；` +
      `不确定就明说，不编造；回答用简体中文，条理清晰、直接有用。如果用户在对话中透露了新的长期有价值信息，在回答末尾用「📌 记住：…」列出一到三条你认为值得沉淀的记忆（没有则不加）。` +
      (mem.block ? `\n${mem.block}` : '')
    const user = `${question}${kbCtx}${mailCtx}`
    return { system, user, usedIds: mem.usedIds }
  }
}