import { create } from 'zustand'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Keychain from 'react-native-keychain'
import { ImapLite, type MailEnvelope } from '../imap/ImapLite'

export interface MobileAccount {
  id: string
  email: string
  host: string
  port: number
  secure: boolean
}

const ACCOUNTS_KEY = 'linkto.accounts.v1'

async function loadAccounts(): Promise<MobileAccount[]> {
  try {
    const raw = await AsyncStorage.getItem(ACCOUNTS_KEY)
    return raw ? (JSON.parse(raw) as MobileAccount[]) : []
  } catch {
    return []
  }
}

async function persistAccounts(list: MobileAccount[]) {
  await AsyncStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list))
}

interface MailState {
  screen: 'accounts' | 'inbox' | 'read'
  accounts: MobileAccount[]
  active: MobileAccount | null
  mailbox: string
  messages: MailEnvelope[]
  status: 'idle' | 'connecting' | 'syncing' | 'error' | 'ready'
  statusText: string
  reading: MailEnvelope | null
  body: string | null
  init(): Promise<void>
  go(screen: MailState['screen']): void
  saveAccount(draft: { email: string; pass: string; host: string; port: string; secure: boolean }): Promise<string | null>
  deleteAccount(id: string): Promise<void>
  openInbox(account: MobileAccount): Promise<void>
  openMessage(m: MailEnvelope, opts?: { stay?: boolean }): Promise<void>
  backToInbox(): void
  closeReading(): void
}

const imap: { client: ImapLite | null } = { client: null }

async function disconnect() {
  try { await imap.client?.logout() } catch { /* ignore */ }
  imap.client = null
}

export const useMail = create<MailState>((set, get) => ({
  screen: 'accounts',
  accounts: [],
  active: null,
  mailbox: 'INBOX',
  messages: [],
  status: 'idle',
  statusText: '',
  reading: null,
  body: null,

  init: async () => {
    set({ accounts: await loadAccounts() })
  },

  go: screen => set({ screen }),

  saveAccount: async draft => {
    const email = draft.email.trim().toLowerCase()
    if (!email || !draft.host.trim() || !draft.pass) return '请填写完整：邮箱 / 服务器 / 密码（授权码）'
    const acc: MobileAccount = {
      id: `mob-${Date.now().toString(36)}`,
      email,
      host: draft.host.trim(),
      port: parseInt(draft.port || '993', 10) || 993,
      secure: draft.secure
    }
    // 先验证再保存：真实连接一次
    const client = new ImapLite()
    try {
      await client.connect({ host: acc.host, port: acc.port, secure: acc.secure, user: email, pass: draft.pass })
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    // 验证通过：凭据入系统钥匙串（iOS Keychain / Android Keystore）
    await Keychain.setGenericPassword(email, draft.pass, { service: `linkto.imap.${acc.id}` })
    const list = [...(await loadAccounts()).filter(a => a.email !== email), acc]
    await persistAccounts(list)
    set({ accounts: list })
    return null
  },

  deleteAccount: async id => {
    await Keychain.resetGenericPassword({ service: `linkto.imap.${id}` })
    const list = (await loadAccounts()).filter(a => a.id !== id)
    await persistAccounts(list)
    set({ accounts: list })
  },

  openInbox: async account => {
    set({ active: account, status: 'connecting', statusText: '连接中…', screen: 'inbox', messages: [] })
    await disconnect()
    const client = new ImapLite()
    imap.client = client
    try {
      const creds = await Keychain.getGenericPassword({ service: `linkto.imap.${account.id}` })
      if (!creds) throw new Error('未找到钥匙串凭据，请重新添加账户')
      await client.connect({ host: account.host, port: account.port, secure: account.secure, user: account.email, pass: creds.password })
      set({ status: 'syncing', statusText: '同步中…' })
      const messages = await client.fetchEnvelopes(get().mailbox, 50)
      set({ status: 'ready', statusText: '', messages })
    } catch (e) {
      set({ status: 'error', statusText: e instanceof Error ? e.message : String(e) })
    }
  },

  openMessage: async (m, opts) => {
    const { active, mailbox } = get()
    if (!active || !imap.client) return
    // 平板双栏：stay=true 时保持 inbox screen，仅更新右栏选中邮件
    set(opts?.stay ? { reading: m, body: null } : { screen: 'read', reading: m, body: null })
    try {
      const body = await imap.client.fetchBody(mailbox, m.uid)
      set({ body: body || '（空正文）' })
      await imap.client.markSeen(mailbox, m.uid).catch(() => {})
    } catch (e) {
      set({ body: `正文加载失败：${e instanceof Error ? e.message : String(e)}` })
    }
  },

  backToInbox: () => set({ screen: 'inbox' }),
  closeReading: () => set({ reading: null, body: null })
}))