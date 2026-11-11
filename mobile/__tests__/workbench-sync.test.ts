const mockClient = { ensureSyncFolder: jest.fn(async () => 'LinkTo-Sync'), syncHeaders: jest.fn(), fetchRaw: jest.fn(), appendSync: jest.fn(async () => {}), selectMailbox: jest.fn(async () => {}) }
jest.mock('../src/store/mail', () => ({ useMail: { getState: () => ({ guard: 'ready', accounts: [{ id: 'phone-account', email: 'me@example.com' }] }) }, withClient: (_: unknown, fn: (client: unknown) => unknown) => fn(mockClient) }))
jest.mock('react-native-keychain', () => {
  const data = new Map<string, string>()
  return { getGenericPassword: jest.fn(async ({ service }) => data.has(service) ? { password: data.get(service) } : false), setGenericPassword: jest.fn(async (_u, value, { service }) => { data.set(service, value); return true }) }
})
jest.mock('@react-native-async-storage/async-storage', () => {
  const data = new Map<string, string>()
  return { getItem: jest.fn(async (key) => data.get(key) ?? null), setItem: jest.fn(async (key, value) => { data.set(key, value) }) }
})
import { configureWorkSync, pauseWorkSync, useWorkSync } from '../src/workbench/sync'
import { useWorkbench } from '../src/workbench/store'
import { SyncCodec, parseHeaders } from '../src/workbench/sync-codec'
import { randomBytes } from '../src/storage/encrypted'

test('mailbox sync aborts before upload with a wrong key, then pulls and pushes encrypted changes with the correct key', async () => {
  const codec = new SyncCodec('correct-shared-passphrase', randomBytes)
  const remote = { id: 'desktop-note', kind: 'memo' as const, title: '电脑上的随手记', status: 'open' as const, dueAt: null, createdAt: 100, data: { updatedAt: 200, content: '跨设备内容' } }
  const raw = await codec.encode(remote)
  mockClient.syncHeaders.mockResolvedValue([{ uid: 70, headers: parseHeaders(raw.split('\r\n\r\n')[0]) }])
  mockClient.fetchRaw.mockResolvedValue(raw)
  await useWorkbench.getState().save({ title: '手机本机记录', content: '尚未上传', at: null })
  await configureWorkSync({ enabled: true, accountEmail: 'me@example.com', passphrase: 'wrong-passphrase' })
  expect(useWorkSync.getState().error).toContain('同步口令不正确')
  expect(mockClient.appendSync).not.toHaveBeenCalled()
  expect(useWorkbench.getState().items.some(i => i.id === remote.id)).toBe(false)
  await configureWorkSync({ enabled: true, accountEmail: 'me@example.com', passphrase: 'correct-shared-passphrase' })
  expect(useWorkSync.getState().error).toBe('')
  expect(useWorkbench.getState().items.find(i => i.id === remote.id)?.data.content).toBe('跨设备内容')
  expect(mockClient.appendSync).toHaveBeenCalledTimes(1)
  const uploaded = (mockClient.appendSync.mock.calls as unknown as [string, string][])[0][1]
  expect(uploaded).not.toContain('尚未上传')
  expect((await codec.decode(uploaded)).title).toBe('手机本机记录')
  pauseWorkSync()
  await codec.clear()
}, 20000)
