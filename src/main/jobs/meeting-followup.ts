/* eslint-disable @typescript-eslint/no-explicit-any */
import { Notification } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentActivity, TodoData } from '@shared/types'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import { DEFAULT_NOTIFICATIONS } from '../store'
import { inQuietHours } from '../notify-policy'
import { recentlyEndedMeetings } from '../agent/events'
import type { JobDef } from './scheduler'

/** 会后拆解技能（内置） */
export const MEETING_NOTES_SKILL = 'meeting-notes-breakdown'

/**
 * 自动任务「会后跟进」：每 30 分钟找最近 24 小时内已结束的会（待办里的会议：endsAt，缺省开始后 1 小时），
 * 在活动记录里提示「刚结束的会：要我把要点整理成待办吗？」并附一键运行（以会议邮件为上下文打开 Agent 对话运行会后技能），
 * 按通知设置发一条系统通知。每个会只提示一次（agent_meeting_prompts 表）。不用 AI。
 */
export function meetingFollowupJob(deps: {
  db: DatabaseSync
  store: MailStore
  appStore: AppStore
  log(a: Omit<AgentActivity, 'id' | 'at'>): AgentActivity
  showActivity(): void
}): JobDef {
  deps.db.exec('CREATE TABLE IF NOT EXISTS agent_meeting_prompts (todo_id TEXT PRIMARY KEY, at INTEGER NOT NULL)')
  const notify = (title: string, body: string) => {
    try {
      const s = deps.appStore.get('notifications', DEFAULT_NOTIFICATIONS)
      if (!s.enabled || inQuietHours(s.quietHours, new Date()) || !Notification.isSupported()) return
      const n = new Notification({ title, body, silent: !s.sound })
      n.on('click', () => deps.showActivity())
      n.show()
    } catch {
      /* 通知失败不影响活动记录 */
    }
  }
  return {
    id: 'meeting-followup',
    name: '会后跟进',
    description: '会议结束后提示把要点整理成待办与跟进邮件（一键以会议邮件为上下文运行「会后纪要拆解」）',
    category: 'collect',
    ai: 'none',
    cadence: { kind: 'every', ms: 30 * 60_000 },
    defaultEnabled: true,
    run: async ctx => {
      const prompted = new Set((deps.db.prepare('SELECT todo_id FROM agent_meeting_prompts WHERE at >= ?').all(ctx.now - 7 * 86_400_000) as any[]).map(r => String(r.todo_id)))
      const todos = deps.store
        .listInsights('todo')
        .map(t => ({ id: t.id, title: t.title, messageId: t.messageId ?? null, status: t.status, meeting: (t.data as TodoData)?.meeting ?? null }))
      const ended = recentlyEndedMeetings(todos, ctx.now, prompted).slice(0, 3)
      for (const m of ended) {
        deps.db.prepare('INSERT OR IGNORE INTO agent_meeting_prompts (todo_id, at) VALUES (?, ?)').run(m.todoId, ctx.now)
        const mins = Math.max(1, Math.round((ctx.now - m.endedAt) / 60_000))
        const ago = mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`
        deps.log({
          source: 'event',
          title: `刚结束的会：『${m.title.slice(0, 40)}』—— 要我把要点整理成待办吗？`,
          detail: `${ago}结束。点「整理成待办」会以这封会议邮件为上下文运行「会后纪要拆解」：找纪要 / 会后邮件，拆出我的待办和给别人的跟进邮件草稿（都需要你确认）。`,
          refs: [{ type: 'todo', id: m.todoId, label: m.title.slice(0, 60) }, ...(m.messageId ? [{ type: 'mail' as const, id: m.messageId, label: '会议邮件' }] : [])],
          action: m.messageId ? { label: '整理成待办', skillId: MEETING_NOTES_SKILL, messageId: m.messageId } : null
        })
      }
      if (ended.length) notify(ended.length === 1 ? `刚结束的会：${ended[0].title.slice(0, 40)}` : `${ended.length} 个会刚结束`, '要我把要点整理成待办吗？点开活动记录一键运行')
      return { summary: ended.length ? `提示了 ${ended.length} 个刚结束的会` : '没有刚结束的会' }
    }
  }
}
