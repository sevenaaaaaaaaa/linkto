jest.mock('react-native-keychain', () => {
  const data = new Map<string, string>()
  return { getGenericPassword: jest.fn(async ({ service }) => data.has(service) ? { password: data.get(service) } : false), setGenericPassword: jest.fn(async (_u, value, { service }) => { data.set(service, value); return true }), resetGenericPassword: jest.fn(async ({ service }) => { data.delete(service); return true }) }
})
jest.mock('@react-native-async-storage/async-storage', () => {
  const data = new Map<string, string>()
  return { getItem: jest.fn(async (key) => data.get(key) ?? null), setItem: jest.fn(async (key, value) => { data.set(key, value) }), removeItem: jest.fn(async key => { data.delete(key) }) }
})
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useWorkbench } from '../src/workbench/store'
import { plannedAt } from '../src/workbench/model'

test('concurrent captures persist encrypted notes without dropping changes; dated note becomes a task', async () => {
  await Promise.all(Array.from({ length: 8 }, (_, index) => useWorkbench.getState().save({ title: `private ${index}`, content: 'sensitive content', at: null })))
  expect(useWorkbench.getState().items).toHaveLength(8)
  const raw = await AsyncStorage.getItem('linkto.workbench.v1')
  expect(raw).not.toContain('private')
  expect(raw).not.toContain('sensitive')
  const first = useWorkbench.getState().items[0]
  await useWorkbench.getState().save({ id: first.id, title: first.title, content: first.data.content!, at: Date.now() + 60000, minutes: 30 })
  expect(useWorkbench.getState().items.find(i => i.id === first.id)?.kind).toBe('todo')
  useWorkbench.getState().clear()
  await useWorkbench.getState().load()
  expect(useWorkbench.getState().items).toHaveLength(8)
  await useWorkbench.getState().remove(first.id)
  expect(useWorkbench.getState().items.find(i => i.id === first.id)?.status).toBe('dismissed')
})

test('rescheduling clears an old appointment time when a task no longer fits today', async () => {
  const now = new Date(); now.setHours(19, 59, 0, 0)
  await useWorkbench.getState().save({ id: 'overflow-task', title: '今天排不下的任务', content: '', at: now.getTime() - 3600000, minutes: 60 })
  expect(await useWorkbench.getState().schedule(now.getTime())).toBeGreaterThan(0)
  const task = useWorkbench.getState().items.find(i => i.id === 'overflow-task')!
  expect(task.data.scheduledAt).toBeNull()
  expect(plannedAt(task)).toBeNull()
})

test('undo advances versions and refuses to overwrite a newer remote edit', async () => {
  await useWorkbench.getState().save({ id: 'undo-me', title: '撤销测试', content: '', at: null })
  await useWorkbench.getState().pin('undo-me')
  await useWorkbench.getState().undo()
  let note = useWorkbench.getState().items.find(i => i.id === 'undo-me')!
  expect(note.data.pinned).toBeFalsy()
  await useWorkbench.getState().pin('undo-me')
  note = useWorkbench.getState().items.find(i => i.id === 'undo-me')!
  await useWorkbench.getState().applyRemote([{ ...note, title: '另一台设备的新内容', data: { ...note.data, updatedAt: note.data.updatedAt + 1 } }])
  await expect(useWorkbench.getState().undo()).rejects.toThrow('另一台设备')
  expect(useWorkbench.getState().items.find(i => i.id === 'undo-me')?.title).toBe('另一台设备的新内容')
})
test('snoozing the same message updates one shared task and removal restores inbox eligibility', async () => {
  const source = { accountEmail: 'me@example.com', mailbox: 'INBOX', uid: 70, messageId: '<stable@example.com>', subject: '客户回复', from: 'customer@example.com', date: Date.now() }
  const id = await useWorkbench.getState().snooze(source, Date.now() + 3600000)
  await useWorkbench.getState().snooze({ ...source, uid: 90 }, Date.now() + 7200000)
  expect(useWorkbench.getState().items.filter(i => i.id === id)).toHaveLength(1)
  expect(useWorkbench.getState().items.find(i => i.id === id)?.data.source?.uid).toBe(90)
  await useWorkbench.getState().remove(id)
  expect(useWorkbench.getState().items.find(i => i.id === id)?.status).toBe('dismissed')
})
