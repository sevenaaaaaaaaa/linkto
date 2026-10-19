import type { LifeCategory } from '@shared/types'
import { daysUntil, lifeUrgency, LIFE_CATEGORY_LABEL, startOfDay, type LifeUrgency } from '@shared/life'
import { fmtDate, leftLabel, type LifeRec } from '../../lib/life'
import { useFinance, fmtMoney } from '../../lib/finance'
import { Chip, type Tone } from '../finance/ui'
import { CategoryIcon } from './icons'

export const URGENCY_LABEL: Record<LifeUrgency, string> = { overdue: '已过期', soon: '即将到期', act: '该办了', later: '', done: '已办妥', undated: '缺到期日' }
export const urgencyTone = (u: LifeUrgency): Tone | undefined => (u === 'overdue' ? 'danger' : u === 'soon' ? 'warn' : u === 'act' ? 'info' : u === 'done' ? 'ok' : 'muted')

/** 类别图标块（底色随紧急度） */
export function CatBadge(props: { category: LifeCategory; urgency?: LifeUrgency; size?: number }) {
  const u = props.urgency
  const s = props.size ?? 30
  const style =
    u === 'overdue'
      ? { background: 'var(--danger-soft)', color: 'var(--danger-ink)' }
      : u === 'soon'
        ? { background: 'var(--warn-soft)', color: 'var(--warn-ink)' }
        : u === 'act'
          ? { background: 'var(--info-soft)', color: 'var(--info-ink)' }
          : { background: 'var(--hover)', color: 'var(--muted)' }
  return (
    <span className="shrink-0 inline-flex items-center justify-center rounded-[var(--r-sm)]" style={{ width: s, height: s, ...style }} title={LIFE_CATEGORY_LABEL[props.category]}>
      <CategoryIcon category={props.category} width={Math.round(s * 0.53)} height={Math.round(s * 0.53)} />
    </span>
  )
}

/** 关联财务的费用（不复制数据：从财务记录里读） */
export function useLinkedAmount(r: LifeRec): { amount: number | null; currency: string } {
  const fin = useFinance(st => (r.data.financeId ? st.records.find(x => x.id === r.data.financeId) : null))
  if (r.data.amount != null) return { amount: r.data.amount, currency: r.data.currency ?? 'CNY' }
  if (fin && fin.data.amount != null) return { amount: fin.data.amount, currency: fin.data.currency }
  return { amount: null, currency: 'CNY' }
}

/** 「该开始办的提示」：还没到 → 「11月20日起办理」；已到 → 「现在就该办」 */
export function actionHint(r: LifeRec, now: number): string | null {
  const a = r.data.actionFrom
  if (!a || r.status === 'done') return null
  const t = r.dueAt ?? r.data.expiresAt
  if (t && daysUntil(t, now) < 0) return null
  if (startOfDay(a) <= startOfDay(now)) return '现在就该办'
  return `${fmtDate(a, now)}起办理`
}

/** 时间线 / 类别卡片共用的一行：类别图标 · 对象 · 机构 · 提示 | 到期日 · 剩余天数 */
export function LifeRow(props: { r: LifeRec; now: number; active?: boolean; compact?: boolean; onOpen(id: string): void }) {
  const { r, now } = props
  const d = r.data
  const u = lifeUrgency(r, now)
  const t = r.dueAt ?? d.expiresAt ?? null
  const n = t ? daysUntil(t, now) : null
  const hint = actionHint(r, now)
  const money = useLinkedAmount(r)
  return (
    <button
      onClick={() => props.onOpen(r.id)}
      className={`w-full text-left flex items-center gap-3 ${props.compact ? 'px-2 py-1.5' : 'px-3 py-2.5'} rounded-[var(--r-sm)] hover:bg-[var(--hover)] transition-colors`}
      style={{ background: props.active ? 'var(--selected)' : undefined, opacity: u === 'done' ? 0.6 : 1 }}
    >
      <CatBadge category={d.category} urgency={u} size={props.compact ? 24 : 30} />
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm truncate" style={{ color: 'var(--fg)', fontWeight: u === 'overdue' || u === 'soon' ? 600 : 500 }}>{d.subject || r.title}</span>
          {URGENCY_LABEL[u] && <Chip tone={urgencyTone(u)}>{URGENCY_LABEL[u]}</Chip>}
          {d.repeat && u !== 'done' && <span className="text-2xs shrink-0" style={{ color: 'var(--faint)' }} title="循环事务：办妥后滚到下一期">↻</span>}
        </span>
        {!props.compact && (
          <span className="mt-0.5 flex items-center gap-1.5 text-2xs min-w-0" style={{ color: 'var(--faint)' }}>
            <span className="truncate">{[LIFE_CATEGORY_LABEL[d.category], d.provider, d.reference].filter(Boolean).join(' · ')}</span>
            {hint && <span className="shrink-0" style={{ color: hint === '现在就该办' ? 'var(--info-ink)' : 'var(--muted)' }}>· {hint}</span>}
            {money.amount != null && <span className="shrink-0 tnum" style={{ fontFamily: 'var(--font-mono)' }}>· {fmtMoney(money.amount, money.currency)}</span>}
            {d.messageIds.length > 0 && <span className="shrink-0">· {d.messageIds.length} 封邮件</span>}
          </span>
        )}
      </span>
      <span className="shrink-0 flex flex-col items-end gap-0.5 min-w-[84px]">
        <span className="text-xs tnum" style={{ color: 'var(--fg)', fontFamily: 'var(--font-mono)' }}>{t ? fmtDate(t, now) : '—'}</span>
        {n != null && u !== 'done' && (
          <span className="text-2xs tnum" style={{ color: n < 0 ? 'var(--danger-ink)' : n <= 30 ? 'var(--warn-ink)' : 'var(--faint)' }}>{leftLabel(n)}</span>
        )}
      </span>
    </button>
  )
}
