import { useMemo, useState } from 'react'
import { useMail, type Scope } from '../stores/mail'
import { api } from '../lib/api'
import { ThemeMenu } from './ThemeMenu'
import {
  IconInbox, IconLayers, IconStar, IconUser, IconBell, IconRss, IconTrash,
  IconBook, IconFolder, IconCompose, IconSettings, IconChevronDown,
  IconChevronRight
} from '../components/icons'
import type { SpecialFolder } from '@shared/types'

/** 侧边栏 —— OpenFlow 玻璃侧栏（admin sidebar 交互：激活项 accent-soft 底 + 3px 左侧 accent 条） */
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
      className={`relative w-full flex items-center gap-2 px-3 py-[6px] rounded-[10px] text-[13px] transition-colors ${
        props.active ? 'font-medium' : 'hover:bg-[var(--hover)]'
      }`}
      style={{
        paddingLeft: props.indent ? 12 + props.indent * 16 : undefined,
        background: props.active ? 'var(--accent-soft)' : undefined,
        color: props.active ? 'var(--accent-strong)' : 'var(--fg)'
      }}
    >
      {props.active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-[16px] rounded-[3px]" style={{ background: 'var(--accent)' }} />
      )}
      <span className="shrink-0" style={{ color: props.active ? 'var(--accent)' : props.color ?? 'var(--faint)' }}>
        {props.color ? (
          <span className="inline-block w-[9px] h-[9px] rounded-full" style={{ background: props.color }} />
        ) : (
          props.icon
        )}
      </span>
      <span className="flex-1 text-left truncate">{props.label}</span>
      {!!props.unread && props.unread > 0 && (
        <span
          className="text-[11px] tabular-nums px-1.5 rounded-full"
          style={props.active ? { background: 'var(--accent)', color: 'var(--on-accent)' } : { background: 'var(--bg-soft)', color: 'var(--muted)' }}
        >
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
        className="w-full flex items-center gap-1 px-3 py-1 text-[10.5px] font-semibold tracking-[.08em] uppercase hover:opacity-80"
        style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}
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
    <div className="glass w-[248px] shrink-0 h-full flex flex-col border-r border-[var(--border-soft)]">
      <div className="drag-region h-[52px] shrink-0 flex items-end pl-[76px] pb-1">
        <span className="text-[12.5px] font-semibold tracking-wide" style={{ color: 'var(--muted)', fontFamily: 'var(--font-display)' }}>
          Mail Studio
        </span>
      </div>
      <div className="px-2 pb-2">
        <button
          onClick={() => api.openCompose()}
          className="no-drag w-full flex items-center justify-center gap-1.5 py-2 rounded-[var(--r-sm)] text-[13px] font-semibold active:scale-[.97] transition-all duration-200"
          style={{
            background: 'var(--accent)',
            color: 'var(--on-accent)',
            boxShadow: '0 4px 16px var(--accent-soft)',
            fontFamily: 'var(--font-display)'
          }}
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
        <div className="mt-3 px-3 pb-1 text-[10.5px] font-semibold tracking-[.08em] uppercase" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
          智能视图
        </div>
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
                <div className="px-3 py-1 text-[12px]" style={{ color: 'var(--faint)' }}>
                  {acc.status === 'error' ? acc.statusText || '连接失败' : '同步中…'}
                </div>
              )}
            </AccountGroup>
          )
        })}

        {!accounts.length && (
          <div className="mt-6 px-3 text-[12.5px] leading-relaxed" style={{ color: 'var(--faint)' }}>
            还没有账户。
            <button
              className="block mt-2 hover:underline"
              style={{ color: 'var(--accent)' }}
              onClick={() => api.openSettings('accounts')}
            >
              添加第一个邮箱 →
            </button>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-[var(--border-soft)] px-2 py-2 flex items-center gap-1">
        <ThemeMenu />
        <button
          onClick={() => void loadAccounts()}
          title="刷新账户状态"
          className="p-2 rounded-lg hover:bg-[var(--hover)] transition-colors"
          style={{ color: 'var(--faint)' }}
        >
          <IconLayers width={15} height={15} />
        </button>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('ms:toggle-palette'))}
          title="命令面板（⌘K）"
          className="p-2 rounded-lg hover:bg-[var(--hover)] transition-colors text-[11px] font-medium"
          style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}
        >
          ⌘K
        </button>
        <div className="flex-1" />
        <button
          onClick={() => api.openSettings()}
          title="设置（⌘,）"
          className="p-2 rounded-lg hover:bg-[var(--hover)] transition-colors"
          style={{ color: 'var(--faint)' }}
        >
          <IconSettings width={15} height={15} />
        </button>
      </div>
    </div>
  )
}

export type { SpecialFolder }
