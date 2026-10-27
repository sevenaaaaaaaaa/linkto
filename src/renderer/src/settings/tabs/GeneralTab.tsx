import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { THEME_PRESETS } from '../../lib/theme-presets'
import { TuneSection } from './AppearanceTune'
import {
  activePresetId, setPreset, getThemePref, setThemePref, onThemeChange, type ThemePref
} from '../../lib/theme'
import type { GeneralSettings } from '@shared/types'
import type { TerminalAppInfo } from '@shared/terminal'
import type { UpdateCheckResult, UpdateDownloadStatus } from '@shared/updates'

export function SectionTitle(props: { children: React.ReactNode }) {
  return <h2 className="text-xs font-semibold mb-1 mt-7 first:mt-1" style={{ color: 'var(--faint)', letterSpacing: '0.04em' }}>{props.children}</h2>
}

export function SettingRow(props: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-3 border-b border-[var(--border-soft)]">
      <div className="flex-1 min-w-0">
        <div className="text-sm" style={{ color: 'var(--fg)' }}>{props.label}</div>
        {props.desc && <div className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--faint)' }}>{props.desc}</div>}
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
        className={`absolute top-[2.5px] w-[20px] h-[20px] rounded-full bg-white shadow-[var(--shadow)] transition-all ${
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
      className="no-drag text-sm bg-zinc-100 rounded-lg px-2.5 py-1.5 outline-none border border-ink/[0.05]"
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
  const [terminals, setTerminals] = useState<TerminalAppInfo[]>([])
  const [terminalNote, setTerminalNote] = useState('')

  useEffect(() => {
    void api.getGeneralSettings().then(setS)
    void api.terminalApps().then(setTerminals).catch(() => setTerminals([]))
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
      <SectionTitle>收件箱纪律</SectionTitle>
      <SettingRow label="新发件人审批（Screener）" desc="陌生发件人的邮件先进入待审队列，放行后才进入收件箱；有过往来的发件人自动放行">
        <Toggle checked={s.screenerEnabled} onChange={v => update({ screenerEnabled: v })} />
      </SettingRow>

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

      <SectionTitle>应用</SectionTitle>
      <SettingRow label="开机自启" desc="登录 macOS 时在后台启动 LinkTo（不抢占前台）">
        <Toggle checked={s.launchAtLogin} onChange={v => update({ launchAtLogin: v })} />
      </SettingRow>
      <SettingRow label="Dock 未读角标">
        <Toggle checked={s.dockBadge} onChange={v => update({ dockBadge: v })} />
      </SettingRow>

      <SectionTitle>终端</SectionTitle>
      <SettingRow
        label="打开终端时使用"
        desc="列表来自本机实际安装的终端。也可以在菜单「显示 → 在终端中打开数据目录」里为这一次临时选另一个。"
      >
        {terminals.length ? (
          <Select
            value={terminals.some(t => t.id === s.terminalApp) ? (s.terminalApp ?? '') : ''}
            onChange={v => update({ terminalApp: v })}
            options={[
              { value: '', label: '自动（' + (terminals.find(t => t.id === 'com.apple.Terminal')?.name ?? terminals[0]?.name ?? '终端') + '）' },
              ...terminals.map(t => ({ value: t.id, label: t.name + (t.version ? ' · ' + t.version : '') }))
            ]}
          />
        ) : (
          <span className="text-xs" style={{ color: 'var(--faint)' }}>没有检测到终端应用</span>
        )}
      </SettingRow>
      <SettingRow label="在终端中打开数据目录" desc="打开 ~/Library/Application Support/linkto/mail-studio，方便查看附件、eml 与数据库。">
        <button
          onClick={() => {
            setTerminalNote('')
            void api.terminalOpen().then(r => setTerminalNote(r.ok ? '已打开' : r.error ?? '打开失败'))
          }}
          className="no-drag text-sm px-3 py-1.5 rounded-lg bg-zinc-100"
        >
          打开
        </button>
      </SettingRow>
      {terminalNote && <div className="text-xs mt-1" style={{ color: 'var(--faint)' }}>{terminalNote}</div>}

      <SectionTitle>快捷键</SectionTitle>
      <div className="text-sm text-zinc-600 leading-loose">
        <Kbd>⌘K</Kbd> 命令面板 · <Kbd>⌘N</Kbd> 写邮件 · <Kbd>⌘F</Kbd> 搜索 · <Kbd>⌘T</Kbd> 明暗 · <Kbd>⌘,</Kbd> 设置
        <br />
        <Kbd>J</Kbd>/<Kbd>K</Kbd> 下一封 / 上一封 · <Kbd>R</Kbd> 回复 · <Kbd>A</Kbd> 归档 · <Kbd>⌫</Kbd> 删除
      </div>

      <SectionTitle>关于</SectionTitle>
      <About />
      <UpdatePanel />
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
    <div className="rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] p-4">
      <div className="flex items-center gap-1 p-1 rounded-xl bg-zinc-100 w-fit mb-4">
        {(['auto', 'light', 'dark'] as ThemePref[]).map(p => (
          <button
            key={p}
            onClick={() => setThemePref(p)}
            className="text-xs px-3.5 py-1.5 rounded-lg transition-all"
            style={pref === p ? { background: 'var(--surface-strong)', color: 'var(--accent-strong)', boxShadow: 'var(--shadow-sm)' } : { color: 'var(--muted)' }}
          >
            {p === 'auto' ? '跟随系统' : p === 'light' ? '浅色' : '深色'}
          </button>
        ))}
      </div>
      <div className="text-xs text-zinc-400 mb-2.5">主题预设 · 来自 OpenFlow 设计系统，点击即换肤，再点一次恢复内置</div>
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
                <span className="block text-xs font-semibold truncate" style={{ color: 'var(--fg)' }}>{p.name}</span>
                <span className="block text-2xs truncate" style={{ color: 'var(--faint)' }}>{p.desc}</span>
              </span>
              <span className="flex gap-1 shrink-0">
                <i className="w-3.5 h-3.5 rounded-xs border border-ink/10" style={{ background: p.light.bg }} />
                <i className="w-3.5 h-3.5 rounded-xs border border-ink/10" style={{ background: p.light.accent }} />
                <i className="w-3.5 h-3.5 rounded-xs border border-ink/10" style={{ background: p.dark.bg }} />
              </span>
            </button>
          )
        })}
      </div>
      <TuneSection />
      <div className="mt-3 text-xs text-zinc-400 leading-relaxed">
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
    <div className="text-xs text-zinc-400 leading-relaxed">
      LinkTo 林可兔 {v?.app} · AI 原生邮件工作台
      <br />
      Electron {v?.electron} · Node {v?.node} · LinKTo / OpenFlow 家族
    </div>
  )
}


function UpdatePanel() {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [status, setStatus] = useState<UpdateDownloadStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [installError, setInstallError] = useState('')

  const refreshStatus = async () => {
    try {
      setStatus(await api.updateStatus())
    } catch {
      /* 主进程还没准备好 */
    }
  }

  useEffect(() => {
    void refreshStatus()
    const timer = setInterval(() => { void refreshStatus() }, 800)
    return () => clearInterval(timer)
  }, [])

  const download = async () => {
    setStarting(true)
    setInstallError('')
    try {
      const r = await api.updateDownload()
      if (!r.ok) setInstallError(r.error ?? '下载失败')
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
      await refreshStatus()
    }
  }

  const install = async () => {
    setInstallError('')
    try {
      const r = await api.updateInstall()
      if (!r.ok) setInstallError(r.error ?? '安装失败')
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    }
  }

  const check = async () => {
    setChecking(true)
    try {
      setResult(await api.checkForUpdates(true))
    } catch {
      setResult({ currentVersion: '', latestVersion: null, hasUpdate: false, releaseUrl: null, publishedAt: null, notes: '', asset: null, error: '检查更新失败，请稍后重试。' })
    } finally {
      setChecking(false)
    }
  }

  // 打开“关于”时静默检查一次；主进程缓存 5 分钟，不会反复打 GitHub
  useEffect(() => {
    void check()
  }, [])

  const hasUpdate = !!result?.hasUpdate
  return (
    <div className="mt-4 rounded-[var(--r-md)] border p-3.5" style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)' }}>
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm" style={{ color: 'var(--fg)' }}>在线更新</div>
          <div className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--faint)' }} aria-live="polite">
            {checking
              ? '正在检查 GitHub Releases…'
              : result?.error
                ? result.error
                : result
                  ? hasUpdate
                    ? `发现新版本 ${result.latestVersion}`
                    : `已是最新版本 · 当前 ${result.currentVersion}`
                  : '检查 LinkTo 的最新版本'}
          </div>
        </div>
        <button
          onClick={() => void check()}
          disabled={checking}
          className="no-drag h-8 shrink-0 rounded-[var(--r-sm)] px-3 text-xs font-medium transition-opacity hover:opacity-90 disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
        >
          {checking ? '检查中…' : result?.error ? '重试' : '检查更新'}
        </button>
      </div>

      {hasUpdate && result && (
        <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--fg)' }}>
            <span>{result.currentVersion} → {result.latestVersion}</span>
            {result.publishedAt && (
              <span style={{ color: 'var(--faint)' }}>{new Date(result.publishedAt).toLocaleDateString('zh-CN')}</span>
            )}
          </div>
          {result.notes && (
            <div className="mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
              {result.notes}
            </div>
          )}
          {status && status.phase !== 'idle' && (
            <div className="mt-2.5 rounded-[var(--r-xs)] border px-2.5 py-2" style={{ borderColor: 'var(--border-soft)', background: 'var(--bg-soft)' }}>
              {status.phase === 'downloading' && (
                <>
                  <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
                    <div
                      className="h-full rounded-full transition-[width] duration-300"
                      style={{
                        width: (status.total > 0 ? Math.min(100, Math.round((status.received / status.total) * 100)) : 0) + '%',
                        background: 'var(--accent)'
                      }}
                    />
                  </div>
                  <div className="mt-1 text-2xs" style={{ color: 'var(--muted)' }}>
                    下载中 {status.total > 0 ? Math.min(100, Math.round((status.received / status.total) * 100)) + '%' : ''}
                    {' · '}
                    {(status.received / 1024 / 1024).toFixed(1)} / {(status.total / 1024 / 1024).toFixed(1)} MB
                  </div>
                </>
              )}
              {status.phase === 'verifying' && <div className="text-2xs" style={{ color: 'var(--muted)' }}>校验 SHA-256…</div>}
              {status.phase === 'ready' && (
                <div className="flex items-center gap-2">
                  <div className="text-2xs flex-1" style={{ color: 'var(--ok-ink)' }}>
                    {status.version} 已下载 · 退出应用也会自动安装
                  </div>
                  <button
                    onClick={() => void install()}
                    className="h-7 rounded-[var(--r-xs)] px-2.5 text-xs font-medium"
                    style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                  >
                    重启并安装
                  </button>
                </div>
              )}
              {status.phase === 'installing' && <div className="text-2xs" style={{ color: 'var(--muted)' }}>正在重启安装…</div>}
              {status.phase === 'error' && <div className="text-2xs" style={{ color: 'var(--danger-ink)' }}>{status.error ?? '下载失败'}</div>}
            </div>
          )}
          {installError && <div className="mt-2 text-2xs" style={{ color: 'var(--danger-ink)' }}>{installError}</div>}
          <div className="mt-2.5 flex flex-wrap gap-2">
            {result.asset && status?.phase !== 'downloading' && status?.phase !== 'verifying' && status?.phase !== 'ready' && status?.phase !== 'installing' && (
              <button
                onClick={() => void download()}
                disabled={starting}
                className="h-7 rounded-[var(--r-xs)] px-2.5 text-xs font-medium disabled:opacity-40"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                {starting ? '准备下载…' : status?.phase === 'error' ? '重试下载' : '下载更新'}
              </button>
            )}
            {result.releaseUrl && (
              <button
                onClick={() => void api.openUpdateUrl(result.releaseUrl!)}
                className="h-7 rounded-[var(--r-xs)] border px-2.5 text-xs"
                style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
              >
                打开发布页
              </button>
            )}
          </div>
          {result.asset && /\.zip$/i.test(result.asset.name) && (
            <div className="mt-2 text-2xs leading-relaxed" style={{ color: 'var(--faint)' }}>
              下载的是 zip 安装包：解压后把 LinkTo.app 拖入 Applications 覆盖旧版本；若当前版本已比发布页新，可忽略。
            </div>
          )}
        </div>
      )}

      {result && !hasUpdate && !result.error && (
        <div className="mt-2 text-2xs" style={{ color: 'var(--faint)' }}>
          当前 {result.currentVersion}{result.latestVersion ? ` · GitHub 最新 ${result.latestVersion}` : ''}
        </div>
      )}
    </div>
  )
}

function Kbd(props: { children: React.ReactNode }) {
  return (
    <kbd className="inline-block px-1.5 py-0.5 rounded-md bg-zinc-100 border border-ink/[0.06] text-xs font-mono text-zinc-600">
      {props.children}
    </kbd>
  )
}
