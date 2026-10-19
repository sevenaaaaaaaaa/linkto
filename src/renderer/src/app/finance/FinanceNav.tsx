import type { SVGProps } from 'react'
import { effectiveStatus } from '@shared/finance'
import { daysUntil, useFinance, useFinanceEvents } from '../../lib/finance'

/** 钱包图标（与 icons.tsx 同规格：24×24 描边 1.8） */
export const IconWallet = (p: SVGProps<SVGSVGElement>) => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M19 7V5.5A1.5 1.5 0 0 0 17.5 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3" />
    <path d="M21 9h-5a3 3 0 0 0 0 6h5V9z" />
    <circle cx="16" cy="12" r="0.6" fill="currentColor" />
  </svg>
)

/** 侧栏「财务」：角标 = 逾期 + 3 天内要付 / 续费的笔数（行组件由侧栏提供，保持同一视觉） */
export function FinanceNavRow(props: { active: boolean; render(label: string, count: number): React.ReactNode }) {
  return <>{props.render('财务', useFinanceBadge())}</>
}

/** 侧栏角标：逾期 / 3 天内到期的应付款与即将续费 / 试用到期的订阅 */
export function useFinanceBadge(): number {
  useFinanceEvents()
  const records = useFinance(st => st.records)
  const now = Date.now()
  return records.filter(r => {
    const d = r.data
    if (d.direction !== 'out') return false
    if (d.kind === 'subscription') {
      if (d.status === 'cancelled') return false
      const t = d.trialEndsAt && d.trialEndsAt > now - 864e5 ? d.trialEndsAt : r.dueAt
      return !!t && daysUntil(t, now) >= 0 && daysUntil(t, now) <= 3
    }
    const st = effectiveStatus(d, r.dueAt, now)
    return st === 'overdue' || (st === 'pending' && !!r.dueAt && daysUntil(r.dueAt, now) <= 3)
  }).length
}
