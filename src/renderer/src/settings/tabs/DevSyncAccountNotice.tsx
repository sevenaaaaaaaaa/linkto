import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { AccountWithStatus } from '@shared/types'
import type { DevSyncAccountIssue } from '@shared/devsync'

/**
 * 账户页：跨设备同步过来的账户需要本机处理时的提示与填写入口
 * （本机专用凭据未填写 / 同步来的密码登录失败 / 需要重新授权）。
 */
export function DevSyncAccountNotice(props: { account: AccountWithStatus; onChanged(): void; onPassword(): void; onReauth(): void }) {
  const a = props.account
  const [issue, setIssue] = useState<DevSyncAccountIssue | null>(null)
  const [pwd, setPwd] = useState('')
  const [imapPort, setImapPort] = useState(String(a.imap.port))
  const [smtpPort, setSmtpPort] = useState(String(a.smtp.port))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = () => void api.devsyncStatus().then(s => setIssue(s.accountIssues.find(i => i.accountId === a.id) ?? null))
  useEffect(() => {
    load()
    return api.onEvent(ev => {
      const t = (ev as { type?: string }).type
      if (t === 'devsync-status' || t === 'accounts-changed' || t === 'account-status') load()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id])

  if (!issue) return null

  const saveLocal = async () => {
    if (!pwd) return
    setBusy(true)
    const ip = Number(imapPort) || a.imap.port
    const sp = Number(smtpPort) || a.smtp.port
    await api.updateAccount(a.id, {
      password: pwd,
      ...(ip !== a.imap.port ? { imap: { ...a.imap, port: ip } } : {}),
      ...(sp !== a.smtp.port ? { smtp: { ...a.smtp, port: sp } } : {})
    } as never)
    setBusy(false)
    setPwd('')
    props.onChanged()
    load()
  }

  const tryCandidate = async () => {
    setBusy(true)
    setErr('')
    const r = await api.devsyncUseCandidate(a.id)
    setBusy(false)
    if (!r.ok) setErr(r.error ?? '失败')
    props.onChanged()
    load()
  }

  const portInput = 'no-drag w-16 text-sm bg-hover rounded-lg px-2 py-1 outline-none border border-line text-ink'

  return (
    <div className="py-2.5 border-b border-ink/[0.04] text-xs leading-relaxed" role="alert">
      <div style={{ color: issue.kind === 'network' ? 'var(--warn-ink)' : 'var(--danger-ink)' }}>
        <b>跨设备同步：</b>
        {issue.text}
      </div>
      {issue.kind === 'device-local' ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="text-ink-3">打开这台电脑上的 Bridge，复制它为该账户显示的密码（与另一台电脑的不同）；端口不同也一并改：</div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="password"
              value={pwd}
              onChange={e => setPwd(e.target.value)}
              placeholder="本机 Bridge 密码"
              aria-label="本机 Bridge 密码"
              className="no-drag flex-1 min-w-[160px] text-sm bg-hover rounded-lg px-2.5 py-1 outline-none border border-line text-ink"
            />
            <span className="text-ink-3">IMAP</span>
            <input value={imapPort} onChange={e => setImapPort(e.target.value)} className={portInput} aria-label="IMAP 端口" />
            <span className="text-ink-3">SMTP</span>
            <input value={smtpPort} onChange={e => setSmtpPort(e.target.value)} className={portInput} aria-label="SMTP 端口" />
            <button onClick={() => void saveLocal()} disabled={!pwd || busy} className="no-drag text-xs font-medium px-3 py-1.5 rounded-lg bg-ink text-app disabled:opacity-40">
              保存并连接
            </button>
          </div>
          {issue.hasCandidate && (
            <div className="text-ink-3">
              已收到{issue.candidateDevice ? `「${issue.candidateDevice}」` : '另一台设备'}的密码，默认不启用（本机服务的密码通常每台电脑不同）。
              <button onClick={() => void tryCandidate()} disabled={busy} className="no-drag ml-1 underline underline-offset-2 text-ink disabled:opacity-40">
                仍要试一下
              </button>
            </div>
          )}
          {err && <div style={{ color: 'var(--danger-ink)' }}>{err}</div>}
        </div>
      ) : (
        <button onClick={() => (issue.kind === 'oauth' ? props.onReauth() : props.onPassword())} className="no-drag mt-1 underline underline-offset-2 text-ink">
          {issue.kind === 'oauth' ? '重新授权' : '重新输入密码'}
        </button>
      )}
    </div>
  )
}
