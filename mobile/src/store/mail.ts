import { create } from 'zustand'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Keychain from 'react-native-keychain'
import { ImapLite, type MailEnvelope } from '../imap/ImapLite'
import {
  guardState,
  setupMaster as setupMasterGuard,
  unlock as unlockGuard,
  burnAll,
  isMitmError,
  BURN_AT_FAILS
} from '../security/guard'

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
  /** 守卫相位：unknown=检测中 setup=需设主密码 locked=需解锁 ready=已解锁 burned=已焚毁 */
  guard: 'unknown' | 'setup' | 'locked' | 'ready' | 'burned'
  guardLockUntil: number
  guardFailsLeft: number
  burnReason: string
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
  setupMaster(password: string): Promise<string | null>
  unlockMaster(password: string): Promise<void>
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

/** 焚毁执行：清凭据与账户索引 → 守卫相位 burned（UI 顶格提示） */
async function burnHere(set: (p: Partial<MailState>) => void, reason: string) {
  await burnAll(reason)
  set({
    guard: 'burned', burnReason: reason, accounts: [], active: null,
    screen: 'accounts', messages: [], reading: null, body: null, status: 'idle', statusText: ''
  })
}

export const useMail = create<MailState>((set, get) => ({
  screen: 'accounts',
  guard: 'unknown',
  guardLockUntil: 0,
  guardFailsLeft: 0,
  burnReason: '',
  accounts: [],
  active: null,
  mailbox: 'INBOX',
  messages: [],
  status: 'idle',
  statusText: '',
  reading: null,
  body: null,

  init: async () => {
    try {
      const gs = await guardState()
      if (!gs.initialized) {
        set({ guard: 'setup' })
        return
      }
      if (gs.lockedUntil > Date.now()) {
        set({ guard: 'locked', guardLockUntil: gs.lockedUntil, guardFailsLeft: gs.fails })
        return
      }
      set({ guard: 'locked', guardFailsLeft: BURN_AT_FAILS - gs.fails, guardLockUntil: 0, accounts: await loadAccounts() })
    } catch (e) {
      console.error('GUARD_INIT_ERR', e instanceof Error ? `${e.message}` : e)
      set({ guard: 'locked', guardFailsLeft: BURN_AT_FAILS })
    }
  },

  setupMaster: async password => {
    const err = await setupMasterGuard(password)
    if (err) return err
    set({ guard: 'locked', guardFailsLeft: BURN_AT_FAILS, guardLockUntil: 0, accounts: await loadAccounts() })
    return null
  },

  unlockMaster: async password => {
    const r = await unlockGuard(password)
    if (r.result === 'ok') set({ guard: 'ready', guardLockUntil: 0, guardFailsLeft: 0, accounts: await loadAccounts() })
    else if (r.result === 'burned') set({ guard: 'burned', burnReason: '主密码连续错误达上限，本地数据已焚毁' })
    else if (r.result === 'locked') set({ guard: 'locked', guardLockUntil: r.lockUntil ?? 0, guardFailsLeft: r.remaining ?? 0 })
    else set({ guardFailsLeft: r.remaining ?? 0 })
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
      const msg = e instanceof Error ? e.message : String(e)
      if (isMitmError(msg)) await burnHere(set, 'TLS 证书校验失败，检测到中间人，本地数据已焚毁')
      return msg
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
      const msg = e instanceof Error ? e.message : String(e)
      // 中间人即焚：TLS 证书校验失败（自签/劫持/抓包）= 确证有人在中间读取 → 本地焚毁
      if (isMitmError(msg)) {
        await burnHere(set, '检测到中间人攻击（TLS 证书校验失败），本地数据已焚毁')
        return
      }
      set({ status: 'error', statusText: msg })
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