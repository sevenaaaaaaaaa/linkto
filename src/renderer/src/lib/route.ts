import { useEffect, useState } from 'react'

/** 主窗口一级视图（由 location.hash 驱动）—— 侧栏激活态与 MailShell 共用同一来源（审计 IA-1） */
export type View = 'mail' | 'kb' | 'insights' | 'agent' | 'todo' | 'attachments' | 'projects'

export function viewFromHash(): View {
  const h = location.hash
  if (h.startsWith('#/kb')) return 'kb'
  if (h.startsWith('#/insights')) return 'insights'
  if (h.startsWith('#/agent')) return 'agent'
  if (h.startsWith('#/todo')) return 'todo'
  if (h.startsWith('#/attachments')) return 'attachments'
  if (h.startsWith('#/projects')) return 'projects'
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
