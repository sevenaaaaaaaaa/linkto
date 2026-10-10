import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { THEME_PRESETS } from '../../lib/theme-presets'
import {
  activePresetId, setPreset, getThemePref, setThemePref, onThemeChange, type ThemePref
} from '../../lib/theme'
import type { GeneralSettings } from '@shared/types'

export function SectionTitle(props: { children: React.ReactNode }) {
  return <div className="text-[12px] font-medium text-zinc-400 uppercase tracking-wide mb-1 mt-5">{props.children}</div>
}

export function SettingRow(props: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-2.5 border-b border-black/[0.04]">
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] text-zinc-800">{props.label}</div>
        {props.desc && <div className="text-[12px] text-zinc-400 mt-0.5">{props.desc}</div>}
      </div>
      {props.children}
    </div>
  )
}

export function Toggle(props: { checked: boolean; onChange(v: boolean): void }) {
  return (
    <button
      onClick={() => props.onChange(!props.checked)}
      className={`no-drag w-[42px] h-[25px] rounded-full transition-colors relative shrink-0 ${
        props.checked ? 'bg-blue-600' : 'bg-zinc-300'
      }`}
    >
      <span
        className={`absolute top-[2.5px] w-[20px] h-[20px] rounded-full bg-white shadow transition-all ${
          props.checked ? 'left-[19px]' : 'left-[2.5px]'
        }`}
      />
    </button>
  )
}

export function Select(props: { value: string; onChange(v: string): void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={props.value}
      onChange={e => props.onChange(e.target.value)}
      className="no-drag text-[13px] bg-zinc-100 rounded-lg px-2.5 py-1.5 outline-none border border-black/[0.05]"
    >
      {props.options.map(o => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function GeneralTab() {
  const [s, setS] = useState<GeneralSettings | null>(null)

  useEffect(() => {
    void api.getGeneralSettings().then(setS)
  }, [])

  if (!s) return null
  const update = (patch: Partial<GeneralSettings>) => {
    const next = { ...s, ...patch }
    setS(next)
    void api.setGeneralSettings(next)
  }

  return (
    <div className="max-w-[620px]">
      <SectionTitle>外观</SectionTitle>
      <AppearancePanel />
      <SectionTitle>阅读</SectionTitle>
      <SettingRow label="远程图片" desc="拦截可隐藏追踪像素的远程图片，阅读时仍可单封放行">
        <Select
          value={s.remoteImages}
          onChange={v => update({ remoteImages: v as GeneralSettings['remoteImages'] })}
          options={[
            { value: 'block', label: '默认拦截' },
            { value: 'allow', label: '自动加载' }
          ]}
        />
      </SettingRow>
      <SettingRow label="删除行为">
        <Select
          value={s.deleteBehavior}
          onChange={v => update({ deleteBehavior: v as GeneralSettings['deleteBehavior'] })}
          options={[
            { value: 'trash', label: '移入废纸篓' },
            { value: 'perm', label: '永久删除' }
          ]}
        />
      </SettingRow>
      <SettingRow label="列表密度">
        <Select
          value={s.density}
          onChange={v => update({ density: v as GeneralSettings['density'] })}
          options={[
            { value: 'cozy', label: '标准' },
            { value: 'compact', label: '紧凑' }
          ]}
        />
      </SettingRow>

      <SectionTitle>应用</SectionTitle>
      <SettingRow label="开机自启" desc="登录 macOS 时在后台启动 LinkTo（不抢占前台）">
        <Toggle checked={s.launchAtLogin} onChange={v => update({ launchAtLogin: v })} />
      </SettingRow>
      <SettingRow label="Dock 未读角标">
        <Toggle checked={s.dockBadge} onChange={v => update({ dockBadge: v })} />
      </SettingRow>

      <SectionTitle>快捷键</SectionTitle>
      <div className="text-[13px] text-zinc-600 leading-loose">
        <Kbd>⌘K</Kbd> 命令面板 · <Kbd>⌘N</Kbd> 写邮件 · <Kbd>⌘F</Kbd> 搜索 · <Kbd>⌘T</Kbd> 明暗 · <Kbd>⌘,</Kbd> 设置
        <br />
        <Kbd>J</Kbd>/<Kbd>K</Kbd> 下一封 / 上一封 · <Kbd>R</Kbd> 回复 · <Kbd>A</Kbd> 归档 · <Kbd>⌫</Kbd> 删除
      </div>

      <SectionTitle>关于</SectionTitle>
      <About />
    </div>
  )
}

/** 外观：明暗分段控件 + 主题预设网格（ThirdC 设计规范面板的预设卡片交互） */
function AppearancePanel() {
  const [pref, setPref] = useState<ThemePref>(getThemePref())
  const [presetId, setPresetId] = useState(activePresetId())

  useEffect(
    () =>
      onThemeChange(() => {
        setPref(getThemePref())
        setPresetId(activePresetId())
      }),
    []
  )

  const BUILTIN = 'default'
  return (
    <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm p-4">
      <div className="flex items-center gap-1 p-1 rounded-xl bg-zinc-100 w-fit mb-4">
        {(['auto', 'light', 'dark'] as ThemePref[]).map(p => (
          <button
            key={p}
            onClick={() => setThemePref(p)}
            className="text-[12.5px] px-3.5 py-1.5 rounded-lg transition-all"
            style={pref === p ? { background: 'var(--surface-strong)', color: 'var(--accent-strong)', boxShadow: 'var(--shadow-sm)' } : { color: 'var(--muted)' }}
          >
            {p === 'auto' ? '跟随系统' : p === 'light' ? '浅色' : '深色'}
          </button>
        ))}
      </div>
      <div className="text-[12px] text-zinc-400 mb-2.5">主题预设 · 来自 OpenFlow 设计系统，点击即换肤，再点一次恢复内置</div>
      <div className="grid grid-cols-2 gap-2">
        {THEME_PRESETS.map(p => {
          const active = presetId === p.id && p.id !== BUILTIN
          const builtinActive = !presetId || presetId === BUILTIN
          return (
            <button
              key={p.id}
              onClick={() => {
                const next = p.id === BUILTIN || presetId === p.id ? '' : p.id
                setPreset(next || null)
                setPresetId(next)
              }}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-all"
              style={{
                borderColor: (p.id === BUILTIN ? builtinActive : active) ? 'var(--accent)' : 'var(--border)',
                background: (p.id === BUILTIN ? builtinActive : active) ? 'var(--accent-soft)' : 'transparent'
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
      <div className="mt-3 text-[12px] text-zinc-400 leading-relaxed">
        阅读风格（信纸皮肤）在阅读窗右上角「风格」菜单切换，24 款设计风格独立于应用主题。
      </div>
    </div>
  )
}

function About() {  const [v, setV] = useState<{ app: string; electron: string; node: string } | null>(null)
  useEffect(() => {
    void api.getVersions().then(setV)
  }, [])
  return (
    <div className="text-[12.5px] text-zinc-400 leading-relaxed">
      LinkTo 林可兔 {v?.app} · AI 原生邮件工作台
      <br />
      Electron {v?.electron} · Node {v?.node} · LinKTo / OpenFlow 家族
    </div>
  )
}

function Kbd(props: { children: React.ReactNode }) {
  return (
    <kbd className="inline-block px-1.5 py-0.5 rounded-md bg-zinc-100 border border-black/[0.06] text-[11.5px] font-mono text-zinc-600">
      {props.children}
    </kbd>
  )
}
