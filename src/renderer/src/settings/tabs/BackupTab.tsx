import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { SectionTitle } from './GeneralTab'

type BackupMeta = { createdAt: number; accountCount: number; hasSecrets: boolean }
type Target = { id: string; label: string; path: string; available: boolean }

/** 备份与恢复：口令加密的账户配置跨设备迁移（iCloud Drive / Dropbox / Proton Drive / 自选目录） */
export function BackupTab() {
  const [targets, setTargets] = useState<Target[]>([])
  const [targetId, setTargetId] = useState<string>('icloud')
  const [passphrase, setPassphrase] = useState('')
  const [passphrase2, setPassphrase2] = useState('')
  const [includeSecrets, setIncludeSecrets] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgOk, setMsgOk] = useState(true)

  // 恢复侧
  const [picked, setPicked] = useState<{ path: string; meta: BackupMeta } | null>(null)
  const [restorePass, setRestorePass] = useState('')
  const [restoreResult, setRestoreResult] = useState<{ added: string[]; skipped: string[]; failed: string[] } | null>(null)

  useEffect(() => {
    void api.listBackupTargets().then(ts => {
      setTargets(ts)
      if (ts.length && !ts.some(t => t.id === 'icloud' && t.available)) {
        const first = ts.find(t => t.available)
        if (first) setTargetId(first.id)
      }
    })
  }, [])

  const notify = (text: string, ok = true) => {
    setMsg(text)
    setMsgOk(ok)
    setTimeout(() => setMsg(''), 4000)
  }

  const doBackup = async () => {
    if (busy) return
    if (passphrase.length < 4) return notify('口令至少 4 位', false)
    if (passphrase !== passphrase2) return notify('两次口令不一致', false)
    setBusy(true)
    const res = await api.createBackup(targetId, passphrase, includeSecrets)
    setBusy(false)
    if (res.ok) notify(`已备份 ${res.accountCount} 个账户 → ${res.path}`, true)
    else notify(res.error ?? '备份失败', false)
  }

  const pickFile = async () => {
    setRestoreResult(null)
    const res = await api.restoreBackupPick()
    if (res.ok && res.path && res.meta) {
      setPicked({ path: res.path, meta: res.meta })
    } else if (res.error && res.error !== '未选择备份文件') {
      notify(res.error, false)
    }
  }

  const doRestore = async () => {
    if (!picked || busy) return
    setBusy(true)
    const res = await api.restoreBackupApply(picked.path, restorePass)
    setBusy(false)
    if (!res.ok) return notify(res.error ?? '恢复失败', false)
    setRestoreResult({ added: res.added ?? [], skipped: res.skipped ?? [], failed: res.failed ?? [] })
  }

  const fmt = (ts: number) => new Date(ts).toLocaleString('zh-CN')

  return (
    <div className="max-w-[600px]">
      <SectionTitle>备份账户配置</SectionTitle>
      <p className="text-[12.5px] text-zinc-500 leading-relaxed mb-3">
        生成口令加密的备份文件（AES-256-GCM），保存到网盘的本地同步目录后会自动云同步到你的其他设备。
        新设备安装林可兔后，在下方「恢复」导入即可，无需重新填写。
      </p>
      <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm px-4 py-1">
        <div className="py-2.5 border-b border-black/[0.04]">
          <div className="text-[13.5px] text-zinc-800 mb-2">备份到</div>
          <div className="flex flex-wrap gap-1.5">
            {targets.map(t => (
              <button
                key={t.id}
                disabled={!t.available}
                onClick={() => setTargetId(t.id)}
                title={t.path}
                className={`text-[12.5px] px-3 py-1.5 rounded-lg border transition disabled:opacity-30 ${
                  targetId === t.id ? 'border-blue-400 text-blue-600 bg-blue-50' : 'border-black/[0.08] text-zinc-600 hover:bg-zinc-50'
                }`}
              >
                {t.label}
              </button>
            ))}
            <button
              onClick={() => setTargetId('pick')}
              className={`text-[12.5px] px-3 py-1.5 rounded-lg border transition ${
                targetId === 'pick' ? 'border-blue-400 text-blue-600 bg-blue-50' : 'border-black/[0.08] text-zinc-600 hover:bg-zinc-50'
              }`}
            >
              选择目录…
            </button>
          </div>
          {targetId === 'pick' && (
            <p className="text-[11.5px] text-zinc-400 mt-1.5">
              提示：把目录选到 Dropbox / Proton Drive 等网盘的同步文件夹里，同样能自动云同步。
            </p>
          )}
        </div>
        <div className="flex items-center gap-4 py-2.5 border-b border-black/[0.04]">
          <span className="w-32 text-[13.5px] text-zinc-700 shrink-0">备份口令</span>
          <input
            type="password"
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            placeholder="至少 4 位，恢复时需要"
            className="flex-1 text-[13px] bg-zinc-50 rounded-lg px-2.5 py-1.5 outline-none border border-black/[0.05]"
          />
        </div>
        <div className="flex items-center gap-4 py-2.5 border-b border-black/[0.04]">
          <span className="w-32 text-[13.5px] text-zinc-700 shrink-0">再次输入</span>
          <input
            type="password"
            value={passphrase2}
            onChange={e => setPassphrase2(e.target.value)}
            placeholder="确认口令"
            className="flex-1 text-[13px] bg-zinc-50 rounded-lg px-2.5 py-1.5 outline-none border border-black/[0.05]"
          />
        </div>
        <div className="flex items-center gap-4 py-2.5">
          <span className="flex-1 text-[13.5px] text-zinc-800">
            包含密码与授权令牌
            <span className="block text-[11.5px] text-zinc-400 mt-0.5">包含后新设备恢复即插即用；文件始终加密，仅口令可解</span>
          </span>
          <ToggleMini checked={includeSecrets} onChange={setIncludeSecrets} />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => void doBackup()}
          disabled={busy}
          className="text-[13px] font-medium px-5 py-2 rounded-xl bg-blue-600 text-white shadow-sm hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? '备份中…' : '立即备份'}
        </button>
        {msg && <span className={`text-[12.5px] ${msgOk ? 'text-green-600' : 'text-red-500'} truncate max-w-[380px]`}>{msg}</span>}
      </div>

      <SectionTitle>从备份恢复</SectionTitle>
      <p className="text-[12.5px] text-zinc-500 leading-relaxed mb-3">
        选择备份文件（.lkbak）并输入备份口令。已存在的账户不会重复导入；未包含凭据的账户恢复后输入一次密码/重新授权即可。
      </p>
      <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm px-4 py-1">
        <div className="flex items-center gap-4 py-2.5 border-b border-black/[0.04]">
          <span className="w-32 text-[13.5px] text-zinc-700 shrink-0">备份文件</span>
          {picked ? (
            <span className="flex-1 min-w-0 text-[12.5px] text-zinc-600 truncate">
              {picked.meta.accountCount} 个账户 · {fmt(picked.meta.createdAt)}
              {picked.meta.hasSecrets ? ' · 含凭据' : ' · 不含凭据'}
            </span>
          ) : (
            <span className="flex-1 text-[12.5px] text-zinc-400">未选择</span>
          )}
          <button onClick={() => void pickFile()} className="text-[13px] text-blue-600 shrink-0">
            选择文件…
          </button>
        </div>
        {picked && (
          <div className="flex items-center gap-4 py-2.5">
            <span className="w-32 text-[13.5px] text-zinc-700 shrink-0">备份口令</span>
            <input
              type="password"
              value={restorePass}
              onChange={e => setRestorePass(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void doRestore()}
              className="flex-1 text-[13px] bg-zinc-50 rounded-lg px-2.5 py-1.5 outline-none border border-black/[0.05]"
              placeholder="创建备份时设置的口令"
            />
            <button
              onClick={() => void doRestore()}
              disabled={busy || !restorePass}
              className="text-[13px] px-4 py-1.5 rounded-lg bg-blue-600 text-white disabled:opacity-40 shrink-0"
            >
              {busy ? '恢复中…' : '恢复'}
            </button>
          </div>
        )}
      </div>
      {restoreResult && (
        <div className="mt-3 rounded-2xl bg-white border border-black/[0.06] shadow-sm px-4 py-3 text-[12.5px] leading-relaxed">
          {restoreResult.added.length > 0 && (
            <div className="text-green-700 mb-1">
              ✓ 恢复 {restoreResult.added.length} 个：{restoreResult.added.join('、')}
            </div>
          )}
          {restoreResult.skipped.length > 0 && (
            <div className="text-zinc-500 mb-1">跳过 {restoreResult.skipped.length} 个（已存在）：{restoreResult.skipped.join('、')}</div>
          )}
          {restoreResult.failed.length > 0 && <div className="text-red-500">失败：{restoreResult.failed.join('、')}</div>}
          {restoreResult.added.length > 0 && (
            <div className="text-zinc-400 mt-1">账户已开始同步，可在「账户」页查看状态。</div>
          )}
        </div>
      )}

      <SectionTitle>安全说明</SectionTitle>
      <p className="text-[12px] text-zinc-400 leading-relaxed">
        备份文件用你的口令经 scrypt 派生密钥加密（AES-256-GCM），口令不落盘、不上传——忘记口令将无法恢复。
        OAuth 令牌随备份迁移后通常可直接使用；若服务商令牌已过期或被撤销，在账户页点「重新授权」即可。
      </p>
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