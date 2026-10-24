/**
 * 自定义调校面板：叠加在当前主题（预设 / 内置）之上的微调层。
 * 维度：强调色 / 圆角风格 / 毛玻璃强度 / 表面质感 / 环境光斑 / 阴影深度 / 动效，
 * 并支持把当前组合保存为命名预设、导入导出 JSON 跨设备分享。
 */
import { useEffect, useState } from 'react'
import {
  getTweak,
  setTweak,
  resetTweak,
  tweakActive,
  onThemeChange,
  ACCENT_SWATCHES,
  hexToOklch,
  oklchToHex,
  listTweakPresets,
  saveTweakPreset,
  deleteTweakPreset,
  applyTweakPreset,
  exportTweakPresets,
  importTweakPresets,
  type ThemeTweak
} from '../../lib/theme'

export function TuneSection() {
  const [open, setOpen] = useState(false)
  const [t, setT] = useState<ThemeTweak>(getTweak())
  const [presets, setPresets] = useState(listTweakPresets())
  const [customHex, setCustomHex] = useState(() => (getTweak().accent ? oklchToHex(getTweak().accent!) : '#2563eb'))
  const [savingName, setSavingName] = useState(false)
  const [name, setName] = useState('')
  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(
    () =>
      onThemeChange(() => {
        setT(getTweak())
        setPresets(listTweakPresets())
      }),
    []
  )

  const update = (patch: Partial<ThemeTweak>) => {
    const next: ThemeTweak = { ...t }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null) delete next[k as keyof ThemeTweak]
      else (next as Record<string, unknown>)[k] = v
    }
    setT(next)
    setTweak(next)
  }

  const flash = (text: string) => {
    setMsg(text)
    window.setTimeout(() => setMsg(''), 2400)
  }

  return (
    <div className="mt-3 pt-3 border-t border-ink/[0.06]">
      <button onClick={() => setOpen(v => !v)} className="w-full flex items-center gap-2 text-left">
        <span className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
          自定义调校
        </span>
        {tweakActive() && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" title="有调校生效中" />}
        <span className="text-xs" style={{ color: 'var(--faint)' }}>
          叠加在当前主题之上 · 强调色 / 圆角 / 玻璃 / 阴影 / 动效
        </span>
        <span className="ml-auto text-xs" style={{ color: 'var(--faint)' }}>
          {open ? '收起' : '展开'}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {/* 强调色 */}
          <div className="flex items-center gap-3">
            <span className="w-16 text-xs shrink-0" style={{ color: 'var(--muted)' }}>
              强调色
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {ACCENT_SWATCHES.map(s => (
                <button
                  key={s.name}
                  title={s.name}
                  onClick={() => update({ accent: s.oklch })}
                  className="w-6 h-6 rounded-full border transition-transform hover:scale-110"
                  style={{ background: s.oklch, borderColor: t.accent === s.oklch ? 'var(--fg)' : 'var(--border)', boxShadow: t.accent === s.oklch ? '0 0 0 2px var(--accent-soft)' : 'none' }}
                />
              ))}
              <label
                title="自定义颜色"
                className="w-6 h-6 rounded-full border cursor-pointer relative overflow-hidden"
                style={{ borderColor: t.accent && !ACCENT_SWATCHES.some(s => s.oklch === t.accent) ? 'var(--fg)' : 'var(--border)', background: `conic-gradient(#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f87171)` }}
              >
                <input
                  type="color"
                  value={customHex}
                  onChange={e => {
                    setCustomHex(e.target.value)
                    update({ accent: hexToOklch(e.target.value) })
                  }}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </label>
              {t.accent && (
                <button onClick={() => update({ accent: undefined })} className="text-xs px-2 py-1 rounded-lg bg-zinc-100 hover:bg-zinc-200" style={{ color: 'var(--muted)' }}>
                  跟随主题
                </button>
              )}
            </div>
          </div>

          {/* 圆角 */}
          <div className="flex items-center gap-3">
            <span className="w-16 text-xs shrink-0" style={{ color: 'var(--muted)' }}>
              圆角
            </span>
            <Seg
              value={t.radius ?? 'normal'}
              options={[
                { v: 'sharp', label: '直角' },
                { v: 'small', label: '小' },
                { v: 'normal', label: '标准' },
                { v: 'large', label: '大' },
                { v: 'round', label: '超圆' }
              ]}
              onChange={v => update({ radius: v })}
            />
          </div>

          {/* 毛玻璃 */}
          <div className="flex items-center gap-3">
            <span className="w-16 text-xs shrink-0" style={{ color: 'var(--muted)' }}>
              毛玻璃
            </span>
            <Seg
              value={t.glassBlur ?? 1}
              options={[
                { v: 0.5, label: '轻透' },
                { v: 1, label: '标准' },
                { v: 1.6, label: '重磨砂' }
              ]}
              onChange={v => update({ glassBlur: v === 1 ? undefined : v })}
            />
            <span className="w-16 text-xs shrink-0" style={{ color: 'var(--muted)' }}>
              表面
            </span>
            <Seg
              value={t.surface ?? 'theme'}
              options={[
                { v: 'theme', label: '半透明' },
                { v: 'solid', label: '实心' }
              ]}
              onChange={v => update({ surface: v === 'theme' ? undefined : v })}
            />
          </div>

          {/* 光斑 / 阴影 */}
          <div className="flex items-center gap-3">
            <span className="w-16 text-xs shrink-0" style={{ color: 'var(--muted)' }}>
              环境光斑
            </span>
            <Seg
              value={t.blobs ?? 'theme'}
              options={[
                { v: 'theme', label: '跟随主题' },
                { v: 'off', label: '关闭' }
              ]}
              onChange={v => update({ blobs: v === 'theme' ? undefined : v })}
            />
            <span className="w-16 text-xs shrink-0" style={{ color: 'var(--muted)' }}>
              阴影
            </span>
            <Seg
              value={t.shadow ?? 'normal'}
              options={[
                { v: 'none', label: '无' },
                { v: 'soft', label: '柔和' },
                { v: 'normal', label: '标准' },
                { v: 'deep', label: '深沉' }
              ]}
              onChange={v => update({ shadow: v === 'normal' ? undefined : v })}
            />
          </div>

          {/* 动效 */}
          <div className="flex items-center gap-3">
            <span className="w-16 text-xs shrink-0" style={{ color: 'var(--muted)' }}>
              动效
            </span>
            <Seg
              value={t.motion ?? 'normal'}
              options={[
                { v: 'normal', label: '标准' },
                { v: 'reduced', label: '减弱' }
              ]}
              onChange={v => update({ motion: v === 'normal' ? undefined : v })}
            />
          </div>

          {/* 界面字体 / 中性色温 */}
          <div className="flex items-center gap-3">
            <span className="w-16 text-xs shrink-0" style={{ color: 'var(--muted)' }}>
              界面字体
            </span>
            <Seg
              value={t.fontUI ?? 'system'}
              options={[
                { v: 'system', label: '系统' },
                { v: 'pingfang', label: '苹方' },
                { v: 'serif', label: '宋体' },
                { v: 'mono', label: '等宽' }
              ]}
              onChange={v => update({ fontUI: v === 'system' ? undefined : v })}
            />
            <span className="w-16 text-xs shrink-0" style={{ color: 'var(--muted)' }}>
              色温
            </span>
            <Seg
              value={t.neutralTemp ?? 'theme'}
              options={[
                { v: 'theme', label: '跟随主题' },
                { v: 'cool', label: '冷灰' },
                { v: 'gray', label: '纯灰' },
                { v: 'paper', label: '暖纸' },
                { v: 'sand', label: '米棕' }
              ]}
              onChange={v => update({ neutralTemp: v === 'theme' ? undefined : v })}
            />
          </div>

          {/* 调校预设管理 */}
          <div className="flex items-center gap-2 flex-wrap pt-1">
            {savingName ? (
              <>
                <input
                  autoFocus
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && name.trim()) {
                      saveTweakPreset(name)
                      setName('')
                      setSavingName(false)
                      flash('已保存当前调校为预设')
                    } else if (e.key === 'Escape') setSavingName(false)
                  }}
                  placeholder="预设名称，回车保存"
                  className="text-xs px-2.5 py-1.5 rounded-lg bg-white border border-ink/[0.1] outline-none w-40"
                />
                <button onClick={() => setSavingName(false)} className="text-xs px-2 py-1.5 rounded-lg text-zinc-400 hover:bg-ink/5">
                  取消
                </button>
              </>
            ) : (
              <button onClick={() => setSavingName(true)} className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-on-accent hover:bg-blue-700">
                保存当前为预设
              </button>
            )}
            {tweakActive() && (
              <button
                onClick={() => {
                  resetTweak()
                  flash('已恢复主题默认')
                }}
                className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200"
                style={{ color: 'var(--muted)' }}
              >
                重置全部
              </button>
            )}
            <button
              onClick={() => {
                void navigator.clipboard.writeText(exportTweakPresets())
                flash('已复制全部调校预设 JSON')
              }}
              className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200"
              style={{ color: 'var(--muted)' }}
            >
              导出
            </button>
            <button onClick={() => setImporting(v => !v)} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200" style={{ color: 'var(--muted)' }}>
              导入
            </button>
            {msg && <span className="text-xs" style={{ color: 'var(--accent)' }}>{msg}</span>}
          </div>

          {importing && (
            <div className="space-y-1.5">
              <textarea
                value={importText}
                onChange={e => setImportText(e.target.value)}
                placeholder={'粘贴导出的 JSON（{app:"linkto", kind:"theme-tweaks", …}）'}
                className="w-full h-20 text-xs font-mono px-3 py-2 rounded-lg bg-white border border-ink/[0.1] outline-none resize-none select-text"
              />
              <button
                onClick={() => {
                  const r = importTweakPresets(importText)
                  if (r.ok) {
                    setImporting(false)
                    setImportText('')
                    flash(`已导入 ${r.count} 个预设`)
                  } else flash(r.error ?? '导入失败')
                }}
                className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-on-accent hover:bg-blue-700"
              >
                解析并导入
              </button>
            </div>
          )}

          {presets.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {presets.map(p => (
                <span key={p.id} className="inline-flex items-center gap-1 pl-1 pr-0.5 py-0.5 rounded-full border border-ink/[0.1]" style={{ background: 'var(--bg-soft)' }}>
                  <button onClick={() => applyTweakPreset(p.id)} className="text-xs px-1.5 py-0.5 rounded-full hover:bg-ink/5" style={{ color: 'var(--fg)' }}>
                    {p.name}
                  </button>
                  <button onClick={() => deleteTweakPreset(p.id)} className="w-4 h-4 rounded-full text-2xs text-zinc-400 hover:text-red-500" title="删除预设">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 分段选择器（与外观面板的明暗控件同款交互） */
function Seg<T extends string | number>(props: { value: T; options: { v: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div className="flex gap-0.5 p-0.5 rounded-lg bg-zinc-100">
      {props.options.map(o => (
        <button
          key={String(o.v)}
          onClick={() => props.onChange(o.v)}
          className="text-xs px-2.5 py-1 rounded-md transition-all whitespace-nowrap"
          style={props.value === o.v ? { background: 'var(--surface-strong)', color: 'var(--accent-strong)', boxShadow: 'var(--shadow-sm)' } : { color: 'var(--muted)' }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
