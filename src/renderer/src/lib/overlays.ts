import { useEffect } from 'react'
import { create } from 'zustand'
import { overlayDequeue, overlayEnqueue, overlayHead, type OverlayRequest } from '@shared/upgrade'

/**
 * 「首次」类浮层协调器：升级向导、附件授权说明、快捷键提示……同一时间最多显示一个，其余排队。
 * 优先级：用户主动触发（interactive）> 升级向导 > 情境提示。
 * 只有优先级 ≥ 90 的（用户主动点开的）能顶掉正在显示的；其余等当前这个关掉再轮到。
 */
export const OVERLAY_PRIORITY = {
  /** 用户主动打开（如「去授权」）：立即显示 */
  interactive: 100,
  /** 升级向导 / 首次整理 */
  wizard: 50,
  /** 情境提示（快捷键教学） */
  tip: 10
} as const

interface OverlayState {
  queue: OverlayRequest[]
  current: string | null
  request(id: string, priority: number): void
  release(id: string): void
}

export const useOverlays = create<OverlayState>((set, get) => ({
  queue: [],
  current: null,
  request: (id, priority) => {
    const queue = overlayEnqueue(get().queue, { id, priority, at: Date.now() })
    set({ queue, current: overlayHead(queue, get().current) })
  },
  release: id => {
    const queue = overlayDequeue(get().queue, id)
    const cur = get().current === id ? null : get().current
    set({ queue, current: overlayHead(queue, cur) })
  }
}))

/**
 * 想显示时排队，返回「现在轮到我了吗」。wanted 变 false（关掉 / 不需要了）时自动出队。
 */
export function useOverlayTurn(id: string, wanted: boolean, priority: number): boolean {
  const current = useOverlays(st => st.current)
  useEffect(() => {
    if (!wanted) {
      useOverlays.getState().release(id)
      return
    }
    useOverlays.getState().request(id, priority)
    return () => useOverlays.getState().release(id)
  }, [id, wanted, priority])
  return wanted && current === id
}

/** 有没有「首次」浮层正在显示（其他浮动元素据此让位） */
export const useAnyOverlay = () => useOverlays(st => st.current !== null)
