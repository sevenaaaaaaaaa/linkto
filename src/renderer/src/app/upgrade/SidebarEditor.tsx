import { useMemo, useState } from 'react'
import { usePrefs, setPrefs, getPrefs, DEFAULT_PREFS } from '../../lib/prefs'
import {
  NAV_DEFS, computeNavLayout, moveNav, reorderNav, resetNav, setPlacement, type NavId, type NavPrefs, type Placement
} from '../../lib/sidebar-layout'
import { IconChevronDown } from '../../components/icons'
import { navIcon, NAV_HINT } from './nav-meta'

const LABEL = new Map(NAV_DEFS.map(d => [d.id, d.label]))
const LOCKED = new Set(NAV_DEFS.filter(d => d.locked).map(d => d.id))

const PLACES: { value: Placement; label: string; title: string }[] = [
  { value: 'pin', label: '侧栏', title: '钉在侧栏' },
  { value: 'more', label: '更多', title: '收进「更多」' },
  { value: 'hidden', label: '隐藏', title: '隐藏（⌘K 仍可到达）' }
]

/** 读最新偏好再写（设置窗与主窗口同源共享 localStorage） */
function updateNav(fn: (p: NavPrefs) => NavPrefs) {
  setPrefs({ nav: fn(getPrefs().nav) })
}

/**
 * 编辑侧栏：每个入口「钉在侧栏 / 收进更多 / 隐藏」，拖动或上下箭头排序。
 * 侧栏底部「编辑侧栏」、设置 → 个性化、升级向导共用这一个。
 * compact：向导里只放「侧栏 / 更多」两档与排序，说明文字省略。
 */
export function SidebarEditor(props: { compact?: boolean }) {
  const p = usePrefs()
  const layout = useMemo(() => computeNavLayout(p.nav, p.sidebar), [p.nav, p.sidebar])
  const [drag, setDrag] = useState<NavId | null>(null)
  const [over, setOver] = useState<NavId | null>(null)

  const sections: { key: string; title: string; ids: NavId[]; place: Placement }[] = [
    { key: 'core', title: '侧栏 · 核心', ids: layout.core, place: 'pin' },
    { key: 'smart', title: '侧栏 · 智能', ids: layout.smart, place: 'pin' },
    { key: 'more', title: '更多（默认收起）', ids: layout.more, place: 'more' },
    ...(props.compact && !layout.hidden.length ? [] : [{ key: 'hidden', title: '隐藏', ids: layout.hidden, place: 'hidden' as Placement }])
  ]

  const drop = (target: NavId, place: Placement) => {
    if (!drag || drag === target || target === 'inbox') return
    const id = drag
    updateNav(n => {
      let next = reorderNav(n, id, target)
      if (computeNavLayout(n, getPrefs().sidebar).placement[id] !== place) next = setPlacement(next, id, place)
      return next
    })
  }

  const places = props.compact ? PLACES.filter(x => x.value !== 'hidden') : PLACES

  return (
    <div className="flex flex-col gap-3">
      {sections.map(sec => (
        <section key={sec.key}>
          <div className="caps mb-1 px-1" style={{ color: 'var(--faint)' }}>
            {sec.title}
          </div>
          {!sec.ids.length && (
            <div className="px-2 py-1.5 text-xs rounded-[var(--r-sm)] border border-dashed border-[var(--border)]" style={{ color: 'var(--faint)' }}>
              空
            </div>
          )}
          <ul className="flex flex-col">
            {sec.ids.map((id, i) => {
              const locked = LOCKED.has(id)
              const cur = layout.placement[id]
              return (
                <li
                  key={id}
                  draggable={!locked}
                  onDragStart={e => {
                    setDrag(id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => {
                    setDrag(null)
                    setOver(null)
                  }}
                  onDragOver={e => {
                    if (!drag || locked) return
                    e.preventDefault()
                    setOver(id)
                  }}
                  onDrop={e => {
                    e.preventDefault()
                    drop(id, sec.place)
                    setDrag(null)
                    setOver(null)
                  }}
                  className={`group flex items-center gap-2 h-8 px-1.5 rounded-[var(--r-sm)] ${locked ? '' : 'cursor-grab active:cursor-grabbing'} hover:bg-[var(--hover)]`}
                  style={{
                    opacity: drag === id ? 0.45 : 1,
                    boxShadow: over === id && drag && drag !== id ? 'inset 0 2px 0 var(--accent)' : undefined
                  }}
                >
                  <span className="w-4 shrink-0 inline-flex justify-center" style={{ color: 'var(--faint)' }}>
                    {navIcon(id, 14)}
                  </span>
                  <span className="text-sm shrink-0" style={{ color: 'var(--fg)' }}>
                    {LABEL.get(id)}
                  </span>
                  <span className="flex-1 min-w-0 text-2xs truncate" style={{ color: 'var(--faint)' }}>
                    {props.compact ? '' : NAV_HINT[id]}
                  </span>
                  {locked ? (
                    <span className="text-2xs pr-1" style={{ color: 'var(--faint)' }}>
                      始终显示
                    </span>
                  ) : (
                    <>
                      <span className="inline-flex shrink-0">
                        <button
                          aria-label={`上移 ${LABEL.get(id)}`}
                          title="上移"
                          disabled={i === 0 || (sec.key === 'core' && i === 1)}
                          onClick={() => updateNav(n => moveNav(n, id, -1, getPrefs().sidebar))}
                          className="w-5 h-6 inline-flex items-center justify-center rounded-[var(--r-xs)] hover:bg-[var(--hover-strong)] disabled:opacity-25 disabled:hover:bg-transparent"
                          style={{ color: 'var(--muted)' }}
                        >
                          <IconChevronDown width={11} height={11} style={{ transform: 'rotate(180deg)' }} />
                        </button>
                        <button
                          aria-label={`下移 ${LABEL.get(id)}`}
                          title="下移"
                          disabled={i === sec.ids.length - 1}
                          onClick={() => updateNav(n => moveNav(n, id, 1, getPrefs().sidebar))}
                          className="w-5 h-6 inline-flex items-center justify-center rounded-[var(--r-xs)] hover:bg-[var(--hover-strong)] disabled:opacity-25 disabled:hover:bg-transparent"
                          style={{ color: 'var(--muted)' }}
                        >
                          <IconChevronDown width={11} height={11} />
                        </button>
                      </span>
                      <div className="inline-flex p-0.5 rounded-[var(--r-sm)] shrink-0" style={{ background: 'var(--hover)' }} role="radiogroup" aria-label={`${LABEL.get(id)} 放在哪里`}>
                        {places.map(o => {
                          const on = cur === o.value || (props.compact && o.value === 'more' && cur === 'hidden')
                          return (
                            <button
                              key={o.value}
                              role="radio"
                              aria-checked={on}
                              title={o.title}
                              onClick={() => updateNav(n => setPlacement(n, id, o.value))}
                              className="h-6 px-2 rounded-[var(--r-xs)] text-2xs"
                              style={on ? { background: 'var(--surface-strong)', color: 'var(--fg)', fontWeight: 600, boxShadow: 'var(--shadow-sm)' } : { color: 'var(--muted)' }}
                            >
                              {o.label}
                            </button>
                          )
                        })}
                      </div>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      <div className="flex items-center gap-2 px-1">
        <span className="flex-1 text-2xs leading-relaxed" style={{ color: 'var(--faint)' }}>
          拖动或用箭头排序；收进「更多」的入口有提醒时，角标汇总在「更多」上；隐藏的入口用 ⌘K 仍能打开。
        </span>
        <button
          onClick={() => setPrefs({ nav: resetNav(getPrefs().nav), sidebar: DEFAULT_PREFS.sidebar })}
          className="shrink-0 h-7 px-2.5 rounded-[var(--r-sm)] text-xs border border-[var(--border)] hover:bg-[var(--hover)]"
          style={{ color: 'var(--fg)' }}
        >
          恢复默认
        </button>
      </div>
    </div>
  )
}
