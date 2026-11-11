import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { TodoSyncStatus } from '@shared/ipc'
import type { AccountWithStatus } from '@shared/types'

export function MobileSyncCard() {
  const [status, setStatus] = useState<TodoSyncStatus | null>(null)
  const [accounts, setAccounts] = useState<AccountWithStatus[]>([])
  const [accountId, setAccountId] = useState(''), [pass, setPass] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    void Promise.all([api.todoSyncStatus(), api.listAccounts()]).then(([s, a]) => { setStatus(s); setAccountId(s.accountId ?? ''); setAccounts(a.filter(i => i.enabled && i.provider !== 'proton' && !/^(127\.|localhost|::1)/i.test(i.imap.host))) })
    return api.onEvent(ev => { const e = ev as { type: string; status?: TodoSyncStatus }; if (e.type === 'todo-sync-status' && e.status) setStatus(e.status) })
  }, [])
  const save = async (enabled: boolean) => {
    setBusy(true); setError('')
    try {
      const result = await api.todoSyncConfigure({ enabled, accountId: accountId || null, encrypt: true, ...(pass ? { passphrase: pass } : {}) })
      setStatus(result.status)
      if (!result.ok) setError(result.error ?? '同步未完成')
      else setPass('')
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  return <section className="mb-6 rounded-2xl border border-line bg-panel p-4 space-y-3">
    <div className="flex items-center gap-2"><h2 className="text-sm font-semibold text-ink">手机与电脑 · 待办和随手记</h2><span className="text-xs text-ink-3">{status?.running ? '同步中…' : status?.enabled ? '已开启' : '未开启'}</span></div>
    <p className="text-xs leading-relaxed text-ink-3">与手机“更多 → 加密同步”选择同一邮箱、同一口令。待办和笔记经加密保存在隐藏文件夹 LinkTo-Sync；邮件来源信息会随记录保留。</p>
    <select aria-label="手机与电脑共用的同步邮箱" value={accountId} onChange={e => setAccountId(e.target.value)} className="w-full rounded-lg bg-hover border border-line px-3 py-2 text-sm text-ink"><option value="">选择同步邮箱</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.email}</option>)}</select>
    <input aria-label="手机与电脑共用的同步口令" type="password" autoComplete="new-password" value={pass} onChange={e => setPass(e.target.value)} placeholder={status?.hasPassphrase ? '已保存口令；留空沿用，修改后所有设备需一致' : '同步口令，至少 6 位'} className="w-full rounded-lg bg-hover border border-line px-3 py-2 text-sm text-ink" />
    {(error || status?.lastError) && <p role="alert" className="text-xs text-red-600">{error || status?.lastError}</p>}
    <div className="flex items-center gap-2"><button disabled={busy || !accountId} onClick={() => void save(true)} className="text-xs px-3 py-2 rounded-lg bg-ink text-app disabled:opacity-40">{busy ? '保存中…' : '保存并开启'}</button>{status?.enabled && <button disabled={busy} onClick={() => void save(false)} className="text-xs px-3 py-2 rounded-lg border border-line text-ink-2">关闭同步</button>}<span className="text-xs text-ink-3">{status?.lastSyncAt ? `上次同步 ${new Date(status.lastSyncAt).toLocaleTimeString('zh-CN')}` : ''}</span></div>
  </section>
}
