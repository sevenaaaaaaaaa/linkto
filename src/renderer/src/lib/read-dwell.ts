import { useEffect, useRef } from 'react'
import { api } from './api'

/**
 * 阅读停留信号：打开一封未读邮件后几秒内就切走、且没有滚动 / 点击 / 按键 = 「打开后马上关掉、没读」。
 * 上报给主进程（ruleSuggestReadSignal）记进操作日志，规则建议据此提出「这类邮件你通常不看 → 自动标已读」。
 * 隐私：只上报邮件 id、判定结果与停留毫秒数；主进程只记元数据（发件人 / 主题模板 / List-Id），不碰正文。
 *
 * 判定（classifyDwell，纯函数）宁可不判也不误判：
 *  - 打开时已读的不算（重看一眼不代表「不看这类」）
 *  - 可见停留 < 0.8 秒：J/K 连续翻过去的，不算
 *  - 有任何互动（滚动 / 滚轮 / 点击正文或工具栏 / 选中文字 / 非翻页按键）或停留 ≥ 8 秒：读了
 *  - 正文很短（< 200 字）：几秒就能看完，分不清，不算
 *  - 0.8~4 秒、没互动：没读；4~8 秒之间不判
 */

export interface DwellSample {
  /** 窗口可见且聚焦时累计的停留（毫秒） */
  visibleMs: number
  scrolled: boolean
  clicked: boolean
  keyed: boolean
  /** 正文字数（纯文本） */
  bodyChars: number
  /** 打开时是否未读 */
  wasUnread: boolean
}

export const DWELL = { passMs: 800, noReadMs: 4000, readMs: 8000, minBodyChars: 200 }

export function classifyDwell(s: DwellSample, t = DWELL): 'noRead' | 'read' | null {
  if (!s.wasUnread) return null
  if (s.scrolled || s.clicked || s.keyed) return 'read'
  if (s.visibleMs >= t.readMs) return 'read'
  if (s.visibleMs < t.passMs) return null
  if (s.bodyChars < t.minBodyChars) return null
  return s.visibleMs < t.noReadMs ? 'noRead' : null
}

/** 翻页 / 关闭类按键不算互动 */
const NAV_KEYS = new Set(['j', 'k', 'J', 'K', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Tab', 'Shift', 'Meta', 'Control', 'Alt', 'PageUp', 'PageDown', 'Home', 'End'])

export function plainLength(text: string | null | undefined, html: string | null | undefined): number {
  if (text?.trim()) return text.replace(/\s+/g, ' ').trim().length
  if (!html) return 0
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length
}

/**
 * 阅读页挂载：messageId 变化 / 卸载时结算上一封。root = 阅读区根节点（互动只认它里面的）。
 */
export function useReadDwell(msg: { id: string; unread: boolean; text?: string | null; html?: string | null } | null, rootRef: React.RefObject<HTMLElement | null>) {
  const msgRef = useRef(msg)
  msgRef.current = msg
  const id = msg?.id ?? null
  useEffect(() => {
    const m = msgRef.current
    if (!id || !m) return
    const wasUnread = !!m.unread
    if (!wasUnread) return
    const bodyChars = plainLength(m.text, m.html)
    const st = { visibleMs: 0, since: 0, scrolled: false, clicked: false, keyed: false }
    const active = () => document.visibilityState === 'visible' && document.hasFocus()
    const start = () => {
      if (!st.since && active()) st.since = performance.now()
    }
    const pause = () => {
      if (st.since) st.visibleMs += performance.now() - st.since
      st.since = 0
    }
    start()
    const inRoot = (t: EventTarget | null) => !!rootRef.current && t instanceof Node && rootRef.current.contains(t)
    const onScroll = (e: Event) => {
      if (inRoot(e.target)) st.scrolled = true
    }
    const onWheel = (e: Event) => {
      if (inRoot(e.target)) st.scrolled = true
    }
    const onDown = (e: Event) => {
      if (inRoot(e.target)) st.clicked = true
    }
    const onKey = (e: KeyboardEvent) => {
      if (!NAV_KEYS.has(e.key)) st.keyed = true
    }
    const onVis = () => (active() ? start() : pause())
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('focus', onVis)
    window.addEventListener('blur', onVis)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('wheel', onWheel, true)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('focus', onVis)
      window.removeEventListener('blur', onVis)
      document.removeEventListener('visibilitychange', onVis)
      pause()
      const verdict = classifyDwell({ visibleMs: st.visibleMs, scrolled: st.scrolled, clicked: st.clicked, keyed: st.keyed, bodyChars, wasUnread })
      if (verdict) void api.ruleSuggestReadSignal({ messageId: id, verdict, dwellMs: Math.round(st.visibleMs) }).catch(() => {})
    }
    // 只跟着邮件 id 走：同一封邮件的状态刷新（已读标记、正文补全）不重新计时
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
}
