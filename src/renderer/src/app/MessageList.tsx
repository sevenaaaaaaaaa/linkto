import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useMail, sortMessages } from '../stores/mail'
import { api, fmtDate, displayName } from '../lib/api'
import { subjectIsAuth } from '../lib/auth-detect'
import { SnoozeMenu, snoozeTargets, fmtSnooze } from './SnoozeMenu'
import { MenuButton, type MenuItem } from '../components/Menu'
import { IconMore, IconFilter, IconSearch, IconSparkles, IconAttach, IconFlag, IconRefresh, IconClose, IconArchive, IconTrash, IconPin, IconKey, IconChat, IconInbox, IconFolder, IconClock, IconSave, IconBellRing } from '../components/icons'
import type { BulkTodo, Folder, ListSort, MailInsight, MessageSummary, TodayBrief } from '@shared/types'
import { AccountErrorBanner } from './AccountIssues'
import { toastAIError } from '../lib/ai-error'
import { goView } from '../lib/route'
import { noteMouseAction } from './Guidance'
import { usePrefs, setPrefs } from '../lib/prefs'
import { useInsights, splitKey } from '../lib/insights'
import { Markdown } from '../components/Markdown'
import { SearchBox, SearchHeader, SearchEmpty, Hl, useSearchTerms } from './MailSearch'
import { useSearch } from '../stores/search'
import { ProjectTag } from './projects/ProjectBits'
import { FollowupBoard, FollowQuickBtn } from './followups/FollowupBoard'

const CATEGORY_BADGE: Record<string, { label: string; cls: string }> = {
  newsletter: { label: '订阅', cls: 'bg-[var(--cat-newsletter-soft)] text-[var(--cat-newsletter)]' },
  notification: { label: '通知', cls: 'bg-[var(--warn-soft)] text-[var(--warn-ink)]' },
  noise: { label: '噪声', cls: 'bg-[var(--hover)] text-[var(--faint)]' }
}

const SORT_LABEL: Record<ListSort, string> = {
  date: '最新在前',
  dateAsc: '最早在前',
  unread: '未读优先',
  smart: '重要优先'
}

/** 标签过滤维度：AI 分类 + 状态切片 */
type ListFilter = 'all' | 'personal' | 'notification' | 'newsletter' | 'noise' | 'unread' | 'attach' | 'flagged' | 'pinned'

/** 行首 16px 槽位：平时是未读点，悬停 / 多选时变勾选框（不额外占列宽） */
function RowSlot(props: { checked: boolean; show: boolean; unread: boolean; onToggle(): void }) {
  return (
    <div
      className="relative w-4 h-[18px] shrink-0 flex items-center justify-center"
      onClick={e => {
        if (!props.show) return
        e.stopPropagation()
        props.onToggle()
      }}
    >
      {!props.show && props.unread && <span className="w-2 h-2 rounded-full" style={{ background: 'var(--accent)' }} aria-label="未读" />}
      {props.show && (
        <span
          role="checkbox"
          aria-checked={props.checked}
          className="w-4 h-4 rounded-[var(--r-xs)] border-[1.5px] flex items-center justify-center fade-in"
          style={{ borderColor: props.checked ? 'var(--accent)' : 'var(--border-strong)', background: props.checked ? 'var(--accent)' : 'var(--surface-strong)' }}
        >
          {props.checked && (
            <svg viewBox="0 0 24 24" width={10} height={10} fill="none" stroke="var(--on-accent)" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </span>
      )}
    </div>
  )
}

/** AI 一句话要点：关键短语荧光标出；没有理解结果时退回摘要片段 */
function GistLine(props: { msg: MessageSummary; insight?: MailInsight }) {
  const { insight, msg } = props
  const preview = usePrefs().rowPreview
  const terms = useSearchTerms()
  if (preview === 'none') return null
  // 搜索结果：摘要里有命中词时优先展示摘要，让用户看到「为什么搜到它」
  const snippetHit = terms.length > 0 && terms.some(t => msg.snippet?.toLowerCase().includes(t.toLowerCase()))
  if (preview === 'snippet' || !insight?.gist || snippetHit)
    return (
      <div className="mt-0.5 truncate text-xs" style={{ color: 'var(--faint)' }}>
        <Hl text={msg.snippet} terms={terms} />
      </div>
    )
  const [pre, key, post] = splitKey(insight.gist, insight.gistKey)
  return (
    <div className="mt-0.5 text-xs leading-[18px] line-clamp-2" style={{ color: 'var(--muted)' }} title={insight.source === 'ai' ? 'AI 要点' : '要点'}>
      <Hl text={pre} terms={terms} />
      {key && <mark className="hl">{key}</mark>}
      <Hl text={post} terms={terms} />
    </div>
  )
}

/** 多选模式判定（store 派生）：打开的那一封不算「勾选」 */
const useMultiMode = () => useMail(st => st.selectedIds.size > 1 || (st.selectedIds.size === 1 && !st.selectedIds.has(st.selectedId ?? '')))

function RowMeta(props: { msg: MessageSummary }) {
  const { msg } = props
  const badge = CATEGORY_BADGE[msg.category]
  return (
    <>
      {msg.pinned && (
        <span className="leading-none shrink-0 inline-flex" title="已置顶" style={{ color: 'var(--faint)' }}>
          <IconPin width={11} height={11} />
        </span>
      )}
      {subjectIsAuth(msg.subject) && (
        <span className="px-1 h-4 rounded-[var(--r-xs)] shrink-0 inline-flex items-center" style={{ background: 'var(--info-soft)', color: 'var(--info-ink)' }} title="疑似验证码 / 登录链接">
          <IconKey width={10} height={10} />
        </span>
      )}
      {badge && <span className={`text-2xs px-1 h-4 inline-flex items-center rounded-[var(--r-xs)] shrink-0 ${badge.cls}`}>{badge.label}</span>}
      <ProjectTag msg={msg} />
      {msg.hasAttachments && <IconAttach width={12} height={12} className="shrink-0" style={{ color: 'var(--faint)' }} />}
      {msg.flagged && <IconFlag width={12} height={12} className="shrink-0" style={{ color: 'var(--warn)' }} />}
    </>
  )
}

function MessageRow(props: {
  msg: MessageSummary
  insight?: MailInsight
  accountColor?: string
  selected: boolean
  checked: boolean
  indent?: boolean
  onSelect(e: React.MouseEvent): void
  onToggle(): void
  onPin(): void
  onSnooze?(ids: string[]): void
  onScreen?(addr: string, status: 'allow' | 'deny'): void
}) {
  const { msg } = props
  const [hover, setHover] = useState(false)

  const quick = (e: React.MouseEvent, action: 'archive' | 'flag' | 'trash' | 'pin') => {
    e.stopPropagation()
    if (action === 'archive') {
      noteMouseAction('archive')
      void api.moveMessages([msg.id], 'archive').then(() => useMail.getState().loadMessages())
    }
    if (action === 'flag') void api.markFlagged([msg.id], !msg.flagged).then(() => useMail.getState().loadMessages())
    if (action === 'trash') void api.deleteMessages([msg.id]).then(() => useMail.getState().loadMessages())
    if (action === 'pin') props.onPin()
    // 波纹批量：单发操作触发同类邮件涌现建议
    if (action === 'archive' || action === 'trash') {
      window.dispatchEvent(new CustomEvent('ms:ripple', { detail: { ids: [msg.id], action } }))
    }
    if (action !== 'flag' && action !== 'pin' && useMail.getState().selectedId === msg.id) useMail.getState().select(null)
  }

  const multi = useMultiMode()
  const checked = multi && props.checked
  const terms = useSearchTerms()
  const followupScope = useMail(st => st.scope.kind === 'followup')
  return (
    <div
      onClick={props.onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-lens-id={msg.id}
      aria-selected={props.selected}
      draggable
      onDragStart={e => {
        const ids = checked ? [...useMail.getState().selectedIds] : [msg.id]
        e.dataTransfer.setData('text/ms-mail-ids', ids.join(','))
        e.dataTransfer.effectAllowed = 'copy'
      }}
      className={`relative flex gap-2.5 pl-4 pr-3 py-[var(--row-py)] border-b border-[var(--border-soft)] cursor-default transition-colors ${props.indent ? 'pl-9' : ''}`}
      style={{
        viewTransitionName: `mrow-${msg.id}`,
        background: props.selected || checked ? 'var(--selected)' : hover ? 'var(--hover)' : 'transparent'
      }}
    >
      {/* 账户色条：同一个颜色贯穿账户栏 · 列表 · 阅读页「收于」标签 */}
      {props.accountColor && <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: props.accountColor, opacity: props.selected ? 1 : 0.85 }} />}
      <RowSlot checked={checked} show={hover || multi} unread={msg.unread} onToggle={props.onToggle} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 h-[18px]">
          <span className={`truncate text-sm ${msg.unread ? 'font-semibold' : ''}`} style={{ color: msg.unread ? 'var(--fg)' : 'var(--muted)' }}>
            <Hl text={displayName(msg.from) || '（未知发件人）'} terms={terms} />
          </span>
          <RowMeta msg={msg} />
          {!(hover && !multi) && (
            <span className="ml-auto shrink-0 text-xs tnum" style={{ color: msg.unread ? 'var(--fg)' : 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{fmtDate(msg.date)}</span>
          )}
        </div>
        <div className={`mt-0.5 truncate text-sm ${msg.unread ? 'font-medium' : ''}`} style={{ color: msg.unread ? 'var(--fg)' : 'var(--muted)' }}>
          <Hl text={msg.subject || '（无主题）'} terms={terms} />
        </div>
        <GistLine msg={msg} insight={props.insight} />
      </div>

      {/* 悬停快捷操作 */}
      {hover && !multi && (
        <div className="absolute right-2 top-1.5 flex items-center gap-0.5 p-0.5 rounded-[var(--r-sm)] liquid-glass fade-in">
          {followupScope && <FollowQuickBtn msg={msg} />}
          <QuickBtn title={msg.pinned ? '取消置顶' : '置顶'} onClick={e => quick(e, 'pin')} active={msg.pinned}>
            <IconPin width={13} height={13} />
          </QuickBtn>
          <QuickBtn title="归档（A）" onClick={e => quick(e, 'archive')}>
            <IconArchive width={13} height={13} />
          </QuickBtn>
          <QuickBtn title={msg.flagged ? '取消旗标' : '旗标'} onClick={e => quick(e, 'flag')} active={msg.flagged}>
            <IconFlag width={13} height={13} />
          </QuickBtn>
          <QuickBtn title="删除（⌫）" onClick={e => quick(e, 'trash')} danger>
            <IconTrash width={13} height={13} />
          </QuickBtn>
        </div>
      )}
    </div>
  )
}

function QuickBtn(props: { title: string; onClick(e: React.MouseEvent): void; children: React.ReactNode; active?: boolean; danger?: boolean }) {
  return (
    <button
      title={props.title}
      onClick={props.onClick}
      className="w-6 h-6 inline-flex items-center justify-center rounded-[var(--r-xs)] transition-colors"
      style={{ color: props.active ? 'var(--accent-ink)' : 'var(--muted)' }}
      onMouseEnter={e => {
        e.currentTarget.style.background = props.danger ? 'var(--danger-soft)' : 'var(--hover-strong)'
        if (props.danger) e.currentTarget.style.color = 'var(--danger)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = 'transparent'
        if (props.danger) e.currentTarget.style.color = 'var(--muted)'
      }}
    >
      {props.children}
    </button>
  )
}

/** 会话聚合行：同一线程折叠为一行，可展开 */
function ThreadRow(props: {
  msgs: MessageSummary[]
  expanded: boolean
  anyChecked: boolean
  colorByAccount: Record<string, string>
  onToggleExpand(): void
  onToggleCheck(): void
  onExpand(): void
  onChild(msg: MessageSummary, e: React.MouseEvent): void
  onSnooze?(ids: string[]): void
  onScreen?(addr: string, status: 'allow' | 'deny'): void
  sort: ListSort
}) {
  const { msgs, expanded } = props
  const [hover, setHover] = useState(false)
  const latest = msgs[0]
  const others = msgs.length - 1
  const participants = [...new Set(msgs.map(m => displayName(m.from)))]
  const threadMulti = useMultiMode()
  const terms = useSearchTerms()

  return (
    <div>
      <div
        onClick={props.onExpand}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        data-lens-id={latest.id}
        className="relative flex gap-2.5 pl-4 pr-3 py-[var(--row-py)] border-b border-[var(--border-soft)] cursor-default transition-colors"
        style={{ viewTransitionName: `mrow-${latest.id}`, background: props.anyChecked && threadMulti ? 'var(--selected)' : hover ? 'var(--hover)' : 'transparent' }}
      >
        {props.colorByAccount[latest.accountId] && <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: props.colorByAccount[latest.accountId], opacity: 0.85 }} />}
        <RowSlot checked={props.anyChecked && threadMulti} show={hover || threadMulti} unread={latest.unread} onToggle={props.onToggleCheck} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`truncate text-sm ${latest.unread ? 'font-semibold' : ''}`} style={{ color: 'var(--fg)' }}>
              {participants.length > 1 ? `${participants[0]} 等 ${participants.length} 人` : displayName(latest.from)}
            </span>
            <span
              className="text-2xs px-1.5 py-px rounded-full shrink-0 font-medium inline-flex items-center gap-1"
              style={{ background: 'var(--hover)', color: 'var(--muted)' }}
            >
              <IconChat width={10} height={10} /> {msgs.length}
            </span>
            <RowMeta msg={latest} />
            <span className="ml-auto shrink-0 text-xs tabular-nums" style={{ color: 'var(--faint)' }}>{fmtDate(latest.date)}</span>
          </div>
          <div className={`mt-0.5 truncate text-sm ${latest.unread ? 'font-medium' : ''}`} style={{ color: latest.unread ? 'var(--fg)' : 'var(--muted)' }}>
            <Hl text={latest.subject || '（无主题）'} terms={terms} />
          </div>
          <div className="mt-0.5 truncate text-xs" style={{ color: 'var(--faint)' }}>
            {expanded ? '点击收起会话' : <Hl text={latest.snippet} terms={terms} />}
          </div>
        </div>
      </div>
      {expanded && (
        <div className="fade-in">
          {(props.sort === 'dateAsc' ? [...msgs].reverse() : msgs).map(m => (
            <MessageRow
              key={m.id}
              msg={m}
              indent
              accountColor={props.colorByAccount[m.accountId]}
              selected={useMail.getState().selectedId === m.id}
              checked={useMail.getState().selectedIds.has(m.id)}
              onSelect={e => props.onChild(m, e)}
              onToggle={() => useMail.getState().toggleSelect(m.id)}
              onPin={() => void useMail.getState().setPinned([m.id], !m.pinned)}
              onSnooze={props.onSnooze}
              onScreen={props.onScreen}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function MessageList() {
  const { scope, messages, total, selectedId, selectedIds, select, toggleSelect, selectAll, searchQuery, loading, sort, setSort, groupThreads, setGroupThreads, setPinned, syncProgress } = useMail()
  const { accounts, folders } = useMail()
  const [classifying, setClassifying] = useState(false)
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set())
  const [moveMenu, setMoveMenu] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [judgeBusy, setJudgeBusy] = useState(false)
  const [judgeResult, setJudgeResult] = useState<Map<string, { urgency: string; reason: string }> | null>(null)
  const [nudgeId, setNudgeId] = useState<string | null>(null)
  const [narrow, setNarrow] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)

  // —— 交互创新 ——
  // 重力滑块：t∈[0,100]，0=时间引力（默认），100=重要性引力，中间为连续混合谱
  const [gravity, setGravity] = useState(() => Number(localStorage.getItem('ms_gravity') ?? 0))
  // 时光机：timeCut = 倒带截至的时间点（null = 全部）
  const [timeOpen, setTimeOpen] = useState(false)
  const [timeCut, setTimeCut] = useState<number | null>(null)
  const gravTrackRef = useRef<HTMLDivElement>(null)
  const vtRef = useRef(0)

  useEffect(() => {
    localStorage.setItem('ms_gravity', String(gravity))
  }, [gravity])

  /** View Transitions：让重排 / 过滤像液体一样流动到新位置 */
  const withViewTransition = (fn: () => void) => {
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
    if (doc.startViewTransition) doc.startViewTransition(fn)
    else fn()
  }
  /** 拖动高频更新节流：每 70ms 一次液态过渡 */
  const vtThrottle = (fn: () => void) => {
    const now = Date.now()
    if (now - vtRef.current < 70) return
    vtRef.current = now
    withViewTransition(fn)
  }
  const gravPick = (clientX: number) => {
    const el = gravTrackRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const ratio = Math.min(Math.max((clientX - r.left) / r.width, 0), 1)
    vtThrottle(() => flushSync(() => setGravity(Math.round(ratio * 100))))
  }

  // 工具栏响应式：宽度不足时按钮只留图标（文字收进 title 提示），避免挤压标题
  useEffect(() => {
    const el = toolbarRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0
      setNarrow(w < 620)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 当前视图下账户的实时同步进度（来自 sync-progress 事件）
  const progressText = useMemo(() => {
    const ids = new Set(messages.map(m => m.accountId))
    if (scope.folderId) {
      const f = folders.find(f => f.id === scope.folderId)
      if (f) return syncProgress[f.accountId] ?? ''
    }
    if (scope.accountId) return syncProgress[scope.accountId] ?? ''
    for (const id of ids) if (syncProgress[id]) return syncProgress[id]
    return ''
  }, [syncProgress, messages, scope, folders])

  const colorByAccount = useMemo(() => Object.fromEntries(accounts.map(a => [a.id, a.color])), [accounts])

  // —— 邮件理解：AI 一句话要点 / 分区，列表可见邮件批量取 ——
  const insights = useInsights(st => st.byId)
  useEffect(() => {
    void useInsights.getState().load(messages.map(m => m.id))
  }, [messages])
  const prefs = usePrefs()
  const sectioned = prefs.sections
  const toggleSectioned = () => setPrefs({ sections: !sectioned })
  const sorted = useMemo(() => sortMessages(messages, sort), [messages, sort])

  // —— 重力混合排序：时间分 × (1-t) + 重要分 × t；t=0 保持原排序，t>0 液态接管 ——
  const blended = useMemo(() => {
    if (!gravity) return sorted
    const list = sorted
    if (!list.length) return list
    let dmin = Infinity
    let dmax = -Infinity
    for (const m of list) {
      if (m.date < dmin) dmin = m.date
      if (m.date > dmax) dmax = m.date
    }
    const span = Math.max(dmax - dmin, 1)
    const t = Math.min(Math.max(gravity / 100, 0), 1)
    const imp = (m: MessageSummary) =>
      (m.unread ? 0.5 : 0) +
      (m.flagged ? 0.2 : 0) +
      (m.pinned ? 0.25 : 0) +
      (m.category === 'personal' ? 0.35 : m.category === 'notification' ? 0.15 : 0) +
      ((m.date - dmin) / span) * 0.15
    const rank = (m: MessageSummary) => ((m.date - dmin) / span) * (1 - t) + imp(m) * t
    return [...list].sort((a, b) => rank(b) - rank(a))
  }, [sorted, gravity])

  // ---- 标签过滤（按 AI 分类 / 状态维度快速切片） ----
  const [filter, setFilter] = useState<ListFilter>('all')
  const filterDefs: { key: ListFilter; label: string }[] = useMemo(
    () => [
      { key: 'all', label: '全部' },
      { key: 'personal', label: '个人' },
      { key: 'notification', label: '通知' },
      { key: 'newsletter', label: '订阅' },
      { key: 'noise', label: '噪声' },
      { key: 'unread', label: '未读' },
      { key: 'attach', label: '附件' },
      { key: 'flagged', label: '旗标' },
      { key: 'pinned', label: '置顶' }
    ],
    []
  )
  const filterCounts = useMemo(() => {
    const c = { all: blended.length, personal: 0, notification: 0, newsletter: 0, noise: 0, unread: 0, attach: 0, flagged: 0, pinned: 0 } as Record<ListFilter, number>
    for (const m of blended) {
      c[m.category] = (c[m.category] ?? 0) + 1
      if (m.unread) c.unread++
      if (m.hasAttachments) c.attach++
      if (m.flagged) c.flagged++
      if (m.pinned) c.pinned++
    }
    return c
  }, [blended])
  const filtered = useMemo(() => {
    if (filter === 'all') return blended
    if (filter === 'unread') return blended.filter(m => m.unread)
    if (filter === 'attach') return blended.filter(m => m.hasAttachments)
    if (filter === 'flagged') return blended.filter(m => m.flagged)
    if (filter === 'pinned') return blended.filter(m => m.pinned)
    return blended.filter(m => m.category === filter)
  }, [blended, filter])

  // —— 时光机：倒带过滤到所选时间点（拖到最右恢复全部）——
  const timeSpan = useMemo(() => {
    if (!filtered.length) return null
    let min = Infinity
    let max = -Infinity
    for (const m of filtered) {
      if (m.date < min) min = m.date
      if (m.date > max) max = m.date
    }
    return { min, max }
  }, [filtered])
  const timed = useMemo(() => (timeCut == null ? filtered : filtered.filter(m => m.date <= timeCut)), [filtered, timeCut])

  // 会话聚合：同线程折叠（按排序后顺序取代表 = 最新一封）
  const view = useMemo(() => {
    if (!groupThreads) return timed.map(m => ({ kind: 'msg' as const, msg: m }))
    const groups: { key: string; msgs: MessageSummary[] }[] = []
    const index = new Map<string, number>()
    for (const m of timed) {
      const key = m.threadId || m.id
      const i = index.get(key)
      if (i === undefined) {
        index.set(key, groups.length)
        groups.push({ key, msgs: [m] })
      } else {
        groups[i].msgs.push(m)
      }
    }
    return groups.map(g =>
      g.msgs.length > 1
        ? ({ kind: 'thread' as const, msgs: g.msgs, key: g.key })
        : ({ kind: 'msg' as const, msg: g.msgs[0] })
    )
  }, [timed, groupThreads])

  // AI 分区：收件箱（全部 / 单账户）且没有其他筛选时生效；其他视图维持原列表
  const sectionMode = sectioned && (scope.kind === 'unified' || scope.kind === 'account') && filter === 'all' && timeCut == null && !gravity && !useMail.getState().nlResults
  const sections = useMemo(() => {
    const act: MessageSummary[] = []
    const wait: MessageSummary[] = []
    const fyi: MessageSummary[] = []
    const bundles: Record<'newsletter' | 'notification', MessageSummary[]> = { newsletter: [], notification: [] }
    for (const m of timed) {
      const ins = insights[m.id]
      if (m.pinned) {
        act.push(m)
        continue
      }
      if (!ins) {
        // 理解结果未到：按原分类先放，避免整页空白
        if (m.category === 'newsletter') bundles.newsletter.push(m)
        else if (m.category === 'notification' || m.category === 'noise') bundles.notification.push(m)
        else fyi.push(m)
        continue
      }
      if (ins.section === 'act') act.push(m)
      else if (ins.section === 'wait') wait.push(m)
      else if (ins.section === 'bundle' && ins.bundle === 'newsletter') bundles.newsletter.push(m)
      else if (ins.section === 'bundle') bundles.notification.push(m)
      else fyi.push(m)
    }
    // 「需要你处理」默认按 AI 紧急度排（原「魔法排序」并入这里），置顶恒在最前
    act.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (insights[b.id]?.urgency ?? 0) - (insights[a.id]?.urgency ?? 0) || b.date - a.date)
    return { act, wait, fyi, bundles }
  }, [timed, insights])
  const [openBundle, setOpenBundle] = useState<string | null>(null)
  const [fyiOpen, setFyiOpen] = useState(() => localStorage.getItem('ms_fyi_open') !== '0')

  // 搜索会话与列表视图对齐：被其他入口切走 = 结束会话；外部关键词搜索（如声呐）同步到输入框
  const searchSpec = useMail(s => s.searchSpec)
  useEffect(() => {
    if (scope.kind !== 'search') useSearch.getState().detach()
    else if (!searchSpec && searchQuery) useSearch.setState({ input: searchQuery })
  }, [scope.kind, searchSpec, searchQuery])
  useEffect(() => setExpandedThreads(new Set()), [scope, groupThreads])

  // 我的视图应用（Sidebar 派发）：还原过滤 chip 与重力滑块
  useEffect(() => {
    const apply = (e: Event) => {
      const d = (e as CustomEvent<{ filter?: string; gravity?: number }>).detail
      if (d?.filter) setFilter(d.filter as never)
      if (d?.gravity !== undefined) setGravity(d.gravity)
    }
    window.addEventListener('ms:apply-view', apply)
    return () => window.removeEventListener('ms:apply-view', apply)
  }, [])

  // Triage 快捷键（MailShell 按 S）对选中邮件唤起稍后菜单
  useEffect(() => {
    const open = (e: Event) => {
      const ids = (e as CustomEvent<string[]>).detail
      if (ids?.length) setSnoozeMenuFor(ids)
    }
    window.addEventListener('ms:snooze-menu', open)
    return () => window.removeEventListener('ms:snooze-menu', open)
  }, [])

  const aiOrganize = async () => {
    setClassifying(true)
    try {
      const st = await api.aiStatus()
      if (!st.ready) return toastAIError('还没有配置 AI')
      await api.aiClassify(messages.map(m => m.id))
      await useMail.getState().loadMessages()
    } catch (err) {
      toastAIError(err, () => void aiOrganize())
    } finally {
      setClassifying(false)
    }
  }

  const searchActive = useSearch(s => !!s.active) && scope.kind === 'search'
  const allSelected = messages.length > 0 && messages.every(m => selectedIds.has(m.id))

  // ---- 收件箱纪律：Snooze / Screener / Split Inbox ----
  const [snoozeMenuFor, setSnoozeMenuFor] = useState<string[] | null>(null)
  const [splitInbox, setSplitInbox] = useState(() => localStorage.getItem('ms_split') === '1')
  const [othersOpen, setOthersOpen] = useState(true)
  const knownSendersRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    void api.getSplitSignals().then(r => {
      knownSendersRef.current = new Set(r.known)
      knownSendersRefGlobal = new Set(r.known)
      setKnownTick(t => t + 1)
    })
  }, [messages])
  const [knownTick, setKnownTick] = useState(0)
  void knownTick

  // Screener 批量 AI 审批
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchVerdicts, setBatchVerdicts] = useState<Map<string, { verdict: 'allow' | 'deny'; reason: string }> | null>(null)

  const runBatchScreen = async () => {
    if (batchBusy || !screenerSenders.length) return
    setBatchBusy(true)
    setBatchVerdicts(null)
    try {
      const res = await api.aiScreenBatch(screenerSenders.map(s => s.addr))
      if (!res.ok) {
        window.dispatchEvent(new CustomEvent('ms:toast', { detail: res.error ?? '批量判定失败' }))
        return
      }
      const map = new Map<string, { verdict: 'allow' | 'deny'; reason: string }>()
      for (const v of res.verdicts) map.set(v.addr, { verdict: v.verdict, reason: v.reason })
      setBatchVerdicts(map)
      const allow = res.verdicts.filter(v => v.verdict === 'allow').length
      window.dispatchEvent(new CustomEvent('ms:toast', { detail: `AI 建议放行 ${allow} 位、拒绝 ${res.verdicts.length - allow} 位，可逐个确认或一键采纳` }))
    } finally {
      setBatchBusy(false)
    }
  }

  const applyAllVerdicts = async () => {
    if (!batchVerdicts?.size) return
    for (const [addr, v] of batchVerdicts) await api.setSenderStatus(addr, v.verdict, `AI：${v.reason}`)
    window.dispatchEvent(new CustomEvent('ms:toast', { detail: `已按 AI 建议处理 ${batchVerdicts.size} 位发件人` }))
    setBatchVerdicts(null)
    await useMail.getState().loadMessages()
  }

  // 待审视图：按发件人聚合
  const screenerSenders = useMemo(() => {
    if (scope.kind !== 'screener') return []
    const by = new Map<string, { addr: string; name: string; count: number }>()
    for (const m of messages) {
      const addr = (m.from?.address ?? '').toLowerCase()
      if (!addr) continue
      const cur = by.get(addr)
      if (cur) cur.count++
      else by.set(addr, { addr, name: displayName(m.from), count: 1 })
    }
    return [...by.values()].sort((a, b) => b.count - a.count)
  }, [messages, scope.kind])

  const decideSender = async (addr: string, status: 'allow' | 'deny', reason?: string) => {
    await api.setSenderStatus(addr, status, reason)
    window.dispatchEvent(new CustomEvent('ms:toast', { detail: status === 'allow' ? `已放行 ${addr}` : `已拒绝 ${addr}，其邮件归入噪声` }))
    await useMail.getState().loadMessages()
  }

  const snoozeSelected = async (at: number) => {
    const ids = snoozeMenuFor ?? []
    await api.snoozeMessages(ids, at)
    setSnoozeMenuFor(null)
    useMail.getState().clearSelection()
    window.dispatchEvent(new CustomEvent('ms:toast', { detail: `已稍后处理 ${ids.length} 封，${fmtSnooze(at)} 回到收件箱` }))
    await useMail.getState().loadMessages()
  }

  // ---- Smart Views：保存当前视图组合 ----
  const [saveViewOpen, setSaveViewOpen] = useState(false)

  // —— Phase B：工具条收敛 ——
  // 多选模式：勾选 ≥2 封，或勾选的那 1 封并非当前打开的邮件（打开 ≠ 勾选，审计 IA-8）
  const multiMode = selectedIds.size > 1 || (selectedIds.size === 1 && !selectedIds.has(selectedId ?? ''))
  const [gravityOpen, setGravityOpen] = useState(false)
  const segmentKeys: ListFilter[] = useMemo(() => {
    const base: ListFilter[] = ['all', 'unread']
    return filter !== 'all' && filter !== 'unread' ? [...base, filter] : base
  }, [filter])
  const filterMenu: MenuItem[] = useMemo(
    () => [
      { kind: 'label', label: 'AI 分类' },
      ...(['personal', 'notification', 'newsletter', 'noise'] as ListFilter[]).map(k => ({
        kind: 'check' as const,
        label: `${filterDefs.find(f => f.key === k)!.label}`,
        hint: String(filterCounts[k] ?? 0),
        checked: filter === k,
        onSelect: () => setFilter(filter === k ? 'all' : k)
      })),
      { kind: 'sep' },
      { kind: 'label', label: '状态' },
      ...(['unread', 'attach', 'flagged', 'pinned'] as ListFilter[]).map(k => ({
        kind: 'check' as const,
        label: `${filterDefs.find(f => f.key === k)!.label}`,
        hint: String(filterCounts[k] ?? 0),
        checked: filter === k,
        onSelect: () => setFilter(filter === k ? 'all' : k)
      })),
      ...(filter !== 'all' ? [{ kind: 'sep' as const }, { kind: 'action' as const, label: '清除筛选', onSelect: () => setFilter('all') }] : [])
    ],
    [filter, filterCounts, filterDefs]
  )
  const toggleSplit = () => {
    const v = !splitInbox
    setSplitInbox(v)
    localStorage.setItem('ms_split', v ? '1' : '0')
  }
  const toggleTime = () => {
    setTimeOpen(o => !o)
    if (timeOpen) setTimeCut(null)
  }
  const listMenu: MenuItem[] = [
    { kind: 'label', label: '排序' },
    ...(Object.keys(SORT_LABEL) as ListSort[]).map(k => ({ kind: 'check' as const, label: SORT_LABEL[k], checked: sort === k, onSelect: () => setSort(k) })),
    { kind: 'sep' },
    { kind: 'check', label: '按会话聚合', checked: groupThreads, onSelect: () => setGroupThreads(!groupThreads) },
    ...(scope.kind === 'unified' || scope.kind === 'account'
      ? [{ kind: 'check' as const, label: 'AI 分区（需要你处理 / 等待对方 / 打包）', checked: sectioned, onSelect: toggleSectioned }]
      : []),
    ...(scope.kind === 'unified' && !sectioned ? [{ kind: 'check' as const, label: '重要 / 其他 双轨', checked: splitInbox, onSelect: toggleSplit }] : []),
    { kind: 'sep' },
    { kind: 'check', label: '邮箱时光机', icon: <IconClock width={13} height={13} />, checked: timeOpen, onSelect: toggleTime },
    { kind: 'check', label: '重力滑块', icon: <IconSparkles width={13} height={13} />, checked: gravityOpen || gravity > 0, onSelect: () => { if (gravityOpen || gravity > 0) { setGravity(0); setGravityOpen(false) } else setGravityOpen(true) } },
    { kind: 'sep' },
    { kind: 'action', label: '存为「我的视图」…', icon: <IconSave width={13} height={13} />, onSelect: () => setSaveViewOpen(true) }
  ]
  const runJudgeFollowups = async () => {
    if (judgeBusy) return
    setJudgeBusy(true)
    setJudgeResult(null)
    try {
      const res = await api.aiJudgeFollowups(messages.map(m => m.id))
      if (!res.ok) {
        window.dispatchEvent(new CustomEvent('ms:toast', { detail: res.error ?? 'AI 判断失败' }))
        return
      }
      const map = new Map<string, { urgency: string; reason: string }>()
      for (const j of res.judgements) map.set(j.messageId, { urgency: j.urgency, reason: j.reason })
      setJudgeResult(map)
      const worth = res.judgements.filter(j => j.needsFollowup).length
      window.dispatchEvent(new CustomEvent('ms:toast', { detail: `AI 判断：${res.judgements.length} 封中 ${worth} 封值得跟进` }))
    } finally {
      setJudgeBusy(false)
    }
  }
  // ⌘K → 列表动作（工具条溢出项在命令面板可达）
  const listActionRef = useRef<(a: string) => void>(() => {})
  listActionRef.current = (a: string) => {
    if (a === 'toggle-threads') setGroupThreads(!groupThreads)
    else if (a === 'toggle-split') toggleSplit()
    else if (a === 'toggle-time') toggleTime()
    else if (a === 'toggle-gravity') setGravityOpen(o => !o)
    else if (a === 'save-view') setSaveViewOpen(true)
    else if (a === 'bulk-ask') setAskOpen(true)
  }
  useEffect(() => {
    const on = (e: Event) => listActionRef.current((e as CustomEvent<string>).detail)
    window.addEventListener('ms:list-action', on)
    return () => window.removeEventListener('ms:list-action', on)
  }, [])
  const [viewName, setViewName] = useState('')
  const saveCurrentView = async () => {
    const name = viewName.trim() || `${scope.title} · ${filterDefs.find(f => f.key === filter)?.label ?? ''}`
    await api.saveSmartView(`view-${Date.now()}`, name, {
      scope,
      filter,
      sort,
      gravity,
      groupThreads
    })
    setSaveViewOpen(false)
    setViewName('')
    window.dispatchEvent(new CustomEvent('ms:views-changed'))
    window.dispatchEvent(new CustomEvent('ms:toast', { detail: `视图「${name}」已保存，见侧栏我的视图` }))
  }

  const moveToFolder = async (folder: Folder) => {
    setMoveMenu(false)
    const res = await api.moveToFolder([...selectedIds], folder.id)
    window.dispatchEvent(
      new CustomEvent('ms:toast', {
        detail: res.failed ? `已移动 ${res.ok} 封，${res.failed} 封无法跨账户移动` : `已移动 ${res.ok} 封到「${folder.name}」`
      })
    )
    useMail.getState().clearSelection()
    await useMail.getState().loadMessages()
  }

  return (
    <div className="surface relative w-[var(--list-w)] min-w-[300px] shrink-0 h-full flex flex-col border-r border-[var(--border-soft)]">
      <div className="drag-region h-[var(--titlebar-h)] shrink-0 flex items-center gap-2 px-3">
        <SearchBox />
      </div>

      <div ref={toolbarRef} className="shrink-0 h-[var(--toolbar-h)] flex items-center gap-1 pl-3 pr-2 border-b border-[var(--border-soft)]">
        {/* 全选：仅在多选模式或悬停工具条时出现 */}
        <button
          onClick={selectAll}
          title="全选 / 取消全选"
          className={`w-4 h-4 rounded-[var(--r-xs)] border flex items-center justify-center shrink-0 transition-opacity ${multiMode ? '' : 'opacity-0 hover:opacity-100 focus-visible:opacity-100'}`}
          style={{ borderColor: allSelected ? 'var(--accent)' : 'var(--border-strong)', background: allSelected ? 'var(--accent)' : 'transparent' }}
        >
          {allSelected && (
            <svg viewBox="0 0 24 24" className="w-[11px] h-[11px]" fill="none" stroke="var(--on-accent)" strokeWidth={3.5}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>
        <h2 className="ml-1 text-sm font-semibold truncate tight" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>{scope.title}</h2>
        {total > 0 && <span className="text-xs tnum shrink-0" style={{ color: 'var(--faint)' }}>{total}</span>}
        {progressText && (
          <span className="text-2xs tnum truncate max-w-[96px] inline-flex items-center gap-1 shrink-0" style={{ color: 'var(--accent-ink)' }} title={progressText}>
            <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--accent)' }} />
            {narrow ? '' : progressText}
          </span>
        )}
        <div className="flex-1" />

        {sectionMode && sections.act.length > 0 && (
          <button
            onClick={() => useMail.getState().setTriage(true)}
            title="逐封处理：一次一封，归档 / 稍后 / 回复，快速清空「需要你处理」"
            className="no-drag shrink-0 h-7 px-2.5 inline-flex items-center gap-1.5 rounded-[var(--r-sm)] text-xs font-semibold ai-chip transition-transform active:scale-95"
            style={{ boxShadow: 'inset 0 0 0 1px var(--ai-ink)' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 3L5 14h6l-1 7 8-11h-6z" /></svg>
            {narrow ? sections.act.length : `逐封处理 ${sections.act.length}`}
          </button>
        )}

        {/* 分段控件：全部 / 未读（+ 当前生效的筛选）；完整维度在「筛选」菜单 */}
        <div className="no-drag shrink-0 flex items-center p-0.5 rounded-[var(--r-sm)]" style={{ background: 'var(--hover)' }} role="tablist">
          {segmentKeys.map(k => {
            const on = filter === k
            const def = filterDefs.find(f => f.key === k)!
            return (
              <button
                key={k}
                role="tab"
                aria-selected={on}
                onClick={() => setFilter(on && k !== 'all' ? 'all' : k)}
                title={`${def.label}（${filterCounts[k] ?? 0}）`}
                className="h-6 px-2 rounded-[var(--r-xs)] text-xs transition-colors"
                style={on ? { background: 'var(--surface-strong)', color: 'var(--fg)', fontWeight: 500, boxShadow: 'var(--shadow-sm)' } : { color: 'var(--muted)' }}
              >
                {def.label}
                {k !== 'all' && <span className="ml-1 tnum" style={{ color: 'var(--faint)' }}>{filterCounts[k] ?? 0}</span>}
              </button>
            )
          })}
        </div>
        <MenuButton title="筛选：分类 / 附件 / 旗标 / 置顶" items={filterMenu} active={filter !== 'all' && filter !== 'unread'} width={200}>
          <IconFilter width={15} height={15} />
        </MenuButton>

        {scope.kind === 'followup' && messages.length > 0 && (
          <button
            onClick={() => void runJudgeFollowups()}
            disabled={judgeBusy}
            title="AI 判断哪些真的值得催"
            className="icon-btn h-7 w-7 inline-flex items-center justify-center disabled:opacity-50"
            style={{ color: 'var(--accent-ink)' }}
          >
            <IconSparkles width={14} height={14} className={judgeBusy ? 'spinning' : ''} />
          </button>
        )}
        {(scope.kind === 'unified' || scope.kind === 'folder' || scope.kind === 'category') && (
          <button
            onClick={aiOrganize}
            disabled={classifying || !messages.length}
            title="AI 整理：分类 个人 / 通知 / 订阅 / 噪声"
            className="icon-btn no-drag h-7 w-7 inline-flex items-center justify-center disabled:opacity-40"
            style={{ color: 'var(--accent-ink)' }}
          >
            <IconSparkles width={14} height={14} className={classifying ? 'spinning' : ''} />
          </button>
        )}
        <MenuButton title="列表选项：排序 / 聚合 / 双轨 / 时光机 / 重力 / 存视图" items={listMenu} width={232}>
          <IconMore width={15} height={15} />
        </MenuButton>
      </div>

      {judgeResult && scope.kind === 'followup' && (
        <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border-soft)] fade-in overflow-x-auto no-scrollbar" style={{ background: 'var(--bg-soft)' }}>
          <span className="text-2xs shrink-0" style={{ color: 'var(--faint)' }}>AI 判定：</span>
          {[...judgeResult.entries()].slice(0, 8).map(([id, j]) => {
            const m = messages.find(x => x.id === id)
            if (!m) return null
            const color = j.urgency === 'high' ? 'var(--danger)' : j.urgency === 'medium' ? 'var(--warn)' : 'var(--faint)'
            return (
              <button
                key={id}
                onClick={() => setNudgeId(id)}
                title={`${m.subject}：${j.reason}（点击生成催促信）`}
                className="shrink-0 text-2xs px-2 py-0.5 rounded-full border"
                style={{ borderColor: color, color }}
              >
                <i className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle" style={{ background: color }} />{(m.subject || '无主题').slice(0, 10)}
              </button>
            )
          })}
          <button onClick={() => setJudgeResult(null)} className="ml-auto text-2xs shrink-0" style={{ color: 'var(--faint)' }}>收起</button>
        </div>
      )}

      {scope.kind === 'search' && <SearchHeader />}

      {/* 重力滑块（按需出现）：向右拖 = 重要性引力增强，邮件像液体一样重新沉降 */}
      {(gravityOpen || gravity > 0) && (
      <div className="shrink-0 h-9 flex items-center gap-2 px-3 border-b border-[var(--border-soft)] fade-in">
        <span className="text-2xs shrink-0" style={{ color: gravity ? 'var(--faint)' : 'var(--accent-strong)' }}>时间</span>
        <div
          ref={gravTrackRef}
          title="重力滑块：向右拖，重要的邮件上浮；向左拖，时间引力回归"
          className="relative flex-1 h-[16px] rounded-full cursor-ew-resize touch-none select-none"
          style={{ background: 'var(--bg-soft)', boxShadow: 'inset 0 1px 0 var(--spec-lo), inset 0 0 0 1px var(--border-soft)' }}
          onPointerDown={e => {
            e.currentTarget.setPointerCapture(e.pointerId)
            gravPick(e.clientX)
          }}
          onPointerMove={e => {
            if (e.buttons & 1) gravPick(e.clientX)
          }}
        >
          <div
            className="absolute inset-y-[3px] left-[3px] rounded-full pointer-events-none"
            style={{ width: `calc(${gravity}% - 6px)`, background: 'var(--accent-grad)', opacity: 0.28 }}
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 w-[20px] h-[20px] rounded-full liquid-glass pointer-events-none flex items-center justify-center"
            style={{ left: `calc(${gravity}% - 10px)`, transition: 'left 0.12s linear' }}
          >
            <span className="block w-[8px] h-[8px] rounded-full" style={{ background: 'var(--accent-grad)' }} />
          </div>
        </div>
        <span className="text-2xs shrink-0 inline-flex items-center gap-1" style={{ color: gravity ? 'var(--accent-strong)' : 'var(--faint)' }}>
          <IconSparkles width={11} height={11} /> 重要
        </span>
        <span className="text-2xs tabular-nums w-8 text-right shrink-0" style={{ color: 'var(--faint)' }}>
          {gravity ? `${gravity}%` : '—'}
        </span>
        <button onClick={() => { setGravity(0); setGravityOpen(false) }} title="关闭重力滑块（恢复时间排序）" className="icon-btn w-6 h-6 inline-flex items-center justify-center shrink-0" style={{ color: 'var(--faint)' }}>
          <IconClose width={11} height={11} />
        </button>
      </div>
      )}

      {/* 时光机轨道：拖动倒带，直方图显示时间分布 */}
      {timeOpen && timeSpan && (
        <TimeScrubber
          min={timeSpan.min}
          max={timeSpan.max}
          value={timeCut ?? timeSpan.max}
          items={filtered}
          onChange={v => vtThrottle(() => flushSync(() => setTimeCut(v >= timeSpan.max ? null : v)))}
        />
      )}

      {saveViewOpen && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--border-soft)] fade-in" style={{ background: 'var(--accent-soft)' }}>
          <input
            autoFocus
            value={viewName}
            onChange={e => setViewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && saveCurrentView()}
            placeholder="视图名称，如「账单速办」"
            className="flex-1 text-xs rounded-lg px-2.5 py-1.5 outline-none border border-[var(--border-soft)]"
            style={{ background: 'var(--surface-strong)', color: 'var(--fg)' }}
          />
          <button onClick={saveCurrentView} className="text-xs font-medium px-3 py-1.5 rounded-lg" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
            保存
          </button>
          <button onClick={() => setSaveViewOpen(false)} className="text-xs px-2 py-1.5 rounded-lg" style={{ color: 'var(--muted)' }}>
            取消
          </button>
        </div>
      )}

      {multiMode && (
        <BulkBar
          count={selectedIds.size}
          scopeKind={scope.kind}
          isPinnedView={scope.kind === 'pinned'}
          folders={folders}
          accounts={accounts}
          selectedAccounts={[...new Set(messages.filter(m => selectedIds.has(m.id)).map(m => m.accountId))]}
          colorByAccount={colorByAccount}
          moveMenu={moveMenu}
          setMoveMenu={setMoveMenu}
          onAsk={() => setAskOpen(true)}
          onMoveToFolder={moveToFolder}
          onSnooze={() => setSnoozeMenuFor([...selectedIds])}
          onUnsnooze={async () => {
            await api.snoozeMessages([...selectedIds], null)
            useMail.getState().clearSelection()
            await useMail.getState().loadMessages()
          }}
          onAllow={async () => {
            const addrs = [...new Set(messages.filter(m => selectedIds.has(m.id)).map(m => (m.from?.address ?? '').toLowerCase()).filter(Boolean))]
            for (const a of addrs) await api.setSenderStatus(a, 'allow', '人工放行')
            useMail.getState().clearSelection()
            window.dispatchEvent(new CustomEvent('ms:toast', { detail: `已放行 ${addrs.length} 位发件人` }))
            await useMail.getState().loadMessages()
          }}
          onDeny={async () => {
            const addrs = [...new Set(messages.filter(m => selectedIds.has(m.id)).map(m => (m.from?.address ?? '').toLowerCase()).filter(Boolean))]
            for (const a of addrs) await api.setSenderStatus(a, 'deny', '人工拒绝')
            useMail.getState().clearSelection()
            window.dispatchEvent(new CustomEvent('ms:toast', { detail: `已拒绝 ${addrs.length} 位发件人` }))
            await useMail.getState().loadMessages()
          }}
          onMagicSort={async () => {
            const ids = [...selectedIds]
            const res = await api.aiRankMessages(ids)
            if (!res.ok) {
              window.dispatchEvent(new CustomEvent('ms:toast', { detail: res.error ?? '魔法排序失败' }))
              return
            }
            const top = res.ranked[0]
            window.dispatchEvent(new CustomEvent('ms:toast', { detail: `魔法排序完成：${top ? `「${useMail.getState().messages.find(m => m.id === top.id)?.subject ?? ''}」最优先` : '已更新 pin 顺序'}` }))
            // 自动 pin 选中邮件并切换到置顶视图查看结果
            await useMail.getState().setPinned(ids, true)
            useMail.getState().setScope({ kind: 'pinned', title: '置顶' })
            location.hash = '#/mail'
          }}
          onArchive={async () => {
            await api.moveMessages([...selectedIds], 'archive')
            await useMail.getState().loadMessages()
          }}
          onDelete={async () => {
            await api.deleteMessages([...selectedIds])
            await useMail.getState().loadMessages()
          }}
          onRead={async () => {
            await api.markRead([...selectedIds], true)
            await useMail.getState().loadMessages()
          }}
          onFlag={async () => {
            await api.markFlagged([...selectedIds], true)
            await useMail.getState().loadMessages()
          }}
          onPin={async () => {
            const ids = [...selectedIds]
            const anyUnpinned = messages.filter(m => selectedIds.has(m.id)).some(m => !m.pinned)
            await setPinned(ids, anyUnpinned)
            window.dispatchEvent(new CustomEvent('ms:toast', { detail: anyUnpinned ? '已置顶所选邮件' : '已取消置顶' }))
          }}
          onClear={() => useMail.getState().clearSelection()}
        />
      )}

      <AccountErrorBanner />
      <div ref={listRef} className={`flex-1 overflow-y-auto ${multiMode ? 'pb-14' : ''}`}>
        {loading && !messages.length && (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--faint)' }}>加载中…</div>
        )}
        {snoozeMenuFor && (
          <div className="sticky top-2 z-30 flex justify-end px-3">
            <div className="relative">
              <SnoozeMenu
                align="right"
                messageId={snoozeMenuFor.length === 1 ? snoozeMenuFor[0] : undefined}
                onPick={async at => {
                  await api.snoozeMessages(snoozeMenuFor, at)
                  setSnoozeMenuFor(null)
                  window.dispatchEvent(new CustomEvent('ms:toast', { detail: `已稍后处理，${fmtSnooze(at)} 回到收件箱` }))
                  await useMail.getState().loadMessages()
                }}
                onUnsnooze={async () => {
                  await api.snoozeMessages(snoozeMenuFor, null)
                  setSnoozeMenuFor(null)
                  await useMail.getState().loadMessages()
                }}
                onClose={() => setSnoozeMenuFor(null)}
              />
            </div>
          </div>
        )}
        {scope.kind === 'followup' && <FollowupBoard passiveCount={total} />}
        {scope.kind === 'screener' && screenerSenders.length > 0 && (
          <div className="px-3 py-2 space-y-1.5 fade-in">
            <div className="flex items-center gap-2">
              <div className="text-2xs font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                {screenerSenders.length} 位新发件人待审 · 放行后邮件才进入收件箱
              </div>
              <div className="flex-1" />
              {batchVerdicts && batchVerdicts.size > 0 && (
                <button
                  onClick={() => void applyAllVerdicts()}
                  className="text-2xs font-medium px-2.5 py-1 rounded-full"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                >
                  一键采纳（{batchVerdicts.size}）
                </button>
              )}
              <button
                onClick={() => void runBatchScreen()}
                disabled={batchBusy}
                className="text-2xs font-medium px-2.5 py-1 rounded-full border inline-flex items-center gap-1 disabled:opacity-50"
                style={{ borderColor: 'var(--accent)', color: 'var(--accent-strong)' }}
              >
                <IconSparkles width={10} height={10} className={batchBusy ? 'spinning' : ''} />
                {batchBusy ? '判定中…' : '全部 AI 判定'}
              </button>
            </div>
            {screenerSenders.map(sc => (
              <ScreenerCard
                key={sc.addr}
                addr={sc.addr}
                name={sc.name}
                count={sc.count}
                preset={batchVerdicts?.get(sc.addr)}
                onDecide={(status, reason) => void decideSender(sc.addr, status, reason)}
              />
            ))}
          </div>
        )}
        {!loading && !messages.length && searchActive && <SearchEmpty />}
        {!loading && !messages.length && !searchActive && (
          <div className="p-10 text-center">
            <div className="text-sm" style={{ color: 'var(--muted)' }}>这里还没有邮件</div>
            {(scope.kind === 'unified' || scope.kind === 'category') && (
              <div className="mt-2 text-xs" style={{ color: 'var(--faint)' }}>收件箱同步后会出现在这里</div>
            )}
            {scope.kind === 'pinned' && (
              <div className="mt-2 text-xs" style={{ color: 'var(--faint)' }}>悬停邮件点图钉图标，或多选后点「置顶」，重要的邮件会固定在这里</div>
            )}
          </div>
        )}
        {sectionMode && messages.length > 0 && (
          <SectionedInbox
            sections={sections}
            renderRow={m => (
              <MessageRow
                key={m.id}
                msg={m}
                insight={insights[m.id]}
                accountColor={accounts.length > 1 ? colorByAccount[m.accountId] : undefined}
                selected={selectedId === m.id}
                checked={selectedIds.has(m.id)}
                onSelect={e => {
                  if (e.shiftKey) toggleSelect(m.id, true)
                  else select(m.id)
                }}
                onToggle={() => toggleSelect(m.id)}
                onPin={() => void setPinned([m.id], !m.pinned)}
                onSnooze={ids => setSnoozeMenuFor(ids)}
              />
            )}
            openBundle={openBundle}
            onToggleBundle={k => setOpenBundle(o => (o === k ? null : k))}
            fyiOpen={fyiOpen}
            onToggleFyi={() =>
              setFyiOpen(o => {
                localStorage.setItem('ms_fyi_open', o ? '0' : '1')
                return !o
              })
            }
            onNudge={id => setNudgeId(id)}
          />
        )}
        {!sectionMode && (splitInbox && scope.kind === 'unified' ? splitView(view) : [{ key: 'all', items: view, important: false }]).map(section => (
          <div key={section.key}>
            {section.items.length > 0 && splitInbox && scope.kind === 'unified' && (
              <div
                className="sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5 border-b border-[var(--border-soft)] glass"
                onClick={() => !section.important && setOthersOpen(o => !o)}
              >
                <span className="text-2xs font-semibold tracking-[0.06em] uppercase" style={{ color: section.important ? 'var(--accent-strong)' : 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                  {section.important ? '重要' : '其他'}
                </span>
                <span className="text-2xs tabular-nums" style={{ color: 'var(--faint)' }}>{section.items.length}</span>
                {!section.important && <span className="ml-auto text-2xs" style={{ color: 'var(--faint)' }}>{othersOpen ? '收起' : '展开'}</span>}
              </div>
            )}
            {(!splitInbox || scope.kind !== 'unified' || section.important || othersOpen) &&
            section.items.map(item =>
          item.kind === 'msg' ? (
            <MessageRow
              key={item.msg.id}
              msg={item.msg}
              insight={insights[item.msg.id]}
              accountColor={accounts.length > 1 ? colorByAccount[item.msg.accountId] : undefined}
              selected={selectedId === item.msg.id}
              checked={selectedIds.has(item.msg.id)}
              onSelect={e => {
                if (e.shiftKey) toggleSelect(item.msg.id, true)
                else select(item.msg.id)
              }}
              onToggle={() => toggleSelect(item.msg.id)}
              onPin={() => void setPinned([item.msg.id], !item.msg.pinned)}
              onSnooze={ids => setSnoozeMenuFor(ids)}
              onScreen={scope.kind === 'screener' ? (addr, status) => void decideSender(addr, status) : undefined}
            />
          ) : (
            <ThreadRow
              key={item.key}
              msgs={item.msgs}
              sort={sort}
              expanded={expandedThreads.has(item.key)}
              anyChecked={item.msgs.some(m => selectedIds.has(m.id))}
              colorByAccount={colorByAccount}
              onToggleExpand={() =>
                setExpandedThreads(prev => {
                  const next = new Set(prev)
                  if (next.has(item.key)) next.delete(item.key)
                  else next.add(item.key)
                  return next
                })
              }
              onToggleCheck={() => {
                const allChecked = item.msgs.every(m => selectedIds.has(m.id))
                const ids = new Set(selectedIds)
                for (const m of item.msgs) {
                  if (allChecked) ids.delete(m.id)
                  else ids.add(m.id)
                }
                useMail.setState({ selectedIds: ids })
              }}
              onExpand={() =>
                setExpandedThreads(prev => {
                  const next = new Set(prev)
                  next.add(item.key)
                  return next
                })
              }
              onSnooze={props2 => setSnoozeMenuFor(props2)}
              onScreen={scope.kind === 'screener' ? (addr, status) => void decideSender(addr, status) : undefined}
              onChild={(m, e) => {
                if (e.shiftKey) toggleSelect(m.id, true)
                else select(m.id)
              }}
            />
          )
        )}
          </div>
        ))}
      </div>

      {askOpen && (
        <BulkAskPanel
          ids={[...selectedIds]}
          onClose={() => setAskOpen(false)}
        />
      )}

      {nudgeId && (
        <NudgePanel
          messageId={nudgeId}
          onClose={() => setNudgeId(null)}
        />
      )}
    </div>
  )
}

/**
 * 多选操作条 —— 浮动 L2 液态玻璃（不占列表高度，审计 IA-5）
 * 主动作按上下文切换：待审批 → 放行 / 拒绝；稍后处理 → 取回；其余 → 归档 / 已读 / 稍后 / 移动
 * 次级动作（置顶、旗标、魔法排序、提问、删除）收进「⋯」
 */
function BulkBar(props: {
  count: number
  scopeKind: string
  isPinnedView: boolean
  folders: Folder[]
  accounts: { id: string; name: string; color: string }[]
  selectedAccounts: string[]
  colorByAccount: Record<string, string>
  moveMenu: boolean
  setMoveMenu(v: boolean): void
  onAsk(): void
  onMoveToFolder(f: Folder): void
  onMagicSort(): void
  onArchive(): void
  onDelete(): void
  onRead(): void
  onFlag(): void
  onPin(): void
  onClear(): void
  onSnooze(): void
  onUnsnooze(): void
  onAllow(): void
  onDeny(): void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!props.moveMenu) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) props.setMoveMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [props.moveMenu])

  const accountIds = [...new Set(props.folders.map(f => f.accountId))]
  const screener = props.scopeKind === 'screener'
  const snoozed = props.scopeKind === 'snoozed'
  const more: MenuItem[] = [
    { kind: 'action', label: props.isPinnedView ? '取消置顶' : '置顶', icon: <IconPin width={13} height={13} />, onSelect: props.onPin },
    { kind: 'action', label: '加旗标', icon: <IconFlag width={13} height={13} />, onSelect: props.onFlag },
    ...(screener || snoozed ? [{ kind: 'action' as const, label: '标为已读', onSelect: props.onRead }] : []),
    ...(snoozed ? [] : screener ? [{ kind: 'action' as const, label: '稍后处理', icon: <IconClock width={13} height={13} />, onSelect: props.onSnooze }] : []),
    { kind: 'sep' },
    { kind: 'action', label: 'AI 魔法排序', icon: <IconSparkles width={13} height={13} />, onSelect: props.onMagicSort },
    { kind: 'action', label: 'AI 提问（基于所选邮件）', icon: <IconChat width={13} height={13} />, onSelect: props.onAsk },
    { kind: 'sep' },
    { kind: 'action', label: '删除', icon: <IconTrash width={13} height={13} />, danger: true, onSelect: props.onDelete }
  ]

  return (
    <div className="absolute left-3 right-3 bottom-3 z-30 liquid-glass pop-in rounded-[var(--r-md)] h-10 flex items-center gap-0.5 pl-3 pr-1 text-xs" role="toolbar" aria-label="批量操作">
      <span className="font-semibold tnum shrink-0" style={{ color: 'var(--accent-ink)' }}>已选 {props.count}</span>
      <div className="flex-1" />
      {screener ? (
        <>
          <BulkBtn onClick={props.onAllow}>放行</BulkBtn>
          <BulkBtn onClick={props.onDeny} danger>拒绝</BulkBtn>
        </>
      ) : snoozed ? (
        <>
          <BulkBtn onClick={props.onUnsnooze}>取回</BulkBtn>
          <BulkBtn onClick={props.onArchive}>归档</BulkBtn>
        </>
      ) : (
        <>
          <BulkBtn onClick={props.onArchive}>归档</BulkBtn>
          <BulkBtn onClick={props.onRead}>已读</BulkBtn>
          <BulkBtn onClick={props.onSnooze}>稍后</BulkBtn>
        </>
      )}
      <div className="relative" ref={ref}>
        <BulkBtn onClick={() => props.setMoveMenu(!props.moveMenu)}>移动</BulkBtn>
        {props.moveMenu && (
          <div className="absolute bottom-full mb-2 right-0 z-30 w-[230px] max-h-[300px] overflow-y-auto liquid-glass rounded-[var(--r-md)] p-1 pop-in">
            {accountIds.map(accId => {
              const accFolders = props.folders.filter(f => f.accountId === accId)
              const acc = props.accounts.find(a => a.id === accId)
              if (!accFolders.length) return null
              const cross = props.selectedAccounts.length > 0 && !props.selectedAccounts.includes(accId)
              return (
                <div key={accId} style={cross ? { opacity: 0.4 } : undefined}>
                  <div className="caps px-2 pt-1.5 pb-1 flex items-center gap-1.5" style={{ color: 'var(--faint)' }}>
                    <i className="w-1.5 h-1.5 rounded-full" style={{ background: acc?.color ?? 'var(--faint)' }} />
                    {acc?.name ?? accId}
                    {cross && <span className="normal-case">（跨账户不可移）</span>}
                  </div>
                  {accFolders.slice(0, 8).map(f => (
                    <button
                      key={f.id}
                      onClick={() => props.onMoveToFolder(f)}
                      className="w-full h-7 text-left px-2 rounded-[var(--r-sm)] text-sm hover:bg-[var(--hover-strong)] truncate inline-flex items-center gap-2"
                      style={{ color: 'var(--fg)' }}
                    >
                      <span className="shrink-0 inline-flex" style={{ color: 'var(--faint)' }}>
                        {f.special === 'inbox' ? <IconInbox width={13} height={13} /> : f.special === 'trash' ? <IconTrash width={13} height={13} /> : f.special === 'archive' ? <IconArchive width={13} height={13} /> : <IconFolder width={13} height={13} />}
                      </span>
                      {f.name}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <MenuButton title="更多批量操作" items={more} side="top" width={210}>
        <IconMore width={15} height={15} />
      </MenuButton>
      <span className="w-px h-4 mx-0.5" style={{ background: 'var(--border)' }} />
      <button onClick={props.onClear} title="取消选择（Esc）" className="icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--muted)' }}>
        <IconClose width={12} height={12} />
      </button>
    </div>
  )
}

function BulkBtn(props: { children: React.ReactNode; onClick(): void; danger?: boolean; accent?: boolean; muted?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      className="h-7 px-2 rounded-[var(--r-sm)] whitespace-nowrap transition-colors hover:bg-[var(--hover-strong)]"
      style={{
        color: props.danger ? 'var(--danger-ink)' : props.accent ? 'var(--accent-ink)' : props.muted ? 'var(--muted)' : 'var(--fg)',
        fontWeight: props.accent ? 600 : 500
      }}
    >
      {props.children}
    </button>
  )
}

/** 多选提问面板：AI 基于选中邮件回答 + 提炼 todo 清单 */
function BulkAskPanel(props: { ids: string[]; onClose(): void }) {
  const [question, setQuestion] = useState('帮我梳理这批邮件：有什么需要我处理的事项？')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [answer, setAnswer] = useState('')
  const [todos, setTodos] = useState<BulkTodo[]>([])
  const [saved, setSaved] = useState(false)

  const ask = async () => {
    if (!question.trim() || busy) return
    setBusy(true)
    setError('')
    setAnswer('')
    setTodos([])
    const res = await api.aiAskBulk(props.ids, question.trim())
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? '提问失败')
      return
    }
    setAnswer(res.answer)
    setTodos(res.todos)
  }

  const saveSet = async () => {
    await api.saveTodoSet(question.trim().slice(0, 40) || '邮件待办清单', todos)
    setSaved(true)
    window.dispatchEvent(new CustomEvent('ms:toast', { detail: `已创建待办清单（${todos.length} 项），见智能洞察 → 待办` }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={props.onClose}>
      <div className="absolute inset-0 bg-black/25 backdrop-blur-[6px]" />
      <div
        className="liquid-glass relative w-[560px] max-w-[90vw] max-h-[80vh] overflow-y-auto rounded-[var(--r-md)] p-5 pop-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span className="inline-flex" style={{ color: 'var(--accent)' }}><IconChat width={16} height={16} /></span>
          <span className="text-base font-semibold" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>就 {props.ids.length} 封邮件提问</span>
          <div className="flex-1" />
          <button onClick={props.onClose} className="p-1.5 rounded-lg hover:bg-[var(--hover)]" style={{ color: 'var(--faint)' }}>
            <IconClose width={14} height={14} />
          </button>
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ask()}
            placeholder="例如：这批邮件里有什么待办？帮我按优先级整理"
            className="flex-1 text-sm rounded-lg px-3 py-2.5 outline-none border border-[var(--border-soft)] selectable"
            style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
          />
          <button
            onClick={ask}
            disabled={busy}
            className="text-sm font-medium px-4 py-2.5 rounded-lg disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          >
            {busy ? '思考中…' : '提问'}
          </button>
        </div>
        {error && <div className="mt-2.5 text-xs" style={{ color: 'var(--danger)' }}>{error}</div>}
        {answer && (
          <div className="mt-3.5 rounded-[var(--r-sm)] border border-[var(--border-soft)] px-4 py-3" style={{ background: 'var(--bg-soft)' }}>
            <div className="selectable text-sm leading-relaxed" style={{ color: 'var(--fg)' }}><Markdown text={answer} /></div>
          </div>
        )}
        {todos.length > 0 && (
          <div className="mt-3">
            <div className="text-2xs font-semibold uppercase tracking-[0.06em] mb-1.5" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
              提炼出 {todos.length} 项待办
            </div>
            <div className="space-y-1">
              {todos.map((t, i) => (
                <label key={i} className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-[var(--border-soft)]" style={{ background: 'var(--surface)' }}>
                  <input type="checkbox" defaultChecked className="accent-[var(--accent)]" onChange={() => {}} />
                  <span className="flex-1 text-xs" style={{ color: 'var(--fg)' }}>{t.title}</span>
                  {t.due && <span className="text-2xs shrink-0" style={{ color: 'var(--faint)' }}>{t.due}</span>}
                </label>
              ))}
            </div>
            <div className="mt-2.5 flex justify-end gap-2">
              <button onClick={props.onClose} className="text-xs px-3 py-1.5 rounded-lg" style={{ color: 'var(--muted)' }}>
                关闭
              </button>
              <button
                onClick={saveSet}
                disabled={saved}
                className="text-xs font-medium px-3.5 py-1.5 rounded-lg disabled:opacity-60"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                {saved ? '✓ 已存入待办清单' : '存为待办清单 →'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 邮箱时光机：拖动时间轴倒带视图；直方图展示时间分布密度 */
function TimeScrubber(props: {
  min: number
  max: number
  value: number
  items: MessageSummary[]
  onChange(v: number): void
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const ratio = Math.min(Math.max((props.value - props.min) / Math.max(props.max - props.min, 1), 0), 1)
  const day = (ts: number) => new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })

  // 40 桶时间分布直方图
  const buckets = useMemo(() => {
    const span = Math.max(props.max - props.min, 1)
    const b = new Array(40).fill(0)
    for (const m of props.items) b[Math.min(39, Math.floor(((m.date - props.min) / span) * 40))]++
    const maxC = Math.max(...b, 1)
    return b.map(c => c / maxC)
  }, [props.items, props.min, props.max])

  const pick = (clientX: number) => {
    const el = trackRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const r2 = Math.min(Math.max((clientX - r.left) / r.width, 0), 1)
    props.onChange(Math.round(props.min + r2 * (props.max - props.min)))
  }

  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--border-soft)]">
      <span className="text-2xs shrink-0 tabular-nums" style={{ color: 'var(--faint)' }}>{day(props.min)}</span>
      <div
        ref={trackRef}
        title="拖动倒带：手柄左侧的邮件会浮现，拖到最右恢复全部"
        className="relative flex-1 h-[26px] rounded-full cursor-ew-resize touch-none select-none overflow-hidden"
        style={{ background: 'var(--bg-soft)', boxShadow: 'inset 0 1px 0 var(--spec-lo), inset 0 0 0 1px var(--border-soft)' }}
        onPointerDown={e => {
          dragging.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          pick(e.clientX)
        }}
        onPointerMove={e => {
          if (dragging.current) pick(e.clientX)
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        <div className="absolute inset-x-1 top-1.5 bottom-1 flex items-end gap-px pointer-events-none">
          {buckets.map((h, i) => (
            <span
              key={i}
              className="flex-1 rounded-t-[2px]"
              style={{ height: `${Math.max(h * 100, 8)}%`, background: 'var(--faint)', opacity: 0.28 }}
            />
          ))}
        </div>
        <div className="absolute inset-y-0 left-0 pointer-events-none" style={{ width: `${ratio * 100}%`, background: 'var(--accent-soft)' }} />
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-[18px] h-[18px] rounded-full liquid-glass pointer-events-none"
          style={{ left: `${ratio * 100}%` }}
        >
          <span className="absolute inset-[5px] rounded-full" style={{ background: 'var(--accent-grad)' }} />
        </div>
      </div>
      <span className="text-2xs shrink-0 tabular-nums" style={{ color: 'var(--faint)' }}>{day(props.max)}</span>
      <span className="text-2xs shrink-0 font-medium tabular-nums" style={{ color: 'var(--accent-strong)' }}>
        ≤ {day(props.value)}
      </span>
    </div>
  )
}

/** Split Inbox：按重要性把视图条目分成 重要 / 其他 两段（代表邮件判定） */
function splitView(items: ({ kind: 'msg'; msg: MessageSummary } | { kind: 'thread'; msgs: MessageSummary[]; key: string })[]): { key: string; important: boolean; items: typeof items }[] {
  const rep = (it: (typeof items)[number]): MessageSummary => (it.kind === 'msg' ? it.msg : it.msgs[0])
  const known = knownSendersRefGlobal
  const important = items.filter(it => {
    const m = rep(it)
    return m.pinned || m.flagged || known.has((m.from?.address ?? '').toLowerCase()) || (m.category === 'personal' && m.unread)
  })
  const others = items.filter(it => !important.includes(it))
  return [
    { key: 'important', important: true, items: important },
    { key: 'others', important: false, items: others }
  ]
}
let knownSendersRefGlobal: Set<string> = new Set()

function ScreenerCard(props: { addr: string; name: string; count: number; preset?: { verdict: 'allow' | 'deny'; reason: string }; onDecide(status: 'allow' | 'deny', reason?: string): void }) {
  const [suggesting, setSuggesting] = useState(false)
  const [suggest, setSuggest] = useState<{ verdict: 'allow' | 'deny'; reason: string } | null>(props.preset ?? null)

  useEffect(() => {
    if (props.preset) setSuggest(props.preset)
  }, [props.preset])

  const ask = async () => {
    setSuggesting(true)
    const res = await api.aiScreenSuggest(props.addr)
    setSuggesting(false)
    if (!res.ok) {
      window.dispatchEvent(new CustomEvent('ms:toast', { detail: res.error ?? 'AI 建议不可用' }))
      return
    }
    setSuggest({ verdict: res.verdict, reason: res.reason })
  }

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-[var(--r-sm)] border surface" style={{ borderColor: 'var(--border-soft)' }}>
      <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium shrink-0" style={{ background: 'var(--bg-soft)', color: 'var(--muted)' }}>
        {[...props.name][0]?.toUpperCase() ?? '?'}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-xs truncate" style={{ color: 'var(--fg)' }}>{props.name} <span className="text-2xs" style={{ color: 'var(--faint)' }}>{props.addr} · {props.count} 封</span></div>
        {suggest && (
          <div className="text-2xs mt-0.5" style={{ color: suggest.verdict === 'allow' ? 'var(--ok)' : 'var(--danger)' }}>
            AI 建议{suggest.verdict === 'allow' ? '放行' : '拒绝'}：{suggest.reason}
          </div>
        )}
      </div>
      {!suggest && (
        <button onClick={ask} disabled={suggesting} className="text-xs px-2 py-1 rounded-lg shrink-0 disabled:opacity-50" style={{ background: 'var(--bg-soft)', color: 'var(--accent-strong)' }}>
          <span className="inline-flex items-center gap-1"><IconSparkles width={11} height={11} />{suggesting ? '判定中…' : 'AI 判定'}</span>
        </button>
      )}
      <button onClick={() => props.onDecide('allow')} className="text-xs px-2.5 py-1 rounded-lg shrink-0 font-medium" style={{ background: suggest?.verdict === 'allow' ? 'var(--accent)' : 'var(--ok-soft)', color: suggest?.verdict === 'allow' ? 'var(--on-accent)' : 'var(--ok)' }}>
        放行
      </button>
      <button onClick={() => props.onDecide('deny')} className="text-xs px-2.5 py-1 rounded-lg shrink-0" style={{ background: suggest?.verdict === 'deny' ? 'var(--danger)' : 'var(--danger-soft)', color: suggest?.verdict === 'deny' ? 'var(--on-accent)' : 'var(--danger)' }}>
        拒绝
      </button>
    </div>
  )
}

/** 催促信面板：AI 起草 → 可编辑 → 直接打开撰写窗发送 */
function NudgePanel(props: { messageId: string; onClose(): void }) {
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    void (async () => {
      const res = await api.aiFollowupDraft(props.messageId)
      setBusy(false)
      if (!res.ok) {
        setError(res.error ?? 'AI 起草失败')
        return
      }
      setSubject(res.subject)
      setBody(res.body)
    })()
  }, [props.messageId])

  const send = () => {
    const m = useMail.getState().messages.find(x => x.id === props.messageId)
    const to = m?.replyTo?.address ?? m?.from?.address ?? ''
    void api.openCompose({
      accountId: m?.accountId,
      to: to ? [{ address: to }] : [],
      subject,
      html: body,
      relatedMessageId: props.messageId
    } as never)
    props.onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={props.onClose}>
      <div className="absolute inset-0 bg-black/25 backdrop-blur-[6px]" />
      <div
        className="glass-strong relative w-[560px] max-w-[90vw] rounded-[var(--r-md)] border border-[var(--glass-border)] shadow-[var(--shadow)] p-5 pop-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--accent)' }}><IconBellRing width={16} height={16} /></span>
          <span className="text-base font-semibold" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>AI 催促信</span>
          <div className="flex-1" />
          <button onClick={props.onClose} className="p-1.5 rounded-lg hover:bg-[var(--hover)]" style={{ color: 'var(--faint)' }}>
            <IconClose width={14} height={14} />
          </button>
        </div>
        {busy && (
          <div className="py-10 text-center text-sm" style={{ color: 'var(--faint)' }}>
            <IconSparkles width={16} height={16} className="spinning inline-block mr-1.5" />
            正在基于原邮件起草…
          </div>
        )}
        {error && <div className="py-6 text-center text-xs" style={{ color: 'var(--danger)' }}>{error}</div>}
        {!busy && !error && (
          <>
            <input
              value={subject}
              onChange={e => setSubject(e.target.value)}
              className="mt-3 w-full text-sm font-medium rounded-lg px-3 py-2 outline-none border border-[var(--border-soft)] selectable"
              style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
            />
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={7}
              className="mt-2 w-full text-sm leading-relaxed rounded-lg px-3 py-2.5 outline-none border border-[var(--border-soft)] resize-none selectable"
              style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={props.onClose} className="text-xs px-3 py-1.5 rounded-lg" style={{ color: 'var(--muted)' }}>
                取消
              </button>
              <button
                onClick={send}
                className="text-xs font-medium px-4 py-1.5 rounded-lg"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                打开撰写窗发送 →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

type Sections = {
  act: MessageSummary[]
  wait: MessageSummary[]
  fyi: MessageSummary[]
  bundles: Record<'newsletter' | 'notification', MessageSummary[]>
}

/**
 * AI 分区收件箱：今日简报 → 需要你处理 → 等待对方 → 打包（订阅 / 通知 / 新发件人）→ 其他。
 * 原「个人 / 通知 / 订阅 / 噪声」分类、跟进判断、魔法排序、待审批在这里合成一个视图。
 */
function SectionedInbox(props: {
  sections: Sections
  renderRow(m: MessageSummary): React.ReactNode
  openBundle: string | null
  onToggleBundle(k: string): void
  fyiOpen: boolean
  onToggleFyi(): void
  onNudge(id: string): void
}) {
  const { sections: sec } = props
  const accountCtx = useMail(st => st.accountCtx)
  const showBrief = usePrefs().brief
  const [pending, setPending] = useState(0)
  useEffect(() => {
    void api.screenerPendingCount().then(setPending).catch(() => {})
  }, [sec])
  const bundleDefs: { key: 'newsletter' | 'notification'; title: string; cta: string }[] = [
    { key: 'newsletter', title: '订阅', cta: '全部已读' },
    { key: 'notification', title: '通知', cta: '全部已读' }
  ]
  const markAllRead = async (list: MessageSummary[]) => {
    const ids = list.filter(m => m.unread).map(m => m.id)
    if (!ids.length) return
    await api.markRead(ids, true)
    window.dispatchEvent(new CustomEvent('ms:toast', { detail: `已标记 ${ids.length} 封为已读` }))
    await useMail.getState().loadMessages()
  }
  const archiveAll = async (list: MessageSummary[]) => {
    await api.moveMessages(list.map(m => m.id), 'archive')
    window.dispatchEvent(new CustomEvent('ms:toast', { detail: `已归档 ${list.length} 封` }))
    await useMail.getState().loadMessages()
  }

  return (
    <div className="pb-6">
      {showBrief && <TodayBriefCard accountId={accountCtx} />}

      <SectionHeader label="需要你处理" count={sec.act.length} hint="AI 按紧急度排序" />
      {sec.act.map(props.renderRow)}
      {!sec.act.length && (
        <div className="mx-4 my-2 px-3 py-3 rounded-[var(--r-md)] text-sm ai-chip" style={{ fontWeight: 500 }}>
          需要你处理的已经清空。
        </div>
      )}

      {sec.wait.length > 0 && (
        <>
          <SectionHeader label="等待对方" count={sec.wait.length} hint="你发出、对方还没回" />
          {sec.wait.map(m => (
            <div key={m.id} className="relative group/wait">
              {props.renderRow(m)}
              <button
                onClick={() => props.onNudge(m.id)}
                className="absolute right-3 bottom-2 text-2xs px-2 h-6 rounded-[var(--r-xs)] border border-[var(--border)] opacity-0 group-hover/wait:opacity-100 transition-opacity"
                style={{ background: 'var(--surface-strong)', color: 'var(--fg)' }}
              >
                催一下
              </button>
            </div>
          ))}
        </>
      )}

      {(sec.bundles.newsletter.length > 0 || sec.bundles.notification.length > 0 || pending > 0) && (
        <SectionHeader label="打包" count={sec.bundles.newsletter.length + sec.bundles.notification.length + pending} hint="AI 自动归组，不打扰你" />
      )}
      {bundleDefs.map(b => {
        const list = sec.bundles[b.key]
        if (!list.length) return null
        const open = props.openBundle === b.key
        const unread = list.filter(m => m.unread).length
        const senders = [...new Set(list.map(m => displayName(m.from)))].slice(0, 3).join('、')
        return (
          <div key={b.key} className="border-b border-[var(--border-soft)]">
            <button onClick={() => props.onToggleBundle(b.key)} aria-expanded={open} className="w-full flex items-center gap-3 pl-4 pr-3 py-2.5 text-left hover:bg-[var(--hover)] transition-colors">
              <span className="w-7 h-7 shrink-0 rounded-[var(--r-sm)] inline-flex items-center justify-center text-xs font-semibold tnum" style={{ background: 'var(--bg-soft)', color: 'var(--fg)', fontFamily: 'var(--font-mono)' }}>
                {list.length}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold" style={{ color: 'var(--fg)' }}>
                  {b.title}
                  {unread > 0 && <span className="ml-1.5 text-xs font-normal" style={{ color: 'var(--muted)' }}>{unread} 封未读</span>}
                </span>
                <span className="block text-xs truncate" style={{ color: 'var(--faint)' }}>{senders}</span>
              </span>
              <IconChevron open={open} />
            </button>
            {open && (
              <div className="fade-in">
                <div className="flex gap-2 pl-14 pr-3 pb-2">
                  <button onClick={() => void markAllRead(list)} className="text-xs h-7 px-2.5 rounded-[var(--r-sm)] border border-[var(--border)] hover:bg-[var(--hover)]" style={{ color: 'var(--fg)' }}>
                    {b.cta}
                  </button>
                  <button onClick={() => void archiveAll(list)} className="text-xs h-7 px-2.5 rounded-[var(--r-sm)] border border-[var(--border)] hover:bg-[var(--hover)]" style={{ color: 'var(--fg)' }}>
                    全部归档
                  </button>
                  {b.key === 'newsletter' && (
                    <button onClick={() => goView('insights')} className="text-xs h-7 px-2.5 rounded-[var(--r-sm)] ai-chip font-medium">
                      看 AI 摘要
                    </button>
                  )}
                </div>
                {list.map(props.renderRow)}
              </div>
            )}
          </div>
        )
      })}
      {pending > 0 && (
        <button
          onClick={() => useMail.getState().setScope({ kind: 'screener', title: '待审批发件人' })}
          className="w-full flex items-center gap-3 pl-4 pr-3 py-2.5 text-left border-b border-[var(--border-soft)] hover:bg-[var(--hover)]"
        >
          <span className="w-7 h-7 shrink-0 rounded-[var(--r-sm)] inline-flex items-center justify-center text-xs font-semibold" style={{ background: 'var(--bg-soft)', color: 'var(--fg)', fontFamily: 'var(--font-mono)' }}>{pending}</span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-semibold" style={{ color: 'var(--fg)' }}>新发件人待审批</span>
            <span className="block text-xs" style={{ color: 'var(--faint)' }}>放行后才进入收件箱，AI 可以帮你判定</span>
          </span>
          <IconChevron open={false} />
        </button>
      )}

      {sec.fyi.length > 0 && (
        <>
          <SectionHeader label="其他" count={sec.fyi.length} hint={props.fyiOpen ? '收起' : '展开'} onClick={props.onToggleFyi} />
          {props.fyiOpen && sec.fyi.map(props.renderRow)}
        </>
      )}
    </div>
  )
}

function SectionHeader(props: { label: string; count: number; hint?: string; onClick?(): void }) {
  const Tag = props.onClick ? 'button' : 'div'
  return (
    <Tag
      onClick={props.onClick}
      className="sticky top-0 z-10 w-full flex items-center gap-2 pl-4 pr-3 h-8 border-b border-[var(--border-soft)] text-left"
      style={{ background: 'var(--surface-strong)' }}
    >
      <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>{props.label}</span>
      <span className="text-xs tnum" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{props.count}</span>
      {props.hint && <span className="ml-auto text-2xs" style={{ color: 'var(--faint)' }}>{props.hint}</span>}
    </Tag>
  )
}

function IconChevron(props: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: props.open ? 'rotate(90deg)' : 'none', transition: 'transform var(--dur-2) var(--ease-out)' }}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

/** 今日简报：一两句话 + 计数；点开是完整的每日商情（原智能洞察页） */
function TodayBriefCard(props: { accountId: string | null }) {
  const [brief, setBrief] = useState<TodayBrief | null>(null)
  const [hidden, setHidden] = useState(() => sessionStorage.getItem('ms_brief_hidden') === '1')
  useEffect(() => {
    let alive = true
    const load = () => void api.todayBrief(props.accountId).then(b => alive && setBrief(b)).catch(() => {})
    load()
    const off = api.onEvent(ev => {
      const t = (ev as { type: string }).type
      if (t === 'mail-insights' || t === 'messages-changed') load()
    })
    return () => {
      alive = false
      void off()
    }
  }, [props.accountId])
  if (!brief || hidden || (!brief.lines.length && !brief.actCount)) return null
  return (
    <div className="mx-3 mt-3 mb-2 rounded-[var(--r-md)] px-3.5 py-3 flex gap-3 items-start" style={{ background: 'var(--ai-soft)' }}>
      <span className="w-6 h-6 shrink-0 rounded-[var(--r-sm)] inline-flex items-center justify-center ai-chip">
        <IconSparkles width={13} height={13} />
      </span>
      <div className="flex-1 min-w-0 text-sm leading-relaxed">
        <div className="font-semibold" style={{ color: 'var(--fg)' }}>{brief.headline}</div>
        {brief.lines.slice(0, 2).map((l, i) => (
          <div key={i} className="text-xs leading-[18px]" style={{ color: 'var(--muted)' }}>{l}</div>
        ))}
        <button onClick={() => goView('insights')} className="mt-1 text-xs font-medium underline underline-offset-2" style={{ color: 'var(--fg)' }}>
          完整简报
        </button>
      </div>
      <button
        onClick={() => {
          sessionStorage.setItem('ms_brief_hidden', '1')
          setHidden(true)
        }}
        aria-label="今天不再显示"
        title="今天不再显示"
        className="icon-btn w-6 h-6 shrink-0 inline-flex items-center justify-center"
        style={{ color: 'var(--faint)' }}
      >
        <IconClose width={11} height={11} />
      </button>
    </div>
  )
}
