import { useSyncExternalStore } from 'react'
import { api } from './api'

/**
 * 主进程渲染好的 SF Symbols（symbol 名 → PNG data URL）。
 * 加载完成前 / 非 macOS / 单个 symbol 缺失时，useSystemSymbol 返回 undefined，调用方回退 SVG。
 */
let cache: Record<string, string> = {}
const listeners = new Set<() => void>()
let started = false

const emit = () => listeners.forEach(fn => fn())
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function loadSystemSymbols(): void {
  if (started) return
  started = true
  let attempts = 0
  const load = () => {
    void api
      .systemSymbols()
      .then(map => {
        if (map && Object.keys(map).length) {
          cache = map
          emit()
        } else if (attempts++ < 2) {
          // 首次启动时 Swift 工具可能还在渲染：稍后重试一次，不阻塞 SVG 回退
          window.setTimeout(load, 1500)
        }
      })
      .catch(() => {
        /* 非 macOS / 旧系统：保持 SVG 图标 */
      })
  }
  load()
}

export function useSystemSymbol(name: string): string | undefined {
  return useSyncExternalStore(subscribe, () => cache[name])
}
