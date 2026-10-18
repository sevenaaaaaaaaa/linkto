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

export const useMail = create<MailState>((set, get) => ({
  accounts: [],
  folders: [],
  scope: { kind: 'unified', title: '收件箱' },
  messages: [],
  total: 0,
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
    set({ scope, messages: [], selectedId: null, selectedIds: new Set(), searchQuery: keepSearch ? get().searchQuery : '', searchSpec: keepSearch ? get().searchSpec : null })
    void get().loadMessages()
  },

  loadMessages: async () => {
    const { scope, searchQuery, searchSpec } = get()
    const seq = ++loadSeq
    set({ loading: true })
    try {
      // 搜索框的结构化查询：走 nlSearch（FTS + 语法条件）
      if (scope.kind === 'search' && searchSpec) {
        const page = await api.nlSearch(searchSpec)
        if (seq !== loadSeq) return
        set({ messages: page.items, total: page.total, loading: false })
        return
      }
      const page = await api.getMessages({
        scope: scope.kind,
        folderId: scope.folderId,
        accountId: scope.accountId,
        category: scope.category,
        search: scope.kind === 'search' ? searchQuery : undefined,
        limit: 100,
        offset: 0
      })
      if (seq !== loadSeq) return
      const ctx = get().accountCtx
      const items = ctx && ACCOUNT_FILTERED_SCOPES.has(scope.kind) ? page.items.filter(m => m.accountId === ctx) : page.items
      set({ messages: items, total: items.length === page.items.length ? page.total : items.length, loading: false })
    } catch {
      if (seq === loadSeq) set({ loading: false })
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
