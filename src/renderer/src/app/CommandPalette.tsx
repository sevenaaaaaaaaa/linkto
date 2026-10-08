import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useMail, type Scope } from '../stores/mail'
import { cycleTheme, themeLabel } from '../lib/theme'
import { IconSearch, IconSparkles, IconCompose, IconSettings, IconInbox, IconRefresh } from '../components/icons'
import type { MessageSummary } from '@shared/types'

interface Command {
  id: string
  group: string
  label: string
  hint?: string
  icon?: React.ReactNode
  keywords?: string
  run(): void
}

const emit = (name: string) => window.dispatchEvent(new CustomEvent(name))

/** ⌘K 命令面板 —— ThirdC 式全局快速操作：导航 / 动作 / 邮件直达 */
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
      if (alive) setResults(r)
    })
    return () => {
      alive = false
    }
  }, [query, props.open])

  const commands = useMemo<Command[]>(() => {
    const state = useMail.getState()
    const go = (scope: Partial<Scope>, title: string) => () => {
      useMail.getState().setScope({ kind: 'unified', ...scope, title } as Scope)
      if (location.hash !== '#/mail') location.hash = '#/mail'
      props.onClose()
    }
    const nav: Command[] = [
      { id: 'nav-unified', group: '前往', label: '统一收件箱', icon: <IconInbox width={14} height={14} />, run: go({ kind: 'unified' }, '统一收件箱') },
      { id: 'nav-flagged', group: '前往', label: '已加旗标', run: go({ kind: 'flagged' }, '已加旗标') },
      { id: 'nav-personal', group: '前往', label: '个人邮件', run: go({ kind: 'category', category: 'personal' }, '个人邮件') },
      { id: 'nav-notification', group: '前往', label: '通知', run: go({ kind: 'category', category: 'notification' }, '通知') },
      { id: 'nav-newsletter', group: '前往', label: 'Newsletter', run: go({ kind: 'newsletter' }, 'Newsletter') },
      { id: 'nav-noise', group: '前往', label: '噪声', run: go({ kind: 'category', category: 'noise' }, '噪声') },
      { id: 'nav-insights', group: '前往', label: '智能洞察（商情 / 待办 / 阅读清单 / 公司分析）', run: () => { location.hash = '#/insights'; props.onClose() } },
      { id: 'nav-kb', group: '前往', label: '知识库', run: () => { location.hash = '#/kb'; useMail.getState().setScope({ kind: 'unified', title: '知识库' }); props.onClose() } },
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
    return [...actions, ...nav]
  }, [props.open, props.onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter(c => (c.label + ' ' + (c.keywords ?? '')).toLowerCase().includes(q))
  }, [commands, query])

  const items = useMemo<Command[]>(
    () => [
      ...filtered,
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
    [filtered, results, props.onClose]
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
        className="glass-strong relative w-[560px] max-w-[86vw] rounded-[var(--r-md)] border border-[var(--glass-border)] shadow-[var(--shadow)] overflow-hidden pop-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 h-[52px] border-b border-[var(--border-soft)]">
          <IconSearch width={15} height={15} style={{ color: 'var(--muted)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索命令、视图，或直接输入关键词找邮件…"
            className="flex-1 bg-transparent outline-none text-[13.5px] placeholder:text-[var(--faint)]"
          />
          <kbd className="text-[10.5px] px-1.5 py-0.5 rounded-md border border-[var(--border)] font-[var(--font-mono)]" style={{ color: 'var(--faint)' }}>
            ESC
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1.5">
          {items.length === 0 && <div className="px-4 py-6 text-center text-[12.5px]" style={{ color: 'var(--faint)' }}>没有匹配的命令</div>}
          {items.map((c, i) => {
            const showGroup = c.group !== lastGroup
            lastGroup = c.group
            return (
              <div key={c.id}>
                {showGroup && (
                  <div className="px-4 pt-2 pb-1 text-[10.5px] font-semibold tracking-[.08em] uppercase" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                    {c.group}
                  </div>
                )}
                <button
                  data-active={i === cursor}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => c.run()}
                  className="w-full flex items-center gap-2.5 px-4 py-[7px] text-[13px] text-left"
                  style={{ background: i === cursor ? 'var(--accent-soft)' : 'transparent', color: 'var(--fg)' }}
                >
                  <span className="shrink-0" style={{ color: i === cursor ? 'var(--accent)' : 'var(--faint)' }}>{c.icon ?? <IconCompose width={13} height={13} className="opacity-0" />}</span>
                  <span className="flex-1 truncate">{c.label}</span>
                  {c.hint && (
                    <kbd className="text-[10.5px] px-1.5 py-0.5 rounded-md border border-[var(--border)] font-[var(--font-mono)]" style={{ color: 'var(--faint)' }}>
                      {c.hint}
                    </kbd>
                  )}
                </button>
              </div>
            )
          })}
        </div>
        <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--border-soft)] text-[11px]" style={{ color: 'var(--faint)' }}>
          <span>↑↓ 选择</span>
          <span>↵ 执行</span>
          <span className="flex-1" />
          <span className="inline-flex items-center gap-1"><IconSparkles width={10} height={10} /> Mail Studio 命令面板</span>
        </div>
      </div>
    </div>
  )
}
