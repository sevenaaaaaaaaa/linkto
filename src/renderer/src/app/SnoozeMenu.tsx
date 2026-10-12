import { IconSparkles } from '../components/icons'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'

/** Snooze 预设时刻计算 */
export function snoozeTargets(now = new Date()): { key: string; label: string; at: number }[] {
  const at = (d: Date) => d.getTime()
  const inHours = (h: number) => at(new Date(now.getTime() + h * 3600_000))
  const tonight = new Date(now)
  tonight.setHours(18, 0, 0, 0)
  if (tonight <= now) tonight.setDate(tonight.getDate() + 1)
  const tomorrow8 = new Date(now)
  tomorrow8.setDate(tomorrow8.getDate() + 1)
  tomorrow8.setHours(8, 0, 0, 0)
  const weekend = new Date(now)
  const daysToSat = (6 - weekend.getDay() + 7) % 7 || 7
  weekend.setDate(weekend.getDate() + daysToSat)
  weekend.setHours(9, 0, 0, 0)
  return [
    { key: '1h', label: '1 小时后', at: inHours(1) },
    { key: '3h', label: '3 小时后', at: inHours(3) },
    { key: 'tonight', label: '今晚 18:00', at: at(tonight) },
    { key: 'tomorrow', label: '明早 8:00', at: at(tomorrow8) },
    { key: 'weekend', label: '周六早上', at: at(weekend) }
  ]
}

export function fmtSnooze(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `今天 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  const tomorrow = new Date(now.getTime() + 86400_000)
  if (d.toDateString() === tomorrow.toDateString()) return `明早 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Snooze 浮层：预设 + 自定义时间。onPick(null) = 取回 */
export function SnoozeMenu(props: {
  onPick(at: number): void
  onUnsnooze?(): void
  onClose(): void
  align?: 'left' | 'right'
  currentlySnoozed?: boolean
  /** AI 建议目标邮件（传入即显示 ✨ 按钮） */
  messageId?: string
}) {
  const [custom, setCustom] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const askAi = async () => {
    if (!props.messageId || suggesting) return
    setSuggesting(true)
    const res = await api.aiSnoozeSuggest(props.messageId)
    setSuggesting(false)
    if (!res.ok) {
      window.dispatchEvent(new CustomEvent('ms:toast', { detail: res.error ?? 'AI 建议不可用' }))
      return
    }
    props.onPick(res.at)
    window.dispatchEvent(new CustomEvent('ms:toast', { detail: `AI 建议 ${fmtSnooze(res.at)}：${res.reason}` }))
  }

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) props.onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  const commitCustom = () => {
    const at = Date.parse(custom)
    if (Number.isFinite(at) && at > Date.now() - 60_000) props.onPick(at)
  }

  return (
    <div
      ref={ref}
      className="absolute z-40 w-[218px] glass-strong rounded-[var(--r-sm)] border border-[var(--glass-border)] shadow-[var(--shadow)] p-1.5 pop-in"
      style={props.align === 'left' ? { left: 0 } : { right: 0 }}
    >
      <div className="px-2 pt-1 pb-1.5 text-2xs font-semibold tracking-[0.06em] uppercase" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
        稍后处理 · 到点自动回归
      </div>
      {snoozeTargets().map(t => (
        <button
          key={t.key}
          onClick={() => props.onPick(t.at)}
          className="w-full flex items-center px-2.5 py-1.5 rounded-lg text-xs hover:bg-[var(--hover)]"
          style={{ color: 'var(--fg)' }}
        >
          <span className="flex-1 text-left">{t.label}</span>
          <span className="text-2xs" style={{ color: 'var(--faint)' }}>{fmtSnooze(t.at)}</span>
        </button>
      ))}
      {props.messageId && (
        <button
          onClick={askAi}
          disabled={suggesting}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs hover:bg-[var(--hover)] disabled:opacity-50"
          style={{ color: 'var(--accent-strong)' }}
        >
          <IconSparkles width={11} height={11} /> {suggesting ? 'AI 判断中…' : 'AI 建议最佳时刻'}
        </button>
      )}
      <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1">
        <input
          type="datetime-local"
          value={custom}
          onChange={e => setCustom(e.target.value)}
          className="flex-1 min-w-0 text-xs rounded-lg px-2 py-1 outline-none border border-[var(--border-soft)]"
          style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
        />
        <button
          onClick={commitCustom}
          disabled={!custom}
          className="text-xs px-2 py-1 rounded-lg font-medium disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
        >
          确定
        </button>
      </div>
      {props.currentlySnoozed && props.onUnsnooze && (
        <button
          onClick={() => props.onUnsnooze?.()}
          className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs hover:bg-[var(--hover)]"
          style={{ color: 'var(--danger)' }}
        >
          立即取回收件箱
        </button>
      )}
    </div>
  )
}
