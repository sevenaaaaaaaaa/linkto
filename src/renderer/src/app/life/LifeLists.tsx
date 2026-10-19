import { useMemo } from 'react'
import type { LifeCategory } from '@shared/types'
import { daysUntil, lifeUrgency, LIFE_CATEGORIES, LIFE_CATEGORY_HINT, LIFE_CATEGORY_LABEL } from '@shared/life'
import type { LifeRec } from '../../lib/life'
import { Card, SectionTitle } from '../finance/ui'
import { CatBadge, LifeRow } from './LifeRow'

/**
 * 时间线（默认）：已过期 → 未来 12 个月按月分组 → 更远 → 缺到期日；已办妥的折叠在最后。
 * 逾期与 30 天内到期的条目在行内突出（图标底色 + 标签）。
 */
export function Timeline(props: { recs: LifeRec[]; now: number; activeId: string | null; showDone: boolean; onOpen(id: string): void }) {
  const { now } = props
  const groups = useMemo(() => {
    const open = props.recs.filter(r => r.status !== 'done')
    const at = (r: LifeRec) => r.dueAt ?? r.data.expiresAt ?? null
    const overdue = open.filter(r => lifeUrgency(r, now) === 'overdue').sort((a, b) => at(a)! - at(b)!)
    const undated = open.filter(r => !at(r))
    const future = open.filter(r => at(r) && lifeUrgency(r, now) !== 'overdue').sort((a, b) => at(a)! - at(b)!)
    const base = new Date(now)
    const months: { key: string; label: string; items: LifeRec[] }[] = []
    for (let i = 0; i < 12; i++) {
      const m = new Date(base.getFullYear(), base.getMonth() + i, 1)
      const end = new Date(base.getFullYear(), base.getMonth() + i + 1, 1).getTime()
      const items = future.filter(r => at(r)! >= m.getTime() && at(r)! < end)
      months.push({ key: `${m.getFullYear()}-${m.getMonth()}`, label: `${m.getFullYear() === base.getFullYear() ? '' : `${m.getFullYear()} 年 `}${m.getMonth() + 1} 月${i === 0 ? '（本月）' : ''}`, items })
    }
    const horizon = new Date(base.getFullYear(), base.getMonth() + 12, 1).getTime()
    const later = future.filter(r => at(r)! >= horizon)
    const done = props.recs.filter(r => r.status === 'done').sort((a, b) => (at(b) ?? 0) - (at(a) ?? 0))
    return { overdue, months, later, undated, done }
  }, [props.recs, now])

  const soon = groups.months.reduce((n, m) => n + m.items.filter(r => daysUntil(r.dueAt ?? r.data.expiresAt ?? 0, now) <= 30).length, 0)
  const row = (r: LifeRec) => <LifeRow key={r.id} r={r} now={now} active={props.activeId === r.id} onOpen={props.onOpen} />

  return (
    <div className="px-6 pb-12 max-w-[860px]">
      {(groups.overdue.length > 0 || soon > 0) && (
        <div className="mt-1 mb-2 text-xs" style={{ color: 'var(--muted)' }}>
          {groups.overdue.length > 0 && <span style={{ color: 'var(--danger-ink)' }}>{groups.overdue.length} 件已过期还没办</span>}
          {groups.overdue.length > 0 && soon > 0 && '，'}
          {soon > 0 && <span style={{ color: 'var(--warn-ink)' }}>{soon} 件 30 天内到期</span>}
        </div>
      )}
      {groups.overdue.length > 0 && (
        <section className="mb-3">
          <SectionTitle count={groups.overdue.length} tone="danger">已过期</SectionTitle>
          <div className="flex flex-col">{groups.overdue.map(row)}</div>
        </section>
      )}
      {groups.months.map(m => (
        <section key={m.key} className="mb-1">
          <div className="flex items-baseline gap-2 py-1.5 border-b border-[var(--border)]">
            <span className="text-xs font-semibold" style={{ color: m.items.length ? 'var(--fg)' : 'var(--faint)' }}>{m.label}</span>
            {m.items.length > 0 && <span className="text-2xs tnum" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{m.items.length}</span>}
          </div>
          {m.items.length > 0 ? <div className="flex flex-col py-1">{m.items.map(row)}</div> : <div className="h-2" />}
        </section>
      ))}
      {groups.later.length > 0 && (
        <section className="mt-3">
          <SectionTitle count={groups.later.length}>12 个月以后</SectionTitle>
          <div className="flex flex-col">{groups.later.map(row)}</div>
        </section>
      )}
      {groups.undated.length > 0 && (
        <section className="mt-3">
          <SectionTitle count={groups.undated.length}>缺到期日（点开补全）</SectionTitle>
          <div className="flex flex-col">{groups.undated.map(row)}</div>
        </section>
      )}
      {props.showDone && groups.done.length > 0 && (
        <section className="mt-3">
          <SectionTitle count={groups.done.length}>已办妥</SectionTitle>
          <div className="flex flex-col">{groups.done.map(row)}</div>
        </section>
      )}
    </div>
  )
}

/** 按类别：证件 / 保险 / 车辆 / 会员 / 域名 / 保修…卡片分组，空类别给「手动添加」 */
export function CategoryBoard(props: { recs: LifeRec[]; now: number; activeId: string | null; filtered?: boolean; onOpen(id: string): void; onAdd(category: LifeCategory): void }) {
  const { now } = props
  const cats = LIFE_CATEGORIES.filter(c => c !== 'other' || props.recs.some(r => r.data.category === 'other'))
  return (
    <div className="px-6 pb-12 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
      {cats.map(c => {
        const items = props.recs
          .filter(r => r.data.category === c)
          .sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
        const worst = items.map(r => lifeUrgency(r, now)).find(u => u === 'overdue') ?? items.map(r => lifeUrgency(r, now)).find(u => u === 'soon')
        return (
          <Card key={c} className="p-3 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <CatBadge category={c} urgency={worst} size={26} />
              <span className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>{LIFE_CATEGORY_LABEL[c]}</span>
              {items.length > 0 && <span className="text-2xs tnum" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{items.length}</span>}
              <span className="flex-1" />
              <button onClick={() => props.onAdd(c)} className="text-2xs h-6 px-2 rounded-[var(--r-xs)] hover:bg-[var(--hover)]" style={{ color: 'var(--muted)' }} aria-label={`手动添加${LIFE_CATEGORY_LABEL[c]}`}>
                + 添加
              </button>
            </div>
            {items.length ? (
              <div className="flex flex-col -mx-1">
                {items.slice(0, 6).map(r => (
                  <LifeRow key={r.id} r={r} now={now} compact active={props.activeId === r.id} onOpen={props.onOpen} />
                ))}
                {items.length > 6 && <span className="text-2xs px-2" style={{ color: 'var(--faint)' }}>还有 {items.length - 6} 件，在时间线里查看</span>}
              </div>
            ) : (
              <button
                onClick={() => props.onAdd(c)}
                className="text-left text-xs leading-relaxed px-2.5 py-2 rounded-[var(--r-sm)] border border-dashed border-[var(--border-strong)] hover:bg-[var(--hover)]"
                style={{ color: 'var(--faint)' }}
              >
                {props.filtered ? `没有匹配的${LIFE_CATEGORY_LABEL[c]}记录` : `还没有记录：${LIFE_CATEGORY_HINT[c]}。邮件里没找到的话，手动添加 →`}
              </button>
            )}
          </Card>
        )
      })}
    </div>
  )
}
