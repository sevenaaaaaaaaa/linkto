import { useMemo, useState } from 'react'
import { annualCost, effectiveStatus, FINANCE_CYCLE_LABEL } from '@shared/finance'
import { api } from '../../lib/api'
import { daysUntil, fmtDay, fmtMoney, isBillish, sumByCurrency, type FinanceRec } from '../../lib/finance'
import { RecRow, LogisticsSteps, openMail, type RowActions } from './RecRow'
import { Card, Chip, Money, Seg, SectionTitle, StatusChip, miniBtn } from './ui'

const DAY = 864e5

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback
  } catch {
    return fallback
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* 存储不可用：本次生效 */
  }
}

// ---------------------------------------------------------------- 账单

type BillGroup = 'status' | 'due' | 'category'

export function BillsView(props: { recs: FinanceRec[]; now: number; actions: RowActions; activeId: string | null }) {
  const [group, setGroup] = useState<BillGroup>(() => readPref<BillGroup>('ms_fin_bill_group', 'status'))
  const { now } = props
  const bills = props.recs.filter(r => isBillish(r.data))
  const groups = useMemo(() => {
    const map = new Map<string, FinanceRec[]>()
    const put = (k: string, r: FinanceRec) => map.set(k, [...(map.get(k) ?? []), r])
    for (const r of bills) {
      const st = effectiveStatus(r.data, r.dueAt, now)
      if (group === 'status') put(st === 'overdue' ? '逾期' : st === 'pending' ? '待付' : st === 'paid' ? '已付' : '已取消 / 退款', r)
      else if (group === 'category') put(r.data.category || '未分类', r)
      else {
        const open = st === 'pending' || st === 'overdue'
        if (!open) put('已结清', r)
        else if (!r.dueAt) put('没有应付日', r)
        else {
          const n = daysUntil(r.dueAt, now)
          put(n < 0 ? '已过应付日' : n <= 7 ? '7 天内' : n <= 31 ? '本月内' : '更晚', r)
        }
      }
    }
    const order =
      group === 'status' ? ['逾期', '待付', '已付', '已取消 / 退款'] : group === 'due' ? ['已过应付日', '7 天内', '本月内', '更晚', '没有应付日', '已结清'] : [...map.keys()].sort()
    const sortIn = (list: FinanceRec[]) =>
      list.sort((a, b) => {
        const ao = a.dueAt ?? Infinity
        const bo = b.dueAt ?? Infinity
        return group === 'status' && (list[0] && effectiveStatus(list[0].data, list[0].dueAt, now) === 'paid') ? (b.data.paidAt ?? b.createdAt) - (a.data.paidAt ?? a.createdAt) : ao - bo
      })
    return order.filter(k => map.has(k)).map(k => ({ key: k, list: sortIn(map.get(k)!) }))
  }, [bills, group, now])

  return (
    <div className="px-6 pb-10">
      <div className="flex items-center gap-2 mt-1 mb-1">
        <Seg
          size="sm"
          value={group}
          onChange={v => {
            setGroup(v)
            writePref('ms_fin_bill_group', v)
          }}
          options={[
            { value: 'status', label: '按状态' },
            { value: 'due', label: '按到期日' },
            { value: 'category', label: '按分类' }
          ]}
        />
        <span className="text-2xs" style={{ color: 'var(--faint)' }}>账单 · 发票 · 退款 · 个人付款；企业往来的付款与回单在「对账」</span>
      </div>
      {groups.map(g => {
        const total = sumByCurrency(g.list.map(r => ({ amount: r.data.amount, currency: r.data.currency })))
        return (
          <section key={g.key} className="mt-3">
            <SectionTitle
              count={g.list.length}
              tone={g.key === '逾期' || g.key === '已过应付日' ? 'danger' : undefined}
              right={
                <span className="tnum font-normal" style={{ fontFamily: 'var(--font-mono)' }}>
                  {total.map(([c, n]) => fmtMoney(n, c)).join(' · ')}
                </span>
              }
            >
              {g.key}
            </SectionTitle>
            <div className="flex flex-col gap-1.5">
              {g.list.map(r => (
                <RecRow key={r.id} r={r} now={now} actions={props.actions} active={props.activeId === r.id} />
              ))}
            </div>
          </section>
        )
      })}
      {!groups.length && <Empty text="没有符合筛选的账单。" />}
    </div>
  )
}

export function Empty(props: { text: string }) {
  return (
    <div className="mt-14 text-center text-sm" style={{ color: 'var(--faint)' }}>
      {props.text}
    </div>
  )
}

// ---------------------------------------------------------------- 订阅

export function SubsView(props: { recs: FinanceRec[]; idle: Set<string>; now: number; actions: RowActions; activeId: string | null }) {
  const { now } = props
  const subs = props.recs.filter(r => r.data.kind === 'subscription')
  const active = subs.filter(r => r.data.status !== 'cancelled' && r.data.status !== 'refunded').sort((a, b) => (annualCost(b.data) ?? -1) - (annualCost(a.data) ?? -1))
  const stopped = subs.filter(r => r.data.status === 'cancelled' || r.data.status === 'refunded')
  const annual = sumByCurrency(active.map(r => ({ amount: annualCost(r.data), currency: r.data.currency })))
  const idleCount = active.filter(r => props.idle.has(r.id)).length

  const setCancelled = async (r: FinanceRec, cancelled: boolean) => {
    await api.financeUpdate(r.id, { data: { status: cancelled ? 'cancelled' : 'paid', events: [...(r.data.events ?? []), { at: Date.now(), kind: cancelled ? 'cancelled' : 'note', label: cancelled ? '标记不再续费' : '恢复续费' }] } })
  }

  return (
    <div className="px-6 pb-10">
      <div className="mt-1 flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {active.length} 个在续费 · 年化{' '}
          {annual.length
            ? annual.map(([c, n], i) => (
                <span key={c}>
                  {i > 0 && ' + '}
                  <Money amount={n} currency={c} size="sm" />
                </span>
              ))
            : '—'}{' '}
          · 月均{' '}
          {annual.length
            ? annual.map(([c, n], i) => (
                <span key={c}>
                  {i > 0 && ' + '}
                  <Money amount={Math.round((n / 12) * 100) / 100} currency={c} size="sm" />
                </span>
              ))
            : '—'}
        </span>
        {idleCount > 0 && <span className="text-xs" style={{ color: 'var(--warn-ink)' }}>{idleCount} 个近 3 个月没打开过相关邮件，可能闲置</span>}
      </div>
      <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {active.map(r => (
          <SubCard key={r.id} r={r} now={now} idle={props.idle.has(r.id)} active={props.activeId === r.id} onOpen={() => props.actions.onOpen(r.id)} onTodo={() => props.actions.onTodo(r.id)} onCancel={() => void setCancelled(r, true)} />
        ))}
      </div>
      {!active.length && <Empty text="还没有识别到在续费的订阅。" />}
      {stopped.length > 0 && (
        <section className="mt-6">
          <SectionTitle count={stopped.length}>不再续费</SectionTitle>
          <div className="flex flex-col gap-1.5">
            {stopped.map(r => (
              <div key={r.id} onClick={() => props.actions.onOpen(r.id)} className="h-9 px-3 flex items-center gap-3 rounded-[var(--r-sm)] hover:bg-[var(--hover)] cursor-default text-sm" style={{ color: 'var(--muted)' }}>
                <span className="flex-1 truncate">{r.title}</span>
                <Money amount={r.data.amount} currency={r.data.currency} size="sm" muted strike />
                <button
                  className={miniBtn}
                  style={{ color: 'var(--muted)' }}
                  onClick={e => {
                    e.stopPropagation()
                    void setCancelled(r, false)
                  }}
                >
                  恢复
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function SubCard(props: { r: FinanceRec; now: number; idle: boolean; active: boolean; onOpen(): void; onTodo(): void; onCancel(): void }) {
  const { r, now } = props
  const d = r.data
  const trialLeft = d.trialEndsAt && d.trialEndsAt >= now - DAY ? daysUntil(d.trialEndsAt, now) : null
  const renewIn = r.dueAt ? daysUntil(r.dueAt, now) : null
  const yearly = annualCost(d)
  return (
    <Card onClick={props.onOpen} active={props.active} className="px-4 py-3.5 flex flex-col gap-2.5 min-w-0">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate" style={{ color: 'var(--fg)' }}>{r.title}</div>
          <div className="text-2xs mt-0.5 truncate" style={{ color: 'var(--faint)' }}>
            {d.category ?? '订阅'}
            {d.cycle ? ` · ${FINANCE_CYCLE_LABEL[d.cycle]}` : ' · 周期未知'}
          </div>
        </div>
        <div className="text-right">
          <Money amount={d.amount} currency={d.currency} size="lg" />
          {d.previousAmount != null && d.amount != null && d.previousAmount !== d.amount && (
            <div className="text-2xs tnum" style={{ color: d.amount > d.previousAmount ? 'var(--danger-ink)' : 'var(--ok-ink)', fontFamily: 'var(--font-mono)' }}>
              {d.amount > d.previousAmount ? '提价' : '降价'} 原 {fmtMoney(d.previousAmount, d.currency)}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {trialLeft != null ? (
          <Chip tone={trialLeft <= 2 ? 'danger' : 'warn'}>试用剩 {Math.max(0, trialLeft)} 天</Chip>
        ) : (
          <StatusChip status={d.status} kind="subscription" />
        )}
        {props.idle && <Chip tone="warn" title="近 3 个月没打开过这个商家除账单外的任何邮件">可能闲置</Chip>}
        {d.source === 'ai' && <Chip tone="ai">AI 识别</Chip>}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
        <dt style={{ color: 'var(--faint)' }}>{trialLeft != null ? '试用结束' : '下次续费'}</dt>
        <dd className="text-right tnum" style={{ color: renewIn != null && renewIn <= 3 ? 'var(--warn-ink)' : 'var(--fg)' }}>
          {trialLeft != null ? fmtDay(d.trialEndsAt, now) : r.dueAt ? `${fmtDay(r.dueAt, now)}${renewIn != null && renewIn >= 0 ? ` · ${renewIn} 天` : ''}` : '—'}
        </dd>
        <dt style={{ color: 'var(--faint)' }}>年化成本</dt>
        <dd className="text-right">
          <Money amount={yearly} currency={d.currency} size="sm" />
        </dd>
      </dl>
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5" onClick={e => e.stopPropagation()}>
        {d.manageUrl && (
          <button className={miniBtn} style={{ color: 'var(--fg)' }} onClick={() => void api.openExternal(d.manageUrl!)} title={d.manageUrl}>
            管理 / 取消 ↗
          </button>
        )}
        {!d.todoId && (r.dueAt || d.trialEndsAt) && (
          <button className={miniBtn} style={{ color: 'var(--fg)' }} onClick={props.onTodo}>
            提醒待办
          </button>
        )}
        <button className={miniBtn} style={{ color: 'var(--muted)' }} onClick={props.onCancel} title="已在商家处取消：不再计入订阅成本与提醒">
          不再续费
        </button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------- 订单

export function OrdersView(props: { recs: FinanceRec[]; now: number; actions: RowActions; activeId: string | null }) {
  const orders = props.recs
    .filter(r => r.data.kind === 'order')
    .sort((a, b) => (b.data.events?.[0]?.at ?? b.createdAt) - (a.data.events?.[0]?.at ?? a.createdAt))
  const inFlight = orders.filter(r => r.data.logistics !== 'delivered' && r.data.status !== 'refunded')
  const rest = orders.filter(r => !inFlight.includes(r))
  const block = (list: FinanceRec[]) => (
    <div className="flex flex-col gap-1.5">
      {list.map(r => {
        const d = r.data
        return (
          <Card key={r.id} onClick={() => props.actions.onOpen(r.id)} active={props.activeId === r.id} className="px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex-1 min-w-[220px]">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium truncate" style={{ color: 'var(--fg)' }}>{d.shop || d.counterparty}</span>
                {d.orderNo && <span className="text-2xs tnum truncate" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{d.orderNo}</span>}
              </div>
              <div className="mt-0.5 text-xs truncate" style={{ color: 'var(--muted)' }}>
                {d.items?.length ? d.items.map(i => `${i.name}${i.qty && i.qty > 1 ? ` ×${i.qty}` : ''}`).join('、') : r.title}
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {d.status === 'refunded' && <Chip>已退款</Chip>}
                {d.status === 'pending' && <Chip tone="warn">待付款</Chip>}
                {d.tracking && <Chip title="运单号">运单 {d.tracking}</Chip>}
              </div>
            </div>
            <LogisticsSteps r={r} />
            <div className="flex flex-col items-end gap-1 min-w-[96px]" onClick={e => e.stopPropagation()}>
              <Money amount={d.amount} currency={d.currency} strike={d.status === 'refunded'} />
              {d.messageIds[0] && (
                <button className={miniBtn} style={{ color: 'var(--muted)' }} onClick={() => openMail(d.messageIds[d.messageIds.length - 1])}>
                  邮件 ↗
                </button>
              )}
            </div>
          </Card>
        )
      })}
    </div>
  )
  return (
    <div className="px-6 pb-10">
      {inFlight.length > 0 && (
        <section className="mt-1">
          <SectionTitle count={inFlight.length}>在路上</SectionTitle>
          {block(inFlight)}
        </section>
      )}
      {rest.length > 0 && (
        <section className="mt-4">
          <SectionTitle count={rest.length}>已签收 / 已结束</SectionTitle>
          {block(rest)}
        </section>
      )}
      {!orders.length && <Empty text="还没有识别到电商订单：下单、发货、签收邮件会自动归到同一个订单。" />}
    </div>
  )
}
