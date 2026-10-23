import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { goView } from '../../lib/route'
import { useMail } from '../../stores/mail'
import {
  IconSearch, IconCloud, IconPin, IconSave, IconMailDot, IconLayers, IconList, IconClose, IconRefresh, IconSparkles, IconAttach, IconCheck
} from '../../components/icons'
import type { ArchiveJobStatus, ArchiveSuggestion, AttachmentCategory, AttachmentItem, AttachmentQuery, AttachmentStats } from '@shared/attachments'
import { ATTACHMENT_CATEGORIES } from '@shared/attachments'
import { attachmentCategoryLabel, cloudLabel, extBadge, fmtBytes, fmtDay, useAttachmentEvents } from './model'
import { ArchiveSheet, GhostBtn, JobProgress, PrimaryBtn, ReleaseSheet, Sheet } from './Sheets'
import { AttachmentTextSection } from './AttachmentText'

type StateFilter = NonNullable<AttachmentQuery['state']>
type Layout = 'grid' | 'list'
type SheetState = { kind: 'archive'; ids: string[]; driveId: string | null } | { kind: 'release'; ids: string[] | null } | { kind: 'dups' } | null

const STATE_FILTERS: { id: StateFilter | 'all'; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'local', label: '本地已缓存' },
  { id: 'unarchived', label: '未归档' },
  { id: 'archived', label: '已在网盘' },
  { id: 'released', label: '已释放' },
  { id: 'remote', label: '未下载' }
]

const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

function readLayout(): Layout {
  try {
    return localStorage.getItem('ms_attach_layout') === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

/** 附件中心：顶部占用与整理建议；左侧分类 / 状态 / 账户 / 年份 / 对方；中间网格或列表；右侧详情 */
export function AttachmentsView() {
  const accounts = useMail(st => st.accounts)
  const [stats, setStats] = useState<AttachmentStats | null>(null)
  const [suggest, setSuggest] = useState<ArchiveSuggestion | null>(null)
  const [releasable, setReleasable] = useState<{ count: number; bytes: number } | null>(null)
  const [job, setJob] = useState<ArchiveJobStatus | null>(null)
  const [category, setCategory] = useState<AttachmentCategory | null>(null)
  const [state, setState] = useState<StateFilter | 'all'>('all')
  const [accountId, setAccountId] = useState<string | null>(null)
  const [year, setYear] = useState<number | null>(null)
  const [party, setParty] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'date' | 'size' | 'name'>('date')
  const [layout, setLayoutState] = useState<Layout>(readLayout)
  const [items, setItems] = useState<AttachmentItem[]>([])
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(200)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focusId, setFocusId] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [sheet, setSheet] = useState<SheetState>(null)
  const [loading, setLoading] = useState(true)
  const lastClicked = useRef<string | null>(null)

  const setLayout = (l: Layout) => {
    setLayoutState(l)
    try {
      localStorage.setItem('ms_attach_layout', l)
    } catch { /* 仅本次生效 */ }
  }

  const query: AttachmentQuery = useMemo(
    () => ({ category, accountId, counterparty: party, year, search: search.trim() || null, state: state === 'all' ? null : state, sort, limit }),
    [category, accountId, party, year, search, state, sort, limit]
  )

  const loadList = useCallback(async () => {
    const res = await api.attachList(query)
    setItems(res.items)
    setTotal(res.total)
    setLoading(false)
    const imgs = res.items.filter(i => i.cached && /^(png|jpe?g|gif|webp|bmp)$/.test(i.ext)).map(i => i.id).slice(0, 80)
    if (imgs.length) void api.attachThumbs(imgs).then(t => setThumbs(prev => ({ ...prev, ...t })))
  }, [query])

  const loadOverview = useCallback(async () => {
    const [s, g, plan, j] = await Promise.all([api.attachStats(), api.attachSuggest(90), api.attachReleasePlan(null), api.attachArchiveStatus()])
    setStats(s)
    setSuggest(g)
    setReleasable({ count: plan.items.length, bytes: plan.bytes })
    setJob(j)
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    void loadOverview()
    // 打开附件中心即补一轮增量扫描（新下载的附件、哈希、AI 补充分类）
    void api.attachRescan().then(s => setStats(s))
  }, [loadOverview])

  useAttachmentEvents(
    () => {
      void loadList()
      void loadOverview()
    },
    s => setJob(s)
  )

  const focus = items.find(i => i.id === focusId) ?? null
  const selectedItems = items.filter(i => selected.has(i.id))

  const clickItem = (e: React.MouseEvent, it: AttachmentItem) => {
    if (e.shiftKey && lastClicked.current) {
      const a = items.findIndex(i => i.id === lastClicked.current)
      const b = items.findIndex(i => i.id === it.id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected(prev => new Set([...prev, ...items.slice(lo, hi + 1).map(i => i.id)]))
      }
    } else if (e.metaKey || e.ctrlKey) {
      setSelected(prev => {
        const next = new Set(prev)
        if (next.has(it.id)) next.delete(it.id)
        else next.add(it.id)
        return next
      })
    } else if (selected.size > 0) {
      setSelected(prev => {
        const next = new Set(prev)
        if (next.has(it.id)) next.delete(it.id)
        else next.add(it.id)
        return next
      })
    }
    lastClicked.current = it.id
    setFocusId(it.id)
  }

  const toggleSelect = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const openMail = (it: AttachmentItem) => {
    goView('mail')
    useMail.getState().setScope({ kind: 'unified', title: '统一收件箱' })
    setTimeout(() => useMail.getState().select(it.messageId), 60)
  }

  const openFile = async (it: AttachmentItem) => {
    if (!it.cached) toast(it.remoteOnly ? '正在从邮箱下载…' : '本地缓存已释放，正在重新下载…')
    const res = await api.attachOpen(it.id)
    if (!res.ok) toast(res.error ?? '无法打开')
  }

  const saveMany = async (ids: string[]) => {
    const res = await api.attachSaveMany(ids)
    if (res.count) toast(`已保存 ${res.count} 个附件${res.failed ? `，${res.failed} 个失败：${res.error ?? ''}` : ''}`)
    else if (res.failed) toast(`保存失败：${res.error ?? ''}`)
  }

  const startArchive = (ids: string[]) => {
    if (!suggest?.targets.length) {
      toast('先添加一个网盘：推荐 Proton Drive 或 Dropbox')
      return
    }
    setSheet({ kind: 'archive', ids, driveId: suggest.recommended })
  }

  const clearFilters = () => {
    setCategory(null)
    setState('all')
    setAccountId(null)
    setYear(null)
    setParty(null)
    setSearch('')
  }
  const filtered = !!(category || state !== 'all' || accountId || year || party || search.trim())

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      {/* 标题栏 */}
      <div className="drag-region h-[var(--titlebar-h)] shrink-0 flex items-center gap-3 px-6 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="min-w-0 flex items-baseline gap-2.5">
          <h1 className="text-md font-semibold" style={{ color: 'var(--fg)' }}>附件</h1>
          <span className="text-xs tnum truncate" style={{ color: 'var(--faint)' }}>
            {stats ? `${stats.total.count} 个 · 本地占用 ${fmtBytes(stats.local.bytes)}` : ''}
          </span>
        </div>
        <div className="flex-1" />
        <label className="no-drag h-8 w-[260px] px-2.5 flex items-center gap-2 rounded-[var(--r-sm)] border focus-within:border-[var(--border-strong)]" style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)', color: 'var(--faint)' }}>
          <IconSearch width={13} height={13} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索文件名、主题、对方"
            className="flex-1 min-w-0 bg-transparent outline-none text-sm"
            style={{ color: 'var(--fg)' }}
          />
          {search && (
            <button onClick={() => setSearch('')} aria-label="清空搜索" style={{ color: 'var(--faint)' }}>
              <IconClose width={11} height={11} />
            </button>
          )}
        </label>
        <div className="no-drag flex items-center rounded-[var(--r-sm)] border p-0.5" style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)' }}>
          {(['grid', 'list'] as Layout[]).map(l => (
            <button
              key={l}
              onClick={() => setLayout(l)}
              title={l === 'grid' ? '网格' : '列表'}
              aria-pressed={layout === l}
              className="w-7 h-6 inline-flex items-center justify-center rounded-[var(--r-xs)]"
              style={layout === l ? { background: 'var(--selected)', color: 'var(--accent-ink)' } : { color: 'var(--faint)' }}
            >
              {l === 'grid' ? <IconLayers width={13} height={13} /> : <IconList width={13} height={13} />}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* 左：筛选 */}
        <aside className="w-[196px] shrink-0 overflow-y-auto px-2 py-3 border-r" style={{ borderColor: 'var(--border)' }} aria-label="附件筛选">
          <FilterGroup label="状态">
            {STATE_FILTERS.map(f => (
              <FilterRow
                key={f.id}
                label={f.label}
                active={state === f.id}
                count={f.id === 'all' ? stats?.total.count : f.id === 'local' ? stats?.local.count : f.id === 'archived' ? stats?.archived.count : f.id === 'released' ? stats?.released.count : f.id === 'remote' ? stats?.remote.count : undefined}
                onClick={() => setState(f.id)}
              />
            ))}
          </FilterGroup>
          <FilterGroup label="分类">
            <FilterRow label="全部分类" active={!category} onClick={() => setCategory(null)} />
            {ATTACHMENT_CATEGORIES.map(c => {
              const b = stats?.byCategory.find(x => x.key === c.id)
              if (!b) return null
              return <FilterRow key={c.id} label={c.label} count={b.count} active={category === c.id} onClick={() => setCategory(category === c.id ? null : c.id)} />
            })}
          </FilterGroup>
          {accounts.length > 1 && (
            <FilterGroup label="账户">
              {(stats?.byAccount ?? []).map(b => {
                const acc = accounts.find(a => a.id === b.key)
                return (
                  <FilterRow
                    key={b.key}
                    label={acc?.name ?? b.label}
                    dot={acc?.color}
                    count={b.count}
                    active={accountId === b.key}
                    onClick={() => setAccountId(accountId === b.key ? null : b.key)}
                  />
                )
              })}
            </FilterGroup>
          )}
          {(stats?.byYear.length ?? 0) > 0 && (
            <FilterGroup label="时间">
              {(stats?.byYear ?? []).map(b => (
                <FilterRow
                  key={b.key}
                  label={b.key === '未知' ? '未知' : `${b.key} 年`}
                  count={b.count}
                  active={year === Number(b.key)}
                  onClick={() => setYear(year === Number(b.key) ? null : Number(b.key) || null)}
                />
              ))}
            </FilterGroup>
          )}
          {(stats?.byCounterparty.length ?? 0) > 0 && (
            <FilterGroup label="对方">
              {(stats?.byCounterparty ?? []).slice(0, 14).map(b => (
                <FilterRow key={b.key} label={b.label} count={b.count} active={party === b.key} onClick={() => setParty(party === b.key ? null : b.key)} />
              ))}
            </FilterGroup>
          )}
        </aside>

        {/* 中：概览 + 网格 / 列表 */}
        <main className="flex-1 min-w-0 overflow-y-auto">
          <div className="px-5 pt-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
            <StorageCard
              stats={stats}
              onLargest={() => {
                clearFilters()
                setState('local')
                setSort('size')
              }}
              onDups={() => setSheet({ kind: 'dups' })}
            />
            <SuggestCard
              suggest={suggest}
              releasable={releasable}
              job={job}
              onArchive={() => suggest && startArchive(suggest.ids)}
              onRelease={() => setSheet({ kind: 'release', ids: null })}
              onChanged={() => void loadOverview()}
            />
          </div>

          <div className="px-5 pt-4 pb-2 flex items-center gap-2">
            <span className="text-xs tnum" style={{ color: 'var(--muted)' }}>
              {loading ? '加载中…' : `${total} 个附件`}
            </span>
            {filtered && (
              <button onClick={clearFilters} className="text-xs hover:underline" style={{ color: 'var(--faint)' }}>
                清除筛选
              </button>
            )}
            <div className="flex-1" />
            {items.length > 0 && (
              <button
                onClick={() => setSelected(selected.size === items.length ? new Set() : new Set(items.map(i => i.id)))}
                className="text-xs h-6 px-2 rounded-[var(--r-xs)] hover:bg-[var(--hover)]"
                style={{ color: 'var(--muted)' }}
              >
                {selected.size === items.length ? '取消全选' : '全选'}
              </button>
            )}
            <select
              value={sort}
              onChange={e => setSort(e.target.value as typeof sort)}
              className="text-xs h-6 px-1.5 rounded-[var(--r-xs)] border outline-none"
              style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)', color: 'var(--muted)' }}
              aria-label="排序"
            >
              <option value="date">最新在前</option>
              <option value="size">最大在前</option>
              <option value="name">按文件名</option>
            </select>
          </div>

          <div className="px-5 pb-24">
            {!loading && !items.length && <EmptyState filtered={filtered} total={stats?.total.count ?? 0} />}
            {layout === 'grid' ? (
              <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))' }}>
                {items.map(it => (
                  <GridCard
                    key={it.id}
                    it={it}
                    thumb={thumbs[it.id]}
                    selected={selected.has(it.id)}
                    focused={focusId === it.id}
                    selecting={selected.size > 0}
                    onClick={e => clickItem(e, it)}
                    onToggle={() => toggleSelect(it.id)}
                    onOpen={() => void openFile(it)}
                  />
                ))}
              </div>
            ) : (
              <div className="@container rounded-[var(--r-md)] border overflow-hidden" style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)' }}>
                {items.map(it => (
                  <ListRow
                    key={it.id}
                    it={it}
                    selected={selected.has(it.id)}
                    focused={focusId === it.id}
                    onClick={e => clickItem(e, it)}
                    onToggle={() => toggleSelect(it.id)}
                    onOpen={() => void openFile(it)}
                  />
                ))}
              </div>
            )}
            {items.length < total && (
              <div className="mt-4 flex justify-center">
                <GhostBtn onClick={() => setLimit(l => l + 200)}>再显示 200 个</GhostBtn>
              </div>
            )}
          </div>
        </main>

        {/* 右：详情 */}
        {focus && (
          <Detail
            it={focus}
            thumb={thumbs[focus.id]}
            onClose={() => setFocusId(null)}
            onOpen={() => void openFile(focus)}
            onSave={() => void saveMany([focus.id])}
            onMail={() => openMail(focus)}
            onArchive={() => startArchive([focus.id])}
            onRelease={() => setSheet({ kind: 'release', ids: [focus.id] })}
          />
        )}
      </div>

      {/* 多选操作条 */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 pl-4 pr-1.5 py-1.5 rounded-[var(--r-md)] liquid-glass pop-in" role="toolbar" aria-label="批量操作">
          <span className="text-sm tnum mr-2" style={{ color: 'var(--fg)' }}>
            已选 {selected.size} 个 · {fmtBytes(selectedItems.reduce((s, i) => s + i.size, 0))}
          </span>
          <BarBtn onClick={() => startArchive([...selected])} icon={<IconCloud width={13} height={13} />} label="归档到网盘" primary />
          <BarBtn onClick={() => void saveMany([...selected])} icon={<IconSave width={13} height={13} />} label="保存到本地" />
          <BarBtn onClick={() => setSheet({ kind: 'release', ids: [...selected] })} label="释放本地缓存" />
          <BarBtn
            onClick={() => {
              const pin = selectedItems.some(i => !i.pinned)
              void api.attachPin([...selected], pin).then(() => toast(pin ? '已钉住：不会被释放' : '已取消钉住'))
            }}
            icon={<IconPin width={13} height={13} />}
            label={selectedItems.some(i => !i.pinned) ? '钉住' : '取消钉住'}
          />
          <CategoryMenu onPick={c => void api.attachSetCategory([...selected], c).then(() => toast(`已改为「${attachmentCategoryLabel(c)}」`))} />
          {selected.size === 1 && <BarBtn onClick={() => { const it = items.find(i => selected.has(i.id)); if (it) openMail(it) }} icon={<IconMailDot width={13} height={13} />} label="原邮件" />}
          <button onClick={() => setSelected(new Set())} aria-label="取消选择" className="icon-btn w-7 h-7 inline-flex items-center justify-center ml-1" style={{ color: 'var(--faint)' }}>
            <IconClose width={13} height={13} />
          </button>
        </div>
      )}

      {sheet?.kind === 'archive' && suggest && (
        <ArchiveSheet
          ids={sheet.ids}
          targets={suggest.targets}
          initialDriveId={sheet.driveId}
          onClose={() => setSheet(null)}
          onRelease={ids => setSheet({ kind: 'release', ids })}
        />
      )}
      {sheet?.kind === 'release' && (
        <ReleaseSheet
          ids={sheet.ids}
          onClose={() => setSheet(null)}
          onDone={msg => {
            toast(msg)
            setSelected(new Set())
            void loadList()
            void loadOverview()
          }}
        />
      )}
      {sheet?.kind === 'dups' && stats && <DupSheet stats={stats} onClose={() => setSheet(null)} onRelease={ids => setSheet({ kind: 'release', ids })} />}
    </div>
  )
}

// ---------------- 小部件 ----------------

function FilterGroup(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="caps px-2 h-6 flex items-center" style={{ color: 'var(--faint)' }}>{props.label}</div>
      {props.children}
    </div>
  )
}

function FilterRow(props: { label: string; count?: number; active: boolean; onClick(): void; dot?: string }) {
  return (
    <button
      onClick={props.onClick}
      aria-pressed={props.active}
      className={`w-full h-[var(--row-side-h)] flex items-center gap-2 px-2 rounded-[var(--r-sm)] text-sm text-left transition-colors ${props.active ? 'font-medium' : 'hover:bg-[var(--hover)]'}`}
      style={{ background: props.active ? 'var(--selected)' : undefined, color: props.active ? 'var(--accent-ink)' : 'var(--fg)' }}
    >
      {props.dot && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: props.dot }} />}
      <span className="flex-1 min-w-0 truncate">{props.label}</span>
      {props.count !== undefined && (
        <span className="text-2xs tnum shrink-0" style={{ color: 'var(--faint)' }}>{props.count}</span>
      )}
    </button>
  )
}

function Card(props: { children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--r-lg)] border p-4 min-w-0" style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-sm)' }}>
      {props.children}
    </section>
  )
}

function StorageCard(props: { stats: AttachmentStats | null; onLargest(): void; onDups(): void }) {
  const [by, setBy] = useState<'category' | 'account' | 'year'>('category')
  const s = props.stats
  const buckets = !s ? [] : (by === 'category' ? s.byCategory : by === 'account' ? s.byAccount : s.byYear).filter(b => b.localBytes > 0).sort((a, b) => b.localBytes - a.localBytes)
  const max = buckets[0]?.localBytes ?? 1
  const dupWaste = s?.duplicates.reduce((sum, d) => sum + d.wasted, 0) ?? 0
  const archivedLocal = s ? s.local.bytes : 0
  return (
    <Card>
      <div className="flex items-baseline gap-2">
        <span className="caps" style={{ color: 'var(--faint)' }}>本地占用</span>
        <div className="flex-1" />
        <div className="flex items-center gap-0.5">
          {(['category', 'account', 'year'] as const).map(k => (
            <button
              key={k}
              onClick={() => setBy(k)}
              className="text-2xs h-5 px-1.5 rounded-[var(--r-xs)]"
              style={by === k ? { background: 'var(--selected)', color: 'var(--accent-ink)', fontWeight: 600 } : { color: 'var(--faint)' }}
            >
              {k === 'category' ? '分类' : k === 'account' ? '账户' : '年份'}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-xl font-semibold tnum tight" style={{ color: 'var(--fg)' }}>{fmtBytes(archivedLocal)}</span>
        <span className="text-xs tnum" style={{ color: 'var(--muted)' }}>{s ? `${s.local.count} 个文件缓存在本机` : '统计中…'}</span>
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        {buckets.slice(0, 5).map(b => (
          <div key={b.key} className="flex items-center gap-2 text-xs">
            <span className="w-[72px] shrink-0 truncate" style={{ color: 'var(--muted)' }}>{b.label}</span>
            <span className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--hover)' }}>
              <span className="block h-full rounded-full" style={{ width: `${Math.max(3, (b.localBytes / max) * 100)}%`, background: 'var(--accent)' }} />
            </span>
            <span className="w-[64px] shrink-0 text-right tnum" style={{ color: 'var(--muted)' }}>{fmtBytes(b.localBytes)}</span>
          </div>
        ))}
        {s && !buckets.length && <div className="text-xs" style={{ color: 'var(--faint)' }}>本机还没有缓存附件。</div>}
      </div>
      {s && (
        <div className="mt-3 pt-3 border-t flex flex-wrap gap-x-3 gap-y-1 text-2xs tnum" style={{ borderColor: 'var(--border-soft)', color: 'var(--faint)' }}>
          {s.largest.length > 0 && (
            <button onClick={props.onLargest} className="hover:underline" style={{ color: 'var(--muted)' }}>
              最大：{s.largest[0].filename.slice(0, 16)} {fmtBytes(s.largest[0].size)}
            </button>
          )}
          {s.duplicates.length > 0 && (
            <button onClick={props.onDups} className="hover:underline" style={{ color: 'var(--muted)' }}>
              重复 {s.duplicates.length} 组，可省 {fmtBytes(dupWaste)}
            </button>
          )}
          {s.released.count > 0 && <span>已释放 {s.released.count} 个</span>}
          {s.remote.count > 0 && <span>未下载 {s.remote.count} 个</span>}
          <span title="邮件 eml 原文镜像（离线可读、可重新解析附件），释放空间不会动它">原文镜像 {fmtBytes(s.emlBytes)}</span>
        </div>
      )}
    </Card>
  )
}

function SuggestCard(props: {
  suggest: ArchiveSuggestion | null
  releasable: { count: number; bytes: number } | null
  job: ArchiveJobStatus | null
  onArchive(): void
  onRelease(): void
  onChanged(): void
}) {
  const g = props.suggest
  const [protonMsg, setProtonMsg] = useState<{ text: string; url?: string } | null>(null)
  const target = g?.targets.find(t => t.driveId === g.recommended)
  const active = props.job && (props.job.state === 'running' || props.job.state === 'paused')
  const cats = (g?.byCategory ?? [])
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map(c => `${attachmentCategoryLabel(c.category)} ${c.count}`)
    .join('、')
  const span = g ? (g.windowDays ? `近 ${g.windowDays} 天` : '目前') : ''

  const addProton = async () => {
    const res = await api.attachAddProton()
    if (res.ok) {
      setProtonMsg({ text: '已添加 Proton Drive：文件写入其同步目录，由客户端自动上云' })
      props.onChanged()
    } else setProtonMsg({ text: '本机没有检测到 Proton Drive for macOS。安装并登录后再点一次即可。', url: res.downloadUrl })
  }

  return (
    <Card>
      <div className="flex items-center gap-2">
        <span className="caps" style={{ color: 'var(--faint)' }}>整理建议</span>
        <div className="flex-1" />
        {target && (
          <span className="text-2xs inline-flex items-center gap-1" style={{ color: 'var(--muted)' }}>
            <IconCloud width={11} height={11} /> {target.name}
          </span>
        )}
      </div>
      {!g ? (
        <div className="mt-2 text-sm" style={{ color: 'var(--faint)' }}>正在分析…</div>
      ) : active && props.job ? (
        <div className="mt-3">
          <JobProgress job={props.job} />
          <div className="mt-3 flex gap-2">
            {props.job.state === 'running' ? (
              <GhostBtn onClick={() => void api.attachArchiveControl('pause')}>暂停</GhostBtn>
            ) : (
              <GhostBtn onClick={() => void api.attachArchiveControl('resume')}>继续</GhostBtn>
            )}
            <GhostBtn tone="danger" onClick={() => void api.attachArchiveControl('cancel')}>取消</GhostBtn>
          </div>
        </div>
      ) : !g.targets.length ? (
        <>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--fg)' }}>
            {g.count ? `${span}有 ${g.count} 个附件（${fmtBytes(g.bytes)}）只存在邮箱和本机。` : '附件只存在邮箱和本机。'}
            归档到网盘，按「分类 / 年份 / 对方」分门别类保存，本机就能放心释放空间。
          </p>
          <p className="mt-1.5 text-xs" style={{ color: 'var(--muted)' }}>推荐 Proton Drive（端到端加密，经桌面客户端同步目录）或 Dropbox。</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <PrimaryBtn onClick={() => void addProton()}>添加 Proton Drive</PrimaryBtn>
            <GhostBtn onClick={() => void api.openSettings('integrations')}>添加 Dropbox / WebDAV…</GhostBtn>
          </div>
          {protonMsg && (
            <div className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
              {protonMsg.text}
              {protonMsg.url && (
                <button onClick={() => void api.openExternal(protonMsg.url!)} className="ml-1 underline underline-offset-2" style={{ color: 'var(--fg)' }}>
                  下载 Proton Drive
                </button>
              )}
            </div>
          )}
        </>
      ) : g.count ? (
        <>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--fg)' }}>
            {span}有 <b className="tnum">{g.count}</b> 个附件（{fmtBytes(g.bytes)}）未归档{cats ? `，其中${cats}` : ''}。
            {g.releasableBytes > 0 && target ? (
              <>
                {' '}归档到 {target.name} 后可释放 <b className="tnum">{fmtBytes(g.releasableBytes)}</b> 本地空间。
              </>
            ) : null}
          </p>
          {g.needDownload > 0 && <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>其中 {g.needDownload} 个还没下载，归档时会先从邮箱拉取。</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <PrimaryBtn onClick={props.onArchive}>
              <IconCloud width={14} height={14} /> 预览并归档
            </PrimaryBtn>
            {props.releasable && props.releasable.count > 0 && (
              <GhostBtn onClick={props.onRelease}>可释放 {fmtBytes(props.releasable.bytes)}…</GhostBtn>
            )}
          </div>
          {props.job?.state === 'done' && (
            <div className="mt-2 text-2xs" style={{ color: 'var(--faint)' }}>
              上次归档：上传 {props.job.uploaded} · 跳过 {props.job.skipped}{props.job.failed.length ? ` · 失败 ${props.job.failed.length}` : ''}
            </div>
          )}
        </>
      ) : (
        <>
          <p className="mt-2 text-sm flex items-center gap-1.5" style={{ color: 'var(--fg)' }}>
            <span style={{ color: 'var(--ok)' }}><IconCheck width={14} height={14} /></span> 附件都已归档。
          </p>
          {props.releasable && props.releasable.count > 0 && (
            <div className="mt-3">
              <GhostBtn onClick={props.onRelease}>按缓存策略可释放 {fmtBytes(props.releasable.bytes)}…</GhostBtn>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

function FileGlyph(props: { it: AttachmentItem; thumb?: string; big?: boolean }) {
  const { it } = props
  if (props.thumb) return <img src={props.thumb} alt="" className="w-full h-full object-cover" draggable={false} loading="lazy" decoding="async" />
  return (
    <span className="flex flex-col items-center justify-center gap-1" style={{ color: 'var(--faint)' }}>
      <span
        className={`${props.big ? 'text-sm px-2 py-1' : 'text-2xs px-1.5 py-0.5'} font-semibold rounded-[var(--r-xs)] border`}
        style={{ fontFamily: 'var(--font-mono)', borderColor: 'var(--border-strong)', color: 'var(--muted)', background: 'var(--surface-strong)' }}
      >
        {extBadge(it.ext, it.category)}
      </span>
    </span>
  )
}

function StateTag(props: { it: AttachmentItem }) {
  const { it } = props
  if (it.cloud.length) {
    return (
      <span className="inline-flex items-center gap-1 truncate" style={{ color: 'var(--info-ink)' }} title={it.cloud.map(c => `${c.driveName}：${c.path}`).join('\n')}>
        <IconCloud width={10} height={10} /> {cloudLabel(it.cloud)}
        {!it.cached && !it.remoteOnly && <span style={{ color: 'var(--faint)' }}>· 本地已释放</span>}
      </span>
    )
  }
  if (it.remoteOnly) return <span style={{ color: 'var(--faint)' }}>未下载</span>
  if (!it.cached) return <span style={{ color: 'var(--faint)' }}>已释放</span>
  return null
}

function GridCard(props: {
  it: AttachmentItem
  thumb?: string
  selected: boolean
  focused: boolean
  selecting: boolean
  onClick(e: React.MouseEvent): void
  onToggle(): void
  onOpen(): void
}) {
  const { it } = props
  return (
    <div
      onClick={props.onClick}
      onDoubleClick={props.onOpen}
      className="group relative rounded-[var(--r-md)] border overflow-hidden cursor-default transition-colors"
      style={{
        background: 'var(--surface-strong)',
        borderColor: props.selected || props.focused ? 'var(--accent)' : 'var(--border)',
        boxShadow: props.selected ? '0 0 0 1px var(--accent)' : undefined
      }}
    >
      <div className="relative h-[104px] flex items-center justify-center overflow-hidden" style={{ background: 'var(--bg-soft)' }}>
        <FileGlyph it={it} thumb={props.thumb} />
        {it.pinned && (
          <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full inline-flex items-center justify-center" style={{ background: 'var(--surface-strong)', color: 'var(--fg)' }} title="已钉住">
            <IconPin width={10} height={10} />
          </span>
        )}
        {it.categorySource === 'ai' && (
          <span className="absolute bottom-1.5 right-1.5 text-2xs h-4 px-1 rounded-[var(--r-xs)] inline-flex items-center gap-0.5" style={{ background: 'var(--ai)', color: 'var(--ai-ink)' }} title="AI 补充分类">
            <IconSparkles width={9} height={9} /> AI
          </span>
        )}
      </div>
      <button
        onClick={e => {
          e.stopPropagation()
          props.onToggle()
        }}
        aria-label={props.selected ? '取消选择' : '选择'}
        className={`absolute top-1.5 left-1.5 w-5 h-5 rounded-[var(--r-xs)] border inline-flex items-center justify-center transition-opacity ${props.selected || props.selecting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        style={props.selected ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--on-accent)' } : { background: 'var(--surface-strong)', borderColor: 'var(--border-strong)' }}
      >
        {props.selected && <IconCheck width={11} height={11} />}
      </button>
      <div className="px-2.5 py-2">
        <div className="text-xs font-medium truncate" style={{ color: 'var(--fg)' }} title={it.filename}>{it.filename}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-2xs tnum" style={{ color: 'var(--faint)' }}>
          <span className="truncate">{it.counterparty}</span>
          <span className="shrink-0">· {fmtDay(it.date)}</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-2xs tnum min-w-0">
          <span className="shrink-0" style={{ color: 'var(--muted)' }}>{fmtBytes(it.size)}</span>
          <span className="min-w-0 truncate"><StateTag it={it} /></span>
        </div>
      </div>
    </div>
  )
}

function ListRow(props: { it: AttachmentItem; selected: boolean; focused: boolean; onClick(e: React.MouseEvent): void; onToggle(): void; onOpen(): void }) {
  const { it } = props
  return (
    <div
      onClick={props.onClick}
      onDoubleClick={props.onOpen}
      className="group h-10 flex items-center gap-3 px-3 border-b cursor-default hover:bg-[var(--hover)]"
      style={{ borderColor: 'var(--border-soft)', background: props.selected || props.focused ? 'var(--selected)' : undefined }}
    >
      <button
        onClick={e => {
          e.stopPropagation()
          props.onToggle()
        }}
        aria-label={props.selected ? '取消选择' : '选择'}
        className="w-4 h-4 shrink-0 rounded-[var(--r-xs)] border inline-flex items-center justify-center"
        style={props.selected ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--on-accent)' } : { borderColor: 'var(--border-strong)' }}
      >
        {props.selected && <IconCheck width={10} height={10} />}
      </button>
      <span className="w-10 shrink-0 text-center text-2xs font-semibold" style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{extBadge(it.ext, it.category)}</span>
      <span className="flex-1 min-w-[140px] truncate text-sm" style={{ color: 'var(--fg)' }} title={it.filename}>
        {it.pinned && <span className="inline-block mr-1 align-[-1px]" style={{ color: 'var(--muted)' }}><IconPin width={10} height={10} /></span>}
        {it.filename}
      </span>
      <span className="hidden @3xl:block w-[120px] shrink-0 truncate text-xs" style={{ color: 'var(--muted)' }}>{it.counterparty}</span>
      <span className="hidden @4xl:block w-[72px] shrink-0 truncate text-xs" style={{ color: 'var(--muted)' }}>
        {attachmentCategoryLabel(it.category)}
        {it.categorySource === 'ai' && <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full align-middle" style={{ background: 'var(--ai)' }} title="AI 补充分类" />}
      </span>
      <span className="hidden @xl:block w-[172px] shrink-0 truncate text-2xs"><StateTag it={it} /></span>
      <span className="w-[64px] shrink-0 text-right text-xs tnum" style={{ color: 'var(--muted)' }}>{fmtBytes(it.size)}</span>
      <span className="w-[72px] shrink-0 text-right text-xs tnum" style={{ color: 'var(--faint)' }}>{fmtDay(it.date)}</span>
    </div>
  )
}

function Detail(props: {
  it: AttachmentItem
  thumb?: string
  onClose(): void
  onOpen(): void
  onSave(): void
  onMail(): void
  onArchive(): void
  onRelease(): void
}) {
  const { it } = props
  const acc = useMail(st => st.accounts.find(a => a.id === it.accountId))
  const Row = (p: { k: string; v: React.ReactNode }) => (
    <div className="flex gap-2 py-1 text-xs">
      <span className="w-12 shrink-0" style={{ color: 'var(--faint)' }}>{p.k}</span>
      <span className="flex-1 min-w-0 break-words" style={{ color: 'var(--fg)' }}>{p.v}</span>
    </div>
  )
  return (
    <aside className="w-[300px] shrink-0 h-full overflow-y-auto border-l" style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)' }} aria-label="附件详情">
      <div className="relative h-[168px] flex items-center justify-center overflow-hidden" style={{ background: 'var(--bg-soft)' }}>
        <FileGlyph it={it} thumb={props.thumb} big />
        <button onClick={props.onClose} aria-label="关闭详情" className="absolute top-2 right-2 icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--faint)', background: 'var(--surface-strong)' }}>
          <IconClose width={12} height={12} />
        </button>
      </div>
      <div className="p-4">
        <div className="text-sm font-semibold break-words" style={{ color: 'var(--fg)' }}>{it.filename}</div>
        <div className="mt-1 text-2xs tnum" style={{ color: 'var(--faint)' }}>
          {fmtBytes(it.size)} · {it.remoteOnly ? '还没下载（只有元数据）' : it.cached ? '本地已缓存' : '本地缓存已释放，打开时自动重新下载'}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <PrimaryBtn onClick={props.onOpen}>打开</PrimaryBtn>
          <GhostBtn onClick={props.onSave}><IconSave width={13} height={13} /> 保存</GhostBtn>
          <GhostBtn onClick={props.onMail}><IconMailDot width={13} height={13} /> 原邮件</GhostBtn>
        </div>
        <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border-soft)' }}>
          <Row
            k="分类"
            v={
              <span className="inline-flex items-center gap-1.5">
                <select
                  value={it.category}
                  onChange={e => void api.attachSetCategory([it.id], e.target.value as AttachmentCategory)}
                  className="text-xs bg-transparent outline-none -ml-0.5"
                  style={{ color: 'var(--fg)' }}
                  aria-label="分类"
                >
                  {ATTACHMENT_CATEGORIES.map(c => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
                {it.categorySource === 'ai' && (
                  <span className="text-2xs h-4 px-1 rounded-[var(--r-xs)] inline-flex items-center" style={{ background: 'var(--ai)', color: 'var(--ai-ink)' }}>AI</span>
                )}
                {it.categorySource === 'manual' && <span className="text-2xs" style={{ color: 'var(--faint)' }}>手动</span>}
              </span>
            }
          />
          <Row k={it.direction === 'out' ? '发给' : '来自'} v={<>{it.counterparty}{it.counterpartyAddr && <span className="block text-2xs" style={{ color: 'var(--faint)' }}>{it.counterpartyAddr}</span>}</>} />
          <Row k="邮件" v={<button onClick={props.onMail} className="text-left hover:underline">{it.subject || '（无主题）'}</button>} />
          <Row k="时间" v={new Date(it.date).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} />
          {acc && <Row k="账户" v={<span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: acc.color }} />{acc.name}</span>} />}
        </div>
        <AttachmentTextSection id={it.id} filename={it.filename} contentType={it.contentType} />
        <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="caps mb-1.5" style={{ color: 'var(--faint)' }}>网盘</div>
          {it.cloud.length ? (
            <div className="flex flex-col gap-2">
              {it.cloud.map(c => (
                <div key={c.driveId + c.path} className="text-xs">
                  <div className="flex items-center gap-1.5" style={{ color: 'var(--info-ink)' }}>
                    <IconCloud width={12} height={12} /> 已在 {c.driveName}
                  </div>
                  <div className="mt-0.5 text-2xs break-all" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{c.path}</div>
                  <button
                    onClick={() => void api.attachReveal(it.id, c.driveId).then(r => !r.ok && toast(r.error ?? '无法打开'))}
                    className="mt-1 text-2xs hover:underline"
                    style={{ color: 'var(--fg)' }}
                  >
                    {c.kind === 'local' ? '在 Finder 中显示' : '打开云端位置'}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs" style={{ color: 'var(--faint)' }}>还没有归档。</div>
          )}
          <div className="mt-3 flex flex-wrap gap-1.5">
            <GhostBtn onClick={props.onArchive}><IconCloud width={13} height={13} /> 归档…</GhostBtn>
            <GhostBtn onClick={() => void api.attachPin([it.id], !it.pinned)}>
              <IconPin width={13} height={13} /> {it.pinned ? '取消钉住' : '钉住'}
            </GhostBtn>
            {it.cached && <GhostBtn onClick={props.onRelease}>释放本地缓存</GhostBtn>}
          </div>
        </div>
      </div>
    </aside>
  )
}

function BarBtn(props: { onClick(): void; label: string; icon?: React.ReactNode; primary?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      className={`h-7 px-2.5 rounded-[var(--r-sm)] text-xs inline-flex items-center gap-1.5 transition-colors ${props.primary ? 'hover:opacity-90' : 'hover:bg-[var(--hover)]'}`}
      style={props.primary ? { background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 500 } : { color: 'var(--fg)' }}
    >
      {props.icon}
      {props.label}
    </button>
  )
}

function CategoryMenu(props: { onPick(c: AttachmentCategory): void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <BarBtn onClick={() => setOpen(o => !o)} label="改分类" />
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-9 left-0 z-20 w-36 liquid-glass rounded-[var(--r-sm)] py-1 pop-in">
            {ATTACHMENT_CATEGORIES.map(c => (
              <button
                key={c.id}
                onClick={() => {
                  setOpen(false)
                  props.onPick(c.id)
                }}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--hover)]"
                style={{ color: 'var(--fg)' }}
              >
                {c.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function EmptyState(props: { filtered: boolean; total: number }) {
  return (
    <div className="mt-16 flex flex-col items-center text-center gap-2">
      <span className="w-10 h-10 rounded-full inline-flex items-center justify-center" style={{ background: 'var(--hover)', color: 'var(--faint)' }}>
        <IconAttach width={16} height={16} />
      </span>
      <div className="text-sm" style={{ color: 'var(--muted)' }}>
        {props.filtered ? '没有符合条件的附件' : props.total ? '这里还空着' : '还没有附件'}
      </div>
      {!props.filtered && (
        <div className="text-xs max-w-[320px]" style={{ color: 'var(--faint)' }}>
          同步到带附件的邮件后会自动建立索引并分类；尚未下载的附件也会列出来。
        </div>
      )}
      {!props.filtered && (
        <button onClick={() => void api.attachRescan()} className="mt-1 text-xs inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--fg)' }}>
          <IconRefresh width={11} height={11} /> 重新扫描
        </button>
      )}
    </div>
  )
}

function DupSheet(props: { stats: AttachmentStats; onClose(): void; onRelease(ids: string[]): void }) {
  // 每组保留第一份，其余的建议释放（同内容只留一份本地缓存）
  const extra = props.stats.duplicates.flatMap(d => d.items.slice(1).map(i => i.id))
  return (
    <Sheet
      title="重复文件"
      sub="内容完全相同（哈希一致）的附件：每组保留一份本地缓存即可"
      onClose={props.onClose}
      footer={
        <>
          <span className="flex-1 text-xs tnum" style={{ color: 'var(--muted)' }}>
            {props.stats.duplicates.length} 组 · 可省 {fmtBytes(props.stats.duplicates.reduce((s, d) => s + d.wasted, 0))}
          </span>
          <GhostBtn onClick={props.onClose}>关闭</GhostBtn>
          <PrimaryBtn onClick={() => props.onRelease(extra)} disabled={!extra.length}>释放多余的副本…</PrimaryBtn>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {props.stats.duplicates.map(d => (
          <div key={d.hash} className="rounded-[var(--r-md)] border p-3" style={{ borderColor: 'var(--border)' }}>
            <div className="text-xs tnum" style={{ color: 'var(--muted)' }}>{d.count} 份 · 每份 {fmtBytes(d.size)}</div>
            {d.items.map((i, k) => (
              <div key={i.id} className="mt-1 text-sm truncate" style={{ color: k ? 'var(--muted)' : 'var(--fg)' }}>
                {i.filename}
                {k === 0 && <span className="ml-1.5 text-2xs" style={{ color: 'var(--faint)' }}>保留</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Sheet>
  )
}
