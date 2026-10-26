import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'

/**
 * 萤火密信阅读窗（独立 BrowserWindow，主进程已 setContentProtection(true)）。
 *
 * 正文通过一次性 token 从主进程内存取走，token 随即失效；本窗不读写任何存储，
 * 关闭即销毁。页面层再拦一层复制 / 右键 / 打印，减少顺手留存。
 */
export function FlyRead({ token }: { token: string }) {
  const [body, setBody] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'empty'>('loading')
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    // token 只用于这一次取件：先从地址栏抹掉，避免刷新/前进后退重复暴露
    if (location.hash.includes('token=')) history.replaceState(null, '', '#/flyread')
    void api
      .flyTake(token)
      .then(r => {
        if (r.ok && typeof r.text === 'string') {
          setBody(r.text)
          setState('ready')
        } else {
          setState('empty')
        }
      })
      .catch(() => setState('empty'))
    // 不在 effect 清理里丢弃：React StrictMode 的双次挂载会与取件竞争；
    // 主进程在阅读窗关闭时已调用 fly.drop 兜底。
  }, [token])

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

  // 关闭即销毁：不做 beforeunload 拦截（Electron 会因此让红绿灯关不掉窗口）。
  // 正文没有“未保存”的概念，关掉就是永久丢弃。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setBody(null)
        window.close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const close = () => {
    setBody(null)
    window.close()
  }

  return (
    <div className="h-screen flex flex-col bg-[var(--rail-bg)] text-[var(--rail-fg)] select-none">
      <header className="drag-region pl-[76px] pr-5 py-3 border-b border-[var(--rail-line)] flex items-center gap-2 shrink-0">
        <div className="no-drag w-2 h-2 rounded-full bg-[var(--ok)] shadow-[0_0_10px_var(--ok)]" />
        <div className="no-drag text-sm font-medium">萤火密信 · 一次性阅读</div>
        <div className="no-drag text-[10px] text-[var(--rail-muted)] ml-auto">
          {state === 'ready' ? '密文已焚毁 · 关闭后不可再看 · 已禁止截屏与复制' : '未开信前密文不可读'}
        </div>
      </header>

      {state === 'loading' ? (
        <div className="flex-1 flex items-center justify-center text-sm text-[var(--rail-muted)]">取件中…</div>
      ) : state === 'empty' ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8">
          <div className="text-sm text-[var(--rail-fg)]">这封信已经被取走、焚毁或过期</div>
          <div className="text-xs text-[var(--rail-muted)]">一次性取件号只能使用一次，本窗不再保留任何内容。</div>
          <button onClick={close} className="px-4 py-2 rounded-[var(--r-sm)] text-sm bg-[var(--rail-fg)] text-[var(--rail-bg)]">
            关闭
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-8 py-6">
          <div className="max-w-2xl mx-auto text-[15px] leading-[1.95] font-light whitespace-pre-wrap break-words">
            {body}
          </div>
        </div>
      )}

      <footer className="shrink-0 px-5 py-2.5 border-t border-[var(--rail-line)] text-[10px] text-[var(--rail-muted)] flex items-center gap-3">
        <span>正文只在内存中，关闭即销毁</span>
        <span>截屏 / 录屏中本窗口显示为黑块</span>
        <button
          onClick={close}
          className="ml-auto px-3 py-1 rounded-[var(--r-sm)] text-xs border border-[var(--rail-line)] hover:bg-white/10"
        >
          关闭并销毁
        </button>
      </footer>
    </div>
  )
}
