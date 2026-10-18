import type { MailInsight } from '@shared/types'
import type { MailStore } from './db'

/** 待办元数据（存在 insights.data 里）：排布所需的时长 / 优先级 / 来源等 */
export interface TodoData {
  /** 来源：mail 自动收集 / agent / rule / manual / bulk / mcp … */
  from?: string
  /** reply：回复类待办，回信后自动完成；task：普通任务 */
  todoKind?: 'reply' | 'task'
  /** 预估时长（分钟） */
  minutes?: number
  /** 1 高 · 2 中 · 3 低 */
  priority?: 1 | 2 | 3
  auto?: boolean
}

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
  const data: TodoData = { from: 'mail', todoKind: kind, minutes, priority: priorityOf(ins.urgency), auto: true }
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
