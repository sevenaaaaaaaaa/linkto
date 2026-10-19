/**
 * 侧栏信息架构（纯函数，无 React / DOM 依赖，可单测）。
 *
 * 每个入口有三种去处：pin = 钉在侧栏（归到它的「核心」或「智能」组）· more = 收进「更多」· hidden = 隐藏（⌘K 仍可到达）。
 * 布局 = 用户覆盖 > 旧版侧栏开关（亲手关掉的 → 隐藏）> 升级时「已经在用」自动钉住 > 默认方案。
 * 顺序 = 用户排过的顺序在前，其余按默认顺序补齐。
 */

export type NavId =
  | 'inbox'
  | 'todo'
  | 'followup'
  | 'projects'
  | 'brief'
  | 'agent'
  | 'finance'
  | 'feeds'
  | 'life'
  | 'trace'
  | 'kb'
  | 'attachments'
  | 'snoozed'
  | 'flagged'
  | 'pinned'

export type Placement = 'pin' | 'more' | 'hidden'
export type NavGroup = 'core' | 'smart'

export interface NavDef {
  id: NavId
  label: string
  group: NavGroup
  placement: Placement
  /** 不能收起 / 隐藏（收件箱） */
  locked?: boolean
}

/** 默认方案（克制）：核心 4 个 + 智能 3 个，其余进「更多」 */
export const NAV_DEFS: NavDef[] = [
  { id: 'inbox', label: '收件箱', group: 'core', placement: 'pin', locked: true },
  { id: 'todo', label: '待办', group: 'core', placement: 'pin' },
  { id: 'followup', label: '等待对方', group: 'core', placement: 'pin' },
  { id: 'projects', label: '项目', group: 'core', placement: 'pin' },
  { id: 'brief', label: '今日简报', group: 'smart', placement: 'pin' },
  { id: 'agent', label: 'Agent', group: 'smart', placement: 'pin' },
  { id: 'finance', label: '财务', group: 'smart', placement: 'pin' },
  { id: 'feeds', label: '订阅', group: 'smart', placement: 'more' },
  { id: 'life', label: '生活档案', group: 'smart', placement: 'more' },
  { id: 'trace', label: '留痕', group: 'smart', placement: 'more' },
  { id: 'kb', label: '知识库', group: 'smart', placement: 'more' },
  { id: 'attachments', label: '附件', group: 'smart', placement: 'more' },
  { id: 'snoozed', label: '稍后处理', group: 'core', placement: 'more' },
  { id: 'flagged', label: '旗标', group: 'core', placement: 'more' },
  { id: 'pinned', label: '置顶', group: 'core', placement: 'more' }
]

const DEF = new Map(NAV_DEFS.map(d => [d.id, d]))
export const isNavId = (x: unknown): x is NavId => typeof x === 'string' && DEF.has(x as NavId)

/** 持久化的用户侧栏设置 */
export interface NavPrefs {
  /** 用户显式设置过的去处 */
  placement: Partial<Record<NavId, Placement>>
  /** 用户排过的顺序（可只含部分 id） */
  order: NavId[]
  /** 升级时按数据量算出的「已经在用」入口（只算一次，之后不随数据变化）；null = 还没算 */
  autoPinned: NavId[] | null
}

export const DEFAULT_NAV_PREFS: NavPrefs = { placement: {}, order: [], autoPinned: null }

/** 旧版「个性化 → 侧栏」开关（false = 用户关掉过） */
export interface LegacySidebarPrefs {
  followup?: boolean
  snoozed?: boolean
  flagged?: boolean
  pinned?: boolean
  brief?: boolean
  kb?: boolean
}

export interface NavLayout {
  core: NavId[]
  smart: NavId[]
  more: NavId[]
  hidden: NavId[]
  /** 每个入口最终的去处（编辑器用） */
  placement: Record<NavId, Placement>
  /** 全部入口的最终顺序（编辑器用） */
  order: NavId[]
}

/** 有数据就钉住：只对默认在「更多」里的入口生效；阈值按入口区分（旗标 / 置顶有 1 封就算在用） */
export function usagePins(usage: Partial<Record<string, number>>, defs: NavDef[] = NAV_DEFS): NavId[] {
  return defs.filter(d => d.placement === 'more' && (usage[d.id] ?? 0) > 0).map(d => d.id)
}

/** 把乱序 / 含未知 id / 重复的顺序整理成完整顺序：用户顺序在前，其余按默认顺序补齐 */
export function normalizeOrder(order: readonly unknown[], defs: NavDef[] = NAV_DEFS): NavId[] {
  const seen = new Set<NavId>()
  const out: NavId[] = []
  for (const x of order) if (isNavId(x) && !seen.has(x) && defs.some(d => d.id === x)) (seen.add(x), out.push(x))
  for (const d of defs) if (!seen.has(d.id)) out.push(d.id)
  return out
}

export function resolvePlacement(id: NavId, prefs: NavPrefs, legacy: LegacySidebarPrefs = {}, defs: NavDef[] = NAV_DEFS): Placement {
  const def = defs.find(d => d.id === id)
  if (!def) return 'hidden'
  if (def.locked) return 'pin'
  const own = prefs.placement[id]
  if (own === 'pin' || own === 'more' || own === 'hidden') return own
  // 旧版里用户亲手关掉的入口优先于「有数据就钉住」
  if ((legacy as Record<string, boolean | undefined>)[id] === false) return 'hidden'
  if (prefs.autoPinned?.includes(id)) return 'pin'
  return def.placement
}

export function computeNavLayout(prefs: NavPrefs, legacy: LegacySidebarPrefs = {}, defs: NavDef[] = NAV_DEFS): NavLayout {
  const order = normalizeOrder(prefs.order, defs)
  const placement = {} as Record<NavId, Placement>
  const out: NavLayout = { core: [], smart: [], more: [], hidden: [], placement, order }
  for (const id of order) {
    const p = resolvePlacement(id, prefs, legacy, defs)
    placement[id] = p
    const def = defs.find(d => d.id === id)!
    if (p === 'pin') out[def.group].push(id)
    else if (p === 'more') out.more.push(id)
    else out.hidden.push(id)
  }
  // 收件箱永远在核心组第一位
  if (out.core.includes('inbox')) out.core = ['inbox', ...out.core.filter(x => x !== 'inbox')]
  return out
}

/** 设定某入口的去处（locked 的忽略） */
export function setPlacement(prefs: NavPrefs, id: NavId, p: Placement, defs: NavDef[] = NAV_DEFS): NavPrefs {
  if (defs.find(d => d.id === id)?.locked) return prefs
  return { ...prefs, placement: { ...prefs.placement, [id]: p } }
}

/** 拖动排序：把 id 移到 target 之前（target 为 null = 移到最后）；返回完整顺序 */
export function reorderNav(prefs: NavPrefs, id: NavId, target: NavId | null, defs: NavDef[] = NAV_DEFS): NavPrefs {
  const order = normalizeOrder(prefs.order, defs).filter(x => x !== id)
  const at = target ? order.indexOf(target) : -1
  if (at < 0) order.push(id)
  else order.splice(at, 0, id)
  return { ...prefs, order }
}

/**
 * 上下移动：在「同一可见分区」里和相邻的入口交换（核心 / 智能 / 更多 / 隐藏各自排序），
 * 这样用户看到的效果就是这一行上移或下移一格。
 */
export function moveNav(prefs: NavPrefs, id: NavId, dir: -1 | 1, legacy: LegacySidebarPrefs = {}, defs: NavDef[] = NAV_DEFS): NavPrefs {
  const layout = computeNavLayout(prefs, legacy, defs)
  const bucket = (['core', 'smart', 'more', 'hidden'] as const).map(k => layout[k]).find(list => list.includes(id))
  if (!bucket) return prefs
  const i = bucket.indexOf(id)
  const j = i + dir
  if (j < 0 || j >= bucket.length) return prefs
  const other = bucket[j]
  if (other === 'inbox') return prefs
  const order = [...layout.order]
  const a = order.indexOf(id)
  const b = order.indexOf(other)
  ;[order[a], order[b]] = [order[b], order[a]]
  return { ...prefs, order }
}

/** 恢复默认（保留 autoPinned，避免把已经在用的入口又收起来） */
export function resetNav(prefs: NavPrefs): NavPrefs {
  return { placement: {}, order: [], autoPinned: prefs.autoPinned }
}

export interface Badge {
  count: number
  /** 只是「未读量」这类弱提示（订阅未读），不是逾期 / 异议 */
  muted?: boolean
}

/** 「更多」收起时的角标汇总：强提示（逾期 / 异议 / 到期）优先计数；只有弱提示时显示弱提示合计 */
export function moreBadge(ids: NavId[], badges: Partial<Record<NavId, Badge>>): Badge | null {
  let strong = 0
  let weak = 0
  for (const id of ids) {
    const b = badges[id]
    if (!b || !b.count) continue
    if (b.muted) weak += b.count
    else strong += b.count
  }
  if (strong) return { count: strong }
  if (weak) return { count: weak, muted: true }
  return null
}
