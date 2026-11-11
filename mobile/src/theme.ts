import { DynamicColorIOS, Platform } from 'react-native'
const color = (light: string, dark: string) => Platform.OS === 'ios' ? DynamicColorIOS({ light, dark }) : light
/** iOS resolves semantic colors natively, including styles created before a theme change. */
export const T = {
  paper: color('#F5F1E8', '#14181B'),
  surface: color('#FFFDF7', '#20262B'),
  surfaceAlt: color('#EFEAE0', '#2B3339'),
  ink: color('#1F2226', '#F0EEE8'),
  inkSoft: color('#3C4146', '#C9CFD1'),
  faint: color('#6C706F', '#A5B0B3'),
  hairline: color('rgba(31,34,38,0.12)', 'rgba(237,242,240,0.15)'),
  accent: color('#007C78', '#72D8C8'),
  accentDeep: color('#005F5D', '#9EE6D9'),
  accentSoft: color('rgba(0,124,120,0.09)', 'rgba(114,216,200,0.12)'),
  accentInk: color('#FFFFFF', '#102C29'),
  danger: color('#B4232A', '#FF9D9D'),
  dangerSoft: color('rgba(180,35,42,0.09)', 'rgba(255,157,157,0.10)'),
  ok: color('#0F766E', '#72D8C8'),
  okSoft: color('rgba(15,118,110,0.10)', 'rgba(114,216,200,0.10)'),
  warn: color('#9A6A1F', '#E7C075'),
  warnSoft: color('rgba(154,106,31,0.12)', 'rgba(231,192,117,0.12)'),
  shadow: 'rgba(31,34,38,0.12)',
  scrim: 'rgba(31,34,38,0.36)',
  white: '#FFFFFF'
} as const

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
