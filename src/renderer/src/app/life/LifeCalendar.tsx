import { useMemo, useState } from 'react'
import { lifeUrgency, startOfDay } from '@shared/life'
import { fmtDate, type LifeRec } from '../../lib/life'
import { fmtMoney, openFinance, useFinance, useFinanceEvents } from '../../lib/finance'
import { entriesOf } from '../finance/CalendarView'
import { Chip, SectionTitle, miniBtn } from '../finance/ui'
import { CategoryIcon } from './icons'
import { Switch } from '../agent/AutomationJobs'

type Kind = 'due' | 'start' | 'overdue' | 'renew' | 'pay'

interface Entry {
  at: number
  kind: Kind
  label: string
  /** 生活档案条目 id；财务叠加层为 null */
  lifeId: string | null
  financeId: string | null
  rec?: LifeRec
  amount?: string | null
}

const KIND_LABEL: Record<Kind, string> = { overdue: '已过期', due: '到期', start: '开始办理', renew: '续费（财务）', pay: '待付（财务）' }
const WEEK = ['一', '二', '三', '四', '五', '六', '日']
const dotColor = (k: Kind) => (k === 'overdue' ? 'var(--danger)' : k === 'due' ? 'var(--warn)' : k === 'start' ? 'var(--info)' : 'var(--faint)')
const OVERLAY_KEY = 'ms_life_fin_overlay'

/** 月历：到期日 / 建议开始办理日；可叠加财务的续费与待付（只读，可开关） */
export function LifeCalendar(props: { recs: LifeRec[]; now: number; activeId: string | null; onOpen(id: string): void }) {
  useFinanceEvents()
  const { now } = props
  const finance = useFinance(st => st.records)
  const [overlay, setOverlay] = useState(() => {
    try {
      return localStorage.getItem(OVERLAY_KEY) !== '0'
    } catch {
      return true
    }
  })
  const toggleOverlay = (v: boolean) => {
    setOverlay(v)
    try {
      localStorage.setItem(OVERLAY_KEY, v ? '1' : '0')
    } catch {
      /* 本次生效 */
    }
  }
  const [cursor, setCursor] = useState(() => {
    const d = new Date(now)
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  })
  const [day, setDay] = useState<number | null>(null)

  const entries = useMemo(() => {
    const out: Entry[] = []
    const linked = new Set<string>()
    for (const r of props.recs) {
      if (r.status === 'done') continue
      const t = r.dueAt ?? r.data.expiresAt
      if (r.data.financeId) linked.add(r.data.financeId)
      if (t) out.push({ at: t, kind: lifeUrgency(r, now) === 'overdue' ? 'overdue' : 'due', label: r.data.subject || r.title, lifeId: r.id, financeId: null, rec: r })
      if (r.data.actionFrom && t && startOfDay(r.data.actionFrom) < startOfDay(t) && r.data.actionFrom >= now - 864e5) out.push({ at: r.data.actionFrom, kind: 'start', label: `开始办：${r.data.subject || r.title}`, lifeId: r.id, financeId: null, rec: r })
    }
    if (overlay) {
      for (const e of entriesOf(finance, now)) {
        if (e.kind === 'paid') continue
        // 已经关联到生活档案的那笔不重复画（合并显示在生活条目上）
        if (linked.has(e.r.id)) continue
        out.push({ at: e.at, kind: e.kind === 'renew' || e.kind === 'trial' ? 'renew' : 'pay', label: e.label, lifeId: null, financeId: e.r.id, amount: e.r.data.amount != null ? fmtMoney(e.r.data.amount, e.r.data.currency) : null })
      }
    }
    return out.sort((a, b) => a.at - b.at)
  }, [props.recs, finance, overlay, now])

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
  const agenda = day != null ? byDay.get(day) ?? [] : entries.filter(e => (e.at >= today && e.at < today + 61 * 864e5) || (e.kind === 'overdue' && e.lifeId))
  const open = (e: Entry) => (e.lifeId ? props.onOpen(e.lifeId) : e.financeId ? openFinance(e.financeId) : undefined)

  return (
    <div className="px-6 pb-10 flex flex-wrap gap-6">
      <div className="flex-1 min-w-[420px]">
        <div className="flex items-center gap-2 mt-1 mb-2 flex-wrap">
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
          {(['overdue', 'due', 'start', ...(overlay ? ['renew', 'pay'] : [])] as Kind[]).map(k => (
            <span key={k} className="inline-flex items-center gap-1 text-2xs" style={{ color: 'var(--faint)' }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: dotColor(k) }} />
              {KIND_LABEL[k]}
            </span>
          ))}
          <label className="inline-flex items-center gap-1.5 text-2xs ml-2" style={{ color: 'var(--muted)' }}>
            <Switch checked={overlay} onChange={toggleOverlay} label="叠加财务的续费与待付" />
            叠加财务
          </label>
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
                  <span className="text-2xs tnum w-5 h-5 inline-flex items-center justify-center rounded-full" style={isToday ? { background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 600 } : { color: 'var(--muted)' }}>
                    {new Date(t).getDate()}
                  </span>
                )}
                {list.slice(0, 3).map((e, j) => (
                  <span key={j} className="flex items-center gap-1 min-w-0 text-2xs" style={{ color: e.lifeId ? 'var(--fg)' : 'var(--faint)' }}>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor(e.kind) }} />
                    <span className="truncate">{e.kind === 'start' ? `↳ ${e.rec?.data.subject ?? e.label}` : e.label}</span>
                  </span>
                ))}
                {list.length > 3 && <span className="text-2xs" style={{ color: 'var(--faint)' }}>+{list.length - 3}</span>}
              </button>
            )
          })}
        </div>
      </div>
      <div className="w-[300px] shrink-0 min-w-0">
        <SectionTitle count={agenda.length} right={day != null ? <button onClick={() => setDay(null)} className="font-normal underline underline-offset-2" style={{ color: 'var(--muted)' }}>看未来 60 天</button> : undefined}>
          {day != null ? new Date(day).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }) : '未来 60 天'}
        </SectionTitle>
        <div className="flex flex-col">
          {agenda.map((e, i) => (
            <button
              key={`${e.lifeId ?? e.financeId}-${e.kind}-${i}`}
              onClick={() => open(e)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--r-sm)] hover:bg-[var(--hover)] text-left"
              style={{ background: e.lifeId && props.activeId === e.lifeId ? 'var(--selected)' : undefined }}
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor(e.kind) }} />
              {e.rec && <CategoryIcon category={e.rec.data.category} width={12} height={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
              <span className="flex-1 min-w-0 text-xs truncate" style={{ color: e.lifeId ? 'var(--fg)' : 'var(--muted)' }}>
                {e.label}
                {e.amount && <span className="ml-1 tnum" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{e.amount}</span>}
              </span>
              <Chip tone={e.kind === 'overdue' ? 'danger' : e.kind === 'due' ? 'warn' : e.kind === 'start' ? 'info' : 'muted'}>{KIND_LABEL[e.kind]}</Chip>
              <span className="text-2xs tnum w-[56px] text-right" style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{fmtDate(e.at, now)}</span>
            </button>
          ))}
          {!agenda.length && <div className="text-xs py-3" style={{ color: 'var(--faint)' }}>{day != null ? '这一天没有要办的事。' : '未来 60 天没有到期的事。'}</div>}
        </div>
      </div>
    </div>
  )
}
