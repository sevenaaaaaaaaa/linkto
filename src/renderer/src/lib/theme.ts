/**
 * 主题引擎 —— ThirdC 式四层换肤：
 *  1. 明暗：documentElement.dataset.theme = 'light' | 'dark'（auto 跟随系统）
 *  2. 主题预设：向 <head> 注入 <style id="theme-override">，覆盖 design token 变量
 *  3. 自定义调校：叠加在预设之上的微调层（<style id="theme-tweak">）——强调色 / 圆角 /
 *     毛玻璃强度 / 表面质感 / 光斑 / 阴影 / 动效，见下方 ThemeTweak
 *  4. 阅读皮肤：见 lib/reading-styles.ts（仅作用于正文 Shadow DOM）
 *
 * 持久化在 localStorage（主窗口 origin 稳定，跨启动保留）：
 *  ms_theme = 'auto' | 'light' | 'dark'
 *  ms_preset = <presetId | ''>
 *  ms_tweak = ThemeTweak JSON
 *  ms_tweak_presets = 用户保存的调校预设 JSON
 */

import { THEME_PRESETS, PRESET_VAR_MAP, BUILTIN_PRESET_ID, type ThemePreset } from './theme-presets'

export type ThemePref = 'auto' | 'light' | 'dark'

const THEME_KEY = 'ms_theme'
const PRESET_KEY = 'ms_preset'
/** 预设强制明暗（如霓虹暗夜）的启动缓存：首帧脚本只读 localStorage，无法 import 预设表 */
const SCHEME_KEY = 'ms_scheme'
const TWEAK_KEY = 'ms_tweak'
const TWEAK_PRESETS_KEY = 'ms_tweak_presets'
const MATCH_DARK = '(prefers-color-scheme: dark)'

const listeners = new Set<() => void>()

export function getThemePref(): ThemePref {
  return (localStorage.getItem(THEME_KEY) as ThemePref) || 'auto'
}

export function systemPrefersDark(): boolean {
  return window.matchMedia(MATCH_DARK).matches
}

export function resolvedTheme(): 'light' | 'dark' {
  const forced = findPreset(activePresetId())?.scheme
  if (forced) return forced
  const pref = getThemePref()
  return pref === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : pref
}

/** 让 macOS 原生 vibrancy 材质跟随应用明暗（而不是反过来的系统明暗） */
function syncNativeAppearance(): void {
  if (document.documentElement.dataset.os !== 'mac') return
  const forced = findPreset(activePresetId())?.scheme
  const pref = getThemePref()
  const source = forced ?? (pref === 'auto' ? 'system' : pref)
  void window.api?.setNativeAppearance?.(source)
}

/** 应用明暗（auto 跟随系统）；预设激活时需重跑 applyThemePreset 使其跟随新明暗 */
export function applyTheme(): void {
  const theme = resolvedTheme()
  document.documentElement.dataset.theme = theme
  try {
    // 只有预设强制明暗时才缓存；auto 仍由首帧脚本读 ms_theme + 系统偏好，避免系统变化后用到过期值
    if (findPreset(activePresetId())?.scheme) localStorage.setItem(SCHEME_KEY, theme)
    else localStorage.removeItem(SCHEME_KEY)
  } catch { /* localStorage 不可用时忽略 */ }
  applyThemePreset()
  applyTweaks()
  syncNativeAppearance()
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
  // 预设可能强制明暗（scheme）；统一走 applyTheme，顺带写 ms_scheme、重跑 tweak 与订阅
  applyTheme()
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
  // 主窗口与设置窗共享 localStorage：一边切明暗 / 预设，另一边同步（原生磨砂材质是全局的，必须一致）
  window.addEventListener('storage', e => {
    if (e.key === THEME_KEY || e.key === PRESET_KEY) applyTheme()
    if (e.key === TWEAK_KEY || e.key === TWEAK_PRESETS_KEY) applyTweaks()
  })
  // 主进程广播：系统明暗 / 另一窗口切换主题（vibrancy 材质是全局的，内容必须一起变）
  window.api?.onEvent?.(ev => {
    if ((ev as { type?: string } | null)?.type === 'theme-changed') applyTheme()
  })
}

// ---------- 自定义调校（第四层：叠加在预设之上） ----------

/** 调校项全部可选：只覆写用户动过的维度，其余跟随当前明暗 + 预设 */
export interface ThemeTweak {
  /** 强调色（oklch 完整串）；自动派生 accent-strong / accent-soft / on-accent */
  accent?: string
  /** 圆角风格（覆盖 --r-lg/md/sm 三档） */
  radius?: 'sharp' | 'small' | 'normal' | 'large' | 'round'
  /** 毛玻璃模糊缩放（0.4–2，乘在全部 backdrop-filter 半径上） */
  glassBlur?: number
  /** 表面质感：theme=跟随主题半透明；solid=实心（关闭浮层毛玻璃） */
  surface?: 'theme' | 'solid'
  /** 环境光斑：theme=跟随主题；off=关闭 */
  blobs?: 'theme' | 'off'
  /** 阴影深度 */
  shadow?: 'none' | 'soft' | 'normal' | 'deep'
  /** 动效：reduced=全局压缩到不可感知 */
  motion?: 'normal' | 'reduced'
  /** 界面字体（覆盖 --font-display / --font-body） */
  fontUI?: 'system' | 'pingfang' | 'serif' | 'mono'
  /** 中性色温：重着色全部中性 token（背景/文字/边框/玻璃），accent 不动 */
  neutralTemp?: 'cool' | 'gray' | 'paper' | 'sand'
}

export const RADIUS_STYLES: Record<NonNullable<ThemeTweak['radius']>, [string, string, string]> = {
  sharp: ['3px', '2px', '1px'],
  small: ['8px', '6px', '4px'],
  normal: ['14px', '10px', '6px'],
  large: ['22px', '16px', '10px'],
  round: ['30px', '22px', '14px']
}

const SHADOW_STYLE_CSS: Record<Exclude<ThemeTweak['shadow'], undefined>, string> = {
  none: '--shadow:none;--shadow-sm:none;',
  soft: '--shadow:0 1px 3px oklch(0% 0 0/.05), 0 8px 20px -12px oklch(0% 0 0/.08);--shadow-sm:0 1px 2px oklch(0% 0 0/.04);',
  normal: '',
  deep: '--shadow:0 4px 10px oklch(0% 0 0/.16), 0 36px 80px -24px oklch(0% 0 0/.55);--shadow-sm:0 2px 6px oklch(0% 0 0/.18), 0 8px 20px -8px oklch(0% 0 0/.3);'
}

/** 界面字体方案：display/body 双 token 成对覆盖 */
const FONT_STYLES: Record<NonNullable<ThemeTweak['fontUI']>, { display: string; body: string }> = {
  system: {
    display: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', 'HarmonyOS Sans SC', 'MiSans', 'Segoe UI', sans-serif",
    body: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'HarmonyOS Sans SC', 'MiSans', 'Segoe UI', sans-serif"
  },
  pingfang: { display: "'PingFang SC', 'HarmonyOS Sans SC', 'MiSans', -apple-system, sans-serif", body: "'PingFang SC', 'HarmonyOS Sans SC', 'MiSans', -apple-system, sans-serif" },
  serif: { display: "'Noto Serif SC', 'Songti SC', SimSun, serif", body: "'Noto Serif SC', 'Songti SC', SimSun, serif" },
  mono: { display: "'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace", body: "'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace" }
}

/** 参与色温重着色的中性 token（accent 系与 blob 不动） */
const NEUTRAL_TOKENS = [
  '--bg', '--bg-soft', '--surface', '--surface-strong', '--fg', '--muted', '--faint',
  '--border', '--border-strong', '--hover', '--hover-strong', '--glass', '--glass-bright', '--glass-border'
]

/** 色温目标：h=色相，c=最低彩度（gray 纯灰时 c=0） */
const NEUTRAL_TEMP: Record<NonNullable<ThemeTweak['neutralTemp']>, { h: number; c: number }> = {
  cool: { h: 260, c: 0.006 },
  gray: { h: 260, c: 0 },
  paper: { h: 85, c: 0.006 },
  sand: { h: 45, c: 0.009 }
}

/** 把一个 oklch 颜色串重着色到目标色温（保留明度与透明度） */
function rehueNeutral(raw: string, spec: { h: number; c: number }): string | null {
  const m = raw.match(/oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\s*\)/)
  if (!m) return null
  const c = spec.c === 0 ? 0 : Math.max(Number(m[2]), spec.c)
  const alpha = m[4] !== undefined ? `/${m[4]}` : ''
  return `oklch(${m[1]}% ${c.toFixed(3)} ${spec.h}${alpha})`
}

// ----- 色彩：sRGB ↔ OKLCH（自包含实现，避免引入色彩库） -----

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return Math.round(Math.min(Math.max(v, 0), 1) * 255)
}

/** #rrggbb → oklch(L% C H)，供取色器接入 */
export function hexToOklch(hex: string): string {
  const m = hex.replace('#', '')
  const r = srgbToLinear(parseInt(m.slice(0, 2), 16) / 255)
  const g = srgbToLinear(parseInt(m.slice(2, 4), 16) / 255)
  const b = srgbToLinear(parseInt(m.slice(4, 6), 16) / 255)
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const mm = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(mm)
  const s_ = Math.cbrt(s)
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  const C = Math.sqrt(A * A + B * B)
  let H = (Math.atan2(B, A) * 180) / Math.PI
  if (H < 0) H += 360
  return `oklch(${(L * 100).toFixed(1)}% ${C.toFixed(3)} ${H.toFixed(1)})`
}

function oklchToRgbParts(l: number, c: number, h: number): [number, number, number] {
  const hr = (h * Math.PI) / 180
  const A = c * Math.cos(hr)
  const B = c * Math.sin(hr)
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B
  const s_ = l - 0.0894841775 * A - 1.291485548 * B
  const L = l_ * l_ * l_
  const M = m_ * m_ * m_
  const S = s_ * s_ * s_
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S
  ]
}

/** oklch(L% C H[/alpha]) → #rrggbb（取色器回显用；alpha 忽略） */
export function oklchToHex(oklch: string): string {
  const m = oklch.match(/oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/)
  if (!m) return '#000000'
  const [r, g, b] = oklchToRgbParts(Number(m[1]) / 100, Number(m[2]), Number(m[3]))
  const to2 = (v: number) => linearToSrgb(v).toString(16).padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`
}

/** 由基色派生完整 accent 四色组：strong 加深、soft 加 12% 透明、on-accent 按明度自动反色 */
function accentSet(base: string): { accent: string; strong: string; soft: string; on: string } {
  const m = base.match(/oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/)
  if (!m) return { accent: base, strong: base, soft: base, on: 'oklch(100% 0 0)' }
  const L = Number(m[1]) / 100
  const C = Number(m[2])
  const H = Number(m[3])
  const strongL = Math.min(Math.max(L * 0.86, L - 0.09), 0.97)
  return {
    accent: `oklch(${(L * 100).toFixed(1)}% ${C} ${H})`,
    strong: `oklch(${(strongL * 100).toFixed(1)}% ${C} ${H})`,
    soft: `oklch(${(L * 100).toFixed(1)}% ${C} ${H}/0.12)`,
    on: L >= 0.62 ? `oklch(16% .02 ${H})` : 'oklch(100% 0 0)'
  }
}

/** 调校面板的可选强调色（与内置预设 accent 呼应） */
export const ACCENT_SWATCHES: { name: string; oklch: string }[] = [
  { name: '墨黑', oklch: 'oklch(19% .012 260)' },
  { name: '珊瑚', oklch: 'oklch(57.5% .13 45)' },
  { name: '海蓝', oklch: 'oklch(55% .18 255)' },
  { name: '紫罗兰', oklch: 'oklch(56% .18 285)' },
  { name: '荧光紫', oklch: 'oklch(70% .2 290)' },
  { name: '活力橙', oklch: 'oklch(57.5% .19 55)' },
  { name: '印章红', oklch: 'oklch(45% .16 25)' },
  { name: '松绿', oklch: 'oklch(52% .13 155)' },
  { name: '工程黄', oklch: 'oklch(58.5% .16 90)' }
]

function tweakCss(t: ThemeTweak): string {
  const parts: string[] = []
  if (t.accent) {
    const s = accentSet(t.accent)
    parts.push(`--accent:${s.accent}`, `--accent-strong:${s.strong}`, `--accent-soft:${s.soft}`, `--on-accent:${s.on}`)
  }
  if (t.fontUI) {
    const f = FONT_STYLES[t.fontUI]
    parts.push(`--font-display:${f.display}`, `--font-body:${f.body}`)
  }
  if (t.neutralTemp) {
    // 中性色温：读当前（内置或预设）生效值，保留明度/透明度、只换色相与彩度；
    // 在 applyTheme 里于预设注入之后执行，因此读到的是叠加后的结果
    const spec = NEUTRAL_TEMP[t.neutralTemp]
    const st = getComputedStyle(document.documentElement)
    for (const name of NEUTRAL_TOKENS) {
      const next = rehueNeutral(st.getPropertyValue(name).trim(), spec)
      if (next) parts.push(`${name}:${next}`)
    }
  }
  if (t.radius) {
    const [lg, md, sm] = RADIUS_STYLES[t.radius]
    parts.push(`--r-lg:${lg}`, `--r-md:${md}`, `--r-sm:${sm}`)
  }
  if (typeof t.glassBlur === 'number') parts.push(`--glass-blur-scale:${Math.min(Math.max(t.glassBlur, 0), 2)}`)
  if (t.surface === 'solid') {
    // 实心：浮层回到不透明表面，毛玻璃全部失效（性能 / 可读性优先）
    parts.push('--glass:var(--surface-strong)', '--glass-bright:var(--surface-strong)', '--glass-border:var(--border)')
  }
  if (t.blobs === 'off') parts.push('--blob-a:transparent', '--blob-b:transparent', '--blob-c:transparent')
  if (t.shadow) parts.push(SHADOW_STYLE_CSS[t.shadow])
  if (!parts.length) return ''
  return `:root{${parts.join(';')};}`
}

export function getTweak(): ThemeTweak {
  try {
    return JSON.parse(localStorage.getItem(TWEAK_KEY) || '{}') as ThemeTweak
  } catch {
    return {}
  }
}

function notifyChange(): void {
  listeners.forEach(fn => fn())
}

/** 应用（或清除）调校：注入 / 移除 theme-tweak 覆盖层 + 动效开关类 */
export function applyTweaks(): void {
  const t = getTweak()
  const css = tweakCss(t)
  let el = document.getElementById('theme-tweak') as HTMLStyleElement | null
  if (!css) {
    el?.remove()
  } else {
    if (!el) {
      el = document.createElement('style')
      el.id = 'theme-tweak'
      document.head.appendChild(el)
    }
    el.textContent = css
  }
  document.documentElement.classList.toggle('tweak-motion-off', t.motion === 'reduced')
}

export function setTweak(t: ThemeTweak): void {
  localStorage.setItem(TWEAK_KEY, JSON.stringify(t))
  applyTweaks()
  notifyChange()
}

/** 清空全部调校（回到纯预设 / 内置主题） */
export function resetTweak(): void {
  localStorage.removeItem(TWEAK_KEY)
  applyTweaks()
  notifyChange()
}

/** 当前是否有任何调校生效 */
export function tweakActive(): boolean {
  return Object.keys(getTweak()).length > 0
}

// ----- 调校预设：保存当前调校组合，可命名 / 删除 / 跨设备导入导出 -----

export interface CustomTweakPreset {
  id: string
  name: string
  tweak: ThemeTweak
}

function tweakPresetList(): CustomTweakPreset[] {
  try {
    return JSON.parse(localStorage.getItem(TWEAK_PRESETS_KEY) || '[]') as CustomTweakPreset[]
  } catch {
    return []
  }
}

export function listTweakPresets(): CustomTweakPreset[] {
  return tweakPresetList()
}

export function saveTweakPreset(name: string): CustomTweakPreset {
  const preset: CustomTweakPreset = { id: `tune-${Date.now().toString(36)}`, name: name.trim() || '我的主题', tweak: getTweak() }
  localStorage.setItem(TWEAK_PRESETS_KEY, JSON.stringify([...tweakPresetList(), preset]))
  notifyChange()
  return preset
}

export function deleteTweakPreset(id: string): void {
  localStorage.setItem(TWEAK_PRESETS_KEY, JSON.stringify(tweakPresetList().filter(p => p.id !== id)))
  notifyChange()
}

export function applyTweakPreset(id: string): void {
  const hit = tweakPresetList().find(p => p.id === id)
  if (hit) setTweak(hit.tweak)
}

/** 导出全部调校预设为 JSON（剪贴板 / 文件均由调用方决定） */
export function exportTweakPresets(): string {
  return JSON.stringify({ app: 'linkto', kind: 'theme-tweaks', version: 1, presets: tweakPresetList() }, null, 2)
}

/** 从导出的 JSON 导入；同名跳过，返回导入数量 */
export function importTweakPresets(json: string): { ok: boolean; error?: string; count?: number } {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return { ok: false, error: '不是有效的 JSON' }
  }
  const presets = (data as { presets?: unknown })?.presets
  if (!Array.isArray(presets)) return { ok: false, error: '格式不对：缺少 presets 数组' }
  const valid = presets.filter(
    (p): p is CustomTweakPreset => !!p && typeof p === 'object' && typeof (p as CustomTweakPreset).name === 'string' && typeof (p as CustomTweakPreset).tweak === 'object'
  )
  if (!valid.length) return { ok: false, error: '没有可导入的预设' }
  const existing = tweakPresetList()
  const names = new Set(existing.map(p => p.name))
  const add = valid.filter(p => !names.has(p.name)).map(p => ({ ...p, id: `tune-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` }))
  if (!add.length) return { ok: false, error: '预设已存在（同名跳过）' }
  localStorage.setItem(TWEAK_PRESETS_KEY, JSON.stringify([...existing, ...add]))
  notifyChange()
  return { ok: true, count: add.length }
}
