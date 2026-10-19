import type { MessageFull } from '@shared/types'
import { TRACE_STATUS_LABEL } from '@shared/trace'
import type { MenuItem } from '../../components/Menu'
import { openTrace, STATUS_TONE, traceFromMessage, useTrace, useTraceEvents } from '../../lib/trace'
import { Chip } from '../finance/ui'
import { IconTrace } from './icons'

/**
 * 阅读页「留痕」关联条：这封邮件是某条留痕的来源 / 书面确认的回信时显示状态，点一下去留痕。
 * 不关联的邮件不显示（「记为留痕」在更多菜单里）。
 */
export function TraceStrip(props: { msg: MessageFull }) {
  useTraceEvents()
  const records = useTrace(st => st.records)
  const id = props.msg.id
  const linked = records.filter(r => r.data.links.messageIds.includes(id) || r.data.confirm?.replyMessageId === id)
  if (!linked.length) return null
  return (
    <div className="shrink-0 px-6 pt-3 flex flex-wrap items-center gap-1.5 text-xs">
      <span style={{ color: 'var(--faint)' }}>留痕</span>
      {linked.slice(0, 3).map(r => {
        const isReply = r.data.confirm?.replyMessageId === id
        return (
          <button
            key={r.id}
            onClick={() => openTrace(r.id)}
            className="h-6 px-2 rounded-[var(--r-xs)] border border-[var(--border)] hover:bg-[var(--hover)] inline-flex items-center gap-1.5 max-w-[360px]"
            style={{ color: 'var(--fg)' }}
            title={isReply ? '这封是书面确认的回信' : '这封邮件记在这条留痕里'}
          >
            <IconTrace width={12} height={12} style={{ color: 'var(--muted)' }} />
            <span className="truncate">{r.title}</span>
            <Chip tone={STATUS_TONE[r.data.status]}>{isReply ? (r.data.confirm?.verdict === 'disputed' ? '回信有异议' : '回信已确认') : TRACE_STATUS_LABEL[r.data.status]}</Chip>
          </button>
        )
      })}
    </div>
  )
}

/** 阅读页更多菜单：记为留痕 */
export function traceMenuItems(msg: MessageFull): MenuItem[] {
  return [{ kind: 'action', label: '记为留痕', icon: <IconTrace width={13} height={13} />, onSelect: () => void traceFromMessage(msg.id) }]
}

/** 侧栏「留痕」：角标 = 有异议的条数（行组件由侧栏提供） */
export function TraceNavRow(props: { render(label: string, count: number): React.ReactNode }) {
  return <>{props.render('留痕', useTraceBadge())}</>
}

/** 侧栏角标：有异议的留痕 */
export function useTraceBadge(): number {
  useTraceEvents()
  const records = useTrace(st => st.records)
  return records.filter(r => r.data.status === 'disputed').length
}
