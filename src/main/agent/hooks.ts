import type { AgentActivity, AgentRef, AgentSkill } from '@shared/types'
import { BUILTIN_SKILLS } from './skills-catalog'

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

// ---------- 定时技能：运行时就绪后注册技能列表来源（内置 + 用户技能，含 schedule 字段） ----------

export type SkillLister = () => AgentSkill[] | Promise<AgentSkill[]>

let lister: SkillLister | null = null
const listerSubs = new Set<() => void>()

/** 运行时 / 技能库注册技能列表来源；技能增删改后可再调一次（或调用 notifySkillsChanged）让自动任务重建定时任务 */
export function setSkillLister(fn: SkillLister | null) {
  lister = fn
  notifySkillsChanged()
}

/** 技能有变化（新建 / 删除 / 改了 schedule）时调用，自动任务会刷新定时技能列表 */
export function notifySkillsChanged() {
  for (const cb of listerSubs) {
    try {
      cb()
    } catch {
      /* 订阅方自己兜底 */
    }
  }
}

/** 自动任务订阅技能变化 */
export function onSkillsChanged(cb: () => void): () => void {
  listerSubs.add(cb)
  return () => listerSubs.delete(cb)
}

/** 带 schedule 的技能（未注册来源时退回内置技能目录） */
export async function listSkillsForSchedule(): Promise<AgentSkill[]> {
  let list: AgentSkill[] = []
  try {
    list = lister ? await lister() : BUILTIN_SKILLS
  } catch {
    list = BUILTIN_SKILLS
  }
  return (list ?? []).filter(s => !!s?.schedule && !!s.schedule.every)
}

/** 全部技能（事件触发按 triggers 匹配；未注册来源时退回内置技能目录） */
export async function listAllSkills(): Promise<AgentSkill[]> {
  try {
    return (lister ? await lister() : BUILTIN_SKILLS) ?? []
  } catch {
    return BUILTIN_SKILLS
  }
}

// ---------- 附件正文读取（附件模块注册；事件触发 / 会后闭环 / 财务核对 / Agent 工具读取） ----------

export type AttachmentTextReader = (attachmentId: string, maxChars?: number) => Promise<string | null>

let textReader: AttachmentTextReader | null = null

export function setAttachmentTextReader(fn: AttachmentTextReader | null) {
  textReader = fn
}

/** 读附件正文（PDF 文本层 / 纯文本）；没注册或提取不到时返回 null */
export function readAttachmentText(attachmentId: string, maxChars = 20000): Promise<string | null> {
  return textReader ? textReader(attachmentId, maxChars).catch(() => null) : Promise.resolve(null)
}

// ---------- 跟进登记（跟进模块注册；Agent 工具 / 技能 / 撰写窗发出后调用） ----------

export type FollowupRegistrar = (input: {
  kind: import('@shared/types').FollowupKind
  ask: string
  to: string[]
  subject: string
  relatedMessageId?: string | null
  draftId?: string | null
  sentMessageId?: string | null
  waitDays?: number
  source: 'agent' | 'skill' | 'manual' | 'rule'
  financeId?: string | null
  projectId?: string | null
}) => string | null

let followupRegistrar: FollowupRegistrar | null = null

export function setFollowupRegistrar(fn: FollowupRegistrar | null) {
  followupRegistrar = fn
}

/** 登记一条跟进；跟进模块未就绪时返回 null */
export function registerFollowup(input: Parameters<FollowupRegistrar>[0]): string | null {
  return followupRegistrar ? followupRegistrar(input) : null
}
