import { create } from 'zustand'
import { Alert, Platform } from 'react-native'
import { encryptedStore, randomBytes, serial } from '../storage/encrypted'
import { autoSchedule, dayEnd, estimateMinutes, plannedAt, type MailSource, type WorkItem } from './model'
import { linkToCore } from '../native/LinkToCore'

const disk = encryptedStore<WorkItem[]>('workbench', () => [])
let revision = 0
let notifyChange: (() => void) | null = null
export const onWorkbenchChange = (handler: () => void) => { notifyChange = handler }
const update = (fn: (items: WorkItem[]) => WorkItem[]) => serial('workbench', async () => {
  const generation = revision
  const items = fn(await disk.read())
  if (generation !== revision) return
  await disk.write(items)
  if (generation === revision) useWorkbench.setState({ items, error: '' })
  notifyChange?.()
})

async function reconcileReminder(item: WorkItem): Promise<void> {
  const at = plannedAt(item)
  if (Platform.OS === 'ios' && item.kind === 'todo' && item.status === 'open' && item.data.reminder && at && at > Date.now()) {
    await linkToCore.scheduleReminder(item.id, item.title, at)
  } else await linkToCore.cancelReminder(item.id)
}

interface WorkState {
  items: WorkItem[]
  loaded: boolean
  error: string
  capture: { itemId?: string; source?: MailSource; content?: string } | null
  load(): Promise<void>
  clear(): void
  openCapture(input?: WorkState['capture']): void
  closeCapture(): void
  save(input: { id?: string; title: string; content: string; at: number | null; fixed?: boolean; minutes?: number; priority?: 1 | 2 | 3; reminder?: boolean; source?: MailSource }): Promise<void>
  complete(id: string): Promise<void>
  remove(id: string): Promise<void>
  pin(id: string): Promise<void>
  schedule(now?: number): Promise<number>
  applyRemote(items: WorkItem[]): Promise<void>
}

export const useWorkbench = create<WorkState>((set, get) => ({
  items: [], loaded: false, error: '', capture: null,
  load: async () => {
    const generation = revision
    try { const items = await serial('workbench', () => disk.read()); if (generation === revision) set({ items, loaded: true, error: '' }) }
    catch (err) { if (generation === revision) set({ error: String(err), loaded: true }) }
  },
  clear: () => { revision++; set({ items: [], loaded: false, capture: null }) },
  openCapture: (input = {}) => set({ capture: input }),
  closeCapture: () => set({ capture: null }),
  save: async input => {
    if (!input.title.trim() && !input.content.trim()) throw new Error('先写下一点内容')
    const id = input.id ?? 'mob-work-' + Array.from(await randomBytes(12), b => b.toString(16).padStart(2, '0')).join('')
    const now = Date.now()
    await update(items => {
      const previous = items.find(i => i.id === id)
      const item: WorkItem = {
        id, kind: input.at ? 'todo' : 'memo', title: (input.title.trim() || input.content.trim().split('\n')[0]).slice(0, 240),
        status: previous?.status === 'dismissed' ? 'open' : previous?.status ?? 'open', dueAt: input.at,
        createdAt: previous?.createdAt ?? now,
        data: { ...previous?.data, content: input.content, notes: input.content, updatedAt: Math.max(now, (previous?.data.updatedAt ?? 0) + 1),
          minutes: input.minutes ?? estimateMinutes(input.title + input.content), priority: input.priority ?? 2,
          fixedAt: input.fixed ? input.at : null, scheduledAt: input.at, unscheduled: false, reminder: input.reminder ?? false, source: input.source ?? previous?.data.source }
      }
      return [...items.filter(i => i.id !== id), item]
    })
    // Scheduling is explicitly requested by the reminder switch in capture.
    const item = get().items.find(i => i.id === id)!
    if (Platform.OS === 'ios' && input.reminder && input.at && input.at > now) {
      try { await linkToCore.scheduleReminder(id, item.title, input.at) }
      catch (err) { Alert.alert('内容已保存，提醒未开启', err instanceof Error ? err.message : String(err)) }
    } else await linkToCore.cancelReminder(id)
    set({ capture: null })
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
      const result = autoSchedule(items, now, Math.min(dayEnd(now), new Date(new Date(now).setHours(20, 0, 0, 0)).getTime()))
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
