import { goView } from '../lib/route'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useMail, type Scope } from '../stores/mail'
import { cycleTheme, themeLabel } from '../lib/theme'
import { IconSearch, IconSparkles, IconCompose, IconSettings, IconInbox, IconRefresh, IconRobot } from '../components/icons'
import { useSearch } from '../stores/search'
import { askAgent } from '../lib/agent-ask'
import type { MessageSummary } from '@shared/types'
import { projectCommands } from './projects/ProjectBits'
import { agentCommands } from './agent/AgentNav'

interface Command {
  id: string
  group: string
  label: string
  hint?: string
  icon?: React.ReactNode
  keywords?: string
  /** 只在输入文字后出现（如「运行技能：xxx」，避免淹没默认列表） */
  searchOnly?: boolean
  run(): void
}

const emit = (name: string) => window.dispatchEvent(new CustomEvent(name))
const listAction = (action: string) => window.dispatchEvent(new CustomEvent('ms:list-action', { detail: action }))

/** ⌘K 命令面板 —— 全局快速操作：命令 / 跳转 / 把文本交给列表搜索或 Agent / 邮件直达 */
export function CommandPalette(props: { open: boolean; onClose(): void }) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [results, setResults] = useState<MessageSummary[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (props.open) {
      setQuery('')
      setCursor(0)
      setResults([])
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [props.open])

  // 查询时带出邮件直达结果
  useEffect(() => {
    const q = query.trim()
    if (!props.open || q.length < 2) {
      setResults([])
      return
    }
    let alive = true
    void api.searchMessages(q, 6).then(r => {
      // 兼容旧主进程返回 { items } 的情况，避免面板崩溃
      if (alive) setResults(Array.isArray(r) ? r : ((r as unknown as { items?: MessageSummary[] })?.items ?? []))
    })
    return () => {
      alive = false
    }
  }, [query, props.open])

  const commands = useMemo<Command[]>(() => {
    const state = useMail.getState()
    const go = (scope: Partial<Scope>, title: string) => () => {
      useMail.getState().setScope({ kind: 'unified', ...scope, title } as Scope)
      goView('mail')
      props.onClose()
    }
    const nav: Command[] = [
      { id: 'nav-unified', group: '前往', label: '统一收件箱', icon: <IconInbox width={14} height={14} />, run: go({ kind: 'unified' }, '统一收件箱') },
      { id: 'nav-flagged', group: '前往', label: '旗标', run: go({ kind: 'flagged' }, '旗标') },
      { id: 'nav-pinned', group: '前往', label: '置顶', run: go({ kind: 'pinned' }, '置顶') },
      { id: 'nav-snoozed', group: '前往', label: '稍后处理', keywords: 'snooze 队列', run: go({ kind: 'snoozed' }, '稍后处理') },
      { id: 'nav-screener', group: '前往', label: '待审批发件人', keywords: 'screener 队列', run: go({ kind: 'screener' }, '待审批发件人') },
      { id: 'nav-followup', group: '前往', label: '待跟进（我发未回）', keywords: 'followup 队列', run: go({ kind: 'followup' }, '待跟进（我发未回）') },
      { id: 'nav-personal', group: '前往', label: '个人邮件', keywords: '分类', run: go({ kind: 'category', category: 'personal' }, '个人邮件') },
      { id: 'nav-notification', group: '前往', label: '通知', keywords: '分类', run: go({ kind: 'category', category: 'notification' }, '通知') },
      { id: 'nav-newsletter', group: '前往', label: '订阅（Newsletter）', keywords: 'newsletter 分类', run: go({ kind: 'newsletter' }, '订阅') },
      { id: 'nav-noise', group: '前往', label: '噪声', keywords: '分类', run: go({ kind: 'category', category: 'noise' }, '噪声') },
      { id: 'nav-insights', group: '前往', label: '洞察（商情 / 待办 / 阅读清单 / 公司分析）', run: () => { goView('insights'); props.onClose() } },
      { id: 'nav-kb', group: '前往', label: '知识库', run: () => { goView('kb'); props.onClose() } },
      { id: 'nav-attachments', group: '前往', label: '附件（整理 / 归档到网盘 / 释放空间）', keywords: 'attachments 附件中心 网盘 Proton Dropbox 发票 合同 存储 空间', run: () => { goView('attachments'); props.onClose() } },
      { id: 'nav-finance', group: '前往', label: '财务（账单 / 订阅 / 订单 / 对账）', keywords: 'finance bill subscription order invoice 账单 订阅 订单 发票 对账 付款 续费', run: () => { goView('finance'); props.onClose() } },
      { id: 'nav-life', group: '前往', label: '生活档案（证件 / 保险 / 年检 / 域名 / 会员 / 保修到期）', keywords: 'life admin 生活档案 到期 续期 续保 护照 证件 保险 年检 域名 会员 保修 合同 租房 个税 体检 renewal expire passport', run: () => { goView('life'); props.onClose() } },
      { id: 'act-life-scan', group: '前往', label: '生活档案：扫描最近 2 年邮件', keywords: 'life scan 到期 续期 回填', run: () => { goView('life'); props.onClose(); void api.lifeScan(730) } },
      { id: 'act-finance-scan', group: '前往', label: '财务：扫描最近 90 天邮件', keywords: 'finance scan 账单 订阅 回填', run: () => { goView('finance'); props.onClose(); void api.financeScan(90) } },
      ...state.accounts.map(acc => ({
        id: `nav-acc-${acc.id}`,
        group: '前往',
        label: `${acc.name} · 收件箱`,
        keywords: acc.email,
        run: () => {
          const folder = useMail.getState().folders.find(f => f.accountId === acc.id && f.special === 'inbox')
          if (folder) go({ kind: 'folder', folderId: folder.id }, `${acc.name} · 收件箱`)()
        }
      }))
    ]
    const actions: Command[] = [
      { id: 'list-threads', group: '列表', label: '切换：按会话聚合', run: () => { listAction('toggle-threads'); props.onClose() } },
      { id: 'list-split', group: '列表', label: '切换：重要 / 其他 双轨', run: () => { listAction('toggle-split'); props.onClose() } },
      { id: 'list-time', group: '列表', label: '邮箱时光机', run: () => { listAction('toggle-time'); props.onClose() } },
      { id: 'list-gravity', group: '列表', label: '重力滑块（重要性上浮）', run: () => { listAction('toggle-gravity'); props.onClose() } },
      { id: 'list-save', group: '列表', label: '把当前视图存为「我的视图」…', run: () => { listAction('save-view'); props.onClose() } },
      { id: 'list-sort-date', group: '列表', label: '排序：最新在前', run: () => { useMail.getState().setSort('date'); props.onClose() } },
      { id: 'list-sort-smart', group: '列表', label: '排序：重要优先', run: () => { useMail.getState().setSort('smart'); props.onClose() } },
      { id: 'list-sort-unread', group: '列表', label: '排序：未读优先', run: () => { useMail.getState().setSort('unread'); props.onClose() } },
      {
        id: 'act-compose', group: '操作', label: '写邮件', hint: '⌘N', icon: <IconCompose width={14} height={14} />,
        run: () => { void api.openCompose(); props.onClose() }
      },
      {
        id: 'act-organize', group: '操作', label: 'AI 整理当前列表', icon: <IconSparkles width={14} height={14} />,
        run: () => {
          props.onClose()
          const ids = useMail.getState().messages.map(m => m.id)
          if (ids.length) void api.aiClassify(ids).then(() => useMail.getState().loadMessages())
        }
      },
      {
        id: 'act-refresh', group: '操作', label: '刷新', hint: '⌘R', icon: <IconRefresh width={14} height={14} />,
        run: () => {
          props.onClose()
          void useMail.getState().loadAccounts()
          void useMail.getState().loadFolders()
          void useMail.getState().loadMessages()
        }
      },
      {
        id: 'act-settings', group: '操作', label: '设置', hint: '⌘,', icon: <IconSettings width={14} height={14} />,
        run: () => { void api.openSettings(); props.onClose() }
      },
      {
        id: 'act-theme', group: '外观', label: '明暗切换（跟随系统 / 浅色 / 深色）', hint: '⌘T',
        run: () => {
          props.onClose()
          const next = cycleTheme()
          window.dispatchEvent(new CustomEvent('ms:toast', { detail: `主题：${themeLabel(next)}` }))
        }
      },
      { id: 'act-preset', group: '外观', label: '主题预设…', run: () => { props.onClose(); emit('ms:toggle-theme-menu') } },
      { id: 'act-style', group: '外观', label: '阅读风格…', run: () => { props.onClose(); emit('ms:toggle-style-menu') } }
    ]
    return [...actions.filter(c => c.group !== '列表'), ...nav, ...agentCommands(props.onClose), ...projectCommands(props.onClose), ...actions.filter(c => c.group === '列表')]
  }, [props.open, props.onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands.filter(c => !c.searchOnly)
    return commands.filter(c => (c.label + ' ' + (c.keywords ?? '')).toLowerCase().includes(q))
  }, [commands, query])

  // 输入的文本可直接带到列表搜索（关键词 / AI）或交给 Agent 提问
  const handoff = useMemo<Command[]>(() => {
    const q = query.trim()
    if (!q) return []
    const toList = (ai: boolean) => () => {
      props.onClose()
      goView('mail')
      void useSearch.getState().run(q, ai ? { ai: true } : { commit: true })
    }
    return [
      { id: 'search-list', group: '搜索与提问', label: `在邮件列表中搜索「${q}」`, icon: <IconSearch width={14} height={14} />, run: toList(false) },
      { id: 'search-ai', group: '搜索与提问', label: `AI 搜索「${q}」`, icon: <IconSparkles width={14} height={14} />, run: toList(true) },
      { id: 'ask-agent', group: '搜索与提问', label: `问 Agent：${q}`, icon: <IconRobot width={14} height={14} />, run: () => { props.onClose(); askAgent(q) } }
    ]
  }, [query, props.onClose])

  const items = useMemo<Command[]>(
    () => [
      ...filtered,
      ...handoff,
      ...results.map(r => ({
        id: `msg-${r.id}`,
        group: '邮件',
        label: r.subject || '（无主题）',
        keywords: `${r.from?.name ?? ''} ${r.from?.address ?? ''} ${r.snippet}`,
        run: () => {
          useMail.getState().select(r.id)
          props.onClose()
        }
      }))
    ],
    [filtered, handoff, results, props.onClose]
  )

  useEffect(() => setCursor(0), [query])

  useEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor(c => Math.min(c + 1, items.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor(c => Math.max(c - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        items[cursor]?.run()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [props.open, items, cursor, props.onClose])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!props.open) return null

  let lastGroup = ''
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]" onClick={props.onClose}>
      <div className="absolute inset-0 bg-black/25 backdrop-blur-[6px]" />
      <div
        className="liquid-glass relative w-[560px] max-w-[86vw] rounded-[var(--r-md)] overflow-hidden pop-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 h-[52px] border-b border-[var(--border-soft)]">
          <IconSearch width={15} height={15} style={{ color: 'var(--muted)' }} />
          <input
            ref={inputRef}
            data-search-input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="输入命令、跳转视图，或输入文字去搜邮件 / 问 Agent…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-[var(--faint)]"
          />
          <kbd className="text-2xs px-1.5 py-0.5 rounded-md border border-[var(--border)] font-[var(--font-mono)]" style={{ color: 'var(--faint)' }}>
            ESC
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1.5">
          {items.length === 0 && <div className="px-4 py-6 text-center text-xs" style={{ color: 'var(--faint)' }}>输入命令名称、视图，或任意文字去搜索 / 提问</div>}
          {items.map((c, i) => {
            const showGroup = c.group !== lastGroup
            lastGroup = c.group
            return (
              <div key={c.id}>
                {showGroup && (
                  <div className="px-4 pt-2 pb-1 text-2xs font-semibold tracking-[0.06em] uppercase" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                    {c.group}
                  </div>
                )}
                <button
                  data-active={i === cursor}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => c.run()}
                  className="w-full flex items-center gap-2.5 px-4 py-[7px] text-sm text-left transition-colors duration-100"
                  style={{
                    background: i === cursor ? 'linear-gradient(90deg, var(--accent-soft), transparent 80%)' : 'transparent',
                    color: 'var(--fg)',
                    boxShadow: i === cursor ? 'inset 2px 0 0 var(--accent)' : undefined
                  }}
                >
                  <span className="shrink-0" style={{ color: i === cursor ? 'var(--accent)' : 'var(--faint)' }}>{c.icon ?? <IconCompose width={13} height={13} className="opacity-0" />}</span>
                  <span className="flex-1 truncate">{c.label}</span>
                  {c.hint && (
                    <kbd className="text-2xs px-1.5 py-0.5 rounded-md border border-[var(--border)] font-[var(--font-mono)]" style={{ color: 'var(--faint)' }}>
                      {c.hint}
                    </kbd>
                  )}
                </button>
              </div>
            )
          })}
        </div>
        <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--border-soft)] text-2xs" style={{ color: 'var(--faint)' }}>
          <span>↑↓ 选择</span>
          <span>↵ 执行</span>
          <span className="flex-1" />
          <span className="inline-flex items-center gap-1"><IconSparkles width={10} height={10} /> LinkTo 命令面板</span>
        </div>
      </div>
    </div>
  )
}
