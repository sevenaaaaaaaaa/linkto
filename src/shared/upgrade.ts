/**
 * 升级向导与「首次」浮层协调（主进程 / 渲染进程共用的纯函数与类型）。
 *
 * 版本口径：
 *  - 向导按「功能版本」= 主.次（0.4）记录，不看补丁号；nightly 版本 `0.4.0-nightly.20261014` 也归到 0.4
 *  - WIZARD_EDITION 是向导内容对应的功能版本：新一轮向导内容写好后把它改成新版本即可，
 *    与 package.json 的版本号脱钩（源码 dev 运行时 package.json 可能还是 0.3.3）
 */

/** 向导内容对应的功能版本（「这次有什么新东西」写的是哪一版） */
export const WIZARD_EDITION = '0.4'

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标识（nightly.20261014 / beta.1 …），正式版为 null */
  pre: string | null
}

/** 宽松解析：'v0.4.0-nightly.20261014' / '0.4' / '0.4.0+build' 都能解析；解析失败返回 null */
export function parseVersion(v: string | null | undefined): ParsedVersion | null {
  if (!v) return null
  const m = String(v).trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), pre: m[4] ?? null }
}

/** 功能版本键：主.次（nightly / 补丁号都归到同一个键） */
export function featureKey(v: string | null | undefined): string | null {
  const p = parseVersion(v)
  return p ? `${p.major}.${p.minor}` : null
}

/** 完整版本比较（semver 语义：预发布排在同号正式版之前；nightly.YYYYMMDD 按日期比） */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return !x && !y ? 0 : !x ? -1 : 1
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  const xs = x.pre.split('.')
  const ys = y.pre.split('.')
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const a1 = xs[i]
    const b1 = ys[i]
    if (a1 === undefined) return -1
    if (b1 === undefined) return 1
    const an = /^\d+$/.test(a1)
    const bn = /^\d+$/.test(b1)
    if (an && bn) {
      const d = Number(a1) - Number(b1)
      if (d) return d < 0 ? -1 : 1
    } else if (an !== bn) return an ? -1 : 1
    else if (a1 !== b1) return a1 < b1 ? -1 : 1
  }
  return 0
}

/** 只比较功能版本（主.次）；无法解析的视为最旧 */
export function compareFeature(a: string | null | undefined, b: string | null | undefined): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return !x && !y ? 0 : !x ? -1 : 1
  if (x.major !== y.major) return x.major < y.major ? -1 : 1
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1
  return 0
}

// ---------------------------------------------------------------- 向导状态（AppStore 持久化）

export interface UpgradeState {
  /** app.getVersion() */
  appVersion: string
  /** 当前向导的功能版本 */
  edition: string
  /** 上次看过（完成或跳过）向导的功能版本；从没看过为 null */
  lastSeen: string | null
  /** 第一次带着向导功能启动时的身份：fresh = 全新安装（当时没有账户）；upgrade = 老用户升级 */
  kind: 'fresh' | 'upgrade'
  /** 点「稍后」的累计次数 */
  later: number
  /** 上次看过向导时的完整应用版本（排查用） */
  lastSeenApp: string | null
}

export type WizardMode = 'full' | 'organize' | 'none'

export interface WizardDecisionInput {
  state: Pick<UpgradeState, 'lastSeen' | 'kind' | 'edition'>
  hasAccounts: boolean
  /** 本次启动里点过「稍后」 */
  laterThisSession: boolean
  /** 首次整理：有新加账户在等待整理（非老用户一次性提示），且本次启动没被「稍后」 */
  organizePending: boolean
}

/**
 * 该不该出向导、出哪种：
 *  - full：老用户升级到新功能版本后首次打开 → 新东西 / 授权 / 首次整理 / 侧栏
 *  - organize：新装用户首个账户同步完成，或以后再加账户 → （授权）+ 首次整理
 *  - none：新装还没账户（交给添加账户流程）、已看过、或本次点了稍后
 */
export function wizardDecision(input: WizardDecisionInput): WizardMode {
  if (input.laterThisSession) return 'none'
  const seen = !!input.state.lastSeen && compareFeature(input.state.lastSeen, input.state.edition) >= 0
  if (!seen && input.state.kind === 'upgrade' && input.hasAccounts) return 'full'
  if (input.hasAccounts && input.organizePending) return 'organize'
  return 'none'
}

export type WizardStep = 'whatsnew' | 'access' | 'organize' | 'sidebar'

/** 向导步骤：授权已问过时 organize 模式不再重复问；full 模式始终给一次回顾的机会 */
export function wizardSteps(mode: WizardMode, opts: { accessAsked: boolean }): WizardStep[] {
  if (mode === 'full') return ['whatsnew', 'access', 'organize', 'sidebar']
  if (mode === 'organize') return opts.accessAsked ? ['organize'] : ['access', 'organize']
  return []
}

// ---------------------------------------------------------------- 「首次」浮层协调队列

export interface OverlayRequest {
  id: string
  /** 越大越先；用户主动触发的（interactive）应给最高 */
  priority: number
  /** 入队时间（同优先级先来先显示） */
  at: number
}

/** 入队（同 id 只保留一个；已在队里时更新优先级但保留原入队时间，避免抖动） */
export function overlayEnqueue(queue: OverlayRequest[], req: OverlayRequest): OverlayRequest[] {
  const prev = queue.find(q => q.id === req.id)
  const next = queue.filter(q => q.id !== req.id)
  next.push(prev ? { ...req, at: prev.at } : req)
  return next.sort((a, b) => b.priority - a.priority || a.at - b.at)
}

export function overlayDequeue(queue: OverlayRequest[], id: string): OverlayRequest[] {
  return queue.some(q => q.id === id) ? queue.filter(q => q.id !== id) : queue
}

/**
 * 当前该显示谁：同一时间最多一个。
 * 已经在显示的（current）不会被普通优先级的后来者顶掉——只有更高优先级且标记 preempt 的才能插队
 * （例如用户主动点「去授权」时，正在显示的提示让位）。
 */
export function overlayHead(queue: OverlayRequest[], current: string | null, preemptAbove = 90): string | null {
  if (!queue.length) return null
  const top = queue[0]
  if (current && queue.some(q => q.id === current)) {
    const cur = queue.find(q => q.id === current)!
    if (top.id !== current && top.priority >= preemptAbove && top.priority > cur.priority) return top.id
    return current
  }
  return top.id
}
