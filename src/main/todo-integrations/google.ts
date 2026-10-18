/**
 * Google Tasks / Google Calendar（REST v1 / v3）。
 * token 来自对 Gmail 账户的增量授权（tasks、calendar.events scope），见 oauth/index.ts。
 */
import type { BusyBlock, CalendarAdapter, CalendarEventFields, RemoteTask, SyncTarget, TaskFields, TasksAdapter } from './types'
import { NotFoundError } from './types'
import { apiRequest, qs, type FetchLike, type TokenGetter } from './http'
import { encodeBody, localDateKey, localMidnightOf } from './merge'

const TASKS = 'https://tasks.googleapis.com/tasks/v1'
const CAL = 'https://www.googleapis.com/calendar/v3'

/** Google Tasks 资源（只列用到的字段） */
export interface GTask {
  id: string
  etag?: string
  title?: string
  notes?: string
  status?: 'needsAction' | 'completed'
  /** RFC 3339，只有日期部分有效 */
  due?: string
  completed?: string
  updated?: string
  deleted?: boolean
  hidden?: boolean
  parent?: string
}

export function gtaskToRemote(t: GTask): RemoteTask {
  const updated = t.updated ? Date.parse(t.updated) : 0
  return {
    id: t.id,
    title: t.title ?? '',
    notes: t.notes ?? '',
    due: t.due ? { at: localMidnightOf(t.due.slice(0, 10)), allDay: true } : null,
    completed: t.status === 'completed',
    completedAt: t.completed ? Date.parse(t.completed) : null,
    // 不支持优先级；子项由 notes 尾部解析
    modifiedAt: updated,
    etag: t.etag ?? String(updated),
    deleted: !!t.deleted
  }
}

/** 写入体：due 只保留本地日期（Google 丢弃时间部分）；取消完成时必须清掉 completed */
export function fieldsToGTask(f: TaskFields): Record<string, unknown> {
  return {
    title: f.title,
    notes: encodeBody(f.notes, f.checklist),
    due: f.due ? `${localDateKey(f.due.at)}T00:00:00.000Z` : null,
    status: f.completed ? 'completed' : 'needsAction',
    ...(f.completed ? {} : { completed: null })
  }
}

export class GoogleTasksAdapter implements TasksAdapter {
  readonly kind = 'tasks' as const
  readonly provider = 'google-tasks' as const

  constructor(
    private getToken: TokenGetter,
    private fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  private req<T>(method: string, url: string, body?: unknown) {
    return apiRequest<T>(this.fetchImpl, this.getToken, method, url, body)
  }

  async listTargets(): Promise<SyncTarget[]> {
    const out: SyncTarget[] = []
    let pageToken: string | undefined
    do {
      const res = await this.req<{ items?: { id: string; title: string }[]; nextPageToken?: string }>(
        'GET',
        `${TASKS}/users/@me/lists?${qs({ maxResults: 100, pageToken })}`
      )
      for (const l of res.items ?? []) out.push({ id: l.id, name: l.title })
      pageToken = res.nextPageToken
    } while (pageToken)
    return out
  }

  /** since 为空：完整快照；否则增量（updatedMin + showDeleted，删除项带 deleted） */
  async listItems(listId: string, since: number | null): Promise<{ items: RemoteTask[]; complete: boolean }> {
    const items: RemoteTask[] = []
    let pageToken: string | undefined
    const incremental = since != null
    do {
      const res = await this.req<{ items?: GTask[]; nextPageToken?: string }>(
        'GET',
        `${TASKS}/lists/${encodeURIComponent(listId)}/tasks?${qs({
          maxResults: 100,
          showCompleted: true,
          showHidden: true,
          showDeleted: incremental ? true : undefined,
          // 回拨 5 分钟，容忍两端时钟偏差
          updatedMin: incremental ? new Date(since - 5 * 60_000).toISOString() : undefined,
          pageToken
        })}`
      )
      for (const t of res.items ?? []) items.push(gtaskToRemote(t))
      pageToken = res.nextPageToken
    } while (pageToken)
    return { items, complete: !incremental }
  }

  async create(listId: string, f: TaskFields): Promise<RemoteTask> {
    const body = fieldsToGTask(f)
    if (!f.due) delete body.due
    delete body.completed
    const t = await this.req<GTask>('POST', `${TASKS}/lists/${encodeURIComponent(listId)}/tasks`, body)
    return gtaskToRemote(t)
  }

  async update(listId: string, id: string, f: TaskFields): Promise<RemoteTask> {
    const t = await this.req<GTask>('PATCH', `${TASKS}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(id)}`, fieldsToGTask(f))
    return gtaskToRemote(t)
  }

  async remove(listId: string, id: string): Promise<void> {
    try {
      await this.req('DELETE', `${TASKS}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(id)}`)
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err
    }
  }
}

interface GEvent {
  id: string
  etag?: string
  summary?: string
  status?: string
  transparency?: 'opaque' | 'transparent'
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
}

export function fieldsToGEvent(f: CalendarEventFields): Record<string, unknown> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return {
    summary: f.title,
    description: f.notes,
    start: { dateTime: new Date(f.start).toISOString(), timeZone: tz },
    end: { dateTime: new Date(f.end).toISOString(), timeZone: tz },
    ...(f.url ? { source: { title: 'LinkTo', url: f.url } } : {})
  }
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  readonly kind = 'calendar' as const
  readonly provider = 'google-calendar' as const

  constructor(
    private getToken: TokenGetter,
    private fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  private req<T>(method: string, url: string, body?: unknown) {
    return apiRequest<T>(this.fetchImpl, this.getToken, method, url, body)
  }

  private async calendars(minAccessRole?: string): Promise<{ id: string; summary: string; primary?: boolean; selected?: boolean }[]> {
    const out: { id: string; summary: string; primary?: boolean; selected?: boolean }[] = []
    let pageToken: string | undefined
    do {
      const res = await this.req<{ items?: { id: string; summary: string; primary?: boolean; selected?: boolean }[]; nextPageToken?: string }>(
        'GET',
        `${CAL}/users/me/calendarList?${qs({ minAccessRole, maxResults: 250, pageToken })}`
      )
      out.push(...(res.items ?? []))
      pageToken = res.nextPageToken
    } while (pageToken)
    return out
  }

  async listTargets(): Promise<SyncTarget[]> {
    try {
      return (await this.calendars('writer')).map(c => ({ id: c.id, name: c.primary ? `${c.summary}（主日历）` : c.summary }))
    } catch {
      // 未授予 calendarlist 只读权限时退回主日历
      return [{ id: 'primary', name: '主日历' }]
    }
  }

  async createEvent(calendarId: string, f: CalendarEventFields) {
    const e = await this.req<GEvent>('POST', `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`, fieldsToGEvent(f))
    return { id: e.id, etag: e.etag ?? '' }
  }

  async updateEvent(calendarId: string, id: string, f: CalendarEventFields) {
    const e = await this.req<GEvent>('PATCH', `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`, fieldsToGEvent(f))
    return { id: e.id, etag: e.etag ?? '' }
  }

  async removeEvent(calendarId: string, id: string) {
    try {
      await this.req('DELETE', `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`)
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err
    }
  }

  async busyBlocks(from: number, to: number, excludeCalendarId: string | null): Promise<BusyBlock[]> {
    let ids: string[]
    try {
      ids = (await this.calendars()).filter(c => c.primary || c.selected).map(c => c.id)
    } catch {
      ids = ['primary']
    }
    const out: BusyBlock[] = []
    for (const id of ids.slice(0, 12)) {
      if (id === excludeCalendarId) continue
      const res = await this.req<{ items?: GEvent[] }>(
        'GET',
        `${CAL}/calendars/${encodeURIComponent(id)}/events?${qs({
          timeMin: new Date(from).toISOString(),
          timeMax: new Date(to).toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250
        })}`
      ).catch(() => ({ items: [] as GEvent[] }))
      for (const e of res.items ?? []) {
        // 全天 / 标记为「有空」/ 已取消的不算忙碌
        if (!e.start?.dateTime || !e.end?.dateTime || e.transparency === 'transparent' || e.status === 'cancelled') continue
        out.push({ start: Date.parse(e.start.dateTime), end: Date.parse(e.end.dateTime), title: e.summary ?? '' })
      }
    }
    return out
  }
}
