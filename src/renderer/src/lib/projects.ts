import { create } from 'zustand'
import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { projectHue, type ProjectListItem } from '@shared/projects'

/**
 * 项目数据（主进程 insights 表 kind='project'）的渲染层缓存：
 * 侧栏钉选、列表项目标签、阅读页关联条、待办项目维度、⌘K 共用一份。
 */
interface ProjectState {
  items: ProjectListItem[]
  loaded: boolean
  load(): Promise<void>
}

export const useProjects = create<ProjectState>(set => ({
  items: [],
  loaded: false,
  load: async () => {
    try {
      const items = await api.listProjects()
      set({ items, loaded: true })
    } catch {
      set({ loaded: true })
    }
  }
}))

let subscribed = false
let reloadTimer = 0
function scheduleReload(ms: number) {
  window.clearTimeout(reloadTimer)
  reloadTimer = window.setTimeout(() => void useProjects.getState().load(), ms)
}

/** 挂一次：项目 / 待办 / 款项 / 邮件变化时刷新（邮件变化频繁，节流） */
export function useProjectEvents() {
  useEffect(() => {
    if (!useProjects.getState().loaded) void useProjects.getState().load()
    if (subscribed) return
    subscribed = true
    const off = api.onEvent(ev => {
      const t = (ev as { type: string }).type
      if (t === 'projects-changed') scheduleReload(120)
      else if (t === 'todos-changed' || t === 'insights-changed') scheduleReload(600)
      else if (t === 'messages-changed') scheduleReload(2000)
    })
    return () => {
      subscribed = false
      void off()
    }
  }, [])
}

/** 活跃项目（进行中 + 暂停） */
export const isLive = (p: ProjectListItem) => p.data.status === 'active' || p.data.status === 'paused'

/** 邮件 → 所在项目（同一会话或单封） */
export function useProjectIndex() {
  const items = useProjects(st => st.items)
  return useMemo(() => {
    const byThread = new Map<string, ProjectListItem>()
    const byMessage = new Map<string, ProjectListItem>()
    const suggestByThread = new Map<string, { project: ProjectListItem; reason: string }>()
    // 已归档的项目排在后面，同一会话属于多个项目时优先显示进行中的
    const sorted = [...items].sort((a, b) => Number(isLive(b)) - Number(isLive(a)))
    for (const p of sorted) {
      for (const t of p.data.threadIds) if (!byThread.has(t)) byThread.set(t, p)
      for (const id of p.data.messageIds) if (!byMessage.has(id)) byMessage.set(id, p)
      for (const s of p.data.suggestions ?? []) if (!suggestByThread.has(s.threadId)) suggestByThread.set(s.threadId, { project: p, reason: s.reason })
    }
    const of = (msg: { id: string; threadId?: string | null }): ProjectListItem | null =>
      byMessage.get(msg.id) ?? (msg.threadId ? byThread.get(msg.threadId) : undefined) ?? byThread.get(msg.id) ?? null
    const suggestion = (msg: { id: string; threadId?: string | null }) => suggestByThread.get(msg.threadId || msg.id) ?? null
    return { of, suggestion }
  }, [items])
}

/** 项目名（活跃的在前），供待办的项目维度选择 */
export function useProjectNames(): string[] {
  useProjectEvents()
  const items = useProjects(st => st.items)
  return useMemo(() => items.filter(isLive).map(p => p.data.name), [items])
}

// ---------------------------------------------------------------- 颜色

/** 项目色：色相取自项目色名，明度 / 彩度来自 --proj-l / --proj-c token（随明暗切换） */
export function projectColor(p: { id: string; data: { color?: string | null } } | null | undefined): string {
  if (!p) return 'var(--faint)'
  return `oklch(var(--proj-l) var(--proj-c) ${projectHue(p.data.color, p.id)})`
}

export function projectSoft(p: { id: string; data: { color?: string | null } }): string {
  return `oklch(var(--proj-l) var(--proj-c) ${projectHue(p.data.color, p.id)} / var(--proj-soft-a))`
}

export function hueColor(hue: number): string {
  return `oklch(var(--proj-l) var(--proj-c) ${hue})`
}

// ---------------------------------------------------------------- 路由（#/projects…）

export type ProjectTab = 'timeline' | 'mail' | 'overview'

export type ProjectRoute =
  | { mode: 'list' }
  | { mode: 'project'; id: string; tab: ProjectTab }
  | { mode: 'contact'; key: string }

export function parseProjectRoute(hash = location.hash): ProjectRoute {
  const m = hash.match(/^#\/projects(?:\/([^/?]+))?(?:\/([^/?]+))?/)
  if (!m || !m[1]) return { mode: 'list' }
  if (m[1] === 'contact' && m[2]) return { mode: 'contact', key: decodeURIComponent(m[2]) }
  const tab = (['timeline', 'mail', 'overview'] as const).find(t => t === m[2]) ?? 'timeline'
  return { mode: 'project', id: decodeURIComponent(m[1]), tab }
}

export function useProjectRoute(): ProjectRoute {
  const [r, setR] = useState(parseProjectRoute)
  useEffect(() => {
    const on = () => setR(parseProjectRoute())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return r
}

export function openProject(id: string, tab?: ProjectTab) {
  location.hash = `#/projects/${encodeURIComponent(id)}${tab && tab !== 'timeline' ? `/${tab}` : ''}`
}

export function openProjects() {
  location.hash = '#/projects'
}

/** 与联系人（地址）或公司（域名）的往来时间线 */
export function openContactTimeline(key: string) {
  location.hash = `#/projects/contact/${encodeURIComponent(key.toLowerCase())}`
}

// ---------------------------------------------------------------- 全局动作（事件解耦：任何地方都能唤起）

/** 唤起「加入项目…」选择器 */
export function pickProjectFor(messageIds: string[]) {
  window.dispatchEvent(new CustomEvent('ms:project-pick', { detail: messageIds }))
}

export function toast(text: string) {
  window.dispatchEvent(new CustomEvent('ms:toast', { detail: text }))
}

/** 从邮件建项目并跳过去 */
export async function createProjectFromMessage(messageId: string) {
  const p = await api.projectFromMessage(messageId)
  if (!p) return toast('没能建成项目')
  await useProjects.getState().load()
  toast(`已建项目「${p.data.name}」`)
  openProject(p.id)
}

export function fmtAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—'
  const d0 = new Date(now)
  d0.setHours(0, 0, 0, 0)
  const days = Math.round((d0.getTime() - new Date(ts).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 0) return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  const d = new Date(ts)
  return d.getFullYear() === d0.getFullYear() ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
