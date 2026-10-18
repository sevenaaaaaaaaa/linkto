import { Notification, shell } from 'electron'
import type { MailStore } from './db'
import type { TodoData } from '@shared/types'

const MEETING_LABEL: Record<string, string> = {
  zoom: 'Zoom',
  teams: 'Teams',
  meet: 'Google Meet',
  tencent: '腾讯会议',
  feishu: '飞书会议',
  webex: 'Webex',
  other: '会议'
}

/**
 * 待办提醒：固定时间的事项（会议 / 约好的电话）开始前 5 分钟、带具体时刻的截止前 15 分钟各提醒一次。
 * 会议提醒点击直接入会；其他提醒点击打开待办页。每条只提醒一次（记在 data.remindedAt）。
 */
export function startTodoReminders(deps: {
  store: MailStore
  enabled(): boolean
  openTodo(id: string): void
}) {
  const live = new Set<Notification>()
  const tick = () => {
    if (!deps.enabled() || !Notification.isSupported()) return
    const now = Date.now()
    for (const t of deps.store.listInsights('todo')) {
      if (t.status !== 'open') continue
      const d = (t.data ?? {}) as TodoData & { remindedAt?: number }
      if (d.remindedAt) continue
      const start = d.meeting?.startsAt ?? d.fixedAt ?? null
      const dueHasTime = t.dueAt && new Date(t.dueAt).getHours() + new Date(t.dueAt).getMinutes() > 0
      let title = ''
      let body = ''
      if (start && start - now <= 5 * 60_000 && start - now > -10 * 60_000) {
        const mins = Math.max(0, Math.round((start - now) / 60_000))
        title = mins ? `${mins} 分钟后：${t.title}` : `现在开始：${t.title}`
        body = d.meeting ? `${MEETING_LABEL[d.meeting.provider] ?? '会议'} · 点击入会${d.meeting.code ? ` · 会议号 ${d.meeting.code}` : ''}` : '固定时间的待办'
      } else if (!start && dueHasTime && t.dueAt! - now <= 15 * 60_000 && t.dueAt! - now > -5 * 60_000) {
        title = `即将截止：${t.title}`
        body = `${new Date(t.dueAt!).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 截止`
      } else continue

      deps.store.updateInsight(t.id, { data: { remindedAt: now, updatedAt: d.updatedAt ?? now } })
      const n = new Notification({ title, body, silent: false })
      live.add(n)
      n.on('click', () => {
        if (d.meeting?.url) void shell.openExternal(d.meeting.url)
        else deps.openTodo(t.id)
        live.delete(n)
      })
      n.on('close', () => live.delete(n))
      n.show()
    }
  }
  setTimeout(tick, 15_000)
  return setInterval(tick, 30_000)
}
