import { AsyncLocalStorage } from 'node:async_hooks'
import { powerMonitor } from 'electron'
import type { AgentJobSettings } from '@shared/types'
import type { AppStore } from '../store'
import { budgetLeft, consume, usedToday, type DailyUsage } from './schedule'

/**
 * 后台 AI 用量：自动任务与首次整理在 runAsBackground 里运行，期间发起的每个 AI 请求
 * （包括被它们触发的理解队列、财务 AI 补充、记忆学习）都经 AIService 的闸门计数；
 * 超过每天上限、或设置了「只在接通电源时」而正在用电池，就直接抛错，不发请求。
 * 用户主动操作（打开邮件、问 Agent、点按钮）不在后台上下文里，不受限制。
 */

const als = new AsyncLocalStorage<{ tag: string }>()

const SETTINGS_KEY = 'agentJobSettings'
const USAGE_KEY = 'agentAiUsage'

export const DEFAULT_JOB_SETTINGS: AgentJobSettings = {
  aiDailyLimit: 200,
  aiOnlyOnPower: false,
  kbDailyLimit: 12,
  notifySkills: true
}

export class BudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetError'
  }
}

export function runAsBackground<T>(tag: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ tag }, fn)
}

export function inBackground(): boolean {
  return !!als.getStore()
}

export function isBudgetError(err: unknown): boolean {
  return err instanceof BudgetError || (err instanceof Error && err.name === 'BudgetError')
}

export function onBattery(): boolean {
  try {
    return powerMonitor.isOnBatteryPower()
  } catch {
    return false
  }
}

export class AiBudget {
  constructor(private appStore: AppStore) {}

  settings(): AgentJobSettings {
    const s = this.appStore.get<AgentJobSettings>(SETTINGS_KEY, DEFAULT_JOB_SETTINGS)
    return {
      aiDailyLimit: Math.max(0, Math.min(5000, Math.round(Number(s.aiDailyLimit) || 0))),
      aiOnlyOnPower: !!s.aiOnlyOnPower,
      kbDailyLimit: Math.max(0, Math.min(200, Math.round(Number(s.kbDailyLimit) || 0))),
      notifySkills: s.notifySkills !== false
    }
  }

  setSettings(patch: Partial<AgentJobSettings>): AgentJobSettings {
    const { aiUsedToday: _ignored, ...rest } = patch ?? {}
    void _ignored
    this.appStore.set(SETTINGS_KEY, { ...this.settings(), ...rest })
    return this.withUsage()
  }

  withUsage(): AgentJobSettings {
    return { ...this.settings(), aiUsedToday: this.used() }
  }

  private usage(): DailyUsage | null {
    return this.appStore.getRaw<DailyUsage | null>(USAGE_KEY, null)
  }

  used(now = Date.now()): number {
    return usedToday(this.usage(), now)
  }

  left(now = Date.now()): number {
    return budgetLeft(this.usage(), this.settings().aiDailyLimit, now)
  }

  /** 后台 AI 现在能不能跑；不能时给出中文原因 */
  blocked(now = Date.now()): string | null {
    const s = this.settings()
    if (s.aiOnlyOnPower && onBattery()) return '正在用电池，AI 部分等接通电源后再跑'
    if (budgetLeft(this.usage(), s.aiDailyLimit, now) <= 0) return `今日后台 AI 用量已达上限（${s.aiDailyLimit} 次）`
    return null
  }

  /** AIService 闸门：只管后台上下文里的请求 */
  guard = () => {
    if (!inBackground()) return
    const why = this.blocked()
    if (why) throw new BudgetError(why)
    this.appStore.set(USAGE_KEY, consume(this.usage(), Date.now()))
  }
}
