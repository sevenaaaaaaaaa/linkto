/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AISettings, InsightRecord, LifeCategory, LifeData, MailInsight, TodoData } from '@shared/types'
import { actionFromOf, daysUntil, defaultRepeat, LIFE_CATEGORIES, LIFE_CATEGORY_LABEL, maskReference, normRemindDays, scrubSensitive, startOfDay, DAY_MS } from '@shared/life'
import type { MailStore } from '../db'
import type { AIService } from '../ai/service'
import { aiReady } from '../ai/service'
import { LIFE_EXTRACT } from '../ai/prompts'
import { readAttachmentText } from '../agent/hooks'
import { allowsAI } from '../attachments/access'
import { runAsBackground, isBudgetError } from '../jobs/budget'
import { bodyOf } from '../finance/detect'
import { acceptLife, detectLife, looksLife, type LifeCandidate, type LifeMailInput } from './detect'
import { completeLife, findLifeMerge, mergeLife, newLifeData, type LifeRow } from './merge'
import { jsonFromText, lifeFromAi } from './ai-map'
import { lifeReminder, type LifeReminder } from './plan'

const SKIP_FOLDERS = new Set(['trash', 'junk', 'drafts'])
/** 附件名像保单 / 合同 / 保修卡 / 证书：值得读 PDF 正文找到期日 */
const DOC_FILE_RE = /(保单|保险|policy|合同|协议|contract|agreement|lease|租赁|租房|保修|质保|warranty|证书|certificate|年检|检验|签证|visa|passport|护照|renewal|续保|续期)/i

interface MsgRow {
  id: string
  account_id: string
  folder_special: string | null
  from_name: string | null
  from_addr: string | null
  subject: string | null
  snippet: string | null
  text: string | null
  html: string | null
  date: number
  category: string | null
  is_newsletter: number
  body_fetched: number
}

interface AttRow {
  id: string
  filename: string
  contentType: string
  inline: boolean
}

export interface LifeScanResult {
  created: number
  merged: number
  scanned: number
  ok?: boolean
  error?: string
  createdIds?: string[]
}

/** 扫描时的限速：一次回填最多读多少个 PDF / 发多少次 AI */
interface ScanBudget {
  pdf: number
  ai: number
}

/**
 * 生活档案主进程服务（insights kind='life'）：
 *  - 自动收集：邮件理解完成（onInsight）→ 排队 → 启发式识别（必要时读 PDF 附件正文）→ 归并 / 新建；拿不准且 AI 可用时补一次 AI（走后台用量闸门）
 *  - 幂等：messageId → 事务索引（含已删除的墓碑，不复活）
 *  - 回填：扫描最近 N 天（进度经 life-scan 事件推送，限速：分批让出事件循环，PDF / AI 有上限）
 *  - 与财务：订阅类已在财务里的不重复建；关联到财务的记 financeId（日历上合并显示，不复制数据）
 *  - 与附件中心：合同 / 保单类附件记 attachmentIds
 */
export class LifeService {
  private index = new Map<string, string>()
  private checked = new Map<string, 'heuristic' | 'ai'>()
  private pending = new Map<string, MailInsight>()
  private timer: NodeJS.Timeout | null = null
  private flushing = false
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
      onTodosChanged?(id: string): void
    }
  ) {}

  // ---------------------------------------------------------------- 数据访问

  rows(includeDismissed = true): LifeRow[] {
    const list = this.deps.store.db
      .prepare(`SELECT * FROM insights WHERE kind = 'life' ${includeDismissed ? '' : "AND status != 'dismissed'"} ORDER BY created_at DESC`)
      .all() as any[]
    return list.map(r => {
      let data: LifeData
      try {
        data = JSON.parse(r.data_json || '{}')
      } catch {
        data = {} as LifeData
      }
      data.messageIds ??= []
      data.remindDays ??= []
      if (!LIFE_CATEGORIES.includes(data.category)) data.category = 'other'
      return { id: r.id, title: r.title, status: r.status ?? 'open', dueAt: r.due_at ?? null, createdAt: Number(r.created_at) || 0, accountId: r.account_id ?? null, data }
    })
  }

  get(id: string): LifeRow | null {
    return this.rows().find(r => r.id === id) ?? null
  }

  list(): InsightRecord[] {
    return this.rows(false).map(r => ({
      id: r.id,
      kind: 'life',
      messageId: r.data.messageIds[0] ?? null,
      accountId: r.accountId,
      title: r.title,
      status: r.status === 'done' ? 'done' : 'open',
      dueAt: r.dueAt,
      createdAt: r.createdAt,
      data: r.data as unknown as Record<string, unknown>
    }))
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
            `SELECT m.id, m.account_id, f.special AS folder_special, m.from_name, m.from_addr, m.subject, m.snippet,
                    substr(coalesce(m.text,''), 1, 8000) AS text, substr(m.html, 1, 80000) AS html, m.date, m.category,
                    m.is_newsletter, m.body_fetched
             FROM messages m LEFT JOIN folders f ON f.id = m.folder_id
             WHERE m.id IN (${part.map(() => '?').join(',')})`
          )
          .all(...part) as unknown as MsgRow[])
      )
    }
    return out
  }

  private attachmentsOf(messageId: string): AttRow[] {
    try {
      return (this.deps.store.db.prepare('SELECT id, filename, content_type, inline FROM attachments WHERE message_id = ? LIMIT 20').all(messageId) as any[]).map(r => ({
        id: r.id,
        filename: r.filename ?? '',
        contentType: r.content_type ?? '',
        inline: !!r.inline
      }))
    } catch {
      return []
    }
  }

  /** 附件中心已归为「合同 / 发票」等分类的附件（关联用；表不存在时为空） */
  private indexedDocs(messageId: string): string[] {
    try {
      return (this.deps.store.db.prepare("SELECT id FROM attachment_index WHERE message_id = ? AND category IN ('contract') LIMIT 10").all(messageId) as { id: string }[]).map(r => r.id)
    } catch {
      return []
    }
  }

  /** 这封邮件在财务里属于哪笔（订阅类的不重复建） */
  private financeOf(messageId: string): { id: string; kind: string; cycle: string | null } | null {
    try {
      const rows = this.deps.store.db
        .prepare("SELECT id, data_json FROM insights WHERE kind = 'finance' AND status != 'dismissed' AND instr(data_json, ?) > 0 LIMIT 5")
        .all(JSON.stringify(messageId)) as { id: string; data_json: string }[]
      for (const r of rows) {
        const d = JSON.parse(r.data_json || '{}')
        if (Array.isArray(d.messageIds) && d.messageIds.includes(messageId)) return { id: r.id, kind: String(d.kind ?? ''), cycle: d.cycle ?? null }
      }
    } catch {
      /* 财务表读不到不影响 */
    }
    return null
  }

  private inputOf(row: MsgRow, mine: Set<string>, attachmentText?: string | null, names?: string[]): LifeMailInput {
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
      isNewsletter: !!row.is_newsletter,
      category: row.category,
      attachmentText: attachmentText ?? null,
      attachmentNames: names ?? []
    }
  }

  /** 预筛：主题 / 正文开头像生活事务，或带着像保单 / 合同的 PDF */
  private worthLooking(row: MsgRow, atts: AttRow[]): { hit: boolean; pdfs: AttRow[] } {
    const snippet = `${row.snippet ?? ''}\n${(row.text ?? '').slice(0, 1500)}`
    const pdfs = atts.filter(a => !a.inline && /pdf|text\/plain|\.txt$/i.test(`${a.contentType} ${a.filename}`))
    const textHit = looksLife(row.subject ?? '', snippet)
    const fileHit = pdfs.some(a => DOC_FILE_RE.test(a.filename))
    return { hit: textHit || fileHit, pdfs: textHit || fileHit ? pdfs.filter(a => DOC_FILE_RE.test(a.filename) || textHit).slice(0, 2) : [] }
  }

  private async pdfText(pdfs: AttRow[], budget: ScanBudget | null): Promise<{ text: string | null; ids: string[] }> {
    const parts: string[] = []
    const ids: string[] = []
    for (const a of pdfs) {
      if (budget && budget.pdf <= 0) break
      if (budget) budget.pdf--
      const t = await readAttachmentText(a.id, 6000)
      if (t && t.trim()) {
        parts.push(t.trim())
        ids.push(a.id)
      }
    }
    return { text: parts.length ? parts.join('\n\n').slice(0, 8000) : null, ids }
  }

  // ---------------------------------------------------------------- 自动收集

  /** 邮件理解结果回调（每次列表加载都会调，必须便宜：只做 Map 判断后排队） */
  onInsight(ins: MailInsight) {
    const seen = this.checked.get(ins.messageId)
    if (seen && (seen === 'ai' || ins.source === 'heuristic')) return
    this.pending.set(ins.messageId, ins)
    // 比财务晚一点：财务先收订阅，生活档案据此不重复建
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), 1200)
  }

  private async flush() {
    this.timer = null
    if (this.flushing) {
      this.timer = setTimeout(() => void this.flush(), 1200)
      return
    }
    const batch = [...this.pending.values()].slice(0, 200)
    for (const b of batch) this.pending.delete(b.messageId)
    if (this.pending.size) this.timer = setTimeout(() => void this.flush(), 1200)
    if (!batch.length) return
    this.flushing = true
    let changed = 0
    try {
      this.ensureIndex()
      const rows = this.loadMessages(batch.map(b => b.messageId))
      const byId = new Map(batch.map(b => [b.messageId, b]))
      const mine = this.myAddrs()
      const budget: ScanBudget = { pdf: 6, ai: 20 }
      for (const row of rows.sort((a, b) => a.date - b.date)) {
        const ins = byId.get(row.id)
        if (!ins) continue
        if (!row.body_fetched && !row.text && !row.html) continue
        this.checked.set(row.id, ins.source)
        if (this.index.has(row.id)) continue
        if (SKIP_FOLDERS.has(row.folder_special ?? '')) continue
        const res = await this.ingest(row, mine, budget, true)
        if (res !== 'skip') changed++
      }
    } catch (err) {
      console.error('[life] collect failed:', err)
    } finally {
      this.flushing = false
    }
    if (changed) this.changed()
  }

  /** 识别 + 归并一封邮件 */
  private async ingest(row: MsgRow, mine: Set<string>, budget: ScanBudget | null, allowAi: boolean): Promise<'created' | 'merged' | 'skip'> {
    const atts = this.attachmentsOf(row.id)
    const look = this.worthLooking(row, atts)
    if (!look.hit) return 'skip'
    let input = this.inputOf(row, mine, null, atts.map(a => a.filename))
    let c = detectLife(input)
    let pdfIds: string[] = []
    // 缺日期 / 只有附件像保单：读 PDF 正文再判一次
    if (look.pdfs.length && (!c || !c.expiresAt)) {
      const p = await this.pdfText(look.pdfs, budget)
      if (p.text) {
        input = this.inputOf(row, mine, p.text, atts.map(a => a.filename))
        c = detectLife(input) ?? c
        pdfIds = p.ids
      }
    }
    if (!c) return 'skip'
    if (c.uncertain && allowAi && this.aiBackground() && (!budget || budget.ai > 0)) {
      if (budget) budget.ai--
      this.queueAi(row.id)
    }
    return this.apply(c, row, input.date, 'heuristic', pdfIds)
  }

  private apply(c: LifeCandidate, row: MsgRow, mailDate: number, source: 'heuristic' | 'ai', pdfIds: string[] = []): 'created' | 'merged' | 'skip' {
    const rows = this.rows(false)
    const target = findLifeMerge(c, rows)
    const fin = this.financeOf(row.id)
    const docs = [...new Set([...pdfIds, ...this.indexedDocs(row.id)])]
    if (target) {
      const m = mergeLife(target, c, row.id, mailDate)
      if (fin && !target.data.financeId) m.patch.financeId = fin.id
      // 关联了财务订阅、费用从财务读的：不复制金额
      if ((target.data.financeId || fin?.kind === 'subscription') && target.data.amount == null) {
        delete m.patch.amount
        delete m.patch.currency
      }
      if (docs.length) m.patch.attachmentIds = [...new Set([...(target.data.attachmentIds ?? []), ...docs])]
      this.deps.store.updateInsight(target.id, { data: m.patch as Record<string, unknown>, dueAt: m.dueAt, ...(m.status ? { status: m.status } : {}) })
      this.index.set(row.id, target.id)
      return 'merged'
    }
    if (!acceptLife(c)) return 'skip'
    // 订阅类已在财务里：按月 / 周 / 季自动扣费的不重复建（财务的续费会叠加显示在生活档案的日历上）；
    // 年费类（健身年卡、域名）建一条并关联 financeId，费用从财务读、不复制
    if (fin?.kind === 'subscription' && fin.cycle && fin.cycle !== 'yearly' && fin.cycle !== 'once') return 'skip'
    const rec = newLifeData(c, row.id, mailDate, source, { attachmentIds: docs, financeId: fin?.id ?? null })
    if (fin?.kind === 'subscription') {
      rec.data.amount = null
      rec.data.currency = null
    }
    // 同一张卡 / 证件已经过期很久且不循环的旧通知：不建
    if (rec.dueAt && rec.dueAt < Date.now() - 180 * DAY_MS && !rec.data.repeat) return 'skip'
    if (rec.dueAt && rec.data.repeat && rec.dueAt < Date.now() - DAY_MS && c.event !== 'renewed') {
      // 回填到的旧一期提醒（如去年的续保通知）：按循环推到当前这一期，标记为推断
      let t = rec.dueAt
      for (let i = 0; i < 50 && t < Date.now() - DAY_MS; i++) t = completeLife({ dueAt: t, data: rec.data }, Date.now()).expiresAt ?? t
      rec.dueAt = t
      rec.data.expiresAt = t
      rec.data.actionFrom = actionFromOf(t, rec.data.category, rec.data.subject)
      rec.data.notes = '按循环从历史邮件推断的下一期，收到新通知后会自动更新'
    }
    const id = `life-${mailDate.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    this.deps.store.insertInsight({ id, kind: 'life', accountId: row.account_id, messageId: row.id, title: scrubSensitive(rec.title), data: rec.data as unknown as Record<string, unknown>, dueAt: rec.dueAt })
    if (rec.status === 'done') this.deps.store.setInsightStatus(id, 'done')
    this.index.set(row.id, id)
    return 'created'
  }

  private changed() {
    this.deps.event({ type: 'life-changed' })
  }

  // ---------------------------------------------------------------- AI 补充

  private aiBackground(): boolean {
    const s = this.deps.getAISettings()
    return aiReady(s, false) && s.autoUnderstand !== false
  }

  private queueAi(id: string) {
    if (this.aiQueued.has(id) || this.aiQueue.length > 40) return
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
          // 后台用量闸门：超过每日上限 / 只在接通电源时，直接停
          const res = await runAsBackground('life', () => this.runAi(id))
          if (res !== 'skip') this.changed()
        } catch (err) {
          if (isBudgetError(err)) {
            this.aiQueue.length = 0
            break
          }
          console.error('[life] ai failed:', err instanceof Error ? err.message : err)
        }
      }
    } finally {
      this.aiBusy = false
    }
  }

  private async aiCandidate(row: MsgRow, input: LifeMailInput): Promise<LifeCandidate | null> {
    const h = detectLife(input)
    const body = bodyOf(input).slice(0, 3500)
    // 附件正文只在允许交给当前 AI 时才带上（本机规则识别不受影响）
    const attach = input.attachmentText && allowsAI() ? `\n附件正文：\n${input.attachmentText.slice(0, 2500)}` : ''
    const user = `发件人：${input.fromName} <${input.fromAddr}>\n日期：${new Date(input.date).toISOString().slice(0, 10)}\n主题：${input.subject}\n正文：\n${body}${attach}`
    const text = await this.deps.ai.complete(
      [
        { role: 'system', content: LIFE_EXTRACT },
        { role: 'user', content: user }
      ],
      600
    )
    return lifeFromAi(jsonFromText(text), h, `${input.subject}\n${body}\n${input.attachmentText ?? ''}`, input.date)
  }

  private async runAi(id: string): Promise<'created' | 'merged' | 'skip'> {
    const row = this.loadMessages([id])[0]
    if (!row) return 'skip'
    const atts = this.attachmentsOf(id)
    const look = this.worthLooking(row, atts)
    const p = look.pdfs.length ? await this.pdfText(look.pdfs, null) : { text: null, ids: [] }
    const input = this.inputOf(row, this.myAddrs(), p.text)
    const existing = this.index.get(id)
    const c = await this.aiCandidate(row, input)
    if (!c) return 'skip'
    if (existing) {
      // 启发式已收：AI 只补缺的到期日 / 费用
      const cur = this.get(existing)
      if (!cur || cur.status === 'dismissed') return 'skip'
      const patch: Partial<LifeData> = {}
      let dueAt: number | undefined
      if (!cur.dueAt && c.expiresAt) {
        dueAt = c.expiresAt
        patch.expiresAt = c.expiresAt
        patch.actionFrom = actionFromOf(c.expiresAt, cur.data.category, cur.data.subject)
      }
      if (cur.data.amount == null && c.amount != null) {
        patch.amount = c.amount
        patch.currency = c.currency
      }
      if (!Object.keys(patch).length) return 'skip'
      this.deps.store.updateInsight(existing, { data: patch as Record<string, unknown>, ...(dueAt !== undefined ? { dueAt } : {}) })
      return 'merged'
    }
    const res = this.apply(c, row, row.date || Date.now(), 'ai', p.ids)
    if (res !== 'skip') this.checked.set(id, 'ai')
    return res
  }

  // ---------------------------------------------------------------- 回填

  /** 扫描最近 N 天（一次性回填）；进度经 life-scan 事件推送 */
  async scan(days: number, opts: { maxAi?: number; maxPdf?: number } = {}): Promise<LifeScanResult> {
    if (this.scanning) return { ok: false, error: '正在扫描', scanned: 0, created: 0, merged: 0 }
    this.scanning = true
    const since = Date.now() - Math.max(1, Math.min(3650, Math.round(Number(days) || 730))) * DAY_MS
    let created = 0
    let merged = 0
    let scanned = 0
    const createdIds: string[] = []
    const budget: ScanBudget = { pdf: opts.maxPdf ?? 40, ai: opts.maxAi ?? 30 }
    try {
      this.ensureIndex()
      const ids = this.deps.store.db
        .prepare(
          `SELECT m.id FROM messages m LEFT JOIN folders f ON f.id = m.folder_id
           WHERE m.date >= ? AND coalesce(f.special, '') NOT IN ('trash', 'junk', 'drafts')
           ORDER BY m.date ASC`
        )
        .all(since) as { id: string }[]
      const total = ids.length
      const mine = this.myAddrs()
      this.deps.event({ type: 'life-scan', done: 0, total, created, merged, finished: false })
      for (let i = 0; i < ids.length; i += 40) {
        const part = ids.slice(i, i + 40).filter(r => !this.index.has(r.id))
        const rows = this.loadMessages(part.map(p => p.id)).sort((a, b) => a.date - b.date)
        for (const row of rows) {
          this.checked.set(row.id, 'heuristic')
          const before = new Set(this.index.values())
          const res = await this.ingest(row, mine, budget, true)
          if (res === 'created') {
            created++
            const id = this.index.get(row.id)
            if (id && !before.has(id)) createdIds.push(id)
          }
          if (res === 'merged') merged++
        }
        scanned = Math.min(total, i + 40)
        this.deps.event({ type: 'life-scan', done: scanned, total, created, merged, finished: false })
        // 让出主进程事件循环（大批量回填不卡界面）
        await new Promise(r => setImmediate(r))
      }
      this.changed()
      this.deps.event({ type: 'life-scan', done: total, total, created, merged, finished: true })
      return { ok: true, scanned: total, created, merged, createdIds }
    } catch (err) {
      this.deps.event({ type: 'life-scan', done: scanned, total: scanned, created, merged, finished: true, error: String(err) })
      return { ok: false, error: err instanceof Error ? err.message : String(err), scanned, created, merged, createdIds }
    } finally {
      this.scanning = false
    }
  }

  /** 每日整理：补扫最近几天 + 补关联财务；返回给自动任务一句话用的数字 */
  async organize(days = 2): Promise<{ ok: boolean; error?: string; created: string[]; merged: number; scanned: number; upcoming: LifeRow[]; overdue: LifeRow[]; linked: number }> {
    const r = await this.scan(days, { maxAi: 10, maxPdf: 10 })
    let linked = 0
    for (const row of this.rows(false)) {
      if (row.data.financeId) continue
      for (const m of row.data.messageIds) {
        const fin = this.financeOf(m)
        if (fin) {
          this.deps.store.updateInsight(row.id, { data: { financeId: fin.id } })
          linked++
          break
        }
      }
    }
    if (linked) this.changed()
    const now = Date.now()
    const open = this.rows(false).filter(x => x.status === 'open' && x.dueAt)
    return {
      ok: r.ok !== false,
      error: r.error,
      created: r.createdIds ?? [],
      merged: r.merged,
      scanned: r.scanned,
      upcoming: open.filter(x => daysUntil(x.dueAt!, now) >= 0 && daysUntil(x.dueAt!, now) <= 30),
      overdue: open.filter(x => daysUntil(x.dueAt!, now) < 0),
      linked
    }
  }

  // ---------------------------------------------------------------- 提醒

  /** 本分钟该发的提醒（调用方负责发通知；这里只算并记 reminded） */
  dueReminders(now = Date.now()): { id: string; reminder: LifeReminder }[] {
    const out: { id: string; reminder: LifeReminder }[] = []
    for (const r of this.rows(false)) {
      const rem = lifeReminder(r, now)
      if (!rem) continue
      const keys = [...new Set([...(r.data.reminded ?? []), ...rem.keys])].slice(-24)
      this.deps.store.updateInsight(r.id, { data: { reminded: keys } })
      out.push({ id: r.id, reminder: rem })
    }
    return out
  }

  // ---------------------------------------------------------------- 增删改

  private clean(input: Partial<LifeData>, category: LifeCategory): Partial<LifeData> {
    const out: Partial<LifeData> = { ...input }
    if (out.category !== undefined && !LIFE_CATEGORIES.includes(out.category)) out.category = 'other'
    if (out.subject !== undefined) out.subject = scrubSensitive(String(out.subject ?? '')).slice(0, 60) || '未命名'
    if (out.provider !== undefined) out.provider = out.provider ? scrubSensitive(String(out.provider)).slice(0, 40) : null
    if (out.reference !== undefined) out.reference = maskReference(out.reference, out.category ?? category)
    if (out.notes !== undefined) out.notes = out.notes ? scrubSensitive(String(out.notes)).slice(0, 2000) : null
    if (out.remindDays !== undefined) out.remindDays = normRemindDays(out.remindDays, out.category ?? category)
    if (out.repeat !== undefined) {
      const r = out.repeat as any
      out.repeat = r && (r.every === 'year' || r.every === 'month') ? { every: r.every, interval: Math.max(1, Math.min(10, Math.round(Number(r.interval) || 1))) } : null
    }
    if (out.amount !== undefined) out.amount = out.amount == null || !Number.isFinite(Number(out.amount)) ? null : Math.round(Number(out.amount) * 100) / 100
    for (const k of ['expiresAt', 'actionFrom'] as const) if (out[k] !== undefined) out[k] = out[k] == null || !Number.isFinite(Number(out[k])) ? null : Number(out[k])
    // 系统字段不让外部改
    delete (out as any).reminded
    delete (out as any).source
    return out
  }

  create(input: { title?: string; dueAt?: number | null; data: Partial<LifeData> }, accountId: string | null = null): string {
    const now = Date.now()
    const category: LifeCategory = LIFE_CATEGORIES.includes(input.data?.category as LifeCategory) ? (input.data.category as LifeCategory) : 'other'
    const d = this.clean(input.data ?? {}, category)
    const expiresAt = input.dueAt !== undefined ? input.dueAt : d.expiresAt ?? null
    const subject = d.subject || scrubSensitive(input.title ?? '').slice(0, 60) || LIFE_CATEGORY_LABEL[category]
    const msgIds = [...new Set((input.data?.messageIds ?? []).map(String))]
    const data: LifeData = {
      category,
      subject,
      provider: d.provider ?? null,
      expiresAt,
      actionFrom: d.actionFrom !== undefined ? d.actionFrom : actionFromOf(expiresAt, category, subject),
      repeat: d.repeat !== undefined ? d.repeat : defaultRepeat(category),
      remindDays: d.remindDays ?? normRemindDays(null, category),
      reminded: [],
      reference: d.reference ?? null,
      amount: d.amount ?? null,
      currency: d.amount != null ? d.currency || 'CNY' : null,
      messageIds: msgIds,
      attachmentIds: input.data?.attachmentIds ?? [],
      financeId: input.data?.financeId ?? null,
      todoId: null,
      source: 'manual',
      notes: d.notes ?? null,
      updatedAt: now
    }
    const id = `life-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const title = scrubSensitive(input.title?.trim() || subject).slice(0, 120)
    let acct = accountId
    if (!acct && msgIds[0]) acct = (this.deps.store.db.prepare('SELECT account_id FROM messages WHERE id = ?').get(msgIds[0]) as { account_id?: string } | undefined)?.account_id ?? null
    this.deps.store.insertInsight({ id, kind: 'life', accountId: acct, messageId: msgIds[0] ?? null, title, data: data as unknown as Record<string, unknown>, dueAt: expiresAt })
    this.ensureIndex()
    for (const m of msgIds) this.index.set(m, id)
    this.changed()
    return id
  }

  update(id: string, patch: { title?: string; dueAt?: number | null; status?: 'open' | 'done'; data?: Partial<LifeData> }) {
    const cur = this.get(id)
    if (!cur) return
    const d = this.clean(patch.data ?? {}, patch.data?.category ?? cur.data.category)
    let dueAt: number | null | undefined = patch.dueAt !== undefined ? patch.dueAt : d.expiresAt !== undefined ? d.expiresAt : undefined
    if (dueAt !== undefined) d.expiresAt = dueAt
    // 改了到期日 / 类别而没指定 actionFrom：按类别重算建议办理日
    if ((dueAt !== undefined || d.category !== undefined) && d.actionFrom === undefined) {
      d.actionFrom = actionFromOf(dueAt !== undefined ? dueAt : cur.dueAt, d.category ?? cur.data.category, d.subject ?? cur.data.subject)
    }
    // 改了类别而没指定提醒天数：换成新类别的默认
    if (d.category !== undefined && d.category !== cur.data.category && d.remindDays === undefined) d.remindDays = normRemindDays(null, d.category)
    let status: string | undefined
    if (patch.status === 'done' && cur.status !== 'done') {
      const merged = { ...cur, dueAt: dueAt !== undefined ? dueAt : cur.dueAt, data: { ...cur.data, ...d } as LifeData }
      const c = completeLife(merged, Date.now())
      status = c.status
      if (c.expiresAt !== merged.dueAt) {
        dueAt = c.expiresAt
        d.expiresAt = c.expiresAt
        d.actionFrom = actionFromOf(c.expiresAt, merged.data.category, merged.data.subject)
      }
      this.finishTodo(cur.data.todoId)
      // 循环事务滚到下一期：旧的提醒待办已完成，下一期需要时再生成
      if (status === 'open') d.todoId = null
    } else if (patch.status === 'open') status = 'open'
    for (const m of (patch.data?.messageIds ?? []) as string[]) this.index.set(m, id)
    this.deps.store.updateInsight(id, {
      title: patch.title !== undefined ? scrubSensitive(patch.title).slice(0, 120) : undefined,
      dueAt,
      status,
      data: d as Record<string, unknown>
    })
    this.changed()
  }

  private finishTodo(todoId: string | null | undefined) {
    if (!todoId) return
    const t = this.deps.store.getInsight(todoId)
    if (t && t.status === 'open') {
      this.deps.store.updateInsight(todoId, { status: 'done', data: { doneAt: Date.now(), doneBy: 'life' } })
      this.deps.event({ type: 'todos-changed' })
      this.deps.onTodosChanged?.(todoId)
    }
  }

  /** 删除 = 墓碑（关联邮件不会被再次自动收集）；手动新建且没关联邮件的直接删 */
  remove(id: string) {
    const cur = this.get(id)
    if (!cur) return
    if (cur.data.source === 'manual' && !cur.data.messageIds.length) this.deps.store.deleteInsight(id)
    else this.deps.store.updateInsight(id, { status: 'dismissed' })
    this.changed()
  }

  /** 生成待办（kind='todo'，dueAt = 建议办理日（还没到时）或到期日），记 todoId 防重复；经待办外部同步进入提醒事项 / 日历 */
  makeTodo(id: string): string | null {
    const cur = this.get(id)
    if (!cur) return null
    const d = cur.data
    if (d.todoId) {
      const t = this.deps.store.getInsight(d.todoId)
      if (t && t.status !== 'dismissed') return d.todoId
    }
    const now = Date.now()
    const verb: Record<LifeCategory, string> = {
      'id-document': '办理换证',
      insurance: '续保',
      vehicle: '办理',
      membership: '决定是否续费',
      domain: '续费',
      warranty: '保修到期前检查',
      contract: '决定是否续签',
      housing: '处理',
      tax: '完成申报',
      health: '赴约',
      education: '缴费 / 报名',
      card: '处理',
      other: '处理'
    }
    const target = cur.dueAt
    const due = d.actionFrom && d.actionFrom > now ? d.actionFrom : target
    const day = target ? new Date(target).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''
    const title = `${verb[d.category]}：${d.subject}${day ? `（${day} 到期）` : ''}`.slice(0, 120)
    const todoId = `todo-life-${id}`.slice(0, 160)
    const data: TodoData = {
      from: 'mail',
      todoKind: 'task',
      minutes: 20,
      priority: target && target - now < 14 * DAY_MS ? 1 : 2,
      notes: [`来自生活档案：${cur.title}`, d.provider ? `机构：${d.provider}` : '', d.reference ? `编号：${d.reference}` : '', target ? `到期：${new Date(target).toLocaleDateString('zh-CN')}` : ''].filter(Boolean).join('\n'),
      tags: ['生活档案'],
      updatedAt: now
    }
    this.deps.store.insertInsight({ id: todoId, kind: 'todo', accountId: cur.accountId, messageId: d.messageIds[0] ?? null, title, data: data as Record<string, unknown>, dueAt: due ? startOfDay(due) + 10 * 3600_000 : null })
    this.deps.store.updateInsight(todoId, { status: 'open' })
    this.deps.store.updateInsight(id, { data: { todoId } })
    this.deps.event({ type: 'todos-changed' })
    this.deps.onTodosChanged?.(todoId)
    this.changed()
    return todoId
  }

  /** 阅读页「加入生活档案」：已收 → 返回所在事务；否则启发式 → AI → 兜底新建一条待补全的 */
  async fromMessage(messageId: string): Promise<{ id: string | null; created: boolean }> {
    this.ensureIndex()
    const existing = this.index.get(messageId)
    if (existing) {
      const cur = this.get(existing)
      if (cur && cur.status === 'dismissed') {
        this.deps.store.updateInsight(existing, { status: 'open' })
        this.changed()
      }
      if (cur) return { id: existing, created: false }
    }
    const row = this.loadMessages([messageId])[0]
    if (!row) return { id: null, created: false }
    const atts = this.attachmentsOf(messageId)
    const pdfs = atts.filter(a => !a.inline && /pdf|text\/plain/i.test(`${a.contentType} ${a.filename}`)).slice(0, 2)
    const p = pdfs.length ? await this.pdfText(pdfs, null) : { text: null, ids: [] }
    const input = this.inputOf(row, new Set(), p.text)
    let c = detectLife(input)
    if ((!c || c.uncertain) && aiReady(this.deps.getAISettings())) {
      try {
        c = (await this.aiCandidate(row, input)) ?? c
      } catch (err) {
        console.error('[life] ai (manual) failed:', err instanceof Error ? err.message : err)
      }
    }
    if (c) {
      const target = findLifeMerge(c, this.rows(false))
      if (target || c.expiresAt) {
        // 用户主动加入：不受「订阅已在财务里」与把握门槛限制
        const res = target ? this.apply(c, row, row.date, 'heuristic', p.ids) : this.forceCreate(c, row, p.ids)
        this.changed()
        return { id: this.index.get(messageId) ?? null, created: res === 'created' }
      }
    }
    const id = this.create({
      title: row.subject || '生活事务',
      data: { category: c?.category ?? 'other', subject: c?.subject ?? (row.subject || '生活事务').slice(0, 40), provider: c?.provider ?? row.from_name ?? null, messageIds: [messageId], attachmentIds: p.ids, notes: '手动加入，到期日待补全' }
    }, row.account_id)
    return { id, created: true }
  }

  private forceCreate(c: LifeCandidate, row: MsgRow, pdfIds: string[]): 'created' {
    const fin = this.financeOf(row.id)
    const rec = newLifeData(c, row.id, row.date, c.reason.includes('AI') ? 'ai' : 'heuristic', { attachmentIds: [...pdfIds, ...this.indexedDocs(row.id)], financeId: fin?.id ?? null })
    const id = `life-${(row.date || Date.now()).toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    this.deps.store.insertInsight({ id, kind: 'life', accountId: row.account_id, messageId: row.id, title: scrubSensitive(rec.title), data: rec.data as unknown as Record<string, unknown>, dueAt: rec.dueAt })
    if (rec.status === 'done') this.deps.store.setInsightStatus(id, 'done')
    this.index.set(row.id, id)
    return 'created'
  }
}
