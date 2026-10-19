import { daysUntil, lifeUrgency, looksLifeHint, LIFE_CATEGORY_LABEL } from '@shared/life'
import type { MailInsight } from '@shared/types'
import { addMessageToLife, fmtDate, leftLabel, openLife, useLife, useLifeEvents } from '../../lib/life'
import { CategoryIcon } from './icons'

/**
 * 阅读页「生活档案」关联条（参照「款项」关联条）：这封信属于哪件到期事务，点一下去生活档案；
 * 不属于任何事务、但读起来像证件 / 保险 / 年检 / 域名等到期通知时，给一个克制的「加入生活档案」。
 */
export function LifeStrip(props: { messageId: string; insight?: MailInsight; text?: string }) {
  useLifeEvents()
  const records = useLife(st => st.records)
  const linked = records.filter(r => r.data.messageIds?.includes(props.messageId))
  const hint = !linked.length && props.insight?.bundle !== 'newsletter' && looksLifeHint(props.text ?? '')
  if (!linked.length && !hint) return null
  const now = Date.now()
  return (
    <div className="shrink-0 px-6 pt-3 flex flex-wrap items-center gap-1.5 text-xs">
      <span style={{ color: 'var(--faint)' }}>生活档案</span>
      {linked.map(r => {
        const t = r.dueAt ?? r.data.expiresAt
        const u = lifeUrgency(r, now)
        return (
          <button
            key={r.id}
            onClick={() => openLife(r.id)}
            className="h-6 px-2 rounded-[var(--r-xs)] border border-[var(--border)] hover:bg-[var(--hover)] inline-flex items-center gap-1.5"
            style={{ color: 'var(--fg)' }}
            title={`${LIFE_CATEGORY_LABEL[r.data.category]} · ${r.title}（${r.data.messageIds.length} 封相关邮件）`}
          >
            <CategoryIcon category={r.data.category} width={12} height={12} style={{ color: 'var(--muted)' }} />
            {r.data.subject.slice(0, 18)}
            <span style={{ color: u === 'overdue' ? 'var(--danger-ink)' : u === 'soon' ? 'var(--warn-ink)' : 'var(--faint)' }}>
              {r.status === 'done' ? ' · 已办妥' : t ? ` · ${fmtDate(t, now)}${daysUntil(t, now) <= 60 ? `（${leftLabel(daysUntil(t, now))}）` : ''}` : ' · 缺到期日'}
            </span>
          </button>
        )
      })}
      {hint && (
        <button
          onClick={() => void addMessageToLife(props.messageId)}
          className="h-6 px-2 rounded-[var(--r-xs)] border border-dashed border-[var(--border-strong)] hover:bg-[var(--hover)]"
          style={{ color: 'var(--muted)' }}
          title="把这封邮件记为一件到期 / 续期事务（证件、保险、年检、域名、会员、保修…）"
        >
          + 加入生活档案
        </button>
      )}
    </div>
  )
}

/** 侧栏「生活档案」：角标 = 已过期 + 30 天内到期的件数（行组件由侧栏提供，保持同一视觉） */
export function LifeNavRow(props: { render(label: string, count: number): React.ReactNode }) {
  return <>{props.render('生活档案', useLifeBadge())}</>
}

/** 侧栏角标：已过期 / 快到期的事务 */
export function useLifeBadge(): number {
  useLifeEvents()
  const records = useLife(st => st.records)
  const now = Date.now()
  return records.filter(r => {
    const u = lifeUrgency(r, now)
    return u === 'overdue' || u === 'soon'
  }).length
}
