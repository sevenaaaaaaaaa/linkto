import { useEffect, useState } from 'react'
import { Sidebar } from './Sidebar'
import { MessageList } from './MessageList'
import { Reader } from './Reader'
import { KbView } from './KbView'
import { useMail } from '../stores/mail'
import { api } from '../lib/api'

export function MailShell() {
  const [kbMode, setKbMode] = useState(() => location.hash === '#/kb')

  useEffect(() => {
    const onHash = () => setKbMode(location.hash === '#/kb')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
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
      } else if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
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
    </div>
  )
}
