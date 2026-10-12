import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * 通用下拉菜单（L2 液态玻璃浮层）—— Phase B 信息架构收敛的「溢出」承载体
 * 次级动作统一收进这里，主界面只留高频动作。键盘：Esc 关闭；外部点击关闭。
 */
export type MenuItem =
  | { kind: 'action'; label: string; icon?: ReactNode; hint?: string; danger?: boolean; disabled?: boolean; onSelect(): void }
  | { kind: 'check'; label: string; icon?: ReactNode; hint?: string; checked: boolean; onSelect(): void }
  | { kind: 'sep' }
  | { kind: 'label'; label: string }

export function MenuList(props: { items: MenuItem[]; onClose(): void; width?: number; className?: string }) {
  return (
    <div
      role="menu"
      className={`liquid-glass pop-in rounded-[var(--r-md)] p-1 z-50 ${props.className ?? ''}`}
      style={{ width: props.width ?? 220 }}
      onClick={e => e.stopPropagation()}
    >
      {props.items.map((it, i) => {
        if (it.kind === 'sep') return <div key={i} className="my-1 h-px mx-1.5" style={{ background: 'var(--border-soft)' }} />
        if (it.kind === 'label')
          return (
            <div key={i} className="caps px-2 pt-1.5 pb-1" style={{ color: 'var(--faint)' }}>
              {it.label}
            </div>
          )
        const disabled = it.kind === 'action' && it.disabled
        const danger = it.kind === 'action' && it.danger
        return (
          <button
            key={i}
            role={it.kind === 'check' ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={it.kind === 'check' ? it.checked : undefined}
            disabled={disabled}
            onClick={() => {
              it.onSelect()
              props.onClose()
            }}
            className="group w-full h-7 flex items-center gap-2 px-2 rounded-[var(--r-sm)] text-sm text-left transition-colors hover:bg-[var(--hover-strong)] disabled:opacity-40"
            style={{ color: danger ? 'var(--danger-ink)' : 'var(--fg)' }}
          >
            <span className="w-4 shrink-0 inline-flex justify-center" style={{ color: danger ? 'var(--danger)' : 'var(--muted)' }}>
              {it.kind === 'check' ? (
                it.checked ? (
                  <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="var(--accent)" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  it.icon
                )
              ) : (
                it.icon
              )}
            </span>
            <span className="flex-1 truncate">{it.label}</span>
            {it.hint && (
              <span className="text-2xs shrink-0" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                {it.hint}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** 触发按钮 + 菜单：自管开合、外部点击与 Esc 关闭 */
export function MenuButton(props: {
  items: MenuItem[]
  title: string
  children: ReactNode
  align?: 'left' | 'right'
  side?: 'top' | 'bottom'
  width?: number
  active?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const pos = `${props.side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'} ${props.align === 'left' ? 'left-0' : 'right-0'}`
  return (
    <div ref={ref} className="relative no-drag">
      <button
        title={props.title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={props.className ?? 'icon-btn h-7 min-w-7 px-1.5 inline-flex items-center justify-center gap-1 text-xs'}
        style={{ color: open || props.active ? 'var(--accent-ink)' : 'var(--muted)', background: open ? 'var(--hover)' : props.active ? 'var(--selected)' : undefined }}
      >
        {props.children}
      </button>
      {open && (
        <div className={`absolute ${pos}`}>
          <MenuList items={props.items} onClose={() => setOpen(false)} width={props.width} />
        </div>
      )}
    </div>
  )
}
