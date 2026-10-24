import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Rule, RuleAction, RuleActionType, RuleCondition, RuleField, RuleOp, RuleSuggestion } from '@shared/types'
import type { MailStore } from '../db'
import { ruleMatches, type RuleEvalContext } from '../rules/engine'
import { logActivity } from '../agent/hooks'
import { RULE_MINE } from '../ai/prompts'
import { jsonFromText } from '../ai/insights'
import { ensureRuleSuggestTables, loadEvents, logReadSignal, pruneLog, type ReadSignal } from './log'
import { mineOpenNoRead } from './dwell'
import { blockedByHistory, coveredByRules, DAY_MS, fingerprint, messageCtx, mineSuggestions, WINDOW_DAYS, type Candidate, type MineMessage, type SuggestionHistory } from './mine'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 一次最多保留几条待处理建议（克制：宁少勿多） */
const MAX_OPEN = 5
/** 「同时处理现有邮件」一次最多处理多少封 */
const APPLY_LIMIT = 300
/** 忽略（非永久）的冷却期 */
const COOLDOWN_MS = 30 * DAY_MS

/** AI 挖掘一次最多提几条（比启发式更克制，毕竟没有统计门槛兜底） */
const AI_MAX = 3

export interface RuleSuggestDeps {
  db: DatabaseSync
  store: MailStore
  /** 调用 ipc.ts 已注册的处理器（saveRule：保存并让同步引擎立即生效） */
  call(method: string, args: unknown[]): Promise<unknown>
  /** 规则动作执行（与新邮件命中规则同一实现） */
  runRuleActions(messageId: string, actions: RuleAction[]): Promise<void>
  event(payload: unknown): void
  /** 可选：AI 服务（结构化 complete），规则 AI 挖掘任务用；与 AIService 结构兼容即可 */
  ai?: { complete(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], maxTokens: number): Promise<string> }
}

interface StoredData extends Omit<RuleSuggestion, 'id' | 'status' | 'fingerprint' | 'createdAt' | 'matchCount' | 'sampleMessageIds'> {
  /** 证据邮件的比对上下文（判断后来手动建的规则是否已覆盖） */
  contexts?: RuleEvalContext[]
  eventMessageIds?: string[]
  days?: number
  total?: number
  /** 建议来源；旧数据（启发式时代）缺省按 heuristic 处理 */
  source?: 'heuristic' | 'ai'
}

/** 挖掘候选落库所需的最小字段（启发式 Candidate 与 AI 候选共用） */
type PersistCandidate = Pick<
  Candidate,
  'fingerprint' | 'name' | 'title' | 'evidence' | 'conditions' | 'actions' | 'support' | 'confidence' | 'contexts' | 'eventMessageIds' | 'days' | 'total' | 'domain'
> & { score: number }

interface MsgMeta extends MineMessage {
  hasAttachment: boolean
  special: string | null
  folder: string
}

const FIELDS: RuleField[] = ['from', 'to', 'subject', 'listId', 'hasAttachment', 'isNewsletter']
const OPS: RuleOp[] = ['contains', 'equals', 'startsWith', 'endsWith', 'regex', 'is']
const ACTIONS: RuleActionType[] = ['markRead', 'flag', 'unflag', 'setCategory', 'moveTrash', 'markNewsletter', 'saveToKb', 'notify', 'runConnector', 'moveFolder', 'archive', 'pin', 'snooze', 'createTodo']

/**
 * 主动建议规则：每天挖掘一次近 30 天的手动操作，生成至多 5 条建议；
 * 只有用户接受（列表卡片 / 设置页 / Agent 确认）后才建规则、才处理现有邮件。
 */
export class RuleSuggestService {
  constructor(private deps: RuleSuggestDeps) {
    ensureRuleSuggestTables(deps.db)
  }

  // ---------------------------------------------------------------- 数据

  private rows(where = '', ...params: any[]): any[] {
    return this.deps.db.prepare(`SELECT * FROM rule_suggestions ${where}`).all(...params) as any[]
  }

  private history(): SuggestionHistory[] {
    return this.rows().map(r => ({ fingerprint: r.fingerprint, status: r.status, domain: r.domain ?? '', actionTypes: safeJson<string[]>(r.action_types, []), until: r.until ?? null }))
  }

  /** 邮件元数据（近一年、不含已发送 / 草稿 / 废纸篓 / 垃圾邮件）：分母、命中数与样本 */
  private messages(since: number): MsgMeta[] {
    const rows = this.deps.db
      .prepare(
        `SELECT m.id, m.from_addr, m.subject, m.list_id, m.is_newsletter, m.has_attachments, m.date, f.special, f.name AS folder
         FROM messages m JOIN folders f ON f.id = m.folder_id
         WHERE m.date >= ? AND COALESCE(f.special, '') NOT IN ('sent', 'drafts', 'trash', 'junk', 'spam')`
      )
      .all(since) as any[]
    return rows.map(r => ({
      id: r.id,
      fromAddr: String(r.from_addr ?? '').toLowerCase(),
      subject: r.subject ?? '',
      listId: r.list_id ?? null,
      isNewsletter: !!r.is_newsletter,
      hasAttachment: !!r.has_attachments,
      date: r.date ?? 0,
      special: r.special ?? null,
      folder: r.folder ?? ''
    }))
  }

  private folderNames(): Record<string, string> {
    const accounts = new Map(this.deps.store.listAccounts().map(a => [a.id, a.name]))
    const multi = accounts.size > 1
    const out: Record<string, string> = {}
    for (const f of this.deps.store.listFolders()) out[f.id] = multi ? `${accounts.get(f.accountId) ?? ''} · ${f.name}` : f.name
    return out
  }

  private toSuggestion(r: any, msgs: MsgMeta[] | null): RuleSuggestion {
    const d = safeJson<StoredData>(r.data, {} as StoredData)
    const base: RuleSuggestion = {
      id: r.id,
      title: d.title,
      evidence: d.evidence,
      rule: d.rule,
      support: d.support,
      confidence: d.confidence,
      sampleMessageIds: [],
      createdAt: r.created_at,
      status: r.status,
      fingerprint: r.fingerprint,
      source: d.source ?? 'heuristic'
    }
    if (!msgs) return base
    const hits = msgs.filter(m => ruleMatches(d.rule, messageCtx(m))).sort((a, b) => b.date - a.date)
    const inbox = hits.filter(m => m.special === 'inbox')
    const samples = hits.slice(0, 10)
    return {
      ...base,
      matchCount: inbox.length,
      sampleMessageIds: samples.map(m => m.id),
      samples: samples.map(m => ({ id: m.id, subject: m.subject || '（无主题）', from: m.fromAddr, date: m.date, folder: m.folder, inInbox: m.special === 'inbox' })),
      days: d.days,
      total: d.total
    }
  }

  // ---------------------------------------------------------------- 读

  /** 待处理的建议（status=new），按价值排序；已被后来手动建的规则覆盖的不再返回 */
  list(): RuleSuggestion[] {
    const rules = this.deps.store.listRules()
    const open = this.rows("WHERE status = 'new' ORDER BY json_extract(data, '$.score') DESC, created_at DESC").filter(r => {
      const d = safeJson<StoredData>(r.data, {} as StoredData)
      return !coveredByRules({ fingerprint: r.fingerprint, actions: d.rule?.actions ?? [], contexts: d.contexts ?? [] }, rules)
    })
    if (!open.length) return []
    const msgs = this.messages(Date.now() - 365 * DAY_MS)
    return open.map(r => this.toSuggestion(r, msgs))
  }

  get(id: string): RuleSuggestion | null {
    const r = this.rows('WHERE id = ?', id)[0]
    return r ? this.toSuggestion(r, this.messages(Date.now() - 365 * DAY_MS)) : null
  }

  // ---------------------------------------------------------------- 挖掘

  /** 挖掘一次（自动任务「规则建议」每天调用）；返回新出现的建议 */
  run(now = Date.now()): { created: RuleSuggestion[]; open: number; candidates: number } {
    const { db, store } = this.deps
    pruneLog(db, now)
    const events = loadEvents(db, now - WINDOW_DAYS * DAY_MS)
    const msgs = this.messages(now - 365 * DAY_MS)
    const inbox = msgs.filter(m => m.special === 'inbox' && m.date >= now - WINDOW_DAYS * DAY_MS)
    const known = store.getKnownSenders()
    // 手动操作的习惯 + 阅读停留（打开后马上关掉、没读）→ 自动标已读
    const cands = [...mineSuggestions({ now, events, inbox, knownContacts: known, folderNames: this.folderNames() }), ...mineOpenNoRead({ now, events, knownContacts: known })].sort((a, b) => b.score - a.score)
    const rules = store.listRules()
    const history = this.history()
    const fresh = cands.filter(c => !coveredByRules(c, rules) && !blockedByHistory(c, history, now)).slice(0, MAX_OPEN)
    const created = this.persist(fresh, now, 'heuristic')
    this.deps.event({ type: 'rule-suggestions' })
    const createdList = created.map(id => this.toSuggestion(this.rows('WHERE id = ?', id)[0], null))
    return { created: createdList, open: this.openCount(), candidates: cands.length }
  }

  /**
   * 落库：按指纹 upsert，撤下「本来源」里不再成立的旧建议。
   * 两个来源（heuristic / ai）各自管理各自的 'new' 行，互不清除对方。
   */
  private persist(fresh: PersistCandidate[], now: number, source: 'heuristic' | 'ai'): string[] {
    const { db } = this.deps
    const created: string[] = []
    const keep = new Set<string>()
    for (const c of fresh) {
      const data = JSON.stringify(this.dataOf(c, source))
      const existing = this.rows('WHERE fingerprint = ? ORDER BY updated_at DESC LIMIT 1', c.fingerprint)[0]
      if (existing && (existing.status === 'new' || existing.status === 'snoozed')) {
        // 同一条建议：刷新证据；冷却期已过的忽略重新冒出来算新的
        if (existing.status === 'snoozed') created.push(existing.id)
        db.prepare("UPDATE rule_suggestions SET status = 'new', data = ?, updated_at = ?, until = NULL WHERE id = ?").run(data, now, existing.id)
        keep.add(existing.id)
        continue
      }
      const id = `rs-${randomUUID()}`
      db.prepare('INSERT INTO rule_suggestions (id, fingerprint, status, domain, action_types, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(
        id, c.fingerprint, 'new', c.domain, JSON.stringify(c.actions.map(a => a.type)), data, now, now
      )
      created.push(id)
      keep.add(id)
    }
    // 不再成立的旧建议（习惯变了 / 已被规则覆盖）撤下——只清本来源的
    for (const r of this.rows("WHERE status = 'new' AND COALESCE(json_extract(data, '$.source'), 'heuristic') = ?", source)) {
      if (!keep.has(r.id)) db.prepare('DELETE FROM rule_suggestions WHERE id = ?').run(r.id)
    }
    return created
  }

  private openCount(): number {
    return this.rows("WHERE status = 'new'").length
  }

  private dataOf(c: PersistCandidate, source: 'heuristic' | 'ai'): StoredData & { score: number } {
    return {
      title: c.title,
      evidence: c.evidence,
      rule: { name: c.name, conditions: c.conditions, actions: c.actions },
      support: c.support,
      confidence: c.confidence,
      contexts: c.contexts.slice(0, 60),
      eventMessageIds: c.eventMessageIds.slice(0, 60),
      days: c.days,
      total: c.total,
      source,
      score: c.score
    }
  }

  // ---------------------------------------------------------------- AI 挖掘

  /**
   * AI 挖掘（自动任务「规则 AI 挖掘」调用）：把近 30 天的操作统计交给模型归纳，
   * 产出启发式门槛（次数/天数/一致率）之外「讲得出道理」的规则候选；落库走同一套
   * 指纹去重 / 已覆盖 / 被拒绝过滤，与启发式建议同列表呈现。
   */
  async runAi(now = Date.now()): Promise<{ created: RuleSuggestion[]; open: number; candidates: number; error?: string }> {
    const ai = this.deps.ai
    if (!ai) return { created: [], open: this.openCount(), candidates: 0, error: 'AI 未接入' }
    const { db, store } = this.deps
    pruneLog(db, now)
    const events = loadEvents(db, now - WINDOW_DAYS * DAY_MS)
    if (events.length < 8) return { created: [], open: this.openCount(), candidates: 0, error: '操作记录还太少' }

    // 统计文本：按 发件人域名 + 动作 聚合，附主题模式样本
    const groups = new Map<string, { n: number; actions: Set<string>; subjects: string[]; category?: string; listId?: string }>()
    for (const e of events) {
      const key = `${e.fromDomain || e.fromAddr}||${e.action}`
      const g = groups.get(key) ?? { n: 0, actions: new Set([e.action]), subjects: [], category: e.category ?? undefined, listId: e.listId ?? undefined }
      g.n++
      g.subjects.push(e.subjectPattern || e.subject || '')
      groups.set(key, g)
    }
    const statLines = [...groups.entries()]
      .filter(([, g]) => g.n >= 3)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 30)
      .map(([key, g]) => {
        const [domain, action] = key.split('||')
        return `- ${domain} × ${action}：${g.n} 次；主题样本：${[...new Set(g.subjects)].slice(0, 4).join(' | ')}${g.listId ? `；List-Id: ${g.listId}` : ''}`
      })
    if (!statLines.length) return { created: [], open: this.openCount(), candidates: 0, error: '没有重复 3 次以上的模式' }

    const rules = store.listRules()
    const existingNote = rules.slice(0, 20).map(r => `- ${r.name}：${r.conditions.map(c => `${c.field} ${c.op} ${c.value ?? ''}`).join(' 且 ')}`).join('\n')
    const user = [
      '近 30 天手动操作统计（≥3 次的组）：',
      ...statLines,
      existingNote ? `\n已有规则（不要重复提）：\n${existingNote}` : ''
    ].join('\n')

    let parsed: { suggestions?: any[] }
    try {
      parsed = jsonFromText(await ai.complete([{ role: 'system', content: RULE_MINE }, { role: 'user', content: user }], 3000)) as { suggestions?: any[] }
    } catch (err) {
      return { created: [], open: this.openCount(), candidates: 0, error: err instanceof Error ? err.message : String(err) }
    }

    const msgs = this.messages(now - 365 * DAY_MS)
    const history = this.history()
    const folderIds = new Set(store.listFolders().map(f => f.id))
    const cands: PersistCandidate[] = []
    for (const s of (parsed.suggestions ?? []).slice(0, AI_MAX)) {
      const clean = sanitizeRule(
        { name: String(s?.title ?? ''), conditions: Array.isArray(s?.conditions) ? s.conditions : [], actions: Array.isArray(s?.actions) ? s.actions : [] },
        folderIds
      )
      if ('error' in clean) continue
      // 只认白名单内的字段 / 动作（sanitize 已过滤）；再用指纹走同一套去重与历史过滤
      const fingerprintId = fingerprint(clean.conditions, clean.actions)
      const evidence = String(s?.reason ?? '').slice(0, 60)
      const support = Math.max(1, Math.min(Number(s?.support) || 0, 9999))
      const confidence = Math.min(Math.max(Number(s?.confidence) || 0.5, 0), 1)
      const contexts = msgs.filter(m => ruleMatches({ conditions: clean.conditions }, messageCtx(m))).map(m => messageCtx(m)).slice(0, 60)
      cands.push({
        fingerprint: fingerprintId,
        name: clean.name,
        title: clean.name,
        evidence,
        conditions: clean.conditions,
        actions: clean.actions,
        support,
        confidence,
        contexts,
        eventMessageIds: [],
        days: 0,
        total: 0,
        domain: String(clean.conditions[0]?.value ?? '').split('@').pop() ?? '',
        score: support * 2 + confidence * 40
      })
    }
    const rulesNow = store.listRules()
    const fresh = cands.filter(c => !coveredByRules(c, rulesNow) && !blockedByHistory(c, history, now))
    const created = this.persist(fresh, now, 'ai')
    this.deps.event({ type: 'rule-suggestions' })
    const createdList = created.map(id => this.toSuggestion(this.rows('WHERE id = ?', id)[0], null))
    return { created: createdList, open: this.openCount(), candidates: cands.length }
  }

  // ---------------------------------------------------------------- 写

  /** 接受：按（可能被用户改过的）规则创建并启用；applyExisting 时对收件箱里现有命中邮件执行一次。已接受过的只补做「处理现有」 */
  async accept(id: string, opts: { rule?: Omit<Rule, 'id' | 'order' | 'enabled'>; applyExisting?: boolean } = {}): Promise<{ ok: boolean; ruleId?: string; applied?: number; error?: string }> {
    const { db, store } = this.deps
    const row = this.rows('WHERE id = ?', id)[0]
    if (!row) return { ok: false, error: '这条建议已经不存在了' }
    let rule: Rule | undefined
    if (row.status === 'accepted') {
      rule = store.listRules().find(r => r.id === row.rule_id)
      if (!rule) return { ok: false, error: '建议已接受，但对应的规则已被删除' }
    } else {
      const d = safeJson<StoredData>(row.data, {} as StoredData)
      const base = opts.rule ?? d.rule
      const clean = sanitizeRule(base, new Set(store.listFolders().map(f => f.id)))
      if ('error' in clean) return { ok: false, error: clean.error }
      const order = Math.max(-1, ...store.listRules().map(r => r.order)) + 1
      rule = { id: `rule-sugg-${randomUUID().slice(0, 8)}`, name: clean.name, enabled: true, order, conditions: clean.conditions, actions: clean.actions }
      await this.deps.call('saveRule', [rule])
      db.prepare("UPDATE rule_suggestions SET status = 'accepted', rule_id = ?, updated_at = ?, data = json_set(data, '$.rule', json(?)) WHERE id = ?").run(
        rule.id, Date.now(), JSON.stringify({ name: rule.name, conditions: rule.conditions, actions: rule.actions }), id
      )
      logActivity({ source: 'job', title: `按建议新建规则「${rule.name}」`, detail: d.title ?? null, refs: [] })
    }
    let applied = 0
    if (opts.applyExisting && rule) {
      const hits = this.messages(0)
        .filter(m => m.special === 'inbox' && ruleMatches(rule!, messageCtx(m)))
        .sort((a, b) => b.date - a.date)
        .slice(0, APPLY_LIMIT)
      for (const m of hits) {
        await this.deps.runRuleActions(m.id, rule.actions)
        applied++
      }
      if (applied) logActivity({ source: 'job', title: `规则「${rule.name}」处理了现有 ${applied} 封`, refs: [], stats: { archived: rule.actions.some(a => a.type === 'archive') ? applied : 0 } })
    }
    this.deps.event({ type: 'rule-suggestions' })
    this.deps.event({ type: 'messages-changed' })
    return { ok: true, ruleId: rule?.id, applied }
  }

  /** 阅读页上报的停留信号（只记元数据） */
  readSignal(sig: ReadSignal): boolean {
    return logReadSignal(this.deps.db, sig)
  }

  /** 忽略：forever = 永不建议（同指纹、同发件域的同类动作都不再提）；否则 30 天内不提 */
  dismiss(id: string, forever = false) {
    const now = Date.now()
    this.deps.db
      .prepare('UPDATE rule_suggestions SET status = ?, until = ?, updated_at = ? WHERE id = ?')
      .run(forever ? 'dismissed' : 'snoozed', forever ? null : now + COOLDOWN_MS, now, id)
    this.deps.event({ type: 'rule-suggestions' })
  }
}

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback
  } catch {
    return fallback
  }
}

/** 用户编辑过的规则：字段 / 运算符 / 动作只认规则引擎支持的；空值条件去掉 */
export function sanitizeRule(
  r: Omit<Rule, 'id' | 'order' | 'enabled'> | undefined,
  folderIds: Set<string>
): { name: string; conditions: RuleCondition[]; actions: RuleAction[] } | { error: string } {
  if (!r) return { error: '规则为空' }
  const conditions = (r.conditions ?? [])
    .map(c => ({ field: c.field, op: c.op, value: String(c.value ?? '').trim() }))
    .filter(c => FIELDS.includes(c.field) && OPS.includes(c.op) && (c.value || c.field === 'hasAttachment' || c.field === 'isNewsletter'))
  const actions = (r.actions ?? [])
    .filter(a => ACTIONS.includes(a.type))
    .map(a => ({ type: a.type, ...(a.value != null && a.value !== '' ? { value: String(a.value) } : {}) }))
  if (!conditions.length) return { error: '至少需要一个有效条件' }
  if (!actions.length) return { error: '至少需要一个动作' }
  const bad = actions.find(a => a.type === 'moveFolder' && !folderIds.has(a.value ?? ''))
  if (bad) return { error: '目标文件夹不存在' }
  for (const c of conditions) {
    if (c.op !== 'regex') continue
    try {
      new RegExp(c.value, 'i')
    } catch {
      return { error: `正则写法有误：${c.value}` }
    }
  }
  return { name: String(r.name ?? '').trim().slice(0, 60) || '建议的规则', conditions, actions }
}
