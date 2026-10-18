/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipcMain, Notification } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentActivity, AgentEventHit, AgentEventKind, AgentRef, MailInsight } from '@shared/types'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import { DEFAULT_NOTIFICATIONS } from '../store'
import { aiReady, type AIService } from '../ai/service'
import { EVENT_REVIEW } from '../ai/prompts'
import { inQuietHours } from '../notify-policy'
import { detectFinance } from '../finance/detect'
import { runAsBackground, type AiBudget } from '../jobs/budget'
import { listAllSkills, readAttachmentText, registerFollowup, runSkillHeadless } from './hooks'
import {
  detectEvents, EVENT_LABEL, extractNotesActions, isLiveArrival, mergeHits, parseReview, planTriggers, quotaCheck, uncertain,
  DEFAULT_TRIGGER_LIMITS, type EventMailInput, type TriggerPlan
} from './events'

/**
 * 事件触发技能（运行时部分）：
 *  - 同步引擎「实时到达」时 markArrival 登记（历史回填 / 首次整理 / 初始同步不登记 → 不触发）
 *  - 邮件理解 onInsight 回调里 onInsight(ins)：只处理登记过的邮件，防抖后识别事件（启发式 + 拿不准时 AI 复核）
 *  - 命中 enabled 的技能 triggers → 以这封邮件为上下文无界面运行（写操作只列为建议）→ 活动记录 → 按 trigger.notify 发通知
 *  - 幂等：agent_event_runs (message_id, skill_id) 主键，同一封邮件同一技能只跑一次；每小时 / 每天次数上限；后台 AI 用量闸门
 *  - AI 未配置：仍记录识别结果（阅读页可见、可手动运行），技能不跑
 */

export interface EventTriggerDeps {
  db: DatabaseSync
  store: MailStore
  appStore: AppStore
  ai: AIService
  budget: AiBudget
  log(a: Omit<AgentActivity, 'id' | 'at'>): AgentActivity
  event(payload: unknown): void
  showActivity(): void
}

const DAY = 86_400_000
const LIVE_MS = 24 * 3_600_000

function envMs(name: string, def: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 0 ? n : def
}

function jsonFromText(text: string): unknown {
  const cleaned = String(text ?? '').replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('AI 未返回 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

const subj = (s: string | null | undefined) => (String(s ?? '').trim() || '（无主题）').slice(0, 40)

export class EventTriggers {
  /** 实时到达、还在观察窗口里的邮件 → 到达时刻 */
  private live = new Map<string, number>()
  private timers = new Map<string, NodeJS.Timeout>()
  private latest = new Map<string, MailInsight>()
  private waits = new Map<string, number>()
  private queue: { plan: TriggerPlan; messageId: string }[] = []
  private pumping = false
  private reviewed = new Set<string>()
  /** 启发式阶段已识别过（列表刷新会反复回调 onInsight，启发式结果不变就不再识别） */
  private heurDone = new Set<string>()

  constructor(private deps: EventTriggerDeps) {
    deps.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_event_msgs (
        message_id TEXT PRIMARY KEY,
        arrived_at INTEGER NOT NULL,
        hits_json TEXT,
        evaluated_at INTEGER,
        ai_checked INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_agent_event_msgs_at ON agent_event_msgs(arrived_at);
      CREATE TABLE IF NOT EXISTS agent_event_runs (
        message_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        event TEXT NOT NULL,
        at INTEGER NOT NULL,
        status TEXT NOT NULL,
        activity_id TEXT,
        note TEXT,
        PRIMARY KEY (message_id, skill_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_event_runs_at ON agent_event_runs(at);
    `)
    // 重启后接着观察 24 小时内到达、还没等到 AI 理解的邮件
    const since = Date.now() - LIVE_MS
    for (const r of deps.db.prepare('SELECT message_id, arrived_at FROM agent_event_msgs WHERE arrived_at >= ? AND coalesce(ai_checked, 0) = 0').all(since) as any[]) this.live.set(r.message_id, Number(r.arrived_at))
    // 上次退出时排队 / 运行中的：不再自动补跑（标记为跳过，阅读页仍可手动运行）
    deps.db.prepare("UPDATE agent_event_runs SET status = 'skipped', note = '应用退出，未运行完' WHERE status IN ('queued','running')").run()
    // 旧记录清理（90 天）
    deps.db.prepare('DELETE FROM agent_event_msgs WHERE arrived_at < ?').run(Date.now() - 90 * DAY)
    deps.db.prepare('DELETE FROM agent_event_runs WHERE at < ?').run(Date.now() - 90 * DAY)
  }

  // ================================================================ 入口

  /** 同步引擎：收件箱增量抓到的新邮件（必须先于 understand.onArrival 调用） */
  markArrival(messageId: string) {
    try {
      const now = Date.now()
      this.deps.db.prepare('INSERT OR IGNORE INTO agent_event_msgs (message_id, arrived_at) VALUES (?, ?)').run(messageId, now)
      this.live.set(messageId, now)
    } catch (err) {
      console.error('[events] mark arrival failed:', err)
    }
  }

  /** 邮件理解产出（启发式 / AI）：只处理实时到达的邮件；防抖后识别 */
  onInsight(ins: MailInsight) {
    const at = this.live.get(ins.messageId)
    if (at === undefined) return
    if (Date.now() - at > LIVE_MS) {
      this.live.delete(ins.messageId)
      return
    }
    if (ins.source !== 'ai' && this.heurDone.has(ins.messageId)) return
    this.latest.set(ins.messageId, ins)
    const old = this.timers.get(ins.messageId)
    if (old) clearTimeout(old)
    const delay = ins.source === 'ai' ? envMs('LINKTO_EVENTS_AI_DELAY_MS', 1500) : envMs('LINKTO_EVENTS_DELAY_MS', 20_000)
    this.timers.set(
      ins.messageId,
      setTimeout(() => {
        this.timers.delete(ins.messageId)
        void this.evaluate(ins.messageId).catch(err => console.error('[events] evaluate failed:', err))
      }, delay)
    )
  }

  // ================================================================ 识别

  private myAddrs(): Set<string> {
    const set = new Set<string>()
    for (const a of this.deps.store.listAccounts()) {
      if (a.email) set.add(a.email.toLowerCase())
      if (a.user?.includes('@')) set.add(a.user.toLowerCase())
    }
    return set
  }

  private attachmentsOf(messageId: string): { id: string; filename: string; contentType: string; inline: boolean }[] {
    try {
      return (this.deps.db.prepare('SELECT id, filename, content_type, inline FROM attachments WHERE message_id = ? LIMIT 30').all(messageId) as any[]).map(r => ({
        id: r.id,
        filename: r.filename ?? '',
        contentType: r.content_type ?? '',
        inline: !!r.inline
      }))
    } catch {
      return []
    }
  }

  /** 一封邮件 → 识别输入（正文 / 附件名 / ics / 财务识别 / 邮件理解） */
  private input(row: any, ins: MailInsight | null): EventMailInput {
    const atts = this.attachmentsOf(row.id)
    const text = String(row.text || row.snippet || '')
    let finance: EventMailInput['finance'] = null
    try {
      const c = detectFinance({
        messageId: row.id,
        subject: row.subject ?? '',
        text,
        snippet: row.snippet ?? '',
        html: row.html ?? null,
        fromAddr: row.from_addr ?? '',
        fromName: row.from_name ?? '',
        date: Number(row.date) || Date.now(),
        listUnsubscribe: row.list_unsubscribe ?? null,
        isNewsletter: !!row.is_newsletter,
        category: row.category ?? null,
        entities: ins?.entities ?? []
      })
      if (c) finance = { kind: c.kind, event: c.event, amount: c.amount, currency: c.currency, dueAt: c.dueAt, confidence: c.confidence, enterprise: c.enterprise }
    } catch {
      /* 财务识别只是加分项 */
    }
    return {
      messageId: row.id,
      subject: row.subject ?? '',
      text,
      fromAddr: row.from_addr ?? '',
      fromName: row.from_name ?? '',
      attachments: atts.filter(a => !a.inline).map(a => ({ filename: a.filename, contentType: a.contentType })),
      hasIcs: atts.some(a => /text\/calendar/i.test(a.contentType) || /\.ics$/i.test(a.filename)),
      fromMe: this.myAddrs().has(String(row.from_addr ?? '').toLowerCase()),
      isNewsletter: !!row.is_newsletter,
      insight: ins ? { section: ins.section, bundle: ins.bundle, gist: ins.gist, entities: ins.entities, source: ins.source } : null,
      finance,
      date: Number(row.date) || Date.now()
    }
  }

  /** 后台 AI 能不能用（已配置 + 没超额 / 没在用电池）；不能时返回原因 */
  private aiBlocked(): string | null {
    if (!aiReady(this.deps.appStore.getAI(), false)) return 'AI 未配置'
    return this.deps.budget.blocked()
  }

  /** 拿不准的事件交给 AI 复核（每封邮件最多一次，走后台用量闸门） */
  private async review(row: any, hits: AgentEventHit[]): Promise<AgentEventHit[]> {
    const unsure = hits.filter(uncertain)
    if (!unsure.length || this.reviewed.has(row.id) || this.aiBlocked()) return hits
    this.reviewed.add(row.id)
    const asked = unsure.map(h => h.event)
    try {
      const user = `候选事件：${asked.join('、')}\n发件人：${row.from_name ?? ''} <${row.from_addr ?? ''}>\n主题：${row.subject ?? ''}\n\n正文：\n${String(row.text || row.snippet || '').slice(0, 2500)}`
      const raw = await runAsBackground('event-review', () => this.deps.ai.complete([{ role: 'system', content: EVENT_REVIEW }, { role: 'user', content: user }], 400))
      const { confirmed, rejected } = parseReview(jsonFromText(raw), row.id, asked)
      // 确认的抬到触发线以上；否决的降到展示线以下（不再显示）
      return mergeHits(hits.filter(h => !rejected.includes(h.event) && !confirmed.some(c => c.event === h.event)), confirmed)
    } catch (err) {
      console.error('[events] review failed:', err instanceof Error ? err.message : err)
      return hits
    }
  }

  private savedHits(messageId: string): AgentEventHit[] {
    try {
      const r = this.deps.db.prepare('SELECT hits_json FROM agent_event_msgs WHERE message_id = ?').get(messageId) as any
      return r?.hits_json ? (JSON.parse(r.hits_json) as AgentEventHit[]) : []
    } catch {
      return []
    }
  }

  private async evaluate(messageId: string) {
    const arrivedAt = this.live.get(messageId)
    const ins = this.latest.get(messageId) ?? null
    const row = this.deps.store.getMessageRow(messageId)
    if (!row || arrivedAt === undefined || !isLiveArrival({ arrivedAt, date: Number(row.date) || 0, now: Date.now() })) {
      this.forget(messageId)
      return
    }
    // 还没有 AI 理解、但后台理解开着：再等一会（最多 3 次），拿到正文与 AI 结果更准
    const s = this.deps.appStore.getAI()
    const waited = this.waits.get(messageId) ?? 0
    if (ins?.source !== 'ai' && s.autoUnderstand && aiReady(s, false) && waited < 3 && Date.now() - arrivedAt < 3 * 60_000) {
      this.waits.set(messageId, waited + 1)
      this.timers.set(
        messageId,
        setTimeout(() => {
          this.timers.delete(messageId)
          void this.evaluate(messageId).catch(err => console.error('[events] evaluate failed:', err))
        }, envMs('LINKTO_EVENTS_DELAY_MS', 30_000))
      )
      return
    }
    let hits = mergeHits(this.savedHits(messageId), detectEvents(this.input(row, ins)))
    hits = await this.review(row, hits)
    const aiChecked = ins?.source === 'ai' ? 1 : 0
    this.deps.db.prepare('UPDATE agent_event_msgs SET hits_json = ?, evaluated_at = ?, ai_checked = ? WHERE message_id = ?').run(JSON.stringify(hits), Date.now(), aiChecked, messageId)
    // 拿到 AI 理解 = 定稿，不再观察；启发式阶段继续等 AI 结果（新的事件还能补触发）
    if (aiChecked) this.forget(messageId)
    else this.heurDone.add(messageId)
    if (hits.length) {
      console.log(`[events] ${messageId.slice(-24)}: ${hits.map(h => `${h.event}(${h.confidence})`).join(', ')}`)
      const skills = await listAllSkills()
      const plans = planTriggers(skills, hits, { messageId, fromAddr: row.from_addr ?? '', fromName: row.from_name ?? '', subject: row.subject ?? '', accountId: row.account_id })
      for (const plan of plans) this.enqueue(plan, messageId)
    }
    this.deps.event({ type: 'agent-events', messageId })
  }

  private forget(messageId: string) {
    this.live.delete(messageId)
    this.latest.delete(messageId)
    this.waits.delete(messageId)
    this.heurDone.delete(messageId)
  }

  // ================================================================ 运行

  private enqueue(plan: TriggerPlan, messageId: string) {
    // 幂等占位：同一封邮件同一技能只跑一次（持久化）
    const res = this.deps.db
      .prepare("INSERT OR IGNORE INTO agent_event_runs (message_id, skill_id, event, at, status) VALUES (?, ?, ?, ?, 'queued')")
      .run(messageId, plan.skillId, plan.event, Date.now())
    if (!Number(res.changes)) return
    this.queue.push({ plan, messageId })
    void this.pump()
  }

  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!
        try {
          await this.runOne(job.plan, job.messageId)
        } catch (err) {
          console.error('[events] run failed:', err)
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private setRun(messageId: string, skillId: string, patch: { status: string; note?: string | null; activityId?: string | null }) {
    this.deps.db
      .prepare('UPDATE agent_event_runs SET status = ?, note = ?, activity_id = coalesce(?, activity_id), at = ? WHERE message_id = ? AND skill_id = ?')
      .run(patch.status, patch.note ?? null, patch.activityId ?? null, Date.now(), messageId, skillId)
  }

  private recentRunTimes(now: number): number[] {
    return (this.deps.db.prepare("SELECT at FROM agent_event_runs WHERE at >= ? AND status IN ('running','done','error')").all(now - DAY) as any[]).map(r => Number(r.at))
  }

  private async runOne(plan: TriggerPlan, messageId: string) {
    const row = this.deps.store.getMessageRow(messageId)
    if (!row) {
      this.setRun(messageId, plan.skillId, { status: 'skipped', note: '邮件已删除' })
      return
    }
    const label = EVENT_LABEL[plan.event]
    const mailRef: AgentRef = { type: 'mail', id: messageId, label: subj(row.subject) }
    const action = { label: '在对话中运行', skillId: plan.skillId, messageId }
    // 不能跑：AI 未配置 / 超额 / 用电池 / 触发次数上限 → 只记识别结果
    const why = this.aiBlocked() ?? quotaCheck(this.recentRunTimes(Date.now()), Date.now(), DEFAULT_TRIGGER_LIMITS).reason
    if (why) {
      const a = this.deps.log({
        source: 'event',
        title: `${label}：识别到『${subj(row.subject)}』，未自动运行『${plan.skillName}』`,
        detail: `${why}。识别依据：${plan.hit.reason}`,
        refs: [mailRef],
        action
      })
      this.setRun(messageId, plan.skillId, { status: 'skipped', note: why, activityId: a.id })
      this.deps.event({ type: 'agent-events', messageId })
      return
    }
    this.setRun(messageId, plan.skillId, { status: 'running' })
    this.deps.event({ type: 'agent-events', messageId })
    const params: Record<string, string | number> = { messageId, event: label, eventReason: plan.hit.reason }
    const att = await this.attachmentText(messageId)
    if (att) params.attachmentText = att
    const r = await runAsBackground(`event:${plan.skillId}`, () => runSkillHeadless(plan.skillId, params))
    if (!r.ok) {
      const a = this.deps.log({ source: 'event', title: `${label}：『${plan.skillName}』运行失败`, detail: `${r.error || '未知错误'}\n邮件：${subj(row.subject)}`, refs: [mailRef], action })
      this.setRun(messageId, plan.skillId, { status: 'error', note: r.error ?? null, activityId: a.id })
      this.deps.event({ type: 'agent-events', messageId })
      return
    }
    let text = String(r.text ?? '').trim()
    let followups = 0
    // 会后纪要拆解：结构化行动项 → 给别人的登记为跟进（跟进模块就绪时）
    const ex = extractNotesActions(text)
    if (ex.actions.length) {
      text = ex.text
      for (const act of ex.actions) {
        if (act.owner !== 'other' || !act.to.length) continue
        const id = registerFollowup({
          kind: act.kind,
          ask: `${act.who || act.to[0]}：${act.what}`.slice(0, 120),
          to: act.to,
          subject: `跟进：${subj(row.subject)}`,
          relatedMessageId: messageId,
          source: 'skill'
        })
        if (id) followups++
      }
    }
    // 去掉与技能同名的标题行（活动记录标题里已有技能名）
    text = text.replace(/^#{1,3}\s*(.+)\n+/, (m, h: string) => (h.trim() === plan.skillName ? '' : m)).trim()
    const first = text.split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '已完成'
    const refs = [mailRef, ...(r.refs ?? []).filter(x => !(x.type === 'mail' && x.id === messageId))].slice(0, 10)
    const a = this.deps.log({
      source: 'event',
      title: `${label}：已为『${subj(row.subject)}』跑了『${plan.skillName}』`,
      detail: `${text.slice(0, 1700)}${followups ? `\n\n已登记 ${followups} 条跟进（在等对方）` : ''}`,
      refs,
      stats: { events: 1 },
      action
    })
    this.setRun(messageId, plan.skillId, { status: 'done', activityId: a.id, note: first.slice(0, 120) })
    this.deps.event({ type: 'agent-events', messageId })
    if (plan.notify) this.notify(`${label}：${plan.skillName}`, `${subj(row.subject)} · ${first}`)
  }

  /** 附件正文（PDF 等，附件模块注册了读取器时）；最多两个附件、6000 字 */
  private async attachmentText(messageId: string): Promise<string | null> {
    const atts = this.attachmentsOf(messageId).filter(a => !a.inline && /(pdf|text\/plain|\.txt$|\.md$)/i.test(`${a.contentType} ${a.filename}`))
    const parts: string[] = []
    for (const a of atts.slice(0, 2)) {
      const t = await readAttachmentText(a.id, 4000)
      if (t && t.trim()) parts.push(`【附件：${a.filename}】\n${t.trim()}`)
    }
    return parts.length ? parts.join('\n\n').slice(0, 6000) : null
  }

  private notify(title: string, body: string) {
    try {
      const s = this.deps.appStore.get('notifications', DEFAULT_NOTIFICATIONS)
      if (!s.enabled || inQuietHours(s.quietHours, new Date()) || !Notification.isSupported()) return
      const n = new Notification({ title, body: body.slice(0, 180), silent: !s.sound })
      n.on('click', () => this.deps.showActivity())
      n.show()
    } catch (err) {
      console.error('[events] notify failed:', err)
    }
  }

  // ================================================================ 查询（阅读页事件条）

  /** 一封邮件命中的事件 + 已运行的技能。没登记过的（历史邮件）即时识别（不跑 AI、不触发） */
  eventsFor(messageId: string): { hits: AgentEventHit[]; runs: { skillId: string; at: number; activityId?: string | null; status: string; event: AgentEventKind; note: string | null }[] } {
    const id = String(messageId ?? '')
    let hits: AgentEventHit[] = []
    const saved = this.deps.db.prepare('SELECT hits_json FROM agent_event_msgs WHERE message_id = ?').get(id) as any
    if (saved?.hits_json) hits = this.savedHits(id)
    else {
      const row = this.deps.store.getMessageRow(id)
      if (row) {
        const ins = this.deps.store.getMailAi([id])[id] ?? null
        hits = detectEvents(this.input(row, ins))
      }
    }
    const runs = (this.deps.db.prepare('SELECT skill_id, at, activity_id, status, event, note FROM agent_event_runs WHERE message_id = ? ORDER BY at DESC').all(id) as any[]).map(r => ({
      skillId: r.skill_id,
      at: Number(r.at),
      activityId: r.activity_id ?? null,
      status: r.status,
      event: r.event as AgentEventKind,
      note: r.note ?? null
    }))
    return { hits, runs }
  }
}

/** 初始化：建表、注册 agentEventsFor IPC；返回给 index.ts 的两个挂钩 */
export function initEventTriggers(deps: EventTriggerDeps): EventTriggers {
  const t = new EventTriggers(deps)
  ipcMain.handle('api:agentEventsFor', async (_e, messageId: string) => {
    try {
      return t.eventsFor(String(messageId))
    } catch (err) {
      console.error('[ipc:agentEventsFor]', err)
      throw err
    }
  })
  return t
}
