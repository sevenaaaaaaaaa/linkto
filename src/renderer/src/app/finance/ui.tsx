import type { FinanceData, FinanceStatus } from '@shared/types'
import { FINANCE_KIND_LABEL, FINANCE_STATUS_LABEL } from '@shared/finance'
import { fmtMoney } from '../../lib/finance'

/** 财务中心的小件：分段、标签、金额（等宽数字）、状态 */

export function Seg<T extends string>(props: { value: T; options: { value: T; label: string; count?: number }[]; onChange(v: T): void; size?: 'sm' }) {
  return (
    <div className="no-drag inline-flex p-0.5 rounded-[var(--r-sm)] max-w-full overflow-x-auto" style={{ background: 'var(--hover)' }} role="tablist">
      {props.options.map(o => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === props.value}
          onClick={() => props.onChange(o.value)}
          className={`${props.size === 'sm' ? 'h-6 px-2' : 'h-7 px-2.5'} shrink-0 rounded-[var(--r-xs)] text-xs inline-flex items-center gap-1`}
          style={o.value === props.value ? { background: 'var(--surface-strong)', color: 'var(--fg)', fontWeight: 600, boxShadow: 'var(--shadow-sm)' } : { color: 'var(--muted)' }}
        >
          {o.label}
          {!!o.count && (
            <span className="tnum text-2xs" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
              {o.count}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

export type Tone = 'danger' | 'warn' | 'ok' | 'info' | 'strong' | 'ai' | 'muted'

export function Chip(props: { children: React.ReactNode; tone?: Tone; title?: string; className?: string }) {
  const style =
    props.tone === 'danger'
      ? { background: 'var(--danger-soft)', color: 'var(--danger-ink)' }
      : props.tone === 'warn'
        ? { background: 'var(--warn-soft)', color: 'var(--warn-ink)' }
        : props.tone === 'ok'
          ? { background: 'var(--ok-soft)', color: 'var(--ok-ink)' }
          : props.tone === 'info'
            ? { background: 'var(--info-soft)', color: 'var(--info-ink)' }
            : props.tone === 'strong'
              ? { background: 'var(--fg)', color: 'var(--surface-strong)' }
              : props.tone === 'ai'
                ? { background: 'var(--ai-soft)', color: 'var(--fg)' }
                : { background: 'var(--hover)', color: 'var(--muted)' }
  return (
    <span title={props.title} className={`px-1.5 h-5 inline-flex items-center gap-1 rounded-[var(--r-xs)] whitespace-nowrap text-2xs ${props.className ?? ''}`} style={style}>
      {props.children}
    </span>
  )
}

/** 金额：等宽数字；支出不加号，收入 / 退款前缀 + 号并用 ok 色 */
export function Money(props: { amount: number | null | undefined; currency?: string; direction?: 'out' | 'in'; strike?: boolean; size?: 'sm' | 'md' | 'lg' | 'xl'; muted?: boolean; compact?: boolean }) {
  const size = props.size === 'xl' ? 'text-[22px] leading-7 font-semibold' : props.size === 'lg' ? 'text-base font-semibold' : props.size === 'sm' ? 'text-xs' : 'text-sm font-medium'
  const inflow = props.direction === 'in'
  return (
    <span
      className={`tnum whitespace-nowrap ${size} ${props.strike ? 'line-through' : ''}`}
      style={{ fontFamily: 'var(--font-mono)', color: props.muted ? 'var(--faint)' : inflow ? 'var(--ok-ink)' : 'var(--fg)', letterSpacing: '-0.01em' }}
    >
      {fmtMoney(props.amount, props.currency ?? 'CNY', { sign: inflow && props.amount != null, compact: props.compact })}
    </span>
  )
}

export function statusTone(s: FinanceStatus): Tone {
  return s === 'overdue' ? 'danger' : s === 'pending' ? 'warn' : s === 'paid' ? 'ok' : s === 'disputed' ? 'danger' : 'muted'
}

export function StatusChip(props: { status: FinanceStatus; kind?: FinanceData['kind'] }) {
  const label =
    props.kind === 'subscription'
      ? props.status === 'paid'
        ? '续费中'
        : props.status === 'pending'
          ? '待续费'
          : props.status === 'cancelled'
            ? '不再续费'
            : FINANCE_STATUS_LABEL[props.status]
      : props.kind === 'payment' || props.kind === 'receipt'
        ? props.status === 'paid'
          ? '已完成'
          : FINANCE_STATUS_LABEL[props.status]
        : FINANCE_STATUS_LABEL[props.status]
  return <Chip tone={props.kind === 'subscription' && props.status === 'paid' ? 'muted' : statusTone(props.status)}>{label}</Chip>
}

export function KindTag(props: { kind: FinanceData['kind'] }) {
  return (
    <span className="caps shrink-0" style={{ color: 'var(--faint)', fontSize: 10 }}>
      {FINANCE_KIND_LABEL[props.kind]}
    </span>
  )
}

export function SectionTitle(props: { children: React.ReactNode; count?: number; tone?: 'danger'; right?: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold py-1.5 flex items-center gap-2" style={{ color: props.tone === 'danger' ? 'var(--danger-ink)' : 'var(--faint)' }}>
      {props.children}
      {props.count != null && (
        <span className="tnum" style={{ fontFamily: 'var(--font-mono)' }}>
          {props.count}
        </span>
      )}
      <span className="flex-1" />
      {props.right}
    </h2>
  )
}

export const btn = 'no-drag h-8 px-3 rounded-[var(--r-sm)] text-xs font-semibold border border-[var(--border)] hover:bg-[var(--hover)] disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap'
export const btnStyle = { color: 'var(--fg)', background: 'var(--surface-strong)' }
export const btnPrimary = 'no-drag h-8 px-3 rounded-[var(--r-sm)] text-xs font-semibold disabled:opacity-50 inline-flex items-center gap-1.5 whitespace-nowrap transition-opacity hover:opacity-90'
export const btnPrimaryStyle = { background: 'var(--accent)', color: 'var(--on-accent)' }
export const miniBtn = 'h-6 px-2 rounded-[var(--r-xs)] text-2xs border border-[var(--border)] hover:bg-[var(--hover)] whitespace-nowrap inline-flex items-center gap-1'
export const field = 'h-7 px-1.5 rounded-[var(--r-xs)] border border-[var(--border)] text-xs outline-none focus:border-[var(--border-strong)]'
export const fieldStyle = { background: 'var(--surface-strong)', color: 'var(--fg)' }

/** 卡片容器 */
export function Card(props: { children: React.ReactNode; className?: string; onClick?(): void; active?: boolean; style?: React.CSSProperties }) {
  return (
    <div
      onClick={props.onClick}
      className={`rounded-[var(--r-md)] border ${props.onClick ? 'cursor-default hover:border-[var(--border-strong)]' : ''} ${props.className ?? ''}`}
      style={{ background: 'var(--surface-strong)', borderColor: props.active ? 'var(--fg)' : 'var(--border)', ...props.style }}
    >
      {props.children}
    </div>
  )
}
