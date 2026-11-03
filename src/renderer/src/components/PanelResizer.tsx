import { useRef, useState } from 'react'

/**
 * 列宽拖拽调节：
 * - `usePanelWidth`：宽度存 localStorage（null = 用样式表默认 clamp 宽度）
 * - `PanelGrip`：贴在列边缘的隐形拖柄，按住左右拖调宽；双击恢复默认
 * 拖动范围 min~max 由调用方定；列必须 `relative`，拖柄作为它的直接子元素。
 */
export function usePanelWidth(storageKey: string, min: number, max: number) {
  const [width, setWidth] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(storageKey))
      return Number.isFinite(v) && v >= min && v <= max ? v : null
    } catch {
      return null
    }
  })
  return [width, setWidth] as const
}

export function PanelGrip(props: {
  storageKey: string
  min: number
  max: number
  /** 手柄贴列的哪条边：右缘（列表往右拖）或左缘（右侧栏往左拖） */
  side: 'right' | 'left'
  onResize(w: number | null): void
  label: string
}) {
  const dragging = useRef(false)
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const grip = e.currentTarget as HTMLElement
    const col = grip.parentElement
    if (!col) return
    const startX = e.clientX
    const startW = col.getBoundingClientRect().width
    dragging.current = true
    grip.classList.add('panel-grip-on')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const move = (ev: PointerEvent) => {
      const delta = (ev.clientX - startX) * (props.side === 'left' ? -1 : 1)
      props.onResize(Math.round(Math.min(props.max, Math.max(props.min, startW + delta))))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      dragging.current = false
      grip.classList.remove('panel-grip-on')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try {
        localStorage.setItem(props.storageKey, String(Math.round(col.getBoundingClientRect().width)))
      } catch {
        /* 存储不可用时仅本次生效 */
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const reset = () => {
    try {
      localStorage.removeItem(props.storageKey)
    } catch {
      /* 同上 */
    }
    props.onResize(null)
  }
  return (
    <div
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
      title={`${props.label}（拖动调宽 · 双击恢复默认）`}
      className={`panel-grip absolute top-0 bottom-0 z-30 ${props.side === 'right' ? '-right-[2px]' : '-left-[2px]'} w-[5px] cursor-col-resize`}
    />
  )
}
