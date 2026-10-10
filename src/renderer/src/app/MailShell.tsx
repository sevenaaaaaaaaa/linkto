import { useEffect, useState } from 'react'
import { Sidebar } from './Sidebar'
import { MessageList } from './MessageList'
import { Reader } from './Reader'
import { KbView } from './KbView'
import { InsightsView } from './InsightsView'
import { AgentView } from './AgentView'
import { CommandPalette } from './CommandPalette'
import { useMail } from '../stores/mail'
import { api } from '../lib/api'
import { cycleTheme, themeLabel } from '../lib/theme'
import { IconClock } from '../components/icons'
import type { ScheduledSend } from '@shared/types'

type View = 'mail' | 'kb' | 'insights' | 'agent'

const viewFromHash = (): View =>
  location.hash.startsWith('#/kb')
    ? 'kb'
    : location.hash.startsWith('#/insights')
      ? 'insights'
      : location.hash.startsWith('#/agent')
        ? 'agent'
        : 'mail'

export function MailShell() {
  const [view, setView] = useState<View>(viewFromHash)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [outbox, setOutbox] = useState<ScheduledSend[]>([])

  const loadOutbox = () => void api.listScheduledSends().then(setOutbox)

  useEffect(() => {
    const onHash = () => setView(viewFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 全局 toast（主题 / 预设 / 命令面板反馈）+ 发件队列事件
  useEffect(() => {
    const onToast = (e: Event) => {
      setToast((e as CustomEvent<string>).detail)
      setTimeout(() => setToast(''), 2200)
    }
    window.addEventListener('ms:toast', onToast)
    return () => window.removeEventListener('ms:toast', onToast)
  }, [])

  useEffect(() => {
    loadOutbox()
    const onEv = (ev: unknown) => {
      const e = ev as { type: string; subject?: string; to?: string }
      if (e.type === 'outbox-changed') loadOutbox()
      if (e.type === 'mail-sent') {
        setToast(`已发送：${e.subject ?? ''}`)
        setTimeout(() => setToast(''), 2600)
      }
    }
    const off = api.onEvent(onEv)
    return () => void off()
  }, [])

  // 侧栏 ⌘K 按钮等入口
  useEffect(() => {
    const onToggle = () => setPaletteOpen(o => !o)
    window.addEventListener('ms:toggle-palette', onToggle)
    return () => window.removeEventListener('ms:toggle-palette', onToggle)
  }, [])

  // 全局指针跟随高光：为 [data-glow] 元素写入 --mx/--my，让光斑随鼠标在玻璃表面流动
  useEffect(() => {
    let raf = 0
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const el = (e.target as HTMLElement).closest?.('[data-glow]') as HTMLElement | null
        if (!el) return
        const r = el.getBoundingClientRect()
        el.style.setProperty('--mx', `${e.clientX - r.left}px`)
        el.style.setProperty('--my', `${e.clientY - r.top}px`)
      })
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      const meta = e.metaKey || e.ctrlKey

      if (meta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen(o => !o)
        return
      }
      if (meta && (e.key === 't' || e.key === 'T') && !typing) {
        e.preventDefault()
        const next = cycleTheme()
        window.dispatchEvent(new CustomEvent('ms:toast', { detail: `主题：${themeLabel(next)}` }))
        return
      }
      if (meta && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        void useMail.getState().loadAccounts()
        void useMail.getState().loadFolders()
        void useMail.getState().loadMessages()
        return
      }
      if (typing) return

      const state = useMail.getState()
      const idx = state.messages.findIndex(m => m.id === state.selectedId)
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        const next = state.messages[Math.min(idx + 1, state.messages.length - 1)]
        if (next) state.select(next.id)
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = state.messages[Math.max(idx - 1, 0)]
        if (prev) state.select(prev.id)
      } else if (e.key === 'r' && state.selectedId) {
        void api.openCompose({
          accountId: state.messages[idx]?.accountId,
          to: state.messages[idx]?.from ? [state.messages[idx].from!] : [],
          subject: `回复：${state.messages[idx]?.subject ?? ''}`,
          relatedMessageId: state.selectedId
        } as never)
      } else if (e.key === 'a' && state.selectedId) {
        void api.moveMessages([state.selectedId], 'archive').then(() => state.loadMessages())
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedId) {
        void api.deleteMessages([state.selectedId]).then(() => state.loadMessages())
      } else if (e.key === 'f' && meta) {
        e.preventDefault()
        ;(document.querySelector('input[placeholder="搜索邮件"]') as HTMLInputElement | null)?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="h-full flex">
      <Sidebar />
      {view === 'kb' ? <KbView /> : view === 'insights' ? <InsightsView /> : view === 'agent' ? <AgentView /> : (
        <>
          <MessageList />
          <Reader />
        </>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      {/* 发件队列（延迟 / 定时发送）：右下角浮条，可逐条撤销 */}
      {outbox.length > 0 && (
        <div className="fixed bottom-6 right-6 z-40 w-[300px] liquid-glass rounded-[var(--r-md)] p-2 pop-in">
          <div className="px-2 pt-1 pb-1.5 text-[10.5px] font-semibold tracking-[.08em] uppercase" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
            发件队列 · {outbox.length}
          </div>
          <div className="flex flex-col gap-0.5 max-h-[220px] overflow-y-auto">
            {outbox.map(s => (
              <div key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded-[10px]">
                <span className="leading-none shrink-0" style={{ color: 'var(--warn)' }}><IconClock width={14} height={14} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] truncate" style={{ color: 'var(--fg)' }}>{s.subject || '（无主题）'}</div>
                  <div className="text-[11px]" style={{ color: 'var(--faint)' }}>
                    {new Date(s.sendAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} → {s.to[0] ?? ''}
                  </div>
                </div>
                <button
                  onClick={() => void api.cancelScheduledSend(s.id)}
                  className="text-[11.5px] px-2 py-1 rounded-lg shrink-0 hover:bg-[var(--hover)]"
                  style={{ color: 'var(--danger)' }}
                >
                  撤销
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full liquid-glass text-[13px] fade-in" style={{ color: 'var(--fg)' }}>
          {toast}
        </div>
      )}
    </div>
  )
}
