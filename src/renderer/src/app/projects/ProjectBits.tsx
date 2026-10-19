import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { api } from '../../lib/api'
import { usePrefs } from '../../lib/prefs'
import { goView, useView } from '../../lib/route'
import { useMail } from '../../stores/mail'
import { pinyinMatch, usePinyin } from '../../lib/pinyin'
import {
  createProjectFromMessage, isLive, openContactTimeline, openProject, pickProjectFor, projectColor, toast,
  useProjectEvents, useProjectIndex, useProjectRoute, useProjects
} from '../../lib/projects'
import { counterpartyKey, domainOf, isPublicDomain } from '@shared/projects'
import type { MenuItem } from '../../components/Menu'
import { IconLayers, IconPlus, IconSearch, IconSparkles } from '../../components/icons'
import type { MessageSummary } from '@shared/types'

/** 时间线图标（竖线 + 节点） */
export const IconTimeline = (p: { width?: number; height?: number }) => (
  <svg width={p.width ?? 16} height={p.height ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3v18" />
    <circle cx="6" cy="7" r="2" fill="currentColor" />
    <circle cx="6" cy="17" r="2" />
    <path d="M11 7h9M11 17h6" />
  </svg>
)

// ---------------------------------------------------------------- 列表行里的项目小标签

/** 列表行项目标签：色点 + 短名（≤6 字），设置里可关；挤不下时只留色点 */
export function ProjectTag(props: { msg: Pick<MessageSummary, 'id' | 'threadId'> }) {
  const on = usePrefs().projectTags !== false
  const { of } = useProjectIndex()
  if (!on) return null
  const p = of(props.msg)
  if (!p) return null
  // 「公司 · 事情」取事情那半，更能认出是哪件事
  const short = p.data.name.includes(' · ') ? p.data.name.split(' · ').slice(1).join(' · ') : p.data.name
  const name = [...short]
  return (
    <span
      className="shrink min-w-0 max-w-[96px] h-4 pl-1 pr-1.5 inline-flex items-center gap-1 rounded-[var(--r-xs)] text-2xs"
      style={{ color: 'var(--muted)', boxShadow: 'inset 0 0 0 1px var(--border)' }}
      title={`项目：${p.data.name}`}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: projectColor(p) }} />
      <span className="truncate">{name.length > 6 ? `${name.slice(0, 6).join('')}…` : short}</span>
    </span>
  )
}

// ---------------------------------------------------------------- 阅读页项目关联条

/** 阅读页：属于项目时一条克制的关联条（色点 + 名称，可点进入）；有「建议归入」时给一键确认 */
export function ProjectStrip(props: { msg: { id: string; threadId: string } }) {
  useProjectEvents()
  const { of, suggestion } = useProjectIndex()
  const p = of(props.msg)
  const sug = !p ? suggestion(props.msg) : null
  if (!p && !sug) return null
  if (p)
    return (
      <div className="shrink-0 px-6 pt-3 flex items-center gap-1.5 text-xs">
        <span style={{ color: 'var(--faint)' }}>项目</span>
        <button
          onClick={() => openProject(p.id)}
          className="h-6 pl-2 pr-2.5 rounded-[var(--r-xs)] border border-[var(--border)] hover:bg-[var(--hover)] inline-flex items-center gap-1.5 min-w-0"
          style={{ color: 'var(--fg)' }}
          title="打开项目时间线"
        >
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: projectColor(p) }} />
          <span className="truncate max-w-[220px]">{p.data.name}</span>
          {p.stats.openTodos > 0 && <span className="tnum" style={{ color: 'var(--faint)' }}>· 待办 {p.stats.openTodos}</span>}
          <span style={{ color: 'var(--faint)' }}>›</span>
        </button>
      </div>
    )
  return (
    <div className="shrink-0 px-6 pt-3 flex flex-wrap items-center gap-1.5 text-xs" title={sug!.reason}>
      <span style={{ color: 'var(--faint)' }}>可能属于</span>
      <span className="h-6 px-2 rounded-[var(--r-xs)] inline-flex items-center gap-1.5" style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }} title={sug!.reason}>
        <span className="w-2 h-2 rounded-full" style={{ background: projectColor(sug!.project) }} />
        {sug!.project.data.name}
      </span>
      <button
        onClick={() => void api.projectResolveSuggestion(sug!.project.id, props.msg.threadId || props.msg.id, true).then(() => toast(`已归入「${sug!.project.data.name}」`))}
        className="h-6 px-2 rounded-[var(--r-xs)] font-medium"
        style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
      >
        归入
      </button>
      <button
        onClick={() => void api.projectResolveSuggestion(sug!.project.id, props.msg.threadId || props.msg.id, false)}
        className="h-6 px-2 rounded-[var(--r-xs)] hover:bg-[var(--hover)]"
        style={{ color: 'var(--muted)' }}
      >
        不是
      </button>
    </div>
  )
}

/** 阅读页 ⋯ 菜单里的项目动作 */
export function projectMenuItems(msg: MessageSummary, inProject: { id: string; data: { name: string } } | null): MenuItem[] {
  const icon = <IconLayers width={13} height={13} />
  const counterpart = msg.from?.address ?? ''
  const items: MenuItem[] = [
    { kind: 'action', label: inProject ? '换到其他项目…' : '加入项目…', icon, onSelect: () => pickProjectFor([msg.id]) }
  ]
  if (inProject)
    items.push({
      kind: 'action',
      label: `移出「${inProject.data.name.slice(0, 10)}」`,
      icon,
      onSelect: () => void api.projectRemoveMessages(inProject.id, [msg.id]).then(() => toast(`已移出「${inProject.data.name}」`))
    })
  else items.push({ kind: 'action', label: '建为项目', icon, onSelect: () => void createProjectFromMessage(msg.id) })
  if (counterpart) items.push({ kind: 'action', label: '与对方的往来时间线', icon: <IconTimeline width={13} height={13} />, onSelect: () => openContactTimeline(counterpart) })
  return items
}

// ---------------------------------------------------------------- 项目选择器（加入项目… / 可新建）

export function ProjectPickerHost() {
  const [ids, setIds] = useState<string[] | null>(null)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const items = useProjects(st => st.items)
  const inputRef = useRef<HTMLInputElement>(null)
  useProjectEvents()

  useEffect(() => {
    const on = (e: Event) => {
      const detail = (e as CustomEvent<string[]>).detail
      if (!detail?.length) return
      setIds(detail)
      setQ('')
      setCursor(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
    window.addEventListener('ms:project-pick', on)
    return () => window.removeEventListener('ms:project-pick', on)
  }, [])

  // 项目名支持拼音（qhgw / qinghe → 青禾官网）
  const pyVer = usePinyin(ids ? items.filter(isLive).map(p => p.data.name) : [])
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return items
      .filter(isLive)
      .filter(p => !s || p.data.name.toLowerCase().includes(s) || p.data.counterparties.some(c => c.includes(s)) || p.data.keywords.some(k => k.toLowerCase().includes(s)) || (s.length >= 2 && !!pinyinMatch(s, p.data.name)))
      .sort((a, b) => (b.stats.lastAt ?? 0) - (a.stats.lastAt ?? 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, q, pyVer])

  if (!ids) return null
  const close = () => setIds(null)
  const options: { key: string; label: ReactNode; run(): void }[] = [
    ...list.map(p => ({
      key: p.id,
      label: (
        <>
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: projectColor(p) }} />
          <span className="flex-1 truncate">{p.data.name}</span>
          <span className="text-2xs truncate max-w-[120px]" style={{ color: 'var(--faint)' }}>{p.data.counterparties.slice(0, 2).join('、')}</span>
        </>
      ),
      run: () => {
        void api.projectAddMessages(p.id, ids).then(() => toast(`已加入「${p.data.name}」`))
        close()
      }
    })),
    ...(q.trim()
      ? [
          {
            key: 'new',
            label: (
              <>
                <IconPlus width={13} height={13} />
                <span className="flex-1 truncate">新建项目「{q.trim()}」并加入</span>
              </>
            ),
            run: () => {
              void (async () => {
                const first = await api.projectFromMessage(ids[0])
                if (!first) return toast('没能建成项目')
                await api.saveProject({ id: first.id, data: { name: q.trim() } })
                if (ids.length > 1) await api.projectAddMessages(first.id, ids.slice(1))
                toast(`已建项目「${q.trim()}」`)
              })()
              close()
            }
          }
        ]
      : [
          {
            key: 'from',
            label: (
              <>
                <IconPlus width={13} height={13} />
                <span className="flex-1 truncate">用这封邮件新建项目（带入对方、会话、关键词）</span>
              </>
            ),
            run: () => {
              void createProjectFromMessage(ids[0])
              close()
            }
          }
        ])
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]" style={{ background: 'var(--scrim)' }} onMouseDown={close}>
      <div className="w-[440px] max-w-[calc(100vw-48px)] liquid-glass rounded-[var(--r-lg)] p-1.5 pop-in" onMouseDown={e => e.stopPropagation()} role="dialog" aria-label="加入项目">
        <label className="h-10 px-3 flex items-center gap-2 border-b border-[var(--border-soft)]">
          <IconSearch width={14} height={14} style={{ color: 'var(--faint)' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => {
              setQ(e.target.value)
              setCursor(0)
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') close()
              if (e.key === 'ArrowDown') (e.preventDefault(), setCursor(c => Math.min(options.length - 1, c + 1)))
              if (e.key === 'ArrowUp') (e.preventDefault(), setCursor(c => Math.max(0, c - 1)))
              if (e.key === 'Enter') options[cursor]?.run()
            }}
            placeholder={ids.length > 1 ? `把 ${ids.length} 封邮件加入项目…` : '加入项目…（输入名称可新建）'}
            className="flex-1 bg-transparent outline-none text-sm"
            style={{ color: 'var(--fg)' }}
          />
        </label>
        <div className="max-h-[320px] overflow-y-auto py-1">
          {options.map((o, i) => (
            <button
              key={o.key}
              onMouseEnter={() => setCursor(i)}
              onClick={o.run}
              className="w-full h-8 px-3 flex items-center gap-2 rounded-[var(--r-sm)] text-sm text-left"
              style={{ background: i === cursor ? 'var(--hover-strong)' : undefined, color: 'var(--fg)' }}
            >
              {o.label}
            </button>
          ))}
          {!list.length && !q && (
            <div className="px-3 py-2 text-xs" style={{ color: 'var(--faint)' }}>还没有进行中的项目，输入名称即可新建</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 侧栏：钉住的项目

type SideRow = (props: { icon?: ReactNode; label: string; unread?: number; muteCount?: boolean; active?: boolean; indent?: number; onClick(): void; color?: string }) => ReactElement

/** 侧栏里钉住的活跃项目（复用侧栏行组件，保持同一视觉） */
export function PinnedProjects(props: { Row: SideRow }) {
  useProjectEvents()
  const items = useProjects(st => st.items)
  const view = useView()
  const route = useProjectRoute()
  const pinned = items.filter(p => p.data.pinned && isLive(p))
  const Row = props.Row
  return (
    <>
      {pinned.map(p => (
        <Row
          key={p.id}
          label={p.data.name}
          color={projectColor(p)}
          indent={1}
          unread={p.stats.unread}
          muteCount
          active={view === 'projects' && route.mode === 'project' && route.id === p.id}
          onClick={() => openProject(p.id)}
        />
      ))}
    </>
  )
}

/** 侧栏「项目」行是否激活：在项目入口里、且当前打开的不是某个钉住的项目（避免双激活） */
export function useProjectsRowActive(): boolean {
  const view = useView()
  const route = useProjectRoute()
  const items = useProjects(st => st.items)
  if (view !== 'projects') return false
  if (route.mode !== 'project') return true
  return !items.some(p => p.id === route.id && p.data.pinned && isLive(p))
}

/** 待办编辑器：项目名对得上「项目」入口里的项目时，给一个直达链接 */
export function TodoProjectLink(props: { name: string }) {
  useProjectEvents()
  const items = useProjects(st => st.items)
  const p = props.name.trim() ? items.find(x => x.data.name === props.name.trim()) : null
  if (!p) return null
  return (
    <button onClick={() => openProject(p.id)} className="inline-flex items-center gap-1 text-xs hover:underline" style={{ color: 'var(--muted)' }} title="打开项目">
      <span className="w-2 h-2 rounded-full" style={{ background: projectColor(p) }} />
      项目页 ›
    </button>
  )
}

/** 侧栏「项目」行的角标：待确认的建议归入数 */
export function useProjectBadge(): number {
  useProjectEvents()
  const items = useProjects(st => st.items)
  return items.filter(isLive).reduce((s, p) => s + (p.data.suggestions?.length ?? 0), 0)
}

// ---------------------------------------------------------------- 右侧栏：往来时间线入口

export function ContactTimelineLinks(props: { addr: string }) {
  const domain = domainOf(props.addr)
  const company = domain && !isPublicDomain(domain)
  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={() => openContactTimeline(props.addr)}
        className="h-8 px-2.5 rounded-[var(--r-sm)] border border-[var(--border)] hover:bg-[var(--hover)] inline-flex items-center gap-2 text-xs"
        style={{ color: 'var(--fg)', background: 'var(--surface-strong)' }}
      >
        <IconTimeline width={13} height={13} />
        <span className="flex-1 text-left">按时间线看和 Ta 的往来</span>
        <span style={{ color: 'var(--faint)' }}>›</span>
      </button>
      {company && (
        <button onClick={() => openContactTimeline(counterpartyKey(props.addr))} className="self-start text-xs underline underline-offset-2" style={{ color: 'var(--muted)' }}>
          整个 {domain} 的往来时间线 →
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- ⌘K

export function projectCommands(close: () => void): { id: string; group: string; label: string; keywords?: string; icon?: ReactNode; run(): void }[] {
  const items = useProjects.getState().items
  const sel = useMail.getState()
  const msg = sel.messages.find(m => m.id === sel.selectedId)
  const out: { id: string; group: string; label: string; keywords?: string; icon?: ReactNode; run(): void }[] = [
    { id: 'nav-projects', group: '前往', label: '项目', keywords: 'project 时间线 timeline', icon: <IconLayers width={14} height={14} />, run: () => (goView('projects'), close()) },
    { id: 'proj-new', group: '操作', label: '新建项目…', keywords: 'project new', icon: <IconLayers width={14} height={14} />, run: () => (goView('projects'), close(), setTimeout(() => window.dispatchEvent(new CustomEvent('ms:project-new')), 120)) },
    { id: 'proj-discover', group: '操作', label: '从最近邮件发现项目', keywords: 'project discover ai 聚类', icon: <IconSparkles width={14} height={14} />, run: () => (goView('projects'), close(), setTimeout(() => window.dispatchEvent(new CustomEvent('ms:project-discover')), 120)) },
    ...items.filter(isLive).map(p => ({ id: `proj-${p.id}`, group: '前往', label: `项目 · ${p.data.name}`, keywords: `${p.data.counterparties.join(' ')} ${p.data.keywords.join(' ')}`, run: () => (openProject(p.id), close()) }))
  ]
  if (msg?.from?.address) {
    out.push({ id: 'proj-contact-tl', group: '操作', label: `与 ${msg.from.name || msg.from.address} 的往来时间线`, keywords: 'timeline 时间线 联系人', icon: <IconTimeline width={14} height={14} />, run: () => (openContactTimeline(msg.from!.address), close()) })
    out.push({ id: 'proj-add-current', group: '操作', label: '把当前邮件加入项目…', keywords: 'project add', icon: <IconLayers width={14} height={14} />, run: () => (close(), pickProjectFor([msg.id])) })
  }
  return out
}
