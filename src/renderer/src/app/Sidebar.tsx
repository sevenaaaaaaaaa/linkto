import { useMemo, useState } from 'react'
import { useMail, type Scope } from '../stores/mail'
import { api } from '../lib/api'
import {
  IconInbox, IconLayers, IconStar, IconUser, IconBell, IconRss, IconTrash,
  IconArchive, IconBook, IconFolder, IconCompose, IconSettings, IconChevronDown,
  IconChevronRight
} from '../components/icons'
import type { SpecialFolder } from '@shared/types'

function Row(props: {
  icon?: React.ReactNode
  label: string
  unread?: number
  active?: boolean
  indent?: number
  onClick(): void
  color?: string
}) {
  return (
    <button
      onClick={props.onClick}
      className={`w-full flex items-center gap-2 px-3 py-[6px] rounded-lg text-[13px] transition-colors ${
        props.active ? 'bg-blue-600/10 text-blue-700 font-medium' : 'text-zinc-700 hover:bg-black/5'
      }`}
      style={props.indent ? { paddingLeft: 12 + props.indent * 16 } : undefined}
    >
      <span className={`shrink-0 ${props.active ? 'text-blue-600' : 'text-zinc-400'}`}>
        {props.color ? (
          <span className="inline-block w-[9px] h-[9px] rounded-full" style={{ background: props.color }} />
        ) : (
          props.icon
        )}
      </span>
      <span className="flex-1 text-left truncate">{props.label}</span>
      {!!props.unread && props.unread > 0 && (
        <span className={`text-[11px] tabular-nums px-1.5 rounded-full ${props.active ? 'bg-blue-600 text-white' : 'bg-zinc-200 text-zinc-600'}`}>
          {props.unread > 99 ? '99+' : props.unread}
        </span>
      )}
    </button>
  )
}

function AccountGroup(props: { accountId: string; children: React.ReactNode; label: string }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1 px-3 py-1 text-[11px] font-medium text-zinc-400 hover:text-zinc-600"
      >
        {open ? <IconChevronDown width={12} height={12} /> : <IconChevronRight width={12} height={12} />}
        <span className="truncate">{props.label}</span>
      </button>
      {open && props.children}
    </div>
  )
}

const SPECIAL_LABEL: Record<string, string> = {
  inbox: '收件箱',
  sent: '已发送',
  drafts: '草稿',
  trash: '废纸篓',
  junk: '垃圾邮件',
  archive: '归档',
  all: '所有邮件'
}

export function Sidebar() {
  const { accounts, folders, scope, setScope, loadAccounts } = useMail()
  const [kbView, setKbView] = useState(false)

  const inboxUnread = useMemo(() => {
    const map: Record<string, number> = {}
    for (const f of folders) if (f.special === 'inbox') map[f.accountId] = (map[f.accountId] ?? 0) + f.unread
    return map
  }, [folders])

  const totalUnread = Object.values(inboxUnread).reduce((s, n) => s + n, 0)

  const is = (s: Partial<Scope>) =>
    scope.kind === s.kind &&
    scope.folderId === s.folderId &&
    scope.accountId === s.accountId &&
    scope.category === s.category

  const showKb = async () => {
    setKbView(true)
    setScope({ kind: 'unified', title: '知识库' })
    location.hash = '#/kb'
  }

  return (
    <div className="w-[248px] shrink-0 h-full flex flex-col bg-[#f0f0f3] border-r border-black/5">
      <div className="drag-region h-[52px] shrink-0 flex items-end pl-[76px] pb-1">
        <span className="text-[13px] font-semibold text-zinc-500">Mail Studio</span>
      </div>
      <div className="px-2 pb-2">
        <button
          onClick={() => api.openCompose()}
          className="no-drag w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-blue-600 text-white text-[13px] font-medium shadow-sm hover:bg-blue-700 active:scale-[.98] transition"
        >
          <IconCompose width={15} height={15} /> 写邮件
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        <Row
          icon={<IconInbox width={15} height={15} />}
          label="统一收件箱"
          unread={totalUnread}
          active={is({ kind: 'unified' })}
          onClick={() => {
            setKbView(false)
            location.hash = '#/mail'
            setScope({ kind: 'unified', title: '统一收件箱' })
          }}
        />
        <div className="mt-3 px-3 text-[11px] font-medium text-zinc-400">智能视图</div>
        <Row icon={<IconStar width={15} height={15} />} label="已加旗标" active={is({ kind: 'flagged' })} onClick={() => setScope({ kind: 'flagged', title: '已加旗标' })} />
        <Row icon={<IconUser width={15} height={15} />} label="个人邮件" active={is({ kind: 'category', category: 'personal' })} onClick={() => setScope({ kind: 'category', category: 'personal', title: '个人邮件' })} />
        <Row icon={<IconBell width={15} height={15} />} label="通知" active={is({ kind: 'category', category: 'notification' })} onClick={() => setScope({ kind: 'category', category: 'notification', title: '通知' })} />
        <Row icon={<IconRss width={15} height={15} />} label="Newsletter" active={is({ kind: 'newsletter' })} onClick={() => setScope({ kind: 'newsletter', title: 'Newsletter' })} />
        <Row icon={<IconTrash width={15} height={15} />} label="噪声" active={is({ kind: 'category', category: 'noise' })} onClick={() => setScope({ kind: 'category', category: 'noise', title: '噪声' })} />
        <Row icon={<IconBook width={15} height={15} />} label="知识库" active={kbView} onClick={showKb} />

        {accounts.map(acc => {
          const accFolders = folders.filter(f => f.accountId === acc.id && !f.hidden)
          const inbox = accFolders.filter(f => f.special === 'inbox')
          const others = accFolders.filter(f => f.special !== 'inbox' && f.special !== null)
          return (
            <AccountGroup key={acc.id} accountId={acc.id} label={acc.name}>
              {inbox.map(f => (
                <Row
                  key={f.id}
                  color={acc.color}
                  label={SPECIAL_LABEL[f.special ?? ''] ?? f.name}
                  unread={f.unread}
                  active={is({ kind: 'folder', folderId: f.id })}
                  onClick={() => setScope({ kind: 'folder', folderId: f.id, title: `${acc.name} · 收件箱` })}
                />
              ))}
              {others.length > 0 && (
                <div className="mt-0.5">
                  {others.map(f => (
                    <Row
                      key={f.id}
                      indent={1}
                      icon={<IconFolder width={13} height={13} />}
                      label={SPECIAL_LABEL[f.special ?? ''] ?? f.name}
                      unread={f.special === 'inbox' ? f.unread : 0}
                      active={is({ kind: 'folder', folderId: f.id })}
                      onClick={() => setScope({ kind: 'folder', folderId: f.id, title: `${acc.name} · ${f.name}` })}
                    />
                  ))}
                </div>
              )}
              {!accFolders.length && (
                <div className="px-3 py-1 text-[12px] text-zinc-400">
                  {acc.status === 'error' ? acc.statusText || '连接失败' : '同步中…'}
                </div>
              )}
            </AccountGroup>
          )
        })}

        {!accounts.length && (
          <div className="mt-6 px-3 text-[12.5px] leading-relaxed text-zinc-400">
            还没有账户。
            <button
              className="block mt-2 text-blue-600 hover:underline"
              onClick={() => api.openSettings('accounts')}
            >
              添加第一个邮箱 →
            </button>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-black/5 px-2 py-2 flex items-center gap-1">
        <button
          onClick={() => void loadAccounts()}
          title="刷新账户状态"
          className="p-2 rounded-lg text-zinc-400 hover:bg-black/5 hover:text-zinc-600"
        >
          <IconLayers width={15} height={15} />
        </button>
        <div className="flex-1" />
        <button
          onClick={() => api.openSettings()}
          title="设置（⌘,）"
          className="p-2 rounded-lg text-zinc-400 hover:bg-black/5 hover:text-zinc-600"
        >
          <IconSettings width={15} height={15} />
        </button>
      </div>
    </div>
  )
}

export type { SpecialFolder }
