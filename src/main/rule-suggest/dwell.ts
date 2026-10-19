import type { RuleAction } from '@shared/types'
import { isPublicDomain } from '@shared/projects'
import {
  conditionsFor, ctxOf, DAY_MS, eventInScope, fingerprint, hostOf, isPersonalScope, normListId, regDomain, scopeDomain, scopeLabel, WINDOW_DAYS,
  type Candidate, type MineEvent, type Scope
} from './mine'

/**
 * 「打开后马上关掉、没读」→ 规则建议（纯函数，便于单测）。
 *
 * 信号来自阅读页的停留判定（渲染端 lib/read-dwell.ts）：只看打开时还是未读的邮件，
 *  - openNoRead：可见停留很短（< 4 秒）、没有滚动 / 点击 / 选中文字 / 按键，正文又不短
 *  - openRead：停留够久或有任何互动（作为分母）
 * 同一封既有 openNoRead 又有 openRead / 旗标 / 置顶 / 转待办，算「读了」。
 *
 * 门槛比其它习惯更高（宁少勿多）：同组 ≥ 8 封、跨 ≥ 5 天、一致率 ≥ 90%（「没读」/ 打开过的），
 * 个人往来（回复过 / 发过信、多数在「需要你处理」）不提。建议动作只是「自动标已读」——可逆、无损。
 */

export const NOREAD_THRESHOLD = { support: 8, days: 5, conf: 0.9 }
/** 视为「读了 / 在意」的其它动作 */
const ENGAGED = new Set(['openRead', 'flag', 'pin', 'createTodo', 'snooze', 'moveFolder'])

const evFrom = (e: MineEvent) => String(e.fromAddr ?? '').toLowerCase()
const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
const md = (t: number) => {
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export interface NoReadStats {
  /** 打开后没读的邮件数（按邮件去重，且后来没再读） */
  support: number
  /** 打开过的邮件数（分母：没读 + 读了） */
  opened: number
  days: number
  confidence: number
  firstAt: number
  lastAt: number
  events: MineEvent[]
}

export function noReadStats(scope: Scope, events: MineEvent[]): NoReadStats {
  const inScope = events.filter(e => eventInScope(scope, e))
  const engaged = new Set(inScope.filter(e => ENGAGED.has(e.action)).map(e => e.messageId))
  const openedIds = new Set(inScope.filter(e => e.action === 'openNoRead' || e.action === 'openRead').map(e => e.messageId))
  const byMsg = new Map<string, MineEvent>()
  for (const e of inScope) if (e.action === 'openNoRead' && !engaged.has(e.messageId)) byMsg.set(e.messageId, e)
  const evs = [...byMsg.values()]
  const days = new Set(evs.map(e => dayKey(e.at))).size
  return {
    support: evs.length,
    opened: openedIds.size,
    days,
    confidence: openedIds.size ? evs.length / openedIds.size : 0,
    firstAt: evs.length ? Math.min(...evs.map(e => e.at)) : 0,
    lastAt: evs.length ? Math.max(...evs.map(e => e.at)) : 0,
    events: evs
  }
}

export function mineOpenNoRead(input: { now: number; events: MineEvent[]; knownContacts: Set<string> | string[] }): Candidate[] {
  const now = input.now
  const known = input.knownContacts instanceof Set ? input.knownContacts : new Set(input.knownContacts.map(a => a.toLowerCase()))
  const events = input.events.filter(e => e.at >= now - WINDOW_DAYS * DAY_MS && e.at <= now + DAY_MS && e.messageId)
  const noRead = events.filter(e => e.action === 'openNoRead')
  if (noRead.length < NOREAD_THRESHOLD.support) return []

  const scopes: Scope[] = []
  const addrs = new Set(noRead.map(evFrom).filter(a => a.includes('@')))
  for (const addr of addrs) scopes.push({ kind: 'addr', addr })
  for (const l of new Set(noRead.map(e => normListId(e.listId)).filter(Boolean))) scopes.push({ kind: 'list', listId: l })
  for (const d of new Set([...addrs].map(a => regDomain(hostOf(a))).filter(d => d && !isPublicDomain(d)))) scopes.push({ kind: 'domain', domain: d })

  const passing: Candidate[] = []
  for (const scope of scopes) {
    const st = noReadStats(scope, events)
    if (st.support < NOREAD_THRESHOLD.support || st.days < NOREAD_THRESHOLD.days || st.confidence < NOREAD_THRESHOLD.conf) continue
    if (isPersonalScope(scope, st.events, known)) continue
    const conditions = conditionsFor(scope)
    const actions: RuleAction[] = [{ type: 'markRead' }]
    const label = scopeLabel(scope)
    const from = scope.kind === 'list' ? `${label} 的` : `来自 ${label} 的`
    passing.push({
      scope,
      action: 'openNoRead',
      value: null,
      conditions,
      actions,
      name: `自动标已读：${label}`.slice(0, 60),
      title: `你最近 ${WINDOW_DAYS} 天打开了 ${st.support} 封${from}邮件，几秒就关掉、没有读`,
      evidence: [
        `${st.support} 封，跨 ${st.days} 天（${md(st.firstAt)}–${md(st.lastAt)}）`,
        `打开过的 ${st.opened} 封里 ${st.support} 封没读（停留不到几秒、没有滚动或点击）`,
        '只建议标为已读，不移动、不删除'
      ].join('；'),
      support: st.support,
      eff: st.support,
      days: st.days,
      confidence: Math.round(st.confidence * 1000) / 1000,
      total: st.opened,
      unreadRate: 1,
      firstAt: st.firstAt,
      lastAt: st.lastAt,
      eventMessageIds: st.events.map(e => e.messageId),
      contexts: st.events.map(ctxOf),
      domain: scopeDomain(scope),
      fingerprint: fingerprint(conditions, actions),
      // 比同等次数的手动习惯略低一档：信号是推断出来的
      score: st.support * st.confidence * Math.min(1, st.days / 5) * 0.8
    })
  }
  // 域名 vs 其下的地址：域名明显覆盖更多（≥ 1.5 倍）才用域名
  const drop = new Set<Candidate>()
  for (const p of passing) {
    if (p.scope.kind !== 'domain') continue
    const subs = passing.filter(q => q !== p && q.domain === p.domain && q.scope.kind !== 'domain')
    if (!subs.length) continue
    if (p.support >= Math.max(...subs.map(q => q.support)) * 1.5) subs.forEach(q => drop.add(q))
    else drop.add(p)
  }
  // 覆盖重叠 ≥ 60% 的只留更具体的
  const order: Record<Scope['kind'], number> = { addr: 0, list: 1, 'addr+kw': 2, 'domain+kw': 3, domain: 4, newsletter: 5 }
  const covered = new Set<string>()
  const out: Candidate[] = []
  for (const c of passing.filter(c => !drop.has(c)).sort((a, b) => order[a.scope.kind] - order[b.scope.kind] || b.support - a.support)) {
    const overlap = c.eventMessageIds.filter(id => covered.has(id)).length / c.eventMessageIds.length
    if (overlap >= 0.6) continue
    c.eventMessageIds.forEach(id => covered.add(id))
    out.push(c)
  }
  return out.sort((a, b) => b.score - a.score)
}
