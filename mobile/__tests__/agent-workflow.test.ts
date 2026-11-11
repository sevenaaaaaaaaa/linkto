jest.mock('react-native-keychain', () => {
  const data = new Map<string, string>()
  return { getGenericPassword: jest.fn(async ({ service }) => data.has(service) ? { password: data.get(service) } : false), setGenericPassword: jest.fn(async (_u, value, { service }) => { data.set(service, value); return true }), resetGenericPassword: jest.fn(async ({ service }) => { data.delete(service); return true }) }
})
jest.mock('@react-native-async-storage/async-storage', () => {
  const data = new Map<string, string>()
  return { getItem: jest.fn(async (key) => data.get(key) ?? null), setItem: jest.fn(async (key, value) => { data.set(key, value) }), removeItem: jest.fn(async key => { data.delete(key) }) }
})
jest.mock('react-native-tcp-socket', () => ({ __esModule: true, default: {} }))
jest.mock('../src/ai/client', () => ({ aiWorkbench: jest.fn(), getAIConfig: jest.fn(async () => ({ hasKey: true, baseUrl: 'https://example.com/v1', model: 'test' })) }))
import { aiWorkbench, getAIConfig } from '../src/ai/client'
import { useAgent } from '../src/agent/store'
import { useMail } from '../src/store/mail'
import { useWorkbench } from '../src/workbench/store'
const analyze = jest.mocked(aiWorkbench)
const message = { uid: 70, accountId: 'qa', accountEmail: 'qa@example.com', accountColor: '#006265', mailbox: 'INBOX', flags: [], date: 100, subject: '客户需求', from: 'client@example.com', to: 'qa@example.com', messageId: '<agent@qa>' }
const body = jest.fn(async () => ({ text: '请回复报价', html: null, attachments: [] }))
const response = (title: string) => JSON.stringify({ entries: [{ index: 0, summary: '客户希望回复报价', tasks: [{ title, detail: '依据邮件', minutes: 15 }] }] })
beforeEach(() => { useAgent.getState().clear(); jest.clearAllMocks(); useMail.setState({ guard: 'ready', messages: [message], fetchBody: body }) })
test('a workflow reads without marking seen, saves linked tasks and schedules with one bound undo', async () => {
  analyze.mockResolvedValue(response('确认客户报价'))
  await useAgent.getState().run('plan')
  expect(body).toHaveBeenCalledWith(message)
  const item = useWorkbench.getState().items.find(i => i.title === '确认客户报价')!
  expect(item).toMatchObject({ kind: 'todo', data: { source: { messageId: '<agent@qa>' }, reminder: false } })
  const undo = useAgent.getState().receipt!.undo!
  await useAgent.getState().run('plan')
  expect(useAgent.getState().receipt!.title).toBe('新增 0 件待办')
  expect(useWorkbench.getState().items.filter(i => i.title === '确认客户报价')).toHaveLength(1)
  await undo()
  expect(useWorkbench.getState().items.find(i => i.id === item.id)!.status).toBe('dismissed')
})
test('cancellation after model analysis starts prevents any new task writes', async () => {
  let resolve!: (value: string) => void
  analyze.mockImplementation(() => new Promise<string>(r => { resolve = r }))
  const running = useAgent.getState().run('plan')
  for (let i = 0; i < 20 && !resolve; i++) await Promise.resolve()
  expect(resolve).toBeDefined()
  useAgent.getState().cancel(); resolve(response('取消后不应保存'))
  await running
  expect(useWorkbench.getState().items.some(i => i.title === '取消后不应保存')).toBe(false)
  expect(useAgent.getState().receipt!.title).toBe('工作流已停止')
})
test('partial server failure preserves successful archive count and undo', async () => {
  const undo = jest.fn(async () => {})
  const move = jest.fn().mockResolvedValueOnce({ undo }).mockRejectedValueOnce(new Error('服务器断线'))
  useMail.setState({ messages: [{ ...message, flags: ['\\Seen'] }, { ...message, uid: 80, flags: ['\\Seen'] }], moveMessage: move })
  await useAgent.getState().run('archive')
  expect(move).toHaveBeenCalledTimes(2)
  expect(useAgent.getState().receipt!.detail).toContain('已归档 1 封')
  await useAgent.getState().receipt!.undo!()
  expect(undo).toHaveBeenCalledTimes(1)
})

test('missing AI credentials are reported before reading any message body', async () => {
  jest.mocked(getAIConfig).mockResolvedValueOnce({ hasKey: false, baseUrl: 'https://example.com/v1', model: 'test' })
  await useAgent.getState().run('plan')
  expect(body).not.toHaveBeenCalled()
  expect(analyze).not.toHaveBeenCalled()
  expect(useAgent.getState().receipt).toMatchObject({ title: '先配置 AI', configureAI: true })
})
test('an active workflow cannot silently replace its input selection', async () => {
  useAgent.setState({ busy: true, input: [message] })
  expect(useAgent.getState().setInput([])).toBe(false)
  expect(useAgent.getState().input).toEqual([message])
  useAgent.getState().clear()
})
