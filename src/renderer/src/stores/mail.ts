import { create } from 'zustand'
import type { AccountWithStatus, Folder, ListSort, MessageSummary, NLQuery, ScopeKind } from '@shared/types'
import { api } from '../lib/api'
import { getPrefs } from '../lib/prefs'

export interface Scope {
  kind: ScopeKind
  title: string
  folderId?: string
  accountId?: string
  category?: 'personal' | 'notification' | 'newsletter' | 'noise'
}

const SORT_KEY = 'ms_sort'
const THREADS_KEY = 'ms_threads'
/** 列表每页条数：向下滚动自动续期，首屏保持轻量 */
const PAGE_SIZE = 100

export const loadSort = (): ListSort => (localStorage.getItem(SORT_KEY) as ListSort) || 'date'
export const loadThreads = (): boolean => localStorage.getItem(THREADS_KEY) === '1'

/** 列表排序比较器：置顶恒在最前；重要优先 = 交互分 + 新鲜度 */
export function sortMessages(list: MessageSummary[], sort: ListSort): MessageSummary[] {
  const arr = [...list]
  const score = (m: MessageSummary) =>
    (m.pinned ? 10_000_000_000 : 0) +
    (sort === 'smart' ? (m.unread ? 500_000_000 : 0) + (m.flagged ? 200_000_000 : 0) + m.date / 10_000 : 0)
  arr.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    switch (sort) {
      case 'dateAsc':
        return a.date - b.date
      case 'unread':
        if (a.unread !== b.unread) return a.unread ? -1 : 1
        return b.date - a.date
      case 'smart':
        return score(b) - score(a)
      default:
        return b.date - a.date
    }
  })
  return arr
}

interface MailState {
  accounts: AccountWithStatus[]
  folders: Folder[]
  scope: Scope
  messages: MessageSummary[]
  total: number
  /** 服务端总命中数（账户栏过滤前）；仅用于判断是否还有下一页 */
  rawTotal: number
  /** 已从服务端取回的原始行数（分页游标；账户过滤前的数量，保证 offset 不跳页） */
  fetched: number
  /** 正在追加下一页 */
  loadingMore: boolean
  selectedId: string | null
  selectedIds: Set<string>
  searchQuery: string
  loading: boolean
  sort: ListSort
  groupThreads: boolean
  lastClickedId: string | null
  /** 账户实时同步进度（accountId → "INBOX +87"），来自 sync-progress 事件 */
  syncProgress: Record<string, string>
  /** AI 自然语言搜索的结果集（非 null 时列表由它驱动） */
  nlResults: MessageSummary[] | null
  /** 搜索框生成的结构化查询（关键词 / 语法 / AI）；scope=search 且非 null 时列表由它驱动 */
  searchSpec: NLQuery | null
  /** 账户栏选中的账户（null = 全部账户）：收件箱切到该账户，旗标/置顶/稍后等视图按它过滤 */
  accountCtx: string | null
  /** 逐封处理模式：一次只看一封「需要你处理」的邮件，用大按钮快速清空 */
  triage: boolean
  /** 阅读页右侧栏：上下文（发件人 / 记忆 / 承诺）或 Agent 对话；null = 收起 */
  rail: 'context' | 'agent' | null

  loadAccounts(): Promise<void>
  loadFolders(): Promise<void>
  setScope(scope: Scope): void
  loadMessages(): Promise<void>
  /** 加载下一页（收件箱列表 / 搜索结果共用） */
  loadMore(): Promise<void>
  select(id: string | null): void
  toggleSelect(id: string, shiftKey?: boolean): void
  selectAll(): void
  clearSelection(): void
  setSearch(q: string): void
  setSort(s: ListSort): void
  setGroupThreads(v: boolean): void
  setPinned(ids: string[], pinned: boolean): Promise<void>
  setSyncProgress(accountId: string, text: string): void
  setAccountCtx(id: string | null): void
  setTriage(v: boolean): void
  /** 再点一次当前模式 = 收起 */
  toggleRail(mode: 'context' | 'agent'): void
}

/** 这些全局视图在选中某个账户时只显示该账户的邮件 */
const ACCOUNT_FILTERED_SCOPES = new Set<ScopeKind>(['flagged', 'pinned', 'snoozed', 'followup', 'unread', 'newsletter', 'category', 'screener'])

/** 列表加载序号：连续触发（如边输边搜）时只采用最后一次的结果 */
let loadSeq = 0
/** 上一次查询的指纹：同一查询的刷新保留已展开的分页，换视图 / 搜索词则回到首屏 */
let lastQueryKey = ''

const queryKey = (st: Pick<MailState, 'scope' | 'searchQuery' | 'searchSpec' | 'accountCtx'>): string =>
  JSON.stringify([st.scope.kind, st.scope.folderId ?? null, st.scope.accountId ?? null, st.scope.category ?? null, st.searchQuery ?? null, st.searchSpec ?? null, st.accountCtx ?? null])

export const useMail = create<MailState>((set, get) => ({
  accounts: [],
  folders: [],
  scope: { kind: 'unified', title: '收件箱' },
  messages: [],
  total: 0,
  rawTotal: 0,
  fetched: 0,
  loadingMore: false,
  selectedId: null,
  selectedIds: new Set(),
  searchQuery: '',
  loading: false,
  sort: loadSort(),
  groupThreads: loadThreads(),
  lastClickedId: null,
  syncProgress: {},
  nlResults: null,
  searchSpec: null,
  accountCtx: null,
  triage: false,
  rail: (() => {
    const saved = localStorage.getItem('ms_rail')
    if (saved !== null) return (saved || null) as 'context' | 'agent' | null
    const d = getPrefs().defaultRail
    return d === 'none' ? null : d
  })(),

  loadAccounts: async () => {
    const accounts = await api.listAccounts()
    set({ accounts })
  },

  loadFolders: async () => {
    const folders = await api.listFolders()
    set({ folders })
  },

  setScope: scope => {
    const keepSearch = scope.kind === 'search'
    lastQueryKey = ''
    set({
      scope,
      messages: [],
      total: 0,
      rawTotal: 0,
      fetched: 0,
      loadingMore: false,
      selectedId: null,
      selectedIds: new Set(),
      searchQuery: keepSearch ? get().searchQuery : '',
      searchSpec: keepSearch ? get().searchSpec : null
    })
    void get().loadMessages()
  },

  loadMessages: async () => {
    const st = get()
    const { scope, searchQuery, searchSpec } = st
    const seq = ++loadSeq
    // 同一查询的刷新（读信标已读、打旗标、新邮件到达）保留已展开的分页，避免列表缩回首屏
    const key = queryKey(st)
    // 用已取回的原始游标（而非过滤后的可见条数）保留分页，账户过滤时也不会缩水
    const keep = key === lastQueryKey ? Math.min(Math.max(st.messages.length, st.fetched), 2000) : 0
    lastQueryKey = key
    set({ loading: true })
    try {
      // 搜索框的结构化查询：走 nlSearch（FTS + 语法条件）
      if (scope.kind === 'search' && searchSpec) {
        const spec = keep > 0 ? { ...searchSpec, limit: Math.max(searchSpec.limit ?? PAGE_SIZE, keep) } : searchSpec
        const page = await api.nlSearch(spec)
        if (seq !== loadSeq) return
        set({ messages: page.items, total: page.total, rawTotal: page.total, fetched: page.items.length, loading: false, loadingMore: false })
        return
      }
      const page = await api.getMessages({
        scope: scope.kind,
        folderId: scope.folderId,
        accountId: scope.accountId,
        category: scope.category,
        search: scope.kind === 'search' ? searchQuery : undefined,
        limit: Math.max(PAGE_SIZE, keep),
        offset: 0
      })
      if (seq !== loadSeq) return
      const ctx = get().accountCtx
      const filtered = !!ctx && ACCOUNT_FILTERED_SCOPES.has(scope.kind)
      const items = filtered ? page.items.filter(m => m.accountId === ctx) : page.items
      set({ messages: items, total: filtered ? items.length : page.total, rawTotal: page.total, fetched: page.items.length, loading: false, loadingMore: false })
      // 账户过滤把整页都滤掉时，自动再取一页，避免误显示「这里还没有邮件」
      if (filtered && !items.length && page.items.length < page.total) void get().loadMore()
    } catch {
      if (seq === loadSeq) set({ loading: false, loadingMore: false })
    }
  },

  loadMore: async () => {
    const st = get()
    const { scope, searchSpec, loading, loadingMore, fetched, rawTotal } = st
    if (loading || loadingMore || !fetched || fetched >= rawTotal) return
    const seq = loadSeq
    const filtered = !!st.accountCtx && ACCOUNT_FILTERED_SCOPES.has(scope.kind)
    const seen = new Set(st.messages.map(m => m.id))
    const appended: MessageSummary[] = []
    let cursor = fetched
    let nextRawTotal = rawTotal
    set({ loadingMore: true })
    try {
      // 账户过滤可能让整页都不显示：继续取下一页（最多 4 页），避免底部「卡住不动」
      for (let guard = 0; guard < 4; guard++) {
        let items: MessageSummary[]
        if (scope.kind === 'search' && searchSpec) {
          const page = await api.nlSearch({ ...searchSpec, offset: cursor })
          if (seq !== loadSeq) return
          items = page.items
          nextRawTotal = page.total
        } else {
          const page = await api.getMessages({
            scope: scope.kind,
            folderId: scope.folderId,
            accountId: scope.accountId,
            category: scope.category,
            search: scope.kind === 'search' ? st.searchQuery : undefined,
            limit: PAGE_SIZE,
            offset: cursor
          })
          if (seq !== loadSeq) return
          items = page.items
          nextRawTotal = page.total
        }
        cursor += items.length
        for (const m of items) {
          if (seen.has(m.id)) continue
          seen.add(m.id)
          if (!filtered || m.accountId === st.accountCtx) appended.push(m)
        }
        // 已取完 / 取到非空可见结果 / 服务端返回空页：停止
        if (!items.length || cursor >= nextRawTotal || appended.length) break
      }
      if (seq !== loadSeq) return
      const cur = get()
      const nextMessages = appended.length ? [...cur.messages, ...appended] : cur.messages
      set({
        messages: nextMessages,
        total: filtered ? nextMessages.length : nextRawTotal,
        rawTotal: nextRawTotal,
        fetched: cursor,
        loadingMore: false
      })
    } catch {
      if (seq === loadSeq) set({ loadingMore: false })
    }
  },

  select: id => set({ selectedId: id, selectedIds: id ? new Set([id]) : new Set(), lastClickedId: id }),

  toggleSelect: (id, shiftKey) => {
    const { messages, selectedIds, lastClickedId } = get()
    if (shiftKey && lastClickedId) {
      // Shift 范围选择：从上次点击到当前的连续区间加入选择
      const from = messages.findIndex(m => m.id === lastClickedId)
      const to = messages.findIndex(m => m.id === id)
      if (from !== -1 && to !== -1) {
        const ids = new Set(selectedIds)
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) ids.add(messages[i].id)
        set({ selectedIds: ids, lastClickedId: id })
        return
      }
    }
    const ids = new Set(selectedIds)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    set({ selectedIds: ids, lastClickedId: id })
  },

  selectAll: () => {
    const { messages, selectedIds } = get()
    const allSelected = messages.length > 0 && messages.every(m => selectedIds.has(m.id))
    set({ selectedIds: allSelected ? new Set() : new Set(messages.map(m => m.id)) })
  },

  clearSelection: () => set({ selectedIds: new Set(), selectedId: null }),

  // 外部直接设关键词（如「声呐」）：走旧的 getMessages 搜索路径，清掉搜索框的结构化查询
  setSearch: q => set({ searchQuery: q, searchSpec: null }),

  setSort: s => {
    localStorage.setItem(SORT_KEY, s)
    set({ sort: s })
  },

  setGroupThreads: v => {
    localStorage.setItem(THREADS_KEY, v ? '1' : '0')
    set({ groupThreads: v })
  },

  setPinned: async (ids, pinned) => {
    await api.pinMessages(ids, pinned)
    await get().loadMessages()
  },

  setSyncProgress: (accountId, text) => {
    set({ syncProgress: { ...get().syncProgress, [accountId]: text } })
  },

  setTriage: v => set({ triage: v }),

  toggleRail: mode => {
    const next = get().rail === mode ? null : mode
    localStorage.setItem('ms_rail', next ?? '')
    set({ rail: next })
  },

  setAccountCtx: id => {
    set({ accountCtx: id })
    const acc = id ? get().accounts.find(a => a.id === id) : null
    const { scope } = get()
    // 在收件箱类视图里切账户 = 切到该账户收件箱；其他视图保持当前视图，只换过滤
    if (scope.kind === 'unified' || scope.kind === 'account' || scope.kind === 'folder') {
      get().setScope(acc ? { kind: 'account', accountId: acc.id, title: acc.name } : { kind: 'unified', title: '收件箱' })
    } else {
      void get().loadMessages()
    }
  }
}))
