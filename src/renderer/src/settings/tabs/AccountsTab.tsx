import { useEffect, useState } from 'react'
import { api, useMailEvent } from '../../lib/api'
import { IconPlus, IconMinus, IconRefresh, IconCheck, IconClose, IconKey, IconSparkles } from '../../components/icons'
import { SectionTitle } from './GeneralTab'
import { PROVIDER_PRESETS, presetFor } from '@shared/presets'
import { ACCOUNT_COLORS } from '@shared/presets'
import type { AccountDraft, AccountWithStatus, OAuthClientConfig, ProviderKey } from '@shared/types'

const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  connected: { label: '已连接', cls: 'text-green-600' },
  syncing: { label: '同步中', cls: 'text-blue-600' },
  error: { label: '连接失败', cls: 'text-red-500' },
  disabled: { label: '已停用', cls: 'text-zinc-400' }
}

export function AccountsTab() {
  const [accounts, setAccounts] = useState<AccountWithStatus[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const reload = () => void api.listAccounts().then(as => {
    setAccounts(as)
    setSelected(prev => prev ?? as[0]?.id ?? null)
  })

  useEffect(reload, [])
  useMailEvent(ev => {
    const t = (ev as { type: string }).type
    if (t === 'accounts-changed' || t === 'account-status') reload()
  })

  const current = accounts.find(a => a.id === selected)

  return (
    <div className="flex gap-5 h-full">
      {/* 左侧账户列表 */}
      <div className="w-[230px] shrink-0 flex flex-col">
        <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm flex-1 overflow-y-auto">
          {accounts.map(a => (
            <button
              key={a.id}
              onClick={() => setSelected(a.id)}
              className={`w-full flex items-center gap-2.5 px-3.5 py-3 text-left border-b border-black/[0.04] last:border-0 ${
                selected === a.id ? 'bg-blue-600 text-white' : 'hover:bg-black/[0.03]'
              }`}
            >
              <span className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[13px] font-medium shrink-0" style={{ background: a.color }}>
                {a.name[0]?.toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium truncate">{a.name}</span>
                <span className={`block text-[11.5px] truncate ${selected === a.id ? 'text-white/70' : 'text-zinc-400'}`}>{a.email}</span>
              </span>
            </button>
          ))}
          {!accounts.length && <div className="p-4 text-[13px] text-zinc-400 text-center">还没有账户</div>}
        </div>
        <div className="mt-2.5 flex items-center gap-1">
          <button onClick={() => setAdding(true)} className="p-2 rounded-lg text-zinc-500 hover:bg-black/5" title="添加账户">
            <IconPlus width={16} height={16} />
          </button>
          <button
            onClick={async () => {
              if (selected) {
                await api.deleteAccount(selected)
                setSelected(null)
                reload()
              }
            }}
            className="p-2 rounded-lg text-zinc-500 hover:bg-red-50 hover:text-red-500"
            title="删除账户"
          >
            <IconMinus width={16} height={16} />
          </button>
          <div className="flex-1" />
          <button
            onClick={() => selected && void api.syncAccountNow(selected)}
            className="p-2 rounded-lg text-zinc-500 hover:bg-black/5"
            title="立即同步"
          >
            <IconRefresh width={15} height={15} />
          </button>
        </div>
      </div>

      {/* 右侧详情 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {adding && <AddAccount onDone={() => { setAdding(false); reload() }} onCancel={() => setAdding(false)} />}
        {!adding && current && <AccountDetail account={current} onChanged={reload} />}
        {!adding && !current && <div className="text-[13.5px] text-zinc-400 mt-10 text-center">点击 + 添加你的第一个邮箱</div>}
      </div>
    </div>
  )
}

function AccountDetail(props: { account: AccountWithStatus; onChanged(): void }) {
  const { account: a } = props
  const status = STATUS_TEXT[a.status] ?? STATUS_TEXT.disabled
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [reauthorizing, setReauthorizing] = useState(false)

  const update = (patch: Parameters<typeof api.updateAccount>[1]) => {
    void api.updateAccount(a.id, patch).then(props.onChanged)
  }

  const reauthorize = async () => {
    if (reauthorizing) return
    setReauthorizing(true)
    const res = await api.oauthAuthorize(a.provider)
    setReauthorizing(false)
    props.onChanged()
    if (!res.ok) window.alert(res.error ?? '重新授权失败')
  }

  return (
    <div className="max-w-[560px]">
      <div className="flex items-center gap-3 mb-4">
        <span className="w-10 h-10 rounded-full flex items-center justify-center text-white text-[15px] font-medium" style={{ background: a.color }}>
          {a.name[0]?.toUpperCase()}
        </span>
        <div>
          <div className="text-[15px] font-semibold text-zinc-800">{a.name}</div>
          <div className="text-[12.5px] text-zinc-400">{a.email}</div>
        </div>
      </div>

      <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm px-4 py-1">
        <div className="flex items-center gap-4 py-2.5 border-b border-black/[0.04]">
          <span className="flex-1 text-[13.5px] text-zinc-800">启用</span>
          <ToggleMini checked={a.enabled} onChange={v => void api.setAccountEnabled(a.id, v).then(props.onChanged)} />
        </div>
        <div className="flex items-center gap-4 py-2.5 border-b border-black/[0.04]">
          <span className="flex-1 text-[13.5px] text-zinc-800">状态</span>
          <span className={`text-[13px] ${status.cls}`}>{status.label}{a.statusText && a.status === 'error' ? ` · ${a.statusText}` : ''}</span>
        </div>
        <div className="flex items-center gap-4 py-2.5 border-b border-black/[0.04]">
          <span className="flex-1 text-[13.5px] text-zinc-800">名称</span>
          <input
            defaultValue={a.name}
            onBlur={e => e.target.value !== a.name && update({ name: e.target.value })}
            className="text-[13px] text-right bg-transparent outline-none w-48"
          />
        </div>
        <div className="flex items-center gap-4 py-2.5 border-b border-black/[0.04]">
          <span className="flex-1 text-[13.5px] text-zinc-800">颜色</span>
          <div className="flex gap-1.5">
            {ACCOUNT_COLORS.map(c => (
              <button
                key={c}
                onClick={() => update({ color: c })}
                className={`w-5 h-5 rounded-full transition ${a.color === c ? 'ring-2 ring-offset-1 ring-blue-400' : ''}`}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
        {a.authType === 'oauth' ? (
          <div className="flex items-center gap-4 py-2.5">
            <span className="flex-1 text-[13.5px] text-zinc-800">
              OAuth 授权
              <span className="block text-[11.5px] text-zinc-400 mt-0.5">凭据自动管理 · token 临期自动刷新</span>
            </span>
            <button
              onClick={() => void reauthorize()}
              disabled={reauthorizing}
              className="text-[13px] text-blue-600 disabled:opacity-40"
            >
              {reauthorizing ? '等待授权…' : '重新授权'}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-4 py-2.5">
            <span className="flex-1 text-[13.5px] text-zinc-800">
              {showPwd ? '重新输入密码' : '密码'}
              <span className="block text-[11.5px] text-zinc-400 mt-0.5">状态异常时可用此重置凭证</span>
            </span>
            {showPwd ? (
              <span className="flex items-center gap-1.5">
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="授权码 / 应用专用密码"
                  className="text-[13px] bg-zinc-50 rounded-lg px-2.5 py-1.5 outline-none w-52 border border-black/[0.05]"
                />
                <button
                  onClick={() => {
                    if (password) update({ password })
                    setShowPwd(false)
                    setPassword('')
                  }}
                  className="p-1.5 rounded-lg bg-blue-600 text-white"
                >
                  <IconCheck width={13} height={13} />
                </button>
                <button onClick={() => setShowPwd(false)} className="p-1.5 text-zinc-400">
                  <IconClose width={13} height={13} />
                </button>
              </span>
            ) : (
              <button onClick={() => setShowPwd(true)} className="text-[13px] text-blue-600">更新密码</button>
            )}
          </div>
        )}
      </div>

      <SectionTitle>服务器</SectionTitle>
      <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm px-4 py-1 text-[13px]">
        <ServerRow label="IMAP" value={`${a.imap.host}:${a.imap.port} ${a.imap.secure ? 'SSL' : ''}`} />
        <ServerRow label="SMTP" value={`${a.smtp.host}:${a.smtp.port} ${a.smtp.secure ? 'SSL' : ''}`} />
        <ServerRow label="用户名" value={a.user} />
      </div>
    </div>
  )
}

function ServerRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-center py-2.5 border-b border-black/[0.04] last:border-0">
      <span className="w-20 text-zinc-500">{props.label}</span>
      <span className="text-zinc-800 font-mono text-[12.5px]">{props.value}</span>
    </div>
  )
}

function ToggleMini(props: { checked: boolean; onChange(v: boolean): void }) {
  return (
    <button onClick={() => props.onChange(!props.checked)} className={`w-[38px] h-[22px] rounded-full relative transition-colors ${props.checked ? 'bg-blue-600' : 'bg-zinc-300'}`}>
      <span className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-all ${props.checked ? 'left-[18px]' : 'left-[2px]'}`} />
    </button>
  )
}

// ---------- 添加账户 ----------

type OAuthKind = 'oauth-google' | 'oauth-ms' | null

function oauthKindOf(key: ProviderKey): OAuthKind {
  if (key === 'gmail') return 'oauth-google'
  if (key === 'outlook' || key === 'hotmail' || key === 'office365') return 'oauth-ms'
  return null
}

/** 选择页：顶部快速邮箱输入（自动识别服务商）+ 服务商卡片（标注门槛） */
function QuickPick(props: {
  onPick(key: ProviderKey, email: string): void
  onPickKey(key: ProviderKey): void
  onCancel(): void
}) {
  const [quick, setQuick] = useState('')
  const [err, setErr] = useState('')

  const quickGo = () => {
    const mail = quick.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      setErr('请输入完整的邮箱地址')
      return
    }
    const p = presetFor(mail)
    setErr('')
    props.onPick(p.key, mail)
  }

  return (
    <div>
      <SectionTitle>添加邮箱</SectionTitle>

      {/* 快速开始：输入地址直接走 */}
      <div className="max-w-[560px] rounded-2xl bg-white border border-black/[0.06] shadow-sm px-4 py-3 mb-4">
        <div className="text-[13px] text-zinc-700 mb-2">直接输入邮箱地址，自动识别服务商并进入对应流程：</div>
        <div className="flex gap-2">
          <input
            value={quick}
            onChange={e => { setQuick(e.target.value); setErr('') }}
            onKeyDown={e => e.key === 'Enter' && quickGo()}
            placeholder="you@qq.com · you@gmail.com · …"
            className="flex-1 text-[13px] bg-zinc-50 rounded-xl px-3 py-2.5 outline-none border border-black/[0.05] focus:border-blue-400 focus:bg-white transition"
          />
          <button
            onClick={quickGo}
            className="text-[13px] font-medium px-4 py-2 rounded-xl bg-blue-600 text-white shadow-sm hover:bg-blue-700 disabled:opacity-40"
            disabled={!quick.trim()}
          >
            开始添加
          </button>
        </div>
        {err && <div className="mt-2 text-[12.5px] text-red-500">{err}</div>}
      </div>

      <div className="text-[11px] font-semibold tracking-[.08em] uppercase text-zinc-400 mb-2">或选择服务商</div>
      <div className="grid grid-cols-3 gap-2.5 max-w-[560px]">
        {PROVIDER_PRESETS.map(p => {
          const kind = oauthKindOf(p.key)
          return (
            <button
              key={p.key}
              onClick={() => props.onPickKey(p.key)}
              className="relative flex flex-col items-center gap-2 py-4 rounded-2xl bg-white border border-black/[0.06] shadow-sm hover:border-blue-300 transition"
            >
              <span
                className={`absolute top-2 right-2 text-[9.5px] px-1.5 py-px rounded-full font-medium inline-flex items-center gap-0.5 ${
                  kind ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                }`}
              >
                {kind ? (
                  <><IconSparkles width={9} height={9} /> 一键授权</>
                ) : (
                  <><IconKey width={9} height={9} /> 授权码</>
                )}
              </span>
              <span className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[14px] font-medium" style={{ background: p.color }}>
                {p.label[0]}
              </span>
              <span className="text-[13px] text-zinc-700">{p.label}</span>
            </button>
          )
        })}
      </div>
      <button onClick={props.onCancel} className="mt-5 text-[13px] text-zinc-500 hover:underline">取消</button>
    </div>
  )
}

function AddAccount(props: { onDone(): void; onCancel(): void }) {
  const [step, setStep] = useState<'pick' | 'oauth' | 'form'>('pick')
  const [provider, setProvider] = useState<ProviderKey>('gmail')
  const [oauthCfg, setOauthCfg] = useState<OAuthClientConfig>({})
  /** 快速输入识别出的邮箱，透传给后续表单 */
  const [pickEmail, setPickEmail] = useState('')

  useEffect(() => {
    void api.getOAuthClientConfig().then(setOauthCfg)
  }, [])

  const pick = (key: ProviderKey) => {
    setProvider(key)
    const kind = oauthKindOf(key)
    setStep(kind ? 'oauth' : 'form')
  }

  const oauthConfigured =
    oauthKindOf(provider) === 'oauth-google'
      ? !!oauthCfg.google?.clientId && !!oauthCfg.google?.clientSecret
      : oauthKindOf(provider) === 'oauth-ms'
        ? !!oauthCfg.ms?.clientId
        : false

  if (step === 'pick') {
    return (
      <QuickPick
        onPick={(key, email) => {
          setProvider(key)
          setPickEmail(email)
          const kind = oauthKindOf(key)
          setStep(kind ? 'oauth' : 'form')
        }}
        onPickKey={pick}
        onCancel={props.onCancel}
      />
    )
  }

  const preset = PROVIDER_PRESETS.find(x => x.key === provider)!
  const kind = oauthKindOf(provider)

  if (step === 'oauth' && kind) {
    return (
      <OAuthStep
        provider={provider}
        kind={kind}
        configured={oauthConfigured}
        oauthCfg={oauthCfg}
        pickEmail={pickEmail}
        onConfigSaved={setOauthCfg}
        onFallback={() => setStep('form')}
        onBack={() => setStep('pick')}
        onDone={props.onDone}
      />
    )
  }

  return (
    <PasswordForm
      provider={provider}
      preset={preset}
      presetEmail={pickEmail}
      onBack={() => setStep(kind ? 'oauth' : 'pick')}
      onDone={props.onDone}
    />
  )
}

/** OAuth 授权步骤：一键授权弹窗 / 设备码 / 未配置凭据时降级引导 */
function OAuthStep(props: {
  provider: ProviderKey
  kind: Exclude<OAuthKind, null>
  configured: boolean
  oauthCfg: OAuthClientConfig
  pickEmail?: string
  onConfigSaved(cfg: OAuthClientConfig): void
  onFallback(): void
  onBack(): void
  onDone(): void
}) {
  const { provider, kind, configured } = props
  const [phase, setPhase] = useState<'idle' | 'working' | 'device'>('idle')
  const [device, setDevice] = useState<{ userCode: string; verificationUri: string } | null>(null)
  const [error, setError] = useState('')
  const [showCreds, setShowCreds] = useState(false)
  const label = PROVIDER_PRESETS.find(p => p.key === provider)?.label ?? provider

  useMailEvent(ev => {
    const e = ev as { type: string; userCode?: string; verificationUri?: string }
    if (e.type === 'oauth-device' && e.userCode && e.verificationUri) {
      setDevice({ userCode: e.userCode, verificationUri: e.verificationUri })
      setPhase('device')
    }
  })

  const start = async () => {
    setPhase('working')
    setError('')
    setDevice(null)
    const res = await api.oauthAuthorize(provider)
    if (res.ok) {
      props.onDone()
    } else {
      setError(res.error ?? '授权失败')
      setPhase('idle')
      setDevice(null)
    }
  }

  return (
    <div className="max-w-[520px]">
      <SectionTitle>添加 {label}</SectionTitle>
      {phase === 'device' && device ? (
        <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm p-5">
          <div className="text-[13.5px] text-zinc-700 mb-1">1. 在浏览器中打开微软登录页并输入以下代码：</div>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-[26px] font-bold tracking-[.2em] text-zinc-900 font-mono select-all">{device.userCode}</span>
            <button
              onClick={() => void navigator.clipboard.writeText(device.userCode)}
              className="text-[12px] px-2 py-1 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            >
              复制代码
            </button>
          </div>
          <div className="text-[13.5px] text-zinc-700 mb-3">2. 登录你的 {label} 账户并确认授权：</div>
          <button
            onClick={() => void api.openExternal(device.verificationUri)}
            className="text-[13px] px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700"
          >
            打开 {device.verificationUri}
          </button>
          <div className="mt-4 flex items-center gap-2 text-[12.5px] text-zinc-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
            等待你在浏览器中完成授权…
          </div>
          <button onClick={props.onBack} className="mt-4 block text-[13px] text-zinc-500 hover:underline">取消</button>
        </div>
      ) : (
        <>
          <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm p-5">
            {props.pickEmail && (
              <div className="mb-3 inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200/60">
                <IconCheck width={11} height={11} /> {props.pickEmail}
              </div>
            )}
            <p className="text-[13.5px] text-zinc-700 leading-relaxed mb-4">
              点击下方按钮，将在浏览器打开 {kind === 'oauth-google' ? 'Google' : 'Microsoft'} 授权页面，确认后自动完成添加——无需手动输入密码。
            </p>
            <button
              onClick={() => void start()}
              disabled={phase === 'working' || !configured}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-[14px] font-semibold text-white shadow-sm disabled:opacity-40 transition active:scale-[.99]"
              style={{ background: kind === 'oauth-google' ? '#22c55e' : '#0ea5e9' }}
            >
              {phase === 'working' ? '等待授权完成…' : `使用 ${label} 账号授权登录`}
            </button>
            {!configured && (
              <div className="mt-3 text-[12.5px] text-amber-700 bg-amber-50 border border-amber-200/60 rounded-xl px-3.5 py-2.5">
                尚未配置 {kind === 'oauth-google' ? 'Google' : 'Microsoft'} OAuth 应用凭据。可在下方填入凭据启用一键授权，或改用应用专用密码手动添加。
              </div>
            )}
            {error && <div className="mt-3 text-[13px] text-red-500">{error}</div>}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button onClick={() => setShowCreds(s => !s)} className="text-[12.5px] text-zinc-500 hover:text-zinc-700">
              {showCreds ? '收起 OAuth 应用凭据' : '高级：配置 OAuth 应用凭据 ▾'}
            </button>
            <div className="flex-1" />
            <button onClick={props.onFallback} className="text-[12.5px] text-zinc-500 hover:text-zinc-700">
              改用应用专用密码添加
            </button>
          </div>

          {showCreds && <OAuthCredsForm cfg={props.oauthCfg} kind={kind} onSaved={props.onConfigSaved} />}

          <button onClick={props.onBack} className="mt-4 text-[13px] text-zinc-500 hover:underline">返回选择服务商</button>
        </>
      )}
    </div>
  )
}

function OAuthCredsForm(props: { cfg: OAuthClientConfig; kind: Exclude<OAuthKind, null>; onSaved(cfg: OAuthClientConfig): void }) {
  const g = props.cfg.google ?? { clientId: '', clientSecret: '' }
  const m = props.cfg.ms ?? { clientId: '' }
  const [gId, setGId] = useState(g.clientId)
  const [gSecret, setGSecret] = useState(g.clientSecret)
  const [mId, setMId] = useState(m.clientId)
  const [saved, setSaved] = useState(false)

  const save = async () => {
    const next: OAuthClientConfig = {
      google: { clientId: gId.trim(), clientSecret: gSecret.trim() },
      ms: { clientId: mId.trim() }
    }
    await api.setOAuthClientConfig(next)
    props.onSaved(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }

  return (
    <div className="mt-2 rounded-2xl bg-white border border-black/[0.06] shadow-sm px-4 py-1">
      <p className="text-[11.5px] text-zinc-400 leading-relaxed py-2">
        凭据只保存在本机（加密）。{props.kind === 'oauth-google'
          ? 'Google Cloud Console → 创建 OAuth 客户端（桌面应用）→ 启用 IMAP scope（https://mail.google.com/）。'
          : 'Azure 门户 → 应用注册（公共客户端）→ 添加 IMAP.AccessAsUser.All 与 SMTP.Send 委托权限。'}
      </p>
      {props.kind === 'oauth-google' && (
        <>
          <Field label="Google Client ID" value={gId} onChange={setGId} placeholder="xxxx.apps.googleusercontent.com" />
          <Field label="Google Client Secret" value={gSecret} onChange={setGSecret} type="password" placeholder="GOCSPX-…" />
        </>
      )}
      {props.kind === 'oauth-ms' && (
        <Field label="Azure Client ID" value={mId} onChange={setMId} placeholder="Application (client) ID" />
      )}
      <div className="py-2.5 flex justify-end">
        {saved && <span className="text-[12px] text-green-600 mr-2">已保存</span>}
        <button onClick={() => void save()} className="text-[12.5px] px-3 py-1.5 rounded-lg bg-zinc-800 text-white hover:bg-zinc-700">
          保存凭据
        </button>
      </div>
    </div>
  )
}

function PasswordForm(props: {
  provider: ProviderKey
  preset: (typeof PROVIDER_PRESETS)[number]
  presetEmail?: string
  onBack(): void
  onDone(): void
}) {
  const { preset } = props
  const [email, setEmail] = useState(props.presetEmail ?? '')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [imap, setImap] = useState(preset.imap ?? { host: '', port: 993, secure: true })
  const [smtp, setSmtp] = useState(preset.smtp ?? { host: '', port: 465, secure: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(!preset.imap)

  const detectPreset = (mail: string) => {
    setEmail(mail)
    const p = PROVIDER_PRESETS.find(x => x.key !== 'custom' && x.domains.includes(mail.split('@')[1]?.toLowerCase() ?? ''))
    if (p) {
      if (p.imap) setImap(p.imap)
      if (p.smtp) setSmtp(p.smtp)
      if (!name) setName(`${p.label}`)
    }
  }

  // 粘贴智能识别：根据格式动态提示（QQ/163 的 16 位授权码、Apple 的分组密码等）
  const pasteFeedback = (() => {
    const v = password.trim()
    if (!v) return null
    if (/^[A-Za-z0-9]{16}$/.test(v)) {
      return { ok: true, text: '检测到 16 位授权码格式 ✓（QQ / 网易 / Yahoo 常见格式）' }
    }
    if (/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/.test(v)) {
      return { ok: true, text: '检测到 Apple App 专用密码格式 ✓' }
    }
    if (preset.codeHint && v.length < 6) {
      return { ok: false, text: `长度偏短：${preset.label}的${preset.passwordLabel ?? '授权码'}通常为${preset.codeHint}` }
    }
    if (/^[\u4e00-\u9fa5]/.test(v)) {
      return { ok: false, text: '粘贴内容包含中文，请确认复制的是纯授权码（不是短信验证码文字）' }
    }
    return null
  })()

  const submit = async () => {
    setBusy(true)
    setError('')
    const draft: AccountDraft = {
      provider: props.provider,
      name: name || email,
      email,
      color: '#3b82f6',
      imap,
      smtp,
      user: email,
      password,
      authType: 'password'
    }
    const res = await api.addAccount(draft)
    setBusy(false)
    if (res.ok) props.onDone()
    else setError(res.error ?? '添加失败')
  }

  return (
    <div className="max-w-[520px]">
      <SectionTitle>添加 {preset.label}</SectionTitle>

      {/* 分步教学：应用内直达，降低授权码获取门槛 */}
      {preset.steps && preset.steps.length > 0 && (
        <div className="mb-4 rounded-2xl bg-amber-50 border border-amber-200/60 px-4 py-3.5">
          <div className="text-[12.5px] font-semibold text-amber-800 mb-2">
            获取{preset.passwordLabel ?? '授权码'}的 {preset.steps.length} 个步骤：
          </div>
          <ol className="space-y-1.5">
            {preset.steps.map((s, i) => (
              <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-amber-800">
                <span className="shrink-0 w-[18px] h-[18px] rounded-full bg-amber-200 text-amber-900 text-[10.5px] font-semibold flex items-center justify-center mt-0.5">
                  {i + 1}
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
          {preset.guideLinks && preset.guideLinks.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {preset.guideLinks.map(l => (
                <button
                  key={l.url}
                  onClick={() => void api.openExternal(l.url)}
                  className="text-[11.5px] px-2.5 py-1 rounded-full bg-white border border-amber-300 text-amber-800 hover:bg-amber-100 transition"
                >
                  {l.label} ↗
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {!preset.steps && preset.hint && (
        <div className="mb-3 text-[12.5px] leading-relaxed text-amber-700 bg-amber-50 border border-amber-200/60 rounded-xl px-3.5 py-2.5">
          {preset.hint}
          {preset.guideUrl && (
            <button onClick={() => preset.guideUrl && void api.openExternal(preset.guideUrl)} className="ml-2 underline hover:no-underline">
              打开官方设置页 →
            </button>
          )}
        </div>
      )}

      <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm px-4 py-1">
        <Field label="邮箱地址" value={email} onChange={v => detectPreset(v)} placeholder="you@example.com" />
        <Field
          label={preset.passwordLabel ?? '密码 / 授权码'}
          value={password}
          onChange={setPassword}
          type="password"
          placeholder={preset.passwordPlaceholder ?? '应用专用密码或授权码'}
        />
        {pasteFeedback && (
          <div className={`flex items-center gap-1.5 pb-2.5 -mt-1 text-[12px] ${pasteFeedback.ok ? 'text-green-600' : 'text-amber-600'}`}>
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: pasteFeedback.ok ? '#16a34a' : '#d97706' }} />
            {pasteFeedback.text}
          </div>
        )}
        <Field label="显示名称" value={name} onChange={setName} placeholder="如 Seven Gmail" />
        <button
          onClick={() => setShowAdvanced(s => !s)}
          className="w-full flex items-center justify-between py-2.5 border-b border-black/[0.04] text-[13px] text-zinc-500 hover:text-zinc-700"
        >
          服务器设置{preset.imap ? '（已按官方推荐预填）' : ''}
          <span>{showAdvanced ? '▴' : '▾'}</span>
        </button>
        {showAdvanced && (
          <>
            <Field label="IMAP 服务器" value={imap.host} onChange={v => setImap({ ...imap, host: v })} />
            <Field label="IMAP 端口" value={String(imap.port)} onChange={v => setImap({ ...imap, port: Number(v) || 993 })} />
            <Field label="SMTP 服务器" value={smtp.host} onChange={v => setSmtp({ ...smtp, host: v })} />
            <Field label="SMTP 端口" value={String(smtp.port)} onChange={v => setSmtp({ ...smtp, port: Number(v) || 465 })} />
          </>
        )}
      </div>
      {error && <div className="mt-3 text-[13px] text-red-500">{error}</div>}
      <div className="mt-4 flex gap-2">
        <button onClick={props.onBack} className="text-[13px] px-3.5 py-2 rounded-xl text-zinc-500 hover:bg-black/5">返回</button>
        <div className="flex-1" />
        <button
          onClick={submit}
          disabled={busy || !email || !password}
          className="text-[13px] font-medium px-5 py-2 rounded-xl bg-blue-600 text-white shadow-sm hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? '验证并添加中…' : '验证并添加'}
        </button>
      </div>
    </div>
  )
}

function Field(props: { label: string; value: string; onChange(v: string): void; type?: string; placeholder?: string }) {
  return (
    <div className="flex items-center gap-4 py-2.5 border-b border-black/[0.04] last:border-0">
      <span className="w-32 text-[13.5px] text-zinc-700 shrink-0">{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        onChange={e => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        className="flex-1 text-[13px] bg-zinc-50 rounded-lg px-2.5 py-1.5 outline-none border border-black/[0.05]"
      />
    </div>
  )
}