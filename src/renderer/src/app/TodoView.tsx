import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useMail } from '../stores/mail'
import { goView } from '../lib/route'
import { askAgent } from '../lib/agent-ask'
import { useTodos, useTodoEvents } from '../lib/todos'
import {
  schedule, parseQuickAdd, fmtClock, fmtDue, loadScheduleConfig, saveScheduleConfig, minutesOf,
  type Planned, type Bucket, type ScheduleConfig
} from '../lib/scheduler'
import { IconSparkles, IconClose, IconPlus } from '../components/icons'
import type { InsightRecord, TodoData, TodoChecklistItem } from '@shared/types'

/* ================================================================
 * 待办（GTD）：
 * - 收：快捷添加（一句话识别时间 / 时长 / #项目 @情境 +标签 / 重复 / 优先级）、邮件转待办、会议邀请、Agent、规则、MCP
 * - 理：收集箱逐条整理；「自动排序」科学排布（带动画）；「AI 排布」先估时长定优先级
 * - 维度：项目 · 标签 · 情境 · 精力 · 子任务 · 重复 · 备注 · 关联邮件 / 会议
 * - 视图：列表（+ 今日时间轴）· 看板 · 本周 · 四象限
 * - 联动：会议一键入会、会前准备 / 会后跟进交给 Agent；回信后回复类待办自动完成
 * ================================================================ */

type ViewMode = 'list' | 'board' | 'week' | 'matrix'
type Phase = 'idle' | 'analyze' | 'settle'

const BUCKET_LABEL: Record<Bucket, string> = { overdue: '逾期 · 已挪到今天', today: '今天', tomorrow: '明天', later: '之后', someday: '以后再说' }
const BUCKET_ORDER: Bucket[] = ['overdue', 'today', 'tomorrow', 'later', 'someday']
const ORDER_KEY = 'ms_todo_order'
const VIEW_KEY = 'ms_todo_view'
const CONTEXTS = ['@电脑', '@电话', '@外出', '@等待', '@家里']
const REPEAT_LABEL: Record<string, string> = { daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月' }
const MEETING_LABEL: Record<string, string> = { zoom: 'Zoom', teams: 'Teams', meet: 'Meet', tencent: '腾讯会议', feishu: '飞书会议', webex: 'Webex', other: '会议' }
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const dataOf = (t: InsightRecord) => (t.data ?? {}) as TodoData
/** 收集箱 = 还没定时间的新事项；带截止的（如邮件里的账单）已经可执行，直接进排布 */
const inInbox = (t: InsightRecord) => !!dataOf(t).inbox && !t.dueAt

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
function writeJson(key: string, v: unknown) {
  try {
    if (v === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

const endOfDay = (ts: number, plusDays = 0) => {
  const d = new Date(ts)
  d.setDate(d.getDate() + plusDays)
  d.setHours(18, 0, 0, 0)
  return d.getTime()
}

interface Filters {
  project: string
  context: string
  tag: string
  energy: string
}

export function TodoView() {
  useTodoEvents()
  const { todos } = useTodos()
  const [now, setNow] = useState(Date.now())
  const [view, setView] = useState<ViewMode>(() => readJson<ViewMode>(VIEW_KEY, 'list'))
  const [manual, setManual] = useState<string[] | undefined>(() => readJson<string[] | undefined>(ORDER_KEY, undefined))
  const [cfg, setCfg] = useState<ScheduleConfig>(loadScheduleConfig)
  const [filters, setFilters] = useState<Filters>({ project: '', context: '', tag: '', energy: '' })
  const [phase, setPhase] = useState<Phase>('idle')
  const [version, setVersion] = useState(0)
  const [deltas, setDeltas] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const [quick, setQuick] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [cfgOpen, setCfgOpen] = useState(false)
  const quickRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const firstRects = useRef<Map<string, number> | null>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  // 托盘 / ⌥⌘T「新建待办」与提醒通知「打开待办」
  useEffect(() => {
    const focusQuick = () => setTimeout(() => quickRef.current?.focus(), 50)
    const openTodo = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      if (id) {
        setView('list')
        setEditing(id)
      }
    }
    window.addEventListener('ms:todo-quick', focusQuick)
    window.addEventListener('ms:todo-open', openTodo)
    return () => {
      window.removeEventListener('ms:todo-quick', focusQuick)
      window.removeEventListener('ms:todo-open', openTodo)
    }
  }, [])

  // 单键：N 新建（在输入框外）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || e.metaKey || e.ctrlKey) return
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        quickRef.current?.focus()
      } else if (e.key === 'Escape') setEditing(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const plan = useMemo(() => schedule(todos, now, cfg, manual), [todos, now, cfg, manual])
  const matches = (t: InsightRecord) => {
    const d = dataOf(t)
    return (
      (!filters.project || (d.project ?? '') === filters.project) &&
      (!filters.context || d.context === filters.context) &&
      (!filters.tag || (d.tags ?? []).includes(filters.tag)) &&
      (!filters.energy || d.energy === filters.energy)
    )
  }
  const visible = plan.items.filter(p => matches(p.todo))
  const inbox = visible.filter(p => inInbox(p.todo))
  const organized = visible.filter(p => !inInbox(p.todo))
  const projects = useMemo(() => [...new Set(todos.filter(t => t.status === 'open').map(t => dataOf(t).project).filter((x): x is string => !!x))], [todos])
  const tags = useMemo(() => [...new Set(todos.filter(t => t.status === 'open').flatMap(t => dataOf(t).tags ?? []))], [todos])
  const usedContexts = useMemo(() => [...new Set(todos.filter(t => t.status === 'open').map(t => dataOf(t).context).filter((x): x is string => !!x))], [todos])
  const todayItems = plan.items.filter(i => i.start && new Date(i.start).toDateString() === new Date(now).toDateString())
  const done = useMemo(
    () => todos.filter(t => t.status === 'done').sort((a, b) => Number(dataOf(b).doneAt ?? b.createdAt) - Number(dataOf(a).doneAt ?? a.createdAt)).slice(0, 8),
    [todos]
  )

  const showToast = (t: string) => {
    setToast(t)
    setTimeout(() => setToast(''), 3800)
  }
  const reload = () => useTodos.getState().load()

  const captureFirst = () => {
    const map = new Map<string, number>()
    rowRefs.current.forEach((el, id) => map.set(id, el.getBoundingClientRect().top))
    firstRects.current = map
  }

  // FLIP：新顺序渲染后，每行从旧位置弹簧滑到新位置（逐行错开）
  useLayoutEffect(() => {
    const first = firstRects.current
    firstRects.current = null
    if (!first || reducedMotion()) return
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

  const runSort = async (useAi: boolean) => {
    if (phase !== 'idle' || busy) return
    if (view !== 'list') setView('list')
    const before = plan.items.map(i => i.id)
    if (useAi) {
      setBusy('AI 正在估时长、定优先级…')
      const res = await api.aiPlanTodos(plan.items.map(i => i.id))
      setBusy('')
      if (!res.ok) showToast(res.error === 'AI 未配置' ? 'AI 还没配置，先用规则排布（设置 → AI 模型）' : `AI 排布失败：${res.error}`)
      else await reload()
    }
    setPhase('analyze')
    await new Promise(r => setTimeout(r, reducedMotion() ? 0 : 900))
    captureFirst()
    writeJson(ORDER_KEY, null)
    const next = schedule(useTodos.getState().todos, Date.now(), cfg)
    const d: Record<string, number> = {}
    next.items.forEach((it, idx) => {
      const old = before.indexOf(it.id)
      if (old >= 0 && old !== idx) d[it.id] = old - idx
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
    writeJson(ORDER_KEY, order ?? null)
    setVersion(v => v + 1)
  }

  const update = async (id: string, patch: Parameters<typeof api.updateTodo>[1], animate = true) => {
    if (animate) captureFirst()
    await api.updateTodo(id, patch)
    await reload()
    if (animate) setVersion(v => v + 1)
  }

  const complete = async (t: InsightRecord) => {
    const el = rowRefs.current.get(t.id)
    if (el && !reducedMotion()) {
      await el.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(24px)' }], { duration: 260, easing: 'cubic-bezier(0.4,0,1,1)' }).finished
    }
    await update(t.id, { status: 'done', data: { doneAt: Date.now() } })
    if (dataOf(t).repeat) showToast(`已完成，下一次「${t.title}」已排上`)
  }

  const addQuick = async () => {
    const q = quick.trim()
    if (!q) return
    const p = parseQuickAdd(q)
    captureFirst()
    await api.createTodo({
      title: p.title,
      dueAt: p.dueAt,
      data: {
        minutes: p.minutes,
        priority: p.priority,
        fixedAt: p.fixedAt,
        project: p.project ?? (filters.project || undefined),
        context: p.context,
        tags: p.tags,
        repeat: p.repeat,
        energy: p.energy,
        // 没写时间 / 项目的进收集箱，稍后统一整理
        inbox: !p.dueAt && !p.project && !filters.project
      }
    })
    setQuick('')
    await reload()
    setVersion(v => v + 1)
  }

  const counts = { inbox: inbox.length, today: todayItems.length }

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <header className="drag-region shrink-0 px-6 pt-4 pb-3 flex flex-wrap items-end gap-3 border-b border-[var(--border)]">
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--fg)', letterSpacing: '-0.01em' }}>待办</h1>
          <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            今天 {counts.today} 项 · 约 {(todayItems.reduce((s, i) => s + i.minutes, 0) / 60).toFixed(1)} 小时 · 还空 {(plan.freeToday / 60).toFixed(1)} 小时
            {counts.inbox > 0 && <span> · 收集箱 {counts.inbox} 项待整理</span>}
            {manual && <span style={{ color: 'var(--faint)' }}> · 手动顺序</span>}
          </div>
        </div>
        <Seg
          value={view}
          onChange={v => {
            setView(v)
            writeJson(VIEW_KEY, v)
          }}
          options={[
            { value: 'list', label: '列表' },
            { value: 'board', label: '看板' },
            { value: 'week', label: '本周' },
            { value: 'matrix', label: '四象限' }
          ]}
        />
        <div className="relative no-drag">
          <button onClick={() => setCfgOpen(o => !o)} className="h-8 px-2.5 rounded-[var(--r-sm)] text-xs hover:bg-[var(--hover)]" style={{ color: 'var(--muted)' }} title="工作时段：排布只会把待办放进这些时间">
            {String(cfg.dayStart).padStart(2, '0')}:00–{String(cfg.dayEnd).padStart(2, '0')}:00
          </button>
          {cfgOpen && (
            <ScheduleSettings
              cfg={cfg}
              onChange={next => {
                setCfg(next)
                saveScheduleConfig(next)
              }}
            />
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

      <div className="shrink-0 px-6 pt-3 pb-2 flex flex-col gap-2">
        <label className="h-10 px-3 flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border)] focus-within:border-[var(--border-strong)]" style={{ background: 'var(--surface-strong)' }}>
          <IconPlus width={14} height={14} style={{ color: 'var(--faint)' }} />
          <input
            ref={quickRef}
            value={quick}
            onChange={e => setQuick(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void addQuick()}
            placeholder="添加待办（N）：明天下午3点 给王小明回电话 30分钟 ! #Q4推广 @电话 +客户 每周"
            className="flex-1 bg-transparent outline-none text-sm"
            style={{ color: 'var(--fg)' }}
          />
          <kbd className="text-2xs shrink-0" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>⌥⌘T 随时记</kbd>
        </label>
        <FilterBar filters={filters} setFilters={setFilters} projects={projects} contexts={usedContexts} tags={tags} />
      </div>

      <div className="flex-1 min-h-0 flex">
        {view === 'list' && (
          <>
            <div className="relative flex-1 min-w-0 overflow-y-auto px-6 pb-10">
              {phase === 'analyze' && <div className="todo-scan" aria-hidden="true" />}
              {inbox.length > 0 && (
                <section className="mt-2">
                  <h2 className="text-xs font-semibold py-1.5 flex items-center gap-2" style={{ color: 'var(--fg)' }}>
                    收集箱 <span className="tnum" style={{ fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>{inbox.length}</span>
                    <span className="font-normal" style={{ color: 'var(--faint)' }}>给每条定个时间或项目，它就会进入排布</span>
                    <span className="flex-1" />
                    <button
                      onClick={async () => {
                        for (const p of inbox) await api.updateTodo(p.id, { data: { inbox: false } })
                        await reload()
                        relayout(manual)
                      }}
                      className="font-normal underline underline-offset-2"
                      style={{ color: 'var(--muted)' }}
                    >
                      全部移出收集箱
                    </button>
                  </h2>
                  <div className="flex flex-col gap-1.5">
                    {inbox.map(p => (
                      <TodoRow
                        key={p.id}
                        p={p}
                        now={now}
                        phase={phase}
                        delta={deltas[p.id]}
                        editing={editing === p.id}
                        projects={projects}
                        triage
                        onTriage={patch => void update(p.id, { ...patch, data: { ...(patch.data ?? {}), inbox: false } })}
                        onEdit={() => setEditing(e => (e === p.id ? null : p.id))}
                        onDone={() => void complete(p.todo)}
                        onUpdate={patch => update(p.id, patch)}
                        setRef={el => (el ? rowRefs.current.set(p.id, el) : rowRefs.current.delete(p.id))}
                      />
                    ))}
                  </div>
                </section>
              )}
              {!plan.items.length && (
                <div className="mt-16 text-center text-sm leading-relaxed" style={{ color: 'var(--faint)' }}>
                  还没有待办。
                  <br />
                  邮件里的截止事项、会议邀请、需要回复的重要邮件会自动收进来；也可以在上面写一句话添加。
                </div>
              )}
              {BUCKET_ORDER.map(b => {
                const items = organized.filter(i => i.bucket === b)
                if (!items.length) return null
                return (
                  <section key={b} className="mt-3">
                    <h2 className="text-xs font-semibold py-1.5 flex items-center gap-2" style={{ color: b === 'overdue' ? 'var(--danger-ink)' : 'var(--faint)' }}>
                      {BUCKET_LABEL[b]}
                      <span className="tnum" style={{ fontFamily: 'var(--font-mono)' }}>{items.length}</span>
                    </h2>
                    <DragList
                      items={items}
                      onReorder={(dragId, targetId) => {
                        const ids = plan.items.map(i => i.id).filter(id => id !== dragId)
                        ids.splice(ids.indexOf(targetId), 0, dragId)
                        relayout(ids)
                        showToast('已按你的顺序排；点「自动排序」恢复科学排布')
                      }}
                      render={p => (
                        <TodoRow
                          key={p.id}
                          p={p}
                          now={now}
                          phase={phase}
                          delta={deltas[p.id]}
                          editing={editing === p.id}
                          projects={projects}
                          onEdit={() => setEditing(e => (e === p.id ? null : p.id))}
                          onDone={() => void complete(p.todo)}
                          onUpdate={patch => update(p.id, patch)}
                          setRef={el => (el ? rowRefs.current.set(p.id, el) : rowRefs.current.delete(p.id))}
                        />
                      )}
                    />
                  </section>
                )
              })}
              {done.length > 0 && (
                <section className="mt-6">
                  <h2 className="text-xs font-semibold py-1.5" style={{ color: 'var(--faint)' }}>已完成</h2>
                  {done.map(t => (
                    <div key={t.id} className="h-8 flex items-center gap-2.5 px-3 text-sm" style={{ color: 'var(--faint)' }}>
                      <button
                        onClick={() => void update(t.id, { status: 'open' })}
                        aria-label="标为未完成"
                        className="w-4 h-4 rounded-full inline-flex items-center justify-center"
                        style={{ background: 'var(--muted)', color: 'var(--surface-strong)' }}
                      >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
                      </button>
                      <span className="line-through truncate">{t.title}</span>
                      {dataOf(t).doneBy === 'reply' && <span className="text-2xs shrink-0">回信后自动完成</span>}
                    </div>
                  ))}
                </section>
              )}
            </div>
            <Timeline items={todayItems} now={now} version={version} />
          </>
        )}
        {view === 'board' && <BoardView items={visible} now={now} projects={projects} onUpdate={update} onDone={t => void complete(t)} onOpen={id => { setView('list'); setEditing(id) }} />}
        {view === 'week' && <WeekView items={visible} now={now} onUpdate={update} onOpen={id => { setView('list'); setEditing(id) }} />}
        {view === 'matrix' && <MatrixView items={visible} now={now} onUpdate={update} onOpen={id => { setView('list'); setEditing(id) }} />}
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[560px] px-4 py-2.5 rounded-[var(--r-md)] text-sm pop-in" style={{ background: 'var(--rail-bg)', color: 'var(--rail-fg)', boxShadow: 'var(--shadow-float)' }}>
          {toast}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 通用小件

function Seg<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div className="no-drag inline-flex p-0.5 rounded-[var(--r-sm)]" style={{ background: 'var(--hover)' }} role="tablist">
      {props.options.map(o => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === props.value}
          onClick={() => props.onChange(o.value)}
          className="h-7 px-2.5 rounded-[var(--r-xs)] text-xs"
          style={o.value === props.value ? { background: 'var(--surface-strong)', color: 'var(--fg)', fontWeight: 600, boxShadow: 'var(--shadow-sm)' } : { color: 'var(--muted)' }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Chip(props: { children: React.ReactNode; tone?: 'danger' | 'warn' | 'strong' | 'ai'; title?: string }) {
  const style =
    props.tone === 'danger'
      ? { background: 'var(--danger-soft)', color: 'var(--danger-ink)' }
      : props.tone === 'warn'
        ? { background: 'var(--warn-soft)', color: 'var(--warn-ink)' }
        : props.tone === 'strong'
          ? { background: 'var(--fg)', color: 'var(--surface-strong)' }
          : props.tone === 'ai'
            ? { background: 'var(--ai-soft)', color: 'var(--fg)' }
            : { background: 'var(--hover)', color: 'var(--muted)' }
  return (
    <span title={props.title} className="px-1.5 h-5 inline-flex items-center gap-1 rounded-[var(--r-xs)] whitespace-nowrap" style={style}>
      {props.children}
    </span>
  )
}

function FilterBar(props: { filters: Filters; setFilters(f: Filters): void; projects: string[]; contexts: string[]; tags: string[] }) {
  const { filters: f, setFilters } = props
  const any = f.project || f.context || f.tag || f.energy
  const chip = (on: boolean, label: string, onClick: () => void) => (
    <button
      key={label}
      onClick={onClick}
      className="text-xs h-6 px-2 rounded-full border whitespace-nowrap"
      style={on ? { background: 'var(--fg)', color: 'var(--surface-strong)', borderColor: 'var(--fg)' } : { borderColor: 'var(--border)', color: 'var(--muted)' }}
    >
      {label}
    </button>
  )
  if (!props.projects.length && !props.contexts.length && !props.tags.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {props.projects.map(p => chip(f.project === p, `# ${p}`, () => setFilters({ ...f, project: f.project === p ? '' : p })))}
      {props.contexts.map(c => chip(f.context === c, c, () => setFilters({ ...f, context: f.context === c ? '' : c })))}
      {props.tags.map(t => chip(f.tag === t, `+${t}`, () => setFilters({ ...f, tag: f.tag === t ? '' : t })))}
      {(['low', 'high'] as const).map(e => chip(f.energy === e, e === 'low' ? '低精力' : '高精力', () => setFilters({ ...f, energy: f.energy === e ? '' : e })))}
      {any && (
        <button onClick={() => setFilters({ project: '', context: '', tag: '', energy: '' })} className="text-xs underline underline-offset-2 ml-1" style={{ color: 'var(--faint)' }}>
          清除筛选
        </button>
      )}
    </div>
  )
}

function ScheduleSettings(props: { cfg: ScheduleConfig; onChange(c: ScheduleConfig): void }) {
  const { cfg } = props
  return (
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
            onChange={e => props.onChange({ ...cfg, [key]: Number(e.target.value) })}
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
        <input type="checkbox" checked={!!cfg.lunch} onChange={e => props.onChange({ ...cfg, lunch: e.target.checked ? [12, 13] : null })} />
      </label>
      <label className="flex items-center justify-between">
        周末也排
        <input type="checkbox" checked={cfg.workdays.includes(0)} onChange={e => props.onChange({ ...cfg, workdays: e.target.checked ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5] })} />
      </label>
    </div>
  )
}

/** 列表内拖动排序 */
function DragList(props: { items: Planned[]; onReorder(dragId: string, targetId: string): void; render(p: Planned): React.ReactNode }) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-1.5">
      {props.items.map(p => (
        <div
          key={p.id}
          draggable
          onDragStart={() => setDragId(p.id)}
          onDragOver={e => {
            e.preventDefault()
            setOver(p.id)
          }}
          onDragLeave={() => setOver(null)}
          onDrop={() => {
            setOver(null)
            if (dragId && dragId !== p.id) props.onReorder(dragId, p.id)
            setDragId(null)
          }}
          style={{ outline: over === p.id && dragId !== p.id ? '1px solid var(--fg)' : undefined, borderRadius: 'var(--r-md)' }}
        >
          {props.render(p)}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- 列表行

function TodoRow(props: {
  p: Planned
  now: number
  phase: Phase
  delta?: number
  editing: boolean
  projects: string[]
  triage?: boolean
  onTriage?(patch: Parameters<typeof api.updateTodo>[1]): void
  onEdit(): void
  onDone(): void
  onUpdate(patch: Parameters<typeof api.updateTodo>[1]): Promise<void>
  setRef(el: HTMLElement | null): void
}) {
  const { p, phase, now } = props
  const t = p.todo
  const d = dataOf(t)
  const prio = d.priority ?? 2
  const moved = phase === 'settle' && props.delta
  const checklist = d.checklist ?? []
  const doneCount = checklist.filter(c => c.done).length
  return (
    <div
      ref={props.setRef}
      className={`relative rounded-[var(--r-md)] border ${moved && props.delta! > 0 ? 'todo-rise' : ''}`}
      style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)' }}
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
            {p.start && !props.triage && (
              <span className="text-xs shrink-0 tnum" style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                {p.bucket === 'today' || p.bucket === 'overdue' ? fmtClock(p.start) : fmtDue(p.start, now)}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs">
            <Chip>{p.minutes} 分钟</Chip>
            {t.dueAt && <Chip tone={t.dueAt < now ? 'danger' : p.atRisk ? 'warn' : undefined}>截止 {fmtDue(t.dueAt, now)}</Chip>}
            {prio === 1 && <Chip tone="strong">高优先</Chip>}
            {d.project && <Chip># {d.project}</Chip>}
            {d.context && <Chip>{d.context}</Chip>}
            {(d.tags ?? []).map(tag => <Chip key={tag}>+{tag}</Chip>)}
            {d.energy && <Chip>{d.energy === 'low' ? '低精力' : d.energy === 'high' ? '高精力' : '中等精力'}</Chip>}
            {d.repeat && <Chip title="完成后自动生成下一次">↻ {REPEAT_LABEL[d.repeat.freq]}</Chip>}
            {checklist.length > 0 && <Chip>☐ {doneCount}/{checklist.length}</Chip>}
            {d.todoKind === 'reply' && <Chip>回信后自动完成</Chip>}
            {Object.keys(d.external ?? {}).length > 0 && <Chip title={`已同步：${Object.keys(d.external ?? {}).join('、')}`}>⇄ 已同步</Chip>}
            {t.messageId && (
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
            {!props.triage && (
              <span className="ml-0.5" style={{ color: 'var(--faint)' }}>
                {moved || phase === 'analyze' ? <mark className="hl">{p.reason}</mark> : p.reason}
              </span>
            )}
          </div>
          {d.meeting && <MeetingBar todo={t} now={now} />}
          {phase === 'analyze' && <ScoreBars f={p.factors} />}
          {props.triage && props.onTriage && <TriageBar now={now} projects={props.projects} onTriage={props.onTriage} />}
        </div>
        {moved ? (
          <span className="absolute -right-2 -top-2 text-2xs font-bold px-1.5 h-5 inline-flex items-center rounded-full pop-in" style={props.delta! > 0 ? { background: 'var(--ai)', color: 'var(--ai-ink)' } : { background: 'var(--hover-strong)', color: 'var(--muted)' }}>
            {props.delta! > 0 ? `↑${props.delta}` : `↓${-props.delta!}`}
          </span>
        ) : null}
      </div>
      {props.editing && <TodoEditor todo={t} projects={props.projects} onUpdate={props.onUpdate} onClose={props.onEdit} />}
    </div>
  )
}

/** 收集箱整理：一键定时间 / 定项目 */
function TriageBar(props: { now: number; projects: string[]; onTriage(patch: Parameters<typeof api.updateTodo>[1]): void }) {
  const friday = (() => {
    const d = new Date(props.now)
    const diff = (5 - d.getDay() + 7) % 7 || 7
    return endOfDay(props.now, diff)
  })()
  const btn = (label: string, patch: Parameters<typeof api.updateTodo>[1]) => (
    <button
      key={label}
      onClick={e => {
        e.stopPropagation()
        props.onTriage(patch)
      }}
      className="text-2xs h-6 px-2 rounded-[var(--r-xs)] border border-[var(--border)] hover:bg-[var(--hover)]"
      style={{ color: 'var(--fg)' }}
    >
      {label}
    </button>
  )
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" onClick={e => e.stopPropagation()}>
      {btn('今天', { dueAt: endOfDay(props.now) })}
      {btn('明天', { dueAt: endOfDay(props.now, 1) })}
      {btn('本周', { dueAt: friday })}
      {btn('以后再说', { data: { priority: 3 } })}
      {props.projects.length > 0 && (
        <select
          defaultValue=""
          onChange={e => e.target.value && props.onTriage({ data: { project: e.target.value } })}
          className="text-2xs h-6 px-1 rounded-[var(--r-xs)] border border-[var(--border)]"
          style={{ background: 'var(--surface-strong)', color: 'var(--fg)' }}
        >
          <option value="">放进项目…</option>
          {props.projects.map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      )}
      {btn('删除', { status: 'dismissed' })}
    </div>
  )
}

/** 会议：开会前后给出入会 / 会前准备 / 会后跟进 */
function MeetingBar(props: { todo: InsightRecord; now: number }) {
  const m = dataOf(props.todo).meeting!
  const end = m.endsAt ?? m.startsAt + minutesOf(props.todo) * 60_000
  const soon = props.now >= m.startsAt - 15 * 60_000 && props.now <= end
  const after = props.now > end
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs" onClick={e => e.stopPropagation()}>
      <Chip>{MEETING_LABEL[m.provider] ?? '会议'} · {fmtDue(m.startsAt, props.now)}{m.code ? ` · ${m.code}` : ''}</Chip>
      {m.url && (
        <button
          onClick={() => void api.openExternal(m.url)}
          className="h-6 px-2.5 rounded-[var(--r-xs)] font-semibold"
          style={soon ? { background: 'var(--fg)', color: 'var(--surface-strong)' } : { border: '1px solid var(--border)', color: 'var(--fg)' }}
        >
          {soon ? '立即入会' : '入会链接'}
        </button>
      )}
      {!after && (
        <button
          onClick={() => askAgent(`帮我准备会议「${props.todo.title}」：把相关邮件里的背景、我答应过的事、需要会上确认的问题整理成一页会前简报。`)}
          className="h-6 px-2.5 rounded-[var(--r-xs)] ai-chip font-semibold"
        >
          会前准备
        </button>
      )}
      {after && (
        <button
          onClick={() => askAgent(`会议「${props.todo.title}」刚结束。根据相关邮件，帮我列出会后要跟进的事项（建成待办），并起草一封发给与会者的会后跟进邮件。`)}
          className="h-6 px-2.5 rounded-[var(--r-xs)] ai-chip font-semibold"
        >
          会后跟进
        </button>
      )}
    </div>
  )
}

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

// ---------------------------------------------------------------- 编辑器（全部维度）

const toLocalInput = (ts: number | null | undefined) => {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function TodoEditor(props: { todo: InsightRecord; projects: string[]; onUpdate(patch: Parameters<typeof api.updateTodo>[1]): Promise<void>; onClose(): void }) {
  const t = props.todo
  const d = dataOf(t)
  const [title, setTitle] = useState(t.title)
  const [notes, setNotes] = useState(d.notes ?? '')
  const [project, setProject] = useState(d.project ?? '')
  const [tagText, setTagText] = useState((d.tags ?? []).join(' '))
  const [newItem, setNewItem] = useState('')
  const checklist = d.checklist ?? []
  const save = (patch: Parameters<typeof api.updateTodo>[1]) => props.onUpdate(patch)
  const saveChecklist = (list: TodoChecklistItem[]) => save({ data: { checklist: list } })
  const field = 'h-7 px-1.5 rounded-[var(--r-xs)] border border-[var(--border)] text-xs'
  const fieldStyle = { background: 'var(--surface-strong)', color: 'var(--fg)' }
  const label = 'flex items-center gap-1.5 text-xs'

  return (
    <div className="px-3.5 pb-3.5 pt-1 flex flex-col gap-3 border-t border-[var(--border-soft)] fade-in" onClick={e => e.stopPropagation()}>
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== t.title && void save({ title: title.trim() })}
        className="mt-2 h-8 px-2.5 rounded-[var(--r-sm)] border border-[var(--border)] text-sm outline-none"
        style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2" style={{ color: 'var(--muted)' }}>
        <label className={label}>
          截止
          <input type="datetime-local" defaultValue={toLocalInput(t.dueAt)} onChange={e => void save({ dueAt: e.target.value ? new Date(e.target.value).getTime() : null })} className={field} style={fieldStyle} />
        </label>
        <label className={label}>
          时长
          <select defaultValue={d.minutes ?? 25} onChange={e => void save({ data: { minutes: Number(e.target.value) } })} className={field} style={fieldStyle}>
            {[5, 10, 15, 25, 30, 45, 60, 90, 120, 180, 240].map(m => (
              <option key={m} value={m}>{m} 分钟</option>
            ))}
          </select>
        </label>
        <span className={label}>
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
        <label className={label}>
          <input type="checkbox" defaultChecked={!!d.fixedAt} disabled={!t.dueAt} onChange={e => void save({ data: { fixedAt: e.target.checked ? t.dueAt : null } })} />
          固定在截止时间
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2" style={{ color: 'var(--muted)' }}>
        <label className={label}>
          项目
          <input list="todo-projects" value={project} onChange={e => setProject(e.target.value)} onBlur={() => project !== (d.project ?? '') && void save({ data: { project: project.trim() || undefined } })} placeholder="无" className={`${field} w-[120px]`} style={fieldStyle} />
          <datalist id="todo-projects">
            {props.projects.map(p => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        <label className={label}>
          情境
          <select defaultValue={d.context ?? ''} onChange={e => void save({ data: { context: e.target.value || undefined } })} className={field} style={fieldStyle}>
            <option value="">无</option>
            {CONTEXTS.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className={label}>
          精力
          <select defaultValue={d.energy ?? ''} onChange={e => void save({ data: { energy: (e.target.value || undefined) as TodoData['energy'] } })} className={field} style={fieldStyle}>
            <option value="">未设</option>
            <option value="low">低（碎片时间可做）</option>
            <option value="mid">中</option>
            <option value="high">高（需要专注）</option>
          </select>
        </label>
        <label className={label}>
          重复
          <select
            defaultValue={d.repeat?.freq ?? ''}
            onChange={e => void save({ data: { repeat: e.target.value ? { freq: e.target.value as NonNullable<TodoData['repeat']>['freq'] } : null } })}
            className={field}
            style={fieldStyle}
          >
            <option value="">不重复</option>
            {Object.entries(REPEAT_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
        <label className={label}>
          标签
          <input
            value={tagText}
            onChange={e => setTagText(e.target.value)}
            onBlur={() => void save({ data: { tags: tagText.split(/[\s,，]+/).map(x => x.replace(/^\+/, '')).filter(Boolean) } })}
            placeholder="空格分隔"
            className={`${field} w-[140px]`}
            style={fieldStyle}
          />
        </label>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs" style={{ color: 'var(--muted)' }}>子任务</span>
        {checklist.map(c => (
          <label key={c.id} className="flex items-center gap-2 text-sm" style={{ color: c.done ? 'var(--faint)' : 'var(--fg)' }}>
            <input type="checkbox" checked={c.done} onChange={() => void saveChecklist(checklist.map(x => (x.id === c.id ? { ...x, done: !x.done } : x)))} />
            <span className={c.done ? 'line-through' : ''}>{c.text}</span>
            <button onClick={() => void saveChecklist(checklist.filter(x => x.id !== c.id))} aria-label="删除子任务" className="ml-auto" style={{ color: 'var(--faint)' }}>
              <IconClose width={10} height={10} />
            </button>
          </label>
        ))}
        <input
          value={newItem}
          onChange={e => setNewItem(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && newItem.trim()) {
              void saveChecklist([...checklist, { id: Math.random().toString(36).slice(2, 9), text: newItem.trim(), done: false }])
              setNewItem('')
            }
          }}
          placeholder="+ 添加子任务，回车确认"
          className="h-7 px-2 rounded-[var(--r-xs)] border border-dashed border-[var(--border)] text-xs outline-none"
          style={{ background: 'transparent', color: 'var(--fg)' }}
        />
      </div>

      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        onBlur={() => notes !== (d.notes ?? '') && void save({ data: { notes } })}
        rows={2}
        placeholder="备注"
        className="px-2.5 py-2 rounded-[var(--r-sm)] border border-[var(--border)] text-sm outline-none resize-y"
        style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
      />

      <div className="flex items-center gap-2">
        <span className="text-2xs" style={{ color: 'var(--faint)' }}>
          来源：{d.from === 'mail' ? '邮件' : d.from === 'meeting' ? '会议邀请' : d.from === 'manual' ? '手动添加' : d.from ?? '—'}
          {d.updatedAt ? ` · 更新于 ${new Date(d.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
        <div className="flex-1" />
        <button
          onClick={async () => {
            await save({ status: 'dismissed' })
            props.onClose()
          }}
          className="inline-flex items-center gap-1 h-7 px-2 rounded-[var(--r-xs)] text-xs hover:bg-[var(--danger-soft)]"
          style={{ color: 'var(--danger-ink)' }}
        >
          <IconClose width={11} height={11} /> 删除
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 看板

/** 卡片（看板 / 本周 / 四象限共用）：可拖动 */
function Card(props: { p: Planned; now: number; onOpen(): void; onDone?(): void }) {
  const t = props.p.todo
  const d = dataOf(t)
  return (
    <div
      draggable
      onDragStart={e => e.dataTransfer.setData('text/todo-id', t.id)}
      onClick={props.onOpen}
      className="rounded-[var(--r-sm)] border border-[var(--border)] px-2.5 py-2 cursor-grab active:cursor-grabbing hover:border-[var(--border-strong)]"
      style={{ background: 'var(--surface-strong)', borderLeft: d.meeting ? '3px solid var(--fg)' : (d.priority ?? 2) === 1 ? '3px solid var(--ai-line)' : undefined }}
    >
      <div className="flex items-start gap-2">
        {props.onDone && (
          <button
            onClick={e => {
              e.stopPropagation()
              props.onDone!()
            }}
            aria-label={`完成：${t.title}`}
            className="mt-0.5 w-3.5 h-3.5 shrink-0 rounded-full border-[1.5px]"
            style={{ borderColor: 'var(--border-strong)' }}
          />
        )}
        <span className="text-xs leading-snug flex-1" style={{ color: 'var(--fg)' }}>{t.title}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1 text-2xs">
        {props.p.start && <Chip>{fmtDue(props.p.start, props.now)}</Chip>}
        <Chip>{props.p.minutes} 分</Chip>
        {d.project && <Chip># {d.project}</Chip>}
        {d.context && <Chip>{d.context}</Chip>}
      </div>
    </div>
  )
}

function DropColumn(props: { title: string; count: number; hint?: string; onDrop(id: string): void; children: React.ReactNode }) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={e => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        setOver(false)
        const id = e.dataTransfer.getData('text/todo-id')
        if (id) props.onDrop(id)
      }}
      className="w-[240px] shrink-0 flex flex-col rounded-[var(--r-md)] p-2 transition-colors"
      style={{ background: over ? 'var(--ai-soft)' : 'var(--bg-soft)' }}
    >
      <div className="px-1 pb-2 flex items-baseline gap-1.5">
        <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>{props.title}</span>
        <span className="text-2xs tnum" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{props.count}</span>
        {props.hint && <span className="text-2xs ml-auto" style={{ color: 'var(--faint)' }}>{props.hint}</span>}
      </div>
      <div className="flex flex-col gap-1.5 overflow-y-auto">{props.children}</div>
    </div>
  )
}

function BoardView(props: {
  items: Planned[]
  now: number
  projects: string[]
  onUpdate(id: string, patch: Parameters<typeof api.updateTodo>[1]): Promise<void>
  onDone(t: InsightRecord): void
  onOpen(id: string): void
}) {
  const [by, setBy] = useState<'status' | 'project'>(() => readJson('ms_todo_board_by', 'status'))
  const weekEnd = endOfDay(props.now, 7)
  const columns =
    by === 'status'
      ? [
          { key: 'inbox', title: '收集箱', items: props.items.filter(p => inInbox(p.todo)), drop: { data: { inbox: true } } },
          { key: 'today', title: '今天', items: props.items.filter(p => !inInbox(p.todo) && (p.bucket === 'today' || p.bucket === 'overdue')), drop: { dueAt: endOfDay(props.now), data: { inbox: false } } },
          { key: 'week', title: '本周', items: props.items.filter(p => !inInbox(p.todo) && (p.bucket === 'tomorrow' || (p.bucket === 'later' && (p.start ?? 0) < weekEnd))), drop: { dueAt: endOfDay(props.now, 3), data: { inbox: false } } },
          { key: 'later', title: '以后', items: props.items.filter(p => !inInbox(p.todo) && (p.bucket === 'someday' || (p.bucket === 'later' && (p.start ?? 0) >= weekEnd))), drop: { dueAt: null, data: { inbox: false, priority: 3 } } }
        ]
      : [
          { key: '', title: '未分项目', items: props.items.filter(p => !dataOf(p.todo).project), drop: { data: { project: undefined, inbox: false } } },
          ...props.projects.map(pr => ({ key: pr, title: `# ${pr}`, items: props.items.filter(p => dataOf(p.todo).project === pr), drop: { data: { project: pr, inbox: false } } }))
        ]
  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="px-6 pb-2 flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
        分栏
        <Seg
          value={by}
          onChange={v => {
            setBy(v)
            writeJson('ms_todo_board_by', v)
          }}
          options={[
            { value: 'status', label: '按时间' },
            { value: 'project', label: '按项目' }
          ]}
        />
        <span style={{ color: 'var(--faint)' }}>拖动卡片到另一栏即可改时间 / 改项目</span>
      </div>
      <div className="flex-1 min-h-0 overflow-x-auto px-6 pb-6 flex gap-3">
        {columns.map(c => (
          <DropColumn key={c.key || 'none'} title={c.title} count={c.items.length} onDrop={id => void props.onUpdate(id, c.drop as Parameters<typeof api.updateTodo>[1])}>
            {c.items.map(p => (
              <Card key={p.id} p={p} now={props.now} onOpen={() => props.onOpen(p.id)} onDone={() => props.onDone(p.todo)} />
            ))}
          </DropColumn>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 本周

function WeekView(props: { items: Planned[]; now: number; onUpdate(id: string, patch: Parameters<typeof api.updateTodo>[1]): Promise<void>; onOpen(id: string): void }) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(props.now)
    d.setDate(d.getDate() + i)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  })
  const [busy, setBusy] = useState<{ start: number; end: number; title: string }[]>([])
  useEffect(() => {
    // 系统日历的忙碌时段（打通日历后可用；未接入时为空）
    const fn = (api as unknown as { calendarBusyBlocks?: (from: number, to: number) => Promise<{ start: number; end: number; title: string }[]> }).calendarBusyBlocks
    if (fn) void fn(days[0], days[6] + 864e5).then(setBusy).catch(() => {})
  }, [days[0]])
  const WD = '日一二三四五六'
  return (
    <div className="flex-1 min-w-0 overflow-x-auto px-6 pb-6 flex gap-2.5">
      {days.map((day, i) => {
        const items = props.items.filter(p => p.start && p.start >= day && p.start < day + 864e5)
        const blocks = busy.filter(b => b.start >= day && b.start < day + 864e5)
        const mins = items.reduce((s, p) => s + p.minutes, 0)
        const d = new Date(day)
        return (
          <DropColumn
            key={day}
            title={`${i === 0 ? '今天' : i === 1 ? '明天' : `周${WD[d.getDay()]}`} ${d.getMonth() + 1}/${d.getDate()}`}
            count={items.length}
            hint={mins ? `${(mins / 60).toFixed(1)}h` : undefined}
            onDrop={id => {
              const t = items.find(p => p.id === id)?.todo ?? props.items.find(p => p.id === id)?.todo
              const fixed = t ? dataOf(t).fixedAt : null
              const patch: Parameters<typeof api.updateTodo>[1] = fixed
                ? { dueAt: day + (fixed - new Date(fixed).setHours(0, 0, 0, 0)), data: { fixedAt: day + (fixed - new Date(fixed).setHours(0, 0, 0, 0)), inbox: false } }
                : { dueAt: endOfDay(day), data: { inbox: false } }
              void props.onUpdate(id, patch)
            }}
          >
            {blocks.map((b, j) => (
              <div key={`b${j}`} className="rounded-[var(--r-sm)] px-2 py-1.5 text-2xs" style={{ background: 'var(--hover-strong)', color: 'var(--muted)' }} title="系统日历">
                {fmtClock(b.start)} {b.title}
              </div>
            ))}
            {items.map(p => (
              <Card key={p.id} p={p} now={props.now} onOpen={() => props.onOpen(p.id)} />
            ))}
          </DropColumn>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- 四象限

function MatrixView(props: { items: Planned[]; now: number; onUpdate(id: string, patch: Parameters<typeof api.updateTodo>[1]): Promise<void>; onOpen(id: string): void }) {
  const urgent = (p: Planned) => !!p.todo.dueAt && p.todo.dueAt - props.now < 48 * 3600_000
  const important = (p: Planned) => (dataOf(p.todo).priority ?? 2) === 1
  const quads: { key: string; title: string; hint: string; test(p: Planned): boolean; drop: Parameters<typeof api.updateTodo>[1] }[] = [
    { key: 'do', title: '重要且紧急', hint: '马上做', test: p => important(p) && urgent(p), drop: { data: { priority: 1 } } },
    { key: 'plan', title: '重要不紧急', hint: '排进日程', test: p => important(p) && !urgent(p), drop: { data: { priority: 1 } } },
    { key: 'delegate', title: '紧急不重要', hint: '快速处理或交给别人', test: p => !important(p) && urgent(p), drop: { data: { priority: 2 } } },
    { key: 'drop', title: '不重要不紧急', hint: '以后再说或删掉', test: p => !important(p) && !urgent(p), drop: { data: { priority: 3 } } }
  ]
  return (
    <div className="flex-1 min-w-0 overflow-y-auto px-6 pb-6">
      <div className="text-xs mb-2" style={{ color: 'var(--faint)' }}>紧急 = 48 小时内截止；重要 = 高优先。拖动卡片到别的象限会改优先级。</div>
      <div className="grid grid-cols-2 gap-3">
        {quads.map(q => {
          const items = props.items.filter(q.test)
          return (
            <MatrixCell key={q.key} title={q.title} hint={q.hint} count={items.length} tone={q.key === 'do'} onDrop={id => void props.onUpdate(id, q.drop)}>
              {items.map(p => (
                <Card key={p.id} p={p} now={props.now} onOpen={() => props.onOpen(p.id)} />
              ))}
            </MatrixCell>
          )
        })}
      </div>
    </div>
  )
}

function MatrixCell(props: { title: string; hint: string; count: number; tone: boolean; onDrop(id: string): void; children: React.ReactNode }) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={e => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        setOver(false)
        const id = e.dataTransfer.getData('text/todo-id')
        if (id) props.onDrop(id)
      }}
      className="min-h-[240px] rounded-[var(--r-md)] p-3 flex flex-col gap-1.5 border"
      style={{ background: over ? 'var(--ai-soft)' : props.tone ? 'var(--surface-strong)' : 'var(--bg-soft)', borderColor: props.tone ? 'var(--fg)' : 'var(--border)' }}
    >
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>{props.title}</span>
        <span className="text-2xs tnum" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{props.count}</span>
        <span className="text-2xs ml-auto" style={{ color: 'var(--faint)' }}>{props.hint}</span>
      </div>
      {props.children}
    </div>
  )
}

// ---------------------------------------------------------------- 今日时间轴

function Timeline(props: { items: Planned[]; now: number; version: number }) {
  const START = 8
  const END = 20
  const PX = 52
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
          const fixed = !!dataOf(p.todo).fixedAt
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
