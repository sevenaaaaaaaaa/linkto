import type { AgentActivity, AgentRef } from '@shared/types'

/**
 * Agent 运行时 / 技能 / 自动任务三块之间的挂钩点（解耦初始化顺序）：
 * - 运行时启动后 setSkillRunner，自动任务用 runSkillHeadless 定时跑技能
 * - 自动任务模块 setActivityLogger，任何地方 logActivity 写活动记录
 */
export type SkillRunner = (skillId: string, params?: Record<string, string | number>) => Promise<{ ok: boolean; text: string; refs: AgentRef[]; error?: string }>

let runner: SkillRunner | null = null
let logger: ((a: Omit<AgentActivity, 'id' | 'at'>) => void) | null = null

export function setSkillRunner(fn: SkillRunner | null) {
  runner = fn
}

export function runSkillHeadless(skillId: string, params?: Record<string, string | number>) {
  if (!runner) return Promise.resolve({ ok: false, text: '', refs: [], error: 'Agent 运行时尚未就绪' })
  return runner(skillId, params)
}

export function setActivityLogger(fn: ((a: Omit<AgentActivity, 'id' | 'at'>) => void) | null) {
  logger = fn
}

export function logActivity(a: Omit<AgentActivity, 'id' | 'at'>) {
  logger?.(a)
}
