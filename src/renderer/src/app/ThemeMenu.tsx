import { useEffect, useRef, useState } from 'react'
import { THEME_PRESETS, BUILTIN_PRESET_ID } from '../lib/theme-presets'
import { activePresetId, setPreset, onThemeChange, getThemePref, cycleTheme, themeLabel, type ThemePref } from '../lib/theme'
import { IconPalette, IconSun, IconMoon, IconSunMoon } from '../components/icons'

/** 主题快速切换浮层 —— ThirdC「主题预设」交互移植：
 *  每个预设一张卡（名称 + 浅底/accent/深底 三色小样），激活项 accent 描边，再点一次恢复内置，切换即 toast。 */
export function ThemeMenu() {
  const [open, setOpen] = useState(false)
  const [presetId, setPresetId] = useState(activePresetId())
  const [pref, setPref] = useState<ThemePref>(getThemePref())
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const toggle = () => setOpen(o => !o)
    window.addEventListener('ms:toggle-theme-menu', toggle)
    return () => window.removeEventListener('ms:toggle-theme-menu', toggle)
  }, [])

  useEffect(
    () =>
      onThemeChange(() => {
        setPresetId(activePresetId())
        setPref(getThemePref())
      }),
    []
  )

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const apply = (id: string) => {
    const active = presetId === id && id !== BUILTIN_PRESET_ID
    const next = active ? '' : id === BUILTIN_PRESET_ID ? '' : id
    setPreset(next || null)
    setPresetId(next)
    toast(active ? '已恢复内置主题' : `已应用预设：${THEME_PRESETS.find(p => p.id === id)?.name ?? id}`)
  }

  const cycle = () => {
    const next = cycleTheme()
    toast(`主题：${themeLabel(next)}`)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        title="主题预设（快速切换风格）"
        className="icon-btn p-2 leading-none"
        style={{ color: 'var(--muted)' }}
      >
        <IconPalette width={15} height={15} />
      </button>
      <button
        onClick={cycle}
        title="明暗切换（auto / 浅色 / 深色）"
        className="icon-btn p-2 leading-none"
        style={{ color: 'var(--muted)' }}
      >
        {pref === 'auto' ? <IconSunMoon width={15} height={15} /> : pref === 'light' ? <IconSun width={15} height={15} /> : <IconMoon width={15} height={15} />}
      </button>

      {open && (
        <div className="liquid-glass absolute bottom-10 left-0 z-40 w-[300px] rounded-[var(--r-md)] p-2 pop-in">
          <div className="px-2 pt-1 pb-1.5 text-[10.5px] font-semibold tracking-[.08em] uppercase" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
            主题预设 · 来自 OpenFlow
          </div>
          <div className="max-h-[300px] overflow-y-auto flex flex-col gap-0.5">
            {THEME_PRESETS.map(p => {
              const active = presetId === p.id
              return (
                <button
                  key={p.id}
                  onClick={() => apply(p.id)}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] text-left border transition-colors"
                  style={{
                    borderColor: active ? 'var(--accent)' : 'transparent',
                    background: active ? 'var(--accent-soft)' : 'transparent'
                  }}
                  onMouseEnter={e => {
                    if (!active) e.currentTarget.style.background = 'var(--hover)'
                  }}
                  onMouseLeave={e => {
                    if (!active) e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-[12.5px] font-semibold truncate" style={{ color: 'var(--fg)' }}>{p.name}</span>
                    <span className="block text-[11px] truncate" style={{ color: 'var(--faint)' }}>{p.desc}</span>
                  </span>
                  <span className="flex gap-1 shrink-0">
                    <i className="w-3.5 h-3.5 rounded-[5px] border border-black/10" style={{ background: p.light.bg }} />
                    <i className="w-3.5 h-3.5 rounded-[5px] border border-black/10" style={{ background: p.light.accent }} />
                    <i className="w-3.5 h-3.5 rounded-[5px] border border-black/10" style={{ background: p.dark.bg }} />
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function toast(text: string) {
  window.dispatchEvent(new CustomEvent('ms:toast', { detail: text }))
}
