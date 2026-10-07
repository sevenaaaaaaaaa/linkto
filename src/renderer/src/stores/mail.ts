import { create } from 'zustand'
import type { AccountWithStatus, Folder, MessageSummary, ScopeKind } from '@shared/types'
import { api } from '../lib/api'

export interface Scope {
  kind: ScopeKind
  title: string
  folderId?: string
  accountId?: string
  category?: 'personal' | 'notification' | 'newsletter' | 'noise'
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
  selection: string | null // 阅读窗当前邮件

  loadAccounts(): Promise<void>
  loadFolders(): Promise<void>
  setScope(scope: Scope): void
  loadMessages(): Promise<void>
  select(id: string | null): void
  toggleSelect(id: string): void
  clearSelection(): void
  setSearch(q: string): void
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
  selection: null,

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

  select: id => set({ selectedId: id, selectedIds: id ? new Set([id]) : new Set() }),

  toggleSelect: id => {
    const ids = new Set(get().selectedIds)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    set({ selectedIds: ids })
  },

  clearSelection: () => set({ selectedIds: new Set(), selectedId: null }),

  setSearch: q => set({ searchQuery: q })
}))
