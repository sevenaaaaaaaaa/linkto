import { create } from 'zustand'
import { useEffect } from 'react'
import { api } from './api'
import { scopeFromKey, scopeKey, type FeedFilter, type FeedItem, type FeedScope, type FeedSettings, type FeedSource } from '@shared/feeds'

/**
 * 订阅视图状态：订阅源 + 当前范围（#/feeds/<scope>）+ 条目列表 + 选中。
 * 像邮件一样处理：选中即标已读；「未读」筛选下刚读过的条目留在列表里（下次切换范围再消失），避免列表跳动。
 */

const FILTER_KEY = 'ms_feed_filter'

function readFilter(): FeedFilter {
  try {
    const v = localStorage.getItem(FILTER_KEY)
    return v === 'all' || v === 'starred' ? v : 'unread'
  } catch {
    return 'unread'
  }
}

export function feedScopeFromHash(hash = location.hash): FeedScope {
  const m = /^#\/feeds\/?(.*)$/.exec(hash)
  return scopeFromKey(m?.[1] ?? '')
}

/** 打开订阅视图（可指定范围） */
export function openFeeds(scope?: FeedScope) {
  const key = scope ? scopeKey(scope) : 'all'
  const target = key === 'all' ? '#/feeds' : `#/feeds/${key}`
  if (location.hash !== target) location.hash = target
}

interface FeedState {
  sources: FeedSource[]
  loaded: boolean
  settings: FeedSettings | null
  scope: FeedScope
  filter: FeedFilter
  q: string
  items: FeedItem[]
  loadingItems: boolean
  selectedId: string | null
  /** 本次范围内刚读过的（未读筛选下保留显示） */
  sticky: Set<string>
  loadSources(): Promise<void>
  loadItems(opts?: { keepSticky?: boolean }): Promise<void>
  setScope(s: FeedScope): void
  setFilter(f: FeedFilter): void
  setQuery(q: string): void
  select(id: string | null): void
  move(delta: 1 | -1): void
  setRead(id: string, read: boolean): Promise<void>
  toggleStar(id: string): Promise<void>
  markAllRead(): Promise<number>
}

const sameScope = (a: FeedScope, b: FeedScope) => scopeKey(a) === scopeKey(b)

export const useFeeds = create<FeedState>((set, get) => ({
  sources: [],
  loaded: false,
  settings: null,
  scope: feedScopeFromHash(),
  filter: readFilter(),
  q: '',
  items: [],
  loadingItems: false,
  selectedId: null,
  sticky: new Set(),
  loadSources: async () => {
    try {
      const [sources, settings] = await Promise.all([api.feedSources(), get().settings ? Promise.resolve(get().settings) : api.feedGetSettings()])
      set({ sources, settings, loaded: true })
    } catch {
      set({ loaded: true })
    }
  },
  loadItems: async opts => {
    const { scope, filter, q } = get()
    if (scope.kind === 'digest') {
      set({ items: [], loadingItems: false })
      return
    }
    set({ loadingItems: true })
    try {
      const fresh = await api.feedItems({ scope, filter, q, limit: 300 })
      const st = get()
      if (!sameScope(st.scope, scope) || st.filter !== filter || st.q !== q) return
      let list = fresh
      if (opts?.keepSticky !== false && filter === 'unread' && st.sticky.size) {
        const keep = st.items.filter(o => st.sticky.has(o.id) && !fresh.some(f => f.id === o.id)).map(o => ({ ...o, read: true }))
        list = [...fresh, ...keep].sort((a, b) => b.sortAt - a.sortAt)
      }
      set({ items: list, loadingItems: false })
    } catch {
      set({ loadingItems: false })
    }
  },
  setScope: s => {
    if (sameScope(get().scope, s)) return
    set({ scope: s, selectedId: null, sticky: new Set(), items: [] })
    void get().loadItems()
  },
  setFilter: f => {
    try {
      localStorage.setItem(FILTER_KEY, f)
    } catch {
      /* ignore */
    }
    set({ filter: f, sticky: new Set() })
    void get().loadItems()
  },
  setQuery: q => {
    set({ q, sticky: new Set() })
    void get().loadItems()
  },
  select: id => {
    set({ selectedId: id })
    if (!id) return
    const it = get().items.find(i => i.id === id)
    if (it && !it.read) void get().setRead(id, true)
  },
  move: delta => {
    const { items, selectedId } = get()
    if (!items.length) return
    const idx = items.findIndex(i => i.id === selectedId)
    const next = items[Math.max(0, Math.min(items.length - 1, idx < 0 ? 0 : idx + delta))]
    if (next) get().select(next.id)
  },
  setRead: async (id, read) => {
    const sticky = new Set(get().sticky)
    if (read) sticky.add(id)
    else sticky.delete(id)
    set({ items: get().items.map(i => (i.id === id ? { ...i, read } : i)), sticky })
    await api.feedMarkRead([id], read)
  },
  toggleStar: async id => {
    const it = get().items.find(i => i.id === id)
    const next = !it?.starred
    set({ items: get().items.map(i => (i.id === id ? { ...i, starred: next } : i)) })
    await api.feedStar(id, next)
  },
  markAllRead: async () => {
    const { scope, items } = get()
    const n = await api.feedMarkAllRead(scope, Date.now())
    set({ items: items.map(i => ({ ...i, read: true })), sticky: new Set(items.map(i => i.id)) })
    return n
  }
}))

let subscribed = false
/** 挂一次（侧栏入口常驻）：订阅源变化 / 新条目到达时刷新 */
export function useFeedEvents() {
  useEffect(() => {
    if (!useFeeds.getState().loaded) void useFeeds.getState().loadSources()
    if (subscribed) return
    subscribed = true
    let timer = 0
    const off = api.onEvent(ev => {
      const e = ev as { type: string }
      if (e.type === 'feeds-changed') {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          void useFeeds.getState().loadSources()
          if (location.hash.startsWith('#/feeds')) void useFeeds.getState().loadItems()
        }, 200)
      }
    })
    return () => {
      subscribed = false
      void off()
    }
  }, [])
}

export function unreadOf(sources: FeedSource[]): number {
  return sources.filter(s => s.enabled || s.kind === 'search').reduce((n, s) => n + s.unread, 0)
}

/** 分组：有分组的按分组，没分组的放「未分组」 */
export function groupSources(sources: FeedSource[]): { name: string | null; sources: FeedSource[]; unread: number }[] {
  const map = new Map<string | null, FeedSource[]>()
  for (const s of sources.filter(x => x.kind === 'feed')) map.set(s.group, [...(map.get(s.group) ?? []), s])
  const out = [...map.entries()].map(([name, list]) => ({ name, sources: list, unread: list.reduce((n, s) => n + s.unread, 0) }))
  out.sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name, 'zh-CN')))
  return out
}

export function scopeLabel(scope: FeedScope, sources: FeedSource[]): string {
  switch (scope.kind) {
    case 'all':
      return '全部订阅'
    case 'starred':
      return '收藏'
    case 'topics':
      return 'AI 搜索订阅'
    case 'digest':
      return '今日精华'
    case 'group':
      return scope.name
    case 'source':
      return sources.find(s => s.id === scope.id)?.title ?? '订阅源'
  }
}

export function fmtFeedTime(t: number | null | undefined, now = Date.now()): string {
  if (!t) return ''
  const d = new Date(t)
  const diff = now - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const today = new Date(now)
  if (d.toDateString() === today.toDateString()) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const y = new Date(now - 864e5)
  if (d.toDateString() === y.toDateString()) return '昨天'
  return d.getFullYear() === today.getFullYear() ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export function hostOf(u: string | null | undefined): string {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}
