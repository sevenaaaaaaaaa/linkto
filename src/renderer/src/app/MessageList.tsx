import { useEffect, useMemo, useRef, useState } from 'react'
import { useMail } from '../stores/mail'
import { api, fmtDate, displayName } from '../lib/api'
import { subjectIsAuth } from '../lib/auth-detect'
import { IconSearch, IconSparkles, IconAttach, IconFlag, IconRefresh, IconClose, IconArchive, IconTrash } from '../components/icons'
import type { MessageSummary } from '@shared/types'

const CATEGORY_BADGE: Record<string, { label: string; cls: string }> = {
  newsletter: { label: '订阅', cls: 'bg-violet-500/15 text-violet-600 dark:text-violet-400' },
  notification: { label: '通知', cls: 'bg-[var(--warn-soft)] text-[var(--warn)]' },
  noise: { label: '噪声', cls: 'bg-zinc-200/70 text-zinc-500' }
}

function Avatar({ name, color }: { name: string; color?: string }) {
  const letter = [...name.trim()][0]?.toUpperCase() ?? '?'
  const hue = color ?? undefined
  return (
    <div
      className="w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-medium shrink-0"
      style={{
        background: hue ?? `hsl(${(name.charCodeAt(0) * 7) % 360} 55% 55%)`,
        color: '#fff'
      }}
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

  const quick = (e: React.MouseEvent, action: 'archive' | 'flag' | 'trash') => {
    e.stopPropagation()
    if (action === 'archive') void api.moveMessages([msg.id], 'archive')
    if (action === 'flag') void api.markFlagged([msg.id], !msg.flagged)
    if (action === 'trash') void api.deleteMessages([msg.id])
    if (action !== 'flag' && useMail.getState().selectedId === msg.id) useMail.getState().select(null)
    void useMail.getState().loadMessages()
  }

  return (
    <div
      onClick={props.onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`relative flex gap-3 px-4 py-3 border-b border-[var(--border-soft)] cursor-default transition-colors duration-150 ${
        msg.unread ? '' : 'opacity-[0.78]'
      }`}
      style={{
        background: props.selected ? 'var(--accent-soft)' : hover ? 'var(--hover)' : 'transparent'
      }}
    >
      {props.selected && (
        <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: 'var(--accent)' }} />
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
          {msg.unread && <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: 'var(--accent)' }} />}
          {subjectIsAuth(msg.subject) && (
            <span className="text-[10px] px-1.5 py-px rounded shrink-0 font-medium" style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}>
              🔑
            </span>
          )}
          {badge && <span className={`text-[10px] px-1.5 py-px rounded ${badge.cls}`}>{badge.label}</span>}
          {msg.hasAttachments && <IconAttach width={12} height={12} className="shrink-0" style={{ color: 'var(--faint)' }} />}
          {msg.flagged && <IconFlag width={12} height={12} className="shrink-0" style={{ color: 'var(--warn)' }} />}
          {!(hover && !props.checked) && (
            <span className="ml-auto shrink-0 text-[11.5px] tabular-nums" style={{ color: 'var(--faint)' }}>{fmtDate(msg.date)}</span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[13px]" style={{ color: 'var(--fg)', opacity: msg.unread ? 0.92 : 0.72 }}>
          {msg.subject || '（无主题）'}
        </div>
        <div className="mt-0.5 truncate text-[12px]" style={{ color: 'var(--faint)' }}>{msg.snippet}</div>
      </div>

      {/* 悬停快捷操作（Superhuman 式） */}
      {hover && !props.checked && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-0.5 px-1 rounded-full glass-strong border border-[var(--glass-border)] shadow-[var(--shadow-sm)] fade-in">
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
      style={{ color: props.active ? 'var(--warn)' : props.danger ? 'var(--muted)' : 'var(--muted)' }}
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

export function MessageList() {
  const { scope, messages, total, selectedId, selectedIds, select, toggleSelect, searchQuery, setSearch, loading } = useMail()
  const { accounts } = useMail()
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
    <div className="glass w-[380px] shrink-0 h-full flex flex-col border-r border-[var(--border-soft)]">
      <div className="drag-region h-[52px] shrink-0 flex items-center gap-2 px-3">
        <div className="no-drag flex-1 flex items-center gap-1.5 rounded-[var(--r-sm)] px-2.5 py-1.5 border border-[var(--border-soft)]" style={{ background: 'var(--bg-soft)' }}>
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

      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[var(--border-soft)]">
        <h2 className="text-[15px] font-semibold truncate" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>{scope.title}</h2>
        {total > 0 && <span className="text-[12px]" style={{ color: 'var(--faint)' }}>{total}</span>}
        <div className="flex-1" />
        {(scope.kind === 'unified' || scope.kind === 'folder' || scope.kind === 'category') && (
          <button
            onClick={aiOrganize}
            disabled={classifying || !messages.length}
            title="AI 智能整理：分类个人/通知/订阅/噪声"
            className="no-drag flex items-center gap-1 text-[12px] px-2.5 py-1 rounded-full text-white shadow-sm disabled:opacity-40 hover:opacity-90 transition"
            style={{ background: 'linear-gradient(120deg, var(--accent), oklch(58% .16 285))' }}
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
          <div className="p-8 text-center text-[13px]" style={{ color: 'var(--faint)' }}>加载中…</div>
        )}
        {!loading && !messages.length && (
          <div className="p-10 text-center">
            <div className="text-[13px]" style={{ color: 'var(--muted)' }}>这里还没有邮件</div>
            {(scope.kind === 'unified' || scope.kind === 'category') && (
              <div className="mt-2 text-[12px]" style={{ color: 'var(--faint)' }}>收件箱同步后会出现在这里</div>
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
    <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[var(--border-soft)] text-[12.5px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}>
      <span>已选 {props.count} 封</span>
      <div className="flex-1" />
      <button className="hover:underline" onClick={props.onRead}>标为已读</button>
      <button className="hover:underline" onClick={props.onFlag}>旗标</button>
      <button className="hover:underline" onClick={props.onArchive}>归档</button>
      <button className="hover:underline" style={{ color: 'var(--danger)' }} onClick={props.onDelete}>删除</button>
      <button className="hover:underline" style={{ color: 'var(--muted)' }} onClick={props.onClear}>取消</button>
    </div>
  )
}
