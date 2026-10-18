import { create } from 'zustand'
import { useEffect } from 'react'
import { api } from './api'
import { goAgent } from './route'
import { useMail } from '../stores/mail'
import { BUILTIN_SKILLS, SKILL_CATEGORIES } from '@shared/agent-skills'
import type { AgentSkill, AgentToolInfo } from '@shared/types'

/**
 * 技能库的渲染层缓存：侧栏钉住技能、⌘K「运行技能」、技能库页、右栏快捷入口共用一份。
 * 运行时未就绪（agentSkills 无 handler / 出错）时退回内置目录（只读，修改仅本次会话生效）。
 */
interface SkillState {
  skills: AgentSkill[]
  tools: AgentToolInfo[]
  loaded: boolean
  /** true = 运行时没有响应，正在用渲染端的内置目录副本 */
  fallback: boolean
  load(): Promise<void>
  loadTools(): Promise<void>
  save(skill: AgentSkill): Promise<AgentSkill>
  remove(id: string): Promise<void>
  togglePin(id: string): Promise<void>
}

export const useSkills = create<SkillState>((set, get) => ({
  skills: [],
  tools: [],
  loaded: false,
  fallback: false,
  load: async () => {
    try {
      const skills = await api.agentSkills()
      set({ skills: Array.isArray(skills) && skills.length ? skills : BUILTIN_SKILLS, loaded: true, fallback: !Array.isArray(skills) || !skills.length })
    } catch {
      // 保留本次会话里的修改（钉住等），只在首次加载时用内置目录
      set(st => ({ skills: st.loaded ? st.skills : BUILTIN_SKILLS, loaded: true, fallback: true }))
    }
  },
  loadTools: async () => {
    try {
      const tools = await api.agentTools()
      set({ tools: Array.isArray(tools) ? tools : [] })
    } catch {
      set({ tools: [] })
    }
  },
  save: async skill => {
    const next = { ...skill, updatedAt: Date.now() }
    try {
      const saved = await api.agentSaveSkill(next)
      set(st => ({ skills: upsert(st.skills, saved ?? next), fallback: false }))
      return saved ?? next
    } catch {
      set(st => ({ skills: upsert(st.skills, next), fallback: true }))
      window.dispatchEvent(new CustomEvent('ms:toast', { detail: 'Agent 运行时未就绪：修改只在本次打开期间有效' }))
      return next
    }
  },
  remove: async id => {
    try {
      await api.agentDeleteSkill(id)
    } catch {
      /* 运行时未就绪：只从本地列表移除 */
    }
    set(st => ({ skills: st.skills.filter(s => s.id !== id) }))
  },
  togglePin: async id => {
    const s = get().skills.find(x => x.id === id)
    if (s) await get().save({ ...s, pinned: !s.pinned })
  }
}))

function upsert(list: AgentSkill[], s: AgentSkill): AgentSkill[] {
  const i = list.findIndex(x => x.id === s.id)
  if (i < 0) return [...list, s]
  const next = [...list]
  next[i] = s
  return next
}

/** 挂载时确保技能已加载（多处挂载只加载一次；窗口重新聚焦时刷新，捕获自动任务 / 运行时侧的改动） */
let subscribed = false
export function useSkillsLoader() {
  useEffect(() => {
    if (!useSkills.getState().loaded) void useSkills.getState().load()
    if (subscribed) return
    subscribed = true
    const onFocus = () => void useSkills.getState().load()
    window.addEventListener('focus', onFocus)
    return () => {
      subscribed = false
      window.removeEventListener('focus', onFocus)
    }
  }, [])
}

/** 分类排序：内置分类按目录顺序，其余（用户自定义分类）排在后面 */
export function categoryOrder(c: string): number {
  const i = (SKILL_CATEGORIES as readonly string[]).indexOf(c)
  return i < 0 ? SKILL_CATEGORIES.length : i
}

export function sortSkills(list: AgentSkill[]): AgentSkill[] {
  const pos = new Map(BUILTIN_SKILLS.map((s, i) => [s.id, i]))
  return [...list].sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category) || (pos.get(a.id) ?? 999) - (pos.get(b.id) ?? 999) || a.name.localeCompare(b.name, 'zh'))
}

export const OUTPUT_LABEL: Record<NonNullable<AgentSkill['output']>, string> = {
  report: '报告',
  actions: '动作清单',
  draft: '邮件草稿'
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
export function scheduleLabel(s: AgentSkill['schedule']): string | null {
  if (!s) return null
  if (s.every === 'hour') return '每小时'
  if (s.every === 'day') return `每天 ${s.at ?? '08:00'}`
  return `每${WEEKDAYS[s.weekday ?? 1] ?? '周一'} ${s.at ?? '08:00'}`
}

// ---------------------------------------------------------------- 运行

export type SkillParams = Record<string, string | number>

export interface SkillLaunch {
  skillId: string
  params: SkillParams
  /** 针对的邮件（右栏 / 需要邮件上下文的技能） */
  messageId?: string | null
  nonce: number
}

let pending: SkillLaunch | null = null

/** 对话页查看待运行的技能（不消费；StrictMode 下初始化函数会被调用两次） */
export function peekPendingLaunch(): SkillLaunch | null {
  return pending
}

/** 对话页已接手这次运行：清掉（只清同一次，避免误清后来的投递） */
export function clearPendingLaunch(nonce: number) {
  if (pending?.nonce === nonce) pending = null
}

/** 跳到 Agent 对话页，并以 initial.skillId 启动技能 */
export function launchSkill(skillId: string, params: SkillParams = {}, messageId?: string | null) {
  pending = { skillId, params, messageId: messageId ?? null, nonce: Date.now() }
  goAgent('chat')
  window.dispatchEvent(new CustomEvent('ms:agent-launch'))
}

/** 参数默认值（未填的可选参数不传，由说明里的「为空则…」处理） */
export function defaultParams(skill: AgentSkill): SkillParams {
  const out: SkillParams = {}
  for (const p of skill.params ?? []) if (p.default !== undefined && p.default !== '') out[p.key] = p.default
  return out
}

/** 是否需要先弹参数卡：有必填但没默认值的参数，或需要邮件上下文 */
export function needsParamCard(skill: AgentSkill): boolean {
  return !!skill.contextKind || (skill.params ?? []).some(p => p.required && (p.default === undefined || p.default === ''))
}

export interface SkillRunRequest {
  skill: AgentSkill
  /** 预填参数（如右栏把当前发件人填进 contact） */
  prefill?: SkillParams
  messageId?: string | null
  /** 不给 = 跳到对话页运行 */
  onRun?(params: SkillParams, messageId: string | null): void
  /** true = 总是弹参数卡（技能库「运行」按钮让用户看一眼参数） */
  always?: boolean
}

/** 运行技能的统一入口：需要参数时弹参数卡（SkillRunHost），否则直接运行 */
export function requestSkillRun(req: SkillRunRequest) {
  const hasParams = !!req.skill.params?.length
  if (needsParamCard(req.skill) || (req.always && hasParams)) {
    window.dispatchEvent(new CustomEvent<SkillRunRequest>('ms:skill-run-request', { detail: req }))
    return
  }
  const params = { ...defaultParams(req.skill), ...req.prefill }
  const messageId = req.messageId ?? (req.skill.contextKind === 'message' ? useMail.getState().selectedId : null)
  if (req.onRun) req.onRun(params, messageId)
  else launchSkill(req.skill.id, params, messageId)
}
