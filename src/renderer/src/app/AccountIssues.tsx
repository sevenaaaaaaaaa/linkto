import { useState } from 'react'
import { useMail } from '../stores/mail'
import { api } from '../lib/api'
import { useConnectivityState } from '../lib/connectivity'
import { IconChevronDown, IconClose, IconRefresh } from '../components/icons'
import { classifyAccountError, type AccountErrorKind } from '@shared/errors'
import type { AccountWithStatus } from '@shared/types'

/**
 * 账户异常的统一呈现：侧栏底部同步状态（SyncStatus）、列表顶部细横幅（AccountErrorBanner）、账户栏悬停提示（accountHoverText）。
 * 按错误类别给主动作：auth → 重新登录；network → 重试；其他 → 查看详情（打开 设置 → 账户 并定位该账户）
 */

export function accountErrorKind(a: AccountWithStatus): AccountErrorKind {
  return a.errorKind ?? classifyAccountError(a.statusText)
}

const HEADLINE: Record<AccountErrorKind, string> = {
  auth: '需要重新登录',
  network: '连不上邮件服务器',
  server: '服务器拒绝了连接',
  tls: '加密连接失败',
  unknown: '同步出错'
}

export function accountErrorHeadline(a: AccountWithStatus): string {
  return HEADLINE[accountErrorKind(a)]
}

export interface AccountAction {
  label: string
  run(): void
}

export function accountErrorAction(a: AccountWithStatus): AccountAction {
  const kind = accountErrorKind(a)
  if (kind === 'auth')
    return {
      label: '重新登录',
      // OAuth：设置窗定位到该账户并直接发起重新授权；密码账户：定位并展开密码输入
      run: () => void api.openSettings(`accounts:${a.id}:${a.authType === 'oauth' ? 'reauth' : 'password'}`)
    }
  if (kind === 'network') return { label: '重试', run: () => void api.syncAccountNow(a.id) }
  return { label: '查看详情', run: () => void api.openSettings(`accounts:${a.id}`) }
}

/** 账户栏悬停提示：名称（邮箱）· 状态（出错时带类别与完整原因） */
export function accountHoverText(a: AccountWithStatus, shortcut?: string): string {
  const state =
    a.status === 'error'
      ? `${accountErrorHeadline(a)}：${a.statusText || '连接失败'}（${accountErrorAction(a).label}）`
      : a.status === 'syncing' ? '同步中' : a.status === 'disabled' ? '已停用' : '已同步'
  return `${a.name}（${a.email}）· ${state}${shortcut ? ` · ${shortcut}` : ''}`
}

function ActionButton(props: { action: AccountAction; primary?: boolean }) {
  return (
    <button
      onClick={e => {
        e.stopPropagation()
        props.action.run()
      }}
      className="no-drag shrink-0 h-6 px-2.5 rounded-[var(--r-sm)] text-xs font-medium transition-colors border"
      style={
        props.primary
          ? { background: 'var(--accent)', borderColor: 'transparent', color: 'var(--on-accent)' }
          : { background: 'var(--surface-strong)', borderColor: 'var(--border)', color: 'var(--fg)' }
      }
    >
      {props.action.label}
    </button>
  )
}

/** 单个出错账户：名称 + 类别标题，下面完整一句原因（最多两行），右下主动作 */
function IssueBlock(props: { account: AccountWithStatus; compact?: boolean }) {
  const a = props.account
  const action = accountErrorAction(a)
  return (
    <div className={props.compact ? 'py-1.5' : ''}>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: a.color }} />
        <span className="font-medium truncate" style={{ color: 'var(--fg)' }}>{a.name}</span>
        <span className="shrink-0" style={{ color: 'var(--danger-ink)' }}>· {accountErrorHeadline(a)}</span>
      </div>
      <div className="mt-0.5 flex items-end gap-2">
        <span className="flex-1 min-w-0 line-clamp-2 leading-snug" title={a.statusText} style={{ color: 'var(--muted)' }}>
          {a.statusText || '连接失败'}
        </span>
        <ActionButton action={action} primary={accountErrorKind(a) === 'auth'} />
      </div>
    </div>
  )
}

/** 侧栏底部同步状态：离线 > 账户出错 > 同步中 > 全部已同步 */
export function SyncStatus() {
  const { accounts, accountCtx, syncProgress } = useMail()
  const { online, pendingOps } = useConnectivityState()
  const [expanded, setExpanded] = useState(false)
  const list = accountCtx ? accounts.filter(a => a.id === accountCtx) : accounts
  if (!list.length) return null
  // 离线时网络类错误是离线的结果，不再逐个报
  const bad = list.filter(a => a.status === 'error' && !(!online && accountErrorKind(a) === 'network'))
  const busy = list.filter(a => a.status === 'syncing')
  const progress = list.map(a => syncProgress[a.id]).filter(Boolean)[0]

  if (!online || bad.length) {
    return (
      <div className="mx-2 mb-2 flex flex-col gap-1.5" aria-live="polite">
        {!online && (
          <div className="px-2.5 py-2 rounded-[var(--r-sm)] text-xs leading-snug" style={{ background: 'var(--warn-soft)' }}>
            <div className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--warn-ink)' }}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--warn)' }} />
              离线
              {pendingOps > 0 && <span className="ml-auto tnum font-normal">{pendingOps} 项待同步</span>}
            </div>
            <div className="mt-0.5" style={{ color: 'var(--muted)' }}>
              已缓存的邮件可以照常阅读，操作会在联网后同步{pendingOps > 0 ? `（${pendingOps} 项待同步）` : ''}
            </div>
          </div>
        )}
        {bad.length === 1 && (
          <div className="px-2.5 py-2 rounded-[var(--r-sm)] text-xs" style={{ background: 'var(--danger-soft)' }}>
            <IssueBlock account={bad[0]} />
          </div>
        )}
        {bad.length > 1 && (
          <div className="rounded-[var(--r-sm)] text-xs" style={{ background: 'var(--danger-soft)' }}>
            <button
              onClick={() => setExpanded(e => !e)}
              aria-expanded={expanded}
              className="w-full px-2.5 py-2 flex items-center gap-1.5 text-left font-medium"
              style={{ color: 'var(--danger-ink)' }}
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--danger)' }} />
              <span className="flex-1">{bad.length} 个账户需要处理</span>
              <IconChevronDown width={12} height={12} style={{ transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform .2s var(--ease-out)' }} />
            </button>
            {expanded && (
              <div className="px-2.5 pb-1.5 max-h-[240px] overflow-y-auto divide-y divide-[var(--border-soft)]">
                {bad.map(a => (
                  <IssueBlock key={a.id} account={a} compact />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const text = busy.length ? progress || '同步中…' : '全部已同步'
  return (
    <button
      onClick={() => list.forEach(a => void api.syncAccountNow(a.id))}
      title="立即同步"
      className="mx-2 mb-2 px-2.5 py-2 flex items-center gap-2 rounded-[var(--r-sm)] text-left text-xs hover:bg-[var(--hover)]"
      style={{ color: 'var(--faint)' }}
    >
      {busy.length ? (
        <IconRefresh width={12} height={12} className="spinning shrink-0" />
      ) : (
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: 'var(--ok)' }} />
      )}
      <span className="flex-1 min-w-0 truncate">{text}</span>
    </button>
  )
}

/**
 * 列表顶部细横幅：当前查看的账户出错时提示一次，可关闭（同一错误文本关闭后不再出现，错误变化后重新出现）。
 * 独立组件，MessageList 只需一处挂载
 */
const dismissed = new Set<string>()
export function AccountErrorBanner() {
  const accountCtx = useMail(st => st.accountCtx)
  const account = useMail(st => (st.accountCtx ? st.accounts.find(a => a.id === st.accountCtx) : undefined))
  const online = useConnectivityState(st => st.online)
  const [, force] = useState(0)
  if (!accountCtx || !account || account.status !== 'error') return null
  const kind = accountErrorKind(account)
  if (!online && kind === 'network') return null
  const key = `${account.id}\u0001${account.statusText}`
  if (dismissed.has(key)) return null
  const action = accountErrorAction(account)
  return (
    <div
      role="alert"
      className="shrink-0 mx-3 mt-2 pl-3 pr-1 py-1 flex items-center gap-2 rounded-[var(--r-sm)] text-xs fade-in"
      style={{ background: 'var(--danger-soft)', color: 'var(--danger-ink)' }}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--danger)' }} />
      <span className="flex-1 min-w-0 truncate" title={account.statusText}>
        <span className="font-medium">{accountErrorHeadline(account)}</span>
        <span style={{ color: 'var(--muted)' }}> · 列表显示的是已缓存的邮件</span>
      </span>
      <button
        onClick={action.run}
        className="shrink-0 h-6 px-2 rounded-[var(--r-sm)] font-medium hover:bg-[var(--hover-strong)]"
        style={{ color: 'var(--danger-ink)' }}
      >
        {action.label}
      </button>
      <button
        onClick={() => {
          dismissed.add(key)
          force(n => n + 1)
        }}
        title="关闭"
        aria-label="关闭"
        className="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded-[var(--r-sm)] hover:bg-[var(--hover-strong)]"
        style={{ color: 'var(--faint)' }}
      >
        <IconClose width={11} height={11} />
      </button>
    </div>
  )
}
