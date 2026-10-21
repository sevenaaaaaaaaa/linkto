import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useMail } from '../stores/mail'
import { useSearch, QUICK_LABEL, type QuickFilter } from '../stores/search'
import { SYNTAX_HINTS, splitHits, worthSearching } from '../lib/search'
import { MenuButton, type MenuItem } from '../components/Menu'
import { IconSearch, IconSparkles, IconClose, IconClock, IconChevronDown, IconPlus } from '../components/icons'
import type { SearchIndexStatus } from '@shared/ipc'

/**
 * 列表搜索：搜索框（边输边搜 + 最近搜索 / 语法提示下拉）、结果头部（数量 · 方式 · 范围 + 胶囊）、
 * 无结果状态，以及列表行里的命中高亮。
 */

/** 列表行高亮用的命中词：只在搜索结果视图里生效 */
export function useSearchTerms(): string[] {
  const inSearch = useMail(s => s.scope.kind === 'search')
  const terms = useSearch(s => s.terms)
  return inSearch ? terms : EMPTY
}
const EMPTY: string[] = []

/** 文本中的命中词用荧光标记（复用 AI 要点的 mark.hl token） */
export function Hl(props: { text: string; terms: string[] }) {
  if (!props.terms.length) return <>{props.text}</>
  return (
    <>
      {splitHits(props.text, props.terms).map((p, i) => (p.hit ? <mark key={i} className="hl">{p.s}</mark> : <span key={i}>{p.s}</span>))}
    </>
  )
}

type DropItem = { kind: 'recent'; q: string } | { kind: 'hint'; insert: string; label: string; example: string }

export function SearchBox() {
  const input = useSearch(s => s.input)
  const recent = useSearch(s => s.recent)
  const aiBusy = useSearch(s => s.aiBusy)
  const [focused, setFocused] = useState(false)
  const [cursor, setCursor] = useState(-1)
  const timer = useRef<number | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const dropOpen = focused && !input.trim()
  const items = useMemo<DropItem[]>(() => [...recent.map(q => ({ kind: 'recent' as const, q })), ...SYNTAX_HINTS.map(h => ({ kind: 'hint' as const, ...h }))], [recent])

  useEffect(() => setCursor(-1), [dropOpen, recent.length])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const st = () => useSearch.getState()
  const onChange = (v: string) => {
    st().setInput(v)
    window.clearTimeout(timer.current)
    if (!v.trim()) {
      // 删空 = 回到搜索前的视图（焦点留在输入框）
      if (st().active) st().clear()
      return
    }
    timer.current = window.setTimeout(() => {
      if (worthSearching(v)) void st().run(v)
    }, 250)
  }

  const pick = (it: DropItem) => {
    if (it.kind === 'recent') {
      void st().run(it.q, { commit: true })
    } else {
      st().setInput(it.insert)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (el) el.setSelectionRange(el.value.length, el.value.length)
      })
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (dropOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      e.stopPropagation()
      setCursor(c => (e.key === 'ArrowDown' ? Math.min(c + 1, items.length - 1) : Math.max(c - 1, -1)))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      window.clearTimeout(timer.current)
      if (dropOpen && cursor >= 0 && items[cursor]) return pick(items[cursor])
      if (!input.trim()) return
      void st().run(input, e.shiftKey ? { ai: true } : { commit: true })
      return
    }
    if (e.key === 'Escape') {
      window.clearTimeout(timer.current)
      if (input || st().active) st().clear()
      else inputRef.current?.blur()
    }
  }

  const recentCount = recent.length
  return (
    <div
      className="no-drag relative flex-1 h-7 flex items-center gap-1.5 rounded-[var(--r-sm)] px-2 border border-[var(--border-soft)] transition-shadow focus-within:shadow-[var(--focus-ring)]"
      style={{ background: 'var(--bg-soft)' }}
    >
      <IconSearch width={14} height={14} style={{ color: 'var(--faint)' }} />
      <input
        ref={inputRef}
        value={input}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        data-mail-search
        data-search-input
        placeholder="搜索邮件（⌘F）· 如 from:李若 未读"
        aria-label="搜索邮件"
        aria-expanded={dropOpen}
        className="flex-1 min-w-0 bg-transparent outline-none text-sm placeholder:text-[var(--faint)]"
      />
      <button
        onMouseDown={e => e.preventDefault()}
        onClick={() => void st().run(input, { ai: true })}
        disabled={aiBusy || !input.trim()}
        title="AI 搜索（Shift+↵）：用一句话描述要找的邮件，AI 编译成查询"
        aria-label="AI 搜索"
        className="shrink-0 inline-flex items-center disabled:opacity-40"
        style={{ color: 'var(--accent-strong)' }}
      >
        <IconSparkles width={13} height={13} className={aiBusy ? 'spinning' : ''} />
      </button>
      {input && (
        <button onMouseDown={e => e.preventDefault()} onClick={() => st().clear()} title="清空（Esc）" aria-label="清空搜索" style={{ color: 'var(--faint)' }}>
          <IconClose width={12} height={12} />
        </button>
      )}

      {dropOpen && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1.5 z-50 pop-in rounded-[var(--r-md)] p-1 max-h-[60vh] overflow-y-auto border border-[var(--border)]"
          style={{ background: 'var(--surface-strong)', boxShadow: 'var(--shadow)' }}
          onMouseDown={e => e.preventDefault()}
        >
          {recentCount > 0 && (
            <div className="caps px-2 pt-1.5 pb-1 flex items-center" style={{ color: 'var(--faint)' }}>
              <span className="flex-1">最近搜索</span>
              <button onClick={() => st().forgetRecent()} className="normal-case text-2xs hover:underline" style={{ color: 'var(--faint)' }}>
                清除
              </button>
            </div>
          )}
          {items.map((it, i) => {
            const on = i === cursor
            const head = it.kind === 'hint' && i === recentCount
            return (
              <div key={it.kind === 'recent' ? `r-${it.q}` : `h-${it.insert}`}>
                {head && (
                  <div className={`caps px-2 pb-1 ${recentCount ? 'pt-2 mt-1 border-t border-[var(--border-soft)]' : 'pt-1.5'}`} style={{ color: 'var(--faint)' }}>
                    搜索语法（不需要 AI）
                  </div>
                )}
                <div
                  role="option"
                  aria-selected={on}
                  data-active={on}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(it)}
                  className="group h-7 flex items-center gap-2 px-2 rounded-[var(--r-sm)] text-sm cursor-default"
                  style={{ background: on ? 'var(--hover-strong)' : 'transparent', color: 'var(--fg)' }}
                >
                  {it.kind === 'recent' ? (
                    <>
                      <IconClock width={12} height={12} className="shrink-0" style={{ color: 'var(--faint)' }} />
                      <span className="flex-1 truncate">{it.q}</span>
                      <button
                        title="从最近搜索中移除"
                        aria-label="移除"
                        onClick={e => {
                          e.stopPropagation()
                          st().forgetRecent(it.q)
                        }}
                        className="opacity-0 group-hover:opacity-100 shrink-0 inline-flex"
                        style={{ color: 'var(--faint)' }}
                      >
                        <IconClose width={11} height={11} />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="shrink-0 text-xs w-[132px] truncate" style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-ink)' }}>
                        {it.example}
                      </span>
                      <span className="flex-1 truncate text-xs" style={{ color: 'var(--muted)' }}>{it.label}</span>
                    </>
                  )}
                </div>
              </div>
            )
          })}
          <div className="px-2 pt-1.5 pb-1 text-2xs flex items-center gap-2" style={{ color: 'var(--faint)' }}>
            <span>↑↓ 选择 · ↵ 搜索 · Shift+↵ AI 搜索</span>
          </div>
        </div>
      )}
    </div>
  )
}

/** 胶囊：识别出的语法 / 快速筛选，可移除 */
function Chip(props: { label: string; onRemove?(): void; onAdd?(): void; muted?: boolean }) {
  if (props.onAdd)
    return (
      <button
        onClick={props.onAdd}
        className="shrink-0 h-6 px-2 inline-flex items-center gap-1 rounded-full text-2xs border border-dashed transition-colors hover:bg-[var(--hover)]"
        style={{ borderColor: 'var(--border-strong)', color: 'var(--muted)' }}
      >
        <IconPlus width={10} height={10} />
        {props.label}
      </button>
    )
  return (
    <span
      className="shrink-0 h-6 pl-2 pr-1 inline-flex items-center gap-1 rounded-full text-2xs"
      style={{ background: props.muted ? 'var(--hover)' : 'var(--selected)', color: props.muted ? 'var(--muted)' : 'var(--accent-ink)' }}
    >
      {props.label}
      {props.onRemove && (
        <button onClick={props.onRemove} title="移除这个条件" aria-label={`移除 ${props.label}`} className="w-4 h-4 inline-flex items-center justify-center rounded-full hover:bg-[var(--hover-strong)]">
          <IconClose width={9} height={9} />
        </button>
      )}
    </span>
  )
}

const QUICK_KEYS: QuickFilter[] = ['unread', 'attach', 'recent30']

/** 中文搜索索引状态：首次启用 / 升级后存量邮件在后台回填，期间显示进度 */
function useSearchIndexStatus(): SearchIndexStatus | null {
  const [st, setSt] = useState<SearchIndexStatus | null>(null)
  useEffect(() => {
    let alive = true
    void api.searchIndexStatus().then(v => alive && setSt(v)).catch(() => {})
    const off = api.onEvent(ev => {
      const e = ev as { type?: string } & Partial<SearchIndexStatus>
      if (e?.type === 'search-index-progress') setSt({ enabled: !!e.enabled, indexed: e.indexed ?? 0, total: e.total ?? 0, building: !!e.building })
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return st
}

/** 搜索结果头部：N 个结果 · 关键词/AI · 范围，胶囊行，AI 理解 / 失败说明 */
export function SearchHeader() {
  const s = useSearch()
  const idx = useSearchIndexStatus()
  const total = useMail(m => m.total)
  const loading = useMail(m => m.loading)
  const accounts = useMail(m => m.accounts)
  if (!s.active) return null
  const rangeName = s.range ? accounts.find(a => a.id === s.range)?.name ?? '当前账户' : '全部账户'
  const rangeMenu: MenuItem[] = [
    { kind: 'check', label: '全部账户', checked: !s.range, onSelect: () => s.setRange(null) },
    ...(accounts.length ? [{ kind: 'sep' as const }] : []),
    ...accounts.map(a => ({ kind: 'check' as const, label: a.name, hint: a.email.split('@')[1] ?? '', checked: s.range === a.id, onSelect: () => s.setRange(a.id) }))
  ]
  // 语法里已给出的条件不再重复出现在「+ 筛选」里
  const tokenLabels = new Set(s.tokens.map(t => t.label))
  const addable = QUICK_KEYS.filter(k => !s.quick.includes(k) && !tokenLabels.has(QUICK_LABEL[k]))
  const hasAccountToken = s.tokens.some(t => t.label.startsWith('账户：'))

  return (
    <div className="shrink-0 px-3 py-1.5 border-b border-[var(--border-soft)] fade-in space-y-1.5" style={{ background: 'var(--bg-soft)' }} aria-live="polite">
      <div className="flex items-center gap-1.5 text-xs min-w-0" style={{ color: 'var(--muted)' }}>
        <span className="tnum shrink-0 font-medium" style={{ color: 'var(--fg)' }}>{loading && !total ? '搜索中…' : `${total} 个结果`}</span>
        <span style={{ color: 'var(--faint)' }}>·</span>
        <span className="shrink-0 inline-flex items-center gap-1" style={{ color: s.mode === 'ai' ? 'var(--accent-strong)' : 'var(--muted)' }}>
          {s.mode === 'ai' && <IconSparkles width={11} height={11} />}
          {s.mode === 'ai' ? 'AI' : '关键词'}
        </span>
        <span style={{ color: 'var(--faint)' }}>·</span>
        {hasAccountToken ? (
          <span className="truncate">按语法限定账户</span>
        ) : (
          <MenuButton
            title="切换搜索范围"
            items={rangeMenu}
            align="left"
            width={220}
            className="h-6 px-1.5 -mx-1 inline-flex items-center gap-1 rounded-[var(--r-xs)] text-xs hover:bg-[var(--hover)] min-w-0"
          >
            <span className="truncate">{rangeName}</span>
            <IconChevronDown width={11} height={11} className="shrink-0" />
          </MenuButton>
        )}
        <div className="flex-1" />
        {s.aiBusy && (
          <span className="shrink-0 inline-flex items-center gap-1 text-2xs" style={{ color: 'var(--accent-strong)' }}>
            <IconSparkles width={10} height={10} className="spinning" /> AI 理解中…
          </span>
        )}
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        {s.tokens.map(t => (
          <Chip key={t.raw} label={t.label} muted={t.label.includes('未找到')} onRemove={() => s.dropToken(t.raw)} />
        ))}
        {s.quick.map(k => (
          <Chip key={k} label={QUICK_LABEL[k]} onRemove={() => s.toggleQuick(k)} />
        ))}
        {addable.map(k => (
          <Chip key={k} label={QUICK_LABEL[k]} onAdd={() => s.toggleQuick(k)} />
        ))}
      </div>

      {idx?.building && idx.total > 0 && (
        <div className="text-2xs truncate tnum" style={{ color: 'var(--faint)' }} title="首次启用中文搜索索引：已有邮件在后台分批建立索引，期间结果仍完整，只是稍慢">
          正在为已有邮件建立中文搜索索引 {Math.min(99, Math.floor((idx.indexed / idx.total) * 100))}%，结果完整、速度稍慢
        </div>
      )}

      {s.loose && s.mode === 'keyword' && (
        <div className="text-2xs truncate" style={{ color: 'var(--faint)' }} title="整句没有命中，已去掉口语词逐个匹配">
          整句没有命中，已按「{s.loose.join(' + ')}」宽松匹配
        </div>
      )}

      {s.mode === 'ai' && s.aiDesc && (
        <div className="flex items-center gap-1.5 text-xs rounded-[var(--r-sm)] px-2 py-1" style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}>
          <IconSparkles width={11} height={11} className="shrink-0" />
          <span className="truncate flex-1" title={s.aiDesc}>AI 理解为：{s.aiDesc}</span>
          <button onClick={() => s.revertAi()} className="shrink-0 text-2xs font-medium hover:underline" style={{ color: 'var(--accent-ink)' }}>
            撤回到关键词结果
          </button>
        </div>
      )}

      {s.aiNote && s.mode === 'keyword' && (
        <div className="flex items-center gap-1.5 text-xs rounded-[var(--r-sm)] px-2 py-1" style={{ background: 'var(--hover)', color: 'var(--muted)' }}>
          <IconSparkles width={11} height={11} className="shrink-0" style={{ color: 'var(--faint)' }} />
          <span className="truncate flex-1" title={`${s.aiNote.text}，当前显示的是关键词结果`}>{s.aiNote.text}</span>
          {s.aiNote.setup && (
            <button onClick={() => void api.openSettings('ai')} className="shrink-0 text-2xs font-medium hover:underline" style={{ color: 'var(--accent-ink)' }}>
              去设置 AI
            </button>
          )}
          {!s.aiNote.setup && (
            <button onClick={() => void s.run(s.active, { ai: true })} className="shrink-0 text-2xs font-medium hover:underline" style={{ color: 'var(--accent-ink)' }}>
              重试
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** 无结果：说明搜了什么 + 可点的建议 */
export function SearchEmpty() {
  const s = useSearch()
  const accounts = useMail(m => m.accounts)
  const rangeName = s.range ? accounts.find(a => a.id === s.range)?.name ?? '当前账户' : '全部账户'
  const conds = [...s.tokens.map(t => t.label), ...s.quick.map(k => QUICK_LABEL[k])]
  const words = s.mode === 'ai' ? (s.aiDesc ? [s.aiDesc] : []) : searchWords(s.active, s.tokens)

  if (s.aiBusy)
    return (
      <div className="p-10 text-center fade-in">
        <div className="inline-flex items-center gap-1.5 text-sm" style={{ color: 'var(--accent-strong)' }}>
          <IconSparkles width={13} height={13} className="spinning" /> 关键词没有直接命中，AI 正在理解你的问题…
        </div>
      </div>
    )

  const Btn = (p: { children: React.ReactNode; onClick(): void }) => (
    <button
      onClick={p.onClick}
      className="h-7 px-2.5 inline-flex items-center gap-1 rounded-full text-xs border border-[var(--border)] transition-colors hover:bg-[var(--hover)] hover:border-[var(--border-strong)]"
      style={{ color: 'var(--fg)', background: 'var(--surface-strong)' }}
    >
      {p.children}
    </button>
  )

  return (
    <div className="px-6 py-10 text-center fade-in">
      <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
        没有找到{words.length ? <>与「{words.join(' ')}」相关的</> : '符合条件的'}邮件
      </div>
      <div className="mt-1.5 text-xs leading-5" style={{ color: 'var(--faint)' }}>
        在{rangeName}的全部文件夹中按{s.mode === 'ai' ? ' AI 理解' : '关键词'}搜索{conds.length ? <> · 条件：{conds.join('、')}</> : null}
      </div>
      <div className="mt-4 flex flex-wrap justify-center gap-1.5">
        {s.tokens.slice(0, 3).map(t => (
          <Btn key={t.raw} onClick={() => s.dropToken(t.raw)}>去掉「{t.label}」</Btn>
        ))}
        {s.quick.map(k => (
          <Btn key={k} onClick={() => s.toggleQuick(k)}>去掉「{QUICK_LABEL[k]}」</Btn>
        ))}
        {s.range && <Btn onClick={() => s.setRange(null)}>扩到全部账户</Btn>}
        {s.mode === 'keyword' && s.aiNote?.setup && <Btn onClick={() => void api.openSettings('ai')}>去设置 AI</Btn>}
        {s.mode === 'keyword' && !s.aiNote?.setup && (
          <Btn onClick={() => void s.run(s.active, { ai: true })}>
            <IconSparkles width={11} height={11} style={{ color: 'var(--accent-strong)' }} /> 试试 AI 搜索
          </Btn>
        )}
        {s.mode === 'ai' && <Btn onClick={() => s.revertAi()}>回到关键词结果</Btn>}
      </div>
      <div className="mt-3 text-2xs" style={{ color: 'var(--faint)' }}>
        检查一下拼写，或换个更短的关键词；中文人名可以只输入姓名中的两个字
      </div>
    </div>
  )
}

/** 无结果说明里展示的纯文本关键词 */
function searchWords(active: string, tokens: { raw: string }[]): string[] {
  let rest = active.replace(/：/g, ':')
  for (const t of tokens) rest = rest.replace(t.raw, ' ')
  return rest.split(/\s+/).filter(Boolean)
}
