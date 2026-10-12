import { useEffect, useState } from 'react'
import { api, useMailEvent } from '../lib/api'
import type { GhostItem } from '@shared/types'

/**
 * 幽灵信箱窗口：写信（密文投递）+ 收信（收取并焚毁信道）+ 信箱管理
 * 注意：本窗不是焚毁阅读窗——复制自己的幽灵 ID 是必要功能，防截屏只作用于阅读窗。
 */
export function GhostWindow() {
  const [ghostId, setGhostId] = useState('')
  const [fingerprint, setFingerprint] = useState('')
  const [items, setItems] = useState<GhostItem[]>([])
  const [accounts, setAccounts] = useState<{ id: string; email: string }[]>([])
  const [tab, setTab] = useState<'inbox' | 'compose'>('inbox')
  const [notice, setNotice] = useState('')

  // 写信表单
  const [accountId, setAccountId] = useState('')
  const [to, setTo] = useState('')
  const [ghostTo, setGhostTo] = useState('')
  const [password, setPassword] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = () => {
    void api.ghostIdentity().then(r => {
      setGhostId(r.ghostId)
      setFingerprint(r.fingerprint)
    })
    void api.ghostList().then(setItems)
    void api.listAccounts().then(as => {
      const enabled = as.filter(a => a.enabled).map(a => ({ id: a.id, email: a.email }))
      setAccounts(enabled)
      setAccountId(prev => prev || enabled[0]?.id || '')
    })
  }

  useEffect(reload, [])
  useMailEvent(ev => {
    if (ev.type === 'ghost-changed') reload()
  })

  const copyId = () => {
    void navigator.clipboard.writeText(ghostId)
    setNotice('幽灵 ID 已复制（发给对方即可收到你的幽灵信）')
  }

  const scan = async () => {
    setBusy(true)
    const r = await api.ghostReceiveScan()
    setBusy(false)
    setNotice(
      r.error
        ? `收取失败：${r.error}`
        : `收取完成：新信 ${r.imported} 封，焚毁信道 ${r.burned} 封${r.pending ? `，${r.pending} 封待附件下载后下轮收取` : ''}`
    )
    reload()
  }

  const send = async () => {
    if (!accountId || !to || !ghostTo || !password || !text) {
      setNotice('请填写完整：投递账户 / 收件地址 / 收件人幽灵 ID / 打开口令 / 正文')
      return
    }
    setBusy(true)
    const r = await api.ghostSend({ accountId, to, ghostId: ghostTo, password, text })
    setBusy(false)
    if (r.ok) {
      setNotice('已投递。密文信封经 SMTP 发出，本机不留副本。')
      setText('')
      setPassword('')
      setTab('inbox')
    } else {
      setNotice(`投递失败：${r.error}`)
    }
  }

  const open = (id: string) => {
    void api.openGhostReader(id)
  }

  const burn = async (id: string) => {
    await api.ghostBurn(id)
    setNotice('已拒收焚毁，此信永久不可恢复')
    reload()
  }

  const fmtTime = (t: number) => new Date(t).toLocaleString('zh-CN', { hour12: false })

  return (
    <div className="h-screen flex flex-col bg-[oklch(0.97_0.005_106)] text-[oklch(0.22_0.02_106)]">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-black/8 bg-white/60 backdrop-blur">
        <div className="text-[15px] font-semibold tracking-wide">幽灵信</div>
        <div className="text-xs text-black/45">端到端加密 · 阅后即焚 · 不含任何账号身份</div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setTab('inbox')}
            className={`px-3 py-1.5 rounded-lg text-xs ${tab === 'inbox' ? 'bg-[oklch(0.45_0.07_180)] text-white' : 'bg-black/5 hover:bg-black/10'}`}
          >
            信箱
          </button>
          <button
            onClick={() => setTab('compose')}
            className={`px-3 py-1.5 rounded-lg text-xs ${tab === 'compose' ? 'bg-[oklch(0.45_0.07_180)] text-white' : 'bg-black/5 hover:bg-black/10'}`}
          >
            写幽灵信
          </button>
        </div>
      </div>

      {notice && <div className="px-5 py-2 text-xs bg-[oklch(0.93_0.03_180)] border-b border-black/5">{notice}</div>}

      <div className="flex-1 overflow-auto px-5 py-4">
        {tab === 'inbox' ? (
          <div className="max-w-3xl mx-auto space-y-4">
            {/* 我的幽灵 ID */}
            <div className="rounded-xl border border-black/8 bg-white/70 p-4">
              <div className="text-xs font-medium mb-1 text-black/60">我的幽灵 ID（公钥）</div>
              <div className="text-xs mb-1">
                指纹 <span className="font-mono text-[oklch(0.45_0.09_180)]">{fingerprint}</span>
              </div>
              <div className="flex gap-2 items-start">
                <code className="flex-1 text-[10px] leading-relaxed break-all bg-black/4 rounded-lg p-2 select-text">{ghostId}</code>
                <button onClick={copyId} className="px-3 py-1.5 rounded-lg text-xs bg-black/5 hover:bg-black/10 whitespace-nowrap">
                  复制
                </button>
              </div>
            </div>

            {/* 收取 */}
            <div className="rounded-xl border border-black/8 bg-white/70 p-4 flex items-center gap-3">
              <div className="text-xs text-black/60 flex-1">
                收取会扫描全部账户的幽灵信信封：落入信箱后，原始邮件（含服务器与已发送副本）将被永久删除
              </div>
              <button
                onClick={() => void scan()}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-xs bg-[oklch(0.45_0.07_180)] text-white hover:opacity-90 disabled:opacity-50 whitespace-nowrap"
              >
                {busy ? '收取中…' : '收取并焚毁信道'}
              </button>
            </div>

            {/* 信箱列表 */}
            {items.length === 0 ? (
              <div className="text-center text-sm text-black/40 py-16">信箱是空的。收到幽灵信并收取后会出现在这里。</div>
            ) : (
              items.map(it => (
                <div key={it.id} className="rounded-xl border border-black/8 bg-white/70 p-4 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">密封的信</div>
                    <div className="text-xs text-black/45 mt-0.5">
                      {fmtTime(it.receivedAt)} · 密文 {Math.ceil(it.sealedBytes / 1024)} KB · 未打开前无任何可读信息
                    </div>
                  </div>
                  <button
                    onClick={() => open(it.id)}
                    className="px-3 py-1.5 rounded-lg text-xs bg-[oklch(0.45_0.07_180)] text-white hover:opacity-90 whitespace-nowrap"
                  >
                    打开阅读
                  </button>
                  <button
                    onClick={() => void burn(it.id)}
                    className="px-3 py-1.5 rounded-lg text-xs bg-black/5 hover:bg-red-500/10 hover:text-red-600 whitespace-nowrap"
                  >
                    拒收焚毁
                  </button>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="max-w-2xl mx-auto space-y-3">
            <div className="text-xs text-black/50 leading-relaxed rounded-xl bg-[oklch(0.93_0.03_180)] p-3">
              正文将以「收件人幽灵公钥 + 你设置的口令」双重加密，作为密文附件投递。收件人需要
              <b>本机幽灵私钥 + 口令</b>两者齐备才能阅读，阅后信封即刻焚毁。投递账户与收件邮箱地址仅作传输通道，
              服务商可看到一次通信发生（内容不可见）——匿名中继通道在后续版本提供。
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-black/55">投递账户（SMTP 出口）</span>
                <select
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-black/10 bg-white/80 px-2.5 py-2 text-sm"
                >
                  {accounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.email}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-black/55">收件邮箱（投递地址）</span>
                <input
                  value={to}
                  onChange={e => setTo(e.target.value)}
                  placeholder="someone@example.com"
                  className="mt-1 w-full rounded-lg border border-black/10 bg-white/80 px-2.5 py-2 text-sm"
                />
              </label>
            </div>
            <label className="block">
              <span className="text-xs text-black/55">收件人幽灵 ID（对方「复制」给你的那串公钥）</span>
              <textarea
                value={ghostTo}
                onChange={e => setGhostTo(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-lg border border-black/10 bg-white/80 px-2.5 py-2 text-[10px] font-mono leading-relaxed"
              />
            </label>
            <label className="block">
              <span className="text-xs text-black/55">打开口令（口头或另一渠道告诉对方；设置后无法更改）</span>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="mt-1 w-full rounded-lg border border-black/10 bg-white/80 px-2.5 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs text-black/55">正文（阅后即焚，对方关闭阅读窗即永久销毁）</span>
              <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                rows={8}
                className="mt-1 w-full rounded-lg border border-black/10 bg-white/80 px-2.5 py-2 text-sm leading-relaxed"
              />
            </label>
            <button
              onClick={() => void send()}
              disabled={busy}
              className="w-full py-2.5 rounded-xl text-sm bg-[oklch(0.45_0.07_180)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? '加密投递中…' : '加密并投递'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}