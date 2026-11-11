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

test('inline edit preserves scheduling and rejects a stale editor without losing the saved content', async () => {
  const at = Date.now() + 3600000
  await useWorkbench.getState().save({ id: 'inline', title: '原标题', content: '', at, fixed: true, minutes: 30 })
  const version = useWorkbench.getState().items.find(i => i.id === 'inline')!.data.updatedAt
  await useWorkbench.getState().edit('inline', '新标题', '新正文', version)
  const item = useWorkbench.getState().items.find(i => i.id === 'inline')!
  expect(item).toMatchObject({ title: '新标题', kind: 'todo', dueAt: at, data: { fixedAt: at, minutes: 30, content: '新正文' } })
  await expect(useWorkbench.getState().edit('inline', '过时输入', '', version)).rejects.toThrow('另一处更新')
  expect(useWorkbench.getState().items.find(i => i.id === 'inline')!.title).toBe('新标题')
})

test('batch deletion has a single undo and an old workflow undo cannot undo a later edit', async () => {
  for (const id of ['batch-a', 'batch-b']) await useWorkbench.getState().save({ id, title: id, content: '', at: null })
  await useWorkbench.getState().batch(['batch-a', 'batch-b'], 'remove')
  expect(useWorkbench.getState().items.filter(i => i.id.startsWith('batch-')).every(i => i.status === 'dismissed')).toBe(true)
  await useWorkbench.getState().snapshotUndo()()
  expect(useWorkbench.getState().items.filter(i => i.id.startsWith('batch-')).every(i => i.status === 'open')).toBe(true)
  await useWorkbench.getState().batch(['batch-a', 'batch-b'], 'tomorrow')
  const oldUndo = useWorkbench.getState().snapshotUndo()
  await useWorkbench.getState().pin('batch-a')
  await expect(oldUndo()).rejects.toThrow('其他改动')
  expect(useWorkbench.getState().items.find(i => i.id === 'batch-a')!.data.pinned).toBe(true)
})

test('Agent imports and schedules atomically, skips stable IDs including dismissed tasks and undoes the entire plan', async () => {
  const source = { accountEmail: 'qa@example.com', mailbox: 'INBOX', uid: 70, messageId: '<stable@qa>', subject: '项目', from: 'client@qa', date: Date.now() }
  const tasks = [{ id: 'agent-a', title: '回复项目', content: '依据', source, minutes: 15, at: null }]
  const result = await useWorkbench.getState().importTasks(tasks)
  expect(result.added).toBe(1)
  const undo = useWorkbench.getState().snapshotUndo()
  expect(await useWorkbench.getState().importTasks(tasks)).toMatchObject({ added: 0, skipped: 1 })
  await undo()
  expect(useWorkbench.getState().items.find(i => i.id === 'agent-a')!.status).toBe('dismissed')
  expect(await useWorkbench.getState().importTasks(tasks)).toMatchObject({ added: 0, skipped: 1 })
})

test('folder rename and mail movement keep linked tasks pointed at their actual server location', async () => {
  const source = { accountEmail: 'Me@Example.com', mailbox: 'Projects/Client', uid: 70, messageId: '<linked@qa>', subject: '项目', from: 'client@qa', date: 100 }
  await useWorkbench.getState().save({ id: 'linked-move', title: '来自邮件', content: '', at: Date.now(), source })
  await useWorkbench.getState().remapMailbox('me@example.com', 'Projects', 'Work', '/')
  expect(useWorkbench.getState().items.find(i => i.id === 'linked-move')!.data.source!.mailbox).toBe('Work/Client')
  await useWorkbench.getState().remapMessage({ ...source, mailbox: 'Work/Client' }, 'Archive', 901)
  expect(useWorkbench.getState().items.find(i => i.id === 'linked-move')!.data.source).toMatchObject({ mailbox: 'Archive', uid: 901 })
})

test('task and memo folders preserve content and scheduling, rename together and undo without deleting items', async () => {
  await useWorkbench.getState().save({ id: 'folder-todo', title: '任务', content: '正文', at: Date.now() + 3600000, fixed: true })
  await useWorkbench.getState().save({ id: 'folder-note', title: '便签', content: '想法', at: null })
  const at = useWorkbench.getState().items.find(i => i.id === 'folder-todo')!.dueAt
  await useWorkbench.getState().moveCollection(['folder-todo', 'folder-note'], '客户项目')
  await useWorkbench.getState().renameCollection('客户项目', '项目跟进')
  expect(useWorkbench.getState().items.filter(i => i.id.startsWith('folder-')).every(i => i.data.collection === '项目跟进')).toBe(true)
  await useWorkbench.getState().renameCollection('项目跟进', '')
  expect(useWorkbench.getState().items.find(i => i.id === 'folder-todo')).toMatchObject({ status: 'open', dueAt: at, data: { content: '正文', collection: '' } })
  await useWorkbench.getState().undo()
  expect(useWorkbench.getState().items.find(i => i.id === 'folder-note')).toMatchObject({ kind: 'memo', status: 'open', data: { collection: '项目跟进' } })
})

test('new capture inherits the visible folder and editing an existing item preserves its own folder', async () => {
  useWorkbench.setState({ activeCollection: '当前项目' })
  useWorkbench.getState().openCapture()
  const collection = useWorkbench.getState().capture!.collection
  expect(collection).toBe('当前项目')
  await useWorkbench.getState().save({ id: 'inherited-folder', title: '项目便签', content: '', at: null, collection })
  expect(useWorkbench.getState().items.find(i => i.id === 'inherited-folder')!.data.collection).toBe('当前项目')
  await useWorkbench.getState().save({ id: 'inherited-folder', title: '仍在原文件夹', content: '', at: null, collection: '另一个文件夹' })
  expect(useWorkbench.getState().items.find(i => i.id === 'inherited-folder')!.data.collection).toBe('当前项目')
  useWorkbench.setState({ activeCollection: null })
})
