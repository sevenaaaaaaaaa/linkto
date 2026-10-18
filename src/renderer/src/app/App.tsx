import { useEffect, useState } from 'react'
import { useMail } from '../stores/mail'
import { useMailEvent } from '../lib/api'
import { MailShell } from './MailShell'
import { ComposeWindow } from './Compose'
import { GhostWindow } from './Ghost'
import { GhostRead } from './GhostRead'
import { parseComposePrefill } from '../preload/parse'
import type { ComposeDraft } from '@shared/types'

function route(): { name: 'mail' | 'compose' | 'ghost' | 'ghostread'; prefill?: Partial<ComposeDraft>; ghostId?: string } {
  const hash = location.hash
  if (hash.startsWith('#/compose')) {
    return { name: 'compose', prefill: parseComposePrefill() }
  }
  if (hash.startsWith('#/ghostread')) {
    const m = hash.match(/[?&]id=([^&]+)/)
    return { name: 'ghostread', ghostId: m ? decodeURIComponent(m[1]) : undefined }
  }
  if (hash.startsWith('#/ghost')) {
    return { name: 'ghost' }
  }
  return { name: 'mail' }
}

export default function App() {
  const [r, setR] = useState(route)
  const { loadAccounts, loadFolders, loadMessages, loadAccounts: reloadAccounts } = useMail()

  useEffect(() => {
    const onHash = () => setR(route())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    void (async () => {
      await loadAccounts()
      await loadFolders()
      await loadMessages()
    })()
  }, [loadAccounts, loadFolders, loadMessages])

  useMailEvent(ev => {
    if (ev.type === 'messages-changed') {
      void useMail.getState().loadMessages()
      void useMail.getState().loadFolders()
    }
    if (ev.type === 'account-status') {
      void reloadAccounts()
      // 状态流转（如 syncing → connected）常伴随新文件夹出现
      void useMail.getState().loadFolders()
    }
    if (ev.type === 'new-mail') {
      void useMail.getState().loadFolders()
    }
    // 点击系统通知：切到统一收件箱并选中该邮件（主进程只发给主窗口）
    if (ev.type === 'open-message' && ev.messageId) {
      if (location.hash !== '#/mail') location.hash = '#/mail'
      useMail.getState().setScope({ kind: 'unified', title: '统一收件箱' })
      const id = ev.messageId
      setTimeout(() => useMail.getState().select(id), 60)
    }
  })

  // 窗口聚焦时刷新账户与文件夹，避免多窗口 / 长时间闲置后的数据滞后
  useEffect(() => {
    const onFocus = () => {
      void reloadAccounts()
      void useMail.getState().loadFolders()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reloadAccounts])

  if (r.name === 'compose') {
    return <ComposeWindow prefill={r.prefill} />
  }
  if (r.name === 'ghost') {
    return <GhostWindow />
  }
  if (r.name === 'ghostread') {
    return r.ghostId ? <GhostRead id={r.ghostId} /> : null
  }
  return <MailShell />
}
