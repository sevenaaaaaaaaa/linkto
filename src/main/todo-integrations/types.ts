import type { TodoProvider } from '@shared/types'

/** 截止时间：allDay = 只有日期（Google Tasks / To Do 只存日期） */
export interface TaskDue {
  at: number
  allDay: boolean
}

export interface ChecklistLine {
  text: string
  done: boolean
  /** 外部服务里的子项 id（Graph checklistItems） */
  id?: string
}

/** 外部任务（统一形状）。可选字段为 undefined 表示该服务不支持 */
export interface RemoteTask {
  id: string
  title: string
  notes: string
  due: TaskDue | null
  completed: boolean
  completedAt?: number | null
  /** 1 高 · 2 中 · 3 低；null = 无 */
  priority?: 1 | 2 | 3 | null
  /** priority 为 null 时含义模糊（Graph 的 normal 可能是「中」也可能是「无」） */
  priorityLoose?: boolean
  /** 原生子项（Graph）；Reminders / Google 由 notes 尾部的 ☐/☑ 行解析 */
  checklist?: ChecklistLine[] | null
  /** 远端最后修改时间（ms） */
  modifiedAt: number
  /** 版本标记：etag / 修改时间字符串；变了 = 远端改过 */
  etag: string
  /** 增量列表里的已删除项（Google showDeleted） */
  deleted?: boolean
}

/** 写到外部的字段 */
export interface TaskFields {
  title: string
  notes: string
  due: TaskDue | null
  completed: boolean
  priority: 1 | 2 | 3 | null
  checklist: ChecklistLine[]
}

export interface SyncTarget {
  id: string
  name: string
}

export interface TasksAdapter {
  kind: 'tasks'
  provider: TodoProvider
  listTargets(): Promise<SyncTarget[]>
  /** complete=true：返回的是清单完整快照（没出现 = 已删除）；false：增量（删除靠 deleted 标记） */
  listItems(listId: string, since: number | null): Promise<{ items: RemoteTask[]; complete: boolean }>
  create(listId: string, f: TaskFields): Promise<RemoteTask>
  /** 返回更新后的任务；id 可能变化（如提醒事项清除截止日期需重建）。不存在时抛 NotFoundError */
  update(listId: string, id: string, f: TaskFields, prev: RemoteTask | null): Promise<RemoteTask>
  /** 不存在视为成功 */
  remove(listId: string, id: string): Promise<void>
}

export interface CalendarEventFields {
  title: string
  notes: string
  start: number
  end: number
  url?: string | null
}

export interface BusyBlock {
  start: number
  end: number
  title: string
}

export interface CalendarAdapter {
  kind: 'calendar'
  provider: TodoProvider
  listTargets(): Promise<SyncTarget[]>
  createEvent(calendarId: string, f: CalendarEventFields): Promise<{ id: string; etag: string }>
  /** 不存在时抛 NotFoundError */
  updateEvent(calendarId: string, id: string, f: CalendarEventFields): Promise<{ id: string; etag: string }>
  removeEvent(calendarId: string, id: string): Promise<void>
  /** [from, to) 内除 excludeCalendarId 外的非全天日程 */
  busyBlocks(from: number, to: number, excludeCalendarId: string | null): Promise<BusyBlock[]>
}

export type Adapter = TasksAdapter | CalendarAdapter

export class NotFoundError extends Error {
  constructor(message = '外部条目不存在') {
    super(message)
    this.name = 'NotFoundError'
  }
}

/** 系统拒绝自动化（Apple 事件）或 OAuth 权限不足：需要用户处理，不自动重试 */
export class PermissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionError'
  }
}
