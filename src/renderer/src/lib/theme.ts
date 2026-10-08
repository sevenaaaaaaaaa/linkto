/**
 * 主题引擎 —— ThirdC 式三层换肤：
 *  1. 明暗：documentElement.dataset.theme = 'light' | 'dark'（auto 跟随系统）
 *  2. 主题预设：向 <head> 注入 <style id="theme-override">，覆盖 design token 变量
 *  3. 阅读皮肤：见 lib/reading-styles.ts（仅作用于正文 Shadow DOM）
 *
 * 持久化在 localStorage（主窗口 origin 稳定，跨启动保留）：
 *  ms_theme = 'auto' | 'light' | 'dark'
 *  ms_preset = <presetId | ''>
 */

import { THEME_PRESETS, PRESET_VAR_MAP, BUILTIN_PRESET_ID, type ThemePreset } from './theme-presets'

export type ThemePref = 'auto' | 'light' | 'dark'

const THEME_KEY = 'ms_theme'
const PRESET_KEY = 'ms_preset'
const MATCH_DARK = '(prefers-color-scheme: dark)'

const listeners = new Set<() => void>()

export function getThemePref(): ThemePref {
  return (localStorage.getItem(THEME_KEY) as ThemePref) || 'auto'
}

export function systemPrefersDark(): boolean {
  return window.matchMedia(MATCH_DARK).matches
}

export function resolvedTheme(): 'light' | 'dark' {
  const pref = getThemePref()
  return pref === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : pref
}

/** 应用明暗（auto 跟随系统）；预设激活时需重跑 applyThemePreset 使其跟随新明暗 */
export function applyTheme(): void {
  document.documentElement.dataset.theme = resolvedTheme()
  applyThemePreset()
  listeners.forEach(fn => fn())
}

export function setThemePref(pref: ThemePref): void {
  localStorage.setItem(THEME_KEY, pref)
  applyTheme()
}

/** 循环切换 auto → light → dark（ThirdC「明暗切换」交互），返回新值供 toast 提示 */
export function cycleTheme(): ThemePref {
  const next: ThemePref = getThemePref() === 'auto' ? 'light' : getThemePref() === 'light' ? 'dark' : 'auto'
  setThemePref(next)
  return next
}

export function themeLabel(pref: ThemePref): string {
  return pref === 'auto' ? '跟随系统' : pref === 'light' ? '浅色' : '深色'
}

// ---------- 主题预设 ----------

export function activePresetId(): string {
  return localStorage.getItem(PRESET_KEY) || ''
}

export function findPreset(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find(p => p.id === id)
}

function presetCss(preset: ThemePreset): string {
  const palette = resolvedTheme() === 'dark' ? preset.dark : preset.light
  let css = ':root{'
  for (const [key, value] of Object.entries(palette)) {
    const cssVar = PRESET_VAR_MAP[key]
    if (cssVar) css += `${cssVar}:${value};`
  }
  const L = preset.layout || {}
  if (L['r-lg']) css += `--r-lg:${L['r-lg']};--r-md:${L['r-md'] ?? '14px'};--r-sm:${L['r-sm'] ?? '10px'};`
  css += '}'
  if (L['font-display']) css += `:root{--font-display:${L['font-display']};}`
  if (L['font-body']) css += `:root{--font-body:${L['font-body']};}`
  return css
}

/** 应用（或清除）主题预设：注入 / 移除 theme-override 覆盖层，整个应用即时换肤 */
export function applyThemePreset(): void {
  const id = activePresetId()
  const preset = findPreset(id)
  let el = document.getElementById('theme-override') as HTMLStyleElement | null
  if (!preset || preset.id === BUILTIN_PRESET_ID) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('style')
    el.id = 'theme-override'
    document.head.appendChild(el)
  }
  el.textContent = presetCss(preset)
}

export function setPreset(id: string | null): void {
  localStorage.setItem(PRESET_KEY, id ?? '')
  applyThemePreset()
  listeners.forEach(fn => fn())
}

/** 预设 / 主题变化订阅（换肤面板刷新高亮用） */
export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 应用启动时调用：恢复明暗与预设；auto 模式下跟随系统切换 */
export function initTheme(): void {
  applyTheme()
  window.matchMedia(MATCH_DARK).addEventListener('change', () => {
    if (getThemePref() === 'auto') applyTheme()
  })
}
