import { useEffect, useState } from 'react'

/** 主窗口一级视图（由 location.hash 驱动）—— 侧栏激活态与 MailShell 共用同一来源（审计 IA-1） */
export type View = 'mail' | 'kb' | 'insights' | 'agent' | 'todo' | 'attachments' | 'projects' | 'finance' | 'life' | 'feeds' | 'trace'

export function viewFromHash(): View {
  const h = location.hash
  if (h.startsWith('#/kb')) return 'kb'
  if (h.startsWith('#/insights')) return 'insights'
  if (h.startsWith('#/agent')) return 'agent'
  if (h.startsWith('#/todo')) return 'todo'
  if (h.startsWith('#/attachments')) return 'attachments'
  if (h.startsWith('#/projects')) return 'projects'
  if (h.startsWith('#/finance')) return 'finance'
  if (h.startsWith('#/life')) return 'life'
  if (h.startsWith('#/feeds')) return 'feeds'
  if (h.startsWith('#/trace')) return 'trace'
  return 'mail'
}

export function useView(): View {
  const [view, setView] = useState<View>(viewFromHash)
  useEffect(() => {
    const on = () => setView(viewFromHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return view
}

export function goView(view: View): void {
  const target = view === 'mail' ? '#/mail' : `#/${view}`
  if (location.hash !== target) location.hash = target
}

// ---------------------------------------------------------------- Agent 子页（#/agent…）

/** Agent 子页：#/agent（默认对话）· #/agent/chat[/<threadId>] · #/agent/skills · #/agent/auto · #/agent/memory */
export type AgentTab = 'chat' | 'skills' | 'auto' | 'memory'

export interface AgentRoute {
  tab: AgentTab
  /** 对话页打开的会话（#/agent/chat/<threadId>） */
  threadId: string | null
}

export function agentRouteFromHash(hash = location.hash): AgentRoute {
  const m = hash.match(/^#\/agent(?:\/([^/?]+))?(?:\/([^/?]+))?/)
  const seg = m?.[1]
  const tab: AgentTab = seg === 'skills' || seg === 'auto' || seg === 'memory' ? seg : 'chat'
  return { tab, threadId: tab === 'chat' && m?.[2] ? decodeURIComponent(m[2]) : null }
}

export function useAgentRoute(): AgentRoute {
  const [r, setR] = useState<AgentRoute>(() => agentRouteFromHash())
  useEffect(() => {
    const on = () => setR(agentRouteFromHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return r
}

export function agentHash(tab: AgentTab, threadId?: string | null): string {
  if (tab === 'chat') return threadId ? `#/agent/chat/${encodeURIComponent(threadId)}` : '#/agent/chat'
  return `#/agent/${tab}`
}

export function goAgent(tab: AgentTab, threadId?: string | null): void {
  const target = agentHash(tab, threadId)
  if (location.hash !== target) location.hash = target
}
