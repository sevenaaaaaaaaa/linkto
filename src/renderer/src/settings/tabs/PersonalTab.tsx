import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { usePrefs, setPrefs } from '../../lib/prefs'
import { SidebarEditor } from '../../app/upgrade/SidebarEditor'
import { SectionTitle, SettingRow, Toggle } from './GeneralTab'
import { ACCOUNT_COLORS } from '@shared/presets'
import type { AccountWithStatus } from '@shared/types'

/** 分段选择：选项少于 5 个时比下拉更快 */
function Seg<T extends string | number>(props: { value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <div className="no-drag shrink-0 inline-flex p-0.5 rounded-[var(--r-sm)]" style={{ background: 'var(--hover)' }} role="radiogroup">
      {props.options.map(o => {
        const on = o.value === props.value
        return (
          <button
            key={String(o.value)}
            role="radio"
            aria-checked={on}
            onClick={() => props.onChange(o.value)}
            className="h-7 px-2.5 rounded-[var(--r-xs)] text-xs transition-colors"
            style={on ? { background: 'var(--surface-strong)', color: 'var(--fg)', fontWeight: 600, boxShadow: 'var(--shadow-sm)' } : { color: 'var(--muted)' }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

const SHORTCUTS: [string, string][] = [
  ['⌘K', '命令面板 · 搜索或直接提问'],
  ['⌘J', '右侧栏切到 Agent'],
  ['⌘0 / ⌘1–9', '全部账户 / 切到第 N 个账户'],
  ['⌘N', '写邮件'],
  ['J / K', '下一封 / 上一封'],
  ['E（或 A）', '归档'],
  ['S', '稍后处理'],
  ['R', '回复'],
  ['V', '移动到文件夹（AI 先猜目标）'],
  ['⌫', '删除'],
  ['⌘T', '切换明暗'],
  ['逐封处理里', 'E 归档 · S 稍后 · R 回复 · ↓ 跳过 · Esc 退出']
]

/**
 * 个性化：列表、阅读、侧栏（入口钉住 / 更多 / 隐藏与排序）、账户颜色、字体与快捷键。
 * 都是本机界面偏好，改完立即在主窗口生效。
 */
export function PersonalTab() {
  const p = usePrefs()
  const isMac = document.documentElement.dataset.os === 'mac'
  const nativeShell = document.documentElement.dataset.nativeShell === '1'
  const [accounts, setAccounts] = useState<AccountWithStatus[]>([])
  useEffect(() => {
    void api.listAccounts().then(setAccounts)
  }, [])

  return (
    <div className="max-w-[640px]">
      <SectionTitle>列表</SectionTitle>
      <SettingRow label="密度" desc="紧凑一屏多看几封；舒适更好读">
        <Seg value={p.density} onChange={v => setPrefs({ density: v })} options={[{ value: 'cozy', label: '舒适' }, { value: 'compact', label: '紧凑' }]} />
      </SettingRow>
      <SettingRow label="每封邮件的第三行" desc="AI 要点会把关键短语用荧光标出">
        <Seg
          value={p.rowPreview}
          onChange={v => setPrefs({ rowPreview: v })}
          options={[{ value: 'gist', label: 'AI 要点' }, { value: 'snippet', label: '原文摘要' }, { value: 'none', label: '不显示' }]}
        />
      </SettingRow>
      <SettingRow label="收件箱 AI 分区" desc="需要你处理 / 等待对方 / 打包 / 其他；关闭后按时间排成一列">
        <Toggle checked={p.sections} onChange={v => setPrefs({ sections: v })} />
      </SettingRow>
      <SettingRow label="今日简报卡" desc="收件箱顶部一两句话的当日重点">
        <Toggle checked={p.brief} onChange={v => setPrefs({ brief: v })} />
      </SettingRow>
      <SettingRow label="项目标签" desc="属于某个项目的邮件，在发件人旁显示项目色点与短名">
        <Toggle checked={p.projectTags} onChange={v => setPrefs({ projectTags: v })} />
      </SettingRow>

      <SectionTitle>阅读</SectionTitle>
      <SettingRow label="正文字号">
        <Seg value={p.readerSize} onChange={v => setPrefs({ readerSize: v })} options={([13, 14, 15, 16, 17] as const).map(n => ({ value: n, label: String(n) }))} />
      </SettingRow>
      <SettingRow label="正文宽度" desc="适中更易读；铺满适合宽表格和营销邮件">
        <Seg value={p.readerWidth} onChange={v => setPrefs({ readerWidth: v })} options={[{ value: 'comfort', label: '适中' }, { value: 'full', label: '铺满' }]} />
      </SettingRow>
      <SettingRow label="AI 划重点" desc="正文里的关键句用荧光标出">
        <Toggle checked={p.highlights} onChange={v => setPrefs({ highlights: v })} />
      </SettingRow>
      <SettingRow label="右侧栏默认" desc="打开邮件时右侧显示什么（随时可按 ⌘J 切换）">
        <Seg
          value={p.defaultRail}
          onChange={v => {
            setPrefs({ defaultRail: v })
            try {
              localStorage.setItem('ms_rail', v === 'none' ? '' : v)
            } catch {
              /* ignore */
            }
          }}
          options={[{ value: 'context', label: '上下文' }, { value: 'agent', label: 'Agent' }, { value: 'none', label: '收起' }]}
        />
      </SettingRow>

      <SectionTitle>侧栏</SectionTitle>
      <div className="text-xs mb-2" style={{ color: 'var(--faint)' }}>每个入口可以钉在侧栏、收进「更多」或隐藏，拖动排序；主窗口侧栏底部「编辑侧栏」是同一份设置。</div>
      <div className="rounded-[var(--r-md)] border border-[var(--border)] p-3" style={{ background: 'var(--surface-strong)' }}>
        <SidebarEditor />
      </div>

      {accounts.length > 0 && (
        <>
          <SectionTitle>账户颜色</SectionTitle>
          <div className="text-xs mb-2" style={{ color: 'var(--faint)' }}>这个颜色贯穿账户栏、列表色条、阅读页「收于」标签和文件夹图标。</div>
          {accounts.map(a => (
            <SettingRow key={a.id} label={a.name} desc={a.email}>
              <div className="flex gap-1.5">
                {ACCOUNT_COLORS.map(c => (
                  <button
                    key={c}
                    aria-label={`${a.name} 使用颜色 ${c}`}
                    onClick={async () => {
                      await api.updateAccount(a.id, { color: c } as never)
                      setAccounts(list => list.map(x => (x.id === a.id ? { ...x, color: c } : x)))
                    }}
                    className="w-5 h-5 rounded-full transition-transform hover:scale-110"
                    style={{ background: c, boxShadow: a.color === c ? '0 0 0 2px var(--bg), 0 0 0 4px var(--fg)' : undefined }}
                  />
                ))}
              </div>
            </SettingRow>
          ))}
        </>
      )}

      {isMac && (
        <>
          <SectionTitle>原生外观</SectionTitle>
          <SettingRow label="侧栏材质" desc="拖动调整：越低越透，越高越实（36–82%）">
            <div className="no-drag flex items-center gap-2.5">
              <input
                aria-label="侧栏材质强度"
                type="range"
                min={36}
                max={82}
                step={1}
                value={p.nativeTint}
                onChange={e => setPrefs({ nativeTint: Number(e.target.value) })}
                className="h-1.5 w-[150px] cursor-pointer rounded-full"
                style={{ accentColor: 'var(--accent)' }}
              />
              <span className="w-8 text-right text-xs tabular-nums" style={{ color: 'var(--muted)' }}>
                {p.nativeTint}%
              </span>
            </div>
          </SettingRow>
          {nativeShell && (
            <SettingRow label="工具栏按钮" desc="在主窗口打开原生自定义面板，拖动排序 / 显示隐藏">
              <button
                className="no-drag h-7 rounded-[var(--r-sm)] px-3 text-xs"
                style={{ background: 'var(--hover)', color: 'var(--fg)' }}
                onClick={() => void api.macShellCustomize()}
              >
                自定义…
              </button>
            </SettingRow>
          )}
          <SettingRow label="图标粗细" desc="SF Symbols 字重；切换时后台重渲染一次">
            <Seg
              value={p.sfWeight}
              onChange={v => setPrefs({ sfWeight: v })}
              options={[{ value: 'regular', label: '常规' }, { value: 'medium', label: '中等' }, { value: 'semibold', label: '加粗' }]}
            />
          </SettingRow>
          <SettingRow label="图标大小" desc="统一缩放 SF Symbols，不改变布局">
            <Seg
              value={p.sfScale}
              onChange={v => setPrefs({ sfScale: v })}
              options={[{ value: 'small', label: '小' }, { value: 'normal', label: '标准' }, { value: 'large', label: '大' }]}
            />
          </SettingRow>
        </>
      )}

      <SectionTitle>字体与快捷键</SectionTitle>
      <SettingRow label="界面字体" desc={isMac ? 'macOS 固定使用系统 SF Pro / SF Mono' : 'Geist 搭配苹方；或完全使用系统字体'}>
        {isMac ? (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>SF Pro</span>
        ) : (
          <Seg value={p.uiFont} onChange={v => setPrefs({ uiFont: v })} options={[{ value: 'geist', label: 'Geist' }, { value: 'system', label: '系统' }]} />
        )}
      </SettingRow>
      <SettingRow label="单键快捷键" desc="E / S / R / V / J / K 等不带 ⌘ 的快捷键；与输入法冲突时可关闭">
        <Toggle checked={p.singleKey} onChange={v => setPrefs({ singleKey: v })} />
      </SettingRow>
      <div className="mt-3 rounded-[var(--r-md)] border border-[var(--border)] divide-y divide-[var(--border-soft)]" style={{ background: 'var(--surface-strong)' }}>
        {SHORTCUTS.map(([k, label]) => (
          <div key={k} className="flex items-center gap-4 px-4 h-9 text-sm">
            <kbd className="w-[120px] shrink-0 text-xs" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>{k}</kbd>
            <span style={{ color: 'var(--muted)' }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
