import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import type { AccountWithStatus } from '@shared/types'
import {
  DEVSYNC_CATEGORIES,
  type BackupxAutoSettings,
  type BackupxHeader,
  type BackupxRestoreResult,
  type DevSyncCategory,
  type DevSyncStatus
} from '@shared/devsync'
import { SectionTitle, SettingRow, Toggle, Select } from './GeneralTab'
import { takeSyncPair } from '../account-focus'

type Target = { id: string; label: string; path: string; available: boolean; hint?: string; downloadUrl?: string }

const fmt = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

/** 同步范围的三个快捷预设：推荐 = 默认；只账户 = 只带账户与凭据；全部 = 含 Agent 对话、API Key、Webhook */
function presetCategories(mode: 'recommended' | 'accounts' | 'all'): Partial<Record<DevSyncCategory, boolean>> {
  const out: Partial<Record<DevSyncCategory, boolean>> = {}
  for (const c of DEVSYNC_CATEGORIES) {
    out[c.id] = mode === 'all' ? true : mode === 'accounts' ? c.id === 'accounts' : c.parent ? false : c.defaultOn
  }
  return out
}

/** 本机专用邮箱（Proton Bridge / 本机服务）：不能作为跨设备同步邮箱，也不能生成配对 */
function isLocalOnly(a: AccountWithStatus): boolean {
  const local = (h?: string) => {
    const s = String(h ?? '').toLowerCase().replace(/^\[|\]$/g, '')
    return s === 'localhost' || s.endsWith('.localhost') || s === '::1' || /^127\./.test(s)
  }
  return a.provider === 'proton' || local(a.imap?.host) || local(a.smtp?.host)
}

const inputCls = 'no-drag flex-1 min-w-0 text-sm bg-hover rounded-lg px-2.5 py-1.5 outline-none border border-line text-ink'
const ghostBtn = 'no-drag shrink-0 text-xs px-3 py-1.5 rounded-lg border border-line text-ink-2 hover:bg-hover disabled:opacity-40'
const primaryBtn = 'no-drag shrink-0 text-xs font-medium px-3.5 py-1.5 rounded-lg bg-ink text-app hover:bg-ink/85 disabled:opacity-40'
const card = 'rounded-2xl bg-panel border border-line px-4'

/** 设置 → 同步与备份：跨设备同步（账户与凭据 + Agent 与各中心数据）+ 加密备份与恢复 */
export function SyncBackupTab() {
  return (
    <div className="max-w-[680px]">
      <DevSyncSection />
      <BackupSection />
    </div>
  )
}

// ================================================================ 跨设备同步

function DevSyncSection() {
  const [st, setSt] = useState<DevSyncStatus | null>(null)
  const [accounts, setAccounts] = useState<AccountWithStatus[]>([])
  const [accountId, setAccountId] = useState('')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [showGuide, setShowGuide] = useState(false)
  /** 从「还没有账户 → 从另一台电脑快速开始」或 linkto://pair 进来：直接展开导入 */
  const [pairIntent, setPairIntent] = useState(false)

  useEffect(() => {
    void Promise.all([api.devsyncStatus(), api.listAccounts()]).then(([s, list]) => {
      setSt(s)
      setAccounts(list)
      setAccountId(s.accountId ?? list.find(a => a.enabled)?.id ?? list[0]?.id ?? '')
      setDeviceName(s.deviceName)
      setShowGuide(!s.enabled)
    })
    return api.onEvent(ev => {
      const e = ev as { type?: string; status?: DevSyncStatus }
      if (e.type === 'devsync-status' && e.status) setSt(e.status)
      if (e.type === 'accounts-changed' || e.type === 'account-status') {
        void api.listAccounts().then(setAccounts)
        void api.devsyncStatus().then(setSt)
      }
      if (e.type === 'todo-sync-status' || e.type === 'trace-sync-status') void api.devsyncStatus().then(setSt)
    })
  }, [])

  // 从主窗口「从另一台电脑快速开始」/ linkto://pair 进入：展开导入表单
  useEffect(() => {
    const open = () => setPairIntent(true)
    window.addEventListener('ms:settings-pair', open)
    if (takeSyncPair() || location.hash.endsWith(':pair')) setPairIntent(true)
    return () => window.removeEventListener('ms:settings-pair', open)
  }, [])

  if (!st) return null
  const running = busy || st.running

  const configure = async (input: { enabled: boolean; categories?: Partial<Record<DevSyncCategory, boolean>>; withPass?: boolean; accountId?: string }) => {
    if (busy) return false
    if (input.withPass) {
      if (pass.length < 6) return setMsg({ text: '同步口令至少 6 位', ok: false }), false
      if (pass !== pass2) return setMsg({ text: '两次输入的口令不一致', ok: false }), false
    }
    setBusy(true)
    setMsg(null)
    const res = await api.devsyncConfigure({
      enabled: input.enabled,
      accountId: (input.accountId ?? accountId) || null,
      passphrase: input.withPass ? pass : undefined,
      deviceName: deviceName.trim() || undefined,
      categories: input.categories
    })
    setBusy(false)
    setSt(res.status)
    if (!res.ok) setMsg({ text: res.error ?? '保存失败', ok: false })
    else if (input.withPass) {
      setPass('')
      setPass2('')
      setMsg({ text: '口令已保存', ok: true })
    }
    return res.ok
  }

  const toggleEnabled = async (v: boolean) => {
    if (v && !st.hasPassphrase && !pass) return setMsg({ text: '请先在下方设置同步口令（所有设备用同一个）', ok: false })
    await configure({ enabled: v, withPass: v && !!pass, categories: st.categories })
  }

  const setCat = (id: DevSyncCategory, v: boolean) => void configure({ enabled: st.enabled, categories: { ...st.categories, [id]: v } })

  /** 生成一个 20 位强口令并复制：避免每台设备都手输弱口令 */
  const genPassphrase = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const bytes = new Uint8Array(20)
    crypto.getRandomValues(bytes)
    const p = Array.from(bytes, b => alphabet[b % alphabet.length])
      .join('')
      .replace(/(.{4})/g, '$1-')
      .replace(/-$/, '')
    setPass(p)
    setPass2(p)
    void navigator.clipboard.writeText(p)
    setMsg({ text: '已生成并复制 20 位口令，请存入密码管理器', ok: true })
  }

  const syncNow = async () => {
    if (busy) return
    setBusy(true)
    setMsg(null)
    setSt(await api.devsyncNow())
    setBusy(false)
  }

  const account = accounts.find(a => a.id === (st.accountId ?? accountId))
  const top = DEVSYNC_CATEGORIES.filter(c => !c.parent)

  return (
    <div>
      <SectionTitle>跨设备同步</SectionTitle>
      <p className="text-xs leading-relaxed mb-2 text-ink-3">
        账户（含密码与授权令牌）、Agent 记忆、知识库、技能和各中心的数据，以加密邮件的形式存放在你自己邮箱的隐藏文件夹（{st.folder}）里，
        不经过任何第三方服务器。每台电脑选同一个邮箱、填同一个口令，就会自动合并：以最后一次修改为准，删除也会同步。
      </p>

      <PairingPanel st={st} accounts={accounts} intent={pairIntent} onStatus={setSt} />

      {st.pendingDeletes.length > 0 && (
        <div role="alert" className="mb-3 rounded-2xl border px-4 py-3 text-xs leading-relaxed" style={{ background: 'var(--warn-soft)', borderColor: 'var(--border)', color: 'var(--warn-ink)' }}>
          {st.pendingDeletes.map(p => (
            <div key={p.key} className="flex items-center gap-3 py-1">
              <span className="flex-1 min-w-0">
                {p.device ? `「${p.device}」` : '另一台设备'}删除了账户 <b>{p.email}</b>。这台电脑上还保留着，要一起删除吗？
              </span>
              <button className={ghostBtn} onClick={() => void api.devsyncResolveDelete(p.key, 'keep').then(setSt)}>
                本机保留
              </button>
              <button
                className="no-drag shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg text-on-accent"
                style={{ background: 'var(--danger)' }}
                onClick={() => void api.devsyncResolveDelete(p.key, 'delete').then(setSt)}
              >
                也在本机删除
              </button>
            </div>
          ))}
        </div>
      )}

      {st.accountIssues.length > 0 && <AccountIssues st={st} onChanged={() => void api.devsyncStatus().then(setSt)} />}

      <div className={card}>
        <SettingRow label="开启跨设备同步" desc="开启后每 5 分钟同步一次，本机改动约 1 分钟内推送">
          <Toggle checked={st.enabled} onChange={v => void toggleEnabled(v)} />
        </SettingRow>
        <SettingRow label="同步邮箱" desc="所有设备都要选同一个邮箱账户（与待办同步共用）">
          {accounts.length ? (
            <Select
              value={st.accountId ?? accountId}
              onChange={v => {
                setAccountId(v)
                void configure({ enabled: st.enabled, accountId: v })
              }}
              options={accounts.map(a => ({ value: a.id, label: a.email || a.name }))}
            />
          ) : (
            <span className="text-xs text-ink-3">请先添加一个邮箱账户</span>
          )}
        </SettingRow>
        <div className="py-3 border-b border-[var(--border-soft)]">
          <div className="flex items-baseline gap-2">
            <span className="text-sm text-ink">同步口令</span>
            <span className="text-2xs text-ink-3">{st.hasPassphrase ? '本机已保存 · 输入新口令可替换' : '尚未设置'}</span>
          </div>
          <div className="text-xs mt-0.5 leading-relaxed text-ink-3">
            每台设备都输入同一个口令（与待办同步共用一个口令，不用设两个）。口令只保存在本机钥匙串里，不会上传；口令不一致时这台设备读不了同步数据，会在下方提示。
          </div>
          <div className="flex items-center gap-2 mt-2">
            <input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="至少 6 位" autoComplete="new-password" className={inputCls} />
            <input type="password" value={pass2} onChange={e => setPass2(e.target.value)} placeholder="再次输入" autoComplete="new-password" className={inputCls} />
            <button onClick={() => void configure({ enabled: st.enabled, withPass: true })} disabled={!pass || busy} className={ghostBtn}>
              保存口令
            </button>
          </div>
          <div className="mt-1.5 text-2xs text-ink-3">
            <button onClick={genPassphrase} className="hover:underline" style={{ color: 'var(--accent-ink)' }}>
              生成一个强口令并复制
            </button>
            <span className="ml-1.5">· 配对到另一台电脑时不用再手输</span>
          </div>
        </div>
        <SettingRow label="本机名称" desc="在其他设备的「已知设备」和活动记录里显示">
          <input
            value={deviceName}
            onChange={e => setDeviceName(e.target.value)}
            onBlur={() => deviceName.trim() && deviceName.trim() !== st.deviceName && void configure({ enabled: st.enabled })}
            className="no-drag w-44 text-sm text-right bg-transparent outline-none text-ink"
            aria-label="本机名称"
          />
        </SettingRow>
        <div className="flex items-center gap-4 py-3">
          <div className="flex-1 min-w-0 text-xs leading-relaxed">
            {!st.enabled ? (
              <span className="text-ink-3">未开启</span>
            ) : running ? (
              <span className="text-ink-2">同步中…</span>
            ) : st.lastSyncAt ? (
              <span className="text-ink-2">
                上次同步 {fmt(st.lastSyncAt)}
                {account ? ` · ${account.email}` : ''}
                {st.lastStats && (st.lastStats.pulled || st.lastStats.pushed) ? ` · 收到 ${st.lastStats.pulled} 条、发出 ${st.lastStats.pushed} 条` : ' · 已是最新'}
                {st.lastStats?.conflicts ? ` · ${st.lastStats.conflicts} 条冲突已按最后修改合并` : ''}
                {st.lastStats?.oversize ? ` · ${st.lastStats.oversize} 条过大未同步` : ''}
              </span>
            ) : (
              <span className="text-ink-3">尚未同步</span>
            )}
            {st.enabled && st.lastError && (
              <div role="alert" className="mt-1" style={{ color: 'var(--danger-ink)' }}>
                {st.lastError}
              </div>
            )}
            {msg && (
              <div className="mt-1" style={{ color: msg.ok ? 'var(--ok-ink)' : 'var(--danger-ink)' }}>
                {msg.text}
              </div>
            )}
          </div>
          <button onClick={() => void syncNow()} disabled={!st.enabled || running} className={primaryBtn}>
            {running ? '同步中…' : '立即同步'}
          </button>
        </div>
      </div>

      <SectionTitle>同步哪些内容</SectionTitle>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-2xs text-ink-3">快速选择</span>
        <button onClick={() => void configure({ enabled: st.enabled, categories: presetCategories('recommended') })} className={ghostBtn}>
          推荐
        </button>
        <button onClick={() => void configure({ enabled: st.enabled, categories: presetCategories('accounts') })} className={ghostBtn}>
          只账户
        </button>
        <button onClick={() => void configure({ enabled: st.enabled, categories: presetCategories('all') })} className={ghostBtn}>
          全部（含密钥）
        </button>
        <span className="ml-auto text-2xs text-ink-3">已开启 {top.filter(c => st.categories[c.id]).length} 类</span>
      </div>
      <div className={`${card} py-1`}>
        {top.map(c => {
          const subs = DEVSYNC_CATEGORIES.filter(x => x.parent === c.id)
          const on = !!st.categories[c.id]
          const count = st.counts[c.id]
          return (
            <div key={c.id} className="py-2.5 border-b border-[var(--border-soft)] last:border-0">
              <div className="flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ink">
                    {c.label}
                    {typeof count === 'number' && count > 0 && <span className="ml-2 text-2xs text-ink-3">本机 {count} 条</span>}
                    {c.secrets && (
                      <span className="ml-2 text-2xs px-1.5 py-0.5 rounded" style={{ background: 'var(--info-soft)', color: 'var(--info-ink)' }}>
                        含凭据 · 加密
                      </span>
                    )}
                  </div>
                  <div className="text-xs mt-0.5 leading-relaxed text-ink-3">{c.desc}</div>
                  {c.id === 'todo' && st.legacy.todo.lastError && on && <div className="text-xs mt-0.5" style={{ color: 'var(--danger-ink)' }}>{st.legacy.todo.lastError}</div>}
                  {c.id === 'trace' && st.legacy.trace.lastError && on && <div className="text-xs mt-0.5" style={{ color: 'var(--danger-ink)' }}>{st.legacy.trace.lastError}</div>}
                </div>
                <Toggle checked={on} onChange={v => setCat(c.id, v)} />
              </div>
              {subs.map(s => (
                <div key={s.id} className={`mt-2 ml-4 pl-3 border-l border-line flex items-start gap-4 ${on ? '' : 'opacity-50'}`}>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-ink">{s.label}</div>
                    <div className="text-xs mt-0.5 leading-relaxed text-ink-3">{s.desc}</div>
                    {s.risk && (
                      <div className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--warn-ink)' }}>
                        {s.risk}
                      </div>
                    )}
                  </div>
                  <Toggle checked={!!st.categories[s.id]} onChange={v => on && setCat(s.id, v)} />
                </div>
              ))}
            </div>
          )
        })}
      </div>

      <SectionTitle>已知设备</SectionTitle>
      <div className={`${card} py-1`}>
        {st.devices.length ? (
          st.devices.map(d => (
            <div key={d.id} className="flex items-center gap-3 py-2.5 border-b border-[var(--border-soft)] last:border-0">
              <span className="flex-1 min-w-0 text-sm text-ink truncate">
                {d.name}
                {d.self && <span className="ml-2 text-2xs px-1.5 py-0.5 rounded bg-hover text-ink-2">本机</span>}
              </span>
              <span className="text-xs text-ink-3">{d.platform === 'darwin' ? 'macOS' : d.platform === 'win32' ? 'Windows' : d.platform}</span>
              <span className="text-xs text-ink-3 w-44 text-right whitespace-nowrap">最近同步 {fmt(d.lastSyncAt)}</span>
            </div>
          ))
        ) : (
          <div className="py-3 text-xs text-ink-3">开启同步后，这里会列出用同一口令同步的所有设备。</div>
        )}
      </div>

      <SectionTitle>
        <button className="no-drag" onClick={() => setShowGuide(v => !v)}>
          在另一台电脑上开始同步 {showGuide ? '▾' : '▸'}
        </button>
      </SectionTitle>
      {showGuide && (
        <ol className={`${card} py-3 text-xs leading-relaxed text-ink-2 list-none flex flex-col gap-2`}>
          <li>
            <b className="text-ink">1. 先添加一个账户。</b> 在新电脑上安装 LinkTo，手动添加上面选的同步邮箱（{account?.email ?? '同一个邮箱'}）；或者用备份文件恢复（见下方）。
          </li>
          <li>
            <b className="text-ink">2. 开启同步并输入同一个口令。</b> 打开「设置 → 同步与备份」，选这个邮箱、填与这台电脑相同的口令，打开「开启跨设备同步」。
          </li>
          <li>
            <b className="text-ink">3. 其余账户自动出现。</b> 配置和密码 / 授权令牌会自动写入并立即测试连接：能连上的直接可用；连不上的会标出原因（如「密码已在另一台设备修改」「需要重新授权」）。
            Proton Bridge 等本机服务的账户只同步配置，需要在新电脑上填写本机 Bridge 显示的密码。
          </li>
        </ol>
      )}
    </div>
  )
}

/** 设备配对：旧电脑生成「链接 + 配对码」，新电脑粘贴导入，自动添加同步邮箱并开启同步 */
function PairingPanel(props: {
  st: DevSyncStatus
  accounts: AccountWithStatus[]
  intent: boolean
  onStatus(s: DevSyncStatus): void
}) {
  const [offer, setOffer] = useState<{ link: string; pin: string; expiresAt: number; email: string } | null>(null)
  const [genBusy, setGenBusy] = useState(false)
  const [genMsg, setGenMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [copied, setCopied] = useState<'link' | 'pin' | null>(null)
  const [now, setNow] = useState(Date.now())
  const [importOpen, setImportOpen] = useState(props.intent || !props.st.enabled)
  const [link, setLink] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  const syncAccount = props.accounts.find(a => a.id === props.st.accountId)
  const localOnly = !!syncAccount && isLocalOnly(syncAccount)
  const canGenerate = props.st.enabled && props.st.hasPassphrase && !!syncAccount && !localOnly

  useEffect(() => {
    if (props.intent) setImportOpen(true)
  }, [props.intent])

  useEffect(() => {
    if (!offer) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [offer])

  useEffect(() => {
    if (offer && now > offer.expiresAt) {
      setOffer(null)
      setGenMsg({ text: '配对链接已过期，请重新生成', ok: false })
    }
  }, [now, offer])

  const generate = async () => {
    if (genBusy) return
    setGenBusy(true)
    setGenMsg(null)
    const r = await api.devsyncCreatePairing()
    setGenBusy(false)
    if (!r.ok || !r.link || !r.pin || !r.expiresAt) {
      setGenMsg({ text: r.error ?? '生成失败', ok: false })
      return
    }
    setOffer({ link: r.link, pin: r.pin, expiresAt: r.expiresAt, email: r.email ?? '' })
    setNow(Date.now())
  }

  const copy = (kind: 'link' | 'pin') => {
    if (!offer) return
    void navigator.clipboard.writeText(kind === 'link' ? offer.link : offer.pin)
    setCopied(kind)
    window.setTimeout(() => setCopied(null), 1600)
  }

  const importNow = async () => {
    if (busy || !link.trim() || !pin.trim()) return
    setBusy(true)
    setMsg(null)
    const r = await api.devsyncImportPairing(link.trim(), pin.trim())
    setBusy(false)
    props.onStatus(r.status)
    if (!r.ok) {
      setMsg({ text: r.error ?? '导入失败', ok: false })
      return
    }
    setLink('')
    setPin('')
    const from = r.fromDevice ? `（来自「${r.fromDevice}」）` : ''
    setMsg({
      ok: true,
      text: r.pending
        ? `已导入同步邮箱 ${r.email}${from}，正在建立连接；连上后会自动取回其余账户与数据。`
        : `已导入同步邮箱 ${r.email}${from}，正在取回其余账户与数据…`
    })
  }

  const remain = offer ? Math.max(0, Math.ceil((offer.expiresAt - now) / 1000)) : 0
  const mm = String(Math.floor(remain / 60)).padStart(2, '0')
  const ss = String(remain % 60).padStart(2, '0')

  return (
    <div className={`${card} mb-4 py-3`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-ink">换新电脑？不用再手动加邮箱</div>
          <div className="text-xs leading-relaxed text-ink-3 mt-0.5">
            {props.st.enabled
              ? '在这台电脑生成一次配对链接与配对码。新电脑粘贴后会自动添加同步邮箱、开启同步，并把其余账户、记忆与各中心数据取回来。'
              : '如果这是新电脑，先在已经同步的那台电脑上生成配对链接，然后在这里粘贴导入——不用手动添加邮箱，也不用重新输入同步口令。'}
          </div>
        </div>
        {props.st.enabled && (
          <button onClick={() => void generate()} disabled={!canGenerate || genBusy} className={primaryBtn}>
            {genBusy ? '生成中…' : '生成配对'}
          </button>
        )}
      </div>

      {props.st.enabled && !syncAccount && (
        <div className="mt-2 text-xs leading-relaxed rounded-lg px-3 py-2" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
          还没有可用的同步邮箱。请先在下方选择/添加一个邮箱，再生成配对。
        </div>
      )}
      {props.st.enabled && syncAccount && !syncAccount.enabled && (
        <div className="mt-2 text-xs leading-relaxed rounded-lg px-3 py-2" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
          同步邮箱当前已停用。请先在「账户」页启用它，再生成配对。
        </div>
      )}
      {props.st.enabled && localOnly && (
        <div className="mt-2 text-xs leading-relaxed rounded-lg px-3 py-2" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
          当前同步邮箱是本机专用账户（Proton Bridge / 本机服务），另一台电脑连不上，无法生成配对。请换一个通用邮箱作为同步邮箱。
        </div>
      )}
      {props.st.enabled && !localOnly && !props.st.hasPassphrase && (
        <div className="mt-2 text-xs leading-relaxed rounded-lg px-3 py-2" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
          请先在下方设置同步口令，再生成配对。
        </div>
      )}
      {genMsg && (
        <div className="mt-2 text-xs leading-relaxed" style={{ color: genMsg.ok ? 'var(--ok-ink)' : 'var(--danger-ink)' }}>
          {genMsg.text}
        </div>
      )}

      {offer && (
        <div className="mt-3 rounded-xl border border-line bg-hover px-3 py-2.5">
          <div className="text-xs text-ink-2 leading-relaxed">
            在新电脑打开 <b>设置 → 同步与备份</b>，把下面的链接粘贴到「从另一台电脑导入」，再输入配对码：
          </div>
          <textarea
            readOnly
            value={offer.link}
            rows={3}
            onFocus={e => e.currentTarget.select()}
            className="no-drag w-full mt-2 text-[10px] font-mono leading-relaxed bg-panel rounded-lg px-2.5 py-2 outline-none border border-line text-ink-2"
          />
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <button onClick={() => copy('link')} className={ghostBtn}>
              {copied === 'link' ? '已复制' : '复制链接'}
            </button>
            <span className="text-xs text-ink-3">配对码</span>
            <code className="text-sm font-mono tracking-wider text-ink select-text">{offer.pin}</code>
            <button onClick={() => copy('pin')} className={ghostBtn}>
              {copied === 'pin' ? '已复制' : '复制配对码'}
            </button>
            <div className="flex-1" />
            <span className="text-2xs tnum text-ink-3">{remain ? `${mm}:${ss} 后过期` : '已过期'}</span>
          </div>
          <div className="mt-2 text-2xs leading-relaxed text-ink-3">
            链接里包含同步邮箱的加密凭据，请像密码一样对待；链接和配对码最好分开发送。15 分钟内有效。
            {offer.email ? ` 同步邮箱：${offer.email}` : ''}
          </div>
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-[var(--border-soft)]">
        <button onClick={() => setImportOpen(v => !v)} className="text-xs text-ink-2 hover:underline">
          {importOpen ? '收起「从另一台电脑导入」' : '从另一台电脑导入配对 ▾'}
        </button>
        {importOpen && (
          <div className="mt-2 space-y-2">
            <textarea
              value={link}
              onChange={e => setLink(e.target.value)}
              rows={3}
              placeholder="粘贴另一台电脑生成的配对链接（linkto://pair?d=…）"
              className="no-drag w-full text-[10px] font-mono leading-relaxed bg-hover rounded-lg px-2.5 py-2 outline-none border border-line text-ink"
            />
            <div className="flex items-center gap-2">
              <input
                value={pin}
                onChange={e => setPin(e.target.value)}
                placeholder="配对码（XXXXX-XXXXX）"
                autoComplete="off"
                spellCheck={false}
                className={inputCls}
              />
              <button onClick={() => void importNow()} disabled={busy || !link.trim() || !pin.trim()} className={primaryBtn}>
                {busy ? '导入中…' : '导入并开始同步'}
              </button>
            </div>
            {msg && (
              <div className="text-xs leading-relaxed" style={{ color: msg.ok ? 'var(--ok-ink)' : 'var(--danger-ink)' }}>
                {msg.text}
              </div>
            )}
            <div className="text-2xs leading-relaxed text-ink-3">
              导入会自动添加同步邮箱并开启同步；这台电脑上已有的账户会保留，并与另一台电脑的数据合并。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function AccountIssues(props: { st: DevSyncStatus; onChanged(): void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<Record<string, string>>({})
  const tryCandidate = async (id: string) => {
    setBusy(id)
    const r = await api.devsyncUseCandidate(id)
    setBusy(null)
    setErr(e => ({ ...e, [id]: r.ok ? '' : r.error ?? '失败' }))
    props.onChanged()
  }
  return (
    <div className="mb-3 rounded-2xl border border-line bg-panel px-4 py-2">
      <div className="text-xs font-semibold py-1 text-ink-2">同步过来的账户需要处理</div>
      {props.st.accountIssues.map(i => (
        <div key={i.accountId} className="py-2 border-t border-[var(--border-soft)] first:border-0 text-xs leading-relaxed">
          <div className="flex items-center gap-3">
            <span className="flex-1 min-w-0">
              <span className="text-ink font-medium">{i.email}</span>
              <span className="ml-2" style={{ color: i.kind === 'network' ? 'var(--warn-ink)' : 'var(--danger-ink)' }}>
                {i.text}
              </span>
            </span>
            {i.hasCandidate && (
              <button className={ghostBtn} disabled={busy === i.accountId} onClick={() => void tryCandidate(i.accountId)} title="另一台设备的本机密码通常在这台电脑上不能用；确认后才会尝试">
                {busy === i.accountId ? '尝试中…' : `试用${i.candidateDevice ? `「${i.candidateDevice}」` : '另一台设备'}的密码`}
              </button>
            )}
            <button
              className={primaryBtn}
              onClick={() => {
                location.hash = `#/accounts:${i.accountId}:${i.kind === 'oauth' ? 'reauth' : 'password'}`
              }}
            >
              {i.kind === 'oauth' ? '重新授权' : '填写密码'}
            </button>
          </div>
          {err[i.accountId] && <div className="mt-1" style={{ color: 'var(--danger-ink)' }}>{err[i.accountId]}</div>}
        </div>
      ))}
    </div>
  )
}

// ================================================================ 备份与恢复

function CategoryPicker(props: {
  value: Partial<Record<DevSyncCategory, boolean>>
  onChange(v: Partial<Record<DevSyncCategory, boolean>>): void
  counts?: Partial<Record<DevSyncCategory, number>>
  /** 只显示有数据的类别（恢复时） */
  onlyCounted?: boolean
}) {
  const list = DEVSYNC_CATEGORIES.filter(c => !c.parent && (!props.onlyCounted || (props.counts?.[c.id] ?? 0) > 0))
  const box = (c: (typeof DEVSYNC_CATEGORIES)[number], disabled: boolean) => (
    <label key={c.id} className={`no-drag flex items-center gap-2 text-xs cursor-pointer ${disabled ? 'opacity-40' : ''}`}>
      <input
        type="checkbox"
        checked={!!props.value[c.id]}
        disabled={disabled}
        onChange={e => props.onChange({ ...props.value, [c.id]: e.target.checked })}
        className="accent-[var(--accent)]"
      />
      <span className="text-ink">{c.label}</span>
      {props.counts && typeof props.counts[c.id] === 'number' && <span className="text-ink-3">{props.counts[c.id]}</span>}
      {c.secrets && <span className="text-2xs" style={{ color: 'var(--info-ink)' }}>含凭据</span>}
    </label>
  )
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 py-2.5">
      {list.map(c => (
        <div key={c.id} className="flex flex-col gap-1">
          {box(c, false)}
          {DEVSYNC_CATEGORIES.filter(x => x.parent === c.id).map(sub => (
            <div key={sub.id} className="pl-5">
              {box(sub, !props.value[c.id])}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

const defaultBackupCats = (): Partial<Record<DevSyncCategory, boolean>> =>
  Object.fromEntries(DEVSYNC_CATEGORIES.map(c => [c.id, c.id === 'threads' ? false : !c.parent])) as Partial<Record<DevSyncCategory, boolean>>

function BackupSection() {
  const [targets, setTargets] = useState<Target[]>([])
  const [targetId, setTargetId] = useState('icloud')
  const [hintFor, setHintFor] = useState<string | null>(null)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [includeSecrets, setIncludeSecrets] = useState(true)
  const [cats, setCats] = useState(defaultBackupCats)
  const [counts, setCounts] = useState<Partial<Record<DevSyncCategory, number>>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  const [picked, setPicked] = useState<{ path: string; header: BackupxHeader } | null>(null)
  const [rPass, setRPass] = useState('')
  const [inspected, setInspected] = useState<{ counts: Partial<Record<DevSyncCategory, number>>; hasSecrets: boolean } | null>(null)
  const [rCats, setRCats] = useState<Partial<Record<DevSyncCategory, boolean>>>({})
  const [strategy, setStrategy] = useState<'merge' | 'overwrite'>('merge')
  const [result, setResult] = useState<BackupxRestoreResult | null>(null)

  const [auto, setAuto] = useState<BackupxAutoSettings | null>(null)
  const [autoPass, setAutoPass] = useState('')

  useEffect(() => {
    void api.listBackupTargets().then(ts => {
      setTargets(ts)
      if (ts.length && !ts.some(t => t.id === 'icloud' && t.available)) {
        const first = ts.find(t => t.available)
        if (first) setTargetId(first.id)
      }
    })
    void api.devsyncStatus().then(s => setCounts(s.counts))
    void api.backupxAutoGet().then(setAuto)
  }, [])

  const selected = useMemo(() => (Object.entries(cats) as [DevSyncCategory, boolean][]).filter(([, v]) => v).map(([k]) => k), [cats])

  const doBackup = async () => {
    if (busy) return
    if (pass.length < 4) return setMsg({ text: '口令至少 4 位', ok: false })
    if (pass !== pass2) return setMsg({ text: '两次口令不一致', ok: false })
    setBusy(true)
    const res = await api.backupxExport({ targetId, passphrase: pass, includeSecrets, categories: selected })
    setBusy(false)
    if (res.ok) {
      const n = Object.values(res.counts ?? {}).reduce((s, x) => s + (x ?? 0), 0)
      setMsg({ text: `已备份 ${n} 条 → ${res.path}`, ok: true })
    } else setMsg({ text: res.error ?? '备份失败', ok: false })
  }

  const pickFile = async () => {
    setResult(null)
    setInspected(null)
    setRPass('')
    const res = await api.backupxPick()
    if (res.ok && res.path && res.header) setPicked({ path: res.path, header: res.header })
    else if (res.error && res.error !== '未选择备份文件') setMsg({ text: res.error, ok: false })
  }

  const inspect = async () => {
    if (!picked || busy) return
    setBusy(true)
    const r = await api.backupxInspect(picked.path, rPass)
    setBusy(false)
    if (!r.ok || !r.counts) return setMsg({ text: r.error ?? '无法读取', ok: false })
    setInspected({ counts: r.counts, hasSecrets: !!r.hasSecrets })
    const sel: Partial<Record<DevSyncCategory, boolean>> = {}
    for (const c of DEVSYNC_CATEGORIES) sel[c.id] = c.parent ? false : (r.counts[c.id] ?? 0) > 0
    setRCats(sel)
  }

  const restore = async () => {
    if (!picked || busy) return
    setBusy(true)
    const categories = (Object.entries(rCats) as [DevSyncCategory, boolean][]).filter(([, v]) => v).map(([k]) => k)
    const r = await api.backupxRestore(picked.path, rPass, { categories, strategy })
    setBusy(false)
    if (!r.ok) return setMsg({ text: r.error ?? '恢复失败', ok: false })
    setResult(r)
  }

  const saveAuto = async (patch: Partial<BackupxAutoSettings> & { passphrase?: string; pickDir?: boolean }) => {
    const r = await api.backupxAutoSet(patch)
    setAuto(r.settings)
    if (!r.ok) setMsg({ text: r.error ?? '保存失败', ok: false })
    else if (patch.passphrase) {
      setAutoPass('')
      setMsg({ text: '自动备份口令已保存', ok: true })
    }
  }

  const targetButtons = (value: string, onPick: (id: string) => void) => (
    <div className="flex flex-wrap gap-1.5">
      {targets.map(t =>
        !t.available && t.hint ? (
          <button
            key={t.id}
            onClick={() => setHintFor(hintFor === t.id ? null : t.id)}
            title="未检测到同步目录，点击查看如何启用"
            className="no-drag text-xs px-3 py-1.5 rounded-lg border border-dashed border-line text-ink-3 hover:bg-hover"
          >
            {t.label}
            <span className="ml-1 text-2xs">· 未安装</span>
          </button>
        ) : (
          <button
            key={t.id}
            disabled={!t.available}
            onClick={() => onPick(t.id)}
            title={t.path}
            className={`no-drag text-xs px-3 py-1.5 rounded-lg border transition disabled:opacity-30 ${value === t.id ? 'border-blue-400 text-blue-600 bg-blue-50' : 'border-line text-ink-2 hover:bg-hover'}`}
          >
            {t.label}
          </button>
        )
      )}
      <button
        onClick={() => onPick('pick')}
        className={`no-drag text-xs px-3 py-1.5 rounded-lg border transition ${value === 'pick' ? 'border-blue-400 text-blue-600 bg-blue-50' : 'border-line text-ink-2 hover:bg-hover'}`}
      >
        选择目录…
      </button>
    </div>
  )

  const hint = targets.find(x => x.id === hintFor)

  return (
    <div>
      <SectionTitle>加密备份</SectionTitle>
      <p className="text-xs leading-relaxed mb-2 text-ink-3">
        生成口令加密的备份文件（.lkbak，AES-256-GCM），放进网盘的同步目录即可在其他设备恢复。旧版本的备份文件同样可以恢复。
      </p>
      <div className={card}>
        <div className="py-2.5 border-b border-[var(--border-soft)]">
          <div className="text-sm text-ink mb-2">备份到</div>
          {targetButtons(targetId, id => {
            setTargetId(id)
            setHintFor(null)
          })}
          {hint?.hint && (
            <div className="mt-2 rounded-lg px-3 py-2 bg-hover border border-line text-xs text-ink-2 leading-relaxed">
              {hint.hint}
              {hint.downloadUrl && (
                <button onClick={() => void api.openExternal(hint.downloadUrl!)} className="no-drag ml-1.5 font-medium underline underline-offset-2 text-ink">
                  下载 {hint.label}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="py-1 border-b border-[var(--border-soft)]">
          <div className="text-sm text-ink pt-2">包含哪些内容</div>
          <CategoryPicker value={cats} onChange={setCats} counts={counts} />
        </div>
        <div className="flex items-center gap-2 py-2.5 border-b border-[var(--border-soft)]">
          <span className="w-24 text-sm text-ink shrink-0">备份口令</span>
          <input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="至少 4 位，恢复时需要" className={inputCls} />
          <input type="password" value={pass2} onChange={e => setPass2(e.target.value)} placeholder="再次输入" className={inputCls} />
        </div>
        <SettingRow label="包含密码、授权令牌与密钥" desc="包含后新设备恢复即插即用；文件始终加密，只有口令能解开">
          <Toggle checked={includeSecrets} onChange={setIncludeSecrets} />
        </SettingRow>
        <div className="flex items-center gap-3 py-3">
          <button onClick={() => void doBackup()} disabled={busy || !selected.length} className={primaryBtn}>
            {busy ? '处理中…' : '立即备份'}
          </button>
          {msg && (
            <span className="text-xs truncate max-w-[480px]" style={{ color: msg.ok ? 'var(--ok-ink)' : 'var(--danger-ink)' }}>
              {msg.text}
            </span>
          )}
        </div>
      </div>

      <SectionTitle>从备份恢复</SectionTitle>
      <div className={card}>
        <div className="flex items-center gap-4 py-2.5 border-b border-[var(--border-soft)]">
          <span className="w-24 text-sm text-ink shrink-0">备份文件</span>
          <span className="flex-1 min-w-0 text-xs text-ink-2 truncate">
            {picked
              ? `${fmt(picked.header.createdAt)} · ${picked.header.version >= 2 ? '含各中心数据' : '旧版备份（只有账户）'} · ${picked.header.accountCount} 个账户${picked.header.hasSecrets ? ' · 含凭据' : ''}`
              : '未选择'}
          </span>
          <button onClick={() => void pickFile()} className={ghostBtn}>
            选择文件…
          </button>
        </div>
        {picked && !inspected && (
          <div className="flex items-center gap-2 py-2.5">
            <span className="w-24 text-sm text-ink shrink-0">备份口令</span>
            <input type="password" value={rPass} onChange={e => setRPass(e.target.value)} onKeyDown={e => e.key === 'Enter' && void inspect()} placeholder="创建备份时设置的口令" className={inputCls} />
            <button onClick={() => void inspect()} disabled={busy || !rPass} className={primaryBtn}>
              {busy ? '读取中…' : '读取内容'}
            </button>
          </div>
        )}
        {picked && inspected && (
          <>
            <div className="py-1 border-b border-[var(--border-soft)]">
              <div className="text-sm text-ink pt-2">恢复哪些内容（数字为备份里的条数）</div>
              <CategoryPicker value={rCats} onChange={setRCats} counts={inspected.counts} onlyCounted />
            </div>
            <SettingRow label="本机已有同一条时" desc={strategy === 'merge' ? '合并：只补上本机没有的，备份里更新的才覆盖；已有的账户不重复导入' : '以备份为准：备份里的内容覆盖本机同一条（账户配置与凭据也会被覆盖）'}>
              <Select
                value={strategy}
                onChange={v => setStrategy(v === 'overwrite' ? 'overwrite' : 'merge')}
                options={[
                  { value: 'merge', label: '合并' },
                  { value: 'overwrite', label: '以备份为准' }
                ]}
              />
            </SettingRow>
            <div className="flex items-center gap-3 py-3">
              <button onClick={() => void restore()} disabled={busy} className={primaryBtn}>
                {busy ? '恢复中…' : '恢复所选内容'}
              </button>
            </div>
          </>
        )}
      </div>
      {result && (
        <div className={`${card} mt-3 py-3 text-xs leading-relaxed`}>
          {result.accounts.added.length > 0 && <div style={{ color: 'var(--ok-ink)' }}>恢复账户 {result.accounts.added.length} 个：{result.accounts.added.join('、')}</div>}
          {result.accounts.updated.length > 0 && <div className="text-ink-2">更新账户：{result.accounts.updated.join('、')}</div>}
          {result.accounts.skipped.length > 0 && <div className="text-ink-3">跳过（已存在）：{result.accounts.skipped.join('、')}</div>}
          {result.accounts.pending.length > 0 && <div style={{ color: 'var(--warn-ink)' }}>需要处理：{result.accounts.pending.join('、')}</div>}
          {result.accounts.failed.length > 0 && <div style={{ color: 'var(--danger-ink)' }}>失败：{result.accounts.failed.join('、')}</div>}
          <div className="mt-1 text-ink-2">
            {(Object.entries(result.perCategory) as [DevSyncCategory, { added: number; updated: number; skipped: number }][])
              .filter(([k]) => k !== 'accounts')
              .map(([k, v]) => `${DEVSYNC_CATEGORIES.find(c => c.id === k)?.label ?? k}：新增 ${v.added}、更新 ${v.updated}、跳过 ${v.skipped}`)
              .join('；') || '没有其他类别的数据'}
          </div>
        </div>
      )}

      <SectionTitle>定期自动备份</SectionTitle>
      {auto && (
        <div className={card}>
          <SettingRow label="每周自动备份一次" desc={auto.lastAt ? `上次 ${fmt(auto.lastAt)}${auto.lastError ? ` · 失败：${auto.lastError}` : ''}` : auto.lastError ? `失败：${auto.lastError}` : '由后台自动任务执行，也可在「自动化」里查看'}>
            <Toggle checked={auto.enabled} onChange={v => void saveAuto({ enabled: v })} />
          </SettingRow>
          <div className="py-2.5 border-b border-[var(--border-soft)]">
            <div className="text-sm text-ink mb-2">备份到</div>
            {targetButtons(auto.targetId, id => void saveAuto(id === 'pick' ? { targetId: 'pick', pickDir: true } : { targetId: id }))}
            {auto.targetId === 'pick' && auto.dir && <div className="text-2xs text-ink-3 mt-1.5 truncate">{auto.dir}</div>}
          </div>
          <SettingRow label="保留最近几份" desc="更早的自动备份文件会被清理（只清理 LinkTo-AutoBackup-*.lkbak）">
            <Select value={String(auto.keep)} onChange={v => void saveAuto({ keep: Number(v) })} options={[2, 4, 8, 12, 26].map(n => ({ value: String(n), label: `${n} 份` }))} />
          </SettingRow>
          <SettingRow label="包含密码、授权令牌与密钥" desc="文件始终用下方口令加密">
            <Toggle checked={auto.includeSecrets} onChange={v => void saveAuto({ includeSecrets: v })} />
          </SettingRow>
          <div className="py-1 border-b border-[var(--border-soft)]">
            <div className="text-sm text-ink pt-2">包含哪些内容</div>
            <CategoryPicker value={auto.categories} onChange={v => void saveAuto({ categories: v })} />
          </div>
          <div className="flex items-center gap-2 py-2.5">
            <span className="w-24 text-sm text-ink shrink-0">备份口令</span>
            <input type="password" value={autoPass} onChange={e => setAutoPass(e.target.value)} placeholder={auto.hasPassphrase ? '本机已保存 · 输入新口令可替换' : '至少 4 位'} className={inputCls} />
            <button onClick={() => void saveAuto({ passphrase: autoPass })} disabled={!autoPass} className={ghostBtn}>
              保存口令
            </button>
            <button
              onClick={async () => {
                setBusy(true)
                const r = await api.backupxAutoRun()
                setBusy(false)
                setMsg(r.ok ? { text: `已备份 → ${r.path}`, ok: true } : { text: r.error ?? '备份失败', ok: false })
                void api.backupxAutoGet().then(setAuto)
              }}
              disabled={busy || !auto.hasPassphrase}
              className={ghostBtn}
            >
              现在备份一次
            </button>
          </div>
        </div>
      )}
      <p className="text-2xs mt-2 leading-relaxed text-ink-3">
        备份文件用你的口令经 scrypt 派生密钥加密，口令不落盘明文、不上传——忘记口令将无法恢复。OAuth 令牌恢复后通常可直接使用；若已过期或被撤销，在账户页点「重新授权」即可。
      </p>
    </div>
  )
}
