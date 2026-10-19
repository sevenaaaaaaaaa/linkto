import { createHash } from 'node:crypto'
import type { Rule, RuleAction, RuleActionType, RuleCondition, UserActionEvent } from '@shared/types'
import { isPublicDomain } from '@shared/projects'
import { hasAiCondition, ruleMatches, type RuleEvalContext } from '../rules/engine'

/**
 * 主动建议规则 · 规律挖掘（纯函数，不碰数据库 / Electron，便于单测）。
 *
 * 输入：近 30 天的用户手动操作记录 + 收件箱里还留着的邮件（分母）+ 往来联系人。
 * 输出：可直接转成 Rule 的候选（条件 / 动作 / 人话标题 / 证据 / 指纹）。
 *
 * 克制原则：宁可少提，不要误提。
 *  - 次数、跨越天数、一致率三道门槛同时满足才提；删除类门槛更高，并默认改成归档
 *  - 一次批量处理 50 封只算一两次（权重封顶），避免一次大扫除就触发
 *  - 个人往来（回复过 / 发过信的联系人、分区「需要你处理」为主）不建议归档 / 删除
 *  - 条件取「最具体又不过拟合」：地址优于域名；域名下只有部分主题被处理时用 域名 + 主题包含 关键词
 */

export const DAY_MS = 86_400_000
export const WINDOW_DAYS = 30

/** 记录里额外的元数据（UserActionEvent 之外，均可选） */
export interface MineEvent extends UserActionEvent {
  /** 原始主题（只用于关键词与已有规则比对；不存正文） */
  subject?: string | null
  /** 同一次操作（一次 IPC 调用）的批次 id 与批量大小 */
  batchId?: string | null
  batchSize?: number | null
  /** 邮件理解的分区（act / wait / fyi / bundle） */
  section?: string | null
  isNewsletter?: boolean | null
}

/** 收件箱里还留着的邮件（一致率的分母：同组收到了却没被这样处理） */
export interface MineMessage {
  id: string
  fromAddr: string
  subject: string
  listId?: string | null
  isNewsletter?: boolean
  date: number
}

export interface MineInput {
  now: number
  events: MineEvent[]
  inbox: MineMessage[]
  /** 有过往来的地址（我回复过 / 我发过信），小写 */
  knownContacts: Set<string> | string[]
  /** 文件夹 id → 名称（标题里用） */
  folderNames?: Record<string, string>
}

export type Scope =
  | { kind: 'addr'; addr: string }
  | { kind: 'list'; listId: string }
  | { kind: 'addr+kw'; addr: string; kw: string }
  | { kind: 'domain+kw'; domain: string; kw: string }
  | { kind: 'domain'; domain: string }
  | { kind: 'newsletter' }

export interface Threshold {
  /** 被这样处理的邮件数（去重） */
  support: number
  /** 降权后的次数（批量封顶、单日封顶） */
  eff: number
  /** 跨越天数 */
  days: number
  /** 一致率 */
  conf: number
}

/** 各动作的门槛（删除最严；移动文件夹次数少但一致率要求更高） */
export const THRESHOLDS: Record<MinedAction, Threshold> = {
  archive: { support: 4, eff: 4, days: 3, conf: 0.8 },
  trash: { support: 6, eff: 5, days: 4, conf: 0.9 },
  moveFolder: { support: 3, eff: 3, days: 2, conf: 0.9 },
  flag: { support: 4, eff: 4, days: 3, conf: 0.8 },
  pin: { support: 4, eff: 4, days: 3, conf: 0.8 },
  snooze: { support: 4, eff: 4, days: 3, conf: 0.8 },
  createTodo: { support: 4, eff: 4, days: 3, conf: 0.8 }
}
/** 「所有订阅邮件」这种大范围条件：额外门槛 */
const NEWSLETTER_EXTRA = { support: 8, days: 4, conf: 0.85, senders: 3 }

export type MinedAction = 'archive' | 'trash' | 'moveFolder' | 'flag' | 'pin' | 'snooze' | 'createTodo'
export const MINED_ACTIONS: MinedAction[] = ['archive', 'trash', 'moveFolder', 'flag', 'pin', 'snooze', 'createTodo']

/** 批量操作：一次处理 ≥ BATCH_MIN 封时，这一批在同一组里最多算 BATCH_CAP 次；同一天最多算 DAY_CAP 次 */
export const BATCH_MIN = 5
export const BATCH_CAP = 2
export const DAY_CAP = 3

export interface Candidate {
  scope: Scope
  /** openNoRead：打开后几秒就关掉、没读（见 dwell.ts），建议自动标已读 */
  action: MinedAction | 'openNoRead'
  /** moveFolder 的目标文件夹 id */
  value: string | null
  conditions: RuleCondition[]
  actions: RuleAction[]
  name: string
  title: string
  evidence: string
  support: number
  eff: number
  days: number
  confidence: number
  /** 分母：同组邮件总数 */
  total: number
  unreadRate: number
  firstAt: number
  lastAt: number
  /** 证据邮件 id（操作当时的 id，可能已移走） */
  eventMessageIds: string[]
  /** 证据邮件的比对上下文（已有规则是否已覆盖） */
  contexts: RuleEvalContext[]
  /** 发件「域」（地址取其域名）：忽略同类时按它判断 */
  domain: string
  fingerprint: string
  score: number
}

// ===================================================================== 主题模板

const PREFIX = /^\s*(re|fw|fwd|aw|wg|sv|答复|回复|转发|回覆|轉寄)\s*(\[\d+\])?\s*[:：]\s*/i

/**
 * 主题 → 模板：去掉回复前缀，把金额 / 日期 / 时间 / 订单号 / 数字换成占位符。
 * 「您的 2026年10月 账单已出，应还 ¥1,280.00」→「您的 {date} 账单已出，应还 {amount}」
 */
export function subjectPattern(subject: string | null | undefined): string {
  let s = String(subject ?? '').trim()
  for (let i = 0; i < 6; i++) {
    const next = s.replace(PREFIX, '')
    if (next === s) break
    s = next
  }
  s = s
    // 金额：货币符号在前 / 单位在后
    .replace(/(?:[¥￥$€£]|rmb|cny|usd|hk\$|us\$)\s?\d[\d,]*(?:\.\d+)?/gi, ' {amount} ')
    .replace(/\d[\d,]*(?:\.\d+)?\s?(?:元|块|美元|港币|rmb|cny|usd|eur)(?![a-z])/gi, ' {amount} ')
    // 日期：2026-10-19 / 2026/10/19 / 2026年10月19日 / 2026年10月 / 10月19日 / 10/19
    .replace(/\d{4}\s?[-/.年]\s?\d{1,2}\s?(?:[-/.月]\s?\d{1,2}\s?日?|月)?/g, ' {date} ')
    .replace(/\d{1,2}\s?月\s?\d{1,2}\s?[日号]?/g, ' {date} ')
    .replace(/\b\d{1,2}\/\d{1,2}\b/g, ' {date} ')
    // 时间
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' {time} ')
    // 订单号 / 单号：≥ 6 位数字，或字母数字混合且含 ≥ 4 位数字
    .replace(/#?\b(?=[a-z0-9-]*\d{4})[a-z]*[0-9][a-z0-9-]{5,}\b/gi, ' {id} ')
    .replace(/#?\d{6,}/g, ' {id} ')
    // 其余数字
    .replace(/\d+(?:\.\d+)?/g, ' {n} ')
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([，。：:、,!！?？\]】)）])\s*/g, '$1')
    .replace(/\s*([【[（(])\s*/g, ' $1')
    .trim()
    .slice(0, 160)
}

// ===================================================================== 地址 / 域名

const TWO_LEVEL = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'co.uk', 'org.uk', 'ac.uk', 'co.jp', 'ne.jp', 'or.jp', 'com.hk', 'com.tw', 'com.au', 'com.sg', 'co.kr', 'com.br'])

export function hostOf(addr: string | null | undefined): string {
  const a = String(addr ?? '').trim().toLowerCase()
  const i = a.lastIndexOf('@')
  return i < 0 ? '' : a.slice(i + 1)
}

/** 可注册域名：news.shop.example → shop.example；mail.bank.com.cn → bank.com.cn */
export function regDomain(host: string | null | undefined): string {
  const parts = String(host ?? '').toLowerCase().split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  const last2 = parts.slice(-2).join('.')
  return TWO_LEVEL.has(last2) ? parts.slice(-3).join('.') : last2
}

export function normListId(v: string | null | undefined): string {
  const s = String(v ?? '').trim().toLowerCase()
  const m = s.match(/<([^>]+)>/)
  return (m ? m[1] : s).trim().slice(0, 200)
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ===================================================================== 分组

function scopeHas(scope: Scope, from: string, subject: string, listId: string, newsletter: boolean): boolean {
  switch (scope.kind) {
    case 'addr':
      return from === scope.addr
    case 'list':
      return listId === scope.listId
    case 'addr+kw':
      return from === scope.addr && subject.includes(scope.kw)
    case 'domain':
      return regDomain(hostOf(from)) === scope.domain
    case 'domain+kw':
      return regDomain(hostOf(from)) === scope.domain && subject.includes(scope.kw)
    case 'newsletter':
      return newsletter
  }
}

const evFrom = (e: MineEvent) => String(e.fromAddr ?? '').toLowerCase()
const evSubject = (e: MineEvent) => String(e.subject ?? e.subjectPattern ?? '').toLowerCase()
const evNewsletter = (e: MineEvent) => !!e.isNewsletter || e.category === 'newsletter'
export const eventInScope = (scope: Scope, e: MineEvent) => scopeHas(scope, evFrom(e), evSubject(e), normListId(e.listId), evNewsletter(e))
export const messageInScope = (scope: Scope, m: MineMessage) => scopeHas(scope, String(m.fromAddr ?? '').toLowerCase(), String(m.subject ?? '').toLowerCase(), normListId(m.listId), !!m.isNewsletter)

/** 记录里的动作 → 挖掘用的动作（markRead / unsubscribe 等不参与：打开即已读，无法区分习惯） */
export function minedActionOf(action: string): MinedAction | null {
  if (action === 'moveFolder' || action === 'archive' || action === 'trash' || action === 'flag' || action === 'pin' || action === 'snooze' || action === 'createTodo') return action
  return null
}

const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export interface GroupStats {
  support: number
  eff: number
  days: number
  total: number
  confidence: number
  unreadRate: number
  firstAt: number
  lastAt: number
  events: MineEvent[]
}

/**
 * 一个（范围, 动作）的统计：
 *  - support：被这样处理的邮件数（按邮件去重）
 *  - eff：降权次数——同一批（一次操作 ≥ 5 封）最多算 2 次，同一天最多算 3 次
 *  - days：跨越天数
 *  - total：分母 = 同组里被手动处理过的邮件（任何动作）+ 收件箱里还留着的同组邮件（收到超过 24 小时）
 */
export function groupStats(scope: Scope, action: MinedAction, value: string | null, events: MineEvent[], inbox: MineMessage[], now: number): GroupStats {
  const inGroup = events.filter(e => eventInScope(scope, e))
  const byMsg = new Map<string, MineEvent>()
  for (const e of inGroup) {
    if (minedActionOf(e.action) !== action) continue
    if (action === 'moveFolder' && (e.value ?? null) !== value) continue
    byMsg.set(e.messageId, e)
  }
  const evs = [...byMsg.values()]
  const handledAny = new Set(inGroup.filter(e => minedActionOf(e.action)).map(e => e.messageId))
  const kept = inbox.filter(m => m.date >= now - WINDOW_DAYS * DAY_MS && m.date <= now - DAY_MS && !handledAny.has(m.id) && messageInScope(scope, m)).length
  const total = handledAny.size + kept

  // 降权：先按批次封顶，再按天封顶
  const perBatch = new Map<string, { day: string; n: number; big: boolean }>()
  for (const e of evs) {
    const key = e.batchId || `single:${e.messageId}`
    const cur = perBatch.get(key) ?? { day: dayKey(e.at), n: 0, big: (e.batchSize ?? 1) >= BATCH_MIN }
    cur.n++
    perBatch.set(key, cur)
  }
  const perDay = new Map<string, number>()
  for (const b of perBatch.values()) perDay.set(b.day, (perDay.get(b.day) ?? 0) + (b.big ? Math.min(b.n, BATCH_CAP) : b.n))
  let eff = 0
  for (const n of perDay.values()) eff += Math.min(n, DAY_CAP)

  const unread = evs.filter(e => e.wasUnread).length
  return {
    support: evs.length,
    eff,
    days: perDay.size,
    total,
    confidence: total ? evs.length / total : 0,
    unreadRate: evs.length ? unread / evs.length : 0,
    firstAt: evs.length ? Math.min(...evs.map(e => e.at)) : 0,
    lastAt: evs.length ? Math.max(...evs.map(e => e.at)) : 0,
    events: evs
  }
}

export function passes(st: Pick<GroupStats, 'support' | 'eff' | 'days' | 'confidence'>, th: Threshold): boolean {
  return st.support >= th.support && st.eff >= th.eff && st.days >= th.days && st.confidence >= th.conf
}

// ===================================================================== 个人往来

/**
 * 个人往来：回复过 / 发过信的联系人；个人邮箱域名上、多数被分为「个人」的发件人；或多数在「需要你处理」分区。
 * 这类邮件不建议归档 / 删除规则。
 */
export function isPersonalScope(scope: Scope, events: MineEvent[], known: Set<string>): boolean {
  const senders = new Set(events.map(evFrom))
  if ([...senders].some(a => known.has(a))) return true
  if (!events.length) return false
  const act = events.filter(e => e.section === 'act').length
  if (act / events.length >= 0.5) return true
  if (scope.kind === 'addr' || scope.kind === 'addr+kw') {
    const personal = events.filter(e => (e.category ?? 'personal') === 'personal' && !evNewsletter(e) && !e.listId).length
    if (isPublicDomain(hostOf(scope.addr)) && personal / events.length >= 0.5) return true
  }
  return false
}

// ===================================================================== 主题关键词（部分 pattern 被处理时）

const PLACEHOLDER = /\{(?:n|date|time|amount|id)\}/g
const CJK = /[㐀-鿿]/

function keywordCandidates(pattern: string): Set<string> {
  const out = new Set<string>()
  const segs = pattern
    .replace(PLACEHOLDER, '|')
    .split(/[|\s，。：:、,.!！?？\-–—_/\\()（）[\]【】<>《》"'“”‘’|·~*#&+=;；]+/)
    .map(s => s.trim())
    .filter(Boolean)
  for (const seg of segs.map(s => s.slice(0, 24))) {
    if (CJK.test(seg)) {
      // 中文：取 2~8 字的连续片段
      for (let len = 2; len <= Math.min(8, seg.length); len++)
        for (let i = 0; i + len <= seg.length; i++) {
          const g = seg.slice(i, i + len)
          // 「您的 / 你的 / 的…」开头、「…的」结尾的片段读起来不像关键词
          if (!/^[的了您你我请]/.test(g) && !/[的了]$/.test(g)) out.add(g)
        }
    } else if (seg.length >= 4 && !STOP.has(seg)) out.add(seg)
  }
  // 英文多词短语：相邻两词
  const words = pattern.replace(PLACEHOLDER, ' ').split(/[^a-z0-9]+/).filter(w => w.length >= 3)
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`)
  return out
}

const STOP = new Set(['your', 'from', 'with', 'this', 'that', 'have', 'here', 'just', 'news', 'mail', 'email', 'info', 'update', 'hello', 'dear'])
const CJK_STOP = new Set(['您的', '你的', '我们', '已经', '通知', '邮件', '请查收', '查收', '一下', '关于'])

/**
 * 在一组（地址 / 域名）里，找能把「被处理的」和「留着的」分开的主题关键词：
 * 被处理的里 ≥ 80% 含它，留着的里 ≤ 1/3 含它；取区分度（覆盖 − 误伤）最高、再取最长的。
 */
export function pickKeyword(handled: string[], kept: string[]): string | null {
  if (handled.length < 2) return null
  const counts = new Map<string, number>()
  for (const s of handled) for (const k of keywordCandidates(subjectPattern(s))) counts.set(k, (counts.get(k) ?? 0) + 1)
  const keptLower = kept.map(s => s.toLowerCase())
  let best: { kw: string; score: number } | null = null
  for (const [kw, n] of counts) {
    if (CJK_STOP.has(kw) || STOP.has(kw)) continue
    const cov = n / handled.length
    if (cov < 0.8) continue
    const neg = keptLower.length ? keptLower.filter(s => s.includes(kw)).length / keptLower.length : 0
    if (neg > 0.34) continue
    // 区分度 = 覆盖率 − 误伤率；一样时取更长（更具体）的。细分后的一致率还要再过一遍门槛
    const score = cov - neg
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && kw.length > best.kw.length)) best = { kw, score }
  }
  return best?.kw ?? null
}

// ===================================================================== 条件 / 动作 / 文案

export function conditionsFor(scope: Scope): RuleCondition[] {
  switch (scope.kind) {
    case 'addr':
      return [{ field: 'from', op: 'equals', value: scope.addr }]
    case 'list':
      return [{ field: 'listId', op: 'contains', value: scope.listId }]
    case 'addr+kw':
      return [
        { field: 'from', op: 'equals', value: scope.addr },
        { field: 'subject', op: 'contains', value: scope.kw }
      ]
    case 'domain':
      return [{ field: 'from', op: 'regex', value: `[@.]${escRe(scope.domain)}$` }]
    case 'domain+kw':
      return [
        { field: 'from', op: 'regex', value: `[@.]${escRe(scope.domain)}$` },
        { field: 'subject', op: 'contains', value: scope.kw }
      ]
    case 'newsletter':
      return [{ field: 'isNewsletter', op: 'is', value: 'yes' }]
  }
}

/** 删除类建议默认改成归档（可恢复，误伤成本低） */
export function actionsFor(action: MinedAction, value: string | null, events: MineEvent[]): RuleAction[] {
  switch (action) {
    case 'archive':
    case 'trash':
      return [{ type: 'archive' }]
    case 'moveFolder':
      return [{ type: 'moveFolder', value: value ?? '' }]
    case 'snooze': {
      const hours = events.map(e => Number(e.value)).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
      const median = hours.length ? hours[Math.floor(hours.length / 2)] : 3
      return [{ type: 'snooze', value: String(Math.max(1, Math.min(24 * 14, Math.round(median)))) }]
    }
    case 'flag':
      return [{ type: 'flag' }]
    case 'pin':
      return [{ type: 'pin' }]
    case 'createTodo':
      return [{ type: 'createTodo' }]
  }
}

export function scopeLabel(scope: Scope): string {
  switch (scope.kind) {
    case 'addr':
      return scope.addr
    case 'list':
      return `邮件列表 ${scope.listId}`
    case 'addr+kw':
      return `${scope.addr}「${scope.kw}」`
    case 'domain':
      return scope.domain
    case 'domain+kw':
      return `${scope.domain}「${scope.kw}」`
    case 'newsletter':
      return '订阅'
  }
}

function nounOf(events: MineEvent[]): string {
  const c = new Map<string, number>()
  for (const e of events) {
    const k = evNewsletter(e) ? 'newsletter' : e.category ?? 'personal'
    c.set(k, (c.get(k) ?? 0) + 1)
  }
  const top = [...c.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!top || top[1] / events.length < 0.6) return '邮件'
  return ({ newsletter: '订阅邮件', notification: '通知', noise: '促销邮件' } as Record<string, string>)[top[0]] ?? '邮件'
}

const fmtHours = (h: number) => (h % 24 === 0 ? `${h / 24} 天` : `${h} 小时`)

function verbOf(action: MinedAction, value: string | null, unreadRate: number, actions: RuleAction[], folderNames: Record<string, string>): string {
  const unread = unreadRate >= 0.8 ? '不读就' : ''
  switch (action) {
    case 'archive':
      return `${unread}归档了`
    case 'trash':
      return `${unread}删除了`
    case 'moveFolder':
      return `移到了「${folderNames[value ?? ''] ?? '同一个文件夹'}」`
    case 'flag':
      return '加了旗标'
    case 'pin':
      return '置顶了'
    case 'snooze':
      return `稍后处理了（通常 ${fmtHours(Number(actions[0]?.value) || 3)}）`
    case 'createTodo':
      return '转成了待办'
  }
}

const ACTION_NAME: Record<MinedAction, string> = { archive: '自动归档', trash: '自动归档', moveFolder: '自动移到文件夹', flag: '自动加旗标', pin: '自动置顶', snooze: '自动稍后处理', createTodo: '自动建待办' }

const md = (t: number) => {
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// ===================================================================== 指纹

/** 条件 + 动作的规范化哈希（顺序无关、大小写无关） */
export function fingerprint(conditions: RuleCondition[], actions: RuleAction[]): string {
  const c = conditions.map(x => `${x.field}|${x.op}|${String(x.value ?? '').trim().toLowerCase()}`).sort()
  const a = actions.map(x => `${x.type}|${String(x.value ?? '').trim().toLowerCase()}`).sort()
  return createHash('sha1').update(JSON.stringify({ c, a })).digest('hex').slice(0, 16)
}

// ===================================================================== 已有规则 / 用户拒绝过

const SAME_ACTION: Partial<Record<RuleActionType, RuleActionType[]>> = { archive: ['archive', 'moveTrash'], moveTrash: ['archive', 'moveTrash'] }

/** 已有等价规则：指纹相同，或某条启用的规则含同类动作、且已能命中 ≥ 80% 的证据邮件 */
export function coveredByRules(c: Pick<Candidate, 'fingerprint' | 'actions' | 'contexts'>, rules: Rule[]): boolean {
  for (const r of rules) {
    if (fingerprint(r.conditions, r.actions) === c.fingerprint) return true
    if (!r.enabled || hasAiCondition(r) || !r.conditions.length) continue
    const types = new Set(r.actions.map(a => a.type))
    const sameAction = c.actions.every(a => (SAME_ACTION[a.type] ?? [a.type]).some(t => types.has(t) && (t !== 'moveFolder' || r.actions.some(x => x.type === 'moveFolder' && x.value === a.value))))
    if (!sameAction || !c.contexts.length) continue
    const hit = c.contexts.filter(ctx => ruleMatches(r, ctx)).length
    if (hit / c.contexts.length >= 0.8) return true
  }
  return false
}

export interface SuggestionHistory {
  fingerprint: string
  status: 'new' | 'accepted' | 'dismissed' | 'snoozed'
  domain: string
  actionTypes: string[]
  /** snoozed（忽略 30 天）的截止 */
  until?: number | null
}

/**
 * 用户拒绝过 / 已接受的同类不再提：
 *  - 同指纹：accepted / dismissed 永远不提；snoozed 冷却期内不提
 *  - 同发件域 + 同动作：dismissed（永不建议）永远不提；snoozed 冷却期内不提（避免换个粒度又冒出来）
 */
export function blockedByHistory(c: Pick<Candidate, 'fingerprint' | 'domain' | 'actions'>, history: SuggestionHistory[], now: number): boolean {
  const types = c.actions.map(a => a.type as string)
  for (const h of history) {
    const cooling = h.status === 'snoozed' && (h.until ?? 0) > now
    if (h.fingerprint === c.fingerprint && (h.status === 'accepted' || h.status === 'dismissed' || cooling)) return true
    const sameFamily = !!c.domain && h.domain === c.domain && h.actionTypes.some(t => types.includes(t))
    if (sameFamily && (h.status === 'dismissed' || cooling)) return true
  }
  return false
}

// ===================================================================== 主流程

const SPECIFICITY: Record<Scope['kind'], number> = { addr: 0, list: 1, 'addr+kw': 2, 'domain+kw': 3, domain: 4, newsletter: 5 }

export function scopeDomain(scope: Scope): string {
  switch (scope.kind) {
    case 'addr':
    case 'addr+kw':
      return regDomain(hostOf(scope.addr))
    case 'domain':
    case 'domain+kw':
      return scope.domain
    case 'list':
      return scope.listId
    case 'newsletter':
      return '*newsletter'
  }
}

export const ctxOf = (e: MineEvent): RuleEvalContext => ({
  from: evFrom(e),
  to: '',
  subject: String(e.subject ?? e.subjectPattern ?? ''),
  listId: e.listId ?? null,
  isNewsletter: evNewsletter(e),
  hasAttachment: false,
  snippet: ''
})

function build(scope: Scope, action: MinedAction, value: string | null, st: GroupStats, folderNames: Record<string, string>): Candidate {
  const conditions = conditionsFor(scope)
  const actions = actionsFor(action, value, st.events)
  const label = scopeLabel(scope)
  const noun = nounOf(st.events)
  const from =
    scope.kind === 'newsletter' ? ''
    : scope.kind === 'list' ? `${label} 的`
    : scope.kind === 'addr+kw' ? `来自 ${scope.addr}、主题含「${scope.kw}」的`
    : scope.kind === 'domain+kw' ? `来自 ${scope.domain}、主题含「${scope.kw}」的`
    : `来自 ${label} 的`
  const title = `你最近 ${WINDOW_DAYS} 天把 ${st.support} 封${from}${noun}${verbOf(action, value, st.unreadRate, actions, folderNames)}`
  const unreadN = Math.round(st.unreadRate * st.support)
  const evidence = [
    `${st.support} 封，跨 ${st.days} 天（${md(st.firstAt)}–${md(st.lastAt)}）`,
    `一致率 ${Math.round(st.confidence * 100)}%（同类 ${st.total} 封里 ${st.support} 封这样处理）`,
    unreadN ? `${unreadN} 封处理时还没读` : '',
    action === 'trash' ? '你是删除的；建议先改成归档（可恢复）' : ''
  ]
    .filter(Boolean)
    .join('；')
  const fp = fingerprint(conditions, actions)
  return {
    scope,
    action,
    value,
    conditions,
    actions,
    name: `${ACTION_NAME[action]}：${label}`.slice(0, 60),
    title,
    evidence,
    support: st.support,
    eff: st.eff,
    days: st.days,
    confidence: Math.round(st.confidence * 1000) / 1000,
    total: st.total,
    unreadRate: st.unreadRate,
    firstAt: st.firstAt,
    lastAt: st.lastAt,
    eventMessageIds: st.events.map(e => e.messageId),
    contexts: st.events.map(ctxOf),
    domain: scopeDomain(scope),
    fingerprint: fp,
    score: st.support * st.confidence * Math.min(1, st.days / 5)
  }
}

/**
 * 挖掘：对每个（动作, 目标值）
 *  1. 列出范围：发件地址 / List-Id / 发件域（个人邮箱域名不按域归并）/ 订阅邮件
 *  2. 统计、过门槛；地址 / 域名一致率不够时，试「+ 主题关键词」细分
 *  3. 选范围：从具体到宽泛；域名比其下最好的地址多覆盖 ≥ 50% 时改用域名；已被选中范围覆盖 ≥ 60% 的跳过
 */
export function mineSuggestions(input: MineInput): Candidate[] {
  const now = input.now
  const known = input.knownContacts instanceof Set ? input.knownContacts : new Set(input.knownContacts.map(a => a.toLowerCase()))
  const folderNames = input.folderNames ?? {}
  const events = input.events.filter(e => e.at >= now - WINDOW_DAYS * DAY_MS && e.at <= now + DAY_MS && e.messageId)
  const out: Candidate[] = []

  const actionKeys = new Map<string, { action: MinedAction; value: string | null }>()
  for (const e of events) {
    const a = minedActionOf(e.action)
    if (!a) continue
    const value = a === 'moveFolder' ? e.value ?? null : null
    if (a === 'moveFolder' && !value) continue
    actionKeys.set(`${a}|${value ?? ''}`, { action: a, value })
  }

  for (const { action, value } of actionKeys.values()) {
    const th = THRESHOLDS[action]
    const mine = events.filter(e => minedActionOf(e.action) === action && (action !== 'moveFolder' || e.value === value))
    if (mine.length < th.support) continue

    const scopes: Scope[] = []
    const addrs = new Set(mine.map(evFrom).filter(a => a.includes('@')))
    for (const addr of addrs) scopes.push({ kind: 'addr', addr })
    for (const l of new Set(mine.map(e => normListId(e.listId)).filter(Boolean))) scopes.push({ kind: 'list', listId: l })
    for (const d of new Set([...addrs].map(a => regDomain(hostOf(a))).filter(d => d && !isPublicDomain(d)))) scopes.push({ kind: 'domain', domain: d })
    if (action === 'archive' || action === 'trash') scopes.push({ kind: 'newsletter' })

    const passing: { c: Candidate; st: GroupStats }[] = []
    const consider = (scope: Scope) => {
      const st = groupStats(scope, action, value, events, input.inbox, now)
      if (st.support < th.support) return { st, ok: false }
      if (scope.kind === 'newsletter') {
        const senders = new Set(st.events.map(e => regDomain(hostOf(evFrom(e))))).size
        if (st.support < NEWSLETTER_EXTRA.support || st.days < NEWSLETTER_EXTRA.days || st.confidence < NEWSLETTER_EXTRA.conf || senders < NEWSLETTER_EXTRA.senders) return { st, ok: false }
      }
      if ((action === 'archive' || action === 'trash') && isPersonalScope(scope, st.events, known)) return { st, ok: false }
      const ok = passes(st, th)
      if (ok) passing.push({ c: build(scope, action, value, st, folderNames), st })
      return { st, ok }
    }

    for (const scope of scopes) {
      const r = consider(scope)
      // 一致率不够、但次数够：同组里可能只有某一类主题被这样处理 → 试「+ 关键词」
      if (!r.ok && r.st.support >= th.support && r.st.confidence < th.conf && (scope.kind === 'addr' || scope.kind === 'domain')) {
        const handledIds = new Set(r.st.events.map(e => e.messageId))
        const handled = r.st.events.map(e => String(e.subject ?? e.subjectPattern ?? ''))
        const keptEvents = events.filter(e => eventInScope(scope, e) && minedActionOf(e.action) && !handledIds.has(e.messageId)).map(e => String(e.subject ?? e.subjectPattern ?? ''))
        const keptInbox = input.inbox.filter(m => m.date >= now - WINDOW_DAYS * DAY_MS && m.date <= now - DAY_MS && messageInScope(scope, m) && !handledIds.has(m.id)).map(m => m.subject)
        const kw = pickKeyword(handled, [...keptEvents, ...keptInbox])
        if (kw) consider(scope.kind === 'addr' ? { kind: 'addr+kw', addr: scope.addr, kw } : { kind: 'domain+kw', domain: scope.domain, kw })
      }
    }
    if (!passing.length) continue

    // 域名 vs 其下的地址 / 列表：域名明显覆盖更多（≥ 1.5 倍）才用域名，否则用更具体的
    const drop = new Set<Candidate>()
    for (const p of passing) {
      if (p.c.scope.kind !== 'domain') continue
      const subs = passing.filter(q => q !== p && q.c.domain === p.c.domain && q.c.scope.kind !== 'domain')
      if (!subs.length) continue
      const bestSub = Math.max(...subs.map(q => q.c.support))
      if (p.c.support >= bestSub * 1.5) for (const q of subs) drop.add(q.c)
      else drop.add(p.c)
    }
    const ordered = passing
      .map(p => p.c)
      .filter(c => !drop.has(c))
      .sort((a, b) => SPECIFICITY[a.scope.kind] - SPECIFICITY[b.scope.kind] || b.support - a.support)
    const covered = new Set<string>()
    for (const c of ordered) {
      const overlap = c.eventMessageIds.filter(id => covered.has(id)).length / c.eventMessageIds.length
      if (overlap >= 0.6) continue
      for (const id of c.eventMessageIds) covered.add(id)
      out.push(c)
    }
  }

  // 同一范围被建议了多个动作（如既归档又删除）：只留价值最高的那个
  const byScope = new Map<string, Candidate>()
  for (const c of out) {
    const k = JSON.stringify(c.conditions)
    const cur = byScope.get(k)
    if (!cur || c.score > cur.score) byScope.set(k, c)
  }
  return [...byScope.values()].sort((a, b) => b.score - a.score)
}

/** 现有邮件 → 规则引擎上下文（matchCount / 样本 / 处理现有） */
export function messageCtx(m: { fromAddr: string; subject: string; listId?: string | null; isNewsletter?: boolean; hasAttachment?: boolean; to?: string }): RuleEvalContext {
  return { from: String(m.fromAddr ?? ''), to: m.to ?? '', subject: String(m.subject ?? ''), listId: m.listId ?? null, isNewsletter: !!m.isNewsletter, hasAttachment: !!m.hasAttachment, snippet: '' }
}
