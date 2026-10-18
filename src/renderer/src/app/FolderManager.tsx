import { useEffect, useMemo, useState } from 'react'
import { useMail } from '../stores/mail'
import { api } from '../lib/api'
import { goView } from '../lib/route'
import { IconClose, IconSearch } from '../components/icons'
import { folderLabel, useFolderPrefs } from './Sidebar'
import type { Folder } from '@shared/types'

const SPECIAL_ORDER: Record<string, number> = { inbox: 0, sent: 1, archive: 2, junk: 3, trash: 4 }

/**
 * 管理文件夹：按账户列出全部文件夹。
 * 「常用」钉到侧栏；「同步」关掉后不再拉取该文件夹（省流量，收件箱不可关）。点名称直接打开。
 */
export function FolderManager() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const { accounts, folders, accountCtx, setScope } = useMail()
  const prefs = useFolderPrefs()

  useEffect(() => {
    const onOpen = () => {
      setQ('')
      setOpen(true)
    }
    window.addEventListener('ms:folders', onOpen)
    return () => window.removeEventListener('ms:folders', onOpen)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return accounts
      .filter(a => !accountCtx || a.id === accountCtx)
      .map(a => ({
        account: a,
        folders: folders
          .filter(f => f.accountId === a.id && (!needle || folderLabel(f).toLowerCase().includes(needle)))
          .sort((x, y) => (SPECIAL_ORDER[x.special ?? ''] ?? 9) - (SPECIAL_ORDER[y.special ?? ''] ?? 9) || x.path.localeCompare(y.path))
      }))
      .filter(g => g.folders.length)
  }, [accounts, folders, accountCtx, q])

  if (!open) return null

  const pref = (f: Folder) => ({ pinned: prefs[f.id]?.pinned ?? false, sync: prefs[f.id]?.sync ?? true })
  const toggle = async (f: Folder, key: 'pinned' | 'sync') => {
    await api.setFolderPref(f.id, { [key]: !pref(f)[key] })
    window.dispatchEvent(new CustomEvent('ms:folder-prefs'))
  }
  const openFolder = (f: Folder) => {
    goView('mail')
    setScope({ kind: 'folder', folderId: f.id, title: folderLabel(f) })
    setOpen(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] fade-in" style={{ background: 'var(--scrim)' }} onClick={() => setOpen(false)}>
      <div
        role="dialog"
        aria-label="管理文件夹"
        className="w-[600px] max-w-[92vw] max-h-[76vh] flex flex-col rounded-[var(--r-lg)] border border-[var(--border)] overflow-hidden pop-in"
        style={{ background: 'var(--surface-strong)', boxShadow: 'var(--shadow-float)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 h-14 shrink-0 flex items-center gap-3 border-b border-[var(--border)]">
          <span className="text-md font-semibold" style={{ color: 'var(--fg)' }}>管理文件夹</span>
          <label className="flex-1 h-8 px-2.5 flex items-center gap-2 rounded-[var(--r-sm)]" style={{ background: 'var(--bg-soft)', color: 'var(--faint)' }}>
            <IconSearch width={13} height={13} />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="查找文件夹" className="flex-1 bg-transparent outline-none text-sm" style={{ color: 'var(--fg)' }} />
          </label>
          <button onClick={() => setOpen(false)} aria-label="关闭" className="icon-btn w-8 h-8 inline-flex items-center justify-center" style={{ color: 'var(--muted)' }}>
            <IconClose width={14} height={14} />
          </button>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_64px_64px] px-4 h-8 items-center text-2xs shrink-0" style={{ color: 'var(--faint)' }}>
          <span>文件夹</span>
          <span className="text-center">常用</span>
          <span className="text-center">同步</span>
        </div>
        <div className="flex-1 overflow-y-auto pb-3">
          {groups.map(g => (
            <div key={g.account.id}>
              <div className="px-4 pt-3 pb-1 flex items-center gap-2 text-xs font-semibold" style={{ color: 'var(--muted)' }}>
                <span className="w-2 h-2 rounded-full" style={{ background: g.account.color }} />
                {g.account.name}
                <span className="font-normal" style={{ color: 'var(--faint)' }}>{g.account.email}</span>
              </div>
              {g.folders.map(f => {
                const p = pref(f)
                const depth = f.special ? 0 : Math.max(0, f.path.split(/[/.]/).length - 1 - (f.path.startsWith('Folders/') ? 1 : 0))
                return (
                  <div key={f.id} className="grid grid-cols-[minmax(0,1fr)_64px_64px] px-4 h-9 items-center hover:bg-[var(--hover)]">
                    <button onClick={() => openFolder(f)} className="min-w-0 text-left text-sm truncate" style={{ paddingLeft: depth * 14, color: p.sync ? 'var(--fg)' : 'var(--faint)' }}>
                      {folderLabel(f).split(' / ').pop()}
                      {f.total > 0 && <span className="ml-2 text-2xs tnum" style={{ color: 'var(--faint)' }}>{f.total.toLocaleString()}</span>}
                    </button>
                    <Check checked={p.pinned} label={`钉到侧栏：${folderLabel(f)}`} onChange={() => void toggle(f, 'pinned')} />
                    <Check checked={p.sync} label={`同步：${folderLabel(f)}`} disabled={f.special === 'inbox'} onChange={() => void toggle(f, 'sync')} />
                  </div>
                )
              })}
            </div>
          ))}
          {!groups.length && (
            <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--faint)' }}>
              {folders.length ? '没有匹配的文件夹' : '文件夹会在首次同步后出现'}
            </div>
          )}
        </div>
        <div className="px-4 py-2.5 shrink-0 border-t border-[var(--border)] text-xs leading-relaxed" style={{ color: 'var(--faint)' }}>
          关掉「同步」的文件夹不再下载新邮件，已下载的仍可查看；收件箱始终同步。
        </div>
      </div>
    </div>
  )
}

function Check(props: { checked: boolean; label: string; disabled?: boolean; onChange(): void }) {
  return (
    <span className="flex justify-center">
      <button
        role="checkbox"
        aria-checked={props.checked}
        aria-label={props.label}
        disabled={props.disabled}
        onClick={props.onChange}
        className="w-5 h-5 rounded-[var(--r-xs)] inline-flex items-center justify-center transition-colors disabled:opacity-40"
        style={{
          background: props.checked ? 'var(--accent)' : 'transparent',
          border: props.checked ? 'none' : '1.5px solid var(--border-strong)',
          color: 'var(--on-accent)'
        }}
      >
        {props.checked && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12l5 5 9-10" />
          </svg>
        )}
      </button>
    </span>
  )
}
