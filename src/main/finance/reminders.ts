import { Notification } from 'electron'
import type { FinanceData, NotificationSettings } from '@shared/types'
import { DAY_MS } from '@shared/finance'
import { inQuietHours } from '../notify-policy'
import type { FinanceService } from './service'

export interface FinanceReminder {
  key: string
  title: string
  body: string
}

const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const money = (d: FinanceData) =>
  d.amount == null ? '' : ` ${d.currency === 'CNY' ? '¥' : `${d.currency} `}${d.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * 该不该提醒（纯函数）：到期前 3 天 / 当天、订阅续费前 3 天、试用结束前 2 天。
 * 键含目标日期，换期（下一次续费 / 改了应付日）后会重新提醒；已结清 / 已取消的不提醒。
 */
export function dueReminders(rec: { title: string; status: string; dueAt: number | null; data: FinanceData }, now: number): FinanceReminder[] {
  const d = rec.data
  const out: FinanceReminder[] = []
  if (rec.status === 'dismissed') return out
  const days = (t: number) => Math.round((startOfDay(t) - startOfDay(now)) / DAY_MS)
  const day = (t: number) => new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  if (d.kind === 'subscription') {
    if (d.status === 'cancelled' || d.status === 'refunded') return out
    if (d.trialEndsAt && d.trialEndsAt > now - DAY_MS) {
      const n = days(d.trialEndsAt)
      if (n >= 0 && n <= 2) out.push({ key: `trial-2-${startOfDay(d.trialEndsAt)}`, title: `试用${n === 0 ? '今天' : `${n} 天后`}结束：${d.counterparty}`, body: `${day(d.trialEndsAt)} 结束试用${money(d) ? `，之后按${money(d)}扣费` : ''}；不想续订记得取消` })
    }
    if (rec.dueAt && (!d.trialEndsAt || Math.abs(rec.dueAt - d.trialEndsAt) > DAY_MS)) {
      const n = days(rec.dueAt)
      if (n >= 0 && n <= 3) out.push({ key: `renew-3-${startOfDay(rec.dueAt)}`, title: `${n === 0 ? '今天' : `${n} 天后`}续费：${d.counterparty}${money(d)}`, body: `${day(rec.dueAt)} 自动续费；不再需要可以先取消` })
    }
    return out
  }
  if (d.status !== 'pending' && d.status !== 'overdue') return out
  if (d.direction === 'in' || !rec.dueAt) return out
  const n = days(rec.dueAt)
  if (n === 0) out.push({ key: `due-0-${startOfDay(rec.dueAt)}`, title: `今天到期：${rec.title}`, body: `${d.counterparty}${money(d)} · 今天是应付日` })
  else if (n > 0 && n <= 3) out.push({ key: `due-3-${startOfDay(rec.dueAt)}`, title: `${n} 天后到期：${rec.title}`, body: `${d.counterparty}${money(d)} · ${day(rec.dueAt)} 应付` })
  return out
}

/** 款项提醒：每分钟看一次；受通知总开关与免打扰时段约束，同一提醒只发一次（记在 data.reminded） */
export function startFinanceReminders(deps: { finance: FinanceService; settings(): NotificationSettings; openFinance(id: string): void; markReminded(id: string, keys: string[]): void }) {
  const live = new Set<Notification>()
  const tick = () => {
    const s = deps.settings()
    if (!s.enabled || !Notification.isSupported()) return
    const now = Date.now()
    if (inQuietHours(s.quietHours, new Date(now))) return
    for (const r of deps.finance.rows(false)) {
      const done = new Set(r.data.reminded ?? [])
      const due = dueReminders(r, now).filter(x => !done.has(x.key))
      if (!due.length) continue
      deps.markReminded(r.id, [...done, ...due.map(x => x.key)].slice(-20))
      const first = due[0]
      const n = new Notification({ title: first.title, body: first.body, silent: false })
      live.add(n)
      n.on('click', () => {
        deps.openFinance(r.id)
        live.delete(n)
      })
      n.on('close', () => live.delete(n))
      n.show()
    }
  }
  setTimeout(tick, 20_000)
  return setInterval(tick, 60_000)
}
