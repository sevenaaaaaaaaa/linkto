import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { TodoSyncStatus } from '@shared/ipc'
import type { AccountWithStatus } from '@shared/types'
import { SectionTitle, SettingRow, Toggle, Select } from './GeneralTab'

/**
 * 待办跨设备同步：待办以（加密）邮件形式存放在用户自己邮箱的隐藏文件夹 LinkTo-Sync 里，
 * 各设备经 IMAP 读写同一个文件夹完成同步，不经过任何第三方服务器。
 */
export function TodoSyncSection() {
  const [st, setSt] = useState<TodoSyncStatus | null>(null)
  const [accounts, setAccounts] = useState<AccountWithStatus[]>([])
  const [accountId, setAccountId] = useState<string>('')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  useEffect(() => {
    void Promise.all([api.todoSyncStatus(), api.listAccounts()]).then(([s, list]) => {
      setSt(s)
      setAccounts(list)
      setAccountId(s.accountId ?? list.find(a => a.enabled)?.id ?? list[0]?.id ?? '')
    })
    return api.onEvent(ev => {
      const e = ev as { type?: string; status?: TodoSyncStatus }
      if (e.type === 'todo-sync-status' && e.status) setSt(e.status)
    })
  }, [])

  if (!st) return null

  const apply = async (input: { enabled: boolean; passphrase?: string; encrypt?: boolean; accountId?: string }) => {
    if (busy) return
    setBusy(true)
    setMsg(null)
    const res = await api.todoSyncConfigure({
      enabled: input.enabled,
      accountId: (input.accountId ?? accountId) || null,
      passphrase: input.passphrase,
      encrypt: input.encrypt
    })
    setBusy(false)
    setSt(res.status)
    if (!res.ok) setMsg({ text: res.error ?? '保存失败', ok: false })
    else if (input.passphrase) {
      setPass('')
      setPass2('')
      setMsg({ text: '口令已保存', ok: true })
    }
    return res.ok
  }

  const savePass = async () => {
    if (pass.length < 6) return setMsg({ text: '同步口令至少 6 位', ok: false })
    if (pass !== pass2) return setMsg({ text: '两次输入的口令不一致', ok: false })
    await apply({ enabled: st.enabled, passphrase: pass })
  }

  const toggleEnabled = async (v: boolean) => {
    if (v && st.encrypt && !st.hasPassphrase && !pass) return setMsg({ text: '请先在下方设置同步口令', ok: false })
    if (v && pass && pass !== pass2) return setMsg({ text: '两次输入的口令不一致', ok: false })
    const ok = await apply({ enabled: v, passphrase: v && pass ? pass : undefined })
    if (ok && v && pass) {
      setPass('')
      setPass2('')
    }
  }

  const syncNow = async () => {
    if (busy) return
    setBusy(true)
    setMsg(null)
    setSt(await api.todoSyncNow())
    setBusy(false)
  }

  const fmt = (ts: number) => new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const account = accounts.find(a => a.id === (st.accountId ?? accountId))
  const running = busy || st.running

  return (
    <div className="max-w-[620px]">
      <SectionTitle>待办跨设备同步</SectionTitle>
      <p className="text-xs leading-relaxed mb-2 text-ink-3">
        待办以加密邮件形式存放在你自己邮箱的隐藏文件夹（{st.folder}）里，不经过任何第三方服务器。
        每台设备选同一个邮箱、填同一个口令，就会自动合并：以最后一次修改为准，删除的待办也会同步删除。
        只有你的设备知道口令，邮箱服务商看到的只是一些读不懂的加密邮件。
      </p>

      <div className="rounded-2xl bg-panel border border-line px-4">
        <SettingRow label="开启待办同步" desc="开启后每 5 分钟自动同步一次，本地改动 3 秒内推送">
          <Toggle checked={st.enabled} onChange={v => void toggleEnabled(v)} />
        </SettingRow>

        <SettingRow label="同步邮箱" desc="所有设备都要选同一个邮箱账户">
          {accounts.length ? (
            <Select
              value={st.accountId ?? accountId}
              onChange={v => {
                setAccountId(v)
                if (st.enabled) void apply({ enabled: true, accountId: v })
              }}
              options={accounts.map(a => ({ value: a.id, label: a.email || a.name }))}
            />
          ) : (
            <span className="text-xs text-ink-3">请先添加邮箱账户</span>
          )}
        </SettingRow>

        <SettingRow label="加密内容（推荐）" desc="关闭后待办以明文 JSON 存在邮箱里；所有设备的这项设置需一致">
          <Toggle checked={st.encrypt} onChange={v => void apply({ enabled: st.enabled, encrypt: v })} />
        </SettingRow>

        {st.encrypt && (
          <div className="py-3 border-b border-[var(--border-soft)]">
            <div className="flex items-baseline gap-2">
              <span className="text-sm text-ink">同步口令</span>
              <span className="text-2xs text-ink-3">{st.hasPassphrase ? '本机已保存 · 输入新口令可替换' : '尚未设置'}</span>
            </div>
            <div className="text-xs mt-0.5 leading-relaxed text-ink-3">
              每台设备都要输入同一个口令，口令只保存在本机钥匙串里，不会上传。口令不一致时这台设备无法读取同步数据，会在下方提示。
              忘记口令：在邮箱网页端删除 {st.folder} 文件夹后重新设置即可（所有设备会重新上传各自的待办）。
            </div>
            <div className="flex items-center gap-2 mt-2">
              <input
                type="password"
                value={pass}
                onChange={e => setPass(e.target.value)}
                placeholder="至少 6 位"
                autoComplete="new-password"
                className="no-drag flex-1 min-w-0 text-sm bg-hover rounded-lg px-2.5 py-1.5 outline-none border border-line text-ink"
              />
              <input
                type="password"
                value={pass2}
                onChange={e => setPass2(e.target.value)}
                placeholder="再次输入"
                autoComplete="new-password"
                className="no-drag flex-1 min-w-0 text-sm bg-hover rounded-lg px-2.5 py-1.5 outline-none border border-line text-ink"
              />
              <button
                onClick={() => void savePass()}
                disabled={!pass || busy}
                className="no-drag shrink-0 text-xs px-3 py-1.5 rounded-lg border border-line text-ink-2 hover:bg-hover disabled:opacity-40"
              >
                保存口令
              </button>
            </div>
          </div>
        )}

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
                {st.lastStats && (st.lastStats.pulled || st.lastStats.pushed)
                  ? ` · 收到 ${st.lastStats.pulled} 条、发出 ${st.lastStats.pushed} 条`
                  : ' · 已是最新'}
              </span>
            ) : (
              <span className="text-ink-3">尚未同步</span>
            )}
            {st.enabled && st.lastError && (
              <div role="alert" className="mt-1 text-red-600">
                {st.lastError}
              </div>
            )}
            {msg && <div className={`mt-1 ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</div>}
          </div>
          <button
            onClick={() => void syncNow()}
            disabled={!st.enabled || running}
            className="no-drag shrink-0 text-xs font-medium px-3.5 py-1.5 rounded-lg bg-ink text-app hover:bg-ink/85 disabled:opacity-40"
          >
            {running ? '同步中…' : '立即同步'}
          </button>
        </div>
      </div>
      <p className="text-2xs mt-2 leading-relaxed text-ink-3">
        本机名称：{st.deviceName}。同步文件夹不会出现在 LinkTo 的文件夹列表里；在 Gmail 网页端它显示为一个同名标签，
        Proton Mail 中位于「Folders」下，请勿手动移动其中的邮件。
      </p>
    </div>
  )
}
