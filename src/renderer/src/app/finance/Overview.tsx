import { useMemo } from 'react'
import { annualCost, effectiveStatus, itemAt } from '@shared/finance'
import { fmtMoney, sumByCurrency, daysUntil, fmtDay, type FinanceRec } from '../../lib/finance'
import { RecRow, LogisticsSteps, type RowActions } from './RecRow'
import { Chip, SectionTitle, Card } from './ui'

export type Tab = 'overview' | 'bills' | 'subs' | 'orders' | 'recon' | 'calendar'

const DAY = 864e5

/** 本月现金流（按币种，不换汇）：订阅按每期扣费事件计；对账组只计一次（付款优先于回单） */
export function monthFlows(recs: FinanceRec[], from: number, to: number) {
  const out: { amount: number; currency: string }[] = []
  const inflow: { amount: number; currency: string }[] = []
  const counted = new Set<string>()
  for (const r of recs) {
    const d = r.data
    if (d.kind === 'subscription') {
      for (const e of d.events ?? []) if (e.kind === 'renewed' && e.at >= from && e.at < to) out.push({ amount: e.amount ?? d.amount ?? 0, currency: d.currency })
      continue
    }
    if (d.status !== 'paid' || d.kind === 'refund' || d.kind === 'invoice') continue
    const t = d.paidAt ?? itemAt(r)
    if (t < from || t >= to || d.amount == null) continue
    if (d.matchId) {
      // 同一笔交易：有付款就只计付款，没有再计回单
      if (counted.has(d.matchId)) continue
      const peers = recs.filter(x => x.data.matchId === d.matchId)
      const pick = peers.find(x => x.data.kind === 'payment') ?? peers.find(x => x.data.kind === 'receipt') ?? r
      if (pick.id !== r.id) continue
      counted.add(d.matchId)
    }
    ;(d.direction === 'in' ? inflow : out).push({ amount: d.amount, currency: d.currency })
  }
  return { out: sumByCurrency(out), in: sumByCurrency(inflow) }
}

function Stat(props: { label: string; values: [string, number][]; hint?: string; tone?: 'danger' | 'in'; empty?: string }) {
  return (
    <Card className="px-4 py-3 min-w-0">
      <div className="caps" style={{ color: 'var(--faint)' }}>{props.label}</div>
      <div className="mt-1.5 flex flex-col gap-0.5 min-h-[28px]">
        {props.values.length ? (
          props.values.map(([cur, n], i) => (
            <span
              key={cur}
              className={`tnum ${i === 0 ? 'text-[22px] leading-7 font-semibold' : 'text-sm'}`}
              style={{ fontFamily: 'var(--font-mono)', color: props.tone === 'danger' ? 'var(--danger-ink)' : props.tone === 'in' ? 'var(--ok-ink)' : i === 0 ? 'var(--fg)' : 'var(--muted)', letterSpacing: '-0.02em' }}
            >
              {fmtMoney(n, cur, { compact: true })}
            </span>
          ))
        ) : (
          <span className="text-[22px] leading-7 font-semibold tnum" style={{ fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>{props.empty ?? '—'}</span>
        )}
      </div>
      {props.hint && <div className="mt-1 text-2xs" style={{ color: 'var(--faint)' }}>{props.hint}</div>}
    </Card>
  )
}

export function Overview(props: { recs: FinanceRec[]; idle: Set<string>; now: number; actions: RowActions; activeId: string | null; onTab(t: Tab): void }) {
  const { recs, now } = props
  const m = useMemo(() => {
    const d0 = new Date(now)
    const from = new Date(d0.getFullYear(), d0.getMonth(), 1).getTime()
    const to = new Date(d0.getFullYear(), d0.getMonth() + 1, 1).getTime()
    const flows = monthFlows(recs, from, to)
    const subs = recs.filter(r => r.data.kind === 'subscription' && r.data.status !== 'cancelled' && r.data.status !== 'refunded')
    const annual = sumByCurrency(subs.map(r => ({ amount: annualCost(r.data), currency: r.data.currency })))
    const monthly = annual.map(([c, n]) => [c, Math.round((n / 12) * 100) / 100] as [string, number])
    const overdue = recs.filter(r => effectiveStatus(r.data, r.dueAt, now) === 'overdue' && r.data.direction === 'out')
    const soon: { r: FinanceRec; at: number; label: string }[] = []
    for (const r of recs) {
      const d = r.data
      const st = effectiveStatus(d, r.dueAt, now)
      if (d.kind === 'subscription') {
        if (d.status === 'cancelled') continue
        if (d.trialEndsAt && d.trialEndsAt >= now - DAY && daysUntil(d.trialEndsAt, now) <= 7) soon.push({ r, at: d.trialEndsAt, label: `试用结束 ${fmtDay(d.trialEndsAt, now)}` })
        else if (r.dueAt && r.dueAt >= now - DAY && daysUntil(r.dueAt, now) <= 7) soon.push({ r, at: r.dueAt, label: `续费 ${fmtDay(r.dueAt, now)}` })
      } else if (st === 'pending' && r.dueAt && daysUntil(r.dueAt, now) >= 0 && daysUntil(r.dueAt, now) <= 7) {
        soon.push({ r, at: r.dueAt, label: `${d.direction === 'in' ? '应收' : '应付'} ${fmtDay(r.dueAt, now)}` })
      }
    }
    soon.sort((a, b) => a.at - b.at)
    const orders = recs
      .filter(r => r.data.kind === 'order')
      .sort((a, b) => (b.data.events?.[b.data.events.length - 1]?.at ?? b.createdAt) - (a.data.events?.[a.data.events.length - 1]?.at ?? a.createdAt))
      .slice(0, 4)
    const pendingOut = sumByCurrency(recs.filter(r => r.data.direction === 'out' && r.data.kind !== 'subscription' && ['pending', 'overdue'].includes(effectiveStatus(r.data, r.dueAt, now))).map(r => ({ amount: r.data.amount, currency: r.data.currency })))
    return { flows, annual, monthly, subs, overdue, soon, orders, pendingOut, monthLabel: `${d0.getMonth() + 1} 月` }
  }, [recs, now])
  const idleSubs = recs.filter(r => props.idle.has(r.id))

  return (
    <div className="px-6 pb-10">
      <div className="grid gap-3 mt-1" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <Stat label={`${m.monthLabel}支出`} values={m.flows.out} hint="已付账单 · 订阅扣费 · 订单 · 付款" empty="¥0.00" />
        <Stat label={`${m.monthLabel}收入`} values={m.flows.in} tone="in" hint="到账 · 收款回单" empty="¥0.00" />
        <Stat label="待付合计" values={m.pendingOut} hint={m.overdue.length ? `其中 ${m.overdue.length} 笔已逾期` : '未结清的账单与发票'} tone={m.overdue.length ? 'danger' : undefined} empty="¥0.00" />
        <Stat label="订阅 · 月均" values={m.monthly} hint={m.annual.length ? `年化 ${m.annual.map(([c, n]) => fmtMoney(n, c, { compact: true })).join(' + ')} · ${m.subs.length} 个` : '还没有订阅'} empty="—" />
      </div>
      <div className="mt-1.5 text-2xs" style={{ color: 'var(--faint)' }}>多币种分别合计，不做汇率换算。</div>

      <div className="mt-4 grid gap-x-6 gap-y-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <section className="min-w-0">
          {m.overdue.length > 0 && (
            <>
              <SectionTitle tone="danger" count={m.overdue.length}>逾期</SectionTitle>
              <div className="flex flex-col gap-1.5 mb-3">
                {m.overdue.map(r => (
                  <RecRow key={r.id} r={r} now={now} actions={props.actions} active={props.activeId === r.id} />
                ))}
              </div>
            </>
          )}
          <SectionTitle count={m.soon.length} right={<button onClick={() => props.onTab('calendar')} className="font-normal underline underline-offset-2" style={{ color: 'var(--muted)' }}>日历</button>}>
            7 天内到期 · 续费
          </SectionTitle>
          <div className="flex flex-col gap-1.5">
            {m.soon.map(({ r, label }) => (
              <RecRow key={r.id + label} r={r} now={now} actions={props.actions} dueLabel={label} active={props.activeId === r.id} />
            ))}
            {!m.soon.length && <div className="text-xs py-3" style={{ color: 'var(--faint)' }}>接下来 7 天没有要付的钱。</div>}
          </div>
        </section>
        <section className="min-w-0">
          <SectionTitle count={m.orders.length} right={<button onClick={() => props.onTab('orders')} className="font-normal underline underline-offset-2" style={{ color: 'var(--muted)' }}>全部订单</button>}>
            最近订单 · 物流
          </SectionTitle>
          <div className="flex flex-col gap-1.5">
            {m.orders.map(r => (
              <Card key={r.id} onClick={() => props.actions.onOpen(r.id)} active={props.activeId === r.id} className="px-3.5 py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm truncate flex-1" style={{ color: 'var(--fg)', fontWeight: 500 }}>{r.title}</span>
                  {r.data.status === 'refunded' && <Chip>已退款</Chip>}
                  <span className="text-sm"><span className="tnum" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg)' }}>{fmtMoney(r.data.amount, r.data.currency)}</span></span>
                </div>
                <div className="mt-2">
                  <LogisticsSteps r={r} />
                </div>
              </Card>
            ))}
            {!m.orders.length && <div className="text-xs py-3" style={{ color: 'var(--faint)' }}>还没有识别到电商订单。</div>}
          </div>
          {idleSubs.length > 0 && (
            <>
              <SectionTitle count={idleSubs.length} right={<button onClick={() => props.onTab('subs')} className="font-normal underline underline-offset-2" style={{ color: 'var(--muted)' }}>全部订阅</button>}>
                可能闲置的订阅
              </SectionTitle>
              <div className="flex flex-col gap-1.5">
                {idleSubs.map(r => (
                  <RecRow key={r.id} r={r} now={now} actions={props.actions} compact active={props.activeId === r.id} dueLabel={`年化 ${fmtMoney(annualCost(r.data), r.data.currency)}`} />
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
