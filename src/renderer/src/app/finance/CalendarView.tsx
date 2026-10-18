import { useMemo, useState } from 'react'
import { effectiveStatus } from '@shared/finance'
import { fmtMoney, startOfDay, type FinanceRec } from '../../lib/finance'
import { Chip, SectionTitle, miniBtn } from './ui'
import type { RowActions } from './RecRow'

type EntryKind = 'due' | 'renew' | 'trial' | 'paid' | 'overdue'

interface Entry {
  r: FinanceRec
  at: number
  kind: EntryKind
  label: string
}

const KIND_LABEL: Record<EntryKind, string> = { due: '到期', renew: '续费', trial: '试用结束', paid: '已付', overdue: '逾期' }
const WEEK = ['一', '二', '三', '四', '五', '六', '日']

/** 时间线上的点：应付日 / 续费日 / 试用结束 / 付款日 */
export function entriesOf(recs: FinanceRec[], now: number): Entry[] {
  const out: Entry[] = []
  for (const r of recs) {
    const d = r.data
    const st = effectiveStatus(d, r.dueAt, now)
    if (d.kind === 'subscription') {
      if (d.status === 'cancelled' || d.status === 'refunded') continue
      if (d.trialEndsAt) out.push({ r, at: d.trialEndsAt, kind: 'trial', label: `${d.counterparty} 试用结束` })
      if (r.dueAt && (!d.trialEndsAt || Math.abs(r.dueAt - d.trialEndsAt) > 864e5)) out.push({ r, at: r.dueAt, kind: 'renew', label: `${d.counterparty} 续费` })
      for (const e of d.events ?? []) if (e.kind === 'renewed') out.push({ r, at: e.at, kind: 'paid', label: `${d.counterparty} 扣费` })
      continue
    }
    if ((st === 'pending' || st === 'overdue') && r.dueAt) out.push({ r, at: r.dueAt, kind: st === 'overdue' ? 'overdue' : 'due', label: r.title })
    if (st === 'paid' && d.paidAt && d.kind !== 'invoice') out.push({ r, at: d.paidAt, kind: 'paid', label: r.title })
  }
  return out.sort((a, b) => a.at - b.at)
}

const dotColor = (k: EntryKind) => (k === 'overdue' ? 'var(--danger)' : k === 'due' || k === 'trial' ? 'var(--warn)' : k === 'renew' ? 'var(--info)' : 'var(--faint)')

export function CalendarView(props: { recs: FinanceRec[]; now: number; actions: RowActions; activeId: string | null }) {
  const { now } = props
  const [cursor, setCursor] = useState(() => {
    const d = new Date(now)
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  })
  const [day, setDay] = useState<number | null>(null)
  const entries = useMemo(() => entriesOf(props.recs, now), [props.recs, now])
  const month = new Date(cursor)
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const lead = (first.getDay() + 6) % 7
  const daysIn = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells = Array.from({ length: Math.ceil((lead + daysIn) / 7) * 7 }, (_, i) => {
    const n = i - lead + 1
    return n >= 1 && n <= daysIn ? new Date(month.getFullYear(), month.getMonth(), n).getTime() : null
  })
  const byDay = useMemo(() => {
    const m = new Map<number, Entry[]>()
    for (const e of entries) {
      const k = startOfDay(e.at)
      m.set(k, [...(m.get(k) ?? []), e])
    }
    return m
  }, [entries])
  const today = startOfDay(now)
  const agenda = day != null ? byDay.get(day) ?? [] : entries.filter(e => e.at >= today && e.at < today + 31 * 864e5 && e.kind !== 'paid')

  return (
    <div className="px-6 pb-10 flex flex-wrap gap-6">
      <div className="flex-1 min-w-[420px]">
        <div className="flex items-center gap-2 mt-1 mb-2">
          <button className={miniBtn} style={{ color: 'var(--fg)' }} onClick={() => setCursor(new Date(month.getFullYear(), month.getMonth() - 1, 1).getTime())} aria-label="上个月">‹</button>
          <span className="text-sm font-semibold tnum w-[96px] text-center" style={{ color: 'var(--fg)' }}>
            {month.getFullYear()} 年 {month.getMonth() + 1} 月
          </span>
          <button className={miniBtn} style={{ color: 'var(--fg)' }} onClick={() => setCursor(new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime())} aria-label="下个月">›</button>
          <button
            className={miniBtn}
            style={{ color: 'var(--muted)' }}
            onClick={() => {
              const d = new Date(now)
              setCursor(new Date(d.getFullYear(), d.getMonth(), 1).getTime())
              setDay(null)
            }}
          >
            本月
          </button>
          <span className="flex-1" />
          {(['overdue', 'due', 'renew', 'trial', 'paid'] as EntryKind[]).map(k => (
            <span key={k} className="inline-flex items-center gap-1 text-2xs" style={{ color: 'var(--faint)' }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: dotColor(k) }} />
              {KIND_LABEL[k]}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px rounded-[var(--r-md)] overflow-hidden border border-[var(--border)]" style={{ background: 'var(--border)' }}>
          {WEEK.map(w => (
            <div key={w} className="caps text-center py-1.5" style={{ background: 'var(--bg-soft)', color: 'var(--faint)' }}>{w}</div>
          ))}
          {cells.map((t, i) => {
            const list = t != null ? byDay.get(t) ?? [] : []
            const isToday = t === today
            const sel = t != null && t === day
            return (
              <button
                key={i}
                disabled={t == null}
                onClick={() => t != null && setDay(d => (d === t ? null : t))}
                className="min-h-[84px] p-1.5 text-left flex flex-col gap-0.5 disabled:cursor-default"
                style={{ background: sel ? 'var(--selected)' : t == null ? 'var(--bg-soft)' : 'var(--surface-strong)' }}
              >
                {t != null && (
                  <span
                    className="text-2xs tnum w-5 h-5 inline-flex items-center justify-center rounded-full"
                    style={isToday ? { background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 600 } : { color: 'var(--muted)' }}
                  >
                    {new Date(t).getDate()}
                  </span>
                )}
                {list.slice(0, 3).map((e, j) => (
                  <span key={j} className="flex items-center gap-1 min-w-0 text-2xs" style={{ color: e.kind === 'paid' ? 'var(--faint)' : 'var(--fg)' }}>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor(e.kind) }} />
                    <span className="truncate">{e.r.data.counterparty}</span>
                  </span>
                ))}
                {list.length > 3 && <span className="text-2xs" style={{ color: 'var(--faint)' }}>+{list.length - 3}</span>}
              </button>
            )
          })}
        </div>
      </div>
      <div className="w-[300px] shrink-0 min-w-0">
        <SectionTitle count={agenda.length} right={day != null ? <button onClick={() => setDay(null)} className="font-normal underline underline-offset-2" style={{ color: 'var(--muted)' }}>看未来 30 天</button> : undefined}>
          {day != null ? new Date(day).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }) : '未来 30 天'}
        </SectionTitle>
        <div className="flex flex-col">
          {agenda.map((e, i) => {
            const showDate = i === 0 || startOfDay(agenda[i - 1].at) !== startOfDay(e.at)
            return (
              <div key={`${e.r.id}-${e.kind}-${i}`}>
                {showDate && day == null && (
                  <div className="mt-2 mb-1 text-2xs tnum" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                    {new Date(e.at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' })}
                  </div>
                )}
                <button
                  onClick={() => props.actions.onOpen(e.r.id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--r-sm)] hover:bg-[var(--hover)] text-left"
                  style={{ background: props.activeId === e.r.id ? 'var(--selected)' : undefined }}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor(e.kind) }} />
                  <span className="flex-1 min-w-0 text-xs truncate" style={{ color: 'var(--fg)' }}>{e.label}</span>
                  <Chip tone={e.kind === 'overdue' ? 'danger' : e.kind === 'paid' ? 'muted' : undefined}>{KIND_LABEL[e.kind]}</Chip>
                  <span className="text-2xs tnum" style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{fmtMoney(e.r.data.amount, e.r.data.currency)}</span>
                </button>
              </div>
            )
          })}
          {!agenda.length && <div className="text-xs py-3" style={{ color: 'var(--faint)' }}>{day != null ? '这一天没有款项。' : '未来 30 天没有要付的钱。'}</div>}
        </div>
      </div>
    </div>
  )
}
