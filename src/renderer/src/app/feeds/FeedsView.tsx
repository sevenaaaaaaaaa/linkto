import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { getPrefs } from '../../lib/prefs'
import { feedScopeFromHash, fmtFeedTime, groupSources, hostOf, openFeeds, scopeLabel, unreadOf, useFeedEvents, useFeeds } from '../../lib/feeds'
import { MenuButton, type MenuItem } from '../../components/Menu'
import { FeedReader } from './FeedReader'
import { scopeKey, type FeedCandidate, type FeedDigest, type FeedItem } from '@shared/feeds'
import {
  IconCheck, IconChevronDown, IconClose, IconFolder, IconLink, IconMailDot, IconMore, IconPlus, IconRefresh, IconRss, IconSearch, IconSettings, IconSparkles, IconStar
} from '../../components/icons'

/**
 * 订阅视图（#/feeds）：条目列表沿用邮件列表的视觉与操作习惯（未读点 / 已读、收藏、J/K、全部已读），右侧是独立的订阅阅读区。
 * 快捷键只在本视图内生效（捕获阶段处理并阻止继续传给邮件的全局快捷键）。
 */

const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

function FilterTabs() {
  const filter = useFeeds(st => st.filter)
  const setFilter = useFeeds(st => st.setFilter)
  const tabs: { key: typeof filter; label: string }[] = [
    { key: 'unread', label: '未读' },
    { key: 'all', label: '全部' },
    { key: 'starred', label: '收藏' }
  ]
  return (
    <div className="no-drag shrink-0 flex items-center p-0.5 rounded-[var(--r-sm)]" style={{ background: 'var(--hover)' }} role="tablist">
      {tabs.map(t => {
        const on = filter === t.key
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={on}
            onClick={() => setFilter(t.key)}
            className="h-6 px-2 rounded-[var(--r-xs)] text-xs transition-colors"
            style={on ? { background: 'var(--surface-strong)', color: 'var(--fg)', fontWeight: 500, boxShadow: 'var(--shadow-sm)' } : { color: 'var(--muted)' }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

function ItemRow(props: { item: FeedItem; selected: boolean; showSource: boolean; onSelect(): void }) {
  const it = props.item
  const [hover, setHover] = useState(false)
  const st = useFeeds.getState
  return (
    <div
      onClick={props.onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-selected={props.selected}
      data-feed-item={it.id}
      className="relative flex gap-2.5 pl-4 pr-3 py-[var(--row-py)] border-b border-[var(--border-soft)] cursor-default transition-colors"
      style={{ background: props.selected ? 'var(--selected)' : hover ? 'var(--hover)' : 'transparent' }}
    >
      <div className="relative w-4 h-[18px] shrink-0 flex items-center justify-center">
        {!it.read && <span className="w-2 h-2 rounded-full" style={{ background: 'var(--accent)' }} aria-label="未读" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 h-[18px]">
          <span className={`truncate text-xs ${it.read ? '' : 'font-medium'}`} style={{ color: it.read ? 'var(--faint)' : 'var(--muted)' }}>
            {props.showSource ? it.sourceTitle || hostOf(it.url) : it.author || hostOf(it.url) || it.sourceTitle}
          </span>
          {it.kind === 'brief' && <span className="text-2xs px-1 h-4 inline-flex items-center rounded-[var(--r-xs)] shrink-0 ai-chip">AI 简报</span>}
          {it.starred && <IconStar width={11} height={11} className="shrink-0" style={{ color: 'var(--warn)' }} />}
          {!hover && (
            <span className="ml-auto shrink-0 text-xs tnum" style={{ color: it.read ? 'var(--faint)' : 'var(--fg)', fontFamily: 'var(--font-mono)' }}>
              {fmtFeedTime(it.publishedAt ?? it.sortAt)}
            </span>
          )}
        </div>
        <div className={`mt-0.5 text-sm leading-snug line-clamp-2 ${it.read ? '' : 'font-semibold'}`} style={{ color: it.read ? 'var(--muted)' : 'var(--fg)' }}>
          {it.title}
        </div>
        {(it.aiSummary || it.summary) && (
          <div className="mt-0.5 truncate text-xs" style={{ color: 'var(--faint)' }}>
            {(it.aiSummary?.replace(/^一句话[:：]\s*/, '').split('\n')[0] || it.summary).slice(0, 160)}
          </div>
        )}
      </div>
      {hover && (
        <div className="absolute right-2 top-1.5 flex items-center gap-0.5 p-0.5 rounded-[var(--r-sm)] liquid-glass fade-in">
          <QuickBtn title={it.starred ? '取消收藏（S）' : '收藏（S）'} active={it.starred} onClick={() => void st().toggleStar(it.id)}>
            <IconStar width={13} height={13} />
          </QuickBtn>
          <QuickBtn title={it.read ? '标为未读（M）' : '标为已读（M）'} onClick={() => void st().setRead(it.id, !it.read)}>
            <IconMailDot width={13} height={13} />
          </QuickBtn>
          {it.url && (
            <QuickBtn title="打开原文（O）" onClick={() => void api.openExternal(it.url!)}>
              <IconLink width={13} height={13} />
            </QuickBtn>
          )}
        </div>
      )}
    </div>
  )
}

function QuickBtn(props: { title: string; onClick(): void; children: React.ReactNode; active?: boolean }) {
  return (
    <button
      title={props.title}
      onClick={e => {
        e.stopPropagation()
        props.onClick()
      }}
      className="w-6 h-6 inline-flex items-center justify-center rounded-[var(--r-xs)] transition-colors hover:bg-[var(--hover-strong)]"
      style={{ color: props.active ? 'var(--warn)' : 'var(--muted)' }}
    >
      {props.children}
    </button>
  )
}

/** 添加订阅：粘贴订阅地址或网站地址（自动发现）；多个候选时让用户选 */
function AddFeedPopover(props: { onClose(): void }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [cands, setCands] = useState<FeedCandidate[]>([])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) props.onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [props])
  const add = async (target: string) => {
    if (!target.trim() || busy) return
    setBusy(true)
    setError('')
    const r = await api.feedAddSource({ url: target.trim() })
    setBusy(false)
    if (r.ok && r.source) {
      toast(`已订阅「${r.source.title}」${r.added ? `，${r.added} 篇` : ''}`)
      props.onClose()
      openFeeds({ kind: 'source', id: r.source.id })
      return
    }
    if (r.candidates?.length) {
      setCands(r.candidates)
      setError(r.error || '')
      return
    }
    if (r.existing) {
      toast(`已经订阅过「${r.existing.title}」`)
      props.onClose()
      openFeeds({ kind: 'source', id: r.existing.id })
      return
    }
    setError(r.error || '添加失败')
  }
  return (
    <div ref={ref} className="absolute top-full right-2 mt-1.5 z-40 w-[320px] liquid-glass rounded-[var(--r-md)] p-3 pop-in" onKeyDown={e => e.key === 'Escape' && props.onClose()}>
      <div className="text-xs font-medium mb-2" style={{ color: 'var(--fg)' }}>添加订阅</div>
      <form
        onSubmit={e => {
          e.preventDefault()
          void add(url)
        }}
        className="flex gap-1.5"
      >
        <input
          autoFocus
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="RSS 地址或网站地址"
          className="flex-1 min-w-0 h-8 px-2.5 rounded-[var(--r-sm)] text-sm outline-none border border-[var(--border-soft)]"
          style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
        />
        <button type="submit" disabled={busy || !url.trim()} className="h-8 px-3 rounded-[var(--r-sm)] text-xs font-semibold disabled:opacity-50" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          {busy ? '检查中…' : '订阅'}
        </button>
      </form>
      {error && <div className="mt-2 text-xs leading-relaxed" style={{ color: cands.length ? 'var(--muted)' : 'var(--danger)' }}>{error}</div>}
      {cands.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {cands.map(c => (
            <button key={c.url} onClick={() => void add(c.url)} disabled={busy} className="w-full text-left px-2 py-1.5 rounded-[var(--r-sm)] hover:bg-[var(--hover)]">
              <div className="text-xs font-medium truncate" style={{ color: 'var(--fg)' }}>{c.title || c.url}</div>
              <div className="text-2xs truncate" style={{ color: 'var(--faint)' }}>{c.url}</div>
            </button>
          ))}
        </div>
      )}
      <div className="mt-2.5 pt-2 border-t border-[var(--border-soft)] flex items-center gap-3 text-xs">
        <button onClick={() => void api.feedImportOpml().then(r => r.ok && toast(`导入 ${r.added} 个订阅源${r.skipped ? `，跳过 ${r.skipped} 个已有的` : ''}`))} className="hover:underline" style={{ color: 'var(--accent-ink)' }}>
          导入 OPML
        </button>
        <button onClick={() => api.openSettings('feeds')} className="hover:underline" style={{ color: 'var(--accent-ink)' }}>
          AI 搜索订阅 · 管理
        </button>
      </div>
    </div>
  )
}

function EmptyState() {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const add = async () => {
    if (!url.trim()) return
    setBusy(true)
    setError('')
    const r = await api.feedAddSource({ url: url.trim() })
    setBusy(false)
    if (r.ok && r.source) openFeeds({ kind: 'source', id: r.source.id })
    else if (r.candidates?.length) {
      const pick = await api.feedAddSource({ url: r.candidates[0].url })
      if (pick.ok && pick.source) openFeeds({ kind: 'source', id: pick.source.id })
      else setError(pick.error || '添加失败')
    } else setError(r.error || '添加失败')
  }
  return (
    <div className="flex-1 min-w-0 h-full flex flex-col">
      <div className="drag-region native-web-titlebar h-[var(--titlebar-h)] shrink-0" />
      <div className="flex-1 flex items-center justify-center px-8">
        <div className="max-w-[440px] w-full">
          <span className="w-10 h-10 rounded-[var(--r-md)] inline-flex items-center justify-center ai-chip">
            <IconRss width={18} height={18} />
          </span>
          <h2 className="mt-4 text-lg font-semibold" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>把正式信息收进一个入口</h2>
          <p className="mt-1.5 text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
            订阅博客、媒体、官方公告的 RSS，或者让 AI 每天替你搜一个主题（行业动态、某家公司、某项技术），像处理邮件一样读完、收藏、转待办、存知识库。
          </p>
          <form
            onSubmit={e => {
              e.preventDefault()
              void add()
            }}
            className="mt-5 flex gap-2"
          >
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="粘贴 RSS 地址或网站地址（自动发现订阅）"
              className="flex-1 min-w-0 h-9 px-3 rounded-[var(--r-sm)] text-sm outline-none border border-[var(--border-soft)]"
              style={{ background: 'var(--surface-strong)', color: 'var(--fg)' }}
            />
            <button type="submit" disabled={busy || !url.trim()} className="h-9 px-4 rounded-[var(--r-sm)] text-sm font-semibold disabled:opacity-50" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
              {busy ? '检查中…' : '订阅'}
            </button>
          </form>
          {error && <div className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>{error}</div>}
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <button onClick={() => void api.feedImportOpml().then(r => r.ok && toast(`导入 ${r.added} 个订阅源`))} className="h-8 px-3 rounded-[var(--r-sm)] border border-[var(--border-soft)] hover:bg-[var(--hover)]" style={{ color: 'var(--fg)' }}>
              导入 OPML
            </button>
            <button onClick={() => api.openSettings('feeds')} className="h-8 px-3 rounded-[var(--r-sm)] border border-[var(--border-soft)] hover:bg-[var(--hover)] inline-flex items-center gap-1.5" style={{ color: 'var(--fg)' }}>
              <IconSparkles width={12} height={12} />
              添加 AI 搜索订阅
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 今日精华（范围 = digest 时显示在阅读区） */
function DigestPanel() {
  const [d, setD] = useState<FeedDigest | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void api.feedDigest().then(setD)
  }, [])
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    shadow.innerHTML = d
      ? `<style>:host{all:initial;display:block;font-family:var(--font-body);font-size:14.5px;line-height:1.75;color:var(--fg)} a{color:var(--accent-ink)} h4{margin:1.1em 0 .4em;color:var(--muted);font-size:.9em} ul,ol{padding-left:1.3em} li{margin:.35em 0} small{color:var(--faint)}</style><div id="b">${d.html}</div>`
      : ''
    shadow.getElementById('b')?.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest('a')
      if (a) {
        e.preventDefault()
        if (/^https?:/i.test(a.href)) void api.openExternal(a.href)
      }
    })
  }, [d])
  const gen = async () => {
    setBusy(true)
    setError('')
    const r = await api.feedGenerateDigest()
    setBusy(false)
    if (r.ok && r.digest) setD(r.digest)
    else setError(r.error || '没有生成')
  }
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return (
    <div className="flex-1 min-w-0 h-full flex flex-col">
      <div className="drag-region h-[var(--titlebar-h)] shrink-0 flex items-center px-4 border-b border-[var(--border-soft)]">
        <div className="flex-1" />
        <button onClick={() => void gen()} disabled={busy} className="no-drag h-8 px-3 rounded-[var(--r-sm)] inline-flex items-center gap-1.5 text-xs font-semibold disabled:opacity-50" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          <IconSparkles width={13} height={13} className={busy ? 'spinning' : ''} />
          {busy ? '生成中…' : d?.day === todayKey ? '重新生成' : '生成今日精华'}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto" style={{ maxWidth: 'var(--reader-max)' }}>
          <div className="text-xs" style={{ color: 'var(--faint)' }}>
            今日订阅精华{d ? ` · ${d.day}${d.day !== todayKey ? '（不是今天的）' : ''} · ${d.count} 篇 · ${d.source === 'ai' ? 'AI 归纳' : '按来源列出'}` : ''}
          </div>
          {error && <div className="mt-3 text-sm" style={{ color: 'var(--danger)' }}>{error}</div>}
          {!d && !error && <div className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>还没有精华。点右上角生成一份：把最近 24 小时的新文章归纳成几个主题（可在 设置 → 订阅 里每天自动生成）。</div>}
          <div className={d ? 'mt-3 rounded-[var(--r-md)] px-6 py-5' : ''} style={d ? { background: 'var(--surface-strong)', border: '1px solid var(--border-soft)' } : undefined}>
            <div ref={hostRef} className="selectable" />
          </div>
        </div>
      </div>
    </div>
  )
}

export function FeedsView() {
  useFeedEvents()
  const sources = useFeeds(st => st.sources)
  const loaded = useFeeds(st => st.loaded)
  const scope = useFeeds(st => st.scope)
  const items = useFeeds(st => st.items)
  const loading = useFeeds(st => st.loadingItems)
  const selectedId = useFeeds(st => st.selectedId)
  const q = useFeeds(st => st.q)
  const filter = useFeeds(st => st.filter)
  const [query, setQuery] = useState(q)
  const [adding, setAdding] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)

  // 路由 → 范围
  useEffect(() => {
    const on = () => useFeeds.getState().setScope(feedScopeFromHash())
    on()
    void useFeeds.getState().loadItems()
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  // 选中项滚动到可见
  useEffect(() => {
    if (!selectedId) return
    listRef.current?.querySelector(`[data-feed-item="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    const st = useFeeds.getState()
    const ids = scope.kind === 'source' ? [scope.id] : scope.kind === 'group' ? sources.filter(s => s.group === scope.name).map(s => s.id) : null
    const topicIds = scope.kind === 'topics' ? sources.filter(s => s.kind === 'search').map(s => s.id) : scope.kind === 'source' && sources.find(s => s.id === scope.id)?.kind === 'search' ? [scope.id] : []
    try {
      if (topicIds.length) {
        let fresh = 0
        for (const id of topicIds) fresh += (await api.feedRunTopic(id)).fresh
        toast(fresh ? `AI 搜索：${fresh} 条新结果` : 'AI 搜索：没有新结果')
      } else {
        const r = await api.feedRefresh(ids)
        toast(r.failed && !r.updated && !r.notModified ? `更新失败：${r.error ?? `${r.failed} 个源`}` : r.added ? `新增 ${r.added} 篇` : '没有新内容')
      }
    } finally {
      setRefreshing(false)
      await st.loadSources()
      await st.loadItems({ keepSticky: true })
    }
  }

  const markAll = async () => {
    const n = await useFeeds.getState().markAllRead()
    toast(n ? `已将 ${n} 篇标为已读` : '没有未读')
  }

  // 订阅视图内的快捷键（捕获阶段，处理后不再传给邮件的全局快捷键）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (/^[a-zA-Z]$/.test(e.key) && !getPrefs().singleKey) return
      const st = useFeeds.getState()
      const sel = st.items.find(i => i.id === st.selectedId)
      let handled = true
      if (e.key === 'j' || e.key === 'ArrowDown') st.move(1)
      else if (e.key === 'k' || e.key === 'ArrowUp') st.move(-1)
      else if ((e.key === 's' || e.key === 'S') && !e.shiftKey && sel) void st.toggleStar(sel.id)
      else if ((e.key === 'm' || e.key === 'M') && sel) void st.setRead(sel.id, !sel.read)
      else if ((e.key === 'o' || e.key === 'Enter') && sel?.url) void api.openExternal(sel.url)
      else if ((e.key === 'f' || e.key === 'F') && sel) window.dispatchEvent(new CustomEvent('ms:feed-action', { detail: 'full' }))
      else if (e.key === 'A' && e.shiftKey) void markAll()
      else if (e.key === 'Escape' && st.selectedId) st.select(null)
      else handled = false
      if (handled) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loaded && !sources.length) return <EmptyState />

  const groups = groupSources(sources)
  const topics = sources.filter(s => s.kind === 'search')
  const scopeItems: MenuItem[] = [
    { kind: 'check', label: `全部订阅（${unreadOf(sources)}）`, checked: scope.kind === 'all', onSelect: () => openFeeds() },
    { kind: 'check', label: '今日精华', icon: <IconSparkles width={13} height={13} />, checked: scope.kind === 'digest', onSelect: () => openFeeds({ kind: 'digest' }) },
    { kind: 'check', label: '收藏', icon: <IconStar width={13} height={13} />, checked: scope.kind === 'starred', onSelect: () => openFeeds({ kind: 'starred' }) },
    ...(topics.length
      ? [
          { kind: 'sep' as const },
          { kind: 'check' as const, label: 'AI 搜索订阅', icon: <IconSearch width={13} height={13} />, checked: scope.kind === 'topics', onSelect: () => openFeeds({ kind: 'topics' }) },
          ...topics.map(t => ({ kind: 'check' as const, label: `　${t.title}${t.unread ? `（${t.unread}）` : ''}`, checked: scope.kind === 'source' && scope.id === t.id, onSelect: () => openFeeds({ kind: 'source', id: t.id }) }))
        ]
      : []),
    ...groups.flatMap(g => [
      { kind: 'sep' as const },
      ...(g.name ? [{ kind: 'check' as const, label: `${g.name}${g.unread ? `（${g.unread}）` : ''}`, icon: <IconFolder width={13} height={13} />, checked: scope.kind === 'group' && scope.name === g.name, onSelect: () => openFeeds({ kind: 'group', name: g.name! }) }] : [{ kind: 'label' as const, label: '未分组' }]),
      ...g.sources.map(s => ({
        kind: 'check' as const,
        label: `${g.name ? '　' : ''}${s.title}${s.unread ? `（${s.unread}）` : ''}${s.lastError && s.failCount > 1 ? ' · 更新失败' : ''}`,
        checked: scope.kind === 'source' && scope.id === s.id,
        onSelect: () => openFeeds({ kind: 'source', id: s.id })
      }))
    ])
  ]
  const moreItems: MenuItem[] = [
    { kind: 'action', label: '全部标为已读', icon: <IconCheck width={13} height={13} />, hint: '⇧A', onSelect: () => void markAll() },
    { kind: 'sep' },
    { kind: 'action', label: '导入 OPML…', onSelect: () => void api.feedImportOpml().then(r => r.ok && toast(`导入 ${r.added} 个订阅源${r.skipped ? `，跳过 ${r.skipped} 个` : ''}`)) },
    { kind: 'action', label: '导出 OPML…', onSelect: () => void api.feedExportOpml().then(r => r.ok && toast(`已导出 ${r.count} 个订阅源`)) },
    { kind: 'sep' },
    { kind: 'action', label: '管理订阅与 AI 搜索…', icon: <IconSettings width={13} height={13} />, onSelect: () => api.openSettings('feeds') }
  ]
  const currentSource = scope.kind === 'source' ? sources.find(s => s.id === scope.id) : null
  const unreadInList = items.filter(i => !i.read).length

  return (
    <>
      <div className="surface relative w-[var(--list-w)] min-w-[300px] shrink-0 h-full flex flex-col border-r border-[var(--border-soft)]" data-feeds-list>
        <div className="drag-region h-[var(--titlebar-h)] shrink-0 flex items-center gap-2 px-3">
          <div className="no-drag relative flex-1 h-7 flex items-center gap-1.5 rounded-[var(--r-sm)] px-2 border border-[var(--border-soft)] focus-within:shadow-[var(--focus-ring)]" style={{ background: 'var(--bg-soft)' }}>
            <IconSearch width={14} height={14} style={{ color: 'var(--faint)' }} />
            <input
              value={query}
              onChange={e => {
                const v = e.target.value
                setQuery(v)
                window.clearTimeout(timer.current)
                timer.current = window.setTimeout(() => useFeeds.getState().setQuery(v), 250)
              }}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  setQuery('')
                  useFeeds.getState().setQuery('')
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              placeholder="搜索订阅"
              aria-label="搜索订阅"
              className="flex-1 min-w-0 bg-transparent outline-none text-sm placeholder:text-[var(--faint)]"
            />
            {query && (
              <button
                onClick={() => {
                  setQuery('')
                  useFeeds.getState().setQuery('')
                }}
                aria-label="清空"
                style={{ color: 'var(--faint)' }}
              >
                <IconClose width={12} height={12} />
              </button>
            )}
          </div>
          <div className="relative no-drag">
            <button onClick={() => setAdding(a => !a)} title="添加订阅" aria-label="添加订阅" className="icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--muted)' }}>
              <IconPlus width={15} height={15} />
            </button>
            {adding && <AddFeedPopover onClose={() => setAdding(false)} />}
          </div>
        </div>

        <div className="shrink-0 h-[var(--toolbar-h)] flex items-center gap-1 pl-3 pr-2 border-b border-[var(--border-soft)]">
          <MenuButton title="切换订阅源" items={scopeItems} width={260} align="left">
            <span className="inline-flex items-center gap-1 max-w-[150px]">
              <span className="text-sm font-semibold truncate tight" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>{scopeLabel(scope, sources)}</span>
              <IconChevronDown width={11} height={11} style={{ color: 'var(--faint)' }} />
            </span>
          </MenuButton>
          {scope.kind !== 'digest' && unreadInList > 0 && <span className="text-xs tnum shrink-0" style={{ color: 'var(--faint)' }}>{unreadInList}</span>}
          <div className="flex-1" />
          {scope.kind !== 'digest' && <FilterTabs />}
          <button onClick={() => void refresh()} disabled={refreshing} title={topics.length && (scope.kind === 'topics' || currentSource?.kind === 'search') ? '立即运行 AI 搜索' : '立即更新'} aria-label="立即更新" className="icon-btn w-7 h-7 inline-flex items-center justify-center disabled:opacity-60" style={{ color: 'var(--muted)' }}>
            <IconRefresh width={14} height={14} className={refreshing ? 'spinning' : ''} />
          </button>
          <MenuButton title="更多" items={moreItems} width={210}>
            <IconMore width={15} height={15} />
          </MenuButton>
        </div>

        {currentSource?.lastError && currentSource.failCount > 0 && (
          <div className="shrink-0 mx-3 mt-2 px-3 py-2 rounded-[var(--r-sm)] text-xs leading-relaxed" style={{ background: 'var(--warn-soft)', color: 'var(--muted)' }}>
            最近一次更新失败：{currentSource.lastError}
            {currentSource.nextFetchAt ? `（${fmtFeedTime(currentSource.nextFetchAt) === '刚刚' ? '稍后' : new Date(currentSource.nextFetchAt).toLocaleTimeString().slice(0, 5)} 自动重试）` : ''}
          </div>
        )}

        <div ref={listRef} className="flex-1 overflow-y-auto">
          {scope.kind === 'digest' ? (
            <div className="px-4 py-6 text-xs leading-relaxed" style={{ color: 'var(--faint)' }}>
              今日精华把最近 24 小时订阅的新文章归纳成几个主题，显示在右侧。
            </div>
          ) : (
            <>
              {items.map(it => (
                <ItemRow key={it.id} item={it} selected={it.id === selectedId} showSource={scope.kind !== 'source'} onSelect={() => useFeeds.getState().select(it.id)} />
              ))}
              {!items.length && !loading && (
                <div className="px-6 py-10 text-center text-sm" style={{ color: 'var(--faint)' }}>
                  {q ? '没有匹配的条目' : filter === 'unread' ? '全部读完了 ✓' : filter === 'starred' ? '还没有收藏' : '这里还没有内容'}
                  {filter === 'unread' && !q && (
                    <button onClick={() => useFeeds.getState().setFilter('all')} className="block mx-auto mt-2 text-xs hover:underline" style={{ color: 'var(--accent-ink)' }}>
                      看全部
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {scope.kind === 'digest' ? <DigestPanel key={scopeKey(scope)} /> : <FeedReader id={selectedId} />}
    </>
  )
}
