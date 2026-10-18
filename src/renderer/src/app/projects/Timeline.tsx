import { useMemo, useState } from 'react'
import { countKinds, groupTimeline, type TimelineEvent, type TimelineKind } from '@shared/projects'
import { IconPlus } from '../../components/icons'

/**
 * 时间线（项目 / 联系人共用）：
 * - 按天 / 周分组，组标题吸顶；相邻两组空了一段就折成一条「空白期」
 * - 按类型筛选（邮件 / 附件 / 待办 / 款项 / 里程碑），筛选与粒度按 storageKey 记住
 * - 点任一事件交给 onOpen（跳邮件 / 待办 / 款项）
 */

const KIND_LABEL: Record<TimelineKind, string> = { mail: '邮件', attachment: '附件', todo: '待办', finance: '款项', milestone: '里程碑' }
const KINDS: TimelineKind[] = ['mail', 'attachment', 'todo', 'finance', 'milestone']

function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? ({ ...fallback, ...JSON.parse(v) } as T) : fallback
  } catch {
    return fallback
  }
}

function writePref(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* 存储不可用时只影响本次 */
  }
}

interface Prefs {
  kinds: TimelineKind[]
  unit: 'day' | 'week'
  order: 'desc' | 'asc'
}

export function Timeline(props: {
  events: TimelineEvent[]
  loading?: boolean
  storageKey: string
  activeId?: string | null
  onOpen(ev: TimelineEvent): void
  onAddMilestone?(m: { title: string; at: number }): void
  onToggleMilestone?(id: string): void
  emptyText?: string
}) {
  const key = `ms_tl_${props.storageKey}`
  const [prefs, setPrefsState] = useState<Prefs>(() => readPref<Prefs>(key, { kinds: [], unit: 'day', order: 'desc' }))
  const setPrefs = (patch: Partial<Prefs>) =>
    setPrefsState(p => {
      const next = { ...p, ...patch }
      writePref(key, next)
      return next
    })
  const counts = useMemo(() => countKinds(props.events), [props.events])
  const rows = useMemo(() => groupTimeline(props.events, { unit: prefs.unit, kinds: prefs.kinds, order: prefs.order }), [props.events, prefs])
  const [adding, setAdding] = useState(false)

  const toggleKind = (k: TimelineKind) => {
    const set = new Set(prefs.kinds)
    if (set.has(k)) set.delete(k)
    else set.add(k)
    setPrefs({ kinds: set.size === KINDS.length ? [] : [...set] })
  }

  return (
    <div className="flex flex-col min-h-0">
      <div className="shrink-0 flex flex-wrap items-center gap-1.5 pb-3">
        <FilterChip active={!prefs.kinds.length} onClick={() => setPrefs({ kinds: [] })} label="全部" count={props.events.length} />
        {KINDS.filter(k => counts[k] > 0 || (k === 'milestone' && !!props.onAddMilestone)).map(k => (
          <FilterChip key={k} active={prefs.kinds.includes(k)} onClick={() => toggleKind(k)} label={KIND_LABEL[k]} count={counts[k]} kind={k} />
        ))}
        <span className="flex-1" />
        {props.onAddMilestone && (
          <button
            onClick={() => setAdding(a => !a)}
            className="h-7 px-2 rounded-[var(--r-sm)] text-xs inline-flex items-center gap-1 hover:bg-[var(--hover)]"
            style={{ color: 'var(--muted)' }}
          >
            <IconPlus width={12} height={12} /> 里程碑
          </button>
        )}
        <MiniSeg value={prefs.unit} onChange={v => setPrefs({ unit: v })} options={[{ value: 'day', label: '按天' }, { value: 'week', label: '按周' }]} />
        <button
          onClick={() => setPrefs({ order: prefs.order === 'desc' ? 'asc' : 'desc' })}
          title="切换顺序"
          className="h-7 px-2 rounded-[var(--r-sm)] text-xs hover:bg-[var(--hover)] tnum"
          style={{ color: 'var(--muted)' }}
        >
          {prefs.order === 'desc' ? '最新在上 ↓' : '最早在上 ↑'}
        </button>
      </div>

      {adding && props.onAddMilestone && (
        <MilestoneForm
          onCancel={() => setAdding(false)}
          onSave={m => {
            props.onAddMilestone?.(m)
            setAdding(false)
          }}
        />
      )}

      {props.loading && !props.events.length ? (
        <div className="space-y-4 pt-1">
          {[70, 92, 60, 84, 76].map((w, i) => (
            <div key={i} className="flex gap-3 items-center">
              <div className="w-10 h-3 rounded-sm shimmer" />
              <div className="w-2 h-2 rounded-full shimmer" />
              <div className="h-3 rounded-sm shimmer" style={{ width: `${w * 0.6}%` }} />
            </div>
          ))}
        </div>
      ) : !rows.length ? (
        <div className="py-12 text-center text-xs leading-relaxed" style={{ color: 'var(--faint)' }}>
          {props.events.length ? '这个筛选下没有事件' : props.emptyText ?? '还没有可展示的往来'}
        </div>
      ) : (
        <div className="relative">
          {rows.map(row =>
            row.type === 'gap' ? (
              <div key={row.key} className="relative flex items-center gap-3 h-9 pl-[56px]" aria-label={`${row.days} 天无往来`}>
                <span className="absolute left-[63px] top-0 bottom-0 border-l border-dashed" style={{ borderColor: 'var(--border-strong)' }} />
                <span className="ml-5 text-2xs tnum px-2 h-5 inline-flex items-center rounded-full" style={{ background: 'var(--bg-soft)', color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                  {row.days} 天无动静 · 已折叠
                </span>
              </div>
            ) : (
              <section key={row.key} className="relative">
                <h3
                  className="sticky top-0 z-[1] flex items-baseline gap-2 h-8 pl-[76px] text-xs font-semibold"
                  style={{ color: 'var(--fg)', background: 'var(--bg)' }}
                >
                  <span className="tnum">{row.label}</span>
                  {row.hint && (
                    <span className="text-2xs font-medium px-1.5 h-[18px] inline-flex items-center rounded-[var(--r-xs)]" style={{ background: 'var(--selected)', color: 'var(--accent-ink)' }}>
                      {row.hint}
                    </span>
                  )}
                  <span className="text-2xs font-normal tnum" style={{ color: 'var(--faint)' }}>{row.events.length}</span>
                </h3>
                <ol className="relative pb-2">
                  <span className="absolute left-[63px] top-0 bottom-0 w-px" style={{ background: 'var(--border)' }} aria-hidden />
                  {row.events.map(ev => (
                    <EventRow key={ev.id} ev={ev} unit={prefs.unit} active={!!props.activeId && ev.messageId === props.activeId && ev.kind === 'mail'} onOpen={() => props.onOpen(ev)} onToggle={props.onToggleMilestone} />
                  ))}
                </ol>
              </section>
            )
          )}
        </div>
      )}
    </div>
  )
}

function timeLabel(ts: number, unit: 'day' | 'week'): string {
  const d = new Date(ts)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return unit === 'week' ? `周${'日一二三四五六'[d.getDay()]} ${hm}` : hm
}

/** 时间线节点：类型靠形状区分（实心 = 收到 · 空心 = 我发出 · 方块 = 附件 · ¥ = 款项 · 菱形 = 里程碑），颜色只用语义 token */
function Node(props: { ev: TimelineEvent }) {
  const { ev } = props
  const wrap = 'absolute left-[63px] top-[13px] -translate-x-1/2 inline-flex items-center justify-center'
  if (ev.kind === 'mail')
    return (
      <span
        className={`${wrap} w-[9px] h-[9px] rounded-full`}
        style={ev.direction === 'out' ? { background: 'var(--bg)', boxShadow: 'inset 0 0 0 1.6px var(--muted)' } : { background: ev.unread ? 'var(--accent)' : 'var(--muted)', boxShadow: '0 0 0 3px var(--bg)' }}
      />
    )
  if (ev.kind === 'attachment') return <span className={`${wrap} w-[7px] h-[7px] rounded-[2px]`} style={{ background: 'var(--info)', boxShadow: '0 0 0 3px var(--bg)' }} />
  if (ev.kind === 'finance')
    return (
      <span className={`${wrap} w-[15px] h-[15px] rounded-full text-[9px] font-bold`} style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)', boxShadow: '0 0 0 2px var(--bg)' }}>
        ¥
      </span>
    )
  if (ev.kind === 'todo')
    return ev.sub === 'done' ? (
      <span className={`${wrap} w-[13px] h-[13px] rounded-full`} style={{ background: 'var(--ok)', boxShadow: '0 0 0 2px var(--bg)' }}>
        <svg viewBox="0 0 24 24" width={8} height={8} fill="none" stroke="var(--bg)" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    ) : (
      <span className={`${wrap} w-[11px] h-[11px] rounded-full`} style={{ background: 'var(--bg)', boxShadow: 'inset 0 0 0 1.6px var(--ok)' }} />
    )
  return <span className={`${wrap} w-[11px] h-[11px] rotate-45 rounded-[2px]`} style={{ background: ev.status === 'done' ? 'var(--accent)' : 'var(--bg)', boxShadow: 'inset 0 0 0 1.8px var(--accent), 0 0 0 2px var(--bg)' }} />
}

function EventRow(props: { ev: TimelineEvent; unit: 'day' | 'week'; active: boolean; onOpen(): void; onToggle?(id: string): void }) {
  const { ev } = props
  const minor = ev.kind === 'attachment'
  const key = ev.titleKey && ev.title.includes(ev.titleKey) ? ev.titleKey : null
  const [pre, post] = key ? [ev.title.slice(0, ev.title.indexOf(key)), ev.title.slice(ev.title.indexOf(key) + key.length)] : [ev.title, '']
  return (
    <li className="relative">
      <button
        onClick={props.onOpen}
        className={`group w-full text-left flex items-start gap-0 pr-3 rounded-[var(--r-sm)] transition-colors ${minor ? 'py-1' : 'py-1.5'} hover:bg-[var(--hover)]`}
        style={{ background: props.active ? 'var(--selected)' : undefined }}
      >
        <span className={`w-[52px] shrink-0 text-right text-2xs tnum ${minor ? 'pt-[3px]' : 'pt-[5px]'}`} style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
          {minor ? '' : timeLabel(ev.at, props.unit)}
        </span>
        <span className="w-[24px] shrink-0" />
        <span className={`flex-1 min-w-0 ${minor ? 'pl-3' : ''}`}>
          <span className="flex items-baseline gap-1.5 min-w-0">
            {ev.kind !== 'mail' && (
              <span className="text-2xs shrink-0" style={{ color: ev.kind === 'finance' ? 'var(--warn-ink)' : ev.kind === 'todo' ? 'var(--ok-ink)' : ev.kind === 'attachment' ? 'var(--info-ink)' : 'var(--accent-ink)', fontWeight: 600 }}>
                {ev.kind === 'todo' ? (ev.sub === 'done' ? '完成' : '待办') : ev.kind === 'finance' ? '款项' : ev.kind === 'attachment' ? '附件' : '里程碑'}
              </span>
            )}
            <span
              className={`${minor ? 'text-xs' : 'text-sm'} leading-snug ${minor ? 'truncate' : 'line-clamp-2'} ${ev.unread ? 'font-semibold' : ''}`}
              style={{ color: minor ? 'var(--muted)' : 'var(--fg)', textDecoration: ev.kind === 'todo' && ev.sub === 'done' ? 'none' : undefined }}
            >
              {pre}
              {key && <mark className="hl">{key}</mark>}
              {post}
            </span>
          </span>
          {ev.detail && (
            <span className="mt-0.5 flex items-center gap-1.5 text-xs truncate" style={{ color: 'var(--faint)' }}>
              {ev.kind === 'mail' && (
                <span className="text-2xs shrink-0 px-1 h-4 inline-flex items-center rounded-[var(--r-xs)]" style={{ background: ev.direction === 'out' ? 'var(--hover)' : 'transparent', color: 'var(--muted)', boxShadow: ev.direction === 'out' ? undefined : 'inset 0 0 0 1px var(--border)' }}>
                  {ev.direction === 'out' ? '发出' : '收到'}
                </span>
              )}
              <span className="truncate">{ev.detail}</span>
            </span>
          )}
        </span>
        {ev.kind === 'milestone' && props.onToggle && ev.milestoneId && (
          <span
            role="button"
            onClick={e => {
              e.stopPropagation()
              props.onToggle?.(ev.milestoneId!)
            }}
            className="opacity-0 group-hover:opacity-100 shrink-0 text-2xs h-6 px-2 inline-flex items-center rounded-[var(--r-xs)] border border-[var(--border)] self-center"
            style={{ color: 'var(--muted)' }}
          >
            {ev.status === 'done' ? '标为未达成' : '标为达成'}
          </span>
        )}
      </button>
      <Node ev={ev} />
    </li>
  )
}

function FilterChip(props: { active: boolean; onClick(): void; label: string; count: number; kind?: TimelineKind }) {
  return (
    <button
      onClick={props.onClick}
      aria-pressed={props.active}
      className="h-7 px-2.5 rounded-full text-xs inline-flex items-center gap-1.5 border transition-colors"
      style={
        props.active
          ? { background: 'var(--accent)', color: 'var(--on-accent)', borderColor: 'var(--accent)' }
          : { background: 'var(--surface-strong)', color: 'var(--muted)', borderColor: 'var(--border)' }
      }
    >
      {props.label}
      <span className="tnum text-2xs" style={{ opacity: 0.7, fontFamily: 'var(--font-mono)' }}>{props.count}</span>
    </button>
  )
}

export function MiniSeg<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div className="no-drag inline-flex p-0.5 rounded-[var(--r-sm)]" style={{ background: 'var(--hover)' }} role="tablist">
      {props.options.map(o => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === props.value}
          onClick={() => props.onChange(o.value)}
          className="h-6 px-2 rounded-[var(--r-xs)] text-xs"
          style={o.value === props.value ? { background: 'var(--surface-strong)', color: 'var(--fg)', fontWeight: 600, boxShadow: 'var(--shadow-sm)' } : { color: 'var(--muted)' }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function MilestoneForm(props: { onSave(m: { title: string; at: number }): void; onCancel(): void }) {
  const today = new Date()
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(iso)
  const save = () => {
    const at = Date.parse(`${date}T12:00:00`)
    if (!title.trim() || !Number.isFinite(at)) return
    props.onSave({ title: title.trim(), at })
  }
  return (
    <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-[var(--r-md)] border border-[var(--border)] pop-in" style={{ background: 'var(--surface-strong)' }}>
      <span className="w-2.5 h-2.5 rotate-45 rounded-[2px] shrink-0" style={{ boxShadow: 'inset 0 0 0 1.8px var(--accent)' }} />
      <input
        autoFocus
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') props.onCancel()
        }}
        placeholder="里程碑，如「合同签署」「第一批交付」"
        className="flex-1 min-w-0 bg-transparent outline-none text-sm"
        style={{ color: 'var(--fg)' }}
      />
      <input type="date" value={date} onChange={e => setDate(e.target.value)} className="h-7 px-2 rounded-[var(--r-sm)] text-xs border border-[var(--border)] bg-transparent tnum" style={{ color: 'var(--fg)' }} />
      <button onClick={save} className="h-7 px-3 rounded-[var(--r-sm)] text-xs font-semibold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
        添加
      </button>
      <button onClick={props.onCancel} className="h-7 px-2 rounded-[var(--r-sm)] text-xs hover:bg-[var(--hover)]" style={{ color: 'var(--muted)' }}>
        取消
      </button>
    </div>
  )
}
