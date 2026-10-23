import { useEffect, useMemo, useRef, useState } from 'react'
import { IconClose, IconSearch } from '../components/icons'
import { SHORTCUT_GROUPS } from '../lib/shortcuts'

/** 可搜索的键盘快捷键面板：? 打开，Esc 关闭 */
export function ShortcutSheet(props: { open: boolean; onClose(): void }) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!props.open) return
    setQuery('')
    const t = window.setTimeout(() => inputRef.current?.focus(), 30)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [props.open])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return SHORTCUT_GROUPS
    return SHORTCUT_GROUPS.map(g => ({
      title: g.title,
      items: g.items.filter(it => `${it.keys} ${it.label} ${it.aliases ?? ''}`.toLowerCase().includes(q))
    })).filter(g => g.items.length)
  }, [query])

  if (!props.open) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh]" onClick={props.onClose}>
      <div className="absolute inset-0 bg-black/25 backdrop-blur-[6px]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="键盘快捷键"
        className="liquid-glass relative w-[720px] max-w-[90vw] rounded-[var(--r-md)] overflow-hidden pop-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 h-[52px] border-b border-[var(--border-soft)]">
          <IconSearch width={15} height={15} style={{ color: 'var(--muted)' }} />
          <input
            ref={inputRef}
            data-search-input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索快捷键、动作或命令…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-[var(--faint)]"
          />
          <button onClick={props.onClose} aria-label="关闭快捷键面板" className="icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--muted)' }}>
            <IconClose width={14} height={14} />
          </button>
        </div>

        <div className="max-h-[62vh] overflow-y-auto px-4 py-3">
          {groups.length === 0 ? (
            <div className="py-10 text-center text-xs" style={{ color: 'var(--faint)' }}>没有找到匹配的快捷键</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-7 gap-y-5">
              {groups.map(g => (
                <div key={g.title}>
                  <div className="mb-1.5 text-2xs font-semibold tracking-[0.06em] uppercase" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                    {g.title}
                  </div>
                  <div className="divide-y divide-[var(--border-soft)]">
                    {g.items.map(it => (
                      <div key={`${g.title}-${it.keys}-${it.label}`} className="flex items-center gap-3 py-1.5">
                        <kbd
                          className="shrink-0 min-w-[64px] text-center text-2xs px-1.5 py-0.5 rounded-md border border-[var(--border)]"
                          style={{ color: 'var(--fg)', fontFamily: 'var(--font-mono)' }}
                        >
                          {it.keys}
                        </kbd>
                        <span className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{it.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--border-soft)] text-2xs" style={{ color: 'var(--faint)' }}>
          <span>? 打开快捷键</span>
          <span>Esc 关闭</span>
          <span className="flex-1" />
          <span>LinkTo 键盘</span>
        </div>
      </div>
    </div>
  )
}
