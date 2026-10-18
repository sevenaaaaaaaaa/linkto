import { useEffect, useMemo, useRef, useState } from 'react'
import { useMail } from '../stores/mail'
import { api, displayName } from '../lib/api'
import { IconFolder, IconSparkles } from '../components/icons'
import { folderLabel } from './Sidebar'
import type { Folder } from '@shared/types'

/**
 * 移动面板（V）：AI 先猜目标（同一发件人历史邮件最常在的文件夹），再按输入模糊匹配本账户文件夹。
 * 勾选「以后 Ta 的邮件自动放到这里」= 顺手生成一条规则（复用规则引擎）。
 */
export function MovePalette() {
  const [ids, setIds] = useState<string[] | null>(null)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const [suggest, setSuggest] = useState<{ folderId: string; reason: string } | null>(null)
  const [makeRule, setMakeRule] = useState(false)
  const { folders, messages, accounts } = useMail()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const open = (e: Event) => {
      const list = (e as CustomEvent<string[]>).detail
      if (!list?.length) return
      setIds(list)
      setQ('')
      setCursor(0)
      setMakeRule(false)
      setSuggest(null)
      void api.suggestMoveTarget(list[0]).then(setSuggest).catch(() => {})
    }
    window.addEventListener('ms:move', open)
    return () => window.removeEventListener('ms:move', open)
  }, [])

  const first = ids ? messages.find(m => m.id === ids[0]) : undefined
  const accountId = first?.accountId
  const sender = first?.from?.address ?? ''
  const account = accounts.find(a => a.id === accountId)

  const options = useMemo(() => {
    if (!accountId) return []
    const needle = q.trim().toLowerCase()
    const list = folders
      .filter(f => f.accountId === accountId && f.special !== 'inbox' && f.special !== 'drafts' && !f.hidden)
      .filter(f => !needle || folderLabel(f).toLowerCase().includes(needle) || f.path.toLowerCase().includes(needle))
    const sug = suggest ? list.find(f => f.id === suggest.folderId) : undefined
    return sug ? [sug, ...list.filter(f => f !== sug)] : list
  }, [folders, accountId, q, suggest])

  useEffect(() => setCursor(0), [q])
  useEffect(() => {
    if (ids) setTimeout(() => inputRef.current?.focus(), 0)
  }, [ids])

  if (!ids) return null
  const close = () => setIds(null)

  const move = async (f: Folder, withRule: boolean) => {
    const res = await api.moveToFolder(ids, f.id)
    if (withRule && sender) {
      await api.saveRule({
        id: `rule-move-${Date.now()}`,
        name: `${displayName(first?.from ?? null) || sender} → ${folderLabel(f)}`,
        enabled: true,
        order: 0,
        conditions: [{ field: 'from', op: 'equals', value: sender }],
        actions: [{ type: 'moveFolder', value: f.id }]
      })
    }
    window.dispatchEvent(
      new CustomEvent('ms:toast', {
        detail: res.failed
          ? `已移动 ${res.ok} 封，${res.failed} 封失败`
          : `已移到「${folderLabel(f)}」${withRule ? '，以后 Ta 的邮件会自动放到这里' : ''}`
      })
    )
    close()
    useMail.getState().select(null)
    await useMail.getState().loadMessages()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(c => Math.min(c + 1, options.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(c => Math.max(c - 1, 0))
    } else if (e.key === 'Enter' && options[cursor]) {
      e.preventDefault()
      void move(options[cursor], makeRule || e.metaKey)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] fade-in" style={{ background: 'var(--scrim)' }} onClick={close}>
      <div
        role="dialog"
        aria-label="移动到文件夹"
        className="w-[520px] max-w-[92vw] rounded-[var(--r-lg)] border border-[var(--border)] overflow-hidden pop-in"
        style={{ background: 'var(--surface-strong)', boxShadow: 'var(--shadow-float)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="h-13 px-4 py-3 flex items-center gap-3 border-b border-[var(--border)]">
          <IconFolder width={16} height={16} style={{ color: account?.color ?? 'var(--muted)' }} />
          <label htmlFor="move-q" className="text-sm shrink-0" style={{ color: 'var(--muted)' }}>
            移动 {ids.length > 1 ? `${ids.length} 封` : ''}到
          </label>
          <input
            id="move-q"
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="输入文件夹名"
            className="flex-1 bg-transparent outline-none text-md"
            style={{ color: 'var(--fg)' }}
          />
          <kbd className="text-2xs px-1.5 py-0.5 rounded-[var(--r-xs)] border border-[var(--border)]" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>Esc</kbd>
        </div>
        <div className="max-h-[46vh] overflow-y-auto p-1.5">
          {options.map((f, i) => {
            const isSuggest = suggest?.folderId === f.id && i === 0
            return (
              <button
                key={f.id}
                onMouseEnter={() => setCursor(i)}
                onClick={() => void move(f, makeRule)}
                className="w-full h-10 px-3 flex items-center gap-2.5 rounded-[var(--r-sm)] text-left text-sm"
                style={{ background: i === cursor ? 'var(--selected)' : 'transparent', color: 'var(--fg)' }}
              >
                {isSuggest ? (
                  <span className="w-5 h-5 shrink-0 rounded-[var(--r-xs)] inline-flex items-center justify-center ai-chip">
                    <IconSparkles width={11} height={11} />
                  </span>
                ) : (
                  <IconFolder width={15} height={15} style={{ color: 'var(--faint)' }} />
                )}
                <span className="flex-1 min-w-0 truncate">
                  <span className={isSuggest ? 'font-semibold' : ''}>{folderLabel(f)}</span>
                  {isSuggest && suggest && <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>{suggest.reason}</span>}
                </span>
                {i === cursor && <kbd className="text-2xs" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>↵</kbd>}
              </button>
            )
          })}
          {!options.length && <div className="px-3 py-6 text-center text-sm" style={{ color: 'var(--faint)' }}>没有匹配的文件夹</div>}
        </div>
        {sender && (
          <label className="px-4 h-11 flex items-center gap-2.5 border-t border-[var(--border)] text-xs cursor-pointer" style={{ color: 'var(--muted)' }}>
            <input type="checkbox" checked={makeRule} onChange={e => setMakeRule(e.target.checked)} className="accent-[var(--fg)]" />
            <span className="flex-1">以后 {displayName(first?.from ?? null) || sender} 的邮件自动放到这里（生成一条规则）</span>
            <kbd style={{ fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>⌘↵</kbd>
          </label>
        )}
      </div>
    </div>
  )
}
