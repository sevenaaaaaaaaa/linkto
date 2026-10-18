import { net, powerMonitor } from 'electron'
import type { AgentActivity, AgentJobInfo } from '@shared/types'
import type { AppStore } from '../store'
import { runAsBackground, isBudgetError } from './budget'
import { backoffMs, cadenceLabel, effectiveNextRun, HOUR_MS, shouldWaitForIdle, type JobCadence } from './schedule'

export interface JobRunContext {
  now: number
  lastRunAt: number | null
  /** 后台 AI 本轮可用（已配置、在线、未超额、未因电池暂停） */
  aiAllowed: boolean
  aiBlocked: string | null
  online: boolean
  manual: boolean
}

export interface JobOutcome {
  /** 一句话结果（任务列表「上次结果」） */
  summary: string
  /** 有实质产出时写一条活动记录 */
  activity?: Omit<AgentActivity, 'id' | 'at'> | null
}

export interface JobDef {
  id: string
  name: string
  description: string
  category: AgentJobInfo['category']
  ai: 'none' | 'optional' | 'required'
  cadence: JobCadence
  defaultEnabled: boolean
  /** 到期后等系统空闲再跑（最多等 maxDelayMs） */
  preferIdle?: { minIdleSec?: number; maxDelayMs?: number }
  /** 用 AI 时额外要求接通电源（知识库学习这类可以晚点跑的） */
  aiNeedsPower?: boolean
  needsNetwork?: boolean
  skillId?: string
  /** 开关由别处的设置决定（如每日简报跟随 AI 设置里的「每日简报」） */
  getEnabled?(): boolean
  setEnabled?(v: boolean): void
  run(ctx: JobRunContext): Promise<JobOutcome>
}

interface JobState {
  enabled?: boolean
  lastRunAt: number | null
  lastResult: string | null
  lastError: string | null
  retryAfter: number | null
  failures: number
}

const STATE_KEY = 'agentJobs'
const EMPTY: JobState = { lastRunAt: null, lastResult: null, lastError: null, retryAfter: null, failures: 0 }

function isOnline(): boolean {
  try {
    return net.isOnline()
  } catch {
    return true
  }
}

function systemIdle(): number {
  try {
    return powerMonitor.getSystemIdleTime()
  } catch {
    return 0
  }
}

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network/i.test(msg) && !/[一-龥]/.test(msg)) return '网络不通，稍后自动重试'
  return msg.slice(0, 200) || '运行失败'
}

/**
 * 自动任务调度器：统一注册表 + 串行执行（一次只跑一个，避免和同步 / 理解队列抢资源）。
 *  - 状态（开关 / 上次运行 / 结果 / 错误 / 退避）持久化在 AppStore（settings 表 agentJobs 键）
 *  - 应用启动后延迟开始；每分钟检查一次到期；休眠唤醒后补跑错过的（每个任务只补一次）
 *  - 离线：需要联网的任务跳过并记录，10 分钟后再看；AI 不可用时 AI 必需的任务跳过、可选的只跑规则部分
 */
export class JobScheduler {
  private defs = new Map<string, JobDef>()
  private queue: { id: string; manual: boolean; done?: (r: { ok: boolean; result?: string; error?: string }) => void }[] = []
  private current: string | null = null
  private timer: NodeJS.Timeout | null = null
  private started = false
  /** 启动延迟已过、开始按频率检查（之前的 kick 一律忽略，避免一启动就抢资源） */
  private live = false

  constructor(
    private deps: {
      appStore: AppStore
      /** 后台 AI 为什么不能用（null = 能用） */
      aiBlocked(online: boolean, def: JobDef): string | null
      log(a: Omit<AgentActivity, 'id' | 'at'>): void
      changed(): void
      tickMs?: number
    }
  ) {}

  // ---------------- 注册表 ----------------

  register(def: JobDef) {
    this.defs.set(def.id, def)
  }

  unregister(id: string) {
    this.defs.delete(id)
    this.queue = this.queue.filter(q => q.id !== id)
  }

  ids(): string[] {
    return [...this.defs.keys()]
  }

  get(id: string): JobDef | undefined {
    return this.defs.get(id)
  }

  // ---------------- 状态 ----------------

  private allState(): Record<string, JobState> {
    return this.deps.appStore.getRaw<Record<string, JobState>>(STATE_KEY, {}) ?? {}
  }

  private state(id: string): JobState {
    return { ...EMPTY, ...(this.allState()[id] ?? {}) }
  }

  private save(id: string, patch: Partial<JobState>) {
    const all = this.allState()
    all[id] = { ...EMPTY, ...(all[id] ?? {}), ...patch }
    this.deps.appStore.set(STATE_KEY, all)
  }

  enabled(def: JobDef): boolean {
    if (def.getEnabled) return def.getEnabled()
    const st = this.state(def.id)
    return st.enabled ?? def.defaultEnabled
  }

  setEnabled(id: string, v: boolean) {
    const def = this.defs.get(id)
    if (!def) return
    if (def.setEnabled) def.setEnabled(v)
    else this.save(id, { enabled: v })
    // 重新打开：清掉退避，下一轮检查按频率计算
    if (v) this.save(id, { retryAfter: null, failures: 0 })
    this.deps.changed()
    if (v) this.kick()
  }

  list(): AgentJobInfo[] {
    const now = Date.now()
    const online = isOnline()
    const idle = systemIdle()
    return [...this.defs.values()].map(def => {
      const st = this.state(def.id)
      const on = this.enabled(def)
      const why = def.ai === 'none' ? (def.needsNetwork && !online ? '离线' : null) : this.deps.aiBlocked(online, def)
      const due = effectiveNextRun(def.cadence, st.lastRunAt, st.retryAfter, now)
      const waiting = !why && due <= now && def.preferIdle && shouldWaitForIdle(due, now, idle, def.preferIdle)
      const blocked = why ? (def.ai === 'required' || def.needsNetwork ? `${why}，暂不运行` : `${why}，只跑规则部分`) : waiting ? '到点了，等电脑空闲时运行' : null
      return {
        id: def.id,
        name: def.name,
        description: def.description,
        category: def.category,
        cadence: cadenceLabel(def.cadence),
        enabled: on,
        running: this.current === def.id,
        lastRunAt: st.lastRunAt,
        nextRunAt: on ? Math.max(now, effectiveNextRun(def.cadence, st.lastRunAt, st.retryAfter, now)) : null,
        lastResult: st.lastResult,
        lastError: st.lastError,
        ai: def.ai,
        blockedReason: blocked,
        skillId: def.skillId ?? null
      }
    })
  }

  // ---------------- 调度 ----------------

  start(delayMs = 45_000) {
    if (this.started) return
    this.started = true
    setTimeout(() => {
      this.live = true
      this.tick()
      this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? 60_000)
    }, delayMs)
    // 休眠唤醒：等网络与 IMAP 重连后补跑错过的任务
    powerMonitor.on('resume', () => setTimeout(() => this.live && this.tick(), 45_000))
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 尽快检查一次（开关打开、技能变化后） */
  kick() {
    if (!this.live) return
    setTimeout(() => this.tick(), 1500)
  }

  tick() {
    const now = Date.now()
    const idle = systemIdle()
    for (const def of this.defs.values()) {
      if (!this.enabled(def) || this.current === def.id || this.queue.some(q => q.id === def.id)) continue
      const st = this.state(def.id)
      const due = effectiveNextRun(def.cadence, st.lastRunAt, st.retryAfter, now)
      if (due > now) continue
      if (def.preferIdle && shouldWaitForIdle(due, now, idle, def.preferIdle)) continue
      this.queue.push({ id: def.id, manual: false })
    }
    void this.pump()
  }

  /** 立即运行（不看频率与开关）；排在队首，等它跑完返回结果 */
  runNow(id: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    if (!this.defs.has(id)) return Promise.resolve({ ok: false, error: '没有这个任务' })
    if (this.current === id) return Promise.resolve({ ok: false, error: '正在运行' })
    return new Promise(resolve => {
      this.queue = this.queue.filter(q => q.id !== id)
      this.queue.unshift({ id, manual: true, done: resolve })
      this.deps.changed()
      void this.pump()
    })
  }

  private async pump() {
    if (this.current) return
    while (this.queue.length) {
      const item = this.queue.shift()!
      const def = this.defs.get(item.id)
      if (!def) {
        item.done?.({ ok: false, error: '没有这个任务' })
        continue
      }
      this.current = def.id
      this.deps.changed()
      let res: { ok: boolean; result?: string; error?: string }
      try {
        res = await this.exec(def, item.manual)
      } catch (err) {
        res = { ok: false, error: friendly(err) }
      }
      this.current = null
      this.deps.changed()
      item.done?.(res)
    }
  }

  private async exec(def: JobDef, manual: boolean): Promise<{ ok: boolean; result?: string; error?: string }> {
    const now = Date.now()
    const st = this.state(def.id)
    const online = isOnline()
    if (def.needsNetwork && !online) {
      const error = '离线，已跳过；联网后自动补跑'
      this.save(def.id, { lastError: error, retryAfter: now + 10 * 60_000 })
      return { ok: false, error }
    }
    const aiBlocked = def.ai === 'none' ? null : this.deps.aiBlocked(online, def)
    if (def.ai === 'required' && aiBlocked) {
      // 不算失败：AI 条件满足后（配置 / 接电 / 次日额度）再跑；一小时后重新检查
      const error = `${aiBlocked}，已跳过`
      this.save(def.id, { lastError: error, retryAfter: now + HOUR_MS })
      return { ok: false, error }
    }
    try {
      const out = await runAsBackground(`job:${def.id}`, () => def.run({ now, lastRunAt: st.lastRunAt, aiAllowed: !aiBlocked, aiBlocked, online, manual }))
      this.save(def.id, { lastRunAt: now, lastResult: out.summary, lastError: null, retryAfter: null, failures: 0 })
      if (out.activity) {
        try {
          this.deps.log(out.activity)
        } catch (err) {
          console.error('[jobs] activity log failed:', err)
        }
      }
      return { ok: true, result: out.summary }
    } catch (err) {
      const error = friendly(err)
      const failures = st.failures + 1
      // 用量上限：等到明天；其他错误按次数退避
      const retry = isBudgetError(err) ? now + 3 * HOUR_MS : now + backoffMs(failures)
      this.save(def.id, { lastError: error, failures, retryAfter: retry })
      console.error(`[jobs] ${def.id} failed:`, err)
      return { ok: false, error }
    }
  }
}
