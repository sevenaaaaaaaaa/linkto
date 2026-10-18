import { effectiveStatus, FINANCE_KIND_LABEL } from '@shared/finance'
import type { MailInsight } from '@shared/types'
import { addMessageToFinance, fmtDay, fmtMoney, openFinance, useFinance, useFinanceEvents } from '../../lib/finance'

/**
 * 阅读页「款项」关联条（参照「关联待办」）：这封信属于哪笔钱，点一下去财务页；
 * 不属于任何款项、但读出了金额时，给一个克制的「加入财务」。
 */
export function FinanceStrip(props: { messageId: string; insight?: MailInsight; text?: string }) {
  useFinanceEvents()
  const records = useFinance(st => st.records)
  const linked = records.filter(r => r.data.messageIds?.includes(props.messageId))
  // 读出了金额（理解实体，或正文里带币种的数字）且不是订阅推送
  const hasMoney =
    props.insight?.bundle !== 'newsletter' &&
    (props.insight?.entities.some(e => e.kind === 'money') || /[¥￥$€£]\s?\d|\d\s?(元|RMB|CNY|USD|EUR)(?![A-Za-z])/.test((props.text ?? '').slice(0, 4000)))
  if (!linked.length && !hasMoney) return null
  return (
    <div className="shrink-0 px-6 pt-3 flex flex-wrap items-center gap-1.5 text-xs">
      <span style={{ color: 'var(--faint)' }}>款项</span>
      {linked.map(r => {
        const d = r.data
        const st = effectiveStatus(d, r.dueAt, Date.now())
        const tail =
          d.kind === 'subscription'
            ? r.dueAt && d.status !== 'cancelled'
              ? ` · ${fmtDay(r.dueAt)}续费`
              : ''
            : st === 'overdue'
              ? ' · 已逾期'
              : st === 'pending' && r.dueAt
                ? ` · ${fmtDay(r.dueAt)}到期`
                : st === 'paid'
                  ? ' · 已付'
                  : st === 'refunded'
                    ? ' · 已退款'
                    : ''
        return (
          <button
            key={r.id}
            onClick={() => openFinance(r.id)}
            className="h-6 px-2 rounded-[var(--r-xs)] border border-[var(--border)] hover:bg-[var(--hover)] inline-flex items-center gap-1.5"
            style={{ color: 'var(--fg)' }}
            title={`${r.title}（${d.messageIds.length} 封相关邮件）`}
          >
            {FINANCE_KIND_LABEL[d.kind]} · {d.counterparty.slice(0, 16)}
            {d.amount != null && <span className="tnum" style={{ fontFamily: 'var(--font-mono)' }}>{fmtMoney(d.amount, d.currency)}</span>}
            <span style={{ color: st === 'overdue' ? 'var(--danger-ink)' : 'var(--faint)' }}>{tail}</span>
          </button>
        )
      })}
      {!linked.length && (
        <button
          onClick={() => void addMessageToFinance(props.messageId)}
          className="h-6 px-2 rounded-[var(--r-xs)] border border-dashed border-[var(--border-strong)] hover:bg-[var(--hover)]"
          style={{ color: 'var(--muted)' }}
          title="把这封邮件记为一笔款项（账单 / 订阅 / 订单 / 发票…）"
        >
          + 加入财务
        </button>
      )}
    </div>
  )
}
