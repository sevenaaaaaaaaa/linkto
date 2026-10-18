import type { MessageFull } from '@shared/types'
import { useMail } from '../../stores/mail'
import { MenuButton } from '../../components/Menu'
import { followMessage, followupsFor, openFollowups, useFollowupEvents, useFollowups } from '../../lib/followups'
import { FollowupActions, StatusPill, timeLine } from './FollowupBoard'

/**
 * 阅读页「跟进」关联条（参照「款项」关联条）：这封已发邮件 / 这个会话登记过跟进时显示状态、在等什么与操作；
 * 自己发出、还没登记的邮件给一个克制的「没回提醒我」。
 */
export function FollowupStrip(props: { msg: MessageFull }) {
  useFollowupEvents()
  const items = useFollowups(st => st.items)
  const folders = useMail(st => st.folders)
  const accounts = useMail(st => st.accounts)
  const { msg } = props
  const linked = followupsFor(items, msg)
  const inSent = folders.some(f => f.id === msg.folderId && f.special === 'sent')
  const fromMe = !!msg.from && accounts.some(a => a.email.toLowerCase() === msg.from!.address.toLowerCase())
  if (!linked.length && !(inSent || fromMe)) return null
  return (
    <div className="shrink-0 px-6 pt-3 flex flex-col gap-1.5 text-xs">
      {linked.slice(0, 2).map(f => (
        <div key={f.id} className="flex flex-wrap items-center gap-1.5 min-w-0">
          <span style={{ color: 'var(--faint)' }}>跟进</span>
          <StatusPill status={f.data.status} />
          <button onClick={() => openFollowups(f.id)} className="min-w-0 max-w-[320px] truncate hover:underline underline-offset-2" style={{ color: 'var(--fg)' }} title="在「等待对方」里查看">
            {f.data.ask || f.data.subject}
          </button>
          <span className="tnum" style={{ color: f.data.status === 'overdue' ? 'var(--danger-ink)' : 'var(--faint)' }}>{timeLine(f)}</span>
          <div className="flex-1" />
          <FollowupActions f={f} size="xs" />
        </div>
      ))}
      {!linked.length && (
        <div className="flex items-center gap-1.5">
          <span style={{ color: 'var(--faint)' }}>跟进</span>
          <MenuButton
            title="对方 N 天还没回就提醒我，并起草一封催促（不会自动发送）"
            align="left"
            width={160}
            items={[{ kind: 'label', label: '几天没回提醒我' }, ...[1, 3, 5, 7].map(n => ({ kind: 'action' as const, label: `${n} 天`, onSelect: () => void followMessage(msg.id, { waitDays: n }) }))]}
            className="h-6 px-2 rounded-[var(--r-xs)] border border-dashed border-[var(--border-strong)] hover:bg-[var(--hover)] text-xs"
          >
            + 没回提醒我
          </MenuButton>
        </div>
      )}
    </div>
  )
}
