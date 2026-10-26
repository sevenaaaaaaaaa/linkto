import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { FlyComposeResult, FlyMode } from '@shared/types'

/**
 * 萤火密信窗口：写 / 读一次性密信。
 *
 * 设计原则（对 2026-10 产品反馈的回应）：
 *  - 不需要知道对方 ID、邮箱、设备：链接或 6 个词，二选一
 *  - 不生成任何长期身份：每封信独立随机，读完即弃，两封信之间无法关联
 *  - 不写盘：正文、口令、链接都只在本窗内存中；中继只存定长密文
 */

const TTL_OPTIONS: Array<{ v: number; label: string }> = [
  { v: 600, label: '10 分钟' },
  { v: 3600, label: '1 小时' },
  { v: 86400, label: '24 小时' },
  { v: 604800, label: '7 天' }
]

const MODES: Array<{ v: FlyMode; title: string; sub: string }> = [
  { v: 'link', title: '一条链接', sub: '256 位密钥在 # 之后，服务器看不到；链接即钥匙，泄露即内容泄露' },
  { v: 'link-code', title: '链接 + 口令', sub: '链接走网络、6 个词走口头；两条信道缺一不可' },
  { v: 'code', title: '只说口令', sub: '不发链接；对方打开中继网址，输入 6 个词' }
]

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

function fmtLeft(ms: number): string {
  if (ms <= 0) return '已过期'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return d + ' 天 ' + h + ' 小时'
  if (h > 0) return h + ' 小时 ' + m + ' 分'
  return m + ' 分 ' + (s % 60) + ' 秒'
}

type Notice = { kind: 'ok' | 'err' | 'info'; text: string } | null

export function FlyWindow() {
  const [tab, setTab] = useState<'write' | 'read' | 'channel'>('write')
  const [notice, setNotice] = useState<Notice>(null)

  // 写
  const [text, setText] = useState('')
  const [mode, setMode] = useState<FlyMode>('link')
  const [ttl, setTtl] = useState(3600)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<FlyComposeResult | null>(null)
  const [now, setNow] = useState(Date.now())

  // 读
  const [openInput, setOpenInput] = useState('')
  const [openCode, setOpenCode] = useState('')
  const [opening, setOpening] = useState(false)

  // 通道
  const [relay, setRelay] = useState('')
  const [relayInput, setRelayInput] = useState('')
  const [relaySaving, setRelaySaving] = useState(false)
  const openInputRef = useRef<HTMLTextAreaElement | null>(null)

  const reloadRelay = () => {
    void api
      .flyRelayUrl()
      .then(u => {
        setRelay(u)
        setRelayInput(prev => prev || u)
      })
      .catch(() => undefined)
  }

  useEffect(reloadRelay, [])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const bytes = useMemo(() => byteLength(text), [text])
  const tooLong = bytes > 40_000

  const copy = async (s: string, label: string) => {
    await api.flyCopy(s)
    setNotice({ kind: 'ok', text: label + '已复制 · 45 秒后自动清空剪贴板' })
  }

  const compose = async () => {
    if (busy) return
    if (!text.trim()) {
      setNotice({ kind: 'err', text: '正文是空的' })
      return
    }
    if (tooLong) {
      setNotice({ kind: 'err', text: '正文太长（上限约 40KB，当前 ' + bytes + ' 字节）' })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const r = await api.flyCompose({ text, mode, ttlSeconds: ttl })
      if (!r.ok) {
        setNotice({ kind: 'err', text: r.error ?? '生成失败' })
        return
      }
      setResult(r)
      setText('') // 生成后立即从编辑区清掉明文
      setNow(Date.now())
      setNotice({
        kind: 'ok',
        text:
          r.mode === 'code'
            ? '已生成 6 词口令。把它口头告诉对方，不要和网址发在同一条消息里。'
            : r.mode === 'link-code'
              ? '已生成。链接与 6 个词请走两条不同的信道。'
              : '已生成。链接本身就是钥匙，只发给你想给的人。'
      })
    } catch (err) {
      setNotice({ kind: 'err', text: '生成失败：' + (err instanceof Error ? err.message : String(err)) })
    } finally {
      setBusy(false)
    }
  }

  const openLetter = async () => {
    if (opening) return
    const input = openInput.trim()
    if (!input) {
      setNotice({ kind: 'err', text: '粘贴链接、32 位信箱号，或 6 个词的口令' })
      return
    }
    setOpening(true)
    setNotice(null)
    try {
      const r = await api.flyOpen(input, openCode.trim() || undefined)
      if (!r.ok || !r.token) {
        setNotice({ kind: 'err', text: r.error ?? '打开失败' })
        return
      }
      setOpenInput('')
      setOpenCode('')
      setNotice({
        kind: 'ok',
        text: r.burned ? '已打开：中继密文已焚毁，正文在独立阅读窗中。' : '已打开：正文在独立阅读窗中；中继焚毁未确认，将按有效期自动删除。'
      })
      await api.openFlyReader(r.token)
    } catch (err) {
      setNotice({ kind: 'err', text: '打开失败：' + (err instanceof Error ? err.message : String(err)) })
    } finally {
      setOpening(false)
    }
  }

  const saveRelay = async () => {
    setRelaySaving(true)
    try {
      await api.flyRelaySetUrl(relayInput)
      const u = await api.flyRelayUrl()
      setRelay(u)
      setNotice({ kind: 'ok', text: u ? '中继已保存' : '中继已清空' })
    } catch (err) {
      setNotice({ kind: 'err', text: '保存失败：' + (err instanceof Error ? err.message : String(err)) })
    } finally {
      setRelaySaving(false)
    }
  }

  // 窗口级键盘：Esc 关闭；⌘↵ 生成 / 打开
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        window.close()
        return
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (tab === 'write') void compose()
        if (tab === 'read') void openLetter()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const modeInfo = MODES.find(m => m.v === mode)!
  const words = result?.code ? result.code.split(' ') : []
  const expired = result?.expiresAt ? result.expiresAt <= now : false

  return (
    <div className="h-screen flex flex-col bg-[var(--bg)] text-[var(--fg)]">
      <header className="drag-region flex items-center gap-3 pl-[76px] pr-4 py-3 border-b border-[var(--border)] bg-[var(--surface)] backdrop-blur shrink-0">
        <div className="w-2 h-2 rounded-full bg-[var(--ok)] shadow-[0_0_10px_var(--ok)]" />
        <div className="text-[15px] font-semibold tracking-wide">萤火密信</div>
        <div className="text-xs text-[var(--muted)]">一次性 · 无账号 · 无设备绑定 · 读后即焚</div>
        <nav className="no-drag ml-auto flex items-center gap-1 p-0.5 rounded-[var(--r-sm)] bg-[var(--hover)]">
          {(
            [
              ['write', '写'],
              ['read', '读'],
              ['channel', '通道']
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={
                'px-3 py-1 rounded-[calc(var(--r-sm)-2px)] text-xs transition-colors ' +
                (tab === k ? 'bg-[var(--surface-strong)] text-[var(--fg)] shadow-[var(--shadow-sm)]' : 'text-[var(--muted)] hover:text-[var(--fg)]')
              }
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {notice && (
        <div
          className="px-5 py-2 text-xs border-b shrink-0"
          style={{
            background: notice.kind === 'err' ? 'var(--danger-soft)' : notice.kind === 'ok' ? 'var(--ok-soft)' : 'var(--info-soft)',
            borderColor: 'var(--border)',
            color: notice.kind === 'err' ? 'var(--danger-ink)' : 'var(--fg)'
          }}
          aria-live="polite"
        >
          {notice.text}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        <div className="max-w-[760px] mx-auto px-6 py-6">
          {tab === 'write' && !result && (
            <div className="space-y-4">
              <section className="rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  rows={9}
                  autoFocus
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  autoComplete="off"
                  placeholder="写给对方的话。不会上传明文，也不会在本地落盘。"
                  className="w-full resize-none bg-transparent outline-none text-[15px] leading-[1.85] placeholder:text-[var(--faint)]"
                />
                <div className="flex items-center justify-between pt-3 mt-1 border-t border-[var(--border-soft)]">
                  <span className={'text-[11px] ' + (tooLong ? 'text-[var(--danger)]' : 'text-[var(--faint)]')}>
                    {bytes.toLocaleString()} / 40,000 字节 · 按档位填充后加密，长度不外泄
                  </span>
                  <span className="text-[11px] text-[var(--faint)]">⌘↵ 生成</span>
                </div>
              </section>

              <section>
                <div className="text-xs text-[var(--muted)] mb-2">打开方式</div>
                <div className="grid grid-cols-3 gap-2">
                  {MODES.map(m => (
                    <button
                      key={m.v}
                      onClick={() => setMode(m.v)}
                      className={
                        'text-left rounded-[var(--r-md)] border p-3 transition-colors ' +
                        (mode === m.v
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                          : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--hover)]')
                      }
                    >
                      <div className="text-[13px] font-medium">{m.title}</div>
                      <div className="text-[11px] leading-relaxed text-[var(--muted)] mt-1">{m.sub}</div>
                    </button>
                  ))}
                </div>
              </section>

              <section className="flex items-center gap-3 flex-wrap">
                <span className="text-xs text-[var(--muted)]">有效期</span>
                <div className="flex items-center gap-1 p-0.5 rounded-[var(--r-sm)] bg-[var(--hover)]">
                  {TTL_OPTIONS.map(o => (
                    <button
                      key={o.v}
                      onClick={() => setTtl(o.v)}
                      className={
                        'px-2.5 py-1 rounded-[calc(var(--r-sm)-2px)] text-[11px] ' +
                        (ttl === o.v ? 'bg-[var(--surface-strong)] text-[var(--fg)] shadow-[var(--shadow-sm)]' : 'text-[var(--muted)]')
                      }
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-[var(--faint)]">到期由中继删除；客户端也拒绝解密过期信</span>
              </section>

              <button
                onClick={() => void compose()}
                disabled={busy || !text.trim() || tooLong}
                className="w-full py-3 rounded-[var(--r-md)] text-sm font-medium bg-[var(--accent)] text-[var(--on-accent)] hover:opacity-90 disabled:opacity-40 transition-opacity"
              >
                {busy ? '加密并投递中…' : '生成密信 · ' + modeInfo.title}
              </button>

              {!relay && (
                <button
                  onClick={() => setTab('channel')}
                  className="w-full text-xs text-[var(--warn-ink)] bg-[var(--warn-soft)] rounded-[var(--r-sm)] px-3 py-2 text-left"
                >
                  还没有配置中继通道 —— 点这里填入地址（自建方法见 relay/README.md）
                </button>
              )}

              <p className="text-[11px] leading-relaxed text-[var(--faint)] px-1">
                不采集账号、邮箱、设备指纹。每封信使用独立随机信箱号，读完即弃；两封信之间没有可关联的标识。
                口令由本机安全随机生成，不接受自选弱密码 —— 这是抗暴力破解的关键。
              </p>
            </div>
          )}

          {tab === 'write' && result && (
            <div className="space-y-4">
              <section className="rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[var(--ok)]" />
                  <div className="text-sm font-medium">密信已生成</div>
                  <div className="ml-auto text-[11px] text-[var(--faint)]">
                    {expired ? '已过期' : '剩余 ' + fmtLeft((result.expiresAt ?? 0) - now)}
                  </div>
                </div>

                {result.link && (
                  <div className="mt-4">
                    <div className="text-[11px] text-[var(--muted)] mb-1">发给对方（任意渠道）</div>
                    <div className="flex gap-2 items-start">
                      <code className="flex-1 text-[11px] leading-relaxed break-all bg-[var(--bg-soft)] rounded-[var(--r-sm)] p-2.5 select-text">
                        {result.link}
                      </code>
                      <button
                        onClick={() => void copy(result.link!, '链接')}
                        className="px-3 py-1.5 rounded-[var(--r-sm)] text-xs bg-[var(--accent)] text-[var(--on-accent)] hover:opacity-90 whitespace-nowrap"
                      >
                        复制
                      </button>
                    </div>
                    {result.mode === 'link-code' && (
                      <div className="text-[11px] text-[var(--faint)] mt-1.5">
                        这条链接本身打不开——必须配合下面的 6 个词。两条信道不要走同一条路。
                      </div>
                    )}
                  </div>
                )}

                {words.length > 0 && (
                  <div className="mt-4">
                    <div className="text-[11px] text-[var(--muted)] mb-1.5">
                      {result.mode === 'code' ? '口头告诉对方这 6 个词（不要打字发出去）' : '口头 / 当面告诉对方这 6 个词'}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {words.map((w, i) => (
                        <span
                          key={i}
                          className="px-2.5 py-1.5 rounded-[var(--r-sm)] bg-[var(--bg-soft)] border border-[var(--border)] font-mono text-[13px] tracking-wide select-text"
                        >
                          {w}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={() => void copy(result.code!, '口令')}
                        className="px-3 py-1.5 rounded-[var(--r-sm)] text-xs border border-[var(--border)] hover:bg-[var(--hover)]"
                      >
                        复制 6 个词
                      </button>
                      <span className="text-[11px] text-[var(--faint)]">只显示这一次；关闭窗口后本机不再保留</span>
                    </div>
                  </div>
                )}

                {result.mode === 'code' && result.portal && (
                  <div className="mt-4">
                    <div className="text-[11px] text-[var(--muted)] mb-1">对方打开这个网址，输入 6 个词</div>
                    <div className="flex gap-2 items-center">
                      <code className="flex-1 text-[11px] break-all bg-[var(--bg-soft)] rounded-[var(--r-sm)] p-2.5 select-text">
                        {result.portal}
                      </code>
                      <button
                        onClick={() => void copy(result.portal!, '网址')}
                        className="px-3 py-1.5 rounded-[var(--r-sm)] text-xs border border-[var(--border)] hover:bg-[var(--hover)] whitespace-nowrap"
                      >
                        复制
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-4 pt-3 border-t border-[var(--border-soft)] text-[11px] leading-relaxed text-[var(--faint)]">
                  中继看到的只有：随机信箱号、定长密文、有效期。看不到正文、看不到你是谁，也无法把两封信关联起来。
                  {result.sealedBytes ? ' 密文 ' + Math.ceil(result.sealedBytes / 1024) + ' KB。' : ''}
                </div>
              </section>

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setResult(null)
                    setText('')
                  }}
                  className="flex-1 py-2.5 rounded-[var(--r-md)] text-sm border border-[var(--border)] hover:bg-[var(--hover)]"
                >
                  再写一封
                </button>
                <button
                  onClick={() => {
                    setResult(null)
                    setTab('read')
                  }}
                  className="flex-1 py-2.5 rounded-[var(--r-md)] text-sm bg-[var(--accent)] text-[var(--on-accent)] hover:opacity-90"
                >
                  去读一封
                </button>
              </div>
            </div>
          )}

          {tab === 'read' && (
            <div className="space-y-4">
              <section className="rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
                <div className="text-sm font-medium">打开一封密信</div>
                <div className="text-[11px] text-[var(--muted)] mt-1 leading-relaxed">
                  链接、32 位信箱号、或 6 个词，任填其一。成功打开后中继立即焚毁，正文进入防截屏阅读窗。
                </div>
                <textarea
                  ref={openInputRef}
                  value={openInput}
                  onChange={e => setOpenInput(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="https://…/r/… 或一张嘴说出来的 6 个词"
                  className="mt-3 w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2.5 text-[12px] font-mono leading-relaxed outline-none focus:border-[var(--accent)] resize-none"
                />
                <label className="block mt-3">
                  <span className="text-[11px] text-[var(--muted)]">口令（仅“链接 + 口令”时填；与上面重复可留空）</span>
                  <input
                    value={openCode}
                    onChange={e => setOpenCode(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="6 个词，用空格分开"
                    className="mt-1 w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-[13px] outline-none focus:border-[var(--accent)]"
                  />
                </label>
                <button
                  onClick={() => void openLetter()}
                  disabled={opening || !openInput.trim()}
                  className="mt-4 w-full py-2.5 rounded-[var(--r-md)] text-sm bg-[var(--accent)] text-[var(--on-accent)] hover:opacity-90 disabled:opacity-40"
                >
                  {opening ? '读取并解密中…' : '打开并焚毁'}
                </button>
              </section>

              <section className="rounded-[var(--r-md)] bg-[var(--info-soft)] px-4 py-3 text-[11px] leading-relaxed text-[var(--muted)]">
                没有账号也能收：对方把链接发到任何地方，你在这里粘贴即可。链接里的密钥在 # 之后，不会随请求上传；
                若用“链接 + 口令”，即使链接被网络中间人拿到，没有口头那 6 个词也解不开。
              </section>
            </div>
          )}

          {tab === 'channel' && (
            <div className="space-y-4">
              <section className="rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
                <div className="text-sm font-medium">中继通道</div>
                <div className="text-[11px] leading-relaxed text-[var(--muted)] mt-1">
                  中继只做两件事：暂存定长密文、按信箱号交付后删除。它没有账号体系，也没有你的任何身份信息。
                  可以用别人部署的，也可以一条命令自建（relay/README.md）。
                </div>
                <input
                  value={relayInput}
                  onChange={e => setRelayInput(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="https://linkto-fly.xxx.workers.dev"
                  className="mt-3 w-full rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-[13px] font-mono outline-none focus:border-[var(--accent)]"
                />
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={() => void saveRelay()}
                    disabled={relaySaving}
                    className="px-4 py-1.5 rounded-[var(--r-sm)] text-xs bg-[var(--accent)] text-[var(--on-accent)] hover:opacity-90 disabled:opacity-40"
                  >
                    {relaySaving ? '保存中…' : '保存'}
                  </button>
                  <span className="text-[11px] text-[var(--muted)]">{relay ? '当前：' + relay : '当前：未配置'}</span>
                </div>
              </section>

              <section className="rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)] p-5">
                <div className="text-sm font-medium">这封信为什么不需要“进入专门设备”</div>
                <ul className="mt-2 space-y-2 text-[12px] leading-relaxed text-[var(--muted)] list-disc pl-4">
                  <li>没有长期私钥：每封信现场生成密钥，读完即弃，换一台电脑也能读。</li>
                  <li>没有账号、邮箱、设备指纹参与加密；链接或口令就是全部凭证。</li>
                  <li>密钥不经过中继：链接模式下它在 # 之后，浏览器和应用都不会发送；口令模式下它只在你的输入框里。</li>
                  <li>代价：谁拿到完整链接（或链接 + 口令）谁就能读一次。所以链接本身就是“一次性钥匙”，请只发给该看的人。</li>
                </ul>
              </section>

              <section className="rounded-[var(--r-md)] bg-[var(--warn-soft)] px-4 py-3 text-[11px] leading-relaxed text-[var(--warn-ink)]">
                诚实边界：网页阅读页由中继提供，理论上中继运营方可替换页面来窃取 # 后的密钥；高敏感内容请用本应用打开。
                终端被木马/键盘记录器控制时，任何加密都无法保护屏幕上的明文。
              </section>
            </div>
          )}
        </div>
      </div>

      <footer className="shrink-0 px-5 py-2 border-t border-[var(--border)] text-[10px] text-[var(--faint)] flex items-center gap-3">
        <span>Esc 关闭</span>
        <span>⌘↵ 生成 / 打开</span>
        <span className="ml-auto">{relay ? '通道已就绪' : '未配置通道'}</span>
      </footer>
    </div>
  )
}
