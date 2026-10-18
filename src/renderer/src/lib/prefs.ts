import { useEffect, useState } from 'react'

/**
 * 个性化偏好（纯界面层，按设备保存在 localStorage）。
 * 主窗口与设置窗同源共享 localStorage：设置窗改动后主窗口通过 storage 事件即时生效。
 */
export interface UiPrefs {
  /** 列表密度：舒适 / 紧凑 */
  density: 'cozy' | 'compact'
  /** 列表第三行：AI 要点 / 原文摘要 / 不显示 */
  rowPreview: 'gist' | 'snippet' | 'none'
  /** 收件箱 AI 分区 */
  sections: boolean
  /** 今日简报卡 */
  brief: boolean
  /** 正文字号（px） */
  readerSize: 13 | 14 | 15 | 16 | 17
  /** 正文宽度：适中（易读）/ 铺满 */
  readerWidth: 'comfort' | 'full'
  /** 正文 AI 划重点 */
  highlights: boolean
  /** 打开邮件时右侧栏默认显示 */
  defaultRail: 'context' | 'agent' | 'none'
  /** 界面字体：Geist + 苹方 / 纯系统字体 */
  uiFont: 'geist' | 'system'
  /** 侧栏显示的入口 */
  sidebar: { followup: boolean; snoozed: boolean; flagged: boolean; pinned: boolean; brief: boolean; kb: boolean; onboarding: boolean }
  /** 单键快捷键（E / S / R / V / J / K）——与输入法冲突时可关闭 */
  singleKey: boolean
}

export const DEFAULT_PREFS: UiPrefs = {
  density: 'cozy',
  rowPreview: 'gist',
  sections: true,
  brief: true,
  readerSize: 14,
  readerWidth: 'comfort',
  highlights: true,
  defaultRail: 'context',
  uiFont: 'geist',
  sidebar: { followup: true, snoozed: true, flagged: true, pinned: true, brief: true, kb: true, onboarding: true },
  singleKey: true
}

const KEY = 'ms_ui_prefs'

export function getPrefs(): UiPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<UiPrefs>
    return { ...DEFAULT_PREFS, ...raw, sidebar: { ...DEFAULT_PREFS.sidebar, ...(raw.sidebar ?? {}) } }
  } catch {
    return DEFAULT_PREFS
  }
}

export function setPrefs(patch: Partial<UiPrefs>) {
  const next = { ...getPrefs(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* 存储不可用时只影响本次 */
  }
  // 同窗口内的订阅者（storage 事件只通知其他窗口）
  window.dispatchEvent(new CustomEvent('ms:prefs'))
  applyPrefsToDocument(next)
}

/** 把影响全局样式的偏好写到根节点（密度 / 字号 / 字体），组件只读 CSS 变量 */
export function applyPrefsToDocument(p: UiPrefs = getPrefs()) {
  const root = document.documentElement
  root.dataset.density = p.density
  root.style.setProperty('--reader-size', `${p.readerSize}px`)
  root.style.setProperty('--reader-max', p.readerWidth === 'comfort' ? '760px' : 'none')
  if (p.uiFont === 'system') root.style.setProperty('--font-body', "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'HarmonyOS Sans SC', 'Segoe UI', sans-serif")
  else root.style.removeProperty('--font-body')
}

export function usePrefs(): UiPrefs {
  const [p, setP] = useState(getPrefs)
  useEffect(() => {
    const sync = () => {
      const next = getPrefs()
      setP(next)
      applyPrefsToDocument(next)
    }
    const onStorage = (e: StorageEvent) => e.key === KEY && sync()
    window.addEventListener('storage', onStorage)
    window.addEventListener('ms:prefs', sync)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('ms:prefs', sync)
    }
  }, [])
  return p
}
