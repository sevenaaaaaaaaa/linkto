import { Appearance, DynamicColorIOS, Platform } from 'react-native'
const color = (light: string, dark: string) => Platform.OS === 'ios' ? DynamicColorIOS({ light, dark }) : Appearance.getColorScheme() === 'dark' ? dark : light
/** iOS resolves semantic colors natively, including styles created before a theme change. */
export const T = {
  get paper() { return color('#F4F5F7', '#0E1116') },
  get surface() { return color('#FFFFFF', '#1D2026') },
  get surfaceAlt() { return color('#ECEEF1', '#262A32') },
  get ink() { return color('#12151C', '#F0F1F4') },
  get inkSoft() { return color('#494E58', '#C3C7D0') },
  get faint() { return color('#626874', '#A4ABB7') },
  get hairline() { return color('rgba(31,34,38,0.12)', 'rgba(237,242,240,0.15)') },
  get accent() { return color('#171B23', '#EDF0F5') },
  get accentDeep() { return color('#2C3340', '#FFFFFF') },
  get accentSoft() { return color('rgba(18,21,28,0.06)', 'rgba(240,241,244,0.09)') },
  get accentInk() { return color('#FFFFFF', '#11151B') },
  get danger() { return color('#B4232A', '#FF9D9D') },
  get dangerSoft() { return color('rgba(180,35,42,0.09)', 'rgba(255,157,157,0.10)') },
  get ok() { return color('#0F766E', '#EDF0F5') },
  get okSoft() { return color('rgba(15,118,110,0.10)', 'rgba(114,216,200,0.10)') },
  get warn() { return color('#9A6A1F', '#E7C075') },
  get warnSoft() { return color('rgba(154,106,31,0.12)', 'rgba(231,192,117,0.12)') },
  get ai() { return color('#D7F23C', '#D7F23C') },
  get aiInk() { return color('#20270C', '#20270C') },
  get aiSoft() { return color('rgba(215,242,60,0.18)', 'rgba(215,242,60,0.12)') },
  shadow: 'rgba(14,17,22,0.10)',
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
