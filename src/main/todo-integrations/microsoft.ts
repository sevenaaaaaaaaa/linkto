/**
 * Microsoft To Do / Outlook 日历（Microsoft Graph v1.0）。
 * token 来自对 Outlook 账户的增量授权（Tasks.ReadWrite、Calendars.ReadWrite），见 oauth/index.ts。
 */
import type { BusyBlock, CalendarAdapter, CalendarEventFields, ChecklistLine, RemoteTask, SyncTarget, TaskFields, TasksAdapter } from './types'
import { NotFoundError } from './types'
import { apiRequest, type FetchLike, type TokenGetter } from './http'
import { localDateKey, localMidnightOf, priorityFromImportance, priorityToImportance } from './merge'

const GRAPH = 'https://graph.microsoft.com/v1.0'

interface DateTimeTimeZone {
  dateTime: string
  timeZone: string
}

export interface GraphTask {
  id: string
  '@odata.etag'?: string
  title?: string
  body?: { content?: string; contentType?: 'text' | 'html' }
  importance?: 'low' | 'normal' | 'high'
  status?: 'notStarted' | 'inProgress' | 'completed' | 'waitingOnOthers' | 'deferred'
  dueDateTime?: DateTimeTimeZone | null
  completedDateTime?: DateTimeTimeZone | null
  lastModifiedDateTime?: string
  checklistItems?: { id: string; displayName: string; isChecked: boolean }[]
}

/** Graph dateTime 没有时区后缀：UTC 时补 Z */
export function parseGraphDate(d: DateTimeTimeZone | null | undefined): number | null {
  if (!d?.dateTime) return null
  const iso = /^utc$/i.test(d.timeZone) && !/[zZ]|[+-]\d\d:?\d\d$/.test(d.dateTime) ? `${d.dateTime}Z` : d.dateTime
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

const stripHtml = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()

export function graphTaskToRemote(t: GraphTask): RemoteTask {
  const modified = t.lastModifiedDateTime ? Date.parse(t.lastModifiedDateTime) : 0
  const content = t.body?.content ?? ''
  return {
    id: t.id,
    title: t.title ?? '',
    notes: t.body?.contentType === 'html' ? stripHtml(content) : content.trim(),
    // To Do 的截止只有日期：取日期部分当本地日期
    due: t.dueDateTime?.dateTime ? { at: localMidnightOf(t.dueDateTime.dateTime.slice(0, 10)), allDay: true } : null,
    completed: t.status === 'completed',
    completedAt: parseGraphDate(t.completedDateTime),
    priority: priorityFromImportance(t.importance),
    priorityLoose: true,
    checklist: (t.checklistItems ?? []).map(c => ({ id: c.id, text: c.displayName, done: !!c.isChecked })),
    modifiedAt: modified,
    etag: t['@odata.etag'] ?? String(modified)
  }
}

export function fieldsToGraphTask(f: TaskFields): Record<string, unknown> {
  return {
    title: f.title,
    body: { content: f.notes, contentType: 'text' },
    importance: priorityToImportance(f.priority),
    status: f.completed ? 'completed' : 'notStarted',
    dueDateTime: f.due ? { dateTime: `${localDateKey(f.due.at)}T00:00:00.0000000`, timeZone: 'UTC' } : null
  }
}

/** 子项差异：按文字匹配，返回需要新增 / 修改 / 删除的 Graph checklistItems */
export function diffChecklist(remote: ChecklistLine[], wanted: ChecklistLine[]) {
  const pool = [...remote]
  const add: ChecklistLine[] = []
  const patch: { id: string; done: boolean }[] = []
  for (const w of wanted) {
    const i = pool.findIndex(r => r.text === w.text)
    if (i < 0) {
      add.push(w)
      continue
    }
    const [r] = pool.splice(i, 1)
    if (r.done !== w.done && r.id) patch.push({ id: r.id, done: w.done })
  }
  const remove = pool.filter(r => r.id).map(r => r.id as string)
  return { add, patch, remove }
}

export class MsTodoAdapter implements TasksAdapter {
  readonly kind = 'tasks' as const
  readonly provider = 'ms-todo' as const

  constructor(
    private getToken: TokenGetter,
    private fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  private req<T>(method: string, url: string, body?: unknown) {
    return apiRequest<T>(this.fetchImpl, this.getToken, method, url, body)
  }

  private taskUrl(listId: string, id?: string) {
    return `${GRAPH}/me/todo/lists/${encodeURIComponent(listId)}/tasks${id ? `/${encodeURIComponent(id)}` : ''}`
  }

  async listTargets(): Promise<SyncTarget[]> {
    const out: SyncTarget[] = []
    let url: string | undefined = `${GRAPH}/me/todo/lists`
    while (url) {
      const res: { value?: { id: string; displayName: string }[]; '@odata.nextLink'?: string } = await this.req('GET', url)
      for (const l of res.value ?? []) out.push({ id: l.id, name: l.displayName })
      url = res['@odata.nextLink']
    }
    return out
  }

  /** 完整快照（清单通常不大）：没出现的即为远端已删除 */
  async listItems(listId: string): Promise<{ items: RemoteTask[]; complete: boolean }> {
    const items: RemoteTask[] = []
    let url: string | undefined = `${this.taskUrl(listId)}?$top=100&$expand=checklistItems`
    while (url) {
      const res: { value?: GraphTask[]; '@odata.nextLink'?: string } = await this.req('GET', url)
      for (const t of res.value ?? []) items.push(graphTaskToRemote(t))
      url = res['@odata.nextLink']
    }
    return { items, complete: true }
  }

  private async syncChecklist(listId: string, id: string, remote: ChecklistLine[], wanted: ChecklistLine[]): Promise<boolean> {
    const { add, patch, remove } = diffChecklist(remote, wanted)
    const base = `${this.taskUrl(listId, id)}/checklistItems`
    for (const a of add) await this.req('POST', base, { displayName: a.text, isChecked: a.done })
    for (const p of patch) await this.req('PATCH', `${base}/${encodeURIComponent(p.id)}`, { isChecked: p.done })
    for (const r of remove) await this.req('DELETE', `${base}/${encodeURIComponent(r)}`).catch(err => {
      if (!(err instanceof NotFoundError)) throw err
    })
    return add.length + patch.length + remove.length > 0
  }

  private async fetchOne(listId: string, id: string): Promise<RemoteTask> {
    return graphTaskToRemote(await this.req<GraphTask>('GET', `${this.taskUrl(listId, id)}?$expand=checklistItems`))
  }

  async create(listId: string, f: TaskFields): Promise<RemoteTask> {
    const body = fieldsToGraphTask(f)
    if (!f.due) delete body.dueDateTime
    const t = await this.req<GraphTask>('POST', this.taskUrl(listId), body)
    if (f.checklist.length && (await this.syncChecklist(listId, t.id, [], f.checklist))) return this.fetchOne(listId, t.id)
    return graphTaskToRemote({ ...t, checklistItems: [] })
  }

  async update(listId: string, id: string, f: TaskFields, prev: RemoteTask | null): Promise<RemoteTask> {
    const t = await this.req<GraphTask>('PATCH', this.taskUrl(listId, id), fieldsToGraphTask(f))
    const remoteList = prev?.checklist ?? (await this.fetchOne(listId, id)).checklist ?? []
    if (await this.syncChecklist(listId, id, remoteList, f.checklist)) return this.fetchOne(listId, id)
    return graphTaskToRemote({ ...t, checklistItems: remoteList.map(c => ({ id: c.id ?? '', displayName: c.text, isChecked: c.done })) })
  }

  async remove(listId: string, id: string): Promise<void> {
    try {
      await this.req('DELETE', this.taskUrl(listId, id))
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err
    }
  }
}

interface GraphEvent {
  id: string
  '@odata.etag'?: string
  subject?: string
  isAllDay?: boolean
  isCancelled?: boolean
  showAs?: 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere' | 'unknown'
  start?: DateTimeTimeZone
  end?: DateTimeTimeZone
}

const utcLocal = (ms: number) => new Date(ms).toISOString().replace(/Z$/, '')

export function fieldsToGraphEvent(f: CalendarEventFields): Record<string, unknown> {
  return {
    subject: f.title,
    body: { contentType: 'text', content: f.notes },
    start: { dateTime: utcLocal(f.start), timeZone: 'UTC' },
    end: { dateTime: utcLocal(f.end), timeZone: 'UTC' },
    ...(f.url ? { isOnlineMeeting: false, location: { displayName: f.url } } : {})
  }
}

export class MsCalendarAdapter implements CalendarAdapter {
  readonly kind = 'calendar' as const
  readonly provider = 'ms-calendar' as const

  constructor(
    private getToken: TokenGetter,
    private fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  private req<T>(method: string, url: string, body?: unknown, headers?: Record<string, string>) {
    return apiRequest<T>(this.fetchImpl, this.getToken, method, url, body, headers)
  }

  private async calendars(): Promise<{ id: string; name: string; canEdit?: boolean }[]> {
    const res = await this.req<{ value?: { id: string; name: string; canEdit?: boolean }[] }>('GET', `${GRAPH}/me/calendars?$top=50`)
    return res.value ?? []
  }

  async listTargets(): Promise<SyncTarget[]> {
    return (await this.calendars()).filter(c => c.canEdit !== false).map(c => ({ id: c.id, name: c.name }))
  }

  async createEvent(calendarId: string, f: CalendarEventFields) {
    const e = await this.req<GraphEvent>('POST', `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/events`, fieldsToGraphEvent(f))
    return { id: e.id, etag: e['@odata.etag'] ?? '' }
  }

  async updateEvent(_calendarId: string, id: string, f: CalendarEventFields) {
    const e = await this.req<GraphEvent>('PATCH', `${GRAPH}/me/events/${encodeURIComponent(id)}`, fieldsToGraphEvent(f))
    return { id: e.id, etag: e['@odata.etag'] ?? '' }
  }

  async removeEvent(_calendarId: string, id: string) {
    try {
      await this.req('DELETE', `${GRAPH}/me/events/${encodeURIComponent(id)}`)
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err
    }
  }

  async busyBlocks(from: number, to: number, excludeCalendarId: string | null): Promise<BusyBlock[]> {
    const out: BusyBlock[] = []
    for (const c of (await this.calendars()).slice(0, 12)) {
      if (c.id === excludeCalendarId) continue
      const url =
        `${GRAPH}/me/calendars/${encodeURIComponent(c.id)}/calendarView?startDateTime=${encodeURIComponent(new Date(from).toISOString())}` +
        `&endDateTime=${encodeURIComponent(new Date(to).toISOString())}&$select=subject,start,end,isAllDay,isCancelled,showAs&$top=200`
      const res = await this.req<{ value?: GraphEvent[] }>('GET', url, undefined, { Prefer: 'outlook.timezone="UTC"' }).catch(() => ({ value: [] as GraphEvent[] }))
      for (const e of res.value ?? []) {
        if (e.isAllDay || e.isCancelled || e.showAs === 'free') continue
        const s = parseGraphDate(e.start), en = parseGraphDate(e.end)
        if (s != null && en != null) out.push({ start: s, end: en, title: e.subject ?? '' })
      }
    }
    return out
  }
}
