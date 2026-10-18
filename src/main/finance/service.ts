import type { AISettings, FinanceData, MailInsight, TodoData } from '@shared/types'
import { autoMatch, isReconKind, rowStatusOf, DAY_MS } from '@shared/finance'
import type { FinanceListResult, FinanceInput, FinanceScanResult } from '@shared/ipc'
import type { MailStore } from '../db'
import type { AIService } from '../ai/service'
import { aiReady } from '../ai/service'
import { FINANCE_EXTRACT } from '../ai/prompts'
import { acceptCandidate, bodyOf, detectFinance, looksFinancial, rootDomain, type FinanceCandidate, type FinanceMailInput } from './detect'
import { findMergeTarget, mergeInto, newRecordData, type FinanceRow } from './merge'
import { candidateFromAi, jsonFromText } from './ai-map'
import { extractEntities } from '../mail/understand-heuristic'

/* eslint-disable @typescript-eslint/no-explicit-any */

const SKIP_FOLDERS = new Set(['trash', 'junk', 'drafts'])

interface MsgRow {
  id: string
  account_id: string
  folder_path: string
  folder_special: string | null
  from_name: string | null
  from_addr: string | null
  subject: string | null
  snippet: string | null
  text: string | null
  html: string | null
  date: number
  flags: string | null
  category: string | null
  is_newsletter: number
  list_unsubscribe: string | null
  body_fetched: number
}

/**
 * 财务中心主进程服务：
 *  - 自动收集：邮件理解完成（onInsight）→ 排队 → 启发式识别 → 归并 / 新建；拿不准且 AI 可用时补一次 AI
 *  - 幂等：messageId → 款项索引；已处理 / 已删除的邮件不再重复入库
 *  - 回填：扫描最近 N 天邮件（带进度事件 finance-scan）
 *  - 对账：每次变更后自动配对 matchId（手动配对 / 拆开过的不动）
 */
export class FinanceService {
  /** messageId → 款项 id（含已删除的，防止复活） */
  private index = new Map<string, string>()
  /** 本次运行已检查过的邮件：值为检查时用的理解来源（AI 结果到达后允许再看一次） */
  private checked = new Map<string, 'heuristic' | 'ai'>()
  private pending = new Map<string, MailInsight>()
  private timer: NodeJS.Timeout | null = null
  private aiQueue: string[] = []
  private aiQueued = new Set<string>()
  private aiBusy = false
  private scanning = false
  private indexed = false

  constructor(
    private deps: {
      store: MailStore
      ai: AIService
      getAISettings(): AISettings
      event(payload: unknown): void
      /** 待办有本地改动（生成提醒待办后通知跨设备 / 外部同步） */
      onTodosChanged?(id: string): void
    }
  ) {}

  // ---------------------------------------------------------------- 数据访问

  /** 全部款项行（含已删除墓碑；不受 listInsights 的 500 条上限约束） */
  rows(includeDismissed = true): FinanceRow[] {
    const list = this.deps.store.db
      .prepare(`SELECT * FROM insights WHERE kind = 'finance' ${includeDismissed ? '' : "AND status != 'dismissed'"} ORDER BY created_at DESC`)
      .all() as any[]
    return list.map(r => {
      let data: FinanceData
      try {
        data = JSON.parse(r.data_json || '{}')
      } catch {
        data = {} as FinanceData
      }
      data.messageIds ??= []
      return { id: r.id, title: r.title, status: r.status ?? 'open', dueAt: r.due_at ?? null, createdAt: Number(r.created_at) || 0, accountId: r.account_id ?? null, data }
    })
  }

  private ensureIndex() {
    if (this.indexed) return
    this.indexed = true
    for (const r of this.rows()) for (const m of r.data.messageIds ?? []) this.index.set(m, r.id)
  }

  private myAddrs(): Set<string> {
    const set = new Set<string>()
    for (const a of this.deps.store.listAccounts()) {
      if (a.email) set.add(a.email.toLowerCase())
      if (a.user?.includes('@')) set.add(a.user.toLowerCase())
    }
    return set
  }

  private loadMessages(ids: string[]): MsgRow[] {
    const out: MsgRow[] = []
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200)
      if (!part.length) continue
      out.push(
        ...(this.deps.store.db
          .prepare(
            `SELECT m.id, m.account_id, m.folder_path, f.special AS folder_special, m.from_name, m.from_addr, m.subject, m.snippet,
                    substr(coalesce(m.text,''), 1, 8000) AS text, substr(m.html, 1, 80000) AS html, m.date, m.flags, m.category,
                    m.is_newsletter, m.list_unsubscribe, m.body_fetched
             FROM messages m LEFT JOIN folders f ON f.id = m.folder_id
             WHERE m.id IN (${part.map(() => '?').join(',')})`
          )
          .all(...part) as unknown as MsgRow[])
      )
    }
    return out
  }

  private inputOf(row: MsgRow, mine: Set<string>, entities?: MailInsight['entities'], next?: MailInsight['next']): FinanceMailInput {
    // 理解结果里的实体（AI 结果可能为空）+ 启发式实体（相对日期「明天 18:00」等）+ 建议待办的截止日
    const ents = [...(entities ?? [])].map(e => ({ kind: e.kind, value: String(e.value), label: e.label }))
    try {
      for (const e of extractEntities({ subject: row.subject ?? '', text: row.text ?? '', snippet: row.snippet ?? '', html: row.html, fromAddr: row.from_addr ?? '', date: row.date || Date.now() })) {
        if (!ents.some(x => x.kind === e.kind && x.value === String(e.value))) ents.push({ kind: e.kind, value: String(e.value), label: e.label })
      }
    } catch {
      /* 实体只是补充 */
    }
    const due = next?.find(n => n.kind === 'todo' && n.due)?.due
    if (due && !ents.some(e => e.kind === 'deadline')) ents.push({ kind: 'deadline', value: String(due), label: String(due) })
    return {
      messageId: row.id,
      subject: row.subject ?? '',
      text: row.text ?? '',
      snippet: row.snippet ?? '',
      html: row.html,
      fromAddr: row.from_addr ?? '',
      fromName: row.from_name ?? '',
      date: row.date || Date.now(),
      fromMe: mine.has(String(row.from_addr ?? '').toLowerCase()),
      listUnsubscribe: row.list_unsubscribe,
      isNewsletter: !!row.is_newsletter,
      category: row.category,
      entities: ents
    }
  }

  // ---------------------------------------------------------------- 自动收集

  /** 邮件理解结果回调（getInsights 每次列表加载都会调，必须便宜：只做 Map 判断后排队） */
  onInsight(ins: MailInsight) {
    const seen = this.checked.get(ins.messageId)
    if (seen && (seen === 'ai' || ins.source === 'heuristic')) return
    this.pending.set(ins.messageId, ins)
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 400)
  }

  private flush() {
    this.timer = null
    const batch = [...this.pending.values()].slice(0, 300)
    for (const b of batch) this.pending.delete(b.messageId)
    if (this.pending.size) this.timer = setTimeout(() => this.flush(), 400)
    if (!batch.length) return
    let changed = 0
    try {
      this.ensureIndex()
      const rows = this.loadMessages(batch.map(b => b.messageId))
      const byId = new Map(batch.map(b => [b.messageId, b]))
      const mine = this.myAddrs()
      let fin: FinanceRow[] | null = null
      for (const row of rows.sort((a, b) => a.date - b.date)) {
        const ins = byId.get(row.id)
        if (!ins) continue
        // 正文还没下载：先不判（不记 checked），等正文到了下次列表加载再看
        if (!row.body_fetched && !row.text && !row.html) continue
        this.checked.set(row.id, ins.source)
        if (this.index.has(row.id)) continue
        if (SKIP_FOLDERS.has(row.folder_special ?? '')) continue
        if (!looksFinancial(row.subject ?? '', `${row.snippet ?? ''}\n${(row.text ?? '').slice(0, 1500)}`)) continue
        fin ??= this.rows()
        const res = this.ingest(row, this.inputOf(row, mine, ins.entities, ins.next), fin, true)
        if (res !== 'skip') {
          changed++
          fin = this.rows()
        }
      }
    } catch (err) {
      console.error('[finance] collect failed:', err)
    }
    if (changed) this.afterChange()
  }

  /** 识别 + 归并一封邮件；allowAi：拿不准时排队补 AI */
  private ingest(row: MsgRow, input: FinanceMailInput, fin: FinanceRow[], allowAi: boolean): 'created' | 'merged' | 'skip' {
    const c = detectFinance(input)
    if (!c) return 'skip'
    if (c.uncertain && allowAi && this.aiBackground()) this.queueAi(row.id)
    if (!acceptCandidate(c)) return 'skip'
    return this.apply(c, row, fin, 'heuristic')
  }

  private apply(c: FinanceCandidate, row: MsgRow, fin: FinanceRow[], source: 'heuristic' | 'ai' | 'manual'): 'created' | 'merged' | 'skip' {
    const date = row.date || Date.now()
    const target = findMergeTarget(c, fin, date)
    if (target) {
      const m = mergeInto(target, c, row.id, date)
      this.deps.store.updateInsight(target.id, { data: m.data as unknown as Record<string, unknown>, dueAt: m.dueAt, ...(m.rowStatus ? { status: m.rowStatus } : {}) })
      this.index.set(row.id, target.id)
      return 'merged'
    }
    const rec = newRecordData(c, row.id, date, source === 'manual' ? 'heuristic' : source)
    const id = `fin-${date.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    this.deps.store.insertInsight({ id, kind: 'finance', accountId: row.account_id, messageId: row.id, title: rec.title, data: rec.data as unknown as Record<string, unknown>, dueAt: rec.dueAt })
    const st = rowStatusOf(rec.data)
    if (st !== 'open') this.deps.store.setInsightStatus(id, st)
    this.index.set(row.id, id)
    return 'created'
  }

  private afterChange() {
    try {
      this.reconcile()
    } catch (err) {
      console.error('[finance] reconcile failed:', err)
    }
    this.deps.event({ type: 'finance-changed' })
  }

  // ---------------------------------------------------------------- AI 补充

  /** 后台补 AI：AI 已配置且开启了邮件理解（与理解队列同一开关），内置端侧小模型不承担 */
  private aiBackground(): boolean {
    const s = this.deps.getAISettings()
    return aiReady(s, false) && s.autoUnderstand !== false
  }

  private queueAi(id: string) {
    if (this.aiQueued.has(id) || this.aiQueue.length > 60) return
    this.aiQueued.add(id)
    this.aiQueue.push(id)
    void this.pumpAi()
  }

  private async pumpAi() {
    if (this.aiBusy) return
    this.aiBusy = true
    try {
      while (this.aiQueue.length) {
        const id = this.aiQueue.shift()!
        try {
          const res = await this.runAi(id)
          if (res !== 'skip') this.afterChange()
        } catch (err) {
          console.error('[finance] ai failed:', err)
        }
      }
    } finally {
      this.aiBusy = false
    }
  }

  private async aiCandidate(row: MsgRow, input: FinanceMailInput): Promise<FinanceCandidate | null> {
    const h = detectFinance(input)
    const body = bodyOf(input).slice(0, 4000)
    const user = `发件人：${input.fromName} <${input.fromAddr}>\n日期：${new Date(input.date).toISOString().slice(0, 10)}\n主题：${input.subject}\n正文：\n${body}`
    const text = await this.deps.ai.complete([
      { role: 'system', content: FINANCE_EXTRACT },
      { role: 'user', content: user }
    ], 900)
    return candidateFromAi(jsonFromText(text), h, input, `${input.subject}\n${body}`)
  }

  private async runAi(id: string): Promise<'created' | 'merged' | 'skip'> {
    if (this.index.has(id)) {
      // 启发式已收：AI 只在缺金额时补金额
      const fid = this.index.get(id)!
      const rec = this.deps.store.getInsight(fid)
      if (!rec || (rec.data as unknown as FinanceData).amount != null) return 'skip'
      const row = this.loadMessages([id])[0]
      if (!row) return 'skip'
      const c = await this.aiCandidate(row, this.inputOf(row, this.myAddrs()))
      if (c?.amount == null) return 'skip'
      this.deps.store.updateInsight(fid, { data: { amount: c.amount, currency: c.currency } })
      return 'merged'
    }
    const row = this.loadMessages([id])[0]
    if (!row) return 'skip'
    const c = await this.aiCandidate(row, this.inputOf(row, this.myAddrs()))
    if (!c || this.index.has(id)) return 'skip'
    return this.apply(c, row, this.rows(), 'ai')
  }

  // ---------------------------------------------------------------- 回填

  /** 扫描最近 N 天的邮件（一次性回填）；进度经 finance-scan 事件推送 */
  async scan(days: number): Promise<FinanceScanResult> {
    if (this.scanning) return { ok: false, error: '正在扫描', scanned: 0, created: 0, merged: 0 }
    this.scanning = true
    const since = Date.now() - Math.max(1, Math.min(3650, days)) * DAY_MS
    let created = 0
    let merged = 0
    let scanned = 0
    try {
      this.ensureIndex()
      const ids = (this.deps.store.db
        .prepare(
          `SELECT m.id, m.subject, m.snippet FROM messages m LEFT JOIN folders f ON f.id = m.folder_id
           WHERE m.date >= ? AND coalesce(f.special, '') NOT IN ('trash', 'junk', 'drafts')
           ORDER BY m.date ASC`
        )
        .all(since) as { id: string; subject: string | null; snippet: string | null }[])
      const total = ids.length
      const mine = this.myAddrs()
      let fin = this.rows()
      this.deps.event({ type: 'finance-scan', done: 0, total, created, merged, finished: false })
      for (let i = 0; i < ids.length; i += 40) {
        const part = ids.slice(i, i + 40).filter(r => !this.index.has(r.id))
        const rows = this.loadMessages(part.map(p => p.id)).sort((a, b) => a.date - b.date)
        for (const row of rows) {
          this.checked.set(row.id, 'heuristic')
          if (!looksFinancial(row.subject ?? '', `${row.snippet ?? ''}\n${(row.text ?? '').slice(0, 1500)}`)) continue
          const res = this.ingest(row, this.inputOf(row, mine), fin, true)
          if (res === 'created') created++
          if (res === 'merged') merged++
          if (res !== 'skip') fin = this.rows()
        }
        scanned = Math.min(total, i + 40)
        this.deps.event({ type: 'finance-scan', done: scanned, total, created, merged, finished: false })
        // 让出主进程事件循环（大批量回填不卡界面）
        await new Promise(r => setImmediate(r))
      }
      this.afterChange()
      this.deps.event({ type: 'finance-scan', done: total, total, created, merged, finished: true })
      return { ok: true, scanned: total, created, merged }
    } catch (err) {
      this.deps.event({ type: 'finance-scan', done: scanned, total: scanned, created, merged, finished: true, error: String(err) })
      return { ok: false, error: err instanceof Error ? err.message : String(err), scanned, created, merged }
    } finally {
      this.scanning = false
    }
  }

  // ---------------------------------------------------------------- 对账

  /** 自动配对 matchId；配上付款的发票标为已付。返回改动条数 */
  reconcile(): number {
    const rows = this.rows(false)
    const items = rows.map(r => ({ id: r.id, dueAt: r.dueAt, createdAt: r.createdAt, data: r.data }))
    const map = autoMatch(items)
    const groups = new Map<string, FinanceRow[]>()
    for (const r of rows) {
      const mid = map.has(r.id) ? map.get(r.id)! : r.data.matchId ?? null
      if (mid) groups.set(mid, [...(groups.get(mid) ?? []), r])
    }
    let n = 0
    for (const r of rows) {
      if (!isReconKind(r.data) || r.data.matchLocked || !map.has(r.id)) continue
      const mid = map.get(r.id) ?? null
      const patch: Partial<FinanceData> = {}
      if ((r.data.matchId ?? null) !== mid) patch.matchId = mid
      if (r.data.kind === 'invoice' && mid && r.data.status === 'pending') {
        const peers = groups.get(mid) ?? []
        const pays = peers.filter(x => x.data.kind === 'payment')
        const settled = (pays.length ? pays : peers.filter(x => x.data.kind === 'receipt')).reduce((n, x) => n + (x.data.amount ?? 0), 0)
        const pay = pays[0] ?? peers.find(x => x.data.kind === 'receipt')
        // 付够了才算已付（金额不符的留在待对账里）
        if (pay && (r.data.amount == null || settled + 0.01 >= r.data.amount)) {
          patch.status = 'paid'
          patch.paidAt = pay.data.paidAt ?? pay.createdAt
        }
      }
      if (!Object.keys(patch).length) continue
      const next = { ...r.data, ...patch }
      this.deps.store.updateInsight(r.id, { data: patch as Record<string, unknown>, status: rowStatusOf(next) })
      n++
    }
    return n
  }

  pair(ids: string[]): string | null {
    const rows = this.rows(false).filter(r => ids.includes(r.id))
    if (rows.length < 2) return null
    const mid = `mt-${rows[0].id}`.slice(0, 80)
    for (const r of rows) {
      const next: Partial<FinanceData> = { matchId: mid, matchLocked: true }
      if (r.data.kind === 'invoice' && r.data.status === 'pending' && rows.some(x => x.data.kind === 'payment' || x.data.kind === 'receipt')) next.status = 'paid'
      this.deps.store.updateInsight(r.id, { data: next as Record<string, unknown>, status: rowStatusOf({ ...r.data, ...next }) })
    }
    this.afterChange()
    return mid
  }

  unpair(ids: string[]) {
    for (const r of this.rows(false).filter(x => ids.includes(x.id))) {
      const next: Partial<FinanceData> = { matchId: null, matchLocked: true }
      if (r.data.kind === 'invoice' && r.data.status === 'paid') next.status = 'pending'
      this.deps.store.updateInsight(r.id, { data: next as Record<string, unknown>, status: rowStatusOf({ ...r.data, ...next }) })
    }
    this.afterChange()
  }

  // ---------------------------------------------------------------- 增删改

  list(): FinanceListResult {
    const rows = this.rows(false)
    return {
      records: rows.map(r => ({ id: r.id, kind: 'finance', messageId: r.data.messageIds[0] ?? null, accountId: r.accountId, title: r.title, status: r.status === 'done' ? 'done' : 'open', dueAt: r.dueAt, createdAt: r.createdAt, data: r.data as unknown as Record<string, unknown> })),
      idle: this.idleSubscriptions(rows)
    }
  }

  /** 可能闲置：订阅超过 60 天、近 90 天没打开过该商家的任何非账单邮件 */
  private idleSubscriptions(rows: FinanceRow[]): string[] {
    const now = Date.now()
    const out: string[] = []
    const q = this.deps.store.db.prepare(
      `SELECT id FROM messages WHERE date >= ? AND (lower(from_addr) LIKE ? OR lower(from_addr) LIKE ?) AND flags LIKE '%\\Seen%' LIMIT 40`
    )
    for (const r of rows) {
      const d = r.data
      if (d.kind !== 'subscription' || d.status === 'cancelled' || !d.domain) continue
      const first = d.events?.[0]?.at ?? r.createdAt
      if (now - first < 60 * DAY_MS) continue
      const opened = (q.all(now - 90 * DAY_MS, `%@${d.domain}`, `%.${d.domain}`) as { id: string }[]).filter(m => !d.messageIds.includes(m.id))
      if (!opened.length) out.push(r.id)
    }
    return out
  }

  create(input: FinanceInput): string {
    const now = Date.now()
    const d = input.data ?? {}
    const msgIds = [...new Set([...(d.messageIds ?? []), ...(input.messageId ? [input.messageId] : [])])]
    const data: FinanceData = {
      kind: d.kind ?? 'bill',
      direction: d.direction ?? 'out',
      counterparty: d.counterparty?.trim() || '未命名',
      amount: d.amount ?? null,
      currency: d.currency || 'CNY',
      status: d.status ?? 'pending',
      ...d,
      messageIds: msgIds,
      source: 'manual',
      events: d.events ?? [{ at: now, kind: 'note', label: '手动添加' }],
      updatedAt: now
    }
    const id = `fin-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const title = (input.title?.trim() || data.counterparty).slice(0, 120)
    this.deps.store.insertInsight({ id, kind: 'finance', accountId: input.accountId ?? null, messageId: msgIds[0] ?? null, title, data: data as unknown as Record<string, unknown>, dueAt: input.dueAt ?? data.dueAt ?? null })
    const st = rowStatusOf(data)
    if (st !== 'open') this.deps.store.setInsightStatus(id, st)
    for (const m of msgIds) this.index.set(m, id)
    this.afterChange()
    return id
  }

  update(id: string, patch: { title?: string; dueAt?: number | null; data?: Partial<FinanceData> }) {
    const cur = this.deps.store.getInsight(id)
    if (!cur || cur.kind !== 'finance') return
    const next = { ...(cur.data as unknown as FinanceData), ...(patch.data ?? {}) }
    if (patch.data?.matchId !== undefined) next.matchLocked = true
    for (const m of next.messageIds ?? []) this.index.set(m, id)
    this.deps.store.updateInsight(id, {
      title: patch.title,
      dueAt: patch.dueAt !== undefined ? patch.dueAt : patch.data?.dueAt !== undefined ? patch.data.dueAt : undefined,
      status: cur.status === 'dismissed' ? undefined : rowStatusOf(next),
      data: { ...(patch.data ?? {}), ...(patch.data?.matchId !== undefined ? { matchLocked: true } : {}) } as Record<string, unknown>
    })
    this.afterChange()
  }

  /** 删除 = 墓碑（关联邮件不会被再次自动收集）；手动新建的直接删 */
  remove(id: string) {
    const cur = this.deps.store.getInsight(id)
    if (!cur) return
    if ((cur.data as unknown as FinanceData).source === 'manual' && !((cur.data as unknown as FinanceData).messageIds ?? []).length) this.deps.store.deleteInsight(id)
    else this.deps.store.updateInsight(id, { status: 'dismissed' })
    this.afterChange()
  }

  markPaid(id: string, paid: boolean) {
    const cur = this.deps.store.getInsight(id)
    if (!cur) return
    const d = cur.data as unknown as FinanceData
    const now = Date.now()
    const events = [...(d.events ?? []), { at: now, kind: paid ? ('paid' as const) : ('note' as const), label: paid ? '手动标记已付' : '撤销已付' }]
    let next: Partial<FinanceData>
    let dueAt: number | null | undefined
    if (d.kind === 'subscription') {
      // 订阅「标记已付」= 本期已续费，顺延到下一期
      next = paid ? { status: 'paid', paidAt: now, events } : { status: 'pending', events }
      if (paid && d.cycle && cur.dueAt) {
        const t = new Date(cur.dueAt)
        if (d.cycle === 'weekly') t.setDate(t.getDate() + 7)
        else if (d.cycle === 'monthly') t.setMonth(t.getMonth() + 1)
        else if (d.cycle === 'quarterly') t.setMonth(t.getMonth() + 3)
        else if (d.cycle === 'yearly') t.setFullYear(t.getFullYear() + 1)
        dueAt = t.getTime()
      }
    } else next = paid ? { status: 'paid', paidAt: now, events } : { status: 'pending', paidAt: null, events }
    this.deps.store.updateInsight(id, { data: next as Record<string, unknown>, status: rowStatusOf({ ...d, ...next } as FinanceData), ...(dueAt !== undefined ? { dueAt } : {}) })
    // 关联的提醒待办随之完成
    if (paid && d.todoId) {
      const t = this.deps.store.getInsight(d.todoId)
      if (t && t.status === 'open') {
        this.deps.store.updateInsight(d.todoId, { status: 'done', data: { doneAt: now, doneBy: 'finance' } })
        this.deps.event({ type: 'todos-changed' })
        this.deps.onTodosChanged?.(d.todoId)
      }
    }
    this.afterChange()
  }

  /** 生成提醒待办（kind='todo'，来源邮件 + 应付日），记在 todoId 防重复 */
  makeTodo(id: string): string | null {
    const cur = this.deps.store.getInsight(id)
    if (!cur) return null
    const d = cur.data as unknown as FinanceData
    if (d.todoId) {
      const t = this.deps.store.getInsight(d.todoId)
      if (t && t.status !== 'dismissed') return d.todoId
    }
    const fmt = d.amount != null ? ` ${d.currency === 'CNY' ? '¥' : d.currency + ' '}${d.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''
    const verb = d.kind === 'subscription' ? (d.trialEndsAt && d.trialEndsAt > Date.now() ? '试用结束前决定是否续订' : '续费') : d.direction === 'in' ? '收款' : '付款'
    const title = `${verb}：${d.counterparty}${fmt}`
    const dueAt = d.kind === 'subscription' && d.trialEndsAt && d.trialEndsAt > Date.now() ? d.trialEndsAt : cur.dueAt
    const todoId = `todo-fin-${id}`.slice(0, 160)
    const data: TodoData = {
      from: 'mail',
      todoKind: 'task',
      minutes: 10,
      priority: dueAt && dueAt - Date.now() < 3 * DAY_MS ? 1 : 2,
      notes: `来自财务：${cur.title}`,
      tags: ['财务'],
      updatedAt: Date.now()
    }
    const row = this.deps.store.db.prepare('SELECT account_id FROM insights WHERE id = ?').get(id) as { account_id?: string } | undefined
    this.deps.store.insertInsight({ id: todoId, kind: 'todo', accountId: row?.account_id ?? null, messageId: d.messageIds[0] ?? null, title: title.slice(0, 120), data: data as Record<string, unknown>, dueAt: dueAt ?? null })
    this.deps.store.updateInsight(todoId, { status: 'open' })
    this.deps.store.updateInsight(id, { data: { todoId } })
    this.deps.event({ type: 'todos-changed' })
    this.deps.onTodosChanged?.(todoId)
    this.deps.event({ type: 'finance-changed' })
    return todoId
  }

  /** 手动「加入财务」：已收 → 返回所在款项；否则启发式 → AI → 兜底新建一条待补全的记录 */
  async fromMessage(messageId: string, entities?: MailInsight['entities']): Promise<{ id: string | null; created: boolean }> {
    this.ensureIndex()
    const existing = this.index.get(messageId)
    if (existing) {
      const cur = this.deps.store.getInsight(existing)
      if (cur && cur.status === 'dismissed') {
        this.deps.store.updateInsight(existing, { status: rowStatusOf(cur.data as unknown as FinanceData) })
        this.afterChange()
      }
      if (cur) return { id: existing, created: false }
    }
    const row = this.loadMessages([messageId])[0]
    if (!row) return { id: null, created: false }
    const input = this.inputOf(row, this.myAddrs(), entities)
    let c = detectFinance(input)
    if ((!c || c.uncertain) && aiReady(this.deps.getAISettings())) {
      try {
        c = (await this.aiCandidate(row, input)) ?? c
      } catch (err) {
        console.error('[finance] ai (manual) failed:', err)
      }
    }
    if (c) {
      const res = this.apply(c, row, this.rows(), c.confidence >= 0.75 && !c.uncertain ? 'ai' : 'heuristic')
      this.afterChange()
      return { id: this.index.get(messageId) ?? null, created: res === 'created' }
    }
    const domain = rootDomain(row.from_addr ?? '')
    const id = this.create({
      title: row.subject || row.from_name || '款项',
      accountId: row.account_id,
      messageId,
      data: { kind: 'bill', counterparty: (row.from_name || domain || '未知').slice(0, 40), domain, notes: '手动加入，金额与日期待补全' }
    })
    return { id, created: true }
  }

  /** 关联邮件的摘要（详情页「全部关联邮件」） */
  messages(ids: string[]): { id: string; subject: string; from: string; date: number; accountId: string; seen: boolean }[] {
    const uniq = [...new Set(ids)].slice(0, 200)
    if (!uniq.length) return []
    const rows = this.deps.store.db
      .prepare(`SELECT id, subject, from_name, from_addr, date, account_id, flags FROM messages WHERE id IN (${uniq.map(() => '?').join(',')})`)
      .all(...uniq) as any[]
    return rows
      .map(r => ({ id: r.id, subject: r.subject ?? '', from: r.from_name || r.from_addr || '', date: r.date ?? 0, accountId: r.account_id, seen: String(r.flags ?? '').includes('\\Seen') }))
      .sort((a, b) => a.date - b.date)
  }
}
