import type { LinkToApi } from '@shared/ipc'

declare global {
  interface Window {
    api: LinkToApi
  }
}

export const api = window.api

import { useEffect, useState } from 'react'
import type { MailEvent } from '@shared/types'

/** 订阅主进程事件流 */
export function useMailEvent(handler: (ev: MailEvent) => void) {
  useEffect(() => {
    return api.onEvent(ev => handler(ev as MailEvent))
  })
}

/** 通用数据加载 hook */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): { data: T | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    loader().then(d => {
      if (alive) {
        setData(d)
        setLoading(false)
      }
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, loading, reload: () => setTick(t => t + 1) }
}

export function fmtDate(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  const sameYear = d.getFullYear() === now.getFullYear()
  if (sameYear) {
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  }
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })
}

export function fmtFullDate(ts: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function fmtTime(ts: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function displayName(a: { name?: string; address: string } | null): string {
  if (!a) return ''
  return a.name?.trim() || a.address
}

export function addrText(list: { name?: string; address: string }[]): string {
  return list.map(a => displayName(a)).join(', ')
}
