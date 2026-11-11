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
