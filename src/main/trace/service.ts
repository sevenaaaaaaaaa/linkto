/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto'
import type { Address, AgentRef, AISettings, ComposeFollowup, TodoData } from '@shared/types'
import type { TraceUpdatePatch } from '@shared/ipc'
import {
  agreementLine, buildConfirmEmail, chatToText, classifyReply, emptyLinks, explicitDateOf, isTraceStatus, materialsText, summaryFromAi,
  templateSummary, traceTransition, TRACE_MATERIAL_LABEL, TRACE_CHANNEL_LABEL, fmtTraceTime,
  type TraceConfirm, type TraceData, type TraceInput, type TraceLinks, type TraceMaterial, type TraceParty, type TraceRecord, type TraceStatus, type TraceSummary
} from '@shared/trace'
import type { MailStore } from '../db'
import type { AIService } from '../ai/service'
import { aiReady, isLocalEndpoint } from '../ai/service'
import { JSON_RETRY_NUDGE, TRACE_ORGANIZE } from '../ai/prompts'
import { htmlToText } from '../agent/protocol'
import { logActivity, registerFollowup } from '../agent/hooks'
import { followupService } from '../followups'
import { allowsAI } from '../attachments/access'
import { commitVersion, newTraceData, normMaterial, verifyRecord, type ContentPatch } from './core'

/**
 * 留痕主进程服务：insights kind='trace'（data = TraceData；title = 标题；status open / dismissed（删除墓碑））。
 *  - 新建 / 修改：内容改动经 commitVersion 留历史版本并重算 SHA-256
 *  - 整理：AI（用户主动触发，不走后台用量闸门；结果再过 validateSummary 防编造）或模板摘录
 *  - 书面确认：起草邮件（存本地草稿 + 打开撰写窗，绝不自动发送）→ registerFollowup(kind=reply)
 *    → 发出后跟进转 waiting → 对方回信（跟进 replied）→ 判断确认 / 异议 → 确认则结束跟进
 */

export interface TraceDeps {
  store: MailStore
  ai: AIService
  getAISettings(): AISettings
  event(payload: unknown): void
  openCompose(prefill: Record<string, unknown>): void
  /** 生成待办后通知待办跨设备 / 外部同步 */
  onTodosChanged?(id: string): void
  /** 本地留痕有改动（跨设备同步防抖推送） */
  onLocalChange?(id: string): void
  /** 系统通知（对方有异议时；受通知设置约束，由注册方实现） */
  notify?(title: string, body: string, id: string): void
  device?(): string | null
}

const REPLY_BODY_WAIT_MS = 30 * 60_000
const MAX_AI_CHARS = 14_000

function jsonFromText(text: string): unknown {
  const s = String(text ?? '').replace(/```(?:json)?/gi, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('AI 没有返回 JSON')
  return JSON.parse(s.slice(a, b + 1))
}

const uniq = <T>(list: T[]) => [...new Set(list)]

export class TraceService {
  constructor(private deps: TraceDeps) {}

  // ---------------------------------------------------------------- 读

  private toRecord(r: any): TraceRecord & { deleted: boolean; accountId: string | null } {
    let data: TraceData
    try {
      data = JSON.parse(r.data_json || '{}')
    } catch {
      data = {} as TraceData
    }
    data.parties ??= []
    data.materials ??= []
    data.summary ??= null
    data.links = { ...emptyLinks(), ...(data.links ?? {}) }
    data.confirm ??= null
    data.versions ??= []
    data.status = isTraceStatus(data.status) ? data.status : 'draft'
    data.channel ??= 'other'
    data.hashAlgo ??= 'sha256'
    data.createdAt ??= Number(r.created_at) || 0
    return { id: r.id, title: r.title ?? '', createdAt: data.createdAt, data, deleted: r.status === 'dismissed', accountId: r.account_id ?? null }
  }

  rows(includeDeleted = false) {
    const list = this.deps.store.db.prepare("SELECT * FROM insights WHERE kind = 'trace' ORDER BY created_at DESC").all() as any[]
    return list.map(r => this.toRecord(r)).filter(r => includeDeleted || !r.deleted)
  }

  get(id: string, includeDeleted = false) {
    const r = this.deps.store.db.prepare("SELECT * FROM insights WHERE id = ? AND kind = 'trace'").get(id) as any
    if (!r) return null
    const rec = this.toRecord(r)
    return rec.deleted && !includeDeleted ? null : rec
  }

  /** 界面列表：按发生时间（没有就按记录时间）倒序 */
  list(): TraceRecord[] {
    return this.rows()
      .map(({ id, title, createdAt, data }) => ({ id, title, createdAt, data }))
      .sort((a, b) => (b.data.occurredAt ?? b.createdAt) - (a.data.occurredAt ?? a.createdAt))
  }

  // ---------------------------------------------------------------- 身份

  myAddrs(): Set<string> {
    const set = new Set<string>()
    for (const a of this.deps.store.listAccounts()) {
      if (a.email) set.add(a.email.toLowerCase())
      if (a.user?.includes('@')) set.add(a.user.toLowerCase())
    }
    return set
  }

  private markMe(parties: TraceParty[]): TraceParty[] {
    const mine = this.myAddrs()
    return parties.map(p => (p.email && mine.has(p.email.toLowerCase()) ? { ...p, me: true } : p))
  }

  private accountFor(r: { accountId?: string | null; data: TraceData } | null): string | null {
    const accounts = this.deps.store.listAccounts()
    const fromMsg = r?.data.links.messageIds.map(m => this.deps.store.getMessageRow(m)?.account_id).find(Boolean)
    if (fromMsg && accounts.some(a => a.id === fromMsg)) return fromMsg
    if (r?.accountId && accounts.some(a => a.id === r.accountId)) return r.accountId
    return (accounts.find(a => a.enabled) ?? accounts[0])?.id ?? null
  }

  // ---------------------------------------------------------------- 写

  private changed(id?: string) {
    this.deps.event({ type: 'trace-changed', id: id ?? null })
    if (id) this.deps.onLocalChange?.(id)
  }

  /** 整条写回（data 全量覆盖各键；updatedAt 由调用方给出） */
  private save(id: string, title: string, data: TraceData, now = Date.now()) {
    this.deps.store.updateInsight(id, { title, data: { ...data, updatedAt: now } as unknown as Record<string, unknown> })
  }

  create(input: TraceInput, accountId: string | null = null): string {
    const now = Date.now()
    const { title, data } = newTraceData({ ...input, parties: this.markMe(input.parties ?? []) }, now)
    data.device = this.deps.device?.() ?? null
    const id = `trace-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    let acct = accountId
    if (!acct && data.links.messageIds[0]) acct = this.deps.store.getMessageRow(data.links.messageIds[0])?.account_id ?? null
    this.deps.store.insertInsight({ id, kind: 'trace', accountId: acct, messageId: data.links.messageIds[0] ?? null, title, data: data as unknown as Record<string, unknown>, dueAt: null })
    logActivity({ source: data.source === 'agent' ? 'chat' : 'job', title: `已记一笔留痕：${title}`, detail: `${TRACE_CHANNEL_LABEL[data.channel]} · ${fmtTraceTime(data.occurredAt)} · 内容哈希 ${data.hash.slice(0, 12)}…`, refs: [this.ref(id, title)] })
    this.changed(id)
    return id
  }

  ref(id: string, title: string): AgentRef {
    return { type: 'trace', id, label: title }
  }

  update(id: string, patch: TraceUpdatePatch, reason = '修改'): { ok: boolean; error?: string } {
    const r = this.get(id)
    if (!r) return { ok: false, error: '留痕不存在' }
    const now = Date.now()
    const content: ContentPatch = {}
    if (patch.title !== undefined) content.title = patch.title
    if (patch.channel !== undefined) content.channel = patch.channel
    if (patch.occurredAt !== undefined) content.occurredAt = patch.occurredAt == null || !Number.isFinite(Number(patch.occurredAt)) ? null : Number(patch.occurredAt)
    if (patch.parties !== undefined) content.parties = this.markMe((patch.parties ?? []).filter(p => p && (p.name || p.email)).map(p => ({ name: String(p.name || String(p.email ?? '').split('@')[0]).slice(0, 40), email: p.email ? String(p.email).toLowerCase() : null, ...(p.me ? { me: true } : {}) })))
    if (patch.summary !== undefined) content.summary = patch.summary ? { ...patch.summary, by: patch.summary.by ?? 'manual', at: now } : null
    if (patch.addMaterials?.length || patch.removeMaterialIds?.length) {
      const drop = new Set(patch.removeMaterialIds ?? [])
      const added = (patch.addMaterials ?? []).map(m => normMaterial(m, now)).filter((m): m is TraceMaterial => !!m)
      content.materials = [...r.data.materials.filter(m => !drop.has(m.id)), ...added]
    }
    let title = r.title
    let data = r.data
    if (Object.keys(content).length) {
      const res = commitVersion(r.title, r.data, content, reason, now)
      title = res.title
      data = res.data
      // 整理结果 / 材料改了：已确认 / 有异议的需要重新确认
      if (res.changed && (content.summary !== undefined || content.materials !== undefined)) data = { ...data, status: traceTransition(data.status, { type: 'edited' }) ?? data.status }
    }
    if (patch.status && isTraceStatus(patch.status)) data = { ...data, status: traceTransition(data.status, { type: 'set', status: patch.status }) ?? data.status }
    if (patch.link || patch.unlink) {
      const links: TraceLinks = { ...data.links }
      for (const k of Object.keys(links) as (keyof TraceLinks)[]) {
        const add = (patch.link?.[k] ?? []).map(String)
        const del = new Set((patch.unlink?.[k] ?? []).map(String))
        links[k] = uniq([...links[k], ...add]).filter(x => !del.has(x))
      }
      data = { ...data, links }
    }
    this.save(id, title, data, now)
    this.changed(id)
    return { ok: true }
  }

  /** 删除 = 墓碑（跨设备同步可传播；关联邮件不会再自动建） */
  remove(id: string) {
    const r = this.get(id)
    if (!r) return
    this.deps.store.updateInsight(id, { status: 'dismissed' })
    this.changed(id)
  }

  // ---------------------------------------------------------------- 整理

  aiAvailable(): { ai: boolean; aiReason: string | null; cloud: boolean; cloudAllowed: boolean } {
    const s = this.deps.getAISettings()
    const ok = aiReady(s)
    const cloud = !(s.baseURL === 'builtin-local' || isLocalEndpoint(s.baseURL))
    return { ai: ok, aiReason: ok ? null : '还没有配置 AI（设置 → AI），可以先按模板整理', cloud, cloudAllowed: allowsAI(s.baseURL) }
  }

  private materialsForAi(materials: TraceMaterial[]): { text: string; used: TraceMaterial[]; excluded: number } {
    const s = this.deps.getAISettings()
    const cloud = !(s.baseURL === 'builtin-local' || isLocalEndpoint(s.baseURL))
    // 截图识字来自图片内容：发给云端 AI 需要「附件内容发给云端 AI」授权（本地模型不受限）
    const used = materials.filter(m => !(m.kind === 'ocr' && cloud && !allowsAI(s.baseURL)))
    const parts: string[] = []
    let total = 0
    for (const m of used) {
      const head = `【${TRACE_MATERIAL_LABEL[m.kind]}${m.label ? ` · ${m.label}` : ''}${m.fileName ? ` · ${m.fileName}` : ''}】`
      const body = m.kind === 'chat' && m.lines?.length ? chatToText(m.lines) : m.text
      const room = MAX_AI_CHARS - total
      if (room <= 200) break
      const piece = `${head}\n${body.slice(0, room)}`
      parts.push(piece)
      total += piece.length
    }
    return { text: parts.join('\n\n'), used, excluded: materials.length - used.length }
  }

  async organize(id: string, mode: 'ai' | 'template'): Promise<{ ok: boolean; by?: 'ai' | 'template'; error?: string; warnings?: string[]; excluded?: number }> {
    const r = this.get(id)
    if (!r) return { ok: false, error: '留痕不存在' }
    if (!r.data.materials.length) return { ok: false, error: '还没有原始材料：先粘贴聊天记录、截图或写几句备注' }
    const now = Date.now()
    const warn: string[] = []
    if (mode === 'ai' && !aiReady(this.deps.getAISettings())) {
      mode = 'template'
      warn.push('AI 未配置，已按模板整理')
    }
    if (mode === 'template') {
      const summary = templateSummary(r.data.materials, now)
      const extra: ContentPatch = {}
      // 占位标题：用第一条约定（或第一句原话）起个标题
      if (/^未命名留痕$|^记一笔/.test(r.title) || !r.title.trim()) {
        const first = summary.agreements[0]?.what ?? r.data.materials[0]?.lines?.[0]?.text ?? r.data.materials[0]?.text ?? ''
        const t = first.split('\n')[0].replace(/^[-*•·\d.、)\s]+/, '').trim().slice(0, 24)
        if (t) extra.title = t
      }
      this.applySummary(r, summary, '按模板整理', extra)
      return { ok: true, by: 'template', warnings: warn }
    }
    const { text, used, excluded } = this.materialsForAi(r.data.materials)
    if (!used.length) return { ok: false, error: '截图识字的内容还没有被允许发给云端 AI（设置 → 附件与存储 → 附件内容读取），可以改用「按模板整理」', excluded }
    const me = r.data.parties.filter(p => p.me).map(p => p.name)
    const others = r.data.parties.filter(p => !p.me).map(p => `${p.name}${p.email ? ` <${p.email}>` : ''}`)
    const user = [
      `场景：${TRACE_CHANNEL_LABEL[r.data.channel]}`,
      `发生时间：${r.data.occurredAt ? fmtTraceTime(r.data.occurredAt) : '未记录'}`,
      `用户本人：${me.join('、') || '（材料里的「我」）'}`,
      `其他参与人：${others.join('、') || '（看材料）'}`,
      `用户写的标题：${r.title}`,
      '',
      '材料：',
      text
    ].join('\n')
    const messages = [
      { role: 'system' as const, content: TRACE_ORGANIZE },
      { role: 'user' as const, content: user }
    ]
    let json: unknown
    try {
      const out = await this.deps.ai.complete(messages, 1600)
      try {
        json = jsonFromText(out)
      } catch {
        const retry = await this.deps.ai.complete([...messages, { role: 'assistant' as const, content: out }, { role: 'user' as const, content: JSON_RETRY_NUDGE }], 1600)
        json = jsonFromText(retry)
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const res = summaryFromAi(json, materialsText(used), now)
    const summary: TraceSummary = { ...res.summary, warnings: [...(res.summary.warnings ?? []), ...(excluded ? [`${excluded} 份截图识字没有发给云端 AI（未授权），整理结果不含其中内容`] : [])] }
    const extra: ContentPatch = {}
    if (res.title && (/^未命名留痕$|^记一笔/.test(r.title) || !r.title.trim())) extra.title = res.title
    if (r.data.occurredAt == null && res.occurredAt) extra.occurredAt = res.occurredAt
    // AI 认出的参与人（材料里的称呼）补进来，不覆盖已有的邮箱
    const known = new Set(r.data.parties.map(p => p.name))
    const addParties = res.parties.filter(n => n && n !== '我' && !known.has(n)).map(n => ({ name: n }))
    if (addParties.length) extra.parties = [...r.data.parties, ...addParties].slice(0, 12)
    this.applySummary(r, summary, 'AI 整理', extra)
    return { ok: true, by: 'ai', warnings: [...warn, ...(summary.warnings ?? [])], excluded }
  }

  private applySummary(r: NonNullable<ReturnType<TraceService['get']>>, summary: TraceSummary, reason: string, extra: ContentPatch) {
    const now = Date.now()
    const res = commitVersion(r.title, r.data, { ...extra, summary }, reason, now)
    const status = traceTransition(res.data.status, { type: 'organized' }) ?? (res.changed ? traceTransition(res.data.status, { type: 'edited' }) : null) ?? res.data.status
    this.save(r.id, res.title, { ...res.data, status }, now)
    this.changed(r.id)
  }

  // ---------------------------------------------------------------- 书面确认

  private draftRow(id: string | null | undefined): any | null {
    if (!id) return null
    return (this.deps.store.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as any) ?? null
  }

  async confirmDraft(id: string, opts: { to?: string[]; waitDays?: number; open?: boolean } = {}): Promise<{ ok: boolean; error?: string; draftId?: string; followupId?: string | null; reopened?: boolean }> {
    const open = opts.open === false ? () => {} : this.deps.openCompose
    let r = this.get(id)
    if (!r) return { ok: false, error: '留痕不存在' }
    const waitDays = Math.max(1, Math.min(14, Math.round(Number(opts.waitDays) || 3)))
    const c = r.data.confirm
    // 已起草还没发出：直接打开那封草稿
    if (c && !c.sentAt && this.draftRow(c.draftId)) {
      const d = this.draftRow(c.draftId)
      const addr = (json: string | null) => {
        try {
          return JSON.parse(json ?? '[]')
        } catch {
          return []
        }
      }
      open({
        id: d.id,
        accountId: d.account_id,
        to: addr(d.to_json),
        cc: addr(d.cc_json),
        bcc: addr(d.bcc_json),
        subject: d.subject ?? '',
        html: d.html ?? '',
        ...(c.followupId ? { followup: { id: c.followupId, enabled: true, kind: 'reply', ask: this.askOf(r.title), waitDays } satisfies ComposeFollowup } : {})
      })
      return { ok: true, draftId: d.id, followupId: c.followupId, reopened: true }
    }
    if (!r.data.materials.length && !r.data.summary) return { ok: false, error: '还没有内容：先记下沟通的原始材料并整理' }
    if (!r.data.summary) {
      // 没整理过：先按模板摘一版（用户在撰写窗里可以改）
      this.applySummary(r, templateSummary(r.data.materials), '起草确认前按模板整理', {})
      r = this.get(id)!
    }
    const accountId = this.accountFor(r)
    if (!accountId) return { ok: false, error: '还没有添加邮件账户' }
    const mine = this.myAddrs()
    const to = uniq((opts.to?.length ? opts.to : r.data.parties.filter(p => !p.me && p.email).map(p => p.email!)).map(a => a.trim().toLowerCase()).filter(a => a.includes('@') && !mine.has(a)))
    const me = r.data.parties.find(p => p.me)?.name ?? null
    const mail = buildConfirmEmail({ title: r.title, channel: r.data.channel, occurredAt: r.data.occurredAt, parties: r.data.parties, summary: r.data.summary, myName: me })
    const now = Date.now()
    const draftId = `trace-confirm-${randomUUID()}`
    const toAddr: Address[] = to.map(a => {
      const p = r!.data.parties.find(x => x.email?.toLowerCase() === a)
      return p?.name ? { name: p.name, address: a } : { address: a }
    })
    this.deps.store.saveDraft({ id: draftId, accountId, to: toAddr, cc: [], bcc: [], subject: mail.subject, html: mail.html, updatedAt: now })
    this.deps.event({ type: 'outbox-changed' })
    const ask = this.askOf(r.title)
    const followupId = registerFollowup({ kind: 'reply', ask, to, subject: mail.subject, relatedMessageId: r.data.links.messageIds[0] ?? null, draftId, waitDays, source: 'manual' })
    const confirm: TraceConfirm = { followupId, draftId, to, subject: mail.subject, draftedAt: now, sentAt: null, replyMessageId: null, replyAt: null, verdict: null, evidence: [] }
    const history = c ? [...(r.data.confirmHistory ?? []), c].slice(-10) : r.data.confirmHistory
    const data: TraceData = {
      ...r.data,
      confirm,
      ...(history ? { confirmHistory: history } : {}),
      links: { ...r.data.links, followupIds: uniq([...r.data.links.followupIds, ...(followupId ? [followupId] : [])]) },
      status: traceTransition(r.data.status, { type: 'confirm-drafted' }) ?? r.data.status
    }
    this.save(id, r.title, data, now)
    this.changed(id)
    open({
      id: draftId,
      accountId,
      to: toAddr,
      subject: mail.subject,
      html: mail.html,
      ...(followupId ? { followup: { id: followupId, enabled: true, kind: 'reply', ask, waitDays } satisfies ComposeFollowup } : {})
    })
    return { ok: true, draftId, followupId }
  }

  private askOf(title: string) {
    return `对方确认「${title}」约定`.slice(0, 120)
  }

  /**
   * 对账书面确认：跟进转 waiting（已发出）→ 已发确认；跟进 replied（对方回信）→ 读回信判断确认 / 异议。
   * 确认 → 结束跟进；异议 → 保留跟进、通知用户查看。返回有变化的条数。
   */
  checkConfirmations(now = Date.now()): number {
    const fs = followupService()
    if (!fs) return 0
    let changed = 0
    for (const r of this.rows()) {
      const c0 = r.data.confirm
      if (!c0?.followupId || c0.verdict) continue
      const fu = fs.get(c0.followupId)
      if (!fu) continue
      const st = fu.data.status
      const c: TraceConfirm = { ...c0 }
      let status: TraceStatus = r.data.status
      let links = r.data.links
      let dirty = false
      if (!c.sentAt && (fu.data.sentAt || st === 'waiting' || st === 'overdue' || st === 'replied')) {
        c.sentAt = fu.data.sentAt ?? now
        status = traceTransition(status, { type: 'confirm-sent' }) ?? status
        dirty = true
        logActivity({ source: 'job', title: `已发出书面确认：${r.title}`, detail: `等对方回复确认；${fu.data.waitDays} 天没回会提醒你`, refs: [this.ref(r.id, r.title), { type: 'followup', id: fu.id, label: fu.data.subject }] })
      }
      const replyId = fu.data.repliedMessageId
      if (replyId && (st === 'replied' || st === 'closed')) {
        const row = this.deps.store.getMessageRow(replyId)
        if (row) {
          const body = String(row.text || (row.html ? htmlToText(row.html) : '') || '')
          const waitBody = !body.trim() && !row.body_fetched && now - (fu.data.repliedAt ?? now) < REPLY_BODY_WAIT_MS
          if (!waitBody) {
            const verdict = classifyReply(body.trim() ? body : String(row.snippet ?? ''))
            c.replyMessageId = replyId
            c.replyAt = Number(row.date) || now
            c.verdict = verdict.verdict
            c.evidence = verdict.matched
            if (status !== 'sent') status = 'sent'
            status = traceTransition(status, { type: 'reply', verdict: verdict.verdict }) ?? status
            links = { ...links, messageIds: uniq([...links.messageIds, replyId]) }
            dirty = true
            const who = row.from_name || row.from_addr || '对方'
            if (verdict.verdict === 'confirmed') {
              if (st === 'replied') fs.update(fu.id, { status: 'closed' })
              logActivity({ source: 'job', title: `${who} 已书面确认：${r.title}`, detail: verdict.matched.length ? `回信里写了：${verdict.matched.join('、')}` : '对方已回信，没有提出异议', refs: [this.ref(r.id, r.title), { type: 'mail', id: replyId, label: String(row.subject ?? '回信') }] })
            } else {
              logActivity({ source: 'job', title: `${who} 对「${r.title}」有异议，请查看回信`, detail: `回信里提到：${verdict.matched.join('、')}`, refs: [this.ref(r.id, r.title), { type: 'mail', id: replyId, label: String(row.subject ?? '回信') }] })
              this.deps.notify?.(`对方对「${r.title}」有异议`, `${who} 回信提到：${verdict.matched.join('、')}。点开查看回信并修改留痕。`, r.id)
            }
          }
        }
      }
      if (!dirty) continue
      this.save(r.id, r.title, { ...r.data, confirm: c, status, links }, now)
      this.deps.onLocalChange?.(r.id)
      changed++
    }
    if (changed) this.deps.event({ type: 'trace-changed', id: null })
    return changed
  }

  // ---------------------------------------------------------------- 从邮件记为留痕

  fromMessage(messageId: string): { id: string | null; created: boolean } {
    const existing = this.rows().find(r => r.data.links.messageIds.includes(messageId) || r.data.materials.some(m => m.messageId === messageId))
    if (existing) return { id: existing.id, created: false }
    const m = this.deps.store.getMessageFull(messageId)
    if (!m) return { id: null, created: false }
    const mine = this.myAddrs()
    const seen = new Set<string>()
    const parties: TraceParty[] = []
    for (const a of [m.from, ...(m.to ?? []), ...(m.cc ?? [])]) {
      if (!a?.address) continue
      const addr = a.address.toLowerCase()
      if (seen.has(addr) || mine.has(addr)) continue
      seen.add(addr)
      parties.push({ name: a.name || addr.split('@')[0], email: addr })
    }
    const body = (m.text || (m.html ? htmlToText(m.html) : '') || m.snippet || '').trim()
    const from = m.from ? `${m.from.name ? `${m.from.name} ` : ''}<${m.from.address}>` : '（未知）'
    const text = `发件人：${from}\n时间：${fmtTraceTime(m.date)}\n主题：${m.subject || '（无主题）'}\n\n${body}`.slice(0, 20_000)
    const id = this.create(
      {
        title: (m.subject || '邮件留痕').replace(/^(回复|答复|re|fw|fwd|转发)\s*[:：]\s*/i, '').slice(0, 60),
        channel: 'other',
        occurredAt: m.date,
        parties: parties.slice(0, 8),
        materials: [{ kind: 'mail', text, label: m.from?.name || m.from?.address || '邮件', messageId }],
        messageIds: [messageId],
        source: 'mail'
      },
      m.accountId
    )
    return { id, created: true }
  }

  // ---------------------------------------------------------------- 待办 / 记忆

  makeTodo(id: string, index: number | null = null): string | null {
    const r = this.get(id)
    if (!r) return null
    const a = index != null ? r.data.summary?.agreements[index] ?? null : null
    if (index != null && !a) return null
    const todoId = `todo-trace-${id}-${index ?? 'all'}`.slice(0, 160)
    const exists = this.deps.store.getInsight(todoId)
    if (exists && exists.status !== 'dismissed') return todoId
    const now = Date.now()
    const title = (a ? `${a.who && a.who !== '我' ? `${a.who}：` : ''}${a.what}` : `留痕跟进：${r.title}`).slice(0, 120)
    const due = a ? explicitDateOf(a.when, r.data.occurredAt ?? r.createdAt) : null
    const data: TodoData = {
      from: 'trace',
      todoKind: 'task',
      minutes: 15,
      priority: 2,
      notes: [`来自留痕：${r.title}`, a ? agreementLine(a) : '', a?.quote ? `原文：${a.quote}` : '', `发生：${fmtTraceTime(r.data.occurredAt)} · ${TRACE_CHANNEL_LABEL[r.data.channel]}`].filter(Boolean).join('\n'),
      tags: ['留痕'],
      updatedAt: now
    }
    this.deps.store.insertInsight({ id: todoId, kind: 'todo', accountId: this.accountFor(r), messageId: r.data.links.messageIds[0] ?? null, title, data: data as Record<string, unknown>, dueAt: due })
    this.deps.store.updateInsight(todoId, { status: 'open' })
    this.save(id, r.title, { ...r.data, links: { ...r.data.links, todoIds: uniq([...r.data.links.todoIds, todoId]) } }, now)
    this.deps.event({ type: 'todos-changed' })
    this.deps.onTodosChanged?.(todoId)
    this.changed(id)
    return todoId
  }

  /** 把一条约定记进 Agent 记忆（scope=commitment）；由用户在界面点击确认后调用 */
  remember(id: string, index: number): { ok: boolean; id?: string; error?: string } {
    const r = this.get(id)
    const a = r?.data.summary?.agreements[index]
    if (!r || !a) return { ok: false, error: '找不到这条约定' }
    const mineSide = a.who === '我' || r.data.parties.some(p => p.me && p.name === a.who)
    const party = r.data.parties.find(p => p.name === a.who && !p.me) ?? r.data.parties.find(p => !p.me && p.email)
    const m = this.deps.store.upsertMemory({
      scope: 'commitment',
      entity: (party?.email ?? '').toLowerCase(),
      title: `${mineSide ? '我承诺' : '对方承诺'}：${a.what}`.slice(0, 60),
      content: `${agreementLine(a)}（留痕「${r.title}」，${fmtTraceTime(r.data.occurredAt, false)}${TRACE_CHANNEL_LABEL[r.data.channel]}${r.data.status === 'confirmed' ? '，对方已书面确认' : ''}）`.slice(0, 500),
      source: 'manual',
      confidence: r.data.status === 'confirmed' ? 1 : 0.8
    })
    this.save(id, r.title, { ...r.data, memoryIds: uniq([...(r.data.memoryIds ?? []), m.id]) })
    this.deps.event({ type: 'agent-changed' })
    this.changed(id)
    return { ok: true, id: m.id }
  }

  verify(id: string) {
    const r = this.get(id)
    return r ? verifyRecord(r.title, r.data) : null
  }

  // ---------------------------------------------------------------- 跨设备同步（行级读写）

  listForSync() {
    return (this.deps.store.db.prepare("SELECT * FROM insights WHERE kind = 'trace'").all() as any[]).map(r => {
      let data: Record<string, unknown> = {}
      try {
        data = JSON.parse(r.data_json || '{}')
      } catch {
        data = {}
      }
      return { id: r.id, title: r.title, status: r.status ?? 'open', dueAt: r.due_at ?? null, createdAt: Number(r.created_at) || 0, accountId: r.account_id ?? null, messageId: r.message_id ?? null, data }
    })
  }

  /** 写入远端版本（保留远端的 created_at / status / data.updatedAt） */
  upsertFromSync(t: { id: string; title: string; status: string; dueAt: number | null; createdAt: number; accountId: string | null; messageId: string | null; data: Record<string, unknown> }) {
    this.deps.store.db
      .prepare(
        `INSERT INTO insights (id, kind, account_id, message_id, title, data_json, status, due_at, period, created_at)
         VALUES (?, 'trace', ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, data_json=excluded.data_json, status=excluded.status, due_at=excluded.due_at`
      )
      .run(t.id, t.accountId, t.messageId, t.title, JSON.stringify(t.data), t.status === 'done' ? 'open' : t.status, t.dueAt, t.createdAt)
  }
}
