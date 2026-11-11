/// <reference types="node" />
import { createCipheriv, randomBytes as nodeRandom, scryptSync } from 'node:crypto'
jest.mock('react-native-tcp-socket', () => ({ createConnection: jest.fn() }))
jest.mock('react-native-keychain', () => {
  const values = new Map<string, { username: string; password: string }>()
  return { getGenericPassword: jest.fn(async ({ service }) => values.get(service) ?? false), setGenericPassword: jest.fn(async (username, password, { service }) => { values.set(service, { username, password }); return true }), resetGenericPassword: jest.fn(async ({ service }) => values.delete(service)) }
})
jest.mock('@react-native-async-storage/async-storage', () => {
  const values = new Map<string, string>()
  return { getItem: jest.fn(async key => values.get(key) ?? null), setItem: jest.fn(async (key, value) => { values.set(key, value) }), removeItem: jest.fn(async key => values.delete(key)) }
})
jest.mock('../src/workbench/sync', () => ({ pauseWorkSync: jest.fn(), scheduleWorkSync: jest.fn() }))
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Keychain from 'react-native-keychain'
import { parseBackup, unlockBackup, type BackupPlan } from '../src/backup/format'
import { applyBackup } from '../src/backup/restore'
import { restoreJournal, recoverPendingRestore } from '../src/backup/journal'
import { useMail } from '../src/store/mail'
import { useWorkbench } from '../src/workbench/store'
import { encryptedStore } from '../src/storage/encrypted'
import type { WorkItem } from '../src/workbench/model'

// Independent desktop-format producer: Node crypto, not the mobile decoder.
function desktop(payload: object, version = 2) {
  const salt = nodeRandom(16), iv = nodeRandom(12), key = scryptSync('backup-password', salt, 32, { N: 16384, r: 8, p: 1 })
  const cipher = createCipheriv('aes-256-gcm', key, iv), ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()])
  return JSON.stringify({ app: 'linkto-backup', v: version, kdf: 'scrypt', createdAt: 100, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })
}
const account = { config: { id: 'desktop-1', provider: 'gmail', email: 'test@example.invalid', name: 'Desktop inbox', user: 'custom-login', imap: { host: 'imap.example.invalid', port: 993, secure: true }, smtp: { host: 'smtp.example.invalid', port: 465, secure: true } }, secret: 'app-password' }
const records = [{ type: 'ins.todo', id: 'desktop-task', updatedAt: 200, refs: { a: { 'desktop-1': 'gmail|test@example.invalid' }, m: { 'desktop-1::INBOX::42': '<mail@example.invalid>' } }, data: { accountId: 'desktop-1', messageId: 'desktop-1::INBOX::42', title: 'Desktop task', status: 'open', dueAt: null, createdAt: 100, data: { content: 'Private backup content', collection: 'Projects' } } }, { type: 'ins.memo', id: 'desktop-note', updatedAt: 300, data: { title: 'Desktop note', data: { content: 'Private note', pinned: true } } }, { type: 'setting.ai', id: 'v', data: { baseURL: 'https://ai.example.invalid/v1', model: 'test-model', apiKey: 'private-key' } }, { type: 'ins.finance', id: 'bill', data: {} }]
beforeEach(async () => {
  useMail.setState({ guard: 'ready', accounts: [], sending: false })
  useWorkbench.getState().clear()
  await AsyncStorage.removeItem('linkto.workbench.v1'); await AsyncStorage.removeItem('linkto.accounts.v1')
  await restoreJournal.write(null)
})
test('opens independently generated desktop v1 and v2 backups, maps notes, AI and device-only accounts', async () => {
  const v1 = await unlockBackup(parseBackup(desktop({ accounts: [account] }, 1)), 'backup-password')
  expect(v1.accounts[0].secret).toBe('app-password'); expect(v1.accounts[0].account.username).toBe('custom-login')
  const plan = await unlockBackup(parseBackup(desktop({ accounts: [account, { config: { ...account.config, provider: 'proton', email: 'proton@example.invalid', imap: { host: '127.0.0.1', port: 1143 } }, secret: 'bridge' }], records })), 'backup-password')
  expect(plan.items.map(i => i.kind)).toEqual(['todo', 'memo']); expect(plan.items[0].data.collection).toBe('Projects'); expect(plan.items[0].data.source).toMatchObject({ accountEmail: 'test@example.invalid', messageId: '<mail@example.invalid>', mailbox: 'INBOX', uid: 42 })
  expect(plan.items[1].data.reminder).toBe(false); expect(plan.ai?.baseUrl).toBe('https://ai.example.invalid/v1')
  expect(plan.accounts[1].desktopOnly).toBe(true); expect(plan.accounts[1].secret).toBeUndefined(); expect(plan.unsupported).toBe(1)
}, 20000)
test('wrong passwords, tampering and unsupported versions fail before any writes', async () => {
  const raw = desktop({ accounts: [account], records })
  const writes = jest.mocked(AsyncStorage.setItem).mock.calls.length
  await expect(unlockBackup(parseBackup(raw), 'wrong')).rejects.toThrow('口令')
  const tampered = JSON.parse(raw); tampered.tag = Buffer.alloc(16).toString('base64')
  await expect(unlockBackup(parseBackup(JSON.stringify(tampered)), 'backup-password')).rejects.toThrow('损坏')
  expect(() => parseBackup(raw.replace('"v":2', '"v":99'))).toThrow('版本')
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(writes)
}, 20000)
test('restore skips duplicate mailboxes and newer local records, then survives a reload', async () => {
  const plan = await unlockBackup(parseBackup(desktop({ accounts: [account], records })), 'backup-password')
  await useWorkbench.getState().save({ id: 'desktop-task', title: 'Newer phone task', content: 'Keep this', at: null })
  const first = await applyBackup(plan, { accounts: true, items: true, ai: false })
  expect(first.accounts).toBe(1); expect(first.items).toBe(1); expect(first.skipped).toBe(1)
  expect(useMail.getState().accounts[0].username).toBe('custom-login')
  expect(await Keychain.getGenericPassword({ service: 'linkto.imap.' + useMail.getState().accounts[0].id })).toMatchObject({ password: 'app-password' })
  expect(await AsyncStorage.getItem('linkto.workbench.v1')).not.toContain('Private note')
  useWorkbench.getState().clear(); await useWorkbench.getState().load()
  expect(useWorkbench.getState().items.find(i => i.id === 'desktop-task')?.title).toBe('Newer phone task')
  expect((await applyBackup(plan, { accounts: true, items: true, ai: false })).accounts).toBe(0)
}, 20000)
test('write failures roll back both new credentials and local content', async () => {
  const plan = await unlockBackup(parseBackup(desktop({ accounts: [account], records })), 'backup-password')
  await useWorkbench.getState().save({ id: 'keep', title: 'Existing phone content', content: 'Unchanged', at: null })
  const before = await AsyncStorage.getItem('linkto.workbench.v1'), keysBefore = jest.mocked(Keychain.setGenericPassword).mock.calls.length
  const setter = jest.mocked(AsyncStorage.setItem), original = setter.getMockImplementation()!
  setter.mockImplementation(async (key, value) => { if (key === 'linkto.accounts.v1') throw new Error('disk full'); return original(key, value) })
  try { await expect(applyBackup(plan, { accounts: true, items: true, ai: false })).rejects.toThrow('撤回') }
  finally { setter.mockImplementation(original) }
  expect(await AsyncStorage.getItem('linkto.workbench.v1')).toBe(before)
  const newCredential = jest.mocked(Keychain.setGenericPassword).mock.calls.slice(keysBefore).find(call => call[2]?.service?.startsWith('linkto.imap.'))!
  expect(await Keychain.getGenericPassword({ service: newCredential[2]!.service })).toBe(false)
  expect(useMail.getState().accounts).toHaveLength(0)
}, 20000)
test('startup recovers interrupted writes using the encrypted journal', async () => {
  await AsyncStorage.setItem('linkto.accounts.v1', 'original-profile')
  await restoreJournal.write({ values: [['linkto.accounts.v1', 'original-profile']], secrets: [{ service: 'linkto.imap.interrupted', password: null }] })
  expect(await AsyncStorage.getItem('linkto.restore-journal.v1')).not.toContain('original-profile')
  await AsyncStorage.setItem('linkto.accounts.v1', 'partial-profile')
  await Keychain.setGenericPassword('me', 'partial-password', { service: 'linkto.imap.interrupted' })
  await recoverPendingRestore(true)
  expect(await AsyncStorage.getItem('linkto.accounts.v1')).toBe('original-profile')
  expect(await Keychain.getGenericPassword({ service: 'linkto.imap.interrupted' })).toBe(false)
  expect(await restoreJournal.read()).toBeNull()
})
test('AI restore is explicit and rolls back endpoint and Key on a partial settings write', async () => {
  const plan = await unlockBackup(parseBackup(desktop({ accounts: [], records })), 'backup-password')
  await AsyncStorage.setItem('linkto.ai.base', 'https://old.example.invalid/v1')
  await AsyncStorage.setItem('linkto.ai.model', 'old-model')
  await Keychain.setGenericPassword('ai', 'old-key', { service: 'linkto.ai.key' })
  const setter = jest.mocked(AsyncStorage.setItem), original = setter.getMockImplementation()!
  let fail = true
  setter.mockImplementation(async (key, value) => { if (key === 'linkto.ai.model' && fail) { fail = false; throw new Error('interrupted write') }; return original(key, value) })
  try { await expect(applyBackup(plan, { accounts: false, items: false, ai: true })).rejects.toThrow('撤回') }
  finally { setter.mockImplementation(original) }
  expect(await AsyncStorage.getItem('linkto.ai.base')).toBe('https://old.example.invalid/v1')
  expect(await Keychain.getGenericPassword({ service: 'linkto.ai.key' })).toMatchObject({ password: 'old-key' })
  expect((await applyBackup(plan, { accounts: false, items: false, ai: true })).ai).toBe(true)
  expect(await Keychain.getGenericPassword({ service: 'linkto.ai.key' })).toMatchObject({ password: 'private-key' })
}, 20000)
test('an intervening profile burn aborts restore without resurrecting credentials or data', async () => {
  const plan = await unlockBackup(parseBackup(desktop({ accounts: [account] })), 'backup-password')
  const setter = jest.mocked(Keychain.setGenericPassword), original = setter.getMockImplementation()!
  let imported = ''
  setter.mockImplementation(async (username, password, options) => {
    const result = await original(username, password, options)
    if (options?.service?.startsWith('linkto.imap.')) { imported = options.service; useMail.setState({ guard: 'burned' }) }
    return result
  })
  try { await expect(applyBackup(plan, { accounts: true, items: false, ai: false })).rejects.toThrow('本次恢复已停止') }
  finally { setter.mockImplementation(original) }
  expect(imported).toBeTruthy()
  expect(await Keychain.getGenericPassword({ service: imported })).toBe(false)
  expect(await AsyncStorage.getItem('linkto.accounts.v1')).toBeNull()
  expect(await AsyncStorage.getItem('linkto.restore-journal.v1')).toBeNull()
}, 20000)
