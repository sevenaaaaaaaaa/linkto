import { create } from 'zustand'
import type { Folder, NLQuery } from '@shared/types'
import { api } from '../lib/api'
import { useMail, type Scope } from './mail'
import { aiErrorText, describeNL, loadRecent, looksNatural, looseTerms, nlIsEmpty, parseSearch, pushRecent, removeToken, saveRecent, type SearchToken } from '../lib/search'

/**
 * 搜索会话：关键词搜索是主路径（边输边搜，走 FTS + 本地语法），AI 编译是增强。
 * 状态放在全局 store，命令面板等入口可直接把文本交给列表搜索。
 */

/** 结果头部可一键添加 / 移除的快速筛选 */
export type QuickFilter = 'unread' | 'attach' | 'recent30'
export const QUICK_LABEL: Record<QuickFilter, string> = { unread: '未读', attach: '有附件', recent30: '近 30 天' }

export interface AiNote {
  text: string
  /** 建议去设置 AI */
  setup: boolean
  /** 用户主动点了 AI（主动失败要说得更明确） */
  explicit: boolean
}

interface SearchState {
  /** 输入框文本 */
  input: string
  /** 当前生效的查询文本（空 = 不在搜索中） */
  active: string
  mode: 'keyword' | 'ai'
  /** 搜索范围：账户 id；null = 全部账户 */
  range: string | null
  quick: QuickFilter[]
  /** 识别出的语法胶囊 */
  tokens: SearchToken[]
  /** 列表高亮用的命中词 */
  terms: string[]
  aiBusy: boolean
  /** 「AI 理解为：…」 */
  aiDesc: string | null
  aiNote: AiNote | null
  /** 问句整句没命中时改用的宽松关键词（非 null 时头部会说明） */
  loose: string[] | null
  recent: string[]
  setInput(v: string): void
  /** 执行搜索：commit = 回车 / 选中建议（记入最近搜索，问句会后台尝试 AI）；ai = 主动 AI 搜索 */
  run(q?: string, opts?: { commit?: boolean; ai?: boolean }): Promise<void>
  /** 清空并回到搜索前的视图（Esc） */
  clear(): void
  /** 列表已被其他入口切走：静默结束搜索会话 */
  detach(): void
  setRange(accountId: string | null): void
  toggleQuick(k: QuickFilter): void
  dropToken(raw: string): void
  revertAi(): void
  forgetRecent(q?: string): void
}

// 非状态的会话细节（不触发渲染）
let runSeq = 0
let prevScope: Scope | null = null
/** 关键词查询本体（未叠加范围 / 快速筛选），撤回 AI、切范围时据此重算 */
let keywordBase: NLQuery | null = null
let keywordTerms: string[] = []
let aiQuery: NLQuery | null = null
/** 自动（非主动）尝试 AI 时，「AI 未配置」只提示一次，避免每次搜索都唠叨 */
let autoSetupNoted = false

const AI_TIMEOUT = 20_000

function defaultRange(scope: Scope, folders: Folder[]): string | null {
  const ctx = useMail.getState().accountCtx
  if (ctx) return ctx
  if (scope.accountId) return scope.accountId
  if (scope.folderId) return folders.find(f => f.id === scope.folderId)?.accountId ?? null
  return null
}

/** 范围 + 快速筛选叠加到查询上；搜索默认覆盖全部文件夹 */
function withScope(q: NLQuery, range: string | null, quick: QuickFilter[]): NLQuery {
  const out: NLQuery = { ...q, allFolders: true, limit: 200 }
  if (!out.accountId && range) out.accountId = range
  if (quick.includes('unread')) out.unreadOnly = true
  if (quick.includes('attach')) out.hasAttachment = true
  if (quick.includes('recent30')) out.withinDays = out.withinDays ? Math.min(out.withinDays, 30) : 30
  return out
}

const nlTerms = (q: NLQuery) => [q.fallbackText || q.text || '', q.subject ?? '', q.sender ?? ''].map(s => s.trim()).filter(Boolean)

export const useSearch = create<SearchState>((set, get) => ({
  input: '',
  active: '',
  mode: 'keyword',
  range: null,
  quick: [],
  tokens: [],
  terms: [],
  aiBusy: false,
  aiDesc: null,
  aiNote: null,
  loose: null,
  recent: loadRecent(),

  setInput: v => set({ input: v }),

  run: async (q, opts = {}) => {
    if (q !== undefined) set({ input: q })
    const input = (q ?? get().input).trim()
    if (!input) {
      if (get().active) get().clear()
      return
    }
    const mail = useMail.getState()
    const parsed = parseSearch(input, { accounts: mail.accounts, folders: mail.folders })
    const hasCond = parsed.terms.length > 0 || Object.keys(parsed.query).length > 0 || parsed.tokens.length > 0
    if (!hasCond) return
    const seq = ++runSeq
    const entering = mail.scope.kind !== 'search' || !mail.searchSpec
    if (entering && mail.scope.kind !== 'search') prevScope = mail.scope
    const range = entering ? defaultRange(prevScope ?? mail.scope, mail.folders) : get().range
    const quick = entering ? [] : get().quick
    keywordBase = { ...parsed.query, terms: parsed.terms }
    const spec = withScope(keywordBase, range, quick)
    keywordTerms = [...parsed.terms, parsed.query.sender ?? '', parsed.query.subject ?? ''].filter(Boolean)
    aiQuery = null
    set({
      active: input,
      mode: 'keyword',
      range,
      quick,
      tokens: parsed.tokens,
      terms: keywordTerms,
      aiDesc: null,
      aiNote: null,
      aiBusy: false,
      loose: null,
      ...(opts.commit || opts.ai ? { recent: pushRecent(input) } : {})
    })
    useMail.setState({
      scope: { kind: 'search', title: `搜索：${input}` },
      searchQuery: input,
      searchSpec: spec,
      nlResults: null,
      ...(entering ? { messages: [], total: 0, selectedId: null, selectedIds: new Set<string>() } : {})
    })
    await useMail.getState().loadMessages()
    if (seq !== runSeq) return

    // 问句整句没命中：去掉口语虚词后宽松匹配（不依赖 AI）
    const natural = parsed.tokens.length === 0 && looksNatural(parsed.terms)
    if (natural && useMail.getState().messages.length === 0) {
      const loose = looseTerms(parsed.terms)
      if (loose.length && loose.join(' ') !== parsed.terms.join(' ')) {
        keywordBase = { ...parsed.query, terms: loose }
        keywordTerms = loose
        set({ terms: loose, loose })
        useMail.setState({ searchSpec: withScope(keywordBase, range, quick) })
        await useMail.getState().loadMessages()
        if (seq !== runSeq) return
      }
    }

    // AI 增强：主动点 ✦ / Shift+Enter；或回车提交的明显问句（含语法的查询本身已足够精确，不再猜）
    const auto = !!opts.commit && natural
    if (!opts.ai && !auto) return
    const explicit = !!opts.ai
    set({ aiBusy: true })
    const res = await Promise.race([
      api.aiComposeQuery(input).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e), query: {} as NLQuery })),
      new Promise<{ ok: false; error: string; query: NLQuery }>(r => setTimeout(() => r({ ok: false, error: 'timeout', query: {} }), AI_TIMEOUT))
    ])
    if (seq !== runSeq) return
    if (!res.ok || nlIsEmpty(res.query)) {
      const note = res.ok ? { text: 'AI 没能从这句话里理解出条件', setup: false } : aiErrorText(res.error)
      const quiet = !explicit && note.setup && autoSetupNoted
      if (!explicit && note.setup) autoSetupNoted = true
      set({ aiBusy: false, aiNote: quiet ? null : { ...note, explicit } })
      return
    }
    const aiSpec = withScope(res.query, get().range, get().quick)
    let page
    try {
      page = await api.nlSearch(aiSpec)
    } catch {
      set({ aiBusy: false, aiNote: { text: 'AI 理解成功，但查询执行失败', setup: false, explicit } })
      return
    }
    if (seq !== runSeq) return
    const desc = describeNL(res.query)
    // 自动尝试时，AI 结果为空而关键词有结果：保留关键词结果，只做说明
    if (!explicit && page.total === 0 && useMail.getState().messages.length > 0) {
      set({ aiBusy: false, aiNote: { text: `AI 理解为「${desc}」，但没有更贴切的结果`, setup: false, explicit } })
      return
    }
    aiQuery = res.query
    set({ mode: 'ai', aiBusy: false, aiDesc: desc, terms: nlTerms(res.query) })
    useMail.setState({
      scope: { kind: 'search', title: `AI 搜索：${input}` },
      searchSpec: aiSpec,
      messages: page.items,
      total: page.total,
      loading: false
    })
  },

  clear: () => {
    runSeq++
    const back = prevScope
    prevScope = null
    keywordBase = null
    aiQuery = null
    set({ input: '', active: '', mode: 'keyword', quick: [], tokens: [], terms: [], aiBusy: false, aiDesc: null, aiNote: null, loose: null })
    useMail.setState({ searchSpec: null, nlResults: null, searchQuery: '' })
    const mail = useMail.getState()
    if (mail.scope.kind === 'search') mail.setScope(back ?? { kind: 'unified', title: '收件箱' })
  },

  detach: () => {
    if (!get().active && !get().input) return
    runSeq++
    prevScope = null
    keywordBase = null
    aiQuery = null
    set({ input: '', active: '', mode: 'keyword', quick: [], tokens: [], terms: [], aiBusy: false, aiDesc: null, aiNote: null, loose: null })
  },

  setRange: accountId => {
    set({ range: accountId })
    reapply()
  },

  toggleQuick: k => {
    const cur = get().quick
    set({ quick: cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k] })
    reapply()
  },

  dropToken: raw => {
    const next = removeToken(get().input || get().active, raw)
    if (!next.trim()) get().clear()
    else void get().run(next)
  },

  revertAi: () => {
    if (!keywordBase) return
    runSeq++
    aiQuery = null
    set({ mode: 'keyword', aiDesc: null, aiNote: null, aiBusy: false, terms: keywordTerms })
    useMail.setState({ scope: { kind: 'search', title: `搜索：${get().active}` }, searchSpec: withScope(keywordBase, get().range, get().quick) })
    void useMail.getState().loadMessages()
  },

  forgetRecent: q => {
    const next = q ? get().recent.filter(x => x !== q) : []
    saveRecent(next)
    set({ recent: next })
  }
}))

/** 范围 / 快速筛选变化：在当前模式（关键词或 AI）的查询上重新叠加并刷新 */
function reapply() {
  const st = useSearch.getState()
  if (!st.active) return
  runSeq++
  const base = st.mode === 'ai' && aiQuery ? aiQuery : keywordBase
  if (!base) return
  useMail.setState({ searchSpec: withScope(base, st.range, st.quick) })
  void useMail.getState().loadMessages()
}
