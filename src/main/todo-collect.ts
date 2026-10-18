import { readFileSync } from 'node:fs'
import type { MailInsight, TodoData } from '@shared/types'
import { detectMeeting } from './meeting'
import type { MailStore } from './db'

const priorityOf = (urgency: number): 1 | 2 | 3 => (urgency >= 70 ? 1 : urgency >= 40 ? 2 : 3)

/**
 * 从邮件理解结果自动收集待办（幂等：同一封邮件只收一次，用户删除 / 改动后不再覆盖）。
 * 收集条件：「需要你处理」且有明确事项——AI 建议的待办、截止时间，或紧急的待回复。
 */
export function collectTodoFromInsight(store: MailStore, ins: MailInsight): boolean {
  if (ins.section !== 'act') return false
  const row = store.getMessageRow(ins.messageId)
  if (!row || row.folder_path !== 'INBOX') return false
  const todoNext = ins.next.find(n => n.kind === 'todo')
  const deadline = ins.entities.find(e => e.kind === 'deadline')
  const replyNext = ins.next.find(n => n.kind === 'reply')
  let title = ''
  let kind: 'reply' | 'task' = 'task'
  let minutes = 25
  if (todoNext) title = (todoNext.title || todoNext.label).replace(/^建待办[:：]\s*/, '')
  else if (deadline) title = ins.gist || row.subject || '处理邮件'
  else if (replyNext && ins.urgency >= 60) {
    title = `回复 ${row.from_name || row.from_addr || ''}：${(row.subject || '').slice(0, 40)}`
    kind = 'reply'
    minutes = 10
  } else return false
  const dueRaw = todoNext?.due || deadline?.value || null
  const due = dueRaw ? Date.parse(String(dueRaw).length <= 10 ? `${dueRaw}T18:00:00` : String(dueRaw)) : NaN
  const data: TodoData = { from: 'mail', todoKind: kind, minutes, priority: priorityOf(ins.urgency), auto: true, inbox: !Number.isFinite(due), updatedAt: Date.now() }
  return store.insertInsightIfAbsent({
    id: `todo-mail-${ins.messageId}`.slice(0, 160),
    kind: 'todo',
    accountId: row.account_id,
    messageId: ins.messageId,
    title: title.slice(0, 120),
    data: data as Record<string, unknown>,
    dueAt: Number.isFinite(due) ? due : null
  })
}

/** 回信后推进：这封邮件上的「回复类」待办自动完成 */
export function advanceTodoOnReply(store: MailStore, messageId: string): boolean {
  const id = `todo-mail-${messageId}`.slice(0, 160)
  const row = store.listInsights('todo').find(t => t.id === id)
  if (!row || row.status !== 'open' || (row.data as TodoData).todoKind !== 'reply') return false
  store.updateInsight(id, { status: 'done', data: { doneBy: 'reply', doneAt: Date.now() } })
  return true
}

/**
 * 会议邮件 → 固定时间的会议待办（带入会链接）。优先读日历邀请附件（.ics），否则用正文链接 + 理解出的时间。
 * 幂等：同一封邮件只建一次；改期邀请（新邮件）会生成新的会议待办。
 */
export function collectMeetingTodo(store: MailStore, ins: MailInsight): boolean {
  const row = store.getMessageRow(ins.messageId)
  if (!row || row.folder_path !== 'INBOX') return false
  let ics: string | null = null
  try {
    const att = store.db
      .prepare("SELECT path FROM attachments WHERE message_id = ? AND (lower(content_type) LIKE 'text/calendar%' OR lower(filename) LIKE '%.ics') LIMIT 1")
      .get(ins.messageId) as { path?: string } | undefined
    if (att?.path) ics = readFileSync(att.path, 'utf8')
  } catch {
    /* 附件未下载 / 读取失败：退回正文识别 */
  }
  const time = ins.entities.find(e => e.kind === 'time' || e.kind === 'deadline')
  const fallback = time ? Date.parse(String(time.value)) : NaN
  const found = detectMeeting({
    subject: row.subject ?? '',
    text: String(row.text ?? ''),
    html: row.html ?? null,
    ics,
    fallbackStart: Number.isFinite(fallback) ? fallback : null
  })
  // 只收未来 / 正在进行的会议
  if (!found || found.meeting.startsAt < Date.now() - 2 * 3600_000) return false
  const minutes = found.meeting.endsAt ? Math.max(15, Math.round((found.meeting.endsAt - found.meeting.startsAt) / 60_000)) : 60
  const data: TodoData = {
    from: 'meeting',
    todoKind: 'meeting',
    minutes,
    priority: 2,
    fixedAt: found.meeting.startsAt,
    meeting: found.meeting,
    auto: true,
    updatedAt: Date.now()
  }
  return store.insertInsightIfAbsent({
    id: `todo-meet-${ins.messageId}`.slice(0, 160),
    kind: 'todo',
    accountId: row.account_id,
    messageId: ins.messageId,
    title: found.title,
    data: data as Record<string, unknown>,
    dueAt: found.meeting.startsAt
  })
}

/** 手动「转为待办」：用邮件理解的要点 / 建议 / 截止生成一条待办，返回 id（已存在则直接返回） */
export function todoFromMessage(store: MailStore, ins: MailInsight | undefined, messageId: string): string | null {
  const row = store.getMessageRow(messageId)
  if (!row) return null
  const id = `todo-mail-${messageId}`.slice(0, 160)
  const exists = store.listInsights('todo').find(t => t.id === id)
  if (exists) {
    // 之前被删除过：恢复
    if (exists.status === 'dismissed') store.updateInsight(id, { status: 'open', data: { inbox: true } })
    return id
  }
  const todoNext = ins?.next.find(n => n.kind === 'todo')
  const deadline = ins?.entities.find(e => e.kind === 'deadline' || e.kind === 'time')
  const due = todoNext?.due || deadline?.value
  const dueAt = due ? Date.parse(String(due).length <= 10 ? `${due}T18:00:00` : String(due)) : NaN
  const replyish = !todoNext && ins?.next.some(n => n.kind === 'reply')
  const title = todoNext ? (todoNext.title || todoNext.label).replace(/^建待办[:：]\s*/, '') : replyish ? `回复 ${row.from_name || row.from_addr || ''}：${row.subject ?? ''}` : row.subject || '处理邮件'
  const data: TodoData = {
    from: 'mail',
    todoKind: replyish ? 'reply' : 'task',
    minutes: replyish ? 10 : 25,
    priority: ins && ins.urgency >= 70 ? 1 : 2,
    updatedAt: Date.now()
  }
  store.insertInsight({ id, kind: 'todo', accountId: row.account_id, messageId, title: title.slice(0, 120), data: data as Record<string, unknown>, dueAt: Number.isFinite(dueAt) ? dueAt : null })
  return id
}
