import { useEffect, useMemo, useRef, useState } from 'react'
import { useMail } from '../stores/mail'
import { api, fmtDate, displayName } from '../lib/api'
import { IconSearch, IconSparkles, IconAttach, IconFlag, IconRefresh, IconClose } from '../components/icons'
import type { MessageSummary } from '@shared/types'

const CATEGORY_BADGE: Record<string, { label: string; cls: string }> = {
  newsletter: { label: '订阅', cls: 'bg-violet-100 text-violet-600' },
  notification: { label: '通知', cls: 'bg-amber-100 text-amber-600' },
  noise: { label: '噪声', cls: 'bg-zinc-200 text-zinc-500' }
}

function Avatar({ name, color }: { name: string; color?: string }) {
  const letter = [...name.trim()][0]?.toUpperCase() ?? '?'
  const hue = color ?? undefined
  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-medium text-white shrink-0"
      style={{ background: hue ?? `hsl(${(name.charCodeAt(0) * 7) % 360} 55% 55%)` }}
    >
      {letter}
    </div>
  )
}

function MessageRow(props: {
  msg: MessageSummary
  accountColor?: string
  selected: boolean
  checked: boolean
  onSelect(): void
  onToggle(): void
}) {
  const { msg } = props
  const [hover, setHover] = useState(false)
  const badge = CATEGORY_BADGE[msg.category]
  return (
    <div
      onClick={props.onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`flex gap-3 px-4 py-3 border-b border-black/[0.04] cursor-default transition-colors ${
        props.selected ? 'bg-blue-600/[0.08]' : hover ? 'bg-black/[0.025]' : ''
      } ${msg.unread ? '' : 'opacity-[0.78]'}`}
    >
      <div
        className="pt-1"
        onClick={e => {
          e.stopPropagation()
          props.onToggle()
        }}
      >
        <span
          className={`block w-[14px] h-[14px] rounded-full border transition-colors ${
            props.checked ? 'bg-blue-600 border-blue-600' : msg.unread && hover ? 'border-blue-400' : 'border-zinc-300'
          }`}
        >
          {props.checked && (
            <svg viewBox="0 0 24 24" className="w-full h-full text-white" fill="none" stroke="currentColor" strokeWidth={3}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </span>
      </div>
      <Avatar name={displayName(msg.from)} color={props.accountColor} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`truncate text-[13.5px] ${msg.unread ? 'font-semibold text-zinc-900' : 'text-zinc-700'}`}>
            {displayName(msg.from) || '（未知发件人）'}
          </span>
          {msg.unread && <span className="w-[7px] h-[7px] rounded-full bg-blue-600 shrink-0" />}
          {badge && <span className={`text-[10px] px-1.5 py-px rounded ${badge.cls}`}>{badge.label}</span>}
          {msg.hasAttachments && <IconAttach width={12} height={12} className="text-zinc-400 shrink-0" />}
          {msg.flagged && <IconFlag width={12} height={12} className="text-orange-500 shrink-0" />}
          <span className="ml-auto shrink-0 text-[11.5px] text-zinc-400 tabular-nums">{fmtDate(msg.date)}</span>
        </div>
        <div className={`mt-0.5 truncate text-[13px] ${msg.unread ? 'text-zinc-800' : 'text-zinc-600'}`}>
          {msg.subject || '（无主题）'}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-zinc-400">{msg.snippet}</div>
      </div>
    </div>
  )
}

export function MessageList() {
  const { scope, messages, total, selectedId, selectedIds, select, toggleSelect, searchQuery, setSearch, loading } = useMail()
  const { accounts, folders } = useMail()
  const [searchLocal, setSearchLocal] = useState(searchQuery)
  const [classifying, setClassifying] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const colorByAccount = useMemo(() => Object.fromEntries(accounts.map(a => [a.id, a.color])), [accounts])

  useEffect(() => setSearchLocal(searchQuery), [searchQuery])

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

  return (
    <div className="w-[380px] shrink-0 h-full flex flex-col bg-white border-r border-black/5">
      <div className="drag-region h-[52px] shrink-0 flex items-center gap-2 px-3">
        <div className="no-drag flex-1 flex items-center gap-1.5 bg-zinc-100 rounded-lg px-2.5 py-1.5">
          <IconSearch width={14} height={14} className="text-zinc-400 shrink-0" />
          <input
            value={searchLocal}
            onChange={e => setSearchLocal(e.target.value)}
            onKeyDown={onKey}
            placeholder="搜索邮件"
            className="flex-1 bg-transparent outline-none text-[13px] placeholder:text-zinc-400"
          />
          {searchLocal && (
            <button
              className="text-zinc-400 hover:text-zinc-600"
              onClick={() => {
                setSearch('')
                setSearchLocal('')
                if (useMail.getState().scope.kind === 'search') useMail.getState().setScope({ kind: 'unified', title: '统一收件箱' })
              }}
            >
              <IconClose width={12} height={12} />
            </button>
          )}
        </div>
      </div>

      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-black/5">
        <h2 className="text-[15px] font-semibold text-zinc-800 truncate">{scope.title}</h2>
        {total > 0 && <span className="text-[12px] text-zinc-400">{total}</span>}
        <div className="flex-1" />
        {(scope.kind === 'unified' || scope.kind === 'folder' || scope.kind === 'category') && (
          <button
            onClick={aiOrganize}
            disabled={classifying || !messages.length}
            title="AI 智能整理：分类个人/通知/订阅/噪声"
            className="no-drag flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-full bg-gradient-to-r from-violet-500 to-blue-500 text-white shadow-sm disabled:opacity-40 hover:opacity-90 transition"
          >
            <IconSparkles width={12} height={12} className={classifying ? 'spinning' : ''} />
            {classifying ? '整理中…' : 'AI 整理'}
          </button>
        )}
      </div>

      {checkedAll && (
        <BulkBar
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
          onClear={() => useMail.getState().clearSelection()}
          count={selectedIds.size}
        />
      )}

      <div ref={listRef} className="flex-1 overflow-y-auto">
        {loading && !messages.length && (
          <div className="p-8 text-center text-[13px] text-zinc-400">加载中…</div>
        )}
        {!loading && !messages.length && (
          <div className="p-10 text-center">
            <div className="text-[13px] text-zinc-400">这里还没有邮件</div>
            {(scope.kind === 'unified' || scope.kind === 'category') && (
              <div className="mt-2 text-[12px] text-zinc-300">收件箱同步后会出现在这里</div>
            )}
          </div>
        )}
        {messages.map(m => (
          <MessageRow
            key={m.id}
            msg={m}
            accountColor={colorByAccount[m.accountId]}
            selected={selectedId === m.id}
            checked={selectedIds.has(m.id)}
            onSelect={() => select(m.id)}
            onToggle={() => toggleSelect(m.id)}
          />
        ))}
      </div>
    </div>
  )
}

function BulkBar(props: { count: number; onArchive(): void; onDelete(): void; onRead(): void; onFlag(): void; onClear(): void }) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-blue-600/[0.06] border-b border-blue-600/10 text-[12.5px] text-blue-700">
      <span>已选 {props.count} 封</span>
      <div className="flex-1" />
      <button className="hover:underline" onClick={props.onRead}>标为已读</button>
      <button className="hover:underline" onClick={props.onFlag}>旗标</button>
      <button className="hover:underline" onClick={props.onArchive}>归档</button>
      <button className="hover:underline text-red-600" onClick={props.onDelete}>删除</button>
      <button className="hover:underline text-zinc-500" onClick={props.onClear}>取消</button>
    </div>
  )
}
