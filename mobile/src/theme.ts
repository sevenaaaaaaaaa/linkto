import { Appearance, DynamicColorIOS, Platform } from 'react-native'
const color = (light: string, dark: string) => Platform.OS === 'ios' ? DynamicColorIOS({ light, dark }) : Appearance.getColorScheme() === 'dark' ? dark : light
/** iOS resolves semantic colors natively, including styles created before a theme change. */
export const T = {
  get paper() { return color('#F5F1E8', '#14181B') },
  get surface() { return color('#FFFDF7', '#20262B') },
  get surfaceAlt() { return color('#EFEAE0', '#2B3339') },
  get ink() { return color('#1F2226', '#F0EEE8') },
  get inkSoft() { return color('#3C4146', '#C9CFD1') },
  get faint() { return color('#6C706F', '#A5B0B3') },
  get hairline() { return color('rgba(31,34,38,0.12)', 'rgba(237,242,240,0.15)') },
  get accent() { return color('#007C78', '#72D8C8') },
  get accentDeep() { return color('#005F5D', '#9EE6D9') },
  get accentSoft() { return color('rgba(0,124,120,0.09)', 'rgba(114,216,200,0.12)') },
  get accentInk() { return color('#FFFFFF', '#102C29') },
  get danger() { return color('#B4232A', '#FF9D9D') },
  get dangerSoft() { return color('rgba(180,35,42,0.09)', 'rgba(255,157,157,0.10)') },
  get ok() { return color('#0F766E', '#72D8C8') },
  get okSoft() { return color('rgba(15,118,110,0.10)', 'rgba(114,216,200,0.10)') },
  get warn() { return color('#9A6A1F', '#E7C075') },
  get warnSoft() { return color('rgba(154,106,31,0.12)', 'rgba(231,192,117,0.12)') },
  shadow: 'rgba(31,34,38,0.12)',
  scrim: 'rgba(31,34,38,0.36)',
  white: '#FFFFFF'
} as const

/** Lazy per-scheme styles keep Android colors reactive without remounting editors. */
export function themedStyles<S extends object>(factory: () => S): S {
  const cache = new Map<string, S>()
  return new Proxy({} as S, { get: (_target, name) => {
    const scheme = Platform.OS === 'ios' ? 'dynamic' : Appearance.getColorScheme() ?? 'light'
    if (!cache.has(scheme)) cache.set(scheme, factory())
    return cache.get(scheme)![name as keyof S]
  } })
}

export function accountInitial(email: string): string {
  const local = (email || '?').split('@')[0]
  return (local[0] || '?').toUpperCase()
}

export function prettyFrom(from: string): string {
  const s = (from || '').trim()
  const m = s.match(/^"?([^"<]*)"?\s*<[^>]+>\s*$/)
  return (m?.[1]?.trim() || s.replace(/<[^>]*>/g, '').trim() || '未知发件人')
}

export function fmtListDate(t: number): string {
  if (!t) return ''
  const d = new Date(t)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  if (d.getFullYear() === today.getFullYear()) return (d.getMonth() + 1) + '/' + d.getDate()
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate()
}

export function fmtShortDate(t: number): string {
  if (!t) return ''
  const d = new Date(t)
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function fmtFullDate(t: number): string {
  if (!t) return ''
  return new Date(t).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function fmtBytes(n: number): string {
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}
