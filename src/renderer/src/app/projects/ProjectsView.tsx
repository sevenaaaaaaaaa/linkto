import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../../lib/api'
import { goView } from '../../lib/route'
import { useMail } from '../../stores/mail'
import { Reader } from '../Reader'
import { MenuButton, type MenuItem } from '../../components/Menu'
import { IconChat, IconChevronRight, IconClose, IconLayers, IconMore, IconPin, IconPlus, IconRefresh, IconSearch, IconSparkles, IconAttach, IconTrash, IconArchive } from '../../components/icons'
import { AIErrorNote } from '../../components/AIErrorNote'
import {
  fmtAgo, hueColor, isLive, openContactTimeline, openProject, openProjects, projectColor, projectSoft, toast,
  useProjectEvents, useProjectRoute, useProjects, type ProjectTab
} from '../../lib/projects'
import {
  ATTACHMENT_KIND_LABEL, FINANCE_KIND_LABEL, FINANCE_STATUS_LABEL, PROJECT_COLORS, fmtBytes, fmtMoney, isPublicDomain, domainOf,
  type ContactTimeline, type ProjectCandidate, type ProjectDetail, type ProjectListItem, type TimelineEvent, type AttachmentKind
} from '@shared/projects'
import type { FinanceData, ProjectData, ProjectStatus, ProjectSummary } from '@shared/types'
import { Timeline, MiniSeg } from './Timeline'
import { IconTimeline } from './ProjectBits'

/**
 * 项目（一级入口）：
 * - 列表：状态、对方、最近动态、未读、待办、款项合计、截止；筛选与排序；「建议归入」队列
 * - 详情：时间线 / 邮件 / 概要 三个视图；点邮件在右侧就地打开阅读页
 * - 联系人时间线：与某人 / 某公司的全部往来（与项目时间线同一组件）
 */
export function ProjectsView() {
  useProjectEvents()
  const route = useProjectRoute()
  if (route.mode === 'contact') return <ContactView key={route.key} contactKey={route.key} />
  if (route.mode === 'project') return <DetailView key={route.id} id={route.id} tab={route.tab} />
  return <ListView />
}

const STATUS_LABEL: Record<ProjectStatus, string> = { active: '进行中', paused: '暂停', done: '已完成', archived: '已归档' }

function StatusChip(props: { status: ProjectStatus }) {
  if (props.status === 'active') return null
  const style =
    props.status === 'paused'
      ? { background: 'var(--warn-soft)', color: 'var(--warn-ink)' }
      : props.status === 'done'
        ? { background: 'var(--ok-soft)', color: 'var(--ok-ink)' }
        : { background: 'var(--hover)', color: 'var(--faint)' }
  return (
    <span className="text-2xs px-1.5 h-[18px] inline-flex items-center rounded-[var(--r-xs)] shrink-0" style={style}>
      {STATUS_LABEL[props.status]}
    </span>
  )
}

function Dot(props: { p: { id: string; data: { color?: string | null } }; size?: number }) {
  const s = props.size ?? 8
  return <span className="rounded-full shrink-0 inline-block" style={{ width: s, height: s, background: projectColor(props.p) }} />
}

function moneyText(stats: ProjectListItem['stats']): string | null {
  if (!stats.finance?.totals.length) return null
  return stats.finance.totals
    .map(t => {
      const total = t.in + t.out
      return fmtMoney(total, t.currency)
    })
    .join(' + ')
}

function fmtMD(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function dueText(due: number | null | undefined): { text: string; late: boolean } | null {
  if (!due) return null
  const d = new Date(due)
  const late = due < Date.now()
  return { text: `${d.getMonth() + 1}/${d.getDate()}`, late }
}

const btnPrimary = 'no-drag h-8 px-3 rounded-[var(--r-sm)] text-xs font-semibold inline-flex items-center gap-1.5 transition-transform active:scale-[.98]'
const btnGhost = 'no-drag h-8 px-3 rounded-[var(--r-sm)] text-xs font-medium inline-flex items-center gap-1.5 border border-[var(--border)] hover:bg-[var(--hover)]'

// =====================================================================
// 列表
// =====================================================================

type StatusFilter = 'live' | 'done' | 'archived' | 'all'
type SortKey = 'recent' | 'due' | 'unread' | 'name'

function ListView() {
  const items = useProjects(st => st.items)
  const loaded = useProjects(st => st.loaded)
  const [filter, setFilter] = useState<StatusFilter>(() => (localStorage.getItem('ms_proj_filter') as StatusFilter) || 'live')
  const [sort, setSort] = useState<SortKey>(() => (localStorage.getItem('ms_proj_sort') as SortKey) || 'recent')
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<ProjectListItem | 'new' | null>(null)
  const [discover, setDiscover] = useState(false)

  useEffect(() => {
    const onNew = () => setEditing('new')
    const onDiscover = () => setDiscover(true)
    window.addEventListener('ms:project-new', onNew)
    window.addEventListener('ms:project-discover', onDiscover)
    return () => {
      window.removeEventListener('ms:project-new', onNew)
      window.removeEventListener('ms:project-discover', onDiscover)
    }
  }, [])

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = items.filter(p =>
      filter === 'all' ? true : filter === 'live' ? isLive(p) : p.data.status === filter
    ).filter(p => !s || p.data.name.toLowerCase().includes(s) || p.data.counterparties.some(c => c.includes(s)) || p.data.keywords.some(k => k.toLowerCase().includes(s)))
    const by: Record<SortKey, (a: ProjectListItem, b: ProjectListItem) => number> = {
      recent: (a, b) => (b.stats.lastAt ?? b.createdAt) - (a.stats.lastAt ?? a.createdAt),
      due: (a, b) => (a.data.dueAt ?? Infinity) - (b.data.dueAt ?? Infinity),
      unread: (a, b) => b.stats.unread - a.stats.unread || (b.stats.lastAt ?? 0) - (a.stats.lastAt ?? 0),
      name: (a, b) => a.data.name.localeCompare(b.data.name, 'zh-CN')
    }
    return list.sort(by[sort])
  }, [items, filter, sort, q])

  const live = items.filter(isLive)
  const suggestions = live.flatMap(p => (p.data.suggestions ?? []).map(s => ({ p, s }))).sort((a, b) => b.s.at - a.s.at)
  const showMoney = visible.some(p => !!p.stats.finance?.totals.length)
  const cols = `minmax(0,1fr) 76px 44px 44px${showMoney ? ' 112px' : ''} 56px`

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <header className="drag-region shrink-0 px-6 pt-4 pb-3 flex flex-wrap items-end gap-3 border-b border-[var(--border)]">
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--fg)', letterSpacing: '-0.01em' }}>项目</h1>
          <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            {live.length} 个进行中
            {suggestions.length > 0 && <span> · {suggestions.length} 封邮件等你确认归入</span>}
          </div>
        </div>
        {items.length > 0 && (
          <>
            <label className="no-drag h-8 w-[180px] px-2.5 flex items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border)] focus-within:border-[var(--border-strong)]" style={{ background: 'var(--surface-strong)' }}>
              <IconSearch width={13} height={13} style={{ color: 'var(--faint)' }} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="筛选项目、对方、关键词" className="flex-1 min-w-0 bg-transparent outline-none text-xs" style={{ color: 'var(--fg)' }} />
            </label>
            <MiniSeg
              value={filter}
              onChange={v => {
                setFilter(v)
                localStorage.setItem('ms_proj_filter', v)
              }}
              options={[
                { value: 'live', label: '进行中' },
                { value: 'done', label: '已完成' },
                { value: 'archived', label: '已归档' },
                { value: 'all', label: '全部' }
              ]}
            />
            <MenuButton
              title="排序"
              width={150}
              className={`${btnGhost} h-8`}
              items={(
                [
                  ['recent', '最近动态'],
                  ['due', '截止日'],
                  ['unread', '未读多的'],
                  ['name', '名称']
                ] as [SortKey, string][]
              ).map(([k, label]) => ({
                kind: 'check' as const,
                label,
                checked: sort === k,
                onSelect: () => {
                  setSort(k)
                  localStorage.setItem('ms_proj_sort', k)
                }
              }))}
            >
              <span style={{ color: 'var(--fg)' }}>排序：{({ recent: '最近动态', due: '截止日', unread: '未读', name: '名称' } as const)[sort]}</span>
            </MenuButton>
          </>
        )}
        <button onClick={() => setDiscover(true)} className={btnGhost} style={{ color: 'var(--fg)', background: 'var(--surface-strong)' }} title="读最近的企业往来，聚出可能是同一件事的邮件">
          <IconSparkles width={13} height={13} /> 发现项目
        </button>
        <button onClick={() => setEditing('new')} className={btnPrimary} style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          <IconPlus width={13} height={13} /> 新建项目
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!loaded ? (
          <div className="px-6 py-6 space-y-3">
            {[80, 64, 72].map((w, i) => (
              <div key={i} className="h-12 rounded-[var(--r-md)] shimmer" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : !items.length ? (
          <EmptyState onDiscover={() => setDiscover(true)} onNew={() => setEditing('new')} />
        ) : (
          <div className="px-6 pb-10">
            {suggestions.length > 0 && filter !== 'archived' && filter !== 'done' && <SuggestionQueue rows={suggestions} />}
            <div className="mt-4 grid items-center gap-3 px-3 h-7 caps" style={{ gridTemplateColumns: cols, color: 'var(--faint)' }}>
              <span>项目 · 对方 · 最近动态</span>
              <span className="text-right">最近</span>
              <span className="text-right">未读</span>
              <span className="text-right">待办</span>
              {showMoney && <span className="text-right">款项</span>}
              <span className="text-right">截止</span>
            </div>
            <div className="rounded-[var(--r-md)] border border-[var(--border)] overflow-hidden" style={{ background: 'var(--surface-strong)' }}>
              {visible.map(p => {
                const due = dueText(p.data.dueAt)
                const money = moneyText(p.stats)
                return (
                  <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openProject(p.id)}
                    onKeyDown={e => e.key === 'Enter' && openProject(p.id)}
                    className="group grid items-center gap-3 px-3 py-2.5 border-b border-[var(--border-soft)] last:border-b-0 hover:bg-[var(--hover)] cursor-default"
                    style={{ gridTemplateColumns: cols }}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <Dot p={p} />
                        <span className="text-sm font-semibold truncate" style={{ color: 'var(--fg)' }}>{p.data.name}</span>
                        <StatusChip status={p.data.status} />
                        {p.data.pinned && <IconPin width={11} height={11} style={{ color: 'var(--faint)' }} />}
                        {!!p.data.suggestions?.length && (
                          <span className="text-2xs px-1.5 h-[18px] inline-flex items-center rounded-[var(--r-xs)] shrink-0" style={{ background: 'var(--selected)', color: 'var(--accent-ink)' }}>
                            {p.data.suggestions.length} 条建议
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 pl-4 text-xs truncate" style={{ color: 'var(--faint)' }}>
                        <span style={{ color: 'var(--muted)' }}>{p.data.counterparties.slice(0, 2).join('、') || '未设对方'}</span>
                        {p.stats.lastAt ? (
                          <>
                            {' · '}
                            {p.stats.lastFrom}：{p.stats.lastGist || p.stats.lastSubject}
                          </>
                        ) : (
                          ' · 还没有邮件'
                        )}
                      </div>
                    </div>
                    <span className="text-right text-xs tnum" style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{fmtAgo(p.stats.lastAt)}</span>
                    <span className="text-right text-xs tnum" style={{ color: p.stats.unread ? 'var(--fg)' : 'var(--faint)', fontWeight: p.stats.unread ? 600 : 400 }}>{p.stats.unread || '—'}</span>
                    <span className="text-right text-xs tnum" style={{ color: p.stats.openTodos ? 'var(--fg)' : 'var(--faint)' }}>{p.stats.openTodos || '—'}</span>
                    {showMoney && (
                      <span className="text-right text-xs tnum truncate" style={{ color: 'var(--fg)', fontFamily: 'var(--font-mono)' }} title={money ?? ''}>
                        {money ?? ''}
                      </span>
                    )}
                    <span className="text-right text-xs tnum" style={{ color: due?.late && isLive(p) ? 'var(--danger-ink)' : 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{due?.text ?? '—'}</span>
                  </div>
                )
              })}
              {!visible.length && <div className="px-4 py-8 text-center text-xs" style={{ color: 'var(--faint)' }}>没有符合条件的项目</div>}
            </div>
          </div>
        )}
      </div>

      {editing && <ProjectEditor project={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {discover && <DiscoverDialog onClose={() => setDiscover(false)} />}
    </div>
  )
}

function EmptyState(props: { onDiscover(): void; onNew(): void }) {
  return (
    <div className="max-w-[560px] mx-auto px-6 pt-[10vh] pb-10 fade-in">
      <div className="w-11 h-11 rounded-[var(--r-md)] inline-flex items-center justify-center" style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}>
        <IconLayers width={20} height={20} />
      </div>
      <h2 className="mt-4 text-xl font-semibold" style={{ color: 'var(--fg)', letterSpacing: '-0.01em' }}>把一件事的邮件收在一起</h2>
      <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
        一次采购、一个合作、一个外包——往往是十几封邮件，散在不同会话、不同账户里。项目把它们按对方、关键词和会话归到一处，
        用一条时间线看清从询价、报价、合同到交付、开票、付款走到了哪一步，卡在谁那里，下一步做什么。
      </p>
      <ul className="mt-4 space-y-1.5 text-xs" style={{ color: 'var(--faint)' }}>
        <li>· 新邮件按「同一会话 › 对方域名 › 主题关键词」自动归入，拿不准的先放进「建议归入」等你一键确认</li>
        <li>· 待办里的「项目」、财务里的款项会自动汇到项目里</li>
        <li>· 在任意邮件的 ⋯ 菜单里「建为项目」或「加入项目…」</li>
      </ul>
      <div className="mt-6 flex items-center gap-2">
        <button onClick={props.onDiscover} className={`${btnPrimary} h-9 px-4`} style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          <IconSparkles width={14} height={14} /> 从最近邮件发现项目
        </button>
        <button onClick={props.onNew} className={`${btnGhost} h-9 px-4`} style={{ color: 'var(--fg)' }}>
          <IconPlus width={14} height={14} /> 手动新建
        </button>
      </div>
    </div>
  )
}

/** 「建议归入」队列：拿不准的新邮件，一键确认或忽略 */
function SuggestionQueue(props: { rows: { p: ProjectListItem; s: NonNullable<ProjectData['suggestions']>[number] }[] }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="mt-4 rounded-[var(--r-md)] border border-[var(--border)]" style={{ background: 'var(--surface-strong)' }}>
      <button onClick={() => setOpen(o => !o)} className="w-full h-9 px-3 flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--fg)' }}>
        建议归入
        <span className="tnum font-normal" style={{ color: 'var(--faint)' }}>{props.rows.length}</span>
        <span className="font-normal" style={{ color: 'var(--faint)' }}>拿不准的邮件，确认后才会进项目</span>
        <span className="flex-1" />
        <span className="transition-transform" style={{ transform: open ? 'rotate(90deg)' : 'none', color: 'var(--faint)' }}>
          <IconChevronRight width={12} height={12} />
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--border-soft)]">
          {props.rows.slice(0, 12).map(({ p, s }) => (
            <div key={`${p.id}:${s.threadId}`} className="flex items-center gap-3 px-3 py-2 border-b border-[var(--border-soft)] last:border-b-0">
              <div className="flex-1 min-w-0">
                <button
                  onClick={() => {
                    useMail.getState().select(s.messageId)
                    goView('mail')
                  }}
                  className="text-sm truncate block max-w-full text-left hover:underline"
                  style={{ color: 'var(--fg)' }}
                >
                  {s.subject || '（无主题）'}
                </button>
                <div className="text-xs truncate" style={{ color: 'var(--faint)' }}>
                  {s.from ? `${s.from} · ` : ''}
                  {fmtAgo(s.at)} · {s.reason}
                </div>
              </div>
              <span className="shrink-0 inline-flex items-center gap-1.5 text-xs h-6 px-2 rounded-[var(--r-xs)]" style={{ background: projectSoft(p), color: 'var(--fg)' }}>
                <Dot p={p} size={6} />
                <span className="max-w-[140px] truncate">{p.data.name}</span>
              </span>
              <button
                onClick={() => void api.projectResolveSuggestion(p.id, s.threadId, true)}
                className="shrink-0 h-7 px-2.5 rounded-[var(--r-sm)] text-xs font-semibold"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                归入
              </button>
              <button
                onClick={() => void api.projectResolveSuggestion(p.id, s.threadId, false)}
                className="shrink-0 h-7 px-2 rounded-[var(--r-sm)] text-xs hover:bg-[var(--hover)]"
                style={{ color: 'var(--muted)' }}
              >
                忽略
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// =====================================================================
// 发现项目
// =====================================================================

function DiscoverDialog(props: { onClose(): void }) {
  const [days, setDays] = useState<'30' | '60' | '90'>('60')
  const [state, setState] = useState<{ loading: boolean; error?: string; source?: 'ai' | 'heuristic'; candidates: ProjectCandidate[] }>({ loading: true, candidates: [] })
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [names, setNames] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState(false)

  const run = useCallback(async (d: string) => {
    setState({ loading: true, candidates: [] })
    try {
      const res = await api.discoverProjects(Number(d))
      setState({ loading: false, error: res.ok ? undefined : res.error, source: res.source, candidates: res.candidates })
      setPicked(new Set(res.candidates.map(c => c.key)))
      setNames(Object.fromEntries(res.candidates.map(c => [c.key, c.name])))
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : String(err), candidates: [] })
    }
  }, [])
  useEffect(() => void run(days), [days, run])

  const create = async () => {
    const list = state.candidates.filter(c => picked.has(c.key))
    if (!list.length) return
    setCreating(true)
    let first: string | null = null
    for (const c of list) {
      const rec = await api.saveProject({
        data: {
          name: (names[c.key] || c.name).trim(),
          counterparties: c.counterparties,
          keywords: c.keywords,
          threadIds: c.threadIds,
          messageIds: c.messageIds,
          startedAt: c.firstAt,
          source: c.source === 'ai' ? 'ai' : 'mail',
          auto: true
        }
      })
      first = first ?? rec.id
    }
    await useProjects.getState().load()
    setCreating(false)
    toast(`已建 ${list.length} 个项目`)
    props.onClose()
    if (list.length === 1 && first) openProject(first)
  }

  return (
    <Modal title="从最近邮件发现项目" onClose={props.onClose} width={680}>
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
        读最近
        <MiniSeg<'30' | '60' | '90'> value={days} onChange={setDays} options={[{ value: '30', label: '30 天' }, { value: '60', label: '60 天' }, { value: '90', label: '90 天' }]} />
        的企业往来，把可能是同一件事的会话聚在一起。
        <span className="flex-1" />
        {!state.loading && state.source && (
          <span className="text-2xs px-1.5 h-5 inline-flex items-center rounded-[var(--r-xs)]" style={state.source === 'ai' ? { background: 'var(--ai)', color: 'var(--ai-ink)' } : { background: 'var(--hover)', color: 'var(--muted)' }}>
            {state.source === 'ai' ? 'AI 聚类' : '按对方聚类'}
          </span>
        )}
      </div>
      {state.error && (
        <div className="mt-3">
          <AIErrorNote error={state.error} onRetry={() => void run(days)} />
          <div className="mt-1 text-2xs" style={{ color: 'var(--faint)' }}>已先按对方聚类给出候选</div>
        </div>
      )}
      <div className="mt-3 max-h-[52vh] overflow-y-auto -mx-1 px-1 space-y-2">
        {state.loading ? (
          <div className="py-6 space-y-3">
            <div className="text-xs" style={{ color: 'var(--faint)' }}>正在读最近 {days} 天的往来…</div>
            {[90, 70, 82].map((w, i) => (
              <div key={i} className="h-16 rounded-[var(--r-md)] shimmer" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : !state.candidates.length ? (
          <div className="py-10 text-center text-sm" style={{ color: 'var(--faint)' }}>
            没找到像「同一件事」的往来。
            <br />
            <span className="text-xs">可以从任意邮件的 ⋯ 菜单「建为项目」，或手动新建。</span>
          </div>
        ) : (
          state.candidates.map((c, i) => {
            const on = picked.has(c.key)
            return (
              <div
                key={c.key}
                className="rounded-[var(--r-md)] border px-3 py-2.5 transition-colors"
                style={{ borderColor: on ? 'var(--border-strong)' : 'var(--border)', background: on ? 'var(--surface-strong)' : 'transparent', opacity: on ? 1 : 0.7 }}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setPicked(s => {
                        const n = new Set(s)
                        if (n.has(c.key)) n.delete(c.key)
                        else n.add(c.key)
                        return n
                      })
                    }
                    className="accent-[var(--accent)]"
                    aria-label={`选择 ${c.name}`}
                  />
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: hueColor(PROJECT_COLORS[i % PROJECT_COLORS.length].hue) }} />
                  <input
                    value={names[c.key] ?? c.name}
                    onChange={e => setNames(n => ({ ...n, [c.key]: e.target.value }))}
                    className="flex-1 min-w-0 bg-transparent outline-none text-sm font-semibold rounded-[var(--r-xs)] px-1 -mx-1 focus:bg-[var(--hover)]"
                    style={{ color: 'var(--fg)' }}
                  />
                  <span className="text-2xs tnum shrink-0" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                    {c.threadIds.length} 会话 · {c.messageCount} 封 · {fmtMD(c.firstAt)}{fmtMD(c.firstAt) !== fmtMD(c.lastAt) ? `–${fmtMD(c.lastAt)}` : ''}
                  </span>
                </div>
                <div className="mt-1 pl-6 text-xs" style={{ color: 'var(--muted)' }}>
                  {c.counterparty} <span style={{ color: 'var(--faint)' }}>{c.counterparties.slice(0, 3).join('、')}</span>
                </div>
                {c.why && (
                  <div className="mt-1.5 ml-6 text-xs leading-relaxed px-2 py-1 rounded-[var(--r-sm)] inline-block" style={c.source === 'ai' ? { background: 'var(--ai-soft)', color: 'var(--fg)' } : { background: 'var(--bg-soft)', color: 'var(--muted)' }}>
                    {c.why}
                  </div>
                )}
                <div className="mt-1.5 pl-6 flex flex-wrap gap-1">
                  {c.keywords.map(k => (
                    <span key={k} className="text-2xs px-1.5 h-5 inline-flex items-center rounded-[var(--r-xs)]" style={{ background: 'var(--hover)', color: 'var(--muted)' }}>
                      {k}
                    </span>
                  ))}
                  {c.subjects.slice(0, 3).map(s => (
                    <span key={s} className="text-2xs h-5 inline-flex items-center truncate max-w-[220px]" style={{ color: 'var(--faint)' }}>
                      「{s}」
                    </span>
                  ))}
                </div>
              </div>
            )
          })
        )}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <span className="text-xs" style={{ color: 'var(--faint)' }}>建好后，新邮件会按这些对方与关键词自动归入</span>
        <span className="flex-1" />
        <button onClick={props.onClose} className={btnGhost} style={{ color: 'var(--fg)' }}>
          取消
        </button>
        <button
          disabled={!picked.size || creating || state.loading}
          onClick={() => void create()}
          className={`${btnPrimary} disabled:opacity-50`}
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
        >
          {creating ? '正在建…' : `建 ${picked.size} 个项目`}
        </button>
      </div>
    </Modal>
  )
}

// =====================================================================
// 编辑器
// =====================================================================

function Modal(props: { title: string; onClose(): void; width?: number; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[9vh] px-4" style={{ background: 'var(--scrim)' }} onMouseDown={props.onClose}>
      <div
        role="dialog"
        aria-label={props.title}
        className="w-full rounded-[var(--r-lg)] border border-[var(--border)] p-5 pop-in"
        style={{ maxWidth: props.width ?? 520, background: 'var(--surface-strong)', boxShadow: 'var(--shadow-float)' }}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center mb-3">
          <h2 className="flex-1 text-md font-semibold" style={{ color: 'var(--fg)' }}>{props.title}</h2>
          <button onClick={props.onClose} aria-label="关闭" className="icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--faint)' }}>
            <IconClose width={12} height={12} />
          </button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

const field = 'w-full h-8 px-2.5 rounded-[var(--r-sm)] text-sm border border-[var(--border)] outline-none focus:border-[var(--border-strong)] bg-transparent'
const toISO = (ts: number | null | undefined) => {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const fromISO = (s: string) => (s ? Date.parse(`${s}T12:00:00`) || null : null)
const splitList = (s: string) => s.split(/[,，、;\s]+/).map(x => x.trim()).filter(Boolean)

export function ProjectEditor(props: { project: ProjectListItem | ProjectDetail | null; onClose(): void; onSaved?(id: string): void }) {
  const d = props.project?.data
  const [name, setName] = useState(d?.name ?? '')
  const [status, setStatus] = useState<ProjectStatus>(d?.status ?? 'active')
  const [color, setColor] = useState(d?.color ?? '')
  const [cps, setCps] = useState((d?.counterparties ?? []).join(', '))
  const [kws, setKws] = useState((d?.keywords ?? []).join(', '))
  const [budget, setBudget] = useState(d?.budget ? String(d.budget.amount) : '')
  const [currency, setCurrency] = useState(d?.budget?.currency ?? 'CNY')
  const [start, setStart] = useState(toISO(d?.startedAt))
  const [due, setDue] = useState(toISO(d?.dueAt))
  const [auto, setAuto] = useState(d?.auto ?? true)
  const [pinned, setPinned] = useState(d?.pinned ?? false)
  const [notes, setNotes] = useState(d?.notes ?? '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!name.trim()) return
    setSaving(true)
    const amount = Number(budget.replace(/[^\d.]/g, ''))
    const data: Partial<ProjectData> = {
      name: name.trim(),
      status,
      color: color || undefined,
      counterparties: splitList(cps),
      keywords: splitList(kws),
      budget: budget && Number.isFinite(amount) && amount > 0 ? { amount, currency } : null,
      startedAt: fromISO(start),
      dueAt: fromISO(due),
      auto,
      pinned,
      notes: notes.trim() || null
    }
    if (!data.color) delete data.color
    try {
      const rec = await api.saveProject({ id: props.project?.id ?? null, data })
      await useProjects.getState().load()
      toast(props.project ? '已保存' : `已建项目「${rec.data.name}」`)
      props.onClose()
      props.onSaved?.(rec.id)
      if (!props.project) openProject(rec.id)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={props.project ? '编辑项目' : '新建项目'} onClose={props.onClose}>
      <div className="space-y-3 text-xs" style={{ color: 'var(--muted)' }}>
        <label className="block">
          名称
          <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && void save()} placeholder="如「云桥 · 机房扩容采购」" className={`${field} mt-1`} style={{ color: 'var(--fg)' }} />
        </label>
        <div className="flex items-center gap-3">
          <span className="w-12 shrink-0">状态</span>
          <MiniSeg<ProjectStatus> value={status} onChange={setStatus} options={(Object.keys(STATUS_LABEL) as ProjectStatus[]).map(s => ({ value: s, label: STATUS_LABEL[s] }))} />
        </div>
        <div className="flex items-center gap-3">
          <span className="w-12 shrink-0">颜色</span>
          <div className="flex gap-1.5">
            {PROJECT_COLORS.map(c => (
              <button
                key={c.key}
                onClick={() => setColor(c.key)}
                title={c.label}
                aria-label={c.label}
                className="w-5 h-5 rounded-full transition-transform hover:scale-110"
                style={{ background: hueColor(c.hue), boxShadow: color === c.key ? '0 0 0 2px var(--surface-strong), 0 0 0 3.5px var(--fg)' : undefined }}
              />
            ))}
          </div>
        </div>
        <label className="block">
          对方（域名或邮箱，命中即归入）
          <input value={cps} onChange={e => setCps(e.target.value)} placeholder="acme.example, wang@mail.example" className={`${field} mt-1`} style={{ color: 'var(--fg)' }} />
        </label>
        <label className="block">
          关键词（主题优先，其次正文）
          <input value={kws} onChange={e => setKws(e.target.value)} placeholder="合同号、产品名、活动名，逗号分隔" className={`${field} mt-1`} style={{ color: 'var(--fg)' }} />
        </label>
        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            开始
            <input type="date" value={start} onChange={e => setStart(e.target.value)} className={`${field} mt-1 tnum`} style={{ color: 'var(--fg)' }} />
          </label>
          <label className="block">
            截止
            <input type="date" value={due} onChange={e => setDue(e.target.value)} className={`${field} mt-1 tnum`} style={{ color: 'var(--fg)' }} />
          </label>
          <label className="block">
            预算
            <div className="mt-1 flex gap-1">
              <input value={budget} onChange={e => setBudget(e.target.value)} inputMode="decimal" placeholder="0" className={`${field} tnum`} style={{ color: 'var(--fg)' }} />
              <select value={currency} onChange={e => setCurrency(e.target.value)} className="h-8 px-1 rounded-[var(--r-sm)] border border-[var(--border)] bg-transparent text-xs" style={{ color: 'var(--fg)' }}>
                {['CNY', 'USD', 'EUR', 'HKD', 'JPY'].map(c => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
          </label>
        </div>
        <label className="flex items-center gap-2 cursor-default">
          <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} className="accent-[var(--accent)]" />
          <span style={{ color: 'var(--fg)' }}>自动归入新邮件</span>
          <span>（拿不准的仍进「建议归入」）</span>
        </label>
        <label className="flex items-center gap-2 cursor-default">
          <input type="checkbox" checked={pinned} onChange={e => setPinned(e.target.checked)} className="accent-[var(--accent)]" />
          <span style={{ color: 'var(--fg)' }}>钉在侧栏</span>
        </label>
        <label className="block">
          备注
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="w-full mt-1 px-2.5 py-1.5 rounded-[var(--r-sm)] text-sm border border-[var(--border)] outline-none focus:border-[var(--border-strong)] bg-transparent resize-none" style={{ color: 'var(--fg)' }} />
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={props.onClose} className={btnGhost} style={{ color: 'var(--fg)' }}>
          取消
        </button>
        <button disabled={!name.trim() || saving} onClick={() => void save()} className={`${btnPrimary} disabled:opacity-50`} style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          {props.project ? '保存' : '建项目'}
        </button>
      </div>
    </Modal>
  )
}

// =====================================================================
// 详情
// =====================================================================

/** 订阅会影响项目内容的事件（项目 / 待办 / 款项 / 邮件），节流刷新 */
function useLiveReload(reload: () => void) {
  const ref = useRef(reload)
  ref.current = reload
  useEffect(() => {
    let t = 0
    const off = api.onEvent(ev => {
      const type = (ev as { type: string }).type
      const ms = type === 'projects-changed' ? 120 : type === 'todos-changed' || type === 'insights-changed' ? 400 : type === 'messages-changed' || type === 'mail-insights' ? 1500 : -1
      if (ms < 0) return
      window.clearTimeout(t)
      t = window.setTimeout(() => ref.current(), ms)
    })
    return () => {
      window.clearTimeout(t)
      void off()
    }
  }, [])
}

/** 详情 / 联系人页里点邮件：右侧就地打开阅读页（复用 Reader） */
function useReaderPane() {
  const [openId, setOpenId] = useState<string | null>(null)
  const open = (id: string) => {
    setOpenId(id)
    useMail.getState().select(id)
  }
  const close = () => {
    setOpenId(null)
    useMail.getState().select(null)
  }
  return { openId, open, close }
}

function openEvent(ev: TimelineEvent, openMail: (id: string) => void) {
  if (ev.kind === 'todo' && ev.todoId) {
    goView('todo')
    setTimeout(() => window.dispatchEvent(new CustomEvent('ms:todo-open', { detail: ev.todoId })), 250)
    return
  }
  if (ev.kind === 'finance') {
    // 财务入口挂上后由它接管（打开款项详情）；同时就地打开来源邮件
    window.dispatchEvent(new CustomEvent('ms:finance-open', { detail: ev.financeId }))
    if (ev.messageId) openMail(ev.messageId)
    return
  }
  if (ev.messageId) openMail(ev.messageId)
}

function DetailView(props: { id: string; tab: ProjectTab }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [editing, setEditing] = useState(false)
  const reader = useReaderPane()

  const reload = useCallback(() => {
    void Promise.all([api.getProject(props.id), api.projectTimeline(props.id)]).then(([d, ev]) => {
      setDetail(d)
      setEvents(ev)
      setMissing(!d)
      setLoading(false)
    })
  }, [props.id])
  useEffect(() => reload(), [reload])
  useLiveReload(reload)
  useEffect(() => () => useMail.getState().select(null), [])

  if (missing)
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm" style={{ color: 'var(--faint)', background: 'var(--bg)' }}>
        项目不存在或已删除
        <button onClick={openProjects} className={btnGhost} style={{ color: 'var(--fg)' }}>
          回到项目列表
        </button>
      </div>
    )
  if (!detail)
    return (
      <div className="flex-1 px-6 pt-6 space-y-3" style={{ background: 'var(--bg)' }}>
        <div className="h-6 w-60 rounded-sm shimmer" />
        <div className="h-4 w-96 rounded-sm shimmer" />
      </div>
    )

  const p = detail
  const save = (data: Partial<ProjectData>) => void api.saveProject({ id: p.id, data }).then(reload)
  const setTab = (t: ProjectTab) => openProject(p.id, t)
  const menu: MenuItem[] = [
    { kind: 'action', label: '编辑…', onSelect: () => setEditing(true) },
    { kind: 'action', label: '重新扫描已有邮件', icon: <IconRefresh width={13} height={13} />, onSelect: () => void api.projectRescan(p.id).then(r => toast(r.added || r.suggested ? `归入 ${r.added} 封，建议 ${r.suggested} 封` : '没有新的可归入邮件')) },
    { kind: 'sep' },
    ...(['active', 'paused', 'done'] as ProjectStatus[]).filter(s => s !== p.data.status).map(s => ({ kind: 'action' as const, label: `标为${STATUS_LABEL[s]}`, onSelect: () => save({ status: s }) })),
    p.data.status === 'archived'
      ? { kind: 'action', label: '取消归档', icon: <IconArchive width={13} height={13} />, onSelect: () => save({ status: 'active' }) }
      : { kind: 'action', label: '归档', icon: <IconArchive width={13} height={13} />, onSelect: () => save({ status: 'archived', pinned: false }) },
    { kind: 'sep' },
    {
      kind: 'action',
      label: '删除项目',
      icon: <IconTrash width={13} height={13} />,
      danger: true,
      onSelect: () => {
        if (!window.confirm(`删除项目「${p.data.name}」？邮件、待办与款项本身不会被删除。`)) return
        void api.deleteProject(p.id).then(() => {
          toast('已删除项目')
          openProjects()
        })
      }
    }
  ]
  const tabs: { value: ProjectTab; label: string }[] = [
    { value: 'timeline', label: `时间线` },
    { value: 'mail', label: `邮件 ${p.stats.threadCount}` },
    { value: 'overview', label: '概要' }
  ]
  const split = !!reader.openId

  return (
    <div className="flex-1 min-w-0 h-full flex" style={{ background: 'var(--bg)' }}>
      <div className={`h-full flex flex-col min-w-0 ${split ? 'w-[min(520px,46%)] shrink-0 border-r border-[var(--border)]' : 'flex-1'}`}>
        <header className="drag-region shrink-0 px-6 pt-3 pb-3 border-b border-[var(--border)]">
          <button onClick={openProjects} className="no-drag text-xs inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--faint)' }}>
            ← 项目
          </button>
          <div className="mt-1.5 flex items-center gap-2.5 min-w-0">
            <Dot p={p} size={11} />
            <h1 className="text-lg font-semibold truncate selectable" style={{ color: 'var(--fg)', letterSpacing: '-0.01em' }}>{p.data.name}</h1>
            <StatusChip status={p.data.status} />
            <span className="flex-1" />
            <button
              onClick={() => save({ pinned: !p.data.pinned })}
              title={p.data.pinned ? '从侧栏取消钉住' : '钉在侧栏'}
              className="no-drag icon-btn w-8 h-8 inline-flex items-center justify-center"
              style={{ color: p.data.pinned ? 'var(--accent-ink)' : 'var(--faint)', background: p.data.pinned ? 'var(--selected)' : undefined }}
            >
              <IconPin width={14} height={14} />
            </button>
            <MenuButton title="更多" items={menu} width={200}>
              <IconMore width={15} height={15} />
            </MenuButton>
          </div>
          <div className="mt-1 text-xs flex flex-wrap items-center gap-x-2 gap-y-1" style={{ color: 'var(--muted)' }}>
            {p.data.counterparties.length ? (
              p.data.counterparties.slice(0, 4).map(c => (
                <button key={c} onClick={() => openContactTimeline(c)} className="no-drag hover:underline" title="看和对方的全部往来">
                  {c}
                </button>
              ))
            ) : (
              <span style={{ color: 'var(--faint)' }}>未设对方</span>
            )}
            <span style={{ color: 'var(--faint)' }}>
              · {p.stats.messageCount} 封{p.stats.unread ? ` · ${p.stats.unread} 未读` : ''}
              {p.data.dueAt ? ` · 截止 ${new Date(p.data.dueAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}` : ''}
              {p.data.auto ? ' · 自动归入' : ''}
            </span>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <MiniSeg value={props.tab} onChange={setTab} options={tabs} />
            <span className="flex-1" />
            {split && (
              <button onClick={reader.close} className="no-drag h-7 px-2 rounded-[var(--r-sm)] text-xs inline-flex items-center gap-1 hover:bg-[var(--hover)]" style={{ color: 'var(--muted)' }}>
                <IconClose width={11} height={11} /> 收起邮件
              </button>
            )}
          </div>
        </header>

        {!!p.data.suggestions?.length && (
          <div className="shrink-0 px-6 pt-3">
            <SuggestionQueue rows={p.data.suggestions.map(s => ({ p, s }))} />
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-10">
          {props.tab === 'timeline' && (
            <div className={split ? '' : 'max-w-[820px]'}>
              <Timeline
                events={events}
                loading={loading}
                storageKey="project"
                activeId={reader.openId}
                onOpen={ev => openEvent(ev, reader.open)}
                onAddMilestone={m => save({ milestones: [...(p.data.milestones ?? []), { id: `ms-${Date.now().toString(36)}`, ...m }] })}
                onToggleMilestone={id => save({ milestones: (p.data.milestones ?? []).map(x => (x.id === id ? { ...x, done: !x.done } : x)) })}
                emptyText="项目里还没有邮件：在邮件的 ⋯ 菜单「加入项目…」，或在概要里补上对方域名与关键词"
              />
            </div>
          )}
          {props.tab === 'mail' && <MailTab detail={p} activeId={reader.openId} onOpen={reader.open} />}
          {props.tab === 'overview' && <OverviewTab detail={p} onOpen={reader.open} onEdit={() => setEditing(true)} onSave={save} compact={split} />}
        </div>
      </div>
      {split && (
        <div className="flex-1 min-w-0 h-full flex">
          <Reader />
        </div>
      )}
      {editing && <ProjectEditor project={p} onClose={() => setEditing(false)} onSaved={reload} />}
    </div>
  )
}

function MailTab(props: { detail: ProjectDetail; activeId: string | null; onOpen(id: string): void }) {
  const convs = props.detail.conversations
  if (!convs.length)
    return <div className="py-12 text-center text-xs" style={{ color: 'var(--faint)' }}>还没有邮件。在任意邮件的 ⋯ 菜单里「加入项目…」</div>
  return (
    <div className="-mx-6 border-t border-[var(--border-soft)]">
      {convs.map(c => {
        const active = props.activeId === c.latestId
        return (
          <div
            key={c.threadId}
            onClick={() => props.onOpen(c.latestId)}
            className="group relative flex gap-2.5 pl-6 pr-4 py-[var(--row-py)] border-b border-[var(--border-soft)] cursor-default transition-colors hover:bg-[var(--hover)]"
            style={{ background: active ? 'var(--selected)' : undefined }}
          >
            <div className="w-4 h-[18px] shrink-0 flex items-center justify-center">
              {c.unread > 0 && <span className="w-2 h-2 rounded-full" style={{ background: 'var(--accent)' }} aria-label="未读" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 h-[18px]">
                <span className={`truncate text-sm ${c.unread ? 'font-semibold' : ''}`} style={{ color: c.unread ? 'var(--fg)' : 'var(--muted)' }}>
                  {c.participants.length > 2 ? `${c.participants.slice(0, 2).join('、')} 等 ${c.participants.length} 人` : c.participants.join('、')}
                </span>
                {c.count > 1 && (
                  <span className="text-2xs px-1.5 py-px rounded-full shrink-0 font-medium inline-flex items-center gap-1" style={{ background: 'var(--hover)', color: 'var(--muted)' }}>
                    <IconChat width={10} height={10} /> {c.count}
                  </span>
                )}
                {c.hasAttachments && <IconAttach width={12} height={12} className="shrink-0" style={{ color: 'var(--faint)' }} />}
                <span className="ml-auto shrink-0 text-xs tnum group-hover:hidden" style={{ color: c.unread ? 'var(--fg)' : 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{fmtAgo(c.lastAt)}</span>
                <button
                  onClick={e => {
                    e.stopPropagation()
                    void api.projectRemoveMessages(props.detail.id, [c.latestId]).then(() => toast('已移出项目，之后不会再自动归入'))
                  }}
                  className="ml-auto hidden group-hover:inline-flex shrink-0 h-5 px-1.5 items-center rounded-[var(--r-xs)] text-2xs border border-[var(--border)]"
                  style={{ color: 'var(--muted)', background: 'var(--surface-strong)' }}
                >
                  移出项目
                </button>
              </div>
              <div className={`mt-0.5 truncate text-sm ${c.unread ? 'font-medium' : ''}`} style={{ color: c.unread ? 'var(--fg)' : 'var(--muted)' }}>{c.subject || '（无主题）'}</div>
              {c.gist && (
                <div className="mt-0.5 text-xs leading-[18px] line-clamp-2" style={{ color: 'var(--muted)' }}>
                  {c.gistKey && c.gist.includes(c.gistKey) ? (
                    <>
                      {c.gist.slice(0, c.gist.indexOf(c.gistKey))}
                      <mark className="hl">{c.gistKey}</mark>
                      {c.gist.slice(c.gist.indexOf(c.gistKey) + c.gistKey.length)}
                    </>
                  ) : (
                    c.gist
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- 概要

function Card(props: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-[var(--r-md)] border border-[var(--border)] px-4 py-3 ${props.className ?? ''}`} style={{ background: 'var(--surface-strong)' }}>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="caps flex-1" style={{ color: 'var(--faint)' }}>{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </section>
  )
}

/** 带 [1] [2] 引用的句子：引用渲染成可点的小角标，点开来源邮件 */
function Cited(props: { text: string; sources: ProjectSummary['sources']; onOpen(id: string): void }) {
  const parts = props.text.split(/(\[\d+\])/g)
  return (
    <>
      {parts.map((part, i) => {
        const m = part.match(/^\[(\d+)\]$/)
        const src = m ? props.sources[Number(m[1]) - 1] : null
        if (!m) return <span key={i}>{part}</span>
        if (!src) return null
        return (
          <button
            key={i}
            onClick={() => props.onOpen(src.messageId)}
            title={`来源：${src.subject}`}
            className="align-super text-[10px] leading-none mx-px px-1 h-[14px] inline-flex items-center rounded-[var(--r-xs)] tnum hover:opacity-80"
            style={{ background: 'var(--hover-strong)', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}
          >
            {m[1]}
          </button>
        )
      })}
    </>
  )
}

function SummaryCard(props: { detail: ProjectDetail; onOpen(id: string): void }) {
  const ai = props.detail.data.summary
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [aiReady, setAiReady] = useState<boolean | null>(null)
  useEffect(() => void api.aiStatus().then(s => setAiReady(s.ready)).catch(() => setAiReady(false)), [])
  const s: ProjectSummary = ai ?? props.detail.ruleSummary
  const run = async () => {
    setBusy(true)
    setError(null)
    const res = await api.projectSummarize(props.detail.id)
    setBusy(false)
    if (!res.ok) setError(res.error ?? '生成失败')
  }
  const waiting = s.waitingOn === 'me' ? { text: '等我处理', style: { background: 'var(--warn-soft)', color: 'var(--warn-ink)' } } : s.waitingOn === 'them' ? { text: '等对方', style: { background: 'var(--info-soft)', color: 'var(--info-ink)' } } : { text: '无人欠回复', style: { background: 'var(--hover)', color: 'var(--muted)' } }
  return (
    <Card
      title={s.source === 'ai' ? '摘要 · AI' : '摘要'}
      className="col-span-full"
      action={
        aiReady ? (
          <button onClick={() => void run()} disabled={busy} className="h-6 px-2 rounded-[var(--r-xs)] text-2xs font-semibold inline-flex items-center gap-1 ai-chip disabled:opacity-60">
            <IconSparkles width={11} height={11} className={busy ? 'spinning' : ''} />
            {busy ? '生成中…' : ai ? '重新生成' : 'AI 生成摘要'}
          </button>
        ) : aiReady === false ? (
          <button onClick={() => void api.openSettings('ai')} className="text-2xs underline underline-offset-2" style={{ color: 'var(--faint)' }}>
            配置 AI 后可生成 AI 摘要
          </button>
        ) : null
      }
    >
      <div className="space-y-2 text-sm leading-relaxed" style={{ color: 'var(--fg)' }}>
        <div className="flex gap-2">
          <span className="shrink-0 w-16 text-xs pt-0.5" style={{ color: 'var(--faint)' }}>进展到哪</span>
          <span className="flex-1 min-w-0">
            {/* AI 产出：荧光下划（只给 AI 写的那句） */}
            <span style={s.source === 'ai' ? { background: 'linear-gradient(transparent 62%, var(--ai-soft) 62%)', boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' } : undefined}>
              <Cited text={s.progress} sources={s.sources} onOpen={props.onOpen} />
            </span>
          </span>
        </div>
        <div className="flex gap-2">
          <span className="shrink-0 w-16 text-xs pt-0.5" style={{ color: 'var(--faint)' }}>卡在谁</span>
          <span className="flex-1 min-w-0">
            <span className="text-2xs px-1.5 h-[18px] inline-flex items-center rounded-[var(--r-xs)] mr-1.5 align-[1px]" style={waiting.style}>{waiting.text}</span>
            {s.blocker ? <Cited text={s.blocker} sources={s.sources} onOpen={props.onOpen} /> : <span style={{ color: 'var(--faint)' }}>没有卡点</span>}
          </span>
        </div>
        <div className="flex gap-2">
          <span className="shrink-0 w-16 text-xs pt-0.5" style={{ color: 'var(--faint)' }}>下一步</span>
          {s.next.length ? (
            <ol className="flex-1 min-w-0 space-y-0.5">
              {s.next.map((n, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="tnum text-xs pt-0.5" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{i + 1}</span>
                  <span className="min-w-0">
                    <Cited text={n} sources={s.sources} onOpen={props.onOpen} />
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <span style={{ color: 'var(--faint)' }}>—</span>
          )}
        </div>
      </div>
      {s.sources.length > 0 && (
        <div className="mt-3 pt-2 border-t border-[var(--border-soft)] flex flex-wrap gap-x-3 gap-y-1 text-2xs" style={{ color: 'var(--faint)' }}>
          {s.sources.map((src, i) => (
            <button key={src.messageId} onClick={() => props.onOpen(src.messageId)} className="hover:underline truncate max-w-[260px]" title={src.subject}>
              [{i + 1}] {new Date(src.date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} {src.subject}
            </button>
          ))}
        </div>
      )}
      {error && <div className="mt-2"><AIErrorNote error={error} onRetry={() => void run()} /></div>}
      {ai && <div className="mt-2 text-2xs" style={{ color: 'var(--faint)' }}>生成于 {new Date(ai.generatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · 规则版：{props.detail.ruleSummary.blocker ?? props.detail.ruleSummary.progress}</div>}
    </Card>
  )
}

function OverviewTab(props: { detail: ProjectDetail; onOpen(id: string): void; onEdit(): void; onSave(d: Partial<ProjectData>): void; compact: boolean }) {
  const p = props.detail
  const [notes, setNotes] = useState(p.data.notes ?? '')
  const [todoText, setTodoText] = useState('')
  useEffect(() => setNotes(p.data.notes ?? ''), [p.data.notes])
  const open = p.todos.filter(t => t.status === 'open').sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
  const done = p.todos.filter(t => t.status === 'done')
  const attByKind = useMemo(() => {
    const m = new Map<AttachmentKind, typeof p.attachments>()
    for (const a of p.attachments) m.set(a.kind, [...(m.get(a.kind) ?? []), a])
    return [...m.entries()].sort((a, b) => (a[0] === 'file' ? 1 : b[0] === 'file' ? -1 : 0))
  }, [p.attachments])
  const addTodo = async () => {
    const title = todoText.trim()
    if (!title) return
    await api.createTodo({ title, data: { project: p.data.name, inbox: false } })
    setTodoText('')
  }
  const edit = (
    <button onClick={props.onEdit} className="text-2xs hover:underline" style={{ color: 'var(--muted)' }}>
      编辑
    </button>
  )
  return (
    <div className={`grid items-start gap-3 ${props.compact ? 'grid-cols-1' : 'grid-cols-1 xl:grid-cols-2'} max-w-[1080px]`}>
      <SummaryCard detail={p} onOpen={props.onOpen} />

      <Card title="对方 · 成员 · 关键词" action={edit}>
        <div className="space-y-2.5 text-sm">
          <div className="flex flex-wrap gap-1.5">
            {p.data.counterparties.map(c => (
              <button key={c} onClick={() => openContactTimeline(c)} className="text-xs h-6 px-2 rounded-[var(--r-xs)] border border-[var(--border)] hover:bg-[var(--hover)] inline-flex items-center gap-1" style={{ color: 'var(--fg)' }} title="往来时间线">
                <IconTimeline width={11} height={11} /> {c}
              </button>
            ))}
            {!p.data.counterparties.length && <span className="text-xs" style={{ color: 'var(--faint)' }}>未设对方：补上域名后新邮件会自动归入</span>}
          </div>
          {!!p.data.members?.length && (
            <div className="space-y-1">
              {p.data.members.slice(0, 8).map(m => (
                <button key={m.address} onClick={() => openContactTimeline(m.address)} className="w-full flex items-baseline gap-2 text-left hover:underline">
                  <span className="text-sm truncate" style={{ color: 'var(--fg)' }}>{m.name || m.address.split('@')[0]}</span>
                  <span className="text-xs truncate" style={{ color: 'var(--faint)' }}>{m.address}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {p.data.keywords.map(k => (
              <span key={k} className="text-2xs px-1.5 h-5 inline-flex items-center rounded-[var(--r-xs)]" style={{ background: 'var(--hover)', color: 'var(--muted)' }}>
                {k}
              </span>
            ))}
            {!p.data.keywords.length && <span className="text-xs" style={{ color: 'var(--faint)' }}>没有关键词</span>}
          </div>
          <label className="flex items-center gap-2 text-xs cursor-default" style={{ color: 'var(--muted)' }}>
            <input type="checkbox" checked={p.data.auto} onChange={e => props.onSave({ auto: e.target.checked })} className="accent-[var(--accent)]" />
            自动归入新邮件
          </label>
        </div>
      </Card>

      <MoneyCard detail={p} onOpen={props.onOpen} onEdit={props.onEdit} />

      <Card title={`待办 · ${open.length}${done.length ? ` / 已完成 ${done.length}` : ''}`}>
        <div className="space-y-1">
          {open.map(t => (
            <div key={t.id} className="group flex items-center gap-2 py-1">
              <button
                onClick={() => void api.updateTodo(t.id, { status: 'done', data: { doneAt: Date.now(), doneBy: 'user' } })}
                aria-label={`完成：${t.title}`}
                className="w-4 h-4 rounded-full border-[1.5px] shrink-0 hover:bg-[var(--hover-strong)]"
                style={{ borderColor: 'var(--border-strong)' }}
              />
              <button
                onClick={() => {
                  goView('todo')
                  setTimeout(() => window.dispatchEvent(new CustomEvent('ms:todo-open', { detail: t.id })), 250)
                }}
                className="flex-1 min-w-0 text-left text-sm truncate hover:underline"
                style={{ color: 'var(--fg)' }}
              >
                {t.title}
              </button>
              {t.dueAt && (
                <span className="text-2xs tnum shrink-0" style={{ color: t.dueAt < Date.now() ? 'var(--danger-ink)' : 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                  {new Date(t.dueAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                </span>
              )}
            </div>
          ))}
          {!open.length && <div className="text-xs py-1" style={{ color: 'var(--faint)' }}>没有未完成的待办</div>}
          <label className="mt-1 h-8 px-2 flex items-center gap-1.5 rounded-[var(--r-sm)] border border-dashed border-[var(--border-strong)]">
            <IconPlus width={12} height={12} style={{ color: 'var(--faint)' }} />
            <input value={todoText} onChange={e => setTodoText(e.target.value)} onKeyDown={e => e.key === 'Enter' && void addTodo()} placeholder={`给「${p.data.name}」加待办，回车`} className="flex-1 min-w-0 bg-transparent outline-none text-xs" style={{ color: 'var(--fg)' }} />
          </label>
        </div>
      </Card>

      <Card title={`附件 · ${p.attachments.length}`}>
        {!p.attachments.length ? (
          <div className="text-xs" style={{ color: 'var(--faint)' }}>项目邮件里还没有附件</div>
        ) : (
          <div className="space-y-2.5">
            {attByKind.map(([kind, list]) => (
              <div key={kind}>
                <div className="text-2xs mb-1" style={{ color: 'var(--faint)' }}>
                  {ATTACHMENT_KIND_LABEL[kind]} · {list.length}
                </div>
                {list.slice(0, 6).map(a => (
                  <button key={a.id} onClick={() => props.onOpen(a.messageId)} className="w-full flex items-center gap-2 py-0.5 text-left hover:underline">
                    <IconAttach width={12} height={12} style={{ color: 'var(--faint)' }} className="shrink-0" />
                    <span className="flex-1 min-w-0 text-sm truncate" style={{ color: 'var(--fg)' }}>{a.filename}</span>
                    <span className="text-2xs tnum shrink-0" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                      {fmtBytes(a.size)} · {new Date(a.date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="备注">
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          onBlur={() => notes !== (p.data.notes ?? '') && props.onSave({ notes: notes.trim() || null })}
          rows={4}
          placeholder="合同要点、联系人分工、注意事项…（离开输入框自动保存）"
          className="w-full px-0 bg-transparent outline-none text-sm leading-relaxed resize-none"
          style={{ color: 'var(--fg)' }}
        />
      </Card>
    </div>
  )
}

function MoneyCard(props: { detail: ProjectDetail; onOpen(id: string): void; onEdit(): void }) {
  const p = props.detail
  const totals = p.stats.finance?.totals ?? []
  const budget = p.data.budget
  return (
    <Card
      title="预算与款项"
      action={
        !budget ? (
          <button onClick={props.onEdit} className="text-2xs hover:underline" style={{ color: 'var(--muted)' }}>
            设预算
          </button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {budget && <Stat label="预算" value={fmtMoney(budget.amount, budget.currency)} />}
        {totals.map(t => (
          <div key={t.currency} className="contents">
            {t.out > 0 && <Stat label={`应付 / 已付${totals.length > 1 ? ` ${t.currency}` : ''}`} value={fmtMoney(t.out, t.currency)} />}
            {t.in > 0 && <Stat label={`应收 / 已收${totals.length > 1 ? ` ${t.currency}` : ''}`} value={fmtMoney(t.in, t.currency)} tone="ok" />}
            {t.pending > 0 && <Stat label="未结清" value={fmtMoney(t.pending, t.currency)} tone="warn" />}
          </div>
        ))}
        {budget && totals.find(t => t.currency === budget.currency) && (
          <Stat label="预算已用" value={`${Math.round(((totals.find(t => t.currency === budget.currency)!.out || totals.find(t => t.currency === budget.currency)!.in) / budget.amount) * 100)}%`} />
        )}
      </div>
      {p.finance.length > 0 ? (
        <div className="mt-3 space-y-1">
          {p.finance.map(f => {
            const d = f.data as unknown as FinanceData
            const src = d.messageIds?.[0] ?? f.messageId
            return (
              <button
                key={f.id}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('ms:finance-open', { detail: f.id }))
                  if (src) props.onOpen(src)
                }}
                className="w-full flex items-center gap-2 py-0.5 text-left hover:bg-[var(--hover)] rounded-[var(--r-xs)] px-1 -mx-1"
              >
                <span className="text-2xs w-8 shrink-0" style={{ color: 'var(--warn-ink)', fontWeight: 600 }}>{FINANCE_KIND_LABEL[d.kind] ?? d.kind}</span>
                <span className="flex-1 min-w-0 text-sm truncate" style={{ color: 'var(--fg)' }}>
                  {d.counterparty}
                  {d.invoiceNo ? <span style={{ color: 'var(--faint)' }}> · {d.invoiceNo}</span> : null}
                </span>
                <span className="text-xs tnum shrink-0" style={{ color: d.direction === 'in' ? 'var(--ok-ink)' : 'var(--fg)', fontFamily: 'var(--font-mono)' }}>
                  {d.amount != null ? `${d.direction === 'in' ? '+' : '−'}${fmtMoney(d.amount, d.currency)}` : '—'}
                </span>
                <span className="text-2xs w-12 text-right shrink-0" style={{ color: d.status === 'overdue' ? 'var(--danger-ink)' : 'var(--faint)' }}>{FINANCE_STATUS_LABEL[d.status] ?? d.status}</span>
              </button>
            )
          })}
        </div>
      ) : (
        !budget && <div className="text-xs" style={{ color: 'var(--faint)' }}>还没有关联款项（财务里识别出的发票 / 付款 / 回单会自动汇到这里）</div>
      )}
    </Card>
  )
}

function Stat(props: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div>
      <div className="text-2xs" style={{ color: 'var(--faint)' }}>{props.label}</div>
      <div className="text-md font-semibold tnum" style={{ color: props.tone === 'ok' ? 'var(--ok-ink)' : props.tone === 'warn' ? 'var(--warn-ink)' : 'var(--fg)', fontFamily: 'var(--font-mono)' }}>
        {props.value}
      </div>
    </div>
  )
}

// =====================================================================
// 联系人 / 公司时间线
// =====================================================================

function ContactView(props: { contactKey: string }) {
  const [data, setData] = useState<ContactTimeline | null>(null)
  const [loading, setLoading] = useState(true)
  const reader = useReaderPane()
  const reload = useCallback(() => {
    void api.contactTimeline(props.contactKey).then(d => {
      setData(d)
      setLoading(false)
    })
  }, [props.contactKey])
  useEffect(() => reload(), [reload])
  useLiveReload(reload)
  useEffect(() => () => useMail.getState().select(null), [])

  const key = props.contactKey
  const domain = key.includes('@') ? domainOf(key) : key
  const canCompany = key.includes('@') && domain && !isPublicDomain(domain)
  const split = !!reader.openId
  const createProject = async () => {
    const rec = await api.saveProject({ data: { name: data?.mode === 'domain' ? `${data.name} 往来` : `${data?.name ?? key} 往来`, counterparties: [key], source: 'manual', auto: true, startedAt: Date.now() - 90 * 86_400_000 } })
    await useProjects.getState().load()
    toast(`已建项目「${rec.data.name}」`)
    openProject(rec.id)
  }

  return (
    <div className="flex-1 min-w-0 h-full flex" style={{ background: 'var(--bg)' }}>
      <div className={`h-full flex flex-col min-w-0 ${split ? 'w-[min(520px,46%)] shrink-0 border-r border-[var(--border)]' : 'flex-1'}`}>
        <header className="drag-region shrink-0 px-6 pt-3 pb-3 border-b border-[var(--border)]">
          <button onClick={() => history.back()} className="no-drag text-xs hover:underline" style={{ color: 'var(--faint)' }}>
            ← 返回
          </button>
          <div className="mt-1.5 flex items-center gap-3 min-w-0">
            <span className="w-9 h-9 shrink-0 rounded-[var(--r-md)] inline-flex items-center justify-center text-md font-semibold" style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}>
              {[...(data?.name || key)][0]?.toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-semibold truncate" style={{ color: 'var(--fg)', letterSpacing: '-0.01em' }}>
                与 {data?.name || key} 的往来
              </h1>
              <div className="text-xs truncate" style={{ color: 'var(--faint)' }}>
                {key} · {data?.messageCount ?? 0} 封{data?.mode === 'domain' ? ' · 整个公司' : ''}
              </div>
            </div>
            {canCompany && (
              <button onClick={() => openContactTimeline(domain)} className={btnGhost} style={{ color: 'var(--fg)' }}>
                看整个 {domain}
              </button>
            )}
            <button onClick={() => void createProject()} className={btnGhost} style={{ color: 'var(--fg)' }} title="以对方为准建一个项目，新邮件自动归入">
              <IconPlus width={12} height={12} /> 建为项目
            </button>
          </div>
          {!!data?.projects.length && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <span style={{ color: 'var(--faint)' }}>所在项目</span>
              {data.projects.map(p => (
                <button key={p.id} onClick={() => openProject(p.id)} className="no-drag h-6 px-2 rounded-[var(--r-xs)] border border-[var(--border)] hover:bg-[var(--hover)] inline-flex items-center gap-1.5" style={{ color: 'var(--fg)' }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: projectColor({ id: p.id, data: { color: p.color } }) }} />
                  {p.name}
                </button>
              ))}
            </div>
          )}
          {split && (
            <div className="mt-2 flex justify-end">
              <button onClick={reader.close} className="no-drag h-7 px-2 rounded-[var(--r-sm)] text-xs inline-flex items-center gap-1 hover:bg-[var(--hover)]" style={{ color: 'var(--muted)' }}>
                <IconClose width={11} height={11} /> 收起邮件
              </button>
            </div>
          )}
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-10">
          <div className={split ? '' : 'max-w-[820px]'}>
            <Timeline events={data?.events ?? []} loading={loading} storageKey="contact" activeId={reader.openId} onOpen={ev => openEvent(ev, reader.open)} emptyText="和对方还没有往来邮件" />
          </div>
        </div>
      </div>
      {split && (
        <div className="flex-1 min-w-0 h-full flex">
          <Reader />
        </div>
      )}
    </div>
  )
}
