import { randomUUID } from 'node:crypto'
import type { AISettings, Address, FinanceData, InsightRecord, ProjectData, ProjectStatus, ProjectSuggestion, ProjectSummary, TodoData } from '@shared/types'
import {
  buildTimeline, classifyAttachment, counterpartyKey, decideMatch, domainOf, extractKeywords, isPublicDomain, isRobotAddr,
  normalizeSubject, PROJECT_COLORS, ruleSummary,
  type ContactTimeline, type MatchMessage, type MatchProject, type ProjectAttachment, type ProjectCandidate, type ProjectConversation,
  type ProjectDetail, type ProjectListItem, type ProjectMoneyTotal, type ProjectRecord, type ProjectStats, type TimelineEvent, type TLMessage
} from '@shared/projects'
import { PROJECT_DISCOVER, PROJECT_SUMMARY, JSON_RETRY_NUDGE } from '../ai/prompts'
import type { MailStore } from '../db'
import { aiReady, type AIService } from '../ai/service'

/* eslint-disable @typescript-eslint/no-explicit-any */

const DAY = 86_400_000
/** 列表 / 详情 / 时间线读邮件时不需要正文：只取这些列 */
const COLS = 'm.id, m.account_id, m.folder_id, m.folder_path, m.thread_id, m.message_id, m.from_name, m.from_addr, m.to_json, m.cc_json, m.subject, m.snippet, m.date, m.flags, m.has_attachments, m.category, m.is_newsletter'
const NOT_TRASH = "m.folder_id NOT IN (SELECT id FROM folders WHERE special IN ('trash','junk','drafts'))"

function j<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

function jsonFromText(text: string): any {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('AI 未返回 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

const threadKey = (r: { thread_id?: string | null; id: string }) => (r.thread_id as string) || r.id
const seen = (r: { flags?: string | null }) => String(r.flags ?? '').includes('\\Seen')

/** 域名 → 显示用的公司名：partner.example → Partner */
function domainLabel(domain: string): string {
  const parts = domain.split('.').filter(Boolean)
  const core = parts.length >= 2 ? parts[parts.length - 2] : parts[0] ?? domain
  const pick = ['mail', 'email', 'news', 'notice', 'service'].includes(core) && parts.length >= 3 ? parts[parts.length - 3] : core
  return pick ? pick.charAt(0).toUpperCase() + pick.slice(1) : domain
}

function chunk<T>(list: T[], size = 400): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * 项目：insights 表 kind='project'。
 * - 成员 = threadIds 里的会话 + messageIds 里的单封（会话里后来的邮件自动算进来）
 * - 待办按 TodoData.project（项目名）关联；款项按 FinanceData.projectId 或邮件交集关联（款项由财务模块收集，这里只读）
 * - 自动归并：邮件理解完成后（onInsight）按 同一会话 > 对方 > 关键词 打分，拿不准的进「建议归入」
 */
export class ProjectService {
  /** 已判过归并的邮件（项目有变化时清空重判） */
  private judged = new Set<string>()
  private cache: ProjectRecord[] | null = null
  private summarizing = new Set<string>()

  constructor(
    private deps: {
      store: MailStore
      ai: AIService
      getAISettings(): AISettings
      event(payload: unknown): void
    }
  ) {}

  private get db() {
    return this.deps.store.db
  }

  private changed() {
    this.cache = null
    this.judged.clear()
    this.deps.event({ type: 'projects-changed' })
  }

  private myAddrs(): Set<string> {
    const set = new Set<string>()
    for (const a of this.deps.store.listAccounts()) {
      if (a.email) set.add(a.email.toLowerCase())
      if (a.user?.includes('@')) set.add(a.user.toLowerCase())
    }
    return set
  }

  // ================= 读写 =================

  private rowToRecord(r: any): ProjectRecord {
    const data = j<ProjectData>(r.data_json, {} as ProjectData)
    const fixed: ProjectData = {
      ...data,
      name: data.name || r.title,
      status: data.status || (r.status === 'done' ? 'done' : 'active'),
      counterparties: data.counterparties ?? [],
      keywords: data.keywords ?? [],
      threadIds: data.threadIds ?? [],
      messageIds: data.messageIds ?? [],
      auto: data.auto ?? true
    }
    return { id: r.id, title: r.title, status: r.status === 'done' ? 'done' : 'open', createdAt: r.created_at ?? 0, dueAt: r.due_at ?? null, data: fixed }
  }

  all(): ProjectRecord[] {
    if (!this.cache) {
      const rows = this.db.prepare("SELECT * FROM insights WHERE kind = 'project' ORDER BY created_at DESC").all() as any[]
      this.cache = rows.map(r => this.rowToRecord(r))
    }
    return this.cache
  }

  get(id: string): ProjectRecord | null {
    return this.all().find(p => p.id === id) ?? null
  }

  private write(id: string, data: Partial<ProjectData>, opts: { title?: string; status?: ProjectStatus; dueAt?: number | null } = {}) {
    const patch: { title?: string; status?: string; dueAt?: number | null; data: Record<string, unknown> } = { data: data as Record<string, unknown> }
    if (opts.title !== undefined) patch.title = opts.title
    if (opts.status !== undefined) patch.status = opts.status === 'done' || opts.status === 'archived' ? 'done' : 'open'
    if (opts.dueAt !== undefined) patch.dueAt = opts.dueAt
    this.deps.store.updateInsight(id, patch)
  }

  /** 新建（无 id）或更新；改名时把待办里的项目名一并改过去 */
  save(input: { id?: string | null; data: Partial<ProjectData> }): ProjectRecord {
    const d = input.data ?? {}
    if (input.id) {
      const before = this.get(input.id)
      if (!before) throw new Error('项目不存在')
      const name = d.name?.trim()
      const next: Partial<ProjectData> = { ...d, ...(name ? { name } : {}), updatedAt: Date.now() }
      if (d.counterparties) next.counterparties = uniqLower(d.counterparties)
      if (d.keywords) next.keywords = uniqText(d.keywords)
      this.write(input.id, next, { title: name || undefined, status: d.status, dueAt: d.dueAt === undefined ? undefined : d.dueAt ?? null })
      if (name && name !== before.data.name) this.renameTodos(before.data.name, name)
      const ruleChanged = !!(d.counterparties || d.keywords)
      this.changed()
      if (ruleChanged) this.rescan(input.id)
      return this.get(input.id)!
    }
    const used = new Set(this.all().map(p => p.data.color))
    const color = d.color || PROJECT_COLORS.find(c => !used.has(c.key))?.key || PROJECT_COLORS[this.all().length % PROJECT_COLORS.length].key
    const data: ProjectData = {
      name: (d.name || '未命名项目').trim().slice(0, 60),
      status: d.status ?? 'active',
      color,
      counterparties: uniqLower(d.counterparties ?? []),
      keywords: uniqText(d.keywords ?? []),
      threadIds: [...new Set(d.threadIds ?? [])],
      messageIds: [...new Set(d.messageIds ?? [])],
      members: d.members ?? [],
      budget: d.budget ?? null,
      startedAt: d.startedAt ?? Date.now(),
      dueAt: d.dueAt ?? null,
      auto: d.auto ?? true,
      notes: d.notes ?? null,
      source: d.source ?? 'manual',
      pinned: d.pinned ?? false,
      milestones: d.milestones ?? [],
      suggestions: [],
      excludedThreadIds: [],
      updatedAt: Date.now()
    }
    const id = `project-${randomUUID().slice(0, 8)}`
    this.deps.store.insertInsight({ id, kind: 'project', title: data.name, data: data as unknown as Record<string, unknown>, dueAt: data.dueAt ?? null })
    if (data.status === 'done' || data.status === 'archived') this.deps.store.setInsightStatus(id, 'done')
    this.changed()
    this.rescan(id)
    return this.get(id)!
  }

  remove(id: string) {
    this.deps.store.deleteInsight(id)
    this.changed()
  }

  private renameTodos(from: string, to: string) {
    for (const t of this.deps.store.listTodosForSync()) {
      if ((t.data as TodoData).project === from) this.deps.store.updateInsight(t.id, { data: { project: to } })
    }
    this.deps.event({ type: 'todos-changed' })
  }

  // ================= 成员邮件 =================

  /** 项目里的全部邮件（去掉废纸篓 / 垃圾 / 草稿；同一封在多个文件夹只留一份），新的在前 */
  memberRows(p: ProjectRecord): any[] {
    const threads = p.data.threadIds
    const ids = p.data.messageIds
    if (!threads.length && !ids.length) return []
    const rows: any[] = []
    const seenIds = new Set<string>()
    for (const part of chunk(threads)) {
      const res = this.db.prepare(`SELECT ${COLS} FROM messages m WHERE m.thread_id IN (${part.map(() => '?').join(',')}) AND ${NOT_TRASH}`).all(...part) as any[]
      for (const r of res) if (!seenIds.has(r.id)) (seenIds.add(r.id), rows.push(r))
    }
    for (const part of chunk(ids)) {
      const res = this.db.prepare(`SELECT ${COLS} FROM messages m WHERE m.id IN (${part.map(() => '?').join(',')}) AND ${NOT_TRASH}`).all(...part) as any[]
      for (const r of res) if (!seenIds.has(r.id)) (seenIds.add(r.id), rows.push(r))
    }
    return dedupeByMessageId(rows).sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
  }

  private tlMessages(rows: any[], mine: Set<string>): TLMessage[] {
    const ai = this.deps.store.getMailAi(rows.map(r => r.id))
    return rows.map(r => ({
      id: r.id,
      threadId: threadKey(r),
      date: r.date ?? 0,
      fromAddr: r.from_addr ?? '',
      fromName: r.from_name ?? '',
      // 发给我的：收件人一栏先显示「我」，再列其他收件人
      to: [
        ...(mine.has(String(r.from_addr ?? '').toLowerCase()) ? [] : [{ name: '我', address: '' }]),
        ...[...j<Address[]>(r.to_json, []), ...j<Address[]>(r.cc_json, [])].filter(a => !mine.has(String(a.address ?? '').toLowerCase())).slice(0, 6)
      ],
      subject: r.subject ?? '',
      gist: ai[r.id]?.gist ?? null,
      gistKey: ai[r.id]?.gistKey ?? null,
      fromMe: mine.has(String(r.from_addr ?? '').toLowerCase()),
      unread: !seen(r) && !mine.has(String(r.from_addr ?? '').toLowerCase())
    }))
  }

  private allTodos(): InsightRecord[] {
    return this.deps.store
      .listTodosForSync()
      .filter(t => t.status !== 'dismissed')
      .map(t => ({ id: t.id, kind: 'todo', messageId: t.messageId, accountId: t.accountId, title: t.title, status: t.status as 'open' | 'done', dueAt: t.dueAt, createdAt: t.createdAt, data: t.data }))
  }

  private allFinance(): InsightRecord[] {
    const rows = this.db.prepare("SELECT * FROM insights WHERE kind = 'finance' AND status != 'dismissed'").all() as any[]
    return rows.map(r => ({ id: r.id, kind: 'finance', messageId: r.message_id, accountId: r.account_id, title: r.title, status: r.status, dueAt: r.due_at, createdAt: r.created_at, data: j<Record<string, unknown>>(r.data_json, {}) }))
  }

  private linkedTodos(p: ProjectRecord, memberIds: Set<string>, todos = this.allTodos()) {
    return todos.filter(t => (t.data as TodoData).project === p.data.name || (t.messageId && memberIds.has(t.messageId)))
  }

  private linkedFinance(p: ProjectRecord, memberIds: Set<string>, finance = this.allFinance()) {
    return finance.filter(f => {
      const d = f.data as unknown as FinanceData
      return d.projectId === p.id || (d.messageIds ?? []).some(id => memberIds.has(id)) || (!!f.messageId && memberIds.has(f.messageId))
    })
  }

  private stats(p: ProjectRecord, rows: any[], todos: InsightRecord[], finance: InsightRecord[], mine: Set<string>): ProjectStats {
    const last = rows[0]
    const gist = last ? this.deps.store.getMailAi([last.id])[last.id]?.gist ?? null : null
    let attachments = 0
    if (rows.length) {
      for (const part of chunk(rows.map(r => r.id))) {
        attachments += (this.db.prepare(`SELECT COUNT(*) AS c FROM attachments WHERE inline = 0 AND message_id IN (${part.map(() => '?').join(',')})`).get(...part) as any).c as number
      }
    }
    let money: ProjectStats['finance'] = null
    if (finance.length) {
      const totals = new Map<string, ProjectMoneyTotal>()
      for (const f of finance) {
        const d = f.data as unknown as FinanceData
        if (typeof d.amount !== 'number' || d.status === 'cancelled') continue
        // 同一笔交易的发票 / 付款 / 回单（matchId 相同）只算一次：只累计发票或第一条
        const cur = (d.currency || 'CNY').toUpperCase()
        const t = totals.get(cur) ?? { currency: cur, in: 0, out: 0, pending: 0 }
        if (d.kind === 'receipt' && d.matchId && finance.some(o => o !== f && (o.data as any).matchId === d.matchId)) continue
        if (d.kind === 'payment' && d.matchId && finance.some(o => o !== f && (o.data as any).matchId === d.matchId && (o.data as any).kind === 'invoice')) continue
        if (d.direction === 'in') t.in += d.amount
        else t.out += d.amount
        if (d.status === 'pending' || d.status === 'overdue') t.pending += d.amount
        totals.set(cur, t)
      }
      money = { count: finance.length, totals: [...totals.values()] }
    }
    return {
      messageCount: rows.length,
      threadCount: new Set(rows.map(threadKey)).size,
      unread: rows.filter(r => !seen(r) && !mine.has(String(r.from_addr ?? '').toLowerCase())).length,
      lastAt: last?.date ?? null,
      lastSubject: last?.subject ?? '',
      lastFrom: last ? (mine.has(String(last.from_addr ?? '').toLowerCase()) ? '我' : last.from_name || last.from_addr || '') : '',
      lastGist: gist,
      openTodos: todos.filter(t => t.status === 'open').length,
      doneTodos: todos.filter(t => t.status === 'done').length,
      finance: money,
      attachments
    }
  }

  list(): ProjectListItem[] {
    const mine = this.myAddrs()
    const todos = this.allTodos()
    const finance = this.allFinance()
    return this.all().map(p => {
      const rows = this.memberRows(p)
      const ids = new Set(rows.map(r => r.id))
      return { ...p, stats: this.stats(p, rows, this.linkedTodos(p, ids, todos), this.linkedFinance(p, ids, finance), mine) }
    })
  }

  detail(id: string): ProjectDetail | null {
    const p = this.get(id)
    if (!p) return null
    const mine = this.myAddrs()
    const rows = this.memberRows(p)
    const ids = new Set(rows.map(r => r.id))
    const todos = this.linkedTodos(p, ids)
    const finance = this.linkedFinance(p, ids)
    const ai = this.deps.store.getMailAi(rows.map(r => r.id))
    // 会话（同一线程聚成一行，新的在前）
    const convMap = new Map<string, any[]>()
    for (const r of rows) {
      const k = threadKey(r)
      const list = convMap.get(k) ?? []
      list.push(r)
      convMap.set(k, list)
    }
    const conversations: ProjectConversation[] = [...convMap.entries()].map(([k, list]) => {
      const latest = list[0]
      const names = new Set<string>()
      for (const r of list) {
        const addr = String(r.from_addr ?? '').toLowerCase()
        names.add(mine.has(addr) ? '我' : r.from_name || r.from_addr || '')
      }
      return {
        threadId: k,
        latestId: latest.id,
        accountId: latest.account_id,
        subject: latest.subject ?? '',
        participants: [...names].filter(Boolean),
        count: list.length,
        unread: list.filter(r => !seen(r) && !mine.has(String(r.from_addr ?? '').toLowerCase())).length,
        lastAt: latest.date ?? 0,
        gist: ai[latest.id]?.gist ?? null,
        gistKey: ai[latest.id]?.gistKey ?? null,
        hasAttachments: list.some(r => !!r.has_attachments),
        fromMe: mine.has(String(latest.from_addr ?? '').toLowerCase())
      }
    })
    const attachments = this.attachmentsOf(rows)
    const tl = this.tlMessages(rows, mine)
    const pending = finance
      .map(f => f.data as unknown as FinanceData)
      .filter(d => d.status === 'pending' || d.status === 'overdue')
      .map(d => ({ amount: d.amount, currency: d.currency || 'CNY', dueAt: d.dueAt ?? null, counterparty: d.counterparty }))
    const ruleSum = ruleSummary({ messages: tl, openTodos: todos.filter(t => t.status === 'open').map(t => ({ title: t.title, dueAt: t.dueAt })), financePending: pending })
    return { ...p, stats: this.stats(p, rows, todos, finance, mine), conversations, todos, finance, attachments, ruleSummary: ruleSum }
  }

  private attachmentsOf(rows: any[]): ProjectAttachment[] {
    const out: ProjectAttachment[] = []
    const dateOf = new Map(rows.map(r => [r.id, r.date ?? 0]))
    for (const part of chunk(rows.map(r => r.id))) {
      const res = this.db
        .prepare(`SELECT id, message_id, filename, content_type, size FROM attachments WHERE inline = 0 AND message_id IN (${part.map(() => '?').join(',')})`)
        .all(...part) as any[]
      for (const a of res) {
        if (/\.(ics|lkghost)$/i.test(a.filename ?? '')) continue
        out.push({ id: a.id, messageId: a.message_id, filename: a.filename ?? '附件', contentType: a.content_type ?? '', size: a.size ?? 0, date: dateOf.get(a.message_id) ?? 0, kind: classifyAttachment(a.filename ?? '') })
      }
    }
    return out.sort((a, b) => b.date - a.date)
  }

  // ================= 时间线 =================

  timeline(id: string): TimelineEvent[] {
    const p = this.get(id)
    if (!p) return []
    const mine = this.myAddrs()
    const rows = this.memberRows(p)
    const ids = new Set(rows.map(r => r.id))
    const todos = this.linkedTodos(p, ids)
    const finance = this.linkedFinance(p, ids)
    return buildTimeline({
      messages: this.tlMessages(rows, mine),
      attachments: this.attachmentsOf(rows).map(a => ({ id: a.id, messageId: a.messageId, filename: a.filename, size: a.size })),
      todos: todos.map(t => ({ id: t.id, title: t.title, createdAt: t.createdAt, status: t.status, dueAt: t.dueAt, doneAt: (t.data as TodoData).doneAt ?? null, messageId: t.messageId })),
      finance: finance.map(f => ({ id: f.id, title: f.title, createdAt: f.createdAt, data: f.data as unknown as FinanceData })),
      milestones: p.data.milestones ?? []
    })
  }

  /** 与某个联系人（地址）或公司（域名）的全部往来，按时间线展开 */
  contactTimeline(rawKey: string): ContactTimeline | null {
    const key = (rawKey || '').trim().toLowerCase()
    if (!key) return null
    const mine = this.myAddrs()
    const mode: ContactTimeline['mode'] = key.includes('@') ? 'address' : 'domain'
    const rows =
      mode === 'address'
        ? (this.db
            .prepare(`SELECT ${COLS} FROM messages m WHERE (lower(m.from_addr) = ? OR lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ?) AND ${NOT_TRASH} ORDER BY m.date DESC LIMIT 400`)
            .all(key, `%"${key}"%`, `%"${key}"%`) as any[])
        : (this.db
            .prepare(
              `SELECT ${COLS} FROM messages m WHERE (lower(m.from_addr) LIKE ? OR lower(m.from_addr) LIKE ? OR lower(m.to_json) LIKE ? OR lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ?) AND ${NOT_TRASH} ORDER BY m.date DESC LIMIT 400`
            )
            .all(`%@${key}`, `%.${key}`, `%@${key}"%`, `%.${key}"%`, `%@${key}"%`) as any[])
    const list = dedupeByMessageId(rows)
    const ids = new Set(list.map(r => r.id))
    const names = new Map<string, number>()
    for (const r of list) {
      const addr = String(r.from_addr ?? '').toLowerCase()
      if (mine.has(addr) || !r.from_name) continue
      if (mode === 'address' ? addr === key : true) names.set(r.from_name, (names.get(r.from_name) ?? 0) + 1)
    }
    const topName = [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const domain = mode === 'domain' ? key : domainOf(key)
    const name = mode === 'domain' ? domainLabel(key) : topName || key
    const todos = this.allTodos().filter(t => t.messageId && ids.has(t.messageId))
    const finance = this.allFinance().filter(f => {
      const d = f.data as unknown as FinanceData
      return (d.messageIds ?? []).some(id => ids.has(id)) || (mode === 'domain' && !!d.domain && d.domain.toLowerCase() === key)
    })
    const events = buildTimeline({
      messages: this.tlMessages(list, mine),
      attachments: this.attachmentsOf(list).map(a => ({ id: a.id, messageId: a.messageId, filename: a.filename, size: a.size })),
      todos: todos.map(t => ({ id: t.id, title: t.title, createdAt: t.createdAt, status: t.status, dueAt: t.dueAt, doneAt: (t.data as TodoData).doneAt ?? null, messageId: t.messageId })),
      finance: finance.map(f => ({ id: f.id, title: f.title, createdAt: f.createdAt, data: f.data as unknown as FinanceData }))
    })
    const projects = this.all()
      .filter(p => p.data.counterparties.some(c => c === key || (mode === 'address' && c === domain && !isPublicDomain(domain))) || list.some(r => p.data.threadIds.includes(threadKey(r))))
      .map(p => ({ id: p.id, name: p.data.name, color: p.data.color ?? null }))
    return { key, mode, name, domain: domain || null, messageCount: list.length, events, projects }
  }

  // ================= 加入 / 移出 / 从邮件建 =================

  private participants(r: any, mine: Set<string>): string[] {
    const all = [r.from_addr, ...j<Address[]>(r.to_json, []).map(a => a.address), ...j<Address[]>(r.cc_json, []).map(a => a.address)]
    return [...new Set(all.filter(Boolean).map((a: string) => a.toLowerCase()))].filter(a => !mine.has(a))
  }

  addMessages(projectId: string, messageIds: string[]): ProjectRecord | null {
    const p = this.get(projectId)
    if (!p) return null
    const threads = new Set(p.data.threadIds)
    const ids = new Set(p.data.messageIds)
    const excluded = new Set(p.data.excludedThreadIds ?? [])
    for (const id of messageIds) {
      const r = this.deps.store.getMessageRow(id)
      if (!r) continue
      const k = threadKey(r)
      if (r.thread_id) threads.add(r.thread_id)
      ids.add(r.id)
      excluded.delete(k)
    }
    // 同一会话被加进来后，从其他项目的建议队列里拿掉
    const addedThreads = new Set(messageIds.map(id => this.deps.store.getMessageRow(id)).filter(Boolean).map((r: any) => threadKey(r)))
    for (const other of this.all()) {
      const sug = other.data.suggestions ?? []
      if (sug.some(s => addedThreads.has(s.threadId))) this.write(other.id, { suggestions: sug.filter(s => !addedThreads.has(s.threadId)) })
    }
    this.write(projectId, { threadIds: [...threads], messageIds: [...ids], excludedThreadIds: [...excluded], updatedAt: Date.now() })
    this.changed()
    return this.get(projectId)
  }

  /** 移出：整段会话移出，并记为「不再自动归入」 */
  removeMessages(projectId: string, messageIds: string[]): ProjectRecord | null {
    const p = this.get(projectId)
    if (!p) return null
    const rows = messageIds.map(id => this.deps.store.getMessageRow(id)).filter(Boolean) as any[]
    const keys = new Set(rows.map(threadKey))
    const threadRows = new Set<string>()
    for (const k of keys) {
      for (const r of this.db.prepare('SELECT id FROM messages WHERE thread_id = ?').all(k) as any[]) threadRows.add(r.id)
    }
    const drop = new Set([...messageIds, ...threadRows])
    this.write(projectId, {
      threadIds: p.data.threadIds.filter(t => !keys.has(t)),
      messageIds: p.data.messageIds.filter(id => !drop.has(id)),
      excludedThreadIds: [...new Set([...(p.data.excludedThreadIds ?? []), ...keys])],
      updatedAt: Date.now()
    })
    this.changed()
    return this.get(projectId)
  }

  resolveSuggestion(projectId: string, threadId: string, accept: boolean): ProjectRecord | null {
    const p = this.get(projectId)
    if (!p) return null
    const sug = p.data.suggestions ?? []
    const hit = sug.find(s => s.threadId === threadId)
    this.write(projectId, { suggestions: sug.filter(s => s.threadId !== threadId) })
    this.cache = null
    if (accept && hit) return this.addMessages(projectId, [hit.messageId])
    if (!accept) this.write(projectId, { excludedThreadIds: [...new Set([...(p.data.excludedThreadIds ?? []), threadId])] })
    this.changed()
    return this.get(projectId)
  }

  /** 从一封邮件 / 一个会话建项目：带入对方域名、成员、关键词、整个会话 */
  fromMessage(messageId: string): ProjectRecord | null {
    const row = this.deps.store.getMessageRow(messageId)
    if (!row) return null
    const mine = this.myAddrs()
    const thread = row.thread_id
      ? (this.db.prepare(`SELECT ${COLS} FROM messages m WHERE m.thread_id = ? AND ${NOT_TRASH} ORDER BY m.date ASC`).all(row.thread_id) as any[])
      : [row]
    const members = new Map<string, { name?: string; address: string }>()
    for (const r of thread) {
      const list: Address[] = [r.from_addr ? { name: r.from_name ?? undefined, address: r.from_addr } : null, ...j<Address[]>(r.to_json, []), ...j<Address[]>(r.cc_json, [])].filter(Boolean) as Address[]
      for (const a of list) {
        const addr = a.address?.toLowerCase()
        if (!addr || mine.has(addr) || isRobotAddr(addr)) continue
        if (!members.has(addr) || (!members.get(addr)!.name && a.name)) members.set(addr, { name: a.name || undefined, address: addr })
      }
    }
    const counterparties = [...new Set([...members.keys()].map(counterpartyKey))]
    const subject = normalizeSubject(row.subject ?? '')
    const firstDomain = counterparties.find(c => !c.includes('@'))
    const name = subject ? subject.slice(0, 40) : firstDomain ? `${domainLabel(firstDomain)} 往来` : '新项目'
    return this.save({
      data: {
        name,
        counterparties,
        keywords: extractKeywords(row.subject ?? ''),
        threadIds: row.thread_id ? [row.thread_id] : [],
        messageIds: thread.map(r => r.id),
        members: [...members.values()],
        startedAt: thread[0]?.date ?? row.date ?? Date.now(),
        source: 'mail',
        auto: true
      }
    })
  }

  // ================= 自动归并 =================

  private matchProjects(): (MatchProject & { record: ProjectRecord })[] {
    return this.all()
      .filter(p => p.data.status === 'active' || p.data.status === 'paused')
      .map(p => ({
        id: p.id,
        name: p.data.name,
        status: p.data.status,
        auto: p.data.auto,
        counterparties: p.data.counterparties,
        keywords: p.data.keywords,
        members: (p.data.members ?? []).map(m => m.address),
        threadIds: p.data.threadIds,
        messageIds: p.data.messageIds,
        excludedThreadIds: p.data.excludedThreadIds,
        startedAt: p.data.startedAt ?? null,
        record: p
      }))
  }

  private matchInput(r: any, mine: Set<string>): MatchMessage {
    return {
      id: r.id,
      threadId: threadKey(r),
      subject: r.subject ?? '',
      body: `${r.snippet ?? ''}\n${String(r.text ?? '').slice(0, 2000)}`,
      participants: this.participants(r, mine),
      isNewsletter: !!r.is_newsletter,
      category: r.category ?? 'personal',
      date: r.date ?? 0
    }
  }

  /** 单封判定并落库；返回动作（rescan 批量调用时 emit=false，最后统一广播） */
  private judge(r: any, mine: Set<string>, projects: ReturnType<ProjectService['matchProjects']>, emit = true): 'auto' | 'suggest' | 'none' {
    const special = (this.db.prepare('SELECT special FROM folders WHERE id = ?').get(r.folder_id) as any)?.special
    if (special === 'trash' || special === 'junk' || special === 'drafts') return 'none'
    const input = this.matchInput(r, mine)
    if (!input.participants.length) return 'none'
    // 已在某个项目里（同一会话）：不必写库
    if (projects.some(p => p.threadIds.includes(input.threadId) || p.messageIds.includes(input.id))) return 'none'
    const decision = decideMatch(input, projects)
    if (decision.action === 'none') return 'none'
    const target = projects.find(p => p.id === decision.projectId)!
    if (decision.action === 'auto') {
      if (r.thread_id) target.threadIds = [...target.threadIds, r.thread_id]
      target.messageIds = [...target.messageIds, r.id]
      this.write(target.id, { threadIds: target.threadIds, messageIds: target.messageIds, updatedAt: Date.now() })
    } else {
      const sug = target.record.data.suggestions ?? []
      if (sug.some(s => s.threadId === input.threadId)) return 'none'
      const next: ProjectSuggestion[] = [
        { messageId: r.id, threadId: input.threadId, score: decision.score, reason: decision.reason, at: r.date ?? Date.now(), subject: r.subject ?? '', from: mine.has(String(r.from_addr ?? '').toLowerCase()) ? '我' : r.from_name || r.from_addr || '' },
        ...sug
      ].slice(0, 60)
      target.record.data.suggestions = next
      this.write(target.id, { suggestions: next })
    }
    if (emit) {
      this.cache = null
      this.deps.event({ type: 'projects-changed' })
    }
    return decision.action
  }

  /** onInsight 钩子：邮件理解完成（启发式或 AI）后判一次；会被列表加载频繁调用，必须便宜且幂等 */
  onMessage(messageId: string) {
    if (this.judged.has(messageId)) return
    if (this.judged.size > 20_000) this.judged.clear()
    this.judged.add(messageId)
    const projects = this.matchProjects()
    if (!projects.length) return
    const r = this.deps.store.getMessageRow(messageId)
    if (!r) return
    try {
      this.judge(r, this.myAddrs(), projects)
    } catch (err) {
      console.error('[projects] judge failed:', err)
    }
  }

  /** 回扫：项目新建 / 改了对方或关键词后，把已有邮件按同样规则过一遍（自动归入 + 建议） */
  rescan(projectId: string): { added: number; suggested: number } {
    const p = this.get(projectId)
    if (!p) return { added: 0, suggested: 0 }
    const since = Math.min(p.data.startedAt ?? Date.now(), Date.now()) - 30 * DAY
    const where: string[] = []
    const params: string[] = []
    for (const c of p.data.counterparties) {
      if (c.includes('@')) {
        where.push('(lower(m.from_addr) = ? OR lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ?)')
        params.push(c, `%"${c}"%`, `%"${c}"%`)
      } else {
        where.push('(lower(m.from_addr) LIKE ? OR lower(m.from_addr) LIKE ? OR lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ?)')
        params.push(`%@${c}`, `%.${c}`, `%@${c}"%`, `%@${c}"%`)
      }
    }
    for (const k of p.data.keywords) {
      if ([...k].length < 2) continue
      where.push('m.subject LIKE ?')
      params.push(`%${k}%`)
    }
    if (!where.length) return { added: 0, suggested: 0 }
    const rows = this.db
      .prepare(`SELECT ${COLS}, m.text FROM messages m WHERE m.date >= ? AND (${where.join(' OR ')}) AND ${NOT_TRASH} ORDER BY m.date ASC LIMIT 2000`)
      .all(since, ...params) as any[]
    const mine = this.myAddrs()
    const projects = this.matchProjects()
    let added = 0
    let suggested = 0
    for (const r of dedupeByMessageId(rows)) {
      const res = this.judge(r, mine, projects, false)
      if (res === 'auto') added++
      if (res === 'suggest') suggested++
    }
    if (added || suggested) this.changed()
    return { added, suggested }
  }

  // ================= AI：摘要 / 发现 =================

  private ready() {
    return aiReady(this.deps.getAISettings())
  }

  private async askJson(system: string, user: string): Promise<any> {
    const ask = (extra: string) =>
      this.deps.ai.complete(
        [
          { role: 'system', content: system + (extra ? `\n\n${extra}` : '') },
          { role: 'user', content: user }
        ],
        2400
      )
    try {
      return jsonFromText(await ask(''))
    } catch (err) {
      if (err instanceof Error && err.name === 'AIError') throw err
      return jsonFromText(await ask(JSON_RETRY_NUDGE))
    }
  }

  async summarize(id: string): Promise<{ ok: boolean; error?: string; summary: ProjectSummary | null }> {
    const detail = this.detail(id)
    if (!detail) return { ok: false, error: '项目不存在', summary: null }
    if (!this.ready()) return { ok: false, error: 'AI 未启用（设置 → AI 配置后可用），先显示规则版摘要', summary: detail.ruleSummary }
    if (this.summarizing.has(id)) return { ok: false, error: '正在生成', summary: detail.data.summary ?? detail.ruleSummary }
    this.summarizing.add(id)
    try {
      const mine = this.myAddrs()
      const rows = this.memberRows(detail).slice(0, 30).reverse()
      if (!rows.length) return { ok: true, summary: detail.ruleSummary }
      const full = rows.map(r => this.deps.store.getMessageRow(r.id))
      const ai = this.deps.store.getMailAi(rows.map(r => r.id))
      const lines = full.map((r, i) => {
        const fromMe = mine.has(String(r.from_addr ?? '').toLowerCase())
        const to = j<Address[]>(r.to_json, []).map(a => a.name || a.address).slice(0, 3).join('、')
        const body = String(r.text || r.snippet || '').replace(/\s+/g, ' ').slice(0, 360)
        return `[E${i + 1}] ${new Date(r.date).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} ${fromMe ? '我' : `${r.from_name || r.from_addr}（对方）`} → ${fromMe ? to : '我'}\n主题：${r.subject}\n${ai[r.id]?.gist ? `要点：${ai[r.id].gist}\n` : ''}正文：${body}`
      })
      const todos = detail.todos.filter(t => t.status === 'open').map(t => `- ${t.title}${t.dueAt ? `（截止 ${new Date(t.dueAt).toLocaleDateString('zh-CN')}）` : ''}`)
      const money = detail.finance.map(f => {
        const d = f.data as unknown as FinanceData
        return `- ${d.kind} ${d.counterparty} ${d.amount ?? '?'} ${d.currency} ${d.status}`
      })
      const user =
        `今天：${new Date().toLocaleDateString('zh-CN')}\n项目：${detail.data.name}\n对方：${detail.data.counterparties.join('、') || '—'}\n` +
        (detail.data.notes ? `备注：${detail.data.notes}\n` : '') +
        `\n邮件往来：\n${lines.join('\n\n')}\n\n未完成待办：\n${todos.join('\n') || '无'}\n\n款项：\n${money.join('\n') || '无'}`
      const raw = await this.askJson(PROJECT_SUMMARY, user)
      // [E3] → [n]：按出现顺序编号，sources 与之对应
      const sources: ProjectSummary['sources'] = []
      const cite = (text: unknown): string => {
        if (typeof text !== 'string') return ''
        return text.replace(/\[E(\d+)\]/g, (_m, n) => {
          const r = full[Number(n) - 1]
          if (!r) return ''
          let i = sources.findIndex(s => s.messageId === r.id)
          if (i < 0) {
            sources.push({ messageId: r.id, subject: normalizeSubject(r.subject ?? '') || '（无主题）', date: r.date ?? 0 })
            i = sources.length - 1
          }
          return `[${i + 1}]`
        }).trim()
      }
      const summary: ProjectSummary = {
        source: 'ai',
        progress: cite(raw.progress) || detail.ruleSummary.progress,
        blocker: raw.blocker && raw.blocker !== 'null' ? cite(raw.blocker) : null,
        waitingOn: ['me', 'them', 'none'].includes(raw.waitingOn) ? raw.waitingOn : detail.ruleSummary.waitingOn,
        next: (Array.isArray(raw.next) ? raw.next : []).map(cite).filter(Boolean).slice(0, 5),
        sources,
        lastMail: detail.ruleSummary.lastMail,
        openTodos: detail.ruleSummary.openTodos,
        generatedAt: Date.now()
      }
      this.write(id, { summary })
      this.changed()
      return { ok: true, summary }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), summary: detail.data.summary ?? detail.ruleSummary }
    } finally {
      this.summarizing.delete(id)
    }
  }

  /** 最近 N 天的企业往来会话（不在任何项目里的），供发现项目用 */
  private recentThreads(days: number) {
    const mine = this.myAddrs()
    const since = Date.now() - days * DAY
    const rows = this.db
      .prepare(`SELECT ${COLS} FROM messages m WHERE m.date >= ? AND m.is_newsletter = 0 AND COALESCE(m.category,'personal') IN ('personal','notification') AND ${NOT_TRASH} ORDER BY m.date DESC LIMIT 2000`)
      .all(since) as any[]
    const inProject = new Set<string>()
    for (const p of this.all()) {
      for (const t of p.data.threadIds) inProject.add(t)
      for (const id of p.data.messageIds) inProject.add(id)
    }
    const threads = new Map<string, { key: string; rows: any[]; parties: Set<string> }>()
    for (const r of dedupeByMessageId(rows)) {
      const k = threadKey(r)
      if (inProject.has(k) || inProject.has(r.id)) continue
      const parties = this.participants(r, mine).filter(a => !isRobotAddr(a))
      const t = threads.get(k) ?? { key: k, rows: [], parties: new Set<string>() }
      t.rows.push(r)
      for (const a of parties) t.parties.add(a)
      threads.set(k, t)
    }
    const ai = this.deps.store.getMailAi([...threads.values()].map(t => t.rows[0].id))
    return [...threads.values()]
      .filter(t => t.parties.size > 0)
      // 企业往来：对方是企业域名，或者是有来有回的会话
      .filter(t => [...t.parties].some(a => !isPublicDomain(domainOf(a))) || t.rows.some(r => mine.has(String(r.from_addr ?? '').toLowerCase())))
      // 纯通知类（对方从不是真人、我也没回）不要
      .filter(t => t.rows.some(r => r.category === 'personal') || t.rows.some(r => mine.has(String(r.from_addr ?? '').toLowerCase())))
      .map(t => {
        const sorted = [...t.rows].sort((a, b) => a.date - b.date)
        const last = sorted[sorted.length - 1]
        const first = sorted[0]
        const from = sorted.find(r => !mine.has(String(r.from_addr ?? '').toLowerCase()))
        return {
          key: t.key,
          rows: sorted,
          parties: [...t.parties],
          counterparty: from ? from.from_name || from.from_addr : [...t.parties][0],
          subject: normalizeSubject(first.subject ?? '') || '（无主题）',
          gist: ai[t.rows[0].id]?.gist ?? String(last.snippet ?? '').slice(0, 60),
          firstAt: first.date,
          lastAt: last.date
        }
      })
      .sort((a, b) => b.lastAt - a.lastAt)
  }

  private candidateFrom(threads: ReturnType<ProjectService['recentThreads']>, extra: { key: string; name: string; counterparty: string; keywords?: string[]; why: string; source: 'ai' | 'heuristic' }): ProjectCandidate {
    const parties = [...new Set(threads.flatMap(t => t.parties))]
    const keys = [...new Set(parties.map(counterpartyKey))]
    const rows = threads.flatMap(t => t.rows)
    return {
      key: extra.key,
      name: extra.name,
      counterparty: extra.counterparty,
      counterparties: keys.slice(0, 6),
      keywords: uniqText(extra.keywords?.length ? extra.keywords : commonKeywords(threads.map(t => t.subject))).slice(0, 4),
      threadIds: threads.map(t => t.key),
      messageIds: rows.map(r => r.id),
      subjects: threads.map(t => t.subject).slice(0, 6),
      firstAt: Math.min(...threads.map(t => t.firstAt)),
      lastAt: Math.max(...threads.map(t => t.lastAt)),
      messageCount: rows.length,
      why: extra.why,
      source: extra.source
    }
  }

  /** 规则版发现：按对方（企业域名 / 个人地址）把会话聚起来，≥2 个会话或 ≥3 封邮件才算 */
  private discoverHeuristic(threads: ReturnType<ProjectService['recentThreads']>): ProjectCandidate[] {
    const groups = new Map<string, typeof threads>()
    for (const t of threads) {
      const key = counterpartyKey(t.parties.find(a => !isPublicDomain(domainOf(a))) ?? t.parties[0])
      const list = groups.get(key) ?? []
      list.push(t)
      groups.set(key, list)
    }
    const out: ProjectCandidate[] = []
    for (const [key, list] of groups) {
      const count = list.reduce((s, t) => s + t.rows.length, 0)
      if (list.length < 2 && count < 3) continue
      const company = key.includes('@') ? list[0].counterparty : domainLabel(key)
      const kw = extractKeywords(list[list.length - 1].subject, 1)[0]
      out.push(
        this.candidateFrom(list, {
          key: `h:${key}`,
          name: kw ? `${company} · ${kw}`.slice(0, 30) : `${company} 往来`,
          counterparty: company,
          why: `和 ${company} 最近有 ${list.length} 个会话、${count} 封往来`,
          source: 'heuristic'
        })
      )
    }
    return out.sort((a, b) => b.lastAt - a.lastAt).slice(0, 8)
  }

  async discover(days = 60): Promise<{ ok: boolean; error?: string; source: 'ai' | 'heuristic'; candidates: ProjectCandidate[] }> {
    const threads = this.recentThreads(Math.max(7, Math.min(365, days)))
    if (!threads.length) return { ok: true, source: 'heuristic', candidates: [] }
    if (!this.ready()) return { ok: true, source: 'heuristic', candidates: this.discoverHeuristic(threads) }
    const pick = threads.slice(0, 80)
    const lines = pick.map((t, i) => {
      const d = (ts: number) => new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
      return `[T${i + 1}] ${d(t.firstAt)}${t.firstAt !== t.lastAt ? `–${d(t.lastAt)}` : ''} | 对方：${t.counterparty} <${t.parties.slice(0, 2).join(', ')}> | 主题：${t.subject} | 要点：${t.gist || '—'} | ${t.rows.length} 封`
    })
    try {
      const raw = await this.askJson(PROJECT_DISCOVER, `最近 ${days} 天的企业往来会话：\n${lines.join('\n')}`)
      const used = new Set<string>()
      const candidates: ProjectCandidate[] = []
      for (const [i, c] of (Array.isArray(raw.projects) ? raw.projects : []).entries()) {
        const refs: string[] = Array.isArray(c.refs) ? c.refs : []
        const list = refs
          .map(r => pick[Number(String(r).replace(/\D/g, '')) - 1])
          .filter((t): t is (typeof pick)[number] => !!t && !used.has(t.key))
        if (!list.length) continue
        if (list.length === 1 && list[0].rows.length < 2) continue
        for (const t of list) used.add(t.key)
        candidates.push(
          this.candidateFrom(list, {
            key: `ai:${i}:${list[0].key}`,
            name: String(c.name || list[0].subject).slice(0, 40),
            counterparty: String(c.counterparty || list[0].counterparty),
            keywords: Array.isArray(c.keywords) ? c.keywords.map(String) : [],
            why: String(c.why || ''),
            source: 'ai'
          })
        )
      }
      return { ok: true, source: 'ai', candidates: candidates.slice(0, 8) }
    } catch (err) {
      // AI 出错：退回规则聚类，同时把错误带给界面
      return { ok: false, error: err instanceof Error ? err.message : String(err), source: 'heuristic', candidates: this.discoverHeuristic(threads) }
    }
  }
}

/** 规则版候选的关键词：在 ≥2 个会话主题里都出现的词（编号、项目名）；没有就取最近一个主题的第一个词 */
function commonKeywords(subjects: string[]): string[] {
  const all = uniqText(subjects.flatMap(s => extractKeywords(s, 4)))
  const common = all.filter(k => subjects.filter(s => s.toLowerCase().includes(k.toLowerCase())).length >= 2)
  if (common.length) return common
  const last = subjects[0] ? extractKeywords(subjects[0], 1) : []
  return last
}

function uniqLower(list: string[]): string[] {
  return [...new Set(list.map(s => String(s).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))]
}

function uniqText(list: string[]): string[] {
  const out: string[] = []
  for (const s of list) {
    const t = String(s).trim()
    if (t && !out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  return out
}

/** 同一封邮件在多个文件夹（如 Gmail 的 All Mail）只留一份：按 Message-ID 去重，保留先出现的 */
function dedupeByMessageId<T extends { message_id?: string | null }>(rows: T[]): T[] {
  const seenIds = new Set<string>()
  return rows.filter(r => {
    if (!r.message_id) return true
    if (seenIds.has(r.message_id)) return false
    seenIds.add(r.message_id)
    return true
  })
}
