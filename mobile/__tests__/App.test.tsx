import React from 'react'
import ReactTestRenderer, { act } from 'react-test-renderer'
import * as Keychain from 'react-native-keychain'
import App from '../App'
import { useMail } from '../src/store/mail'

jest.mock('react-native-tcp-socket', () => ({ createConnection: jest.fn(), default: { createConnection: jest.fn() } }))
jest.mock('react-native-webview', () => ({ WebView: () => null }))
jest.mock('../src/hooks/useTablet', () => ({ useTablet: () => false }))
jest.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: require('react-native').View, SafeAreaView: require('react-native').View, useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }))
jest.mock('@react-native-clipboard/clipboard', () => ({ __esModule: true, default: { setString: jest.fn(), getString: jest.fn(async () => '') } }))
jest.mock('react-native-keychain', () => {
  const data = new Map<string, string>()
  return { getGenericPassword: jest.fn(async ({ service }) => data.has(service) ? { password: data.get(service) } : false), setGenericPassword: jest.fn(async (_u, value, { service }) => { data.set(service, value); return true }), resetGenericPassword: jest.fn(async ({ service }) => { data.delete(service); return true }) }
})
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}) }))

test('a fresh install presents both password setup fields', async () => {
  let app!: ReactTestRenderer.ReactTestRenderer
  await act(async () => { app = ReactTestRenderer.create(<App />) })
  try {
    expect(app.root.findAll(node => node.props.secureTextEntry === true).length).toBeGreaterThanOrEqual(2)
    await act(async () => {
      app.root.findAllByProps({ placeholder: '主密码' })[0].props.onChangeText('fresh-password')
      app.root.findAllByProps({ placeholder: '再输一遍确认' })[0].props.onChangeText('fresh-password')
    })
    const submit = app.root.findAll(node => typeof node.props.onPress === 'function' && node.findAll(child => child.props.children === '设置并进入').length > 0)[0]
    await act(async () => { await submit.props.onPress() })
    expect(app.root.findAllByProps({ accessibilityLabel: '全局新建邮件或随手记' }).length).toBeGreaterThan(0)
  } finally { await act(async () => app.unmount()) }
})
test('keychain initialization failure offers retry without asking for a password', async () => {
  useMail.setState({ guard: 'unknown', initError: '' })
  jest.mocked(Keychain.getGenericPassword).mockRejectedValueOnce(new Error('entitlement unavailable'))
  const log = jest.spyOn(console, 'error').mockImplementation(() => {})
  let app!: ReactTestRenderer.ReactTestRenderer
  try {
    await act(async () => { app = ReactTestRenderer.create(<App />) })
    expect(app.root.findAllByProps({ accessibilityLabel: '重试初始化' }).length).toBeGreaterThan(0)
    expect(app.root.findAll(node => node.props.secureTextEntry === true)).toHaveLength(0)
  } finally { await act(async () => app.unmount()); log.mockRestore() }
})
