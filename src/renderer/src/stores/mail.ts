import { create } from 'zustand'
import type { AccountWithStatus, Folder, ListSort, MessageSummary, ScopeKind } from '@shared/types'
import { api } from '../lib/api'

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
}

export const useMail = create<MailState>((set, get) => ({
  accounts: [],
  folders: [],
  scope: { kind: 'unified', title: '统一收件箱' },
  messages: [],
  total: 0,
  selectedId: null,
  selectedIds: new Set(),
  searchQuery: '',
  loading: false,
  sort: loadSort(),
  groupThreads: loadThreads(),
  lastClickedId: null,

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
    set({ scope, messages: [], selectedId: null, selectedIds: new Set(), searchQuery: keepSearch ? get().searchQuery : '' })
    void get().loadMessages()
  },

  loadMessages: async () => {
    const { scope, searchQuery } = get()
    set({ loading: true })
    try {
      const page = await api.getMessages({
        scope: scope.kind,
        folderId: scope.folderId,
        accountId: scope.accountId,
        category: scope.category,
        search: scope.kind === 'search' ? searchQuery : undefined,
        limit: 100,
        offset: 0
      })
      set({ messages: page.items, total: page.total, loading: false })
    } catch {
      set({ loading: false })
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

  setSearch: q => set({ searchQuery: q }),

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
  }
}))
