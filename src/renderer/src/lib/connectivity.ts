import { create } from 'zustand'
import { useEffect } from 'react'
import { api } from './api'
import { useMail } from '../stores/mail'
import type { ToastPayload } from './ai-error'

/**
 * 联网状态：渲染端 navigator.onLine（含 online/offline 事件）× 主进程 net.isOnline。
 * 任一判定离线即视为离线；离线时侧栏底部给出「已缓存的邮件可照常阅读 + N 项待同步」，恢复后自动同步一次。
 */
interface ConnectivityState {
  online: boolean
  pendingOps: number
}

export const useConnectivityState = create<ConnectivityState>(() => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pendingOps: 0
}))

/** 恢复联网：立即让所有启用账户重连同步（退避等待中的 worker 会被打断） */
function resyncAll() {
  for (const a of useMail.getState().accounts) if (a.status !== 'disabled') void api.syncAccountNow(a.id)
}

/** 在主窗口挂一次（MailShell） */
export function useConnectivity(toast: (p: string | ToastPayload | null, ms?: number) => void) {
  useEffect(() => {
    let alive = true
    let timer = 0
    const refresh = async () => {
      let main = { online: true, pendingOps: useConnectivityState.getState().pendingOps }
      try {
        main = await api.connectivity()
      } catch { /* 主进程暂不可用：只看 navigator */ }
      if (!alive) return
      const online = navigator.onLine && main.online
      const prev = useConnectivityState.getState()
      useConnectivityState.setState({ online, pendingOps: main.pendingOps })
      if (!prev.online && online) {
        resyncAll()
        toast(main.pendingOps ? `已恢复连接 · 正在同步 ${main.pendingOps} 项离线操作` : '已恢复连接', 2600)
      }
    }
    // 离线时 4s 轮询一次（主进程判定 / 待同步数），在线时 30s
    const loop = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(async () => {
        await refresh()
        if (alive) loop()
      }, useConnectivityState.getState().online ? 30_000 : 4_000)
    }
    const onChange = () => {
      void refresh().then(loop)
    }
    window.addEventListener('online', onChange)
    window.addEventListener('offline', onChange)
    // 兜底：部分网络切换（及 DevTools 断网仿真）不派发 online/offline 事件，3s 比对一次 navigator.onLine（零开销）
    let lastNav = navigator.onLine
    const navTimer = window.setInterval(() => {
      if (navigator.onLine !== lastNav) {
        lastNav = navigator.onLine
        onChange()
      }
    }, 3000)
    // 离线暂存 / 重放进度事件：刷新待同步数
    const off = api.onEvent(ev => {
      const e = ev as { type?: string; text?: string }
      if (e.type === 'sync-progress' && /离线/.test(e.text ?? '')) void refresh()
    })
    void refresh().then(loop)
    return () => {
      alive = false
      window.clearTimeout(timer)
      window.clearInterval(navTimer)
      window.removeEventListener('online', onChange)
      window.removeEventListener('offline', onChange)
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
