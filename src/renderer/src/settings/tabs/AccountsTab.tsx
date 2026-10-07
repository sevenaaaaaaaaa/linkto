import { useEffect, useState } from 'react'
import { api, useMailEvent } from '../../lib/api'
import { IconPlus, IconMinus, IconRefresh, IconCheck, IconClose } from '../../components/icons'
import { SectionTitle } from './GeneralTab'
import { PROVIDER_PRESETS } from '@shared/presets'
import { ACCOUNT_COLORS } from '@shared/presets'
import type { AccountDraft, AccountWithStatus, ProviderKey } from '@shared/types'

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

  const update = (patch: Parameters<typeof api.updateAccount>[1]) => {
    void api.updateAccount(a.id, patch).then(props.onChanged)
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

function AddAccount(props: { onDone(): void; onCancel(): void }) {
  const [step, setStep] = useState<'pick' | 'form'>('pick')
  const [provider, setProvider] = useState<ProviderKey>('gmail')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [imap, setImap] = useState({ host: '', port: 993, secure: true })
  const [smtp, setSmtp] = useState({ host: '', port: 465, secure: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const applyPreset = (key: ProviderKey) => {
    setProvider(key)
    const p = PROVIDER_PRESETS.find(x => x.key === key)!
    if (p.imap) setImap(p.imap)
    if (p.smtp) setSmtp(p.smtp)
    setStep('form')
  }

  const detectPreset = (mail: string) => {
    setEmail(mail)
    const p = PROVIDER_PRESETS.find(x => x.key !== 'custom' && x.domains.includes(mail.split('@')[1]?.toLowerCase() ?? ''))
    if (p) {
      setProvider(p.key)
      if (p.imap) setImap(p.imap)
      if (p.smtp) setSmtp(p.smtp)
      if (!name) setName(`${p.label}`)
    }
  }

  const submit = async () => {
    setBusy(true)
    setError('')
    const draft: AccountDraft = {
      provider,
      name: name || email,
      email,
      color: '#3b82f6',
      imap,
      smtp,
      user: email,
      password
    }
    const res = await api.addAccount(draft)
    setBusy(false)
    if (res.ok) props.onDone()
    else setError(res.error ?? '添加失败')
  }

  if (step === 'pick') {
    return (
      <div>
        <SectionTitle>选择邮件服务商</SectionTitle>
        <div className="grid grid-cols-3 gap-2.5 max-w-[560px]">
          {PROVIDER_PRESETS.map(p => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              className="flex flex-col items-center gap-2 py-4 rounded-2xl bg-white border border-black/[0.06] shadow-sm hover:border-blue-300 transition"
            >
              <span className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[14px] font-medium" style={{ background: p.color }}>
                {p.label[0]}
              </span>
              <span className="text-[13px] text-zinc-700">{p.label}</span>
            </button>
          ))}
        </div>
        <button onClick={props.onCancel} className="mt-5 text-[13px] text-zinc-500 hover:underline">取消</button>
      </div>
    )
  }

  const preset = PROVIDER_PRESETS.find(x => x.key === provider)!
  return (
    <div className="max-w-[520px]">
      <SectionTitle>添加 {preset.label}</SectionTitle>
      {preset.hint && (
        <div className="mb-3 text-[12.5px] leading-relaxed text-amber-700 bg-amber-50 border border-amber-200/60 rounded-xl px-3.5 py-2.5">
          {preset.hint}
        </div>
      )}
      <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm px-4 py-1">
        <Field label="邮箱地址" value={email} onChange={v => detectPreset(v)} placeholder="you@example.com" />
        <Field label="密码 / 授权码" value={password} onChange={setPassword} type="password" placeholder="应用专用密码或授权码" />
        <Field label="显示名称" value={name} onChange={setName} placeholder="如 Seven Gmail" />
        <Field label="IMAP 服务器" value={imap.host} onChange={v => setImap({ ...imap, host: v })} />
        <Field label="IMAP 端口" value={String(imap.port)} onChange={v => setImap({ ...imap, port: Number(v) || 993 })} />
        <Field label="SMTP 服务器" value={smtp.host} onChange={v => setSmtp({ ...smtp, host: v })} />
        <Field label="SMTP 端口" value={String(smtp.port)} onChange={v => setSmtp({ ...smtp, port: Number(v) || 465 })} />
      </div>
      {error && <div className="mt-3 text-[13px] text-red-500">{error}</div>}
      <div className="mt-4 flex gap-2">
        <button onClick={() => setStep('pick')} className="text-[13px] px-3.5 py-2 rounded-xl text-zinc-500 hover:bg-black/5">返回</button>
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
