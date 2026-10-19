import { randomUUID } from 'node:crypto'
import type { Address, AgentRef, AISettings, ComposeDraft, ComposeFollowup, FollowupData, FollowupKind, FollowupStatus, InsightRecord } from '@shared/types'
import {
  clampMaxAttempts, clampWaitDays, DAY_MS, DEFAULT_MAX_ATTEMPTS, dueAtFor, FOLLOWUP_KIND_NOUN, inferAsk, inferKind, isActive, isFollowupKind, looksLikeInvoice,
  matchReply, normMsgId, nudgeTemplate, overdueDays, rowStatusOf, shouldAutoNudge, shouldNotifyOverdue, transition, waitedDays,
  type FollowupEvent, type FollowupState, type IncomingMail
} from '@shared/followups'
import type { MailStore } from '../db'
import type { AIService } from '../ai/service'
import { aiReady } from '../ai/service'
import { FOLLOWUP_NUDGE, JSON_RETRY_NUDGE } from '../ai/prompts'
import { normalizeSubject } from '../mail/classify'
import { htmlToText, textToHtml } from '../agent/protocol'
import { logActivity, type FollowupRegistrar } from '../agent/hooks'
import type { OutboxEvent } from '../mail/outbox'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 跟进闭环服务：insights kind='followup'（data = FollowupData；dueAt = 到期时间；status open 进行中 / done 已结束）。
 *  - 登记：Agent / 技能起草（drafted）、撰写窗「发出后跟进」、手动「N 天后没回提醒我」
 *  - 发出：订阅发件队列的 sent 事件，真正发出后才转 waiting（延迟 / 定时发送同样到点发出后才转）
 *  - 回复：新邮件到达 / 每小时检查时按 In-Reply-To·References / 会话 / 同主题+对方地址匹配 → replied
 *  - 到期：每小时检查 → overdue + 通知 + 自动起草下一封催促草稿（只起草，绝不发送）
 */

export interface FollowupDeps {
  store: MailStore
  ai: AIService
  getAISettings(): AISettings
  event(payload: unknown): void
  /** 打开撰写窗（预填草稿；用户检查后自己发送） */
  openCompose(prefill: Record<string, unknown>): void
  /** 系统通知（受通知设置 / 免打扰约束，由注册方实现） */
  notify(title: string, body: string, followupId: string): void
}

export type FollowupRec = Omit<InsightRecord, 'data'> & { data: FollowupData }

export interface CheckResult {
  overdue: FollowupRec[]
  nudged: FollowupRec[]
  replied: FollowupRec[]
  checked: number
}

const subj = (s: string | null | undefined) => (s || '').trim() || '（无主题）'
const addrList = (json: string | null | undefined): Address[] => {
  try {
    const v = JSON.parse(json ?? '[]')
    return Array.isArray(v) ? v.filter(a => a && typeof a.address === 'string') : []
  } catch {
    return []
  }
}

function jsonFromText(text: string): any {
  const s = String(text ?? '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('不是 JSON')
  return JSON.parse(s.slice(a, b + 1))
}

export class FollowupService {
  private changedTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private deps: FollowupDeps) {}

  // ---------------------------------------------------------------- 读

  private toRec(r: any): FollowupRec {
    const data = { ...(r.data ?? {}) } as FollowupData
    data.attempts = Number(data.attempts) || 0
    data.maxAttempts = clampMaxAttempts(data.maxAttempts)
    data.waitDays = clampWaitDays(data.waitDays)
    data.to = Array.isArray(data.to) ? data.to : []
    return { id: r.id, kind: 'followup', messageId: r.messageId ?? null, accountId: r.accountId ?? null, title: r.title, status: r.status === 'done' ? 'done' : 'open', dueAt: r.dueAt ?? null, createdAt: r.createdAt ?? 0, data }
  }

  rows(): FollowupRec[] {
    return this.deps.store.listInsights('followup').map(r => this.toRec(r))
  }

  get(id: string): FollowupRec | null {
    const r = this.deps.store.getInsight(id)
    if (!r || r.kind !== 'followup') return null
    return this.toRec(r)
  }

  /** 列表：进行中的在前（逾期 → 等待中按到期 → 待发出 → 已回复），已结束的放最后 */
  list(includeClosed = false): FollowupRec[] {
    try {
      this.reconcile(Date.now())
    } catch (err) {
      console.error('[followups] reconcile failed:', err)
    }
    const rank: Record<FollowupStatus, number> = { overdue: 0, waiting: 1, drafted: 2, replied: 3, closed: 4, cancelled: 5 }
    return this.rows()
      .filter(r => includeClosed || isActive(r.data.status))
      .sort((a, b) => rank[a.data.status] - rank[b.data.status] || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || b.createdAt - a.createdAt)
  }

  private active(pred: (d: FollowupData) => boolean): FollowupRec | null {
    return this.rows().find(r => isActive(r.data.status) && pred(r.data)) ?? null
  }

  private myAddrs(): Set<string> {
    const set = new Set<string>()
    for (const a of this.deps.store.listAccounts()) {
      if (a.email) set.add(a.email.toLowerCase())
      if (a.user?.includes('@')) set.add(a.user.toLowerCase())
    }
    return set
  }

  private draftExists(id: string | null | undefined): boolean {
    if (!id) return false
    return !!this.deps.store.db.prepare('SELECT 1 FROM drafts WHERE id = ?').get(id)
  }

  // ---------------------------------------------------------------- 写

  private changed() {
    if (this.changedTimer) return
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      this.deps.event({ type: 'followups-changed' })
    }, 80)
  }

  private titleOf(d: FollowupData): string {
    return (d.ask?.trim() || subj(d.subject)).slice(0, 80)
  }

  private save(rec: FollowupRec, next: FollowupState): FollowupRec {
    const data = { ...next.data, updatedAt: Date.now() }
    this.deps.store.updateInsight(rec.id, { title: this.titleOf(data), status: rowStatusOf(data.status), dueAt: next.dueAt, data: data as unknown as Record<string, unknown> })
    this.changed()
    return { ...rec, data, dueAt: next.dueAt, status: rowStatusOf(data.status), title: this.titleOf(data) }
  }

  private apply(rec: FollowupRec, ev: FollowupEvent): FollowupRec | null {
    const next = transition({ data: rec.data, dueAt: rec.dueAt }, ev)
    return next ? this.save(rec, next) : null
  }

  private refs(rec: FollowupRec, extra: AgentRef[] = []): AgentRef[] {
    const d = rec.data
    const out: AgentRef[] = [{ type: 'followup', id: rec.id, label: subj(d.subject) }, ...extra]
    const mailId = d.sentMessageId ?? d.relatedMessageId
    if (mailId && !out.some(r => r.id === mailId) && this.deps.store.getMessageRow(mailId)) out.push({ type: 'mail', id: mailId, label: subj(d.subject) })
    if (d.financeId) out.push({ type: 'finance', id: d.financeId, label: '关联款项' })
    return out
  }

  private whoOf(d: FollowupData): string {
    const first = d.to[0]
    if (!first) return '对方'
    const row = this.deps.store.db
      .prepare("SELECT from_name FROM messages WHERE lower(from_addr) = ? AND from_name IS NOT NULL AND from_name != '' ORDER BY date DESC LIMIT 1")
      .get(first.toLowerCase()) as { from_name?: string } | undefined
    return row?.from_name || first
  }

  private insert(data: FollowupData, dueAt: number | null, messageId: string | null): FollowupRec {
    const id = `fu-${randomUUID()}`
    const full: FollowupData = { ...data, updatedAt: Date.now() }
    this.deps.store.insertInsight({ id, kind: 'followup', accountId: data.accountId ?? null, messageId, title: this.titleOf(full), data: full as unknown as Record<string, unknown>, dueAt })
    // insertInsight 固定写 status='open'；新登记的都是进行中
    this.changed()
    return this.get(id)!
  }

  /** 登记（hooks.registerFollowup 的实现）：已给出 sentMessageId 时直接进入等待，否则为 drafted（等用户发出） */
  register: FollowupRegistrar = input => {
    try {
      const { store } = this.deps
      const now = Date.now()
      const sent = input.sentMessageId ? store.getMessageRow(input.sentMessageId) : null
      const related = input.relatedMessageId ? store.getMessageRow(input.relatedMessageId) : null
      // 同一草稿只登记一条（Agent 重复调用时更新）
      const existing = input.draftId ? this.active(d => d.draftId === input.draftId) : sent ? this.active(d => d.sentMessageId === sent.id) : null
      const text = `${input.subject}\n${input.ask ?? ''}`
      const kind: FollowupKind = isFollowupKind(input.kind) ? input.kind : inferKind(text)
      const waitDays = clampWaitDays(input.waitDays)
      const ask = (input.ask ?? '').trim().slice(0, 120) || inferAsk(text, kind)
      if (existing) {
        const d = { ...existing.data, kind, ask, waitDays, to: input.to.length ? input.to : existing.data.to, subject: input.subject || existing.data.subject }
        this.save(existing, { data: d, dueAt: existing.dueAt })
        return existing.id
      }
      const data: FollowupData = {
        kind,
        status: sent ? 'waiting' : 'drafted',
        ask,
        to: input.to.map(a => a.trim()).filter(Boolean),
        subject: input.subject,
        relatedMessageId: input.relatedMessageId ?? null,
        draftId: sent ? null : input.draftId ?? null,
        sentMessageId: sent?.id ?? null,
        sentHeaderId: sent?.message_id ?? null,
        sentAt: sent?.date ?? null,
        threadId: sent?.thread_id ?? related?.thread_id ?? null,
        accountId: sent?.account_id ?? related?.account_id ?? null,
        waitDays,
        attempts: 0,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        source: input.source,
        financeId: input.financeId ?? null,
        projectId: input.projectId ?? null
      }
      const rec = this.insert(data, sent ? dueAtFor(now, waitDays) : null, sent?.id ?? related?.id ?? null)
      logActivity({
        source: input.source === 'skill' ? 'skill' : input.source === 'agent' ? 'chat' : 'job',
        title: sent ? `开始跟进：${this.titleOf(data)}` : `已登记跟进：${this.titleOf(data)}`,
        detail: sent ? `${waitDays} 天后（${new Date(rec.dueAt!).toLocaleDateString('zh-CN')}）对方还没回会提醒你` : `草稿发出后 ${waitDays} 天未回会提醒你`,
        refs: this.refs(rec)
      })
      return rec.id
    } catch (err) {
      console.error('[followups] register failed:', err)
      return null
    }
  }

  /** 手动：对一封已发出的邮件「N 天后没回提醒我」（已存在则更新等待天数） */
  createFromMessage(input: { messageId: string; kind?: FollowupKind; ask?: string; waitDays?: number }): string {
    const { store } = this.deps
    const row = store.getMessageRow(input.messageId)
    if (!row) throw new Error('找不到这封邮件')
    const now = Date.now()
    const waitDays = clampWaitDays(input.waitDays)
    const existing = this.active(d => d.sentMessageId === row.id || (!!row.message_id && normMsgId(d.sentHeaderId) === normMsgId(row.message_id)))
    if (existing) {
      const d = { ...existing.data, waitDays, ...(input.ask?.trim() ? { ask: input.ask.trim() } : {}), ...(isFollowupKind(input.kind) ? { kind: input.kind } : {}) }
      const st = existing.data.status === 'drafted' ? { data: d, dueAt: existing.dueAt } : transition({ data: d, dueAt: existing.dueAt }, { type: 'snooze', at: now, days: waitDays })
      this.save(existing, st ?? { data: d, dueAt: existing.dueAt })
      return existing.id
    }
    const mine = this.myAddrs()
    const fromMe = mine.has(String(row.from_addr ?? '').toLowerCase())
    const to = fromMe
      ? [...addrList(row.to_json), ...addrList(row.cc_json)].map(a => a.address.toLowerCase()).filter(a => !mine.has(a))
      : row.from_addr
        ? [String(row.from_addr).toLowerCase()]
        : []
    const text = `${row.subject ?? ''}\n${String(row.text || row.snippet || '').slice(0, 3000)}`
    const kind = isFollowupKind(input.kind) ? input.kind : inferKind(text)
    const data: FollowupData = {
      kind,
      status: 'waiting',
      ask: input.ask?.trim().slice(0, 120) || inferAsk(String(row.text || row.snippet || row.subject || ''), kind),
      to: [...new Set(to)],
      subject: row.subject ?? '',
      relatedMessageId: null,
      draftId: null,
      sentMessageId: row.id,
      sentHeaderId: row.message_id ?? null,
      sentAt: row.date ?? now,
      threadId: row.thread_id ?? null,
      accountId: row.account_id ?? null,
      waitDays,
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      source: 'manual'
    }
    const rec = this.insert(data, dueAtFor(now, waitDays), row.id)
    logActivity({ source: 'job', title: `开始跟进：${this.titleOf(data)}`, detail: `${waitDays} 天后（${new Date(rec.dueAt!).toLocaleDateString('zh-CN')}）对方还没回会提醒你`, refs: this.refs(rec) })
    // 已经回过的话立刻结束
    this.reconcile(now)
    return rec.id
  }

  update(id: string, patch: { status?: FollowupStatus; waitDays?: number; ask?: string; maxAttempts?: number; kind?: FollowupKind; snoozeDays?: number }) {
    let rec = this.get(id)
    if (!rec) throw new Error('跟进不存在')
    const now = Date.now()
    const p = patch ?? {}
    // 字段修改
    const d: FollowupData = { ...rec.data }
    let touched = false
    if (p.ask !== undefined) {
      d.ask = String(p.ask).trim().slice(0, 120) || d.ask
      touched = true
    }
    if (isFollowupKind(p.kind)) {
      d.kind = p.kind
      touched = true
    }
    if (p.maxAttempts !== undefined) {
      d.maxAttempts = clampMaxAttempts(p.maxAttempts)
      touched = true
    }
    let dueAt = rec.dueAt
    if (p.waitDays !== undefined) {
      d.waitDays = clampWaitDays(p.waitDays)
      touched = true
      // 改了等待天数：从上次发出（或再催）的时刻重新算到期
      if ((d.status === 'waiting' || d.status === 'overdue') && p.snoozeDays === undefined && p.status === undefined) {
        dueAt = dueAtFor(d.lastNudgeAt ?? d.sentAt ?? now, d.waitDays)
        if (d.status === 'overdue' && dueAt > now) d.status = 'waiting'
      }
    }
    if (touched) rec = this.save(rec, { data: d, dueAt })
    if (p.snoozeDays !== undefined) {
      rec = this.apply(rec, { type: 'snooze', at: now, days: clampWaitDays(p.snoozeDays) }) ?? rec
    }
    if (p.status && p.status !== rec.data.status) {
      if (p.status === 'closed') this.apply(rec, { type: 'close', at: now })
      else if (p.status === 'cancelled') this.apply(rec, { type: 'cancel', at: now })
      else if (p.status === 'waiting') this.apply(rec, { type: 'snooze', at: now, days: p.waitDays ?? rec.data.waitDays })
      else this.save(rec, { data: { ...rec.data, status: p.status }, dueAt: rec.dueAt })
    }
  }

  // ---------------------------------------------------------------- 发件队列

  onOutbox(e: OutboxEvent) {
    try {
      if (e.type === 'sent') this.onSent(e.draft, e.messageId)
      else if (e.type === 'scheduled') this.onScheduled(e.draft)
      else if (e.type === 'cancelled') this.onCancelled(e.id)
    } catch (err) {
      console.error('[followups] outbox event failed:', err)
    }
  }

  /** 找这封草稿对应的跟进：撰写窗带来的 id > 草稿 id（drafted）> 催促草稿 id */
  private forDraft(draft: ComposeDraft): FollowupRec | null {
    const fid = draft.followup?.id
    const byId = fid ? this.get(fid) : null
    if (byId && isActive(byId.data.status)) return byId
    return this.active(d => d.draftId === draft.id || d.nudgeDraftId === draft.id)
  }

  /** 撰写窗开关里的类型 / 在等什么 / 天数覆盖到跟进上 */
  private withOverrides(d: FollowupData, fu: ComposeFollowup | null | undefined, draft: ComposeDraft): FollowupData {
    const out = { ...d }
    if (fu) {
      if (isFollowupKind(fu.kind)) out.kind = fu.kind
      if (fu.ask?.trim()) out.ask = fu.ask.trim().slice(0, 120)
      if (fu.waitDays !== undefined) out.waitDays = clampWaitDays(fu.waitDays)
    }
    if (out.status === 'drafted') {
      out.to = draft.to.map(a => a.address.toLowerCase())
      out.subject = draft.subject
      out.accountId = draft.accountId
    }
    return out
  }

  private newFromDraft(draft: ComposeDraft, fu: ComposeFollowup): FollowupRec {
    const related = draft.relatedMessageId ? this.deps.store.getMessageRow(draft.relatedMessageId) : null
    const text = `${draft.subject}\n${htmlToText(draft.html).slice(0, 3000)}`
    const kind = isFollowupKind(fu.kind) ? fu.kind : inferKind(text)
    const data: FollowupData = {
      kind,
      status: 'drafted',
      ask: fu.ask?.trim().slice(0, 120) || inferAsk(htmlToText(draft.html).split(/\n-{2,}|\n>/)[0] ?? '', kind),
      to: draft.to.map(a => a.address.toLowerCase()),
      subject: draft.subject,
      relatedMessageId: related?.id ?? null,
      draftId: draft.id,
      sentMessageId: null,
      threadId: related?.thread_id ?? null,
      accountId: draft.accountId,
      waitDays: clampWaitDays(fu.waitDays),
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      source: 'manual'
    }
    return this.insert(data, null, related?.id ?? null)
  }

  private onScheduled(draft: ComposeDraft) {
    const fu = draft.followup
    if (!fu) return
    const rec = this.forDraft(draft)
    if (!fu.enabled) {
      if (rec && rec.data.status === 'drafted') this.apply(rec, { type: 'cancel', at: Date.now() })
      return
    }
    if (!rec) {
      this.newFromDraft(draft, fu)
      return
    }
    // 定时发送的那封就是要等的那封：drafted 记下草稿 id；再催的那封记为 nudgeDraftId
    const d = this.withOverrides(rec.data, fu, draft)
    if (d.status === 'drafted') d.draftId = draft.id
    else d.nudgeDraftId = draft.id
    this.save(rec, { data: d, dueAt: rec.dueAt })
  }

  private onCancelled(id: string) {
    for (const r of this.rows()) {
      if (!isActive(r.data.status)) continue
      if (r.data.status === 'drafted' && r.data.draftId === id) this.apply(r, { type: 'cancel', at: Date.now() })
      else if (r.data.nudgeDraftId === id) this.save(r, { data: { ...r.data, nudgeDraftId: null }, dueAt: r.dueAt })
    }
  }

  private onSent(draft: ComposeDraft, header?: string) {
    const fu = draft.followup
    let rec = this.forDraft(draft)
    if (fu && fu.enabled === false) {
      if (rec && rec.data.status === 'drafted') this.apply(rec, { type: 'cancel', at: Date.now() })
      return
    }
    if (!rec && !fu?.enabled) return
    if (!rec) rec = this.newFromDraft(draft, fu!)
    const now = Date.now()
    const related = draft.relatedMessageId ? this.deps.store.getMessageRow(draft.relatedMessageId) : null
    const isNudge = rec.data.status !== 'drafted'
    rec = this.save(rec, { data: this.withOverrides(rec.data, fu, draft), dueAt: rec.dueAt })
    const next = this.apply(rec, { type: 'sent', at: now, sentHeaderId: header ?? null, threadId: related?.thread_id ?? null, nudge: isNudge })
    if (!next) return
    const d = next.data
    logActivity({
      source: d.source === 'skill' ? 'skill' : d.source === 'agent' ? 'chat' : 'job',
      title: isNudge ? `已发出第 ${d.nudgesSent ?? 1} 封催促：${subj(d.subject)}` : `已发出，开始跟进：${this.titleOf(d)}`,
      detail: `${d.waitDays} 天后（${new Date(next.dueAt!).toLocaleDateString('zh-CN')}）对方还没回会提醒你`,
      refs: this.refs(next)
    })
    // 补上已发送副本（如果已经同步回来）
    this.reconcile(now)
  }

  // ---------------------------------------------------------------- 回复

  private incoming(row: any): IncomingMail {
    let refs: string[] = []
    try {
      refs = JSON.parse(row.references_txt ?? '[]')
    } catch {
      refs = []
    }
    return { id: row.id, threadId: row.thread_id, inReplyTo: row.in_reply_to, references: Array.isArray(refs) ? refs : [], from: String(row.from_addr ?? ''), subject: String(row.subject ?? ''), date: Number(row.date) || 0 }
  }

  private indexedAttachments(messageId: string): { filename: string; contentType: string }[] {
    try {
      return (this.deps.store.db.prepare('SELECT filename, content_type FROM attachment_index WHERE message_id = ?').all(messageId) as { filename: string; content_type: string }[]).map(a => ({
        filename: a.filename,
        contentType: a.content_type
      }))
    } catch {
      return [] // 附件中心未初始化（表不存在）
    }
  }

  private markReplied(rec: FollowupRec, row: any, matchedBy: 'header' | 'thread' | 'subject'): FollowupRec | null {
    let invoiceHint = false
    if (rec.data.kind === 'invoice') {
      // 刚到达时正文 / 附件还没下载：附件中心的 BODYSTRUCTURE 索引（attachment_index）此时已有文件名与类型
      const atts = [
        ...(this.deps.store.getMessageFull(row.id)?.attachments.map(a => ({ filename: a.filename, contentType: a.contentType })) ?? []),
        ...this.indexedAttachments(row.id)
      ]
      // 催开票后对方回信带了附件，多半就是发票
      invoiceHint = looksLikeInvoice({ subject: row.subject, snippet: row.snippet, attachments: atts }) || !!row.has_attachments
    }
    const next = this.apply(rec, { type: 'reply', at: Date.now(), messageId: row.id, matchedBy, invoiceHint })
    if (!next) return null
    const who = row.from_name || row.from_addr || '对方'
    const noun = FOLLOWUP_KIND_NOUN[next.data.kind]
    logActivity({
      source: 'job',
      title: `${who} 回复了你的${noun}邮件：${subj(next.data.subject)}`,
      detail:
        `在等：${next.data.ask}（等了 ${waitedDays(next.data.sentAt, Date.now())} 天）` +
        (invoiceHint ? '\n来信带 PDF / 发票，可以到财务中心把它关联到对应款项' : '') +
        '\n确认事情办完后在「等待对方」里点「已解决」',
      refs: this.refs(next, [{ type: 'mail', id: row.id, label: `回复 · ${subj(row.subject)}` }])
    })
    return next
  }

  /** 新邮件到达（同步引擎 arrived 钩子）：属于某条跟进的回复 → replied */
  onArrival(messageId: string) {
    try {
      const row = this.deps.store.getMessageRow(messageId)
      if (!row) return
      const m = this.incoming(row)
      const mine = this.myAddrs()
      for (const rec of this.rows()) {
        if (rec.data.status !== 'waiting' && rec.data.status !== 'overdue') continue
        const how = matchReply({ ...rec.data, to: rec.data.to }, m, mine)
        if (how) this.markReplied(rec, row, how)
      }
    } catch (err) {
      console.error('[followups] arrival failed:', err)
    }
  }

  /**
   * 对账（便宜，纯本地查询）：补全已发送副本的本地 id / 会话；在本地邮件里找漏掉的回复（离线期间到达、被规则挪走的）。
   * 返回本轮新判定为已回复的跟进。
   */
  reconcile(now: number): FollowupRec[] {
    const { store } = this.deps
    const db = store.db
    const out: FollowupRec[] = []
    const mine = this.myAddrs()
    for (let rec of this.rows()) {
      const d = rec.data
      if (d.status !== 'waiting' && d.status !== 'overdue') continue
      // 已发送副本同步回来：记下本地 id 与会话
      if (d.sentHeaderId && !d.sentMessageId) {
        const h = normMsgId(d.sentHeaderId)
        const sent = db.prepare('SELECT id, thread_id FROM messages WHERE message_id IN (?, ?, ?) LIMIT 1').get(d.sentHeaderId, `<${h}>`, h) as { id: string; thread_id: string } | undefined
        if (sent) rec = this.save(rec, { data: { ...d, sentMessageId: sent.id, threadId: d.threadId ?? sent.thread_id }, dueAt: rec.dueAt })
      }
      const f = rec.data
      const since = (f.sentAt ?? rec.createdAt) - 5 * 60_000
      const h = normMsgId(f.sentHeaderId)
      const norm = normalizeSubject(f.subject ?? '')
      const cands = db
        .prepare(
          `SELECT * FROM messages WHERE date >= ? AND (
             (? != '' AND thread_id = ?) OR (? != '' AND lower(COALESCE(in_reply_to,'')) LIKE ?) OR (? != '' AND lower(COALESCE(references_txt,'')) LIKE ?) OR (? != '' AND norm_subject = ?)
           ) ORDER BY date ASC LIMIT 60`
        )
        .all(since, f.threadId ?? '', f.threadId ?? '', h, `%${h}%`, h, `%${h}%`, norm.length >= 2 ? norm : '', norm) as any[]
      for (const row of cands) {
        const how = matchReply({ ...f, to: f.to }, this.incoming(row), mine)
        if (!how) continue
        const next = this.markReplied(rec, row, how)
        if (next) out.push(next)
        break
      }
    }
    void now
    return out
  }

  // ---------------------------------------------------------------- 到期检查（每小时）

  /** 起草下一封催促：AI 可用时用 AI（后台调用走用量闸门），否则 / 失败时用模板；存为本地草稿，不发送 */
  private async composeNudge(rec: FollowupRec, useAi: boolean): Promise<{ subject: string; html: string; by: 'ai' | 'template' }> {
    const d = rec.data
    const now = Date.now()
    const attempt = (d.attempts ?? 0) + 1
    const toName = d.to[0] ? this.whoOf(d) : null
    if (useAi && aiReady(this.deps.getAISettings(), false)) {
      const sent = d.sentMessageId ? this.deps.store.getMessageRow(d.sentMessageId) : null
      const body = sent ? String(sent.text || sent.snippet || '').slice(0, 1500) : ''
      const user =
        `原邮件主题：${d.subject}\n发出时间：${d.sentAt ? new Date(d.sentAt).toLocaleDateString('zh-CN') : '未知'}\n收件人：${toName ?? d.to.join('、')}\n` +
        `在等对方：${d.ask}\n这是第 ${attempt} 封催促（之前已催 ${d.nudgesSent ?? 0} 次），今天是 ${new Date(now).toLocaleDateString('zh-CN')}\n` +
        (body ? `原邮件正文：\n${body}` : '')
      const ask = (extra: string) =>
        this.deps.ai.complete(
          [
            { role: 'system', content: FOLLOWUP_NUDGE + (extra ? `\n\n${extra}` : '') },
            { role: 'user', content: user }
          ],
          900
        )
      try {
        let parsed: any
        try {
          parsed = jsonFromText(await ask(''))
        } catch (err) {
          if (err instanceof Error && err.name === 'BudgetError') throw err
          parsed = jsonFromText(await ask(JSON_RETRY_NUDGE))
        }
        const text = String(parsed?.body ?? '').trim()
        if (text) {
          const s = String(parsed?.subject ?? '').trim() || `回复：${d.subject}`
          return { subject: s, html: /<p[\s>]/i.test(text) ? text : textToHtml(text), by: 'ai' }
        }
      } catch (err) {
        console.warn('[followups] AI nudge failed, using template:', err instanceof Error ? err.message : err)
      }
    }
    const t = nudgeTemplate({ kind: d.kind, ask: d.ask, subject: d.subject, sentAt: d.sentAt, attempt, toName: toName && !toName.includes('@') ? toName : null, now })
    return { subject: t.subject, html: textToHtml(t.text), by: 'template' }
  }

  private saveNudgeDraft(rec: FollowupRec, n: { subject: string; html: string }): string {
    const { store } = this.deps
    const d = rec.data
    const accounts = store.listAccounts()
    const accountId = (d.accountId && accounts.some(a => a.id === d.accountId) ? d.accountId : null) ?? accounts.find(a => a.enabled)?.id ?? accounts[0]?.id
    if (!accountId) throw new Error('还没有添加邮件账户')
    const id = `fu-nudge-${randomUUID()}`
    store.saveDraft({ id, accountId, to: d.to.map(a => ({ address: a })), cc: [], bcc: [], subject: n.subject, html: n.html, updatedAt: Date.now() })
    this.deps.event({ type: 'outbox-changed' })
    return id
  }

  async check(now: number, opts: { aiAllowed: boolean }): Promise<CheckResult> {
    const out: CheckResult = { overdue: [], nudged: [], replied: [], checked: 0 }
    out.replied = this.reconcile(now)
    for (let rec of this.rows()) {
      if (!isActive(rec.data.status)) continue
      out.checked++
      // 起草了但没发出、草稿也没存下（Agent 打开的撰写窗一字未改就关了）：24 小时后取消，免得一直挂着；
      // 存了草稿的一直保留（用户可能还会回来发；删草稿时 outbox 事件会取消它）
      if (rec.data.status === 'drafted') {
        if (now - rec.createdAt > DAY_MS && !this.draftExists(rec.data.draftId)) {
          const next = this.apply(rec, { type: 'cancel', at: now })
          if (next) {
            logActivity({
              source: next.data.source === 'skill' ? 'skill' : next.data.source === 'agent' ? 'chat' : 'job',
              title: `已取消跟进：${subj(next.data.subject)}`,
              detail: '起草后一直没有发出、也没有存草稿（撰写窗未保存就关了），24 小时后自动取消；需要的话可以重新起草',
              refs: this.refs(next)
            })
          }
        }
        continue
      }
      const due = this.apply(rec, { type: 'due', at: now })
      if (due) {
        rec = due
        out.overdue.push(rec)
        const n = overdueDays(rec.dueAt, now)
        logActivity({ source: 'job', title: `已 ${waitedDays(rec.data.sentAt, now)} 天没回：${subj(rec.data.subject)}`, detail: `在等：${rec.data.ask}${n > 1 ? `（已逾期 ${n} 天）` : ''}`, refs: this.refs(rec) })
      }
      if (rec.data.status !== 'overdue') continue
      if (shouldNotifyOverdue(rec.data, rec.dueAt)) {
        this.deps.notify(`已 ${waitedDays(rec.data.sentAt, now)} 天没回：${subj(rec.data.subject)}`, `在等${rec.data.to[0] ? ` ${this.whoOf(rec.data)} ` : ''}${rec.data.ask}`, rec.id)
        rec = this.save(rec, { data: { ...rec.data, notifiedDueAt: rec.dueAt }, dueAt: rec.dueAt })
      }
      if (shouldAutoNudge(rec.data, this.draftExists(rec.data.nudgeDraftId))) {
        try {
          const n = await this.composeNudge(rec, opts.aiAllowed)
          const draftId = this.saveNudgeDraft(rec, n)
          const next = this.apply(rec, { type: 'nudged', at: now, draftId })
          if (next) {
            out.nudged.push(next)
            logActivity({
              source: 'job',
              title: `已起草第 ${next.data.attempts} 封催促（未发送）：${subj(next.data.subject)}`,
              detail: `${n.by === 'ai' ? 'AI 起草' : '按模板起草'}；在「等待对方」里点「再催一封」检查后自己发送`,
              refs: this.refs(next)
            })
          }
        } catch (err) {
          console.error('[followups] nudge draft failed:', err)
        }
      }
    }
    return out
  }

  // ---------------------------------------------------------------- 再催一封（界面 / IPC）

  private draftRow(id: string): any | null {
    return (this.deps.store.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as any) ?? null
  }

  private openDraft(rec: FollowupRec, draftId: string, extra: Record<string, unknown> = {}) {
    const r = this.draftRow(draftId)
    if (!r) return false
    const d = rec.data
    this.deps.openCompose({
      id: r.id,
      accountId: r.account_id,
      to: addrList(r.to_json),
      cc: addrList(r.cc_json),
      bcc: addrList(r.bcc_json),
      subject: r.subject ?? '',
      html: r.html ?? '',
      ...(d.sentHeaderId ? { inReplyToMessageId: d.sentHeaderId } : {}),
      followup: { id: rec.id, enabled: true, kind: d.kind, ask: d.ask, waitDays: d.waitDays } satisfies ComposeFollowup,
      ...extra
    })
    return true
  }

  /** 打开撰写窗：已有催促草稿就打开它；drafted 打开那封草稿；否则现起草一封（不发送） */
  async nudge(id: string): Promise<{ ok: boolean; error?: string }> {
    let rec = this.get(id)
    if (!rec) return { ok: false, error: '跟进不存在' }
    const d = rec.data
    if (d.status === 'drafted') {
      const related = d.relatedMessageId ? this.deps.store.getMessageRow(d.relatedMessageId) : null
      const replyExtra = related ? { relatedMessageId: related.id, ...(related.message_id ? { inReplyToMessageId: related.message_id } : {}) } : {}
      if (d.draftId && this.openDraft(rec, d.draftId, replyExtra)) return { ok: true }
      if (related) {
        this.deps.openCompose({
          ...(d.draftId ? { id: d.draftId } : {}),
          accountId: related.account_id,
          to: d.to.map(a => ({ address: a })),
          subject: d.subject,
          ...replyExtra,
          followup: { id: rec.id, enabled: true, kind: d.kind, ask: d.ask, waitDays: d.waitDays } satisfies ComposeFollowup
        })
        return { ok: true }
      }
      return { ok: false, error: '草稿已不在了' }
    }
    if (d.nudgeDraftId && this.openDraft(rec, d.nudgeDraftId)) return { ok: true }
    try {
      const n = await this.composeNudge(rec, true)
      const draftId = this.saveNudgeDraft(rec, n)
      const now = Date.now()
      rec = this.apply(rec, { type: 'nudged', at: now, draftId }) ?? this.save(rec, { data: { ...rec.data, nudgeDraftId: draftId, attempts: (rec.data.attempts ?? 0) + 1, lastNudgeAt: now }, dueAt: rec.dueAt })
      logActivity({ source: 'job', title: `已起草第 ${rec.data.attempts} 封催促（未发送）：${subj(rec.data.subject)}`, detail: n.by === 'ai' ? 'AI 起草，已打开撰写窗' : '按模板起草，已打开撰写窗', refs: this.refs(rec) })
      this.openDraft(rec, draftId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
