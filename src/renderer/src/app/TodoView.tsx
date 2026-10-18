import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useMail } from '../stores/mail'
import { goView } from '../lib/route'
import { useTodos, useTodoEvents } from '../lib/todos'
import { schedule, parseQuickAdd, fmtClock, fmtDue, loadScheduleConfig, saveScheduleConfig, type Planned, type Bucket, type TodoData, type ScheduleConfig } from '../lib/scheduler'
import { IconSparkles, IconClose, IconPlus } from '../components/icons'
import type { InsightRecord } from '@shared/types'

const BUCKET_LABEL: Record<Bucket, string> = { overdue: '逾期 · 已挪到今天', today: '今天', tomorrow: '明天', later: '之后', someday: '以后再说' }
const BUCKET_ORDER: Bucket[] = ['overdue', 'today', 'tomorrow', 'later', 'someday']
const ORDER_KEY = 'ms_todo_order'
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

type Phase = 'idle' | 'analyze' | 'settle'

function loadOrder(): string[] | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null')
    return Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}
function saveOrder(ids: string[] | null) {
  try {
    if (ids) localStorage.setItem(ORDER_KEY, JSON.stringify(ids))
    else localStorage.removeItem(ORDER_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * 待办（GTD，Sorted³ 式）：左边按「逾期 / 今天 / 明天 / 之后 / 以后再说」排好的清单，右边今天的时间轴。
 * - 自动收集：邮件理解出的事项、Agent、规则、MCP 都会进来
 * - 「自动排序」：确定性排布（截止 · 重要 · 快速清掉 · 搁置），带「分析 → 排布 → 落位」动画
 * - 「AI 排布」：先让 AI 估时长、定优先级、写理由，再排
 * - 手动拖动可以改顺序；再点自动排序即恢复科学排布
 */
export function TodoView() {
  useTodoEvents()
  const { todos } = useTodos()
  const [now, setNow] = useState(Date.now())
  const [manual, setManual] = useState<string[] | undefined>(loadOrder)
  const [phase, setPhase] = useState<Phase>('idle')
  const [version, setVersion] = useState(0)
  const [deltas, setDeltas] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const [quick, setQuick] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [cfg, setCfg] = useState<ScheduleConfig>(loadScheduleConfig)
  const [cfgOpen, setCfgOpen] = useState(false)
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const firstRects = useRef<Map<string, number> | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 每分钟刷新「现在」线与排布起点
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const plan = useMemo(() => schedule(todos, now, cfg, manual), [todos, now, manual, cfg])
  const done = useMemo(() => todos.filter(t => t.status === 'done').sort((a, b) => Number((b.data as { doneAt?: number }).doneAt ?? b.createdAt) - Number((a.data as { doneAt?: number }).doneAt ?? a.createdAt)).slice(0, 8), [todos])
  const grouped = useMemo(() => BUCKET_ORDER.map(b => ({ bucket: b, items: plan.items.filter(i => i.bucket === b) })).filter(g => g.items.length), [plan])
  const todayItems = plan.items.filter(i => i.start && new Date(i.start).toDateString() === new Date(now).toDateString())
  const todayMinutes = todayItems.reduce((s, i) => s + i.minutes, 0)

  const showToast = (t: string) => {
    setToast(t)
    setTimeout(() => setToast(''), 3800)
  }

  /** 记录当前每行的位置（FLIP 的 First） */
  const captureFirst = () => {
    const map = new Map<string, number>()
    rowRefs.current.forEach((el, id) => map.set(id, el.getBoundingClientRect().top))
    firstRects.current = map
  }

  // FLIP 的 Last / Invert / Play：新顺序渲染后，每行从旧位置滑到新位置（弹簧曲线、逐行错开）
  useLayoutEffect(() => {
    const first = firstRects.current
    if (!first || reducedMotion()) {
      firstRects.current = null
      return
    }
    firstRects.current = null
    let i = 0
    rowRefs.current.forEach((el, id) => {
      const before = first.get(id)
      const after = el.getBoundingClientRect().top
      const dy = before === undefined ? 24 : before - after
      if (Math.abs(dy) < 1 && before !== undefined) return
      el.animate(
        [
          { transform: `translateY(${dy}px) scale(${before === undefined ? 0.98 : 1.015})`, opacity: before === undefined ? 0 : 1, boxShadow: '0 12px 28px -12px oklch(0% 0 0 / 0.25)' },
          { transform: 'translateY(0) scale(1)', opacity: 1, boxShadow: '0 0 0 0 transparent' }
        ],
        { duration: 620, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', delay: Math.min(i++, 14) * 32, fill: 'backwards' }
      )
    })
  }, [version])

  /** 自动排序：分析（扫描 + 评分条）→ 排布（FLIP）→ 落位（时间轴逐块生长） */
  const runSort = async (useAi: boolean) => {
    if (phase !== 'idle' || busy) return
    const before = plan.items.map(i => i.id)
    if (useAi) {
      setBusy('AI 正在估时长、定优先级…')
      const res = await api.aiPlanTodos(plan.items.map(i => i.id))
      setBusy('')
      if (!res.ok) {
        showToast(res.error === 'AI 未配置' ? 'AI 还没配置，先用规则排布（设置 → AI 模型）' : `AI 排布失败：${res.error}`)
      } else await useTodos.getState().load()
    }
    setPhase('analyze')
    await new Promise(r => setTimeout(r, reducedMotion() ? 0 : 900))
    captureFirst()
    saveOrder(null)
    const next = schedule(useTodos.getState().todos, Date.now(), cfg)
    const after = next.items.map(i => i.id)
    const d: Record<string, number> = {}
    after.forEach((id, idx) => {
      const old = before.indexOf(id)
      if (old >= 0 && old !== idx) d[id] = old - idx
    })
    setDeltas(d)
    setManual(undefined)
    setNow(Date.now())
    setVersion(v => v + 1)
    setPhase('settle')
    const moved = Object.keys(d).length
    const hours = (next.items.filter(i => i.start && new Date(i.start).toDateString() === new Date().toDateString()).reduce((s, i) => s + i.minutes, 0) / 60).toFixed(1)
    showToast(
      `已按截止 · 重要度 · 时长重新排布 ${next.items.length} 项${moved ? `，调整了 ${moved} 项位置` : '，顺序已是最优'}` +
        `${next.movedToToday ? `，${next.movedToToday} 项逾期挪到今天` : ''}；今天约 ${hours} 小时，还空 ${(next.freeToday / 60).toFixed(1)} 小时`
    )
    setTimeout(() => {
      setPhase('idle')
      setDeltas({})
    }, 2200)
  }

  const relayout = (order?: string[]) => {
    captureFirst()
    setManual(order)
    saveOrder(order ?? null)
    setVersion(v => v + 1)
  }

  const complete = async (t: InsightRecord) => {
    const el = rowRefs.current.get(t.id)
    if (el && !reducedMotion()) {
      await el.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(24px)' }], { duration: 260, easing: 'cubic-bezier(0.4,0,1,1)' }).finished
    }
    captureFirst()
    await api.updateTodo(t.id, { status: 'done', data: { doneAt: Date.now() } })
    await useTodos.getState().load()
    setVersion(v => v + 1)
  }

  const addQuick = async () => {
    const q = quick.trim()
    if (!q) return
    const p = parseQuickAdd(q)
    captureFirst()
    await api.createTodo({ title: p.title, dueAt: p.dueAt, data: { minutes: p.minutes, priority: p.priority, fixedAt: p.fixedAt } })
    setQuick('')
    await useTodos.getState().load()
    setVersion(v => v + 1)
  }

  const onDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) return
    const ids = plan.items.map(i => i.id).filter(id => id !== dragId)
    ids.splice(ids.indexOf(targetId), 0, dragId)
    setDragId(null)
    relayout(ids)
    showToast('已按你的顺序排；点「自动排序」恢复科学排布')
  }

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <header className="drag-region shrink-0 px-6 pt-4 pb-3 flex items-end gap-3 border-b border-[var(--border)]">
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--fg)', letterSpacing: '-0.01em' }}>待办</h1>
          <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            今天 {todayItems.length} 项 · 约 {(todayMinutes / 60).toFixed(1)} 小时 · 还空 {(plan.freeToday / 60).toFixed(1)} 小时
            {manual && <span style={{ color: 'var(--faint)' }}> · 手动顺序</span>}
          </div>
        </div>
        <div className="relative no-drag">
          <button
            onClick={() => setCfgOpen(o => !o)}
            className="h-8 px-2.5 rounded-[var(--r-sm)] text-xs hover:bg-[var(--hover)]"
            style={{ color: 'var(--muted)' }}
            title="工作时段：排布只会把待办放进这些时间"
          >
            {String(cfg.dayStart).padStart(2, '0')}:00–{String(cfg.dayEnd).padStart(2, '0')}:00
          </button>
          {cfgOpen && (
            <div className="absolute right-0 top-full mt-1.5 z-30 w-[260px] p-3 rounded-[var(--r-md)] border border-[var(--border)] flex flex-col gap-2.5 text-xs pop-in" style={{ background: 'var(--surface-strong)', boxShadow: 'var(--shadow)', color: 'var(--fg)' }}>
              {(
                [
                  ['开始', 'dayStart', 5, 12],
                  ['结束', 'dayEnd', 13, 24]
                ] as const
              ).map(([label, key, min, max]) => (
                <label key={key} className="flex items-center justify-between">
                  {label}
                  <select
                    value={cfg[key]}
                    onChange={e => {
                      const next = { ...cfg, [key]: Number(e.target.value) }
                      setCfg(next)
                      saveScheduleConfig(next)
                    }}
                    className="h-7 px-1.5 rounded-[var(--r-xs)] border border-[var(--border)]"
                    style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
                  >
                    {Array.from({ length: max - min + 1 }, (_, i) => min + i).map(h => (
                      <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="flex items-center justify-between">
                避开午休 12:00–13:00
                <input
                  type="checkbox"
                  checked={!!cfg.lunch}
                  onChange={e => {
                    const next = { ...cfg, lunch: e.target.checked ? ([12, 13] as [number, number]) : null }
                    setCfg(next)
                    saveScheduleConfig(next)
                  }}
                />
              </label>
              <label className="flex items-center justify-between">
                周末也排
                <input
                  type="checkbox"
                  checked={cfg.workdays.includes(0)}
                  onChange={e => {
                    const next = { ...cfg, workdays: e.target.checked ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5] }
                    setCfg(next)
                    saveScheduleConfig(next)
                  }}
                />
              </label>
            </div>
          )}
        </div>
        <button
          onClick={() => void runSort(false)}
          disabled={phase !== 'idle' || !!busy}
          className="no-drag h-8 px-3 rounded-[var(--r-sm)] text-xs font-semibold border border-[var(--border)] hover:bg-[var(--hover)] disabled:opacity-50"
          style={{ color: 'var(--fg)', background: 'var(--surface-strong)' }}
        >
          自动排序
        </button>
        <button
          onClick={() => void runSort(true)}
          disabled={phase !== 'idle' || !!busy}
          title="AI 先估时长、定优先级、写理由，再排布"
          className="no-drag h-8 px-3 rounded-[var(--r-sm)] text-xs font-semibold inline-flex items-center gap-1.5 ai-chip disabled:opacity-60"
          style={{ boxShadow: 'inset 0 0 0 1px var(--ai-ink)' }}
        >
          <IconSparkles width={13} height={13} className={busy ? 'spinning' : ''} />
          {busy || 'AI 排布'}
        </button>
      </header>

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="shrink-0 px-6 pt-4 pb-2">
            <label className="h-10 px-3 flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border)] focus-within:border-[var(--border-strong)]" style={{ background: 'var(--surface-strong)' }}>
              <IconPlus width={14} height={14} style={{ color: 'var(--faint)' }} />
              <input
                value={quick}
                onChange={e => setQuick(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void addQuick()}
                placeholder="添加待办，可直接写时间：明天下午3点 给王小明回电话 30分钟 !"
                className="flex-1 bg-transparent outline-none text-sm"
                style={{ color: 'var(--fg)' }}
              />
            </label>
          </div>

          <div ref={listRef} className="relative flex-1 overflow-y-auto px-6 pb-10">
            {phase === 'analyze' && <div className="todo-scan" aria-hidden="true" />}
            {!plan.items.length && (
              <div className="mt-16 text-center text-sm leading-relaxed" style={{ color: 'var(--faint)' }}>
                还没有待办。
                <br />
                邮件里的截止事项、需要回复的重要邮件会自动收进来；也可以在上面直接写一句话添加。
              </div>
            )}
            {grouped.map(g => (
              <section key={g.bucket} className="mt-3">
                <h2 className="text-xs font-semibold py-1.5 flex items-center gap-2" style={{ color: g.bucket === 'overdue' ? 'var(--danger-ink)' : 'var(--faint)' }}>
                  {BUCKET_LABEL[g.bucket]}
                  <span className="tnum" style={{ fontFamily: 'var(--font-mono)' }}>{g.items.length}</span>
                </h2>
                <div className="flex flex-col gap-1.5">
                  {g.items.map(p => (
                    <TodoRow
                      key={p.id}
                      p={p}
                      now={now}
                      phase={phase}
                      delta={deltas[p.id]}
                      editing={editing === p.id}
                      onEdit={() => setEditing(e => (e === p.id ? null : p.id))}
                      onDone={() => void complete(p.todo)}
                      onSaved={async () => {
                        await useTodos.getState().load()
                        relayout(manual)
                      }}
                      setRef={el => {
                        if (el) rowRefs.current.set(p.id, el)
                        else rowRefs.current.delete(p.id)
                      }}
                      onDragStart={() => setDragId(p.id)}
                      onDrop={() => onDrop(p.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
            {done.length > 0 && (
              <section className="mt-6">
                <h2 className="text-xs font-semibold py-1.5" style={{ color: 'var(--faint)' }}>已完成</h2>
                {done.map(t => (
                  <div key={t.id} className="h-8 flex items-center gap-2.5 px-3 text-sm" style={{ color: 'var(--faint)' }}>
                    <button
                      onClick={async () => {
                        await api.updateTodo(t.id, { status: 'open' })
                        await useTodos.getState().load()
                      }}
                      aria-label="标为未完成"
                      className="w-4 h-4 rounded-full inline-flex items-center justify-center"
                      style={{ background: 'var(--muted)', color: 'var(--surface-strong)' }}
                    >
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
                    </button>
                    <span className="line-through truncate">{t.title}</span>
                    {(t.data as { doneBy?: string }).doneBy === 'reply' && <span className="text-2xs shrink-0">回信后自动完成</span>}
                  </div>
                ))}
              </section>
            )}
          </div>
        </div>

        <Timeline items={todayItems} now={now} version={version} />
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[560px] px-4 py-2.5 rounded-[var(--r-md)] text-sm pop-in" style={{ background: 'var(--rail-bg)', color: 'var(--rail-fg)', boxShadow: 'var(--shadow-float)' }}>
          {toast}
        </div>
      )}
    </div>
  )
}

function TodoRow(props: {
  p: Planned
  now: number
  phase: Phase
  delta?: number
  editing: boolean
  onEdit(): void
  onDone(): void
  onSaved(): Promise<void>
  setRef(el: HTMLElement | null): void
  onDragStart(): void
  onDrop(): void
}) {
  const { p, phase } = props
  const t = p.todo
  const d = (t.data ?? {}) as TodoData
  const prio = d.priority ?? 2
  const [over, setOver] = useState(false)
  const moved = phase === 'settle' && props.delta
  return (
    <div
      ref={props.setRef}
      draggable={!props.editing}
      onDragStart={props.onDragStart}
      onDragOver={e => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={() => {
        setOver(false)
        props.onDrop()
      }}
      className={`relative rounded-[var(--r-md)] border transition-colors ${moved && props.delta! > 0 ? 'todo-rise' : ''}`}
      style={{ background: 'var(--surface-strong)', borderColor: over ? 'var(--fg)' : 'var(--border)' }}
    >
      <div className="flex items-start gap-3 px-3.5 py-2.5 cursor-default" onClick={props.onEdit}>
        <button
          onClick={e => {
            e.stopPropagation()
            props.onDone()
          }}
          aria-label={`完成：${t.title}`}
          className="mt-0.5 w-[18px] h-[18px] shrink-0 rounded-full border-[1.5px] hover:bg-[var(--hover-strong)]"
          style={{ borderColor: prio === 1 ? 'var(--fg)' : 'var(--border-strong)' }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-sm truncate flex-1" style={{ color: 'var(--fg)', fontWeight: prio === 1 ? 600 : 400 }}>{t.title}</span>
            {p.start && (
              <span className="text-xs shrink-0 tnum" style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                {p.bucket === 'today' || p.bucket === 'overdue' ? fmtClock(p.start) : fmtDue(p.start, props.now)}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs">
            <Chip>{p.minutes} 分钟</Chip>
            {t.dueAt && <Chip tone={t.dueAt < props.now ? 'danger' : p.atRisk ? 'warn' : undefined}>截止 {fmtDue(t.dueAt, props.now)}</Chip>}
            {prio === 1 && <Chip tone="strong">高优先</Chip>}
            {d.from === 'mail' && t.messageId && (
              <button
                onClick={e => {
                  e.stopPropagation()
                  goView('mail')
                  useMail.getState().select(t.messageId!)
                }}
                className="px-1.5 h-5 rounded-[var(--r-xs)] border border-[var(--border)] hover:bg-[var(--hover)]"
                style={{ color: 'var(--muted)' }}
              >
                来自邮件 ↗
              </button>
            )}
            {d.todoKind === 'reply' && <Chip>回信后自动完成</Chip>}
            <span className="ml-0.5" style={{ color: 'var(--faint)' }}>
              {moved || phase === 'analyze' ? <mark className="hl">{p.reason}</mark> : p.reason}
            </span>
          </div>
          {phase === 'analyze' && <ScoreBars f={p.factors} />}
        </div>
        {moved ? (
          <span className="absolute -right-2 -top-2 text-2xs font-bold px-1.5 h-5 inline-flex items-center rounded-full pop-in" style={props.delta! > 0 ? { background: 'var(--ai)', color: 'var(--ai-ink)' } : { background: 'var(--hover-strong)', color: 'var(--muted)' }}>
            {props.delta! > 0 ? `↑${props.delta}` : `↓${-props.delta!}`}
          </span>
        ) : null}
      </div>
      {props.editing && <TodoEditor todo={t} onSaved={props.onSaved} onClose={props.onEdit} />}
    </div>
  )
}

/** 分析阶段：三条评分条依次长出来（截止 · 重要 · 快速清掉），让排序依据可见 */
function ScoreBars(props: { f: Planned['factors'] }) {
  const bars: [string, number][] = [
    ['截止', props.f.due],
    ['重要', props.f.importance],
    ['快清', props.f.quick]
  ]
  return (
    <div className="mt-2 grid grid-cols-3 gap-2">
      {bars.map(([label, v], i) => (
        <div key={label} className="flex items-center gap-1.5">
          <span className="text-2xs w-6 shrink-0" style={{ color: 'var(--faint)' }}>{label}</span>
          <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--hover-strong)' }}>
            <div className="h-full rounded-full todo-bar" style={{ width: `${Math.round(v * 100)}%`, background: 'var(--ai)', animationDelay: `${i * 120}ms` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function Chip(props: { children: React.ReactNode; tone?: 'danger' | 'warn' | 'strong' }) {
  const style =
    props.tone === 'danger'
      ? { background: 'var(--danger-soft)', color: 'var(--danger-ink)' }
      : props.tone === 'warn'
        ? { background: 'var(--warn-soft)', color: 'var(--warn-ink)' }
        : props.tone === 'strong'
          ? { background: 'var(--fg)', color: 'var(--surface-strong)' }
          : { background: 'var(--hover)', color: 'var(--muted)' }
  return <span className="px-1.5 h-5 inline-flex items-center rounded-[var(--r-xs)]" style={style}>{props.children}</span>
}

const toLocalInput = (ts: number | null | undefined) => {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function TodoEditor(props: { todo: InsightRecord; onSaved(): Promise<void>; onClose(): void }) {
  const t = props.todo
  const d = (t.data ?? {}) as TodoData
  const [title, setTitle] = useState(t.title)
  const save = async (patch: Parameters<typeof api.updateTodo>[1]) => {
    await api.updateTodo(t.id, patch)
    await props.onSaved()
  }
  return (
    <div className="px-3.5 pb-3 pt-1 flex flex-col gap-2.5 border-t border-[var(--border-soft)] fade-in" onClick={e => e.stopPropagation()}>
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== t.title && void save({ title: title.trim() })}
        className="mt-2 h-8 px-2.5 rounded-[var(--r-sm)] border border-[var(--border)] text-sm outline-none"
        style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
      />
      <div className="flex flex-wrap items-center gap-3 text-xs" style={{ color: 'var(--muted)' }}>
        <label className="flex items-center gap-1.5">
          截止
          <input
            type="datetime-local"
            defaultValue={toLocalInput(t.dueAt)}
            onChange={e => void save({ dueAt: e.target.value ? new Date(e.target.value).getTime() : null })}
            className="h-7 px-1.5 rounded-[var(--r-xs)] border border-[var(--border)]"
            style={{ background: 'var(--surface-strong)', color: 'var(--fg)' }}
          />
        </label>
        <label className="flex items-center gap-1.5">
          时长
          <select
            defaultValue={d.minutes ?? 25}
            onChange={e => void save({ data: { minutes: Number(e.target.value) } })}
            className="h-7 px-1.5 rounded-[var(--r-xs)] border border-[var(--border)]"
            style={{ background: 'var(--surface-strong)', color: 'var(--fg)' }}
          >
            {[5, 10, 15, 25, 30, 45, 60, 90, 120, 180].map(m => (
              <option key={m} value={m}>{m} 分钟</option>
            ))}
          </select>
        </label>
        <span className="flex items-center gap-1">
          优先级
          {([1, 2, 3] as const).map(n => (
            <button
              key={n}
              onClick={() => void save({ data: { priority: n } })}
              className="h-6 px-2 rounded-[var(--r-xs)] border"
              style={(d.priority ?? 2) === n ? { background: 'var(--fg)', color: 'var(--surface-strong)', borderColor: 'var(--fg)' } : { borderColor: 'var(--border)', color: 'var(--muted)' }}
            >
              {n === 1 ? '高' : n === 2 ? '中' : '低'}
            </button>
          ))}
        </span>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            defaultChecked={!!d.fixedAt}
            disabled={!t.dueAt}
            onChange={e => void save({ data: { fixedAt: e.target.checked ? t.dueAt : null } })}
          />
          固定在截止时间（会议 / 约好的电话）
        </label>
        <div className="flex-1" />
        <button
          onClick={async () => {
            await api.updateTodo(t.id, { status: 'dismissed' })
            await props.onSaved()
            props.onClose()
          }}
          className="inline-flex items-center gap-1 h-7 px-2 rounded-[var(--r-xs)] hover:bg-[var(--danger-soft)]"
          style={{ color: 'var(--danger-ink)' }}
        >
          <IconClose width={11} height={11} /> 删除
        </button>
      </div>
    </div>
  )
}

/** 今天的时间轴：8:00–20:00，每次排布后各块依次「长」进自己的时段；红线是现在 */
function Timeline(props: { items: Planned[]; now: number; version: number }) {
  const START = 8
  const END = 20
  const PX = 52 // 每小时高度
  const top = (ts: number) => {
    const d = new Date(ts)
    return (d.getHours() + d.getMinutes() / 60 - START) * PX
  }
  const nowTop = top(props.now)
  return (
    <aside className="w-[300px] shrink-0 border-l border-[var(--border)] overflow-y-auto hidden lg:block" style={{ background: 'var(--bg-soft)' }} aria-label="今天的时间轴">
      <div className="px-4 pt-4 pb-2 text-xs font-semibold" style={{ color: 'var(--faint)' }}>今天</div>
      <div className="relative mx-4 mb-6" style={{ height: (END - START) * PX }}>
        {Array.from({ length: END - START + 1 }, (_, i) => (
          <div key={i} className="absolute left-0 right-0 flex items-start gap-2" style={{ top: i * PX }}>
            <span className="w-9 -mt-2 text-2xs tnum" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{String(START + i).padStart(2, '0')}:00</span>
            <span className="flex-1 border-t border-[var(--border-soft)]" />
          </div>
        ))}
        {props.items.map((p, i) => {
          const y = top(p.start!)
          const h = Math.max(18, (p.minutes / 60) * PX - 3)
          if (y + h < 0 || y > (END - START) * PX) return null
          const fixed = !!(p.todo.data as TodoData).fixedAt
          return (
            <div
              key={`${props.version}-${p.id}`}
              className="absolute left-11 right-0 rounded-[var(--r-sm)] px-2 py-1 overflow-hidden tl-block"
              style={{
                top: y,
                height: h,
                animationDelay: `${300 + i * 70}ms`,
                background: fixed ? 'var(--fg)' : 'var(--surface-strong)',
                color: fixed ? 'var(--surface-strong)' : 'var(--fg)',
                border: fixed ? 'none' : '1px solid var(--border)',
                borderLeft: fixed ? 'none' : `3px solid ${p.atRisk ? 'var(--warn)' : p.bucket === 'overdue' ? 'var(--danger)' : 'var(--ai-line)'}`
              }}
              title={`${p.todo.title} · ${fmtClock(p.start!)}–${fmtClock(p.end!)} · ${p.reason}`}
            >
              <div className="text-2xs font-semibold truncate">{p.todo.title}</div>
              {h > 30 && <div className="text-2xs opacity-70 tnum">{fmtClock(p.start!)}–{fmtClock(p.end!)}</div>}
            </div>
          )
        })}
        {nowTop >= 0 && nowTop <= (END - START) * PX && (
          <div className="absolute left-9 right-0 flex items-center pointer-events-none" style={{ top: nowTop }}>
            <span className="w-2 h-2 rounded-full -ml-1" style={{ background: 'var(--danger)' }} />
            <span className="flex-1 h-px" style={{ background: 'var(--danger)' }} />
          </div>
        )}
      </div>
    </aside>
  )
}
