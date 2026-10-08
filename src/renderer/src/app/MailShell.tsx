import { useEffect, useState } from 'react'
import { Sidebar } from './Sidebar'
import { MessageList } from './MessageList'
import { Reader } from './Reader'
import { KbView } from './KbView'
import { CommandPalette } from './CommandPalette'
import { useMail } from '../stores/mail'
import { api } from '../lib/api'
import { cycleTheme, themeLabel } from '../lib/theme'

export function MailShell() {
  const [kbMode, setKbMode] = useState(() => location.hash === '#/kb')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [toast, setToast] = useState('')

  useEffect(() => {
    const onHash = () => setKbMode(location.hash === '#/kb')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 全局 toast（主题 / 预设 / 命令面板反馈）
  useEffect(() => {
    const onToast = (e: Event) => {
      setToast((e as CustomEvent<string>).detail)
      setTimeout(() => setToast(''), 2200)
    }
    window.addEventListener('ms:toast', onToast)
    return () => window.removeEventListener('ms:toast', onToast)
  }, [])

  // 侧栏 ⌘K 按钮等入口
  useEffect(() => {
    const onToggle = () => setPaletteOpen(o => !o)
    window.addEventListener('ms:toggle-palette', onToggle)
    return () => window.removeEventListener('ms:toggle-palette', onToggle)
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
      {kbMode ? <KbView /> : (
        <>
          <MessageList />
          <Reader />
        </>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full glass-strong border border-[var(--glass-border)] text-[13px] shadow-[var(--shadow-sm)] fade-in" style={{ color: 'var(--fg)' }}>
          {toast}
        </div>
      )}
    </div>
  )
}
