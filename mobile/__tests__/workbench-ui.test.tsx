import React from 'react'
import { Alert, Modal } from 'react-native'
import TestRenderer, { act } from 'react-test-renderer'

jest.mock('react-native-tcp-socket', () => ({ __esModule: true, default: {} }))
jest.mock('react-native-webview', () => ({ WebView: () => null }))
jest.mock('@react-native-clipboard/clipboard', () => ({ __esModule: true, default: { setString: jest.fn() } }))
jest.mock('../src/hooks/useTablet', () => ({ useTablet: () => false }))
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }))
jest.mock('react-native-keychain', () => {
  const data = new Map<string, string>()
  return { getGenericPassword: jest.fn(async ({ service }) => data.has(service) ? { password: data.get(service) } : false), setGenericPassword: jest.fn(async (_u, value, { service }) => { data.set(service, value); return true }), resetGenericPassword: jest.fn(async ({ service }) => { data.delete(service); return true }) }
})
jest.mock('@react-native-async-storage/async-storage', () => {
  const data = new Map<string, string>()
  return { getItem: jest.fn(async (key) => data.get(key) ?? null), setItem: jest.fn(async (key, value) => { data.set(key, value) }), removeItem: jest.fn(async key => { data.delete(key) }) }
})
import { MainShell } from '../src/screens/MainShell'
import { useMail } from '../src/store/mail'
import { useWorkbench } from '../src/workbench/store'

test('global create opens capture, timed note becomes a task and primary navigation stays usable', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  useMail.setState({ guard: 'ready', accounts: [], tab: 'today' })
  let app!: TestRenderer.ReactTestRenderer
  await act(async () => { app = TestRenderer.create(<MainShell />) })
  await act(async () => { app.root.findAllByProps({ accessibilityLabel: '全局新建邮件或随手记' })[0].props.onPress() })
  const buttons = alert.mock.calls[0][2]!
  expect(buttons.map(b => b.text)).toEqual(['写邮件', '随手记 / 待办', '取消'])
  await act(async () => { buttons[1].onPress?.() })
  expect(app.root.findByType(Modal).props.visible).toBe(true)
  await act(async () => {
    app.root.findByProps({ accessibilityLabel: '标题' }).props.onChangeText('准备回复客户邮件')
    app.root.findByProps({ accessibilityLabel: '安排日期，年-月-日' }).props.onChangeText('2030-02-20')
  })
  // Save directly through the sheet's visible button, not through a test-only API.
  const save = app.root.findAll(node => node.props.accessibilityRole === 'button' && node.findAll(child => child.props.children === '保存').length > 0)[0]
  await act(async () => { save.props.onPress(); await new Promise<void>(resolve => setTimeout(() => resolve(), 30)) })
  expect(useWorkbench.getState().items.some(i => i.title === '准备回复客户邮件' && i.kind === 'todo' && i.data.minutes === 45)).toBe(true)
  expect(useWorkbench.getState().capture).toBeNull()
  await act(async () => { app.root.findAllByProps({ accessibilityLabel: '随手记', accessibilityRole: 'tab' })[0].props.onPress() })
  expect(useMail.getState().tab).toBe('notes')
  await act(async () => app.unmount())
  alert.mockRestore()
})

test('mail actions, list density and batch actions remain reachable from the inbox', async () => {
  const original = useMail.getState().moveMessage
  const move = jest.fn(async () => ({ undo: async () => {} }))
  const account = { id: 'qa-mail', email: 'qa@example.com', host: 'imap.example.com', port: 993, secure: true, smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecure: true, color: '#006265' }
  const first = { uid: 70, accountId: account.id, accountEmail: account.email, accountColor: account.color, mailbox: 'INBOX', flags: [], date: Date.now(), subject: 'First', from: 'a@example.com', to: account.email }
  useMail.setState({ guard: 'ready', accounts: [account], messages: [first, { ...first, uid: 80, subject: 'Second' }], tab: 'mail', screen: 'inbox', status: 'ready', scope: { kind: 'unified', folder: 'INBOX', title: '收件箱' }, moveMessage: move })
  let app!: TestRenderer.ReactTestRenderer
  const button = (text: string) => app.root.findAll(node => node.props.accessibilityRole === 'button' && node.findAll(child => child.props.children === text).length > 0)[0]
  try {
    await act(async () => { app = TestRenderer.create(<MainShell />) })
    await act(async () => app.root.findAllByProps({ accessibilityLabel: '处理邮件 First' })[0].props.onPress())
    await act(async () => { button('归档').props.onPress() })
    expect(move).toHaveBeenCalledWith(expect.objectContaining({ uid: 70 }), 'archive')
    await act(async () => { await app.root.findAllByProps({ accessibilityLabel: '切换收件箱列表密度' })[0].props.onPress() })
    expect(app.root.findAllByProps({ children: '紧凑列表' }).length).toBeGreaterThan(0)
    await act(async () => { button('选择邮件').props.onPress() })
    await act(async () => { button('全选').props.onPress() })
    await act(async () => { button('归档').props.onPress() })
    expect(move).toHaveBeenCalledTimes(3)
  } finally { await act(async () => app.unmount()); useMail.setState({ moveMessage: original, accounts: [], messages: [] }) }
})

test('folder batch movement retries only unfinished mail after a partial failure', async () => {
  const { FolderSheet } = require('../src/mail/FolderSheet')
  const { Notice } = require('../src/ui/Notice')
  const originalMove = useMail.getState().moveToFolder, originalReload = useMail.getState().reloadFolders
  const move = jest.fn().mockResolvedValueOnce({ undo: async () => {} }).mockRejectedValueOnce(new Error('连接失败')).mockResolvedValueOnce({})
  const base = { uid: 71, accountId: 'qa-folders', accountEmail: 'qa@example.com', accountColor: '#006265', mailbox: 'INBOX', flags: [], date: 100, subject: '客户', from: 'a@example.com', to: 'qa@example.com' }
  useMail.setState({ moveToFolder: move, reloadFolders: async () => {}, folders: { 'qa-folders': [{ name: 'Projects', flags: [], delimiter: '/' }] } })
  let app!: TestRenderer.ReactTestRenderer
  const close = jest.fn()
  try {
    await act(async () => { app = TestRenderer.create(<><FolderSheet accountId="qa-folders" messages={[base, { ...base, uid: 72 }]} onClose={close} /><Notice /></>) })
    const target = () => app.root.findAllByProps({ accessibilityLabel: '移动到文件夹 Projects' })[0]
    await act(async () => { target().props.onPress() })
    expect(move).toHaveBeenCalledTimes(2); expect(close).not.toHaveBeenCalled()
    await act(async () => { target().props.onPress() })
    expect(move).toHaveBeenCalledTimes(3); expect(move.mock.calls[2][0].uid).toBe(72); expect(close).toHaveBeenCalledTimes(1)
  } finally { await act(async () => app.unmount()); useMail.setState({ moveToFolder: originalMove, reloadFolders: originalReload }) }
})

test('creating a move destination and retrying a partial failure does not recreate it or repeat successful moves', async () => {
  const { FolderSheet } = require('../src/mail/FolderSheet')
  const { Notice } = require('../src/ui/Notice')
  const original = { moveToFolder: useMail.getState().moveToFolder, reloadFolders: useMail.getState().reloadFolders, changeFolder: useMail.getState().changeFolder }
  const create = jest.fn(async () => {})
  const move = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('临时失败')).mockResolvedValueOnce({})
  const base = { uid: 91, accountId: 'qa-new-folder', accountEmail: 'qa@example.com', accountColor: '#006265', mailbox: 'INBOX', flags: [], date: 100, subject: '项目', from: 'a@example.com', to: 'qa@example.com' }
  useMail.setState({ moveToFolder: move, reloadFolders: async () => {}, changeFolder: create, folders: {} })
  const close = jest.fn()
  let app!: TestRenderer.ReactTestRenderer
  try {
    await act(async () => { app = TestRenderer.create(<><FolderSheet accountId="qa-new-folder" messages={[base, { ...base, uid: 92 }]} onClose={close} /><Notice /></>) })
    await act(async () => { app.root.findByProps({ accessibilityLabel: '文件夹名称' }).props.onChangeText('客户项目') })
    const button = () => app.root.findAll(n => n.props?.accessibilityRole === 'button' && n.findAll(c => c.props?.children === '新建并移入').length > 0)[0]
    await act(async () => { button().props.onPress() })
    expect(create).toHaveBeenCalledWith('qa-new-folder', 'create', '客户项目')
    expect(move).toHaveBeenCalledTimes(2); expect(close).not.toHaveBeenCalled()
    await act(async () => { button().props.onPress() })
    expect(create).toHaveBeenCalledTimes(1)
    expect(move).toHaveBeenCalledTimes(3); expect(move.mock.calls[2][0].uid).toBe(92)
    expect(close).toHaveBeenCalledTimes(1)
  } finally { await act(async () => app.unmount()); useMail.setState(original) }
})
