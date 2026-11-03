import { useEffect } from 'react'

/**
 * 红绿灯三键：所有场景默认隐藏（主进程创建窗口时 setWindowButtonVisibility(false)），
 * 需要时唤出——hover 左上角 3 秒，或 900ms 内连击左上角 3 次；
 * 唤出后鼠标离开左上角区域 3 秒自动收回。
 *
 * 纯 document 监听、不渲染任何元素：不遮挡 dock 内容（左上角贯通后是 layers 图标与侧栏标题带）。
 * 连击第 3 次在捕获阶段拦截，前两次落到下层的副作用是「开了又关」回到原状，无残留。
 * 主窗布局随 data-traffic 临时让位（见 global.css）；设置窗等其它窗口只切三键，不动布局。
 */
export function TrafficHotzone() {
  useEffect(() => {
    if (!/Mac/i.test(navigator.platform)) return
    let shown = false
    let inZone = false
    let hoverTimer = 0
    let hideTimer = 0
    let clicks = 0
    let clickTimer = 0

    const setTraffic = (on: boolean) => {
      shown = on
      document.documentElement.dataset.traffic = on ? 'shown' : 'hidden'
      void window.api?.setTrafficLights?.(on)
      // clearTimeout 后变量必须归零，否则后续 !hideTimer 判断失效、再也启动不了收回计时
      window.clearTimeout(hoverTimer)
      hoverTimer = 0
      window.clearTimeout(hideTimer)
      hideTimer = 0
    }

    const inHotzone = (e: MouseEvent) => e.clientX < 88 && e.clientY < 52

    const onMove = (e: MouseEvent) => {
      const z = inHotzone(e)
      if (shown) {
        // 鼠标留在左上角（含三键上）保持；离开 3 秒自动收回
        if (z) {
          window.clearTimeout(hideTimer)
          hideTimer = 0
        } else if (!hideTimer) {
          hideTimer = window.setTimeout(() => {
            hideTimer = 0
            setTraffic(false)
          }, 3000)
        }
        return
      }
      if (z && !inZone) {
        inZone = true
        window.clearTimeout(hoverTimer)
        hoverTimer = window.setTimeout(() => setTraffic(true), 3000)
      } else if (!z && inZone) {
        inZone = false
        window.clearTimeout(hoverTimer)
      }
    }

    const onDown = (e: MouseEvent) => {
      if (shown || !inHotzone(e)) return
      clicks += 1
      window.clearTimeout(clickTimer)
      clickTimer = window.setTimeout(() => {
        clicks = 0
      }, 900)
      if (clicks >= 3) {
        clicks = 0
        // 拦截第三次点击下传（前两次落到下层是「开了又关」，回到原状）
        e.preventDefault()
        e.stopPropagation()
        setTraffic(true)
      }
    }

    // 初始状态：三键隐藏、布局贯通（data-traffic 初值）
    document.documentElement.dataset.traffic = 'hidden'
    window.addEventListener('mousemove', onMove, { passive: true })
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mousedown', onDown, true)
      window.clearTimeout(hoverTimer)
      window.clearTimeout(hideTimer)
      window.clearTimeout(clickTimer)
    }
  }, [])
  return null
}
