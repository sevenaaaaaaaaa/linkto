import { useEffect, useState } from 'react'
import { api } from '../lib/api'

/**
 * 焚毁阅读窗（独立 BrowserWindow，主进程已开启 contentProtection 系统级防截屏/录屏）。
 * 信封在「打开阅读」成功那一刻已被主进程焚毁——本窗显示的是唯一一次阅读机会。
 */
export function GhostRead({ id }: { id: string }) {
  const [password, setPassword] = useState('')
  const [body, setBody] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [burned, setBurned] = useState(false)
  const [busy, setBusy] = useState(false)

  // 页面层禁复制：复制/剪切/选中/右键/拖拽全部拦截，打印快捷键屏蔽
  useEffect(() => {
    const block = (e: Event) => e.preventDefault()
    const keys = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && ['c', 'x', 'a', 's', 'p'].includes(e.key.toLowerCase())) e.preventDefault()
    }
    document.addEventListener('copy', block)
    document.addEventListener('cut', block)
    document.addEventListener('contextmenu', block)
    document.addEventListener('selectstart', block)
    document.addEventListener('dragstart', block)
    document.addEventListener('keydown', keys)
    return () => {
      document.removeEventListener('copy', block)
      document.removeEventListener('cut', block)
      document.removeEventListener('contextmenu', block)
      document.removeEventListener('selectstart', block)
      document.removeEventListener('dragstart', block)
      document.removeEventListener('keydown', keys)
    }
  }, [])

  // 关闭窗口前的最后提醒：信封已焚毁，这是唯一一次阅读
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (body !== null) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [body])

  const unlock = async () => {
    if (!password) return
    setBusy(true)
    const r = await api.ghostOpen(id, password)
    setBusy(false)
    if (r.ok && typeof r.body === 'string') {
      setBody(r.body)
      setBurned(true) // 主进程已在成功瞬间焚毁信封
    } else {
      setError(r.error ?? '打开失败')
    }
  }

  return (
    <div className="h-screen flex flex-col bg-[oklch(0.18_0.02_180)] text-[oklch(0.93_0.01_106)] select-none">
      <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-[oklch(0.7_0.12_180)]" />
        <div className="text-sm font-medium">幽灵信 · 焚毁阅读</div>
        <div className="text-[10px] text-white/40 ml-auto">
          {burned ? '信封已焚毁 · 关闭后不可再看 · 本窗已禁止截屏与复制' : '未开信前密文不可读'}
        </div>
      </div>

      {body === null ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8">
          <div className="text-center">
            <div className="text-sm text-white/70 mb-1">这封信需要你的幽灵私钥 + 口令才能打开</div>
            <div className="text-xs text-white/40">口令由发件人另行告知 · 口令错误不会销毁信封</div>
          </div>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={e => {
              setPassword(e.target.value)
              setError('')
            }}
            onKeyDown={e => e.key === 'Enter' && void unlock()}
            placeholder="输入打开口令"
            className="w-72 px-3 py-2.5 rounded-xl bg-white/8 border border-white/15 text-sm text-center outline-none focus:border-[oklch(0.7_0.12_180)]"
          />
          {error && <div className="text-xs text-red-400">{error}</div>}
          <button
            onClick={() => void unlock()}
            disabled={busy || !password}
            className="px-5 py-2 rounded-xl text-sm bg-[oklch(0.45_0.09_180)] text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy ? '解密中…' : '解密阅读（阅后即焚）'}
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-8 py-5">
          <div className="text-[15px] leading-[1.9] whitespace-pre-wrap font-light max-w-2xl mx-auto">{body}</div>
        </div>
      )}

      <div className="px-5 py-2.5 border-t border-white/10 text-[10px] text-white/35">
        阅后即焚：此信密文已在解密成功时销毁。截屏/录屏中本窗口显示为黑块；请勿用其他设备拍摄屏幕。
      </div>
    </div>
  )
}