import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useView } from '../../lib/route'
import { feedScopeFromHash, groupSources, openFeeds, unreadOf, useFeedEvents, useFeeds } from '../../lib/feeds'
import { scopeKey, type FeedScope } from '@shared/feeds'
import { IconChevronDown, IconFolder, IconRss, IconSparkles, IconStar, IconSearch } from '../../components/icons'

/** 侧栏展开后最多直接列出的条目（分组 / 订阅源），其余从「全部订阅」里看 */
const MAX_SHOWN = 8

type RowComp = (props: {
  icon?: React.ReactNode
  label: string
  unread?: number
  muteCount?: boolean
  active?: boolean
  onClick(): void
  trailing?: React.ReactNode
}) => React.ReactElement

function useOpen(): [boolean, () => void] {
  const key = 'ms_side_feeds'
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  return [
    open,
    () =>
      setOpen(o => {
        try {
          localStorage.setItem(key, o ? '0' : '1')
        } catch {
          /* 仅本次生效 */
        }
        return !o
      })
  ]
}

function useScope(): FeedScope {
  const [s, setS] = useState<FeedScope>(() => feedScopeFromHash())
  useEffect(() => {
    const on = () => setS(feedScopeFromHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return s
}

function SubRow(props: { icon: React.ReactNode; label: string; count?: number; active?: boolean; onClick(): void; title?: string; error?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      title={props.title ?? props.label}
      aria-current={props.active ? 'page' : undefined}
      className={`w-full h-6 flex items-center gap-2 pl-[30px] pr-2 rounded-[var(--r-sm)] text-xs transition-colors ${props.active ? 'font-medium' : 'hover:bg-[var(--hover)]'}`}
      style={{ background: props.active ? 'var(--selected)' : undefined, color: props.active ? 'var(--accent-ink)' : 'var(--fg)' }}
    >
      <span className="w-3.5 shrink-0 inline-flex justify-center" style={{ color: props.active ? 'var(--accent)' : props.error ? 'var(--danger)' : 'var(--faint)' }}>
        {props.icon}
      </span>
      <span className="flex-1 text-left truncate">{props.label}</span>
      {!!props.count && <span className="text-2xs tnum shrink-0" style={{ color: 'var(--faint)' }}>{props.count > 999 ? '999+' : props.count}</span>}
    </button>
  )
}

/** 侧栏「订阅」：一级行显示未读数，可展开分组 / 订阅源（最多 8 个）+ 收藏 / AI 搜索订阅 / 今日精华 */
export function FeedNavSection(props: { Row: RowComp; ico: { width: number; height: number } }) {
  useFeedEvents()
  const view = useView()
  const scope = useScope()
  const [open, toggle] = useOpen()
  const sources = useFeeds(st => st.sources)
  const unread = unreadOf(sources)
  const inFeeds = view === 'feeds'
  const groups = groupSources(sources)
  const topics = sources.filter(s => s.kind === 'search')
  const key = inFeeds ? scopeKey(scope) : ''
  const sub = { width: 12, height: 12 }

  // 分组优先显示为一行；没分组的订阅源逐个列出
  const entries: { key: string; scope: FeedScope; label: string; count: number; folder: boolean; error?: boolean }[] = []
  for (const g of groups) {
    if (g.name) entries.push({ key: scopeKey({ kind: 'group', name: g.name }), scope: { kind: 'group', name: g.name }, label: g.name, count: g.unread, folder: true })
    else for (const s of g.sources) entries.push({ key: scopeKey({ kind: 'source', id: s.id }), scope: { kind: 'source', id: s.id }, label: s.title, count: s.enabled ? s.unread : 0, folder: false, error: !!s.lastError && s.failCount > 1 })
  }
  const shown = entries.slice(0, MAX_SHOWN)

  return (
    <>
      <props.Row
        icon={<IconRss {...props.ico} />}
        label="订阅"
        unread={unread}
        muteCount
        active={inFeeds && (!open || key === 'all')}
        onClick={() => openFeeds()}
        trailing={
          sources.length ? (
            <span
              role="button"
              tabIndex={0}
              aria-label={open ? '收起订阅源' : '展开订阅源'}
              aria-expanded={open}
              onClick={e => {
                e.stopPropagation()
                toggle()
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  toggle()
                }
              }}
              className="w-4 h-4 -mr-0.5 inline-flex items-center justify-center rounded-[var(--r-xs)] hover:bg-[var(--hover-strong)]"
              style={{ color: 'var(--faint)' }}
            >
              <span className="inline-flex transition-transform" style={{ transform: open ? 'none' : 'rotate(-90deg)', transitionDuration: 'var(--dur-2)' }}>
                <IconChevronDown width={11} height={11} />
              </span>
            </span>
          ) : undefined
        }
      />
      {open && sources.length > 0 && (
        <div className="pb-0.5">
          <SubRow icon={<IconSparkles {...sub} />} label="今日精华" active={key === 'digest'} onClick={() => openFeeds({ kind: 'digest' })} />
          <SubRow icon={<IconStar {...sub} />} label="收藏" active={key === 'starred'} onClick={() => openFeeds({ kind: 'starred' })} />
          {topics.length > 0 && (
            <SubRow icon={<IconSearch {...sub} />} label="AI 搜索订阅" count={topics.reduce((n, t) => n + t.unread, 0)} active={key === 'topics'} onClick={() => openFeeds({ kind: 'topics' })} />
          )}
          {shown.map(e => (
            <SubRow
              key={e.key}
              icon={e.folder ? <IconFolder {...sub} /> : <IconRss {...sub} />}
              label={e.label}
              count={e.count}
              error={e.error}
              title={e.error ? `${e.label}：最近更新失败` : e.label}
              active={key === e.key}
              onClick={() => openFeeds(e.scope)}
            />
          ))}
          {entries.length > MAX_SHOWN && (
            <button onClick={() => openFeeds()} className="w-full h-6 pl-[52px] pr-2 text-left text-2xs rounded-[var(--r-sm)] hover:bg-[var(--hover)]" style={{ color: 'var(--faint)' }}>
              还有 {entries.length - MAX_SHOWN} 个 · 全部订阅 →
            </button>
          )}
        </div>
      )}
    </>
  )
}

/** 今日简报卡片里的一行订阅精华（设置 → 订阅「精华并入今日简报」打开、且今天已生成时显示） */
export function FeedBriefLine() {
  const settings = useFeeds(st => st.settings)
  const [line, setLine] = useState<string | null>(null)
  useFeedEvents()
  useEffect(() => {
    let alive = true
    if (!settings?.digestInBrief) {
      setLine(null)
      return
    }
    const d = new Date()
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    void api.feedDigest(day).then(x => alive && setLine(x ? x.headline : null))
    return () => {
      alive = false
    }
  }, [settings?.digestInBrief])
  if (!line) return null
  return (
    <button onClick={() => openFeeds({ kind: 'digest' })} className="block w-full text-left text-xs leading-[18px] truncate hover:underline" style={{ color: 'var(--muted)' }} title="今日订阅精华">
      订阅精华：{line}
    </button>
  )
}
