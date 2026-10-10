import { useEffect, useMemo, useRef, useState } from 'react'
import { useMail, sortMessages } from '../stores/mail'
import { api, fmtDate, displayName } from '../lib/api'
import { subjectIsAuth } from '../lib/auth-detect'
import { IconSearch, IconSparkles, IconAttach, IconFlag, IconRefresh, IconClose, IconArchive, IconTrash, IconPin, IconKey, IconChat, IconInbox, IconFolder, IconClock } from '../components/icons'
import type { BulkTodo, Folder, ListSort, MessageSummary } from '@shared/types'

const CATEGORY_BADGE: Record<string, { label: string; cls: string }> = {
  newsletter: { label: '订阅', cls: 'bg-violet-500/15 text-violet-600 dark:text-violet-400' },
  notification: { label: '通知', cls: 'bg-[var(--warn-soft)] text-[var(--warn)]' },
  noise: { label: '噪声', cls: 'bg-zinc-200/70 text-zinc-500' }
}

const SORT_LABEL: Record<ListSort, string> = {
  date: '最新在前',
  dateAsc: '最早在前',
  unread: '未读优先',
  smart: '重要优先'
}

function Avatar({ name, color }: { name: string; color?: string }) {
  const letter = [...name.trim()][0]?.toUpperCase() ?? '?'
  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-medium shrink-0"
      style={{ background: color ?? `hsl(${(name.charCodeAt(0) * 7) % 360} 55% 55%)`, color: '#fff' }}
    >
      {letter}
    </div>
  )
}

function RowMeta(props: { msg: MessageSummary }) {
  const { msg } = props
  const badge = CATEGORY_BADGE[msg.category]
  return (
    <>
      {msg.unread && <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: 'var(--accent)' }} />}
      {msg.pinned && (
        <span className="leading-none shrink-0 inline-flex" title="已置顶" style={{ color: 'var(--accent)' }}>
          <IconPin width={11} height={11} />
        </span>
      )}
      {subjectIsAuth(msg.subject) && (
        <span className="px-1.5 py-px rounded shrink-0 font-medium inline-flex items-center" style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }} title="疑似验证码 / 登录链接">
          <IconKey width={10} height={10} />
        </span>
      )}
      {badge && <span className={`text-[10px] px-1.5 py-px rounded ${badge.cls}`}>{badge.label}</span>}
      {msg.hasAttachments && <IconAttach width={12} height={12} className="shrink-0" style={{ color: 'var(--faint)' }} />}
      {msg.flagged && <IconFlag width={12} height={12} className="shrink-0" style={{ color: 'var(--warn)' }} />}
    </>
  )
}

function MessageRow(props: {
  msg: MessageSummary
  accountColor?: string
  selected: boolean
  checked: boolean
  indent?: boolean
  onSelect(e: React.MouseEvent): void
  onToggle(): void
  onPin(): void
}) {
  const { msg } = props
  const [hover, setHover] = useState(false)

  const quick = (e: React.MouseEvent, action: 'archive' | 'flag' | 'trash' | 'pin') => {
    e.stopPropagation()
    if (action === 'archive') void api.moveMessages([msg.id], 'archive').then(() => useMail.getState().loadMessages())
    if (action === 'flag') void api.markFlagged([msg.id], !msg.flagged).then(() => useMail.getState().loadMessages())
    if (action === 'trash') void api.deleteMessages([msg.id]).then(() => useMail.getState().loadMessages())
    if (action === 'pin') props.onPin()
    if (action !== 'flag' && action !== 'pin' && useMail.getState().selectedId === msg.id) useMail.getState().select(null)
  }

  return (
    <div
      onClick={props.onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-glow
      className={`relative flex gap-3 px-4 py-3 border-b border-[var(--border-soft)] cursor-default transition-all duration-200 ${
        msg.unread ? '' : 'opacity-[0.78]'
      } ${props.indent ? 'pl-10' : ''}`}
      style={{
        background: props.selected
          ? 'linear-gradient(90deg, var(--accent-soft), transparent 75%)'
          : hover
            ? 'var(--hover)'
            : 'transparent',
        boxShadow: props.selected ? 'inset 0 1px 0 var(--spec-lo)' : undefined
      }}
    >
      {props.selected && (
        <span
          className="absolute left-0 top-[10%] bottom-[10%] w-[3px] rounded-full"
          style={{ background: 'var(--accent-grad)', boxShadow: '0 0 10px var(--accent)' }}
        />
      )}
      <div
        className="pt-1"
        onClick={e => {
          e.stopPropagation()
          props.onToggle()
        }}
      >
        <span
          className="block w-[14px] h-[14px] rounded-full border transition-colors"
          style={{
            borderColor: props.checked ? 'var(--accent)' : msg.unread && hover ? 'var(--accent)' : 'var(--border-strong)',
            background: props.checked ? 'var(--accent)' : 'transparent'
          }}
        >
          {props.checked && (
            <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="var(--on-accent)" strokeWidth={3}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </span>
      </div>
      <Avatar name={displayName(msg.from)} color={props.accountColor} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`truncate text-[13.5px] ${msg.unread ? 'font-semibold' : ''}`} style={{ color: 'var(--fg)' }}>
            {displayName(msg.from) || '（未知发件人）'}
          </span>
          <RowMeta msg={msg} />
          {!(hover && !props.checked) && (
            <span className="ml-auto shrink-0 text-[11.5px] tabular-nums" style={{ color: 'var(--faint)' }}>{fmtDate(msg.date)}</span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[13px]" style={{ color: 'var(--fg)', opacity: msg.unread ? 0.92 : 0.72 }}>
          {msg.subject || '（无主题）'}
        </div>
        <div className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--faint)' }}>{msg.snippet}</div>
      </div>

      {/* 悬停快捷操作 */}
      {hover && !props.checked && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-0.5 px-1 rounded-full liquid-glass fade-in">
          <QuickBtn title={msg.pinned ? '取消置顶' : '置顶'} onClick={e => quick(e, 'pin')} active={msg.pinned}>
            <IconPin width={13} height={13} />
          </QuickBtn>
          <QuickBtn title="归档" onClick={e => quick(e, 'archive')}>
            <IconArchive width={13} height={13} />
          </QuickBtn>
          <QuickBtn title={msg.flagged ? '取消旗标' : '旗标'} onClick={e => quick(e, 'flag')} active={msg.flagged}>
            <IconFlag width={13} height={13} />
          </QuickBtn>
          <QuickBtn title="删除" onClick={e => quick(e, 'trash')} danger>
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
      className="p-1.5 rounded-full transition-colors"
      style={{ color: props.active ? 'var(--warn)' : 'var(--muted)' }}
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
  sort: ListSort
}) {
  const { msgs, expanded } = props
  const [hover, setHover] = useState(false)
  const latest = msgs[0]
  const others = msgs.length - 1
  const participants = [...new Set(msgs.map(m => displayName(m.from)))]

  return (
    <div>
      <div
        onClick={props.onExpand}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        data-glow
        className="relative flex gap-3 px-4 py-3 border-b border-[var(--border-soft)] cursor-default transition-all duration-200"
        style={{ background: hover ? 'var(--hover)' : 'transparent' }}
      >
        <div
          className="pt-1"
          onClick={e => {
            e.stopPropagation()
            props.onToggleCheck()
          }}
        >
          <span
            className="block w-[14px] h-[14px] rounded-full border"
            style={{
              borderColor: props.anyChecked ? 'var(--accent)' : 'var(--border-strong)',
              background: props.anyChecked ? 'var(--accent)' : 'transparent'
            }}
          >
            {props.anyChecked && (
              <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="var(--on-accent)" strokeWidth={3}>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </span>
        </div>
        <Avatar name={participants[participants.length - 1] ?? ''} color={props.colorByAccount[latest.accountId]} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`truncate text-[13.5px] ${latest.unread ? 'font-semibold' : ''}`} style={{ color: 'var(--fg)' }}>
              {participants.length > 1 ? `${participants[0]} 等 ${participants.length} 人` : displayName(latest.from)}
            </span>
            <span
              className="text-[10.5px] px-1.5 py-px rounded-full shrink-0 font-medium inline-flex items-center gap-1"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}
            >
              <IconChat width={10} height={10} /> {msgs.length} 封
            </span>
            <RowMeta msg={latest} />
            <span className="ml-auto shrink-0 text-[11.5px] tabular-nums" style={{ color: 'var(--faint)' }}>{fmtDate(latest.date)}</span>
          </div>
          <div className="mt-0.5 truncate text-[13px]" style={{ color: 'var(--fg)', opacity: latest.unread ? 0.92 : 0.72 }}>
            {latest.subject || '（无主题）'}
          </div>
          <div className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--faint)' }}>
            {expanded ? '点击收起会话' : latest.snippet}
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
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function MessageList() {
  const { scope, messages, total, selectedId, selectedIds, select, toggleSelect, selectAll, searchQuery, setSearch, loading, sort, setSort, groupThreads, setGroupThreads, setPinned, syncProgress } = useMail()
  const { accounts, folders } = useMail()
  const [searchLocal, setSearchLocal] = useState(searchQuery)
  const [classifying, setClassifying] = useState(false)
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set())
  const [moveMenu, setMoveMenu] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)

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
  const sorted = useMemo(() => sortMessages(messages, sort), [messages, sort])

  // 会话聚合：同线程折叠（按排序后顺序取代表 = 最新一封）
  const view = useMemo(() => {
    if (!groupThreads) return sorted.map(m => ({ kind: 'msg' as const, msg: m }))
    const groups: { key: string; msgs: MessageSummary[] }[] = []
    const index = new Map<string, number>()
    for (const m of sorted) {
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
  }, [sorted, groupThreads])

  useEffect(() => setSearchLocal(searchQuery), [searchQuery])
  useEffect(() => setExpandedThreads(new Set()), [scope, groupThreads])

  const runSearch = () => {
    if (!searchLocal.trim()) return
    setSearch(searchLocal.trim())
    useMail.getState().setScope({ kind: 'search', title: `搜索：${searchLocal.trim()}` })
  }

  const aiOrganize = async () => {
    setClassifying(true)
    try {
      await api.aiClassify(messages.map(m => m.id))
      await useMail.getState().loadMessages()
    } finally {
      setClassifying(false)
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') runSearch()
    if (e.key === 'Escape') {
      setSearch('')
      setSearchLocal('')
      if (useMail.getState().scope.kind === 'search') useMail.getState().setScope({ kind: 'unified', title: '统一收件箱' })
    }
  }

  const checkedAll = selectedIds.size > 1
  const allSelected = messages.length > 0 && messages.every(m => selectedIds.has(m.id))

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
    <div className="glass w-[380px] shrink-0 h-full flex flex-col border-r border-[var(--border-soft)]">
      <div className="drag-region h-[52px] shrink-0 flex items-center gap-2 px-3">
        <div
          className="no-drag flex-1 flex items-center gap-1.5 rounded-[var(--r-sm)] px-2.5 py-1.5 transition-shadow duration-200 focus-within:shadow-[0_0_0_3px_var(--accent-soft),0_0_0_1px_var(--accent)]"
          style={{
            background: 'var(--bg-soft)',
            boxShadow: 'inset 0 1px 0 var(--spec-lo), inset 0 0 0 1px var(--border-soft)'
          }}
        >
          <IconSearch width={14} height={14} style={{ color: 'var(--faint)' }} />
          <input
            value={searchLocal}
            onChange={e => setSearchLocal(e.target.value)}
            onKeyDown={onKey}
            placeholder="搜索邮件"
            className="flex-1 bg-transparent outline-none text-[13px] placeholder:text-[var(--faint)]"
          />
          {searchLocal && (
            <button
              onClick={() => {
                setSearch('')
                setSearchLocal('')
                if (useMail.getState().scope.kind === 'search') useMail.getState().setScope({ kind: 'unified', title: '统一收件箱' })
              }}
              style={{ color: 'var(--faint)' }}
            >
              <IconClose width={12} height={12} />
            </button>
          )}
        </div>
      </div>

      <div ref={toolbarRef} className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-b border-[var(--border-soft)]">
        {/* 全选 */}
        <button
          onClick={selectAll}
          title="全选 / 取消全选"
          className="w-[15px] h-[15px] rounded-[4px] border flex items-center justify-center shrink-0"
          style={{ borderColor: allSelected ? 'var(--accent)' : 'var(--border-strong)', background: allSelected ? 'var(--accent)' : 'transparent' }}
        >
          {allSelected && (
            <svg viewBox="0 0 24 24" className="w-[11px] h-[11px]" fill="none" stroke="var(--on-accent)" strokeWidth={3.5}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>
        <h2 className="text-[14.5px] font-semibold truncate" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>{scope.title}</h2>
        {total > 0 && <span className="text-[12px]" style={{ color: 'var(--faint)' }}>{total}</span>}
        {progressText && (
          <span className="text-[11px] tabular-nums truncate max-w-[110px] inline-flex items-center gap-1" style={{ color: 'var(--accent)' }} title={progressText}>
            <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--accent)' }} />
            {progressText}
          </span>
        )}
        <div className="flex-1" />
        {/* 会话聚合（窄屏只留图标） */}
        <button
          onClick={() => setGroupThreads(!groupThreads)}
          title="按会话聚合"
          className={`text-[11.5px] px-2 py-1 rounded-full border transition-colors inline-flex items-center gap-1 ${narrow ? 'px-1.5' : ''}`}
          style={{
            borderColor: groupThreads ? 'var(--accent)' : 'var(--border)',
            color: groupThreads ? 'var(--accent-strong)' : 'var(--muted)',
            background: groupThreads ? 'var(--accent-soft)' : 'transparent'
          }}
        >
          <IconChat width={11} height={11} />
          {!narrow && '会话'}
        </button>
        {/* 排序（窄屏换成图标循环切换） */}
        {narrow ? (
          <button
            onClick={() => {
              const ks = Object.keys(SORT_LABEL) as ListSort[]
              setSort(ks[(ks.indexOf(sort) + 1) % ks.length])
            }}
            title={`排序：${SORT_LABEL[sort]}（点击切换）`}
            className="text-[11.5px] px-1.5 py-1 rounded-full border inline-flex items-center"
            style={{
              borderColor: sort === 'smart' ? 'var(--accent)' : 'var(--border)',
              color: sort === 'smart' ? 'var(--accent-strong)' : 'var(--muted)',
              background: sort === 'smart' ? 'var(--accent-soft)' : 'transparent'
            }}
          >
            {sort === 'smart' ? <IconSparkles width={12} height={12} /> : sort === 'unread' ? <IconInbox width={12} height={12} /> : <IconClock width={12} height={12} />}
          </button>
        ) : (
          <select
            value={sort}
            onChange={e => setSort(e.target.value as ListSort)}
            title="排序方式"
            className="no-drag text-[11.5px] rounded-full px-2 py-1 outline-none border"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-soft)', color: sort === 'smart' ? 'var(--accent-strong)' : 'var(--muted)' }}
          >
            {(Object.keys(SORT_LABEL) as ListSort[]).map(s => (
              <option key={s} value={s}>{SORT_LABEL[s]}</option>
            ))}
          </select>
        )}
        {(scope.kind === 'unified' || scope.kind === 'folder' || scope.kind === 'category') && (
          <button
            onClick={aiOrganize}
            disabled={classifying || !messages.length}
            title="AI 智能整理：分类个人/通知/订阅/噪声"
            className="no-drag btn-liquid flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-full disabled:opacity-40"
          >
            <IconSparkles width={12} height={12} className={classifying ? 'spinning' : ''} />
            {!narrow && (classifying ? '整理中…' : 'AI 整理')}
          </button>
        )}
      </div>

      {checkedAll && (
        <BulkBar
          count={selectedIds.size}
          isPinnedView={scope.kind === 'pinned'}
          folders={folders}
          accounts={accounts}
          selectedAccounts={[...new Set(messages.filter(m => selectedIds.has(m.id)).map(m => m.accountId))]}
          colorByAccount={colorByAccount}
          moveMenu={moveMenu}
          setMoveMenu={setMoveMenu}
          onAsk={() => setAskOpen(true)}
          onMoveToFolder={moveToFolder}
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

      <div ref={listRef} className="flex-1 overflow-y-auto">
        {loading && !messages.length && (
          <div className="p-8 text-center text-[13px]" style={{ color: 'var(--faint)' }}>加载中…</div>
        )}
        {!loading && !messages.length && (
          <div className="p-10 text-center">
            <div className="text-[13px]" style={{ color: 'var(--muted)' }}>这里还没有邮件</div>
            {(scope.kind === 'unified' || scope.kind === 'category') && (
              <div className="mt-2 text-[12px]" style={{ color: 'var(--faint)' }}>收件箱同步后会出现在这里</div>
            )}
            {scope.kind === 'pinned' && (
              <div className="mt-2 text-[12px]" style={{ color: 'var(--faint)' }}>悬停邮件点图钉图标，或多选后点「置顶」，重要的邮件会固定在这里</div>
            )}
          </div>
        )}
        {view.map(item =>
          item.kind === 'msg' ? (
            <MessageRow
              key={item.msg.id}
              msg={item.msg}
              accountColor={colorByAccount[item.msg.accountId]}
              selected={selectedId === item.msg.id}
              checked={selectedIds.has(item.msg.id)}
              onSelect={e => {
                if (e.shiftKey) toggleSelect(item.msg.id, true)
                else select(item.msg.id)
              }}
              onToggle={() => toggleSelect(item.msg.id)}
              onPin={() => void setPinned([item.msg.id], !item.msg.pinned)}
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
              onChild={(m, e) => {
                if (e.shiftKey) toggleSelect(m.id, true)
                else select(m.id)
              }}
            />
          )
        )}
      </div>

      {askOpen && (
        <BulkAskPanel
          ids={[...selectedIds]}
          onClose={() => setAskOpen(false)}
        />
      )}
    </div>
  )
}

function BulkBar(props: {
  count: number
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

  return (
    <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-b border-[var(--border-soft)] text-[12.5px] flex-wrap" style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}>
      <span className="px-0.5">已选 {props.count} 封</span>
      <div className="flex-1" />
      <BulkBtn onClick={props.onPin}>置顶</BulkBtn>
      <BulkBtn onClick={props.onRead}>已读</BulkBtn>
      <BulkBtn onClick={props.onFlag}>旗标</BulkBtn>
      <div className="relative" ref={ref}>
        <BulkBtn onClick={() => props.setMoveMenu(!props.moveMenu)}>移动到…</BulkBtn>
        {props.moveMenu && (
          <div className="absolute top-8 right-0 z-30 w-[230px] max-h-[300px] overflow-y-auto liquid-glass rounded-[var(--r-sm)] p-1.5 pop-in">
            {accountIds.map(accId => {
              const accFolders = props.folders.filter(f => f.accountId === accId)
              const acc = props.accounts.find(a => a.id === accId)
              if (!accFolders.length) return null
              const cross = props.selectedAccounts.length > 0 && !props.selectedAccounts.includes(accId)
              return (
                <div key={accId} style={cross ? { opacity: 0.4 } : undefined}>
                  <div className="px-2 pt-1.5 pb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[.08em]" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                    <i className="w-1.5 h-1.5 rounded-full" style={{ background: acc?.color ?? 'var(--faint)' }} />
                    {acc?.name ?? accId}
                    {cross && <span className="normal-case">（跨账户不可移）</span>}
                  </div>
                  {accFolders.slice(0, 8).map(f => (
                    <button
                      key={f.id}
                      onClick={() => props.onMoveToFolder(f)}
                      className="w-full text-left px-2.5 py-1.5 rounded-[8px] text-[12.5px] hover:bg-[var(--hover)] truncate inline-flex items-center gap-1.5"
                      style={{ color: 'var(--fg)' }}
                    >
                      <span className="shrink-0 inline-flex" style={{ color: 'var(--faint)' }}>
                        {f.special === 'inbox' ? <IconInbox width={12} height={12} /> : f.special === 'trash' ? <IconTrash width={12} height={12} /> : f.special === 'archive' ? <IconArchive width={12} height={12} /> : <IconFolder width={12} height={12} />}
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
      <BulkBtn onClick={props.onMagicSort} accent>
        <span className="inline-flex items-center gap-1"><IconSparkles width={12} height={12} /> 魔法排序</span>
      </BulkBtn>
      <BulkBtn onClick={props.onAsk} accent>
        <span className="inline-flex items-center gap-1"><IconChat width={12} height={12} /> 提问</span>
      </BulkBtn>
      <BulkBtn onClick={props.onArchive}>归档</BulkBtn>
      <BulkBtn onClick={props.onDelete} danger>删除</BulkBtn>
      <BulkBtn onClick={props.onClear} muted>取消</BulkBtn>
    </div>
  )
}

function BulkBtn(props: { children: React.ReactNode; onClick(): void; danger?: boolean; accent?: boolean; muted?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      className="px-2 py-1 rounded-lg whitespace-nowrap transition-colors hover:bg-[var(--hover-strong)]"
      style={{
        color: props.danger ? 'var(--danger)' : props.accent ? 'var(--accent-strong)' : props.muted ? 'var(--muted)' : 'var(--fg)',
        fontWeight: props.accent ? 600 : undefined
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
          <span className="text-[14px] font-semibold" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>就 {props.ids.length} 封邮件提问</span>
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
            className="flex-1 text-[13px] rounded-[10px] px-3 py-2.5 outline-none border border-[var(--border-soft)] selectable"
            style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
          />
          <button
            onClick={ask}
            disabled={busy}
            className="text-[13px] font-medium px-4 py-2.5 rounded-[10px] disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          >
            {busy ? '思考中…' : '提问'}
          </button>
        </div>
        {error && <div className="mt-2.5 text-[12.5px]" style={{ color: 'var(--danger)' }}>{error}</div>}
        {answer && (
          <div className="mt-3.5 rounded-[var(--r-sm)] border border-[var(--border-soft)] px-4 py-3" style={{ background: 'var(--bg-soft)' }}>
            <div className="selectable text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--fg)' }}>{answer}</div>
          </div>
        )}
        {todos.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] font-semibold uppercase tracking-[.08em] mb-1.5" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
              提炼出 {todos.length} 项待办
            </div>
            <div className="space-y-1">
              {todos.map((t, i) => (
                <label key={i} className="flex items-center gap-2.5 px-3 py-2 rounded-[10px] border border-[var(--border-soft)]" style={{ background: 'var(--surface)' }}>
                  <input type="checkbox" defaultChecked className="accent-[var(--accent)]" onChange={() => {}} />
                  <span className="flex-1 text-[12.5px]" style={{ color: 'var(--fg)' }}>{t.title}</span>
                  {t.due && <span className="text-[11px] shrink-0" style={{ color: 'var(--faint)' }}>{t.due}</span>}
                </label>
              ))}
            </div>
            <div className="mt-2.5 flex justify-end gap-2">
              <button onClick={props.onClose} className="text-[12.5px] px-3 py-1.5 rounded-lg" style={{ color: 'var(--muted)' }}>
                关闭
              </button>
              <button
                onClick={saveSet}
                disabled={saved}
                className="text-[12.5px] font-medium px-3.5 py-1.5 rounded-lg disabled:opacity-60"
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
