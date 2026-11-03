import { useSyncExternalStore } from 'react'

/**
 * 侧栏折叠（收进账户 Dock）全局态：
 * - 折叠时文字侧栏整体消失，账户栏吸收核心导航 icon，顶部「全部账户」图标成为折叠入口
 * - 状态存 localStorage；折叠时 --sidebar-w 归零，原生壳标题带补色同步收缩
 * - useSyncExternalStore 让 AccountRail / Sidebar / MailShell 共享同一份状态，避免 prop 穿透
 */
const KEY = 'ms_sidebar_collapsed'
const EVT = 'ms:sidebar-collapse'

export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

function applyWidth(collapsed: boolean) {
  document.documentElement.style.setProperty('--sidebar-w', collapsed ? '0px' : '')
}

export function setSidebarCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(KEY, collapsed ? '1' : '0')
  } catch {
    /* 存储不可用时仅本次生效 */
  }
  applyWidth(collapsed)
  // 红绿灯三键只在极简模式显示（默认隐藏，hiddenInset 会压内容区标题带）
  void window.api?.macShellSetSidebarCollapsed?.(collapsed)
  window.dispatchEvent(new CustomEvent(EVT))
}

// 模块加载即同步一次，避免首帧侧栏闪现再收起；开机恢复极简模式时红绿灯同步显示
if (typeof document !== 'undefined') {
  applyWidth(readSidebarCollapsed())
  if (readSidebarCollapsed()) void window.api?.macShellSetSidebarCollapsed?.(true)
}

function subscribe(cb: () => void) {
  window.addEventListener(EVT, cb)
  return () => window.removeEventListener(EVT, cb)
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, readSidebarCollapsed)
}
