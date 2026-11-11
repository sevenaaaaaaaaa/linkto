import { create } from 'zustand'
import { Alert, Platform } from 'react-native'
import { encryptedStore, randomBytes, serial } from '../storage/encrypted'
import { autoSchedule, dayEnd, estimateMinutes, plannedAt, type MailSource, type WorkItem } from './model'
import { defaultPlanning, validatePlanning, type Planning } from './planning'
import { linkToCore } from '../native/LinkToCore'
import { clearInlineDrafts } from './drafts'

const disk = encryptedStore<WorkItem[]>('workbench', () => [])
const preferences = encryptedStore<Planning>('planning', () => defaultPlanning)
let undoEntry: { before: WorkItem[]; versions: Map<string, number> } | null = null
let revision = 0
let notifyChange: (() => void) | null = null
export const onWorkbenchChange = (handler: () => void) => { notifyChange = handler }
const update = (fn: (items: WorkItem[]) => WorkItem[], recordUndo = true) => {
  const generation = revision
  return serial('workbench', async () => {
  if (generation !== revision) return
  const previous = await disk.read()
  const items = fn(previous)
  if (items === previous) return
  if (generation !== revision) return
  await disk.write(items)
  if (generation === revision) {
    if (recordUndo) undoEntry = { before: previous, versions: new Map(items.filter(i => !previous.some(p => p.id === i.id && p.data.updatedAt === i.data.updatedAt)).map(i => [i.id, i.data.updatedAt])) }
    useWorkbench.setState({ items, error: '' })
  }
  notifyChange?.()
})
}

async function reconcileReminder(item: WorkItem): Promise<void> {
  const at = plannedAt(item)
  if ((Platform.OS === 'ios' || Platform.OS === 'android') && item.kind === 'todo' && item.status === 'open' && item.data.reminder && at && at > Date.now()) {
    await linkToCore.scheduleReminder(item.id, item.title, at)
  } else await linkToCore.cancelReminder(item.id)
}

interface WorkState {
  items: WorkItem[]
  planning: Planning
  savePlanning(value: Planning): Promise<void>
  reorder(ids: string[]): Promise<void>
  undo(): Promise<void>
  snapshotUndo(): () => Promise<void>
  edit(id: string, title: string, content: string, expectedVersion: number): Promise<void>
  batch(ids: string[], action: 'remove' | 'complete' | 'reopen' | 'tomorrow' | 'pin'): Promise<void>
  remapMailbox(email: string, oldName: string, newName: string, delimiter: string): Promise<void>
  remapMessage(source: MailSource, target: string, uid: number | null): Promise<void>
  moveCollection(ids: string[], name: string): Promise<void>
  renameCollection(from: string, to: string): Promise<void>
  importTasks(tasks: Array<{ id: string; title: string; content: string; source: MailSource; minutes: number; at: number | null }>): Promise<{ added: number; skipped: number; overflow: number }>
  loaded: boolean
  error: string
  activeCollection: string | null
  capture: { itemId?: string; source?: MailSource; content?: string; collection?: string | null } | null
  load(): Promise<void>
  clear(): void
  openCapture(input?: WorkState['capture']): void
  closeCapture(): void
  save(input: { id?: string; title: string; content: string; at: number | null; fixed?: boolean; minutes?: number; priority?: 1 | 2 | 3; reminder?: boolean; source?: MailSource; expectedVersion?: number; collection?: string | null }): Promise<void>
  snooze(source: MailSource, until: number): Promise<string>
  complete(id: string): Promise<void>
  remove(id: string): Promise<void>
  pin(id: string): Promise<void>
  schedule(now?: number): Promise<number>
  applyRemote(items: WorkItem[]): Promise<void>
}

export const useWorkbench = create<WorkState>((set, get) => ({
  items: [], planning: defaultPlanning, loaded: false, error: '', capture: null, activeCollection: null,
  load: async () => {
    const generation = revision
    try {
      await Promise.all([
        serial('workbench', async () => { const items = await disk.read(); if (generation === revision) set({ items, loaded: true, error: '' }) }),
        serial('planning', async () => { const planning = validatePlanning(await preferences.read()); if (generation === revision) set({ planning }) })
      ])
    }
    catch (err) { if (generation === revision) set({ error: String(err), loaded: true }) }
  },
  clear: () => { revision++; undoEntry = null; clearInlineDrafts(); set({ items: [], loaded: false, capture: null, activeCollection: null }) },
  savePlanning: async value => {
    validatePlanning(value)
    await serial('planning', () => preferences.write(value)); set({ planning: value })
  },
  moveCollection: (ids, name) => {
    if (name.trim().length > 64) return Promise.reject(new Error('文件夹名称最多 64 字'))
    const selected = new Set(ids)
    return update(items => items.map(item => !selected.has(item.id) || item.status === 'dismissed' ? item : { ...item, data: { ...item.data, collection: name.trim(), updatedAt: Math.max(Date.now(), item.data.updatedAt + 1) } }))
  },
  renameCollection: (from, to) => {
    if (to.trim().length > 64) return Promise.reject(new Error('文件夹名称最多 64 字'))
    return update(items => items.map(item => item.data.collection !== from || item.status === 'dismissed' ? item : { ...item, data: { ...item.data, collection: to.trim(), updatedAt: Math.max(Date.now(), item.data.updatedAt + 1) } }))
  },
  remapMailbox: (email, oldName, newName, delimiter) => update(items => items.map(item => {
    const source = item.data.source
    if (!source || source.accountEmail.toLowerCase() !== email.toLowerCase() || !(source.mailbox === oldName || (delimiter && source.mailbox.startsWith(oldName + delimiter)))) return item
    return { ...item, data: { ...item.data, source: { ...source, mailbox: newName + source.mailbox.slice(oldName.length) }, updatedAt: Math.max(Date.now(), item.data.updatedAt + 1) } }
  }), false),
  remapMessage: (m, target, uid) => update(items => items.map(item => {
    const source = item.data.source
    if (!source || source.accountEmail.toLowerCase() !== m.accountEmail.toLowerCase() || !(m.messageId ? source.messageId === m.messageId : source.mailbox === m.mailbox && source.uid === m.uid)) return item
    return { ...item, data: { ...item.data, source: { ...source, mailbox: target, uid: uid ?? 0 }, updatedAt: Math.max(Date.now(), item.data.updatedAt + 1) } }
  }), false),
  edit: async (id, title, content, expectedVersion) => {
    if (!title.trim() && !content.trim()) throw new Error('先写下一点内容')
    await update(items => items.map(item => {
      if (item.id !== id) return item
      if (item.data.updatedAt !== expectedVersion || item.status === 'dismissed') throw new Error('记录已在另一处更新；草稿已保留，请复制内容后重新打开')
      return { ...item, title: (title.trim() || content.trim().split('\n')[0]).slice(0, 240), data: { ...item.data, content, notes: content, updatedAt: Math.max(Date.now(), item.data.updatedAt + 1) } }
    }))
    const item = get().items.find(i => i.id === id)
    if (item) await reconcileReminder(item).catch(() => set({ error: '内容已保存，提醒更新失败，请检查通知权限。' }))
  },
  batch: async (ids, action) => {
    const selected = new Set(ids)
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0)
    await update(items => items.map(item => !selected.has(item.id) || item.status === 'dismissed' ? item : {
      ...item, ...(action === 'tomorrow' ? { kind: 'todo' as const, dueAt: tomorrow.getTime() } : {}),
      status: action === 'remove' ? 'dismissed' : action === 'complete' ? 'done' : action === 'reopen' || action === 'tomorrow' ? 'open' : item.status,
      data: { ...item.data, ...(action === 'pin' ? { pinned: true } : {}), ...(action === 'tomorrow' ? { fixedAt: null, scheduledAt: tomorrow.getTime(), unscheduled: false, ...(item.data.mailSnoozeUntil ? { mailSnoozeUntil: tomorrow.getTime() } : {}) } : {}), updatedAt: Math.max(Date.now(), item.data.updatedAt + 1) }
    }))
    const results = await Promise.allSettled(get().items.filter(i => selected.has(i.id)).map(reconcileReminder))
    if (results.some(r => r.status === 'rejected')) set({ error: '记录已更新，但部分提醒未更新，请检查通知权限。' })
  },
  importTasks: async tasks => {
    let added = 0, skipped = 0, overflow = 0
    await update(items => {
      const known = new Set(items.map(i => i.id)), now = Date.now()
      const next = [...items]
      for (const task of tasks) {
        if (known.has(task.id)) { skipped++; continue }
        known.add(task.id); added++
        next.push({ id: task.id, kind: 'todo', title: task.title, status: 'open', dueAt: task.at, createdAt: now, data: { updatedAt: now, content: task.content, notes: task.content, source: task.source, minutes: task.minutes, fixedAt: task.at, reminder: false } })
      }
      if (!added) return items
      const date = new Date(now); date.setHours(0, 0, 0, 0)
      const plan = autoSchedule(next, now, date.getTime() + get().planning.end * 60000, get().planning)
      overflow = plan.overflow.length
      return next.map(item => plan.scheduled.has(item.id) || plan.overflow.includes(item.id) ? { ...item, data: { ...item.data, scheduledAt: plan.scheduled.get(item.id) ?? null, unscheduled: !plan.scheduled.has(item.id), updatedAt: Math.max(now, item.data.updatedAt + 1) } } : item)
    })
    await Promise.allSettled(get().items.map(reconcileReminder))
    return { added, skipped, overflow }
  },
  reorder: async ids => {
    const order = new Map(ids.map((id, index) => [id, index]))
    await update(items => {
      const ordered = items.map(i => order.has(i.id) ? { ...i, data: { ...i.data, order: order.get(i.id) } } : i)
      const now = Date.now(), date = new Date(now); date.setHours(0, 0, 0, 0)
      const result = autoSchedule(ordered, now, date.getTime() + get().planning.end * 60000, get().planning)
      return ordered.map(item => {
        const scheduled = result.scheduled.get(item.id), overflow = result.overflow.includes(item.id)
        return order.has(item.id) || scheduled !== undefined || overflow ? { ...item, data: { ...item.data, ...(scheduled !== undefined || overflow ? { scheduledAt: scheduled ?? null, unscheduled: overflow } : {}), updatedAt: Math.max(Date.now(), item.data.updatedAt + 1) } } : item
      })
    })
    await Promise.allSettled(get().items.map(reconcileReminder))
  },
  undo: async () => {
    const entry = undoEntry
    if (!entry?.versions.size) throw new Error('没有可撤销的改动')
    await update(items => {
      for (const [id, version] of entry.versions) if (items.find(i => i.id === id)?.data.updatedAt !== version) throw new Error('记录已被另一台设备更新，保留最新内容；无法撤销这次改动')
      return items.map(item => {
        if (!entry.versions.has(item.id)) return item
        const previous = entry.before.find(i => i.id === item.id)
        return { ...(previous ?? { ...item, status: 'dismissed' as const }), data: { ...(previous?.data ?? item.data), updatedAt: Math.max(Date.now(), item.data.updatedAt + 1) } }
      })
    }, false)
    undoEntry = null
    await Promise.allSettled(get().items.filter(i => entry.versions.has(i.id)).map(reconcileReminder))
  },
  snapshotUndo: () => {
    const entry = undoEntry
    return async () => { if (!entry || undoEntry !== entry) throw new Error('此后已有其他改动，无法再撤销这次工作流'); await get().undo() }
  },
  openCapture: (input = {}) => set({ capture: { collection: get().activeCollection, ...input } }),
  closeCapture: () => set({ capture: null }),
  save: async input => {
    if (!input.title.trim() && !input.content.trim()) throw new Error('先写下一点内容')
    const id = input.id ?? 'mob-work-' + Array.from(await randomBytes(12), b => b.toString(16).padStart(2, '0')).join('')
    const now = Date.now()
    await update(items => {
      const previous = items.find(i => i.id === id)
      if (input.expectedVersion !== undefined && previous?.data.updatedAt !== input.expectedVersion) throw new Error('记录已在另一处更新；草稿已保留，请复制内容后重新打开')
      const item: WorkItem = {
        id, kind: input.at ? 'todo' : 'memo', title: (input.title.trim() || input.content.trim().split('\n')[0]).slice(0, 240),
        status: previous?.status === 'dismissed' ? 'open' : previous?.status ?? 'open', dueAt: input.at,
        createdAt: previous?.createdAt ?? now,
        data: { ...previous?.data, collection: previous?.data.collection ?? input.collection ?? '', content: input.content, notes: input.content, updatedAt: Math.max(now, (previous?.data.updatedAt ?? 0) + 1),
          minutes: input.minutes ?? estimateMinutes(input.title + input.content), priority: input.priority ?? 2,
          fixedAt: input.fixed ? input.at : null, scheduledAt: input.at, unscheduled: false, reminder: input.reminder ?? false, source: input.source ?? previous?.data.source,
          ...(previous?.data.mailSnoozeUntil ? { mailSnoozeUntil: input.at } : {}) }
      }
      return [...items.filter(i => i.id !== id), item]
    })
    // Scheduling is explicitly requested by the reminder switch in capture.
    const item = get().items.find(i => i.id === id)!
    if ((Platform.OS === 'ios' || Platform.OS === 'android') && input.reminder && input.at && input.at > now) {
      try { await linkToCore.scheduleReminder(id, item.title, input.at) }
      catch (err) { Alert.alert('内容已保存，提醒未开启', err instanceof Error ? err.message : String(err)) }
    } else await linkToCore.cancelReminder(id)
    set({ capture: null })
  },
  snooze: async (source, until) => {
    if (!Number.isFinite(until) || until <= Date.now()) throw new Error('请选择未来的处理时间')
    const id = 'mail-snooze-' + encodeURIComponent(source.accountEmail.toLowerCase() + ':' + (source.messageId || source.mailbox + ':' + source.uid))
    await update(items => {
      const previous = items.find(i => i.id === id)
      return [...items.filter(i => i.id !== id), { id, kind: 'todo', status: 'open', title: '处理邮件：' + source.subject, dueAt: until, createdAt: previous?.createdAt ?? Date.now(), data: { ...previous?.data, updatedAt: Math.max(Date.now(), (previous?.data.updatedAt ?? 0) + 1), source, mailSnoozeUntil: until, fixedAt: until, scheduledAt: until, minutes: 5, reminder: true } }]
    })
    const item = get().items.find(i => i.id === id)
    if (item) try { await reconcileReminder(item) } catch { set({ error: '稍后处理已保存，但本机提醒未开启；请检查系统通知权限。' }) }
    return id
  },
  complete: async id => {
    await update(items => items.map(i => i.id === id ? { ...i, status: i.status === 'done' ? 'open' : 'done', data: { ...i.data, updatedAt: Math.max(Date.now(), i.data.updatedAt + 1) } } : i))
    const item = get().items.find(i => i.id === id)
    if (item) {
      try { await reconcileReminder(item) }
      catch { set({ error: '待办已更新，但本机提醒未开启；请检查系统通知权限。' }) }
    }
  },
  remove: async id => {
    await update(items => items.map(i => i.id === id ? { ...i, status: 'dismissed', data: { ...i.data, updatedAt: Math.max(Date.now(), i.data.updatedAt + 1) } } : i))
    await linkToCore.cancelReminder(id)
  },
  pin: id => update(items => items.map(i => i.id === id ? { ...i, data: { ...i.data, pinned: !i.data.pinned, updatedAt: Math.max(Date.now(), i.data.updatedAt + 1) } } : i)),
  schedule: async (now = Date.now()) => {
    let remaining = 0
    const changed = new Set<string>()
    await update(items => {
      const planning = get().planning
      const date = new Date(now); date.setHours(0, 0, 0, 0)
      const result = autoSchedule(items, now, Math.min(dayEnd(now), date.getTime() + planning.end * 60000), planning)
      remaining = result.overflow.length
      for (const id of [...result.scheduled.keys(), ...result.overflow]) changed.add(id)
      return items.map(i => changed.has(i.id) ? { ...i, data: { ...i.data, scheduledAt: result.scheduled.get(i.id) ?? null, unscheduled: !result.scheduled.has(i.id), updatedAt: Math.max(Date.now(), i.data.updatedAt + 1) } } : i)
    })
    const reminders = await Promise.allSettled(get().items.filter(i => changed.has(i.id)).map(reconcileReminder))
    if (reminders.some(r => r.status === 'rejected')) set({ error: '排程已保存，但部分本机提醒未开启；请检查系统通知权限。' })
    return remaining
  },
  applyRemote: items => serial('workbench', async () => {
    const generation = revision
    const local = await disk.read()
    const byId = new Map(local.map(i => [i.id, i]))
    for (const item of items) if (!byId.has(item.id) || item.data.updatedAt > byId.get(item.id)!.data.updatedAt) byId.set(item.id, item)
    const merged = [...byId.values()]
    if (generation !== revision) return
    await disk.write(merged)
    if (generation !== revision) return
    set({ items: merged })
    const changed = merged.filter(item => !local.some(previous => previous.id === item.id && previous.data.updatedAt === item.data.updatedAt))
    const reminders = await Promise.allSettled(changed.map(reconcileReminder))
    if (generation === revision && reminders.some(r => r.status === 'rejected')) set({ error: '同步已完成，但部分本机提醒未开启；请检查系统通知权限。' })
  })
}))
