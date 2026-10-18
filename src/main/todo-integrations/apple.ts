/**
 * Apple 提醒事项 / 日历：通过 osascript 运行 JXA（JavaScript for Automation），不引入原生模块。
 * 参数一律 JSON.stringify 后注入脚本，结果以 JSON 字符串返回。
 * 首次调用 macOS 会弹「LinkTo 想要控制 提醒事项 / 日历」授权框；被拒绝时报 -1743。
 */
import { execFile } from 'node:child_process'
import type { BusyBlock, CalendarAdapter, CalendarEventFields, RemoteTask, SyncTarget, TaskFields, TasksAdapter } from './types'
import { NotFoundError, PermissionError } from './types'
import { encodeBody, priorityFromReminders, priorityToReminders } from './merge'

const AUTOMATION_HINT = (app: string) =>
  `macOS 未允许 LinkTo 控制「${app}」：请到 系统设置 → 隐私与安全性 → 自动化 → LinkTo，勾选「${app}」后重试`

/** 运行一段 JXA；args 作为常量 A 注入。返回脚本最后一个表达式（应为 JSON 字符串）解析后的值 */
export function runJxa<T>(appName: string, body: string, args: unknown, timeoutMs = 30_000): Promise<T> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('仅 macOS 支持'))
  const script = `const A = ${JSON.stringify(args ?? null)};\n(() => {\n${body}\n})()`
  return new Promise<T>((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = `${stderr || ''} ${err.message || ''}`
        if (/-1743|Not authorized to send Apple events|不允许发送 Apple 事件|未获得授权/i.test(msg)) {
          reject(new PermissionError(AUTOMATION_HINT(appName)))
          return
        }
        if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          reject(new Error(`${appName} 响应超时（可能正在等待你在系统弹窗里允许访问）`))
          return
        }
        if (/NOT_FOUND|-1728|-1719|Can.t get|不能获取/i.test(msg)) {
          reject(new NotFoundError())
          return
        }
        reject(new Error(`${appName}：${(stderr || err.message).trim().slice(0, 200)}`))
        return
      }
      const out = stdout.trim()
      try {
        resolve((out ? JSON.parse(out) : null) as T)
      } catch {
        reject(new Error(`${appName} 返回无法解析：${out.slice(0, 120)}`))
      }
    })
  })
}

// ================= 提醒事项 =================

/** JXA 片段：读取一条提醒为统一形状（日期前 1970 视为空：清空截止日后 JXA 会返回 1904 年） */
const READ_REMINDER = `
function ms(d) { if (!d) return null; const t = d.getTime(); return t > 0 ? t : null }
function readR(r) {
  const due = ms(r.dueDate()), ad = ms(r.alldayDueDate()), mod = ms(r.modificationDate()) || 0
  return { id: r.id(), name: r.name() || '', body: r.body() || '', due, allDay: due != null && ad != null && due === ad,
    completed: !!r.completed(), completedAt: ms(r.completionDate()), priority: r.priority() || 0, mod }
}
function applyR(r, f) {
  r.name = f.title
  r.body = f.body
  if (f.due) { if (f.due.allDay) r.alldayDueDate = new Date(f.due.at); else r.dueDate = new Date(f.due.at) }
  r.priority = f.priority
  if (!!r.completed() !== f.completed) r.completed = f.completed
}`

interface RawReminder {
  id: string
  name: string
  body: string
  due: number | null
  allDay: boolean
  completed: boolean
  completedAt: number | null
  priority: number
  mod: number
}

function toRemote(r: RawReminder): RemoteTask {
  return {
    id: r.id,
    title: r.name,
    notes: r.body,
    due: r.due != null ? { at: r.due, allDay: r.allDay } : null,
    completed: r.completed,
    completedAt: r.completedAt,
    priority: priorityFromReminders(r.priority),
    // checklist 留 undefined：由 merge 从 body 尾部 ☐/☑ 行解析
    modifiedAt: r.mod,
    etag: String(r.mod)
  }
}

function toRaw(f: TaskFields) {
  return { title: f.title, body: encodeBody(f.notes, f.checklist), due: f.due, completed: f.completed, priority: priorityToReminders(f.priority) }
}

export class RemindersAdapter implements TasksAdapter {
  readonly kind = 'tasks' as const
  readonly provider = 'apple-reminders' as const

  listTargets(): Promise<SyncTarget[]> {
    return runJxa<SyncTarget[]>(
      '提醒事项',
      `const app = Application('Reminders')
       const ids = app.lists.id(), names = app.lists.name()
       return JSON.stringify(ids.map((id, i) => ({ id, name: names[i] })))`,
      null
    )
  }

  async listItems(listId: string): Promise<{ items: RemoteTask[]; complete: boolean }> {
    // 批量取属性：每个属性一次 Apple 事件，比逐条读快两个数量级
    const raw = await runJxa<RawReminder[]>(
      '提醒事项',
      `const app = Application('Reminders')
       let L
       try { L = app.lists.byId(A.listId); L.name() } catch (e) { throw new Error('NOT_FOUND list') }
       const rs = L.reminders
       const ids = rs.id()
       if (!ids.length) return '[]'
       const names = rs.name(), bodies = rs.body(), due = rs.dueDate(), ad = rs.alldayDueDate(), done = rs.completed(),
         doneAt = rs.completionDate(), mod = rs.modificationDate(), pri = rs.priority()
       const ms = d => { if (!d) return null; const t = d.getTime(); return t > 0 ? t : null }
       return JSON.stringify(ids.map((id, i) => {
         const d = ms(due[i]), a = ms(ad[i])
         return { id, name: names[i] || '', body: bodies[i] || '', due: d, allDay: d != null && a != null && d === a,
           completed: !!done[i], completedAt: ms(doneAt[i]), priority: pri[i] || 0, mod: ms(mod[i]) || 0 }
       }))`,
      { listId },
      60_000
    )
    return { items: raw.map(toRemote), complete: true }
  }

  async create(listId: string, f: TaskFields): Promise<RemoteTask> {
    const raw = await runJxa<RawReminder>(
      '提醒事项',
      `${READ_REMINDER}
       const app = Application('Reminders')
       const r = app.Reminder({ name: A.f.title })
       app.lists.byId(A.listId).reminders.push(r)
       applyR(r, A.f)
       return JSON.stringify(readR(app.reminders.byId(r.id())))`,
      { listId, f: toRaw(f) }
    )
    return toRemote(raw)
  }

  async update(listId: string, id: string, f: TaskFields, prev: RemoteTask | null): Promise<RemoteTask> {
    // 提醒事项无法通过脚本清空截止日期：需要清空时删除重建（id 会变，由执行器更新映射）
    if (!f.due && (prev?.due ?? true)) {
      const hadDue = prev ? !!prev.due : await this.hasDue(id)
      if (hadDue) {
        const created = await this.create(listId, f)
        await this.remove(listId, id)
        return created
      }
    }
    const raw = await runJxa<RawReminder>(
      '提醒事项',
      `${READ_REMINDER}
       const app = Application('Reminders')
       const r = app.reminders.byId(A.id)
       try { r.name() } catch (e) { throw new Error('NOT_FOUND') }
       applyR(r, A.f)
       return JSON.stringify(readR(r))`,
      { id, f: toRaw(f) }
    )
    return toRemote(raw)
  }

  private async hasDue(id: string): Promise<boolean> {
    const due = await runJxa<number | null>(
      '提醒事项',
      `const app = Application('Reminders')
       const r = app.reminders.byId(A.id)
       let d
       try { d = r.dueDate() } catch (e) { throw new Error('NOT_FOUND') }
       return JSON.stringify(d && d.getTime() > 0 ? d.getTime() : null)`,
      { id }
    )
    return due != null
  }

  async remove(_listId: string, id: string): Promise<void> {
    try {
      await runJxa<boolean>(
        '提醒事项',
        `const app = Application('Reminders')
         const r = app.reminders.byId(A.id)
         try { r.name() } catch (e) { throw new Error('NOT_FOUND') }
         app.delete(r)
         return 'true'`,
        { id }
      )
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err
    }
  }
}

// ================= 日历 =================
// 脚本里读不到 calendarIdentifier（新版 macOS 报 -1728），日历以名称作为 id

export class AppleCalendarAdapter implements CalendarAdapter {
  readonly kind = 'calendar' as const
  readonly provider = 'apple-calendar' as const

  async listTargets(): Promise<SyncTarget[]> {
    const rows = await runJxa<{ name: string; writable: boolean }[]>(
      '日历',
      `const app = Application('Calendar')
       const names = app.calendars.name(), w = app.calendars.writable()
       return JSON.stringify(names.map((name, i) => ({ name, writable: !!w[i] })))`,
      null
    )
    const seen = new Set<string>()
    return rows
      .filter(r => r.writable && !seen.has(r.name) && seen.add(r.name))
      .map(r => ({ id: r.name, name: r.name }))
  }

  createEvent(calendarId: string, f: CalendarEventFields): Promise<{ id: string; etag: string }> {
    return runJxa<{ id: string; etag: string }>(
      '日历',
      `const app = Application('Calendar')
       let cal
       try { cal = app.calendars.byName(A.cal); cal.name() } catch (e) { throw new Error('NOT_FOUND calendar') }
       const ev = app.Event({ summary: A.f.title, startDate: new Date(A.f.start), endDate: new Date(A.f.end), description: A.f.notes })
       cal.events.push(ev)
       if (A.f.url) { try { ev.url = A.f.url } catch (e) {} }
       const s = ev.stampDate()
       return JSON.stringify({ id: ev.uid(), etag: String(s ? s.getTime() : Date.now()) })`,
      { cal: calendarId, f }
    )
  }

  updateEvent(calendarId: string, id: string, f: CalendarEventFields): Promise<{ id: string; etag: string }> {
    return runJxa<{ id: string; etag: string }>(
      '日历',
      `const app = Application('Calendar')
       const found = app.calendars.byName(A.cal).events.whose({ uid: A.id })
       if (!found.length) throw new Error('NOT_FOUND')
       const ev = found[0]
       ev.summary = A.f.title
       // 每次赋值都会立即保存且要求开始早于结束：往后挪时先改结束时间
       const start = new Date(A.f.start), end = new Date(A.f.end)
       if (start.getTime() >= ev.endDate().getTime()) { ev.endDate = end; ev.startDate = start }
       else { ev.startDate = start; ev.endDate = end }
       ev.description = A.f.notes
       if (A.f.url) { try { ev.url = A.f.url } catch (e) {} }
       const s = ev.stampDate()
       return JSON.stringify({ id: ev.uid(), etag: String(s ? s.getTime() : Date.now()) })`,
      { cal: calendarId, id, f }
    )
  }

  async removeEvent(calendarId: string, id: string): Promise<void> {
    try {
      await runJxa<boolean>(
        '日历',
        `const app = Application('Calendar')
         const found = app.calendars.byName(A.cal).events.whose({ uid: A.id })
         if (!found.length) throw new Error('NOT_FOUND')
         app.delete(found[0])
         return 'true'`,
        { cal: calendarId, id }
      )
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err
    }
  }

  /** 各日历在区间内的非全天日程（只读）。注：脚本接口不展开重复日程，只能拿到首个实例 */
  busyBlocks(from: number, to: number, excludeCalendarId: string | null): Promise<BusyBlock[]> {
    return runJxa<BusyBlock[]>(
      '日历',
      `const app = Application('Calendar')
       const from = new Date(A.from), to = new Date(A.to), out = []
       for (const name of app.calendars.name()) {
         if (name === A.exclude) continue
         try {
           const evs = app.calendars.byName(name).events.whose({ _and: [{ startDate: { _lessThan: to } }, { endDate: { _greaterThan: from } }] })
           const s = evs.startDate()
           if (!s.length) continue
           const e = evs.endDate(), ad = evs.alldayEvent(), t = evs.summary()
           for (let i = 0; i < s.length; i++) if (!ad[i]) out.push({ start: s[i].getTime(), end: e[i].getTime(), title: t[i] || '' })
         } catch (e) {}
       }
       return JSON.stringify(out)`,
      { from, to, exclude: excludeCalendarId },
      90_000
    )
  }
}
