import type {
  AISettings,
  DailyDigest,
  MailBundle,
  MailEntity,
  MailInsight,
  MailNextAction,
  MailSection,
  TodayBrief
} from '@shared/types'
import type { MailStore } from '../db'
import type { AccountWorker } from '../mail/sync-engine'
import { aiReady, type AIService } from './service'
import { MAIL_UNDERSTAND, JSON_RETRY_NUDGE } from './prompts'
import {
  heuristicInsight,
  displayName,
  entityTime,
  type HeuristicInput
} from '../mail/understand-heuristic'

const DAY = 864e5
const WEEK_CN = '日一二三四五六'

/* eslint-disable @typescript-eslint/no-explicit-any */

function jsonFromText(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('AI 未返回 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

function todayPeriod(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function str(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const t = v.replace(/\s+/g, ' ').trim()
  return [...t].length > max ? [...t].slice(0, max).join('') : t
}

/** 多行文本（回复草稿）：保留换行，只裁剪长度 */
function multiline(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const t = v.replace(/\r/g, '').trim()
  return t.length > max ? t.slice(0, max) : t
}

function clipGist(s: string): string {
  return [...s].length > 60 ? [...s].slice(0, 59).join('') + '…' : s
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

const SECTIONS: MailSection[] = ['act', 'wait', 'fyi', 'bundle']
const BUNDLES: MailBundle[] = ['newsletter', 'notification', 'screener']
const ENTITY_KINDS: MailEntity['kind'][] = ['time', 'deadline', 'money', 'code', 'link', 'tracking']
const ENTITY_ACTIONS = ['calendar', 'todo', 'copy', 'open'] as const
const NEXT_KINDS: MailNextAction['kind'][] = ['reply', 'todo', 'snooze', 'archive', 'open', 'forward']
const DEFAULT_ACTION: Record<MailEntity['kind'], MailEntity['action']> = {
  time: 'calendar',
  deadline: 'todo',
  money: 'todo',
  code: 'copy',
  link: 'open',
  tracking: 'copy'
}

/**
 * 严格校验并清洗 AI 输出：未知类型丢弃、荧光句必须逐字出现在正文、
 * gistKey 必须是 gist 子串、验证码/链接必须真实出现在邮件里、长度封顶。
 * 字段缺失或非法时回落到启发式结果。
 */
export function sanitizeAiInsight(
  raw: unknown,
  h: MailInsight,
  mail: { subject: string; text: string; html: string | null },
  now = Date.now()
): MailInsight {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const hay = `${mail.subject}\n${mail.text}\n${mail.html ?? ''}`

  // 分区 / 归堆：Screener 待审是事实而非判断，始终以本地状态为准
  let section: MailSection = SECTIONS.includes(r.section) ? r.section : h.section
  let bundle: MailBundle | null = BUNDLES.includes(r.bundle) ? r.bundle : null
  if (h.bundle === 'screener') {
    section = 'bundle'
    bundle = 'screener'
  } else if (section === 'bundle') {
    if (!bundle || bundle === 'screener') bundle = h.bundle ?? 'notification'
  } else {
    bundle = null
  }

  let gist = str(r.gist, 120)
  gist = gist ? clipGist(gist) : h.gist
  const keyRaw = str(r.gistKey, 30)
  const gistKey = keyRaw && keyRaw !== 'null' && gist.includes(keyRaw) ? keyRaw : null

  const u = Number(r.urgency)
  const urgency = Number.isFinite(u) ? Math.max(0, Math.min(100, Math.round(u))) : h.urgency

  const entities: MailEntity[] = []
  for (const e of Array.isArray(r.entities) ? r.entities : []) {
    if (!e || typeof e !== 'object' || !ENTITY_KINDS.includes(e.kind)) continue
    const kind = e.kind as MailEntity['kind']
    const label = str(e.label, 24)
    let value = str(e.value, 600)
    if (!label || !value) continue
    if (kind === 'time' || kind === 'deadline') {
      if (entityTime(value) == null) continue
    } else if (kind === 'money') {
      value = value.replace(/[,，\s]/g, '').replace(/^[^\d]+/, '')
      if (!/^\d+(\.\d+)?$/.test(value)) continue
    } else if (kind === 'code') {
      if (!/^[A-Za-z0-9-]{3,12}$/.test(value) || !hay.includes(value)) continue
    } else if (kind === 'link') {
      if (!/^https?:\/\//i.test(value) || !(hay.includes(value) || hay.includes(value.replace(/&/g, '&amp;')))) continue
    } else if (kind === 'tracking') {
      if (!hay.toUpperCase().includes(value.toUpperCase())) continue
    }
    const action = e.action === null || e.action === 'null'
      ? null
      : (ENTITY_ACTIONS as readonly string[]).includes(e.action) ? (e.action as MailEntity['action']) : DEFAULT_ACTION[kind]
    if (entities.some(x => x.kind === kind && x.value === value)) continue
    entities.push({ kind, label, value, action })
    if (entities.length >= 6) break
  }
  // 正则抽取的验证码 / 登录链接 / 运单号是确定性的：AI 漏掉时补回
  for (const e of h.entities) {
    if ((e.kind === 'code' || e.kind === 'link' || e.kind === 'tracking') && !entities.some(x => x.kind === e.kind && x.value === e.value)) {
      entities.push(e)
    }
  }

  const highlights: string[] = []
  for (const s of Array.isArray(r.highlights) ? r.highlights : []) {
    if (typeof s !== 'string') continue
    const t = s.trim()
    if (!t || [...t].length > 80 || !mail.text.includes(t) || highlights.includes(t)) continue
    highlights.push(t)
    if (highlights.length >= 4) break
  }

  const next: MailNextAction[] = []
  for (const n of Array.isArray(r.next) ? r.next : []) {
    if (!n || typeof n !== 'object' || !NEXT_KINDS.includes(n.kind)) continue
    const kind = n.kind as MailNextAction['kind']
    const label = str(n.label, 30)
    if (!label) continue
    const a: MailNextAction = { kind, label }
    if (kind === 'reply' || kind === 'forward') {
      const body = multiline(n.body, 2000)
      if (kind === 'reply' && !body) continue
      if (body) a.body = body
    } else if (kind === 'todo') {
      const title = str(n.title, 80) || label.replace(/^建待办[:：]\s*/, '')
      if (!title) continue
      a.title = title
      const due = str(n.due, 16)
      a.due = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(due) && Number.isFinite(Date.parse(due.slice(0, 10))) ? due : null
    } else if (kind === 'snooze') {
      const until = str(n.until, 16)
      const t = Date.parse(until.replace(' ', 'T'))
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(until) || !Number.isFinite(t) || t <= now) continue
      a.until = until
    } else if (kind === 'open') {
      const url = str(n.url, 600)
      if (!/^https?:\/\//i.test(url) || !(hay.includes(url) || hay.includes(url.replace(/&/g, '&amp;')))) continue
      a.url = url
    }
    next.push(a)
    if (next.length >= 4) break
  }

  return {
    messageId: h.messageId,
    section,
    bundle,
    gist,
    gistKey,
    urgency,
    entities,
    highlights,
    next: next.length ? next : h.next,
    quickReply: multiline(r.quickReply, 1000),
    source: 'ai',
    updatedAt: now
  }
}

interface RowCtx {
  myAddrs: Set<string>
  screening: Map<string, 'pending' | 'allow' | 'deny'>
  awaiting: Map<string, { since: number; toName: string }>
}

/**
 * 邮件理解服务：每封邮件一次「理解」（启发式即时 + AI 异步），结果缓存在 mail_ai 表，
 * 供列表分区、阅读页要点卡、今日简报、Agent 复用。
 *  - 启发式：零成本、无 AI 也可用，缺失时即时补齐（不落库，随已读/回复状态实时变化）
 *  - AI：新邮件到达 / 启动时后台排队（并发 1），用户打开邮件时立即跑
 */
export class UnderstandService {
  private queue: string[] = []
  private queued = new Set<string>()
  private failed = new Set<string>()
  private pumping = false
  private inflight = new Map<string, Promise<MailInsight | null>>()

  constructor(
    private deps: {
      ai: AIService
      store: MailStore
      getAISettings(): AISettings
      event(payload: unknown): void
      /** 可选：Agent 长期记忆注入 */
      getMemoryContext?(query: string): string | null
      getWorker(accountId: string): AccountWorker | undefined
      /** 可选：理解结果产出后回调（自动收集待办等） */
      onInsight?(insight: MailInsight): void
    }
  ) {}

  // ---------- 启发式输入构建 ----------

  private myAddrs(): Set<string> {
    const set = new Set<string>()
    for (const a of this.deps.store.listAccounts()) {
      if (a.email) set.add(a.email.toLowerCase())
      if (a.user?.includes('@')) set.add(a.user.toLowerCase())
    }
    return set
  }

  private loadRows(ids: string[]): any[] {
    const rows: any[] = []
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400)
      if (!part.length) continue
      rows.push(
        ...(this.deps.store.db
          .prepare(
            `SELECT m.id, m.account_id, m.folder_id, m.folder_path, m.uid, m.thread_id, m.from_name, m.from_addr, m.to_json,
                    m.subject, m.snippet, substr(coalesce(m.text,''), 1, 8000) AS text,
                    CASE WHEN instr(coalesce(m.text,''), 'http') = 0 THEN substr(m.html, 1, 60000) END AS html,
                    m.date, m.flags, m.category, m.is_newsletter, m.pinned, m.body_fetched, f.special AS folder_special
             FROM messages m LEFT JOIN folders f ON f.id = m.folder_id
             WHERE m.id IN (${part.map(() => '?').join(',')})`
          )
          .all(...part) as any[])
      )
    }
    return rows
  }

  private buildCtx(rows: any[], now: number): RowCtx {
    const myAddrs = this.myAddrs()
    const screening = new Map<string, 'pending' | 'allow' | 'deny'>()
    const addrs = [...new Set(rows.map(r => String(r.from_addr ?? '').toLowerCase()).filter(Boolean))]
    for (let i = 0; i < addrs.length; i += 400) {
      const part = addrs.slice(i, i + 400)
      const res = this.deps.store.db
        .prepare(`SELECT addr, status FROM sender_screening WHERE addr IN (${part.map(() => '?').join(',')})`)
        .all(...part) as { addr: string; status: 'pending' | 'allow' | 'deny' }[]
      for (const s of res) screening.set(s.addr, s.status)
    }
    // 等回复：线程最新一封是我发的、超过 2 天、不超过 30 天（更早的视为已搁置）
    const awaiting = new Map<string, { since: number; toName: string }>()
    const threads = [...new Set(rows.map(r => r.thread_id).filter(Boolean))] as string[]
    for (let i = 0; i < threads.length; i += 400) {
      const part = threads.slice(i, i + 400)
      const latest = this.deps.store.db
        .prepare(
          `SELECT m.thread_id, m.from_addr, m.to_json, m.date FROM messages m
           WHERE m.thread_id IN (${part.map(() => '?').join(',')})
             AND m.date = (SELECT MAX(r.date) FROM messages r WHERE r.thread_id = m.thread_id)`
        )
        .all(...part) as { thread_id: string; from_addr: string | null; to_json: string | null; date: number }[]
      for (const l of latest) {
        if (!myAddrs.has(String(l.from_addr ?? '').toLowerCase())) continue
        if (now - l.date < 2 * DAY || now - l.date > 30 * DAY) continue
        let toName = ''
        try {
          const to = (JSON.parse(l.to_json || '[]') as { name?: string; address: string }[])[0]
          if (to) toName = displayName(to.name ?? '', to.address)
        } catch { /* ignore */ }
        awaiting.set(l.thread_id, { since: l.date, toName })
      }
    }
    return { myAddrs, screening, awaiting }
  }

  private inputOf(row: any, ctx: RowCtx, now: number): HeuristicInput {
    const flags = String(row.flags ?? '')
    const from = String(row.from_addr ?? '').toLowerCase()
    return {
      messageId: row.id,
      subject: row.subject ?? '',
      text: row.text ?? '',
      snippet: row.snippet ?? '',
      html: row.html ?? null,
      fromAddr: row.from_addr ?? '',
      fromName: row.from_name ?? '',
      date: row.date ?? 0,
      category: row.category ?? 'personal',
      isNewsletter: !!row.is_newsletter,
      unread: !flags.includes('\\Seen'),
      flagged: flags.includes('\\Flagged'),
      pinned: !!row.pinned,
      answered: flags.includes('\\Answered'),
      screening: ctx.screening.get(from) ?? null,
      fromMe: ctx.myAddrs.has(from),
      awaitingReply: ctx.awaiting.get(row.thread_id) ?? null,
      now
    }
  }

  /** AI 结果 + 实时状态校正：已回复/过期不再「需要你处理」，等回复与 Screener 以实时状态为准 */
  private liveAdjust(ai: MailInsight, h: MailInsight, input: HeuristicInput): MailInsight {
    const out = { ...ai }
    if (h.bundle === 'screener') {
      out.section = 'bundle'
      out.bundle = 'screener'
    } else if (h.section === 'wait') {
      out.section = 'wait'
      out.bundle = null
    } else if (out.section === 'act' && !input.flagged && !input.pinned) {
      const stale = (input.now ?? Date.now()) - input.date > 14 * DAY
      if (input.answered || stale) out.section = 'fyi'
    } else if (out.section === 'wait') {
      // 对方已回信：不再等待
      out.section = h.section === 'bundle' ? 'fyi' : h.section
    }
    return out
  }

  /** 内部批量计算（不入队）：返回 insight 以及每封的启发式结果与原始行 */
  private compute(ids: string[]): { insights: Record<string, MailInsight>; heuristics: Map<string, MailInsight>; rows: Map<string, any>; ai: Record<string, MailInsight> } {
    const now = Date.now()
    const uniq = [...new Set(ids.filter(id => typeof id === 'string' && id))]
    const rows = this.loadRows(uniq)
    const ctx = this.buildCtx(rows, now)
    const ai = this.deps.store.getMailAi(uniq)
    const insights: Record<string, MailInsight> = {}
    const heuristics = new Map<string, MailInsight>()
    const rowMap = new Map<string, any>()
    for (const row of rows) {
      const input = this.inputOf(row, ctx, now)
      const h = heuristicInsight(input)
      heuristics.set(row.id, h)
      rowMap.set(row.id, row)
      const cached = ai[row.id]
      insights[row.id] = cached && cached.source === 'ai' ? this.liveAdjust(cached, h, input) : h
    }
    return { insights, heuristics, rows: rowMap, ai }
  }

  // ---------- 对外：批量取 / 单封理解 ----------

  /** 批量取邮件理解结果；缺 AI 结果且符合条件的邮件进入后台 AI 队列 */
  getInsights(ids: string[]): Record<string, MailInsight> {
    const list = Array.isArray(ids) ? ids.slice(0, 1000) : []
    const { insights, heuristics, rows, ai } = this.compute(list)
    if (this.backgroundReady()) {
      for (const [id, h] of heuristics) {
        if (ai[id]?.source === 'ai') continue
        if (this.worthAi(rows.get(id), h)) this.enqueue(id)
      }
    }
    // 自动收集待办（幂等）：已有邮件里的截止事项也能进待办，不必等新邮件到达
    if (this.deps.onInsight) for (const ins of Object.values(insights)) if (ins.section === 'act') this.deps.onInsight(ins)
    return insights
  }

  /** 立即对一封邮件跑 AI 理解（用户打开邮件时调用）；AI 未就绪或失败则返回启发式结果 */
  async understand(id: string, force = false): Promise<MailInsight | null> {
    const current = this.compute([id]).insights[id]
    if (!current) return null
    if (current.source === 'ai' && !force) return current
    // 用户主动打开：不受 autoUnderstand 开关限制，只要 AI 可用
    if (!aiReady(this.deps.getAISettings())) return current
    const running = this.inflight.get(id)
    if (running) return (await running) ?? current
    const p = this.runAi(id).finally(() => this.inflight.delete(id))
    this.inflight.set(id, p)
    try {
      const res = await p
      return res ? this.compute([id]).insights[id] ?? res : current
    } catch (err) {
      console.error('[understand]', err)
      return current
    }
  }

  // ---------- AI 理解 ----------

  private async json(system: string, user: string): Promise<unknown> {
    const ask = (extra: string) =>
      this.deps.ai.complete(
        [
          { role: 'system', content: system + (extra ? `\n\n${extra}` : '') },
          { role: 'user', content: user }
        ],
        2000
      )
    try {
      return jsonFromText(await ask(''))
    } catch {
      return jsonFromText(await ask(JSON_RETRY_NUDGE))
    }
  }

  private async ensureBody(row: any): Promise<any> {
    if (row.body_fetched) return row
    const worker = this.deps.getWorker(row.account_id)
    if (!worker) return row
    const local = await worker.hydrateFromLocalEml(row.folder_path, row.uid).catch(() => false)
    if (!local) await worker.downloadBody(row.folder_path, row.uid).catch(() => {})
    return this.loadRows([row.id])[0] ?? row
  }

  private async runAi(id: string): Promise<MailInsight | null> {
    let row = this.loadRows([id])[0]
    if (!row) return null
    row = await this.ensureBody(row)
    const now = Date.now()
    const ctx = this.buildCtx([row], now)
    const h = heuristicInsight(this.inputOf(row, ctx, now))
    const full = this.deps.store.getMessageRow(id)
    const text = String(full?.text || row.snippet || '')
    const html: string | null = full?.html ? String(full.html).slice(0, 200_000) : null
    const d = new Date(now)
    const accounts = [...ctx.myAddrs].join('、') || '（未知）'
    let to = ''
    try {
      to = (JSON.parse(row.to_json || '[]') as { name?: string; address: string }[])
        .slice(0, 5)
        .map(a => (a.name ? `${a.name} <${a.address}>` : a.address))
        .join('，')
    } catch { /* ignore */ }
    const hint = {
      section: h.section,
      bundle: h.bundle,
      gist: h.gist,
      urgency: h.urgency,
      entities: h.entities.map(e => ({ kind: e.kind, label: e.label, value: e.value }))
    }
    const user =
      `用户的邮箱：${accounts}\n` +
      `今天：${d.toLocaleDateString('zh-CN')} 星期${WEEK_CN[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}\n` +
      `发件人：${row.from_name ?? ''} <${row.from_addr ?? ''}>\n` +
      (to ? `收件人：${to}\n` : '') +
      `主题：${row.subject ?? ''}\n` +
      `邮件日期：${new Date(row.date ?? now).toLocaleString('zh-CN')}\n` +
      `启发式结果（仅供参考）：${JSON.stringify(hint)}\n\n` +
      `正文：\n${text.slice(0, 4000)}`
    const memory = this.deps.getMemoryContext?.(`${row.from_name ?? ''} ${row.from_addr ?? ''} ${row.subject ?? ''}`) ?? ''
    const raw = await this.json(MAIL_UNDERSTAND + (memory ? `\n理解时结合你对用户的长期记忆（人物关系、承诺、偏好）判断轻重缓急。${memory}` : ''), user)
    const insight = sanitizeAiInsight(raw, h, { subject: row.subject ?? '', text, html }, Date.now())
    // 邮件可能在 AI 运行期间被删除：不再写入孤儿记录
    if (!this.deps.store.getMessageRow(id)) return null
    this.deps.store.saveMailAi(insight)
    this.deps.event({ type: 'mail-insights', ids: [id] })
    this.deps.onInsight?.(insight)
    return insight
  }

  // ---------- 后台队列 ----------

  /** 后台理解开关：autoUnderstand + AI 可用（内置端侧小模型不承担逐封后台任务） */
  private backgroundReady(): boolean {
    const s = this.deps.getAISettings()
    return !!s.autoUnderstand && aiReady(s, false)
  }

  /** 是否值得后台花一次 AI：收件箱、14 天内；订阅/通知类仅在有紧急信号时 */
  private worthAi(row: any, h: MailInsight): boolean {
    if (!row) return false
    const inbox = row.folder_special === 'inbox' || String(row.folder_path).toUpperCase() === 'INBOX'
    if (!inbox) return false
    if (Date.now() - (row.date ?? 0) > 14 * DAY) return false
    if (h.bundle === 'screener') return false
    if (h.bundle === 'newsletter' || h.bundle === 'notification') {
      return h.urgency >= 50 || h.entities.some(e => e.kind === 'deadline')
    }
    return true
  }

  private enqueue(id: string) {
    if (this.queued.has(id) || this.failed.has(id) || this.inflight.has(id)) return
    if (this.queue.length >= 200) return
    this.queued.add(id)
    this.queue.push(id)
    void this.pump()
  }

  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length) {
        if (!this.backgroundReady()) {
          // 用户关闭了自动理解 / AI：清空队列，下次需要时重新排
          this.queue = []
          this.queued.clear()
          break
        }
        const id = this.queue.shift()!
        this.queued.delete(id)
        const existing = this.deps.store.getMailAi([id])[id]
        if (existing?.source === 'ai' || this.inflight.has(id)) continue
        const p = this.runAi(id).finally(() => this.inflight.delete(id))
        this.inflight.set(id, p)
        try {
          await p
        } catch (err) {
          this.failed.add(id)
          console.error('[understand] background failed:', err instanceof Error ? err.message : err)
        }
        await new Promise(r => setTimeout(r, 400))
      }
    } finally {
      this.pumping = false
    }
  }

  /** 新邮件到达（收件箱增量）：符合条件即排队 */
  onArrival(messageId: string) {
    // 启发式结果立即可用：没有 AI 也能自动收集待办
    if (this.deps.onInsight) {
      const now = this.compute([messageId]).heuristics.get(messageId)
      if (now) this.deps.onInsight(now)
    }
    if (!this.backgroundReady()) return
    const { heuristics, rows, ai } = this.compute([messageId])
    const h = heuristics.get(messageId)
    if (!h || ai[messageId]?.source === 'ai') return
    if (this.worthAi(rows.get(messageId), h)) this.enqueue(messageId)
  }

  /** 启动时：最新 30 封未读收件箱邮件中缺 AI 结果的补跑 */
  startupScan() {
    if (!this.backgroundReady()) return
    const rows = this.deps.store.db
      .prepare(
        `SELECT m.id FROM messages m
         WHERE m.folder_path = 'INBOX' AND m.flags NOT LIKE '%\\Seen%' AND m.date >= ?
           AND NOT EXISTS (SELECT 1 FROM mail_ai a WHERE a.message_id = m.id AND a.source = 'ai')
         ORDER BY m.date DESC LIMIT 30`
      )
      .all(Date.now() - 14 * DAY) as { id: string }[]
    if (rows.length) this.getInsights(rows.map(r => r.id))
  }

  // ---------- 今日简报（不调用模型） ----------

  todayBrief(accountId?: string | null): TodayBrief {
    const now = Date.now()
    const since = now - 14 * DAY
    const acc = accountId ? ' AND m.account_id = ?' : ''
    const args: (string | number)[] = accountId ? [since, now, accountId] : [since, now]
    const ids = (
      this.deps.store.db
        .prepare(
          `SELECT m.id FROM messages m
           WHERE m.folder_path = 'INBOX' AND m.date >= ? AND (m.snoozed_until IS NULL OR m.snoozed_until <= ?)${acc}
           ORDER BY m.date DESC LIMIT 400`
        )
        .all(...args) as { id: string }[]
    ).map(r => r.id)
    const { insights, rows } = this.compute(ids)
    const list = Object.values(insights)
    const act = list.filter(i => i.section === 'act').sort((a, b) => b.urgency - a.urgency)

    // 等回复：收件箱中处于等待的线程 + 我发出后无人回复的已发送邮件（2-14 天）
    const myAddrs = this.myAddrs()
    const waits = new Map<string, { name: string; since: number }>()
    for (const i of list) {
      if (i.section !== 'wait') continue
      const row = rows.get(i.messageId)
      if (!row) continue
      waits.set(row.thread_id, { name: displayName(row.from_name ?? '', row.from_addr ?? ''), since: row.date })
    }
    const sent = this.deps.store.db
      .prepare(
        `SELECT m.thread_id, m.to_json, m.date FROM messages m JOIN folders f ON f.id = m.folder_id
         WHERE f.special = 'sent' AND m.date >= ? AND m.date <= ?${acc}
           AND NOT EXISTS (
             SELECT 1 FROM messages r WHERE r.thread_id = m.thread_id AND r.date > m.date
               AND lower(COALESCE(r.from_addr,'')) NOT IN (SELECT lower(email) FROM accounts)
               AND lower(COALESCE(r.from_addr,'')) NOT IN (SELECT lower(user) FROM accounts WHERE user LIKE '%@%')
           )
         ORDER BY m.date DESC LIMIT 100`
      )
      .all(...(accountId ? [since, now - 2 * DAY, accountId] : [since, now - 2 * DAY])) as { thread_id: string; to_json: string | null; date: number }[]
    for (const s of sent) {
      const cur = waits.get(s.thread_id)
      let name = ''
      try {
        const to = (JSON.parse(s.to_json || '[]') as { name?: string; address: string }[])[0]
        if (to) {
          if (myAddrs.has(to.address.toLowerCase())) continue
          name = displayName(to.name ?? '', to.address)
        }
      } catch { /* ignore */ }
      if (!cur || s.date > cur.since) waits.set(s.thread_id, { name: name || cur?.name || '', since: s.date })
    }

    // 今天到期：截止实体在今天 + 今天到期的未完成待办
    const dueIds = new Set<string>()
    const deadlines: { i: MailInsight; t: number; label: string }[] = []
    for (const i of list) {
      for (const e of i.entities) {
        if (e.kind !== 'deadline') continue
        const t = entityTime(e.value)
        if (t == null) continue
        if (sameDay(t, now)) dueIds.add(i.messageId)
        if (t >= now - 2 * DAY && t <= now + 7 * DAY) deadlines.push({ i, t, label: e.label })
      }
    }
    for (const todo of this.deps.store.listInsights('todo')) {
      if (todo.status !== 'open' || !todo.dueAt || !sameDay(Number(todo.dueAt), now)) continue
      if (accountId && todo.accountId && todo.accountId !== accountId) continue
      dueIds.add(todo.messageId ?? todo.id)
    }

    const actCount = act.length
    const waitCount = waits.size
    const dueToday = dueIds.size
    let headline: string
    if (actCount) {
      headline = `今天有 ${actCount} 件事需要你处理`
      if (dueToday) headline += `，${dueToday} 件今天到期`
      if (waitCount) headline += `，${waitCount} 件在等回复`
    } else if (waitCount) {
      headline = `没有待处理的邮件，${waitCount} 件在等对方回复`
    } else {
      headline = '收件箱很清爽，今天没有需要你处理的邮件'
    }

    // 当日商情已生成：直接用其重点（AI）；否则启发式拼装
    const digest = this.deps.store.latestInsight('daily', todayPeriod())?.data as unknown as DailyDigest | undefined
    const highlights = Array.isArray(digest?.highlights) ? digest!.highlights.map(String).filter(Boolean) : []
    if (highlights.length) {
      return { headline, lines: highlights.slice(0, 5), actCount, waitCount, dueToday, source: 'ai' }
    }

    const lines: string[] = []
    const used = new Set<string>()
    const short = (s: string, max = 12) => {
      const t = s.replace(/^\s*((re|fw|fwd|答复|回复|转发)\s*[:：]\s*)+/i, '').replace(/[【\[][^】\]]{0,12}[】\]]/g, '').trim()
      return [...t].length > max ? [...t].slice(0, max).join('') + '…' : t
    }
    for (const d of deadlines.sort((a, b) => a.t - b.t)) {
      if (used.has(d.i.messageId) || lines.length >= 2) continue
      const row = rows.get(d.i.messageId)
      const dt = new Date(d.t)
      const when = sameDay(d.t, now) ? '今天' : sameDay(d.t, now + DAY) ? '明天' : `${dt.getMonth() + 1}/${dt.getDate()}`
      const overdue = d.t < now && !sameDay(d.t, now)
      lines.push(`${short(row?.subject || d.i.gist)} ${when} ${overdue ? '已过期' : '到期'}`)
      used.add(d.i.messageId)
    }
    for (const w of [...waits.values()].sort((a, b) => a.since - b.since).slice(0, 2)) {
      const days = Math.max(2, Math.floor((now - w.since) / DAY))
      lines.push(`${w.name || '对方'} ${days} 天没回`)
    }
    for (const i of act) {
      if (lines.length >= 5) break
      if (used.has(i.messageId)) continue
      const row = rows.get(i.messageId)
      const who = row ? displayName(row.from_name ?? '', row.from_addr ?? '') : ''
      lines.push(`${who ? `${who}：` : ''}${short(i.gist, 24)}`)
      used.add(i.messageId)
    }
    return { headline, lines: lines.slice(0, 5), actCount, waitCount, dueToday, source: 'heuristic' }
  }

  // ---------- 移动建议 ----------

  suggestMoveTarget(messageId: string): { folderId: string; reason: string } | null {
    const row = this.deps.store.getMessageRow(messageId)
    if (!row?.from_addr) return null
    const best = this.deps.store.db
      .prepare(
        `SELECT m.folder_id, COUNT(*) AS c FROM messages m JOIN folders f ON f.id = m.folder_id
         WHERE m.account_id = ? AND lower(m.from_addr) = ? AND m.id != ?
           AND upper(f.path) != 'INBOX'
           AND (f.special IS NULL OR f.special NOT IN ('inbox','trash','junk','sent','drafts','all'))
         GROUP BY m.folder_id ORDER BY c DESC, MAX(m.date) DESC LIMIT 1`
      )
      .get(row.account_id, String(row.from_addr).toLowerCase(), messageId) as { folder_id: string; c: number } | undefined
    if (!best || best.c < 2 || best.folder_id === row.folder_id) return null
    const name = displayName(row.from_name ?? '', row.from_addr)
    return { folderId: best.folder_id, reason: `${name}之前 ${best.c} 封都在这里` }
  }

  // ---------- 发件人上下文（右侧栏） ----------

  senderContext(messageId: string): {
    addr: string
    name: string
    total: number
    lastAt: number | null
    sentByMe: number
    memories: string[]
    promises: string[]
    related: { id: string; title: string; kind: 'kb' | 'message' }[]
  } | null {
    const store = this.deps.store
    const row = store.getMessageRow(messageId)
    if (!row) return null
    const mine = this.myAddrs()
    let addr = String(row.from_addr ?? '').toLowerCase()
    let name = row.from_name ?? ''
    // 我发出的邮件：上下文对象是第一位收件人
    if (!addr || mine.has(addr)) {
      try {
        const to = (JSON.parse(row.to_json || '[]') as { name?: string; address: string }[]).find(a => !mine.has(a.address.toLowerCase()))
        if (to) {
          addr = to.address.toLowerCase()
          name = to.name ?? ''
        }
      } catch { /* ignore */ }
    }
    if (!addr || mine.has(addr)) return null
    const stats = store.db
      .prepare(`SELECT COUNT(*) AS c, MAX(date) AS last, MAX(from_name) AS n FROM messages WHERE lower(from_addr) = ?`)
      .get(addr) as { c: number; last: number | null; n: string | null }
    if (!name) name = stats.n ?? ''
    const sentByMe = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS c FROM messages m JOIN folders f ON f.id = m.folder_id
           WHERE f.special = 'sent' AND (lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ?)`
        )
        .get(`%"${addr}"%`, `%"${addr}"%`) as { c: number }
    ).c
    const display = displayName(name, addr)
    const domain = addr.split('@')[1] ?? ''
    const nameOk = [...display].length >= 2
    const mentions = (m: { entity: string; title: string; content: string }) => {
      const ent = (m.entity || '').toLowerCase()
      if (ent && (ent === addr || (domain && ent === domain) || (nameOk && ent === display.toLowerCase()))) return true
      const hay = `${m.title} ${m.content}`.toLowerCase()
      return hay.includes(addr) || (nameOk && hay.includes(display.toLowerCase()))
    }
    const memories: string[] = []
    const promises: string[] = []
    for (const m of store.listMemories('all')) {
      if (m.status !== 'active' || !mentions(m)) continue
      const line = m.content && m.content !== m.title ? `${m.title}：${m.content}` : m.title
      if (m.scope === 'commitment') {
        if (promises.length < 5) promises.push(line)
      } else if (m.scope === 'person' || m.scope === 'fact' || m.scope === 'preference') {
        if (memories.length < 5) memories.push(line)
      }
    }
    // 相关：来源邮件同发件人 / 标题内容提到对方的知识库条目，不足 4 条用对方近期其他邮件补齐
    const related: { id: string; title: string; kind: 'kb' | 'message' }[] = []
    const kb = store.listKbItems()
    const srcIds = kb.map(k => k.sourceMessageId).filter((x): x is string => !!x)
    const sameSender = new Set<string>()
    for (let i = 0; i < srcIds.length; i += 400) {
      const part = srcIds.slice(i, i + 400)
      const res = store.db
        .prepare(`SELECT id FROM messages WHERE lower(from_addr) = ? AND id IN (${part.map(() => '?').join(',')})`)
        .all(addr, ...part) as { id: string }[]
      for (const r of res) sameSender.add(r.id)
    }
    for (const k of kb) {
      if (related.length >= 4) break
      const byName = nameOk && (k.title.includes(display) || k.content.slice(0, 4000).includes(display) || (k.sourceLabel ?? '').includes(display))
      if ((k.sourceMessageId && sameSender.has(k.sourceMessageId)) || byName) related.push({ id: k.id, title: k.title, kind: 'kb' })
    }
    if (related.length < 4) {
      const others = store.db
        .prepare(
          `SELECT id, subject, thread_id FROM messages WHERE lower(from_addr) = ? AND id != ? AND thread_id != ?
           ORDER BY date DESC LIMIT 12`
        )
        .all(addr, messageId, row.thread_id ?? '') as { id: string; subject: string; thread_id: string }[]
      const seenThreads = new Set<string>()
      for (const o of others) {
        if (related.length >= 4) break
        if (seenThreads.has(o.thread_id)) continue
        seenThreads.add(o.thread_id)
        related.push({ id: o.id, title: o.subject || '（无主题）', kind: 'message' })
      }
    }
    return { addr, name: display, total: stats.c ?? 0, lastAt: stats.last ?? null, sentByMe, memories, promises, related }
  }
}
