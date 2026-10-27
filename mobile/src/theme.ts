/** 对齐桌面端「石墨纸 + 铜绿」token 层；移动端只用语义 token，不在组件里散写颜色 */
export const T = {
  paper: '#F5F1E8',
  surface: '#FFFDF7',
  surfaceAlt: '#EFEAE0',
  ink: '#1F2226',
  inkSoft: '#3C4146',
  faint: 'rgba(31,34,38,0.46)',
  hairline: 'rgba(31,34,38,0.10)',
  accent: '#007C78',
  accentDeep: '#005F5D',
  accentSoft: 'rgba(0,124,120,0.09)',
  accentInk: '#FFFFFF',
  danger: '#B4232A',
  dangerSoft: 'rgba(180,35,42,0.09)',
  ok: '#0F766E',
  okSoft: 'rgba(15,118,110,0.10)',
  warn: '#9A6A1F',
  warnSoft: 'rgba(154,106,31,0.12)',
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
