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
