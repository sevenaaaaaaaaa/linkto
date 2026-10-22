import { useSyncExternalStore } from 'react'
import type { SfSymbolWeight } from '@shared/sf-symbols'
import { api } from './api'
import { getPrefs } from './prefs'

/**
 * 主进程渲染好的 SF Symbols（symbol 名 → PNG data URL）。
 * 字重来自「个性化 → 原生外观」；切换时只重渲染一次并按字重缓存。
 * 加载完成前 / 非 macOS / 单个 symbol 缺失时，useSystemSymbol 返回 undefined，调用方回退 SVG。
 */
let cache: Record<string, string> = {}
let loadedWeight: SfSymbolWeight | null = null
let loadingWeight: SfSymbolWeight | null = null
const listeners = new Set<() => void>()

const emit = () => listeners.forEach(fn => fn())
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function loadSystemSymbols(weightInput?: SfSymbolWeight): void {
  const weight: SfSymbolWeight = weightInput ?? (getPrefs().sfWeight as SfSymbolWeight)
  if (loadedWeight === weight || loadingWeight === weight) return
  loadingWeight = weight
  let attempts = 0
  const load = () => {
    void api
      .systemSymbols(weight)
      .then(map => {
        if (loadingWeight !== weight) return
        if (map && Object.keys(map).length) {
          cache = map
          loadedWeight = weight
          loadingWeight = null
          emit()
        } else if (attempts++ < 2) {
          // 首次启动时 Swift 工具可能还在渲染：稍后重试，不阻塞 SVG 回退
          window.setTimeout(load, 1500)
        } else {
          loadingWeight = null
        }
      })
      .catch(() => {
        if (loadingWeight === weight) loadingWeight = null
      })
  }
  load()
}

// 设置窗 / 主窗改字重：local storage 事件 + 同窗口 ms:prefs
const reloadForPrefs = () => loadSystemSymbols(getPrefs().sfWeight as SfSymbolWeight)
window.addEventListener('ms:prefs', reloadForPrefs)
window.addEventListener('storage', e => {
  if (e.key === 'ms_ui_prefs') reloadForPrefs()
})

export function useSystemSymbol(name: string): string | undefined {
  return useSyncExternalStore(subscribe, () => cache[name])
}
