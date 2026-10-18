import { effectiveStatus } from '@shared/finance'
import { api } from '../../lib/api'
import { goView } from '../../lib/route'
import { useMail } from '../../stores/mail'
import { daysUntil, fmtDay, type FinanceRec } from '../../lib/finance'
import { Chip, KindTag, Money, StatusChip, miniBtn } from './ui'

/** 跳回邮件：切到邮件视图并选中 */
export function openMail(id: string) {
  goView('mail')
  useMail.getState().select(id)
}

export interface RowActions {
  onOpen(id: string): void
  onPaid(id: string, paid: boolean): void
  onTodo(id: string): void
}

/** 款项行（账单 / 概览 / 日历议程共用）：标题 · 对方 · 标签 | 金额 | 到期 | 快捷动作 */
export function RecRow(props: { r: FinanceRec; now: number; actions: RowActions; active?: boolean; dueLabel?: string; compact?: boolean }) {
  const { r, now } = props
  const d = r.data
  const st = effectiveStatus(d, r.dueAt, now)
  const open = st === 'pending' || st === 'overdue'
  const dueIn = r.dueAt ? daysUntil(r.dueAt, now) : null
  return (
    <div
      onClick={() => props.actions.onOpen(r.id)}
      className="group flex items-center gap-3 px-3.5 py-2.5 rounded-[var(--r-md)] border cursor-default hover:border-[var(--border-strong)]"
      style={{ background: 'var(--surface-strong)', borderColor: props.active ? 'var(--fg)' : 'var(--border)' }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <KindTag kind={d.kind} />
          <span className="text-sm truncate" style={{ color: 'var(--fg)', fontWeight: st === 'overdue' ? 600 : 500 }}>{r.title}</span>
        </div>
        <div className="relative mt-1 flex items-center gap-1.5 text-2xs min-w-0 min-h-5" style={{ color: 'var(--faint)' }}>
          {!props.compact && (
            <span className="flex flex-wrap items-center gap-1.5 min-w-0">
              <span className="truncate max-w-[180px]">{d.counterparty}</span>
              <StatusChip status={st} kind={d.kind} />
              {d.category && <Chip>{d.category}</Chip>}
              {d.matchId && <Chip tone="info" title="已与发票 / 付款 / 回单配对">已配对</Chip>}
              {d.todoId && <Chip title="已生成提醒待办">☐ 已建待办</Chip>}
              {d.source === 'ai' && <Chip tone="ai">AI 识别</Chip>}
              {d.messageIds.length > 1 && <Chip title="关联邮件数">{d.messageIds.length} 封邮件</Chip>}
            </span>
          )}
          {/* 快捷动作：悬停时出现在元信息行尾，不占金额列 */}
          <span className="absolute right-0 top-1/2 -translate-y-1/2 pl-3 hidden group-hover:flex group-focus-within:flex items-center gap-1" style={{ background: 'linear-gradient(90deg, transparent, var(--surface-strong) 12px)' }} onClick={e => e.stopPropagation()}>
            {open && d.kind !== 'subscription' && (
              <button className={miniBtn} style={{ color: 'var(--fg)' }} onClick={() => props.actions.onPaid(r.id, true)}>
                {d.direction === 'in' ? '标记已收' : '标记已付'}
              </button>
            )}
            {open && !d.todoId && d.direction === 'out' && (
              <button className={miniBtn} style={{ color: 'var(--fg)' }} onClick={() => props.actions.onTodo(r.id)} title="生成一条到期提醒待办">
                提醒待办
              </button>
            )}
            {d.messageIds[0] && (
              <button className={miniBtn} style={{ color: 'var(--muted)' }} onClick={() => openMail(d.messageIds[d.messageIds.length - 1])} title="打开最近一封关联邮件">
                邮件 ↗
              </button>
            )}
          </span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.5 shrink-0 min-w-[96px]">
        <Money amount={d.amount} currency={d.currency} direction={d.direction} strike={st === 'refunded' || st === 'cancelled'} />
        <span className="text-2xs tnum" style={{ color: st === 'overdue' ? 'var(--danger-ink)' : dueIn != null && dueIn >= 0 && dueIn <= 3 && open ? 'var(--warn-ink)' : 'var(--faint)' }}>
          {props.dueLabel ?? (r.dueAt ? `${d.kind === 'subscription' ? '续费' : open ? '应付' : '到期'} ${fmtDay(r.dueAt, now)}` : d.paidAt ? `付于 ${fmtDay(d.paidAt, now)}` : '')}
        </span>
      </div>
    </div>
  )
}

/** 物流进度：下单 → 发货 → 派送 → 签收 */
export function LogisticsSteps(props: { r: FinanceRec }) {
  const d = props.r.data
  const steps: { key: string; label: string }[] = [
    { key: 'ordered', label: '下单' },
    { key: 'shipped', label: '发货' },
    { key: 'in_transit', label: '派送' },
    { key: 'delivered', label: '签收' }
  ]
  const idx = steps.findIndex(s => s.key === (d.logistics ?? 'ordered'))
  const at = (k: string) => d.events?.find(e => e.kind === k)?.at
  return (
    <div className="flex items-center gap-0 w-full max-w-[360px]" aria-label="物流进度">
      {steps.map((s, i) => {
        const done = i <= idx && d.status !== 'refunded'
        const t = at(s.key)
        return (
          <div key={s.key} className="flex-1 flex flex-col items-center gap-1 relative">
            {i > 0 && <span className="absolute top-[4px] right-1/2 w-full h-px" style={{ background: i <= idx && d.status !== 'refunded' ? 'var(--fg)' : 'var(--border-strong)' }} />}
            <span className="relative z-[1] w-[9px] h-[9px] rounded-full border" style={{ background: done ? 'var(--fg)' : 'var(--surface-strong)', borderColor: done ? 'var(--fg)' : 'var(--border-strong)' }} />
            <span className="text-2xs" style={{ color: done ? 'var(--fg)' : 'var(--faint)' }}>{s.label}</span>
            <span className="text-2xs tnum h-3.5" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
              {t ? `${new Date(t).getMonth() + 1}/${new Date(t).getDate()}` : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export async function markPaid(id: string, paid: boolean) {
  await api.financeMarkPaid(id, paid)
}
