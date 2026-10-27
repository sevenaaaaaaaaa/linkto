import { create } from 'zustand'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Keychain from 'react-native-keychain'
import { ImapLite, type MailBoxInfo, type MailEnvelope } from '../imap/ImapLite'
import { parseMime, type ParsedAttachment } from '../imap/MimeLite'
import { SmtpLite } from '../smtp/SmtpLite'
import { addressOf } from '../smtp/message'
import {
  guardState,
  setupMaster as setupMasterGuard,
  unlock as unlockGuard,
  burnAll,
  isMitmError,
  BURN_AT_FAILS
} from '../security/guard'
import { burnExtraSecrets } from '../security/burn-extra'

export interface MobileAccount {
  id: string
  email: string
  host: string
  port: number
  secure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  color: string
  displayName?: string
}

export type MailTab = 'mail' | 'fly' | 'vault' | 'settings'
export type MailScreen = 'accounts' | 'inbox' | 'read' | 'compose'

export interface MobileMessage extends MailEnvelope {
  accountId: string
  accountEmail: string
  accountColor: string
  mailbox: string
}

export interface MailScope {
  kind: 'unified' | 'account'
  accountId?: string
  folder: string
  title: string
}

export interface MailBody {
  html: string | null
  text: string | null
  attachments: ParsedAttachment[]
}

export interface ComposeDraft {
  accountId: string
  to: string
  cc: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string
}

const ACCOUNTS_KEY = 'linkto.accounts.v1'
const PALETTE = ['#006265', '#8A5A2B', '#5B4B8A', '#2E6B4F', '#8A3B4A', '#3B5B8A', '#6B5A2E']

function colorFor(email: string): string {
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function guessSmtp(host: string, email: string): Pick<MobileAccount, 'smtpHost' | 'smtpPort' | 'smtpSecure'> {
  const h = host.toLowerCase()
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  if (h.includes('gmail') || domain.includes('gmail')) return { smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true }
  if (h.includes('qq') || domain.includes('qq')) return { smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecure: true }
  if (h.includes('163') || domain.includes('163')) return { smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: true }
  if (h.includes('outlook') || h.includes('office365') || domain.includes('outlook') || domain.includes('hotmail')) {
    return { smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false }
  }
  if (h.includes('icloud') || h.includes('me.com') || domain.includes('icloud') || domain.includes('me.com')) {
    return { smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false }
  }
  return { smtpHost: h.replace(/^imap\./, 'smtp.'), smtpPort: 465, smtpSecure: true }
}

function normalizeAccount(a: MobileAccount): MobileAccount {
  const smtp = guessSmtp(a.host, a.email)
  return {
    ...a,
    ...(a.smtpHost ? { smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpSecure: a.smtpSecure } : smtp),
    color: a.color || colorFor(a.email)
  }
}

async function loadAccounts(): Promise<MobileAccount[]> {
  try {
    const raw = await AsyncStorage.getItem(ACCOUNTS_KEY)
    const list = raw ? (JSON.parse(raw) as MobileAccount[]) : []
    return Array.isArray(list) ? list.map(normalizeAccount) : []
  } catch {
    return []
  }
}

async function persistAccounts(list: MobileAccount[]) {
  await AsyncStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list))
}

interface MailState {
  tab: MailTab
  screen: MailScreen
  guard: 'unknown' | 'setup' | 'locked' | 'ready' | 'burned'
  guardLockUntil: number
  guardFailsLeft: number
  burnReason: string
  accounts: MobileAccount[]
  active: MobileAccount | null
  scope: MailScope
  folders: Record<string, MailBoxInfo[]>
  messages: MobileMessage[]
  searchQuery: string
  status: 'idle' | 'connecting' | 'syncing' | 'error' | 'ready'
  statusText: string
  reading: MobileMessage | null
  body: MailBody | null
  bodyLoading: boolean
  compose: ComposeDraft | null
  sending: boolean
  composeError: string
  init(): Promise<void>
  setTab(tab: MailTab): void
  go(screen: MailScreen): void
  setupMaster(password: string): Promise<string | null>
  unlockMaster(password: string): Promise<void>
  saveAccount(draft: {
    email: string; pass: string; host: string; port: string; secure: boolean
    smtpHost?: string; smtpPort?: string; smtpSecure?: boolean
  }): Promise<string | null>
  deleteAccount(id: string): Promise<void>
  openUnified(): Promise<void>
  openAccount(account: MobileAccount): Promise<void>
  openInbox(account: MobileAccount): Promise<void>
  openFolder(account: MobileAccount, folder: string): Promise<void>
  refresh(): Promise<void>
  search(query: string): Promise<void>
  openMessage(m: MobileMessage, opts?: { stay?: boolean }): Promise<void>
  toggleSeen(m: MobileMessage): Promise<void>
  stepReading(dir: 1 | -1): Promise<void>
  backToInbox(): void
  closeReading(): void
  composeNew(prefill?: Partial<ComposeDraft>): void
  composeReply(m: MobileMessage): void
  updateCompose(patch: Partial<ComposeDraft>): void
  closeCompose(): void
  sendCompose(): Promise<void>
  lockNow(): Promise<void>
}

const clients = new Map<string, ImapLite>()

async function disconnectAll() {
  for (const c of clients.values()) {
    try { await c.logout() } catch { /* ignore */ }
  }
  clients.clear()
}

async function ensureClient(account: MobileAccount): Promise<ImapLite> {
  const existing = clients.get(account.id)
  if (existing) return existing
  const creds = await Keychain.getGenericPassword({ service: 'linkto.imap.' + account.id })
  if (!creds) throw new Error('未找到钥匙串凭据，请重新添加账户')
  const client = new ImapLite()
  await client.connect({
    host: account.host,
    port: account.port,
    secure: account.secure,
    user: account.email,
    pass: creds.password
  })
  clients.set(account.id, client)
  return client
}

async function withClient<T>(account: MobileAccount, fn: (c: ImapLite) => Promise<T>): Promise<T> {
  const client = await ensureClient(account)
  try {
    return await fn(client)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/未连接|网络错误|响应超时|连接超时/.test(msg)) {
      await client.reconnect()
      return fn(client)
    }
    throw err
  }
}

function isMitmMessage(msg: string): boolean {
  return isMitmError(msg)
}

function withAccount(msg: MailEnvelope, account: MobileAccount, mailbox: string): MobileMessage {
  return { ...msg, accountId: account.id, accountEmail: account.email, accountColor: account.color, mailbox }
}

function sortMessages(list: MobileMessage[]): MobileMessage[] {
  return list.slice().sort((a, b) => (b.date || 0) - (a.date || 0))
}

export const useMail = create<MailState>((set, get) => ({
  tab: 'mail',
  screen: 'accounts',
  guard: 'unknown',
  guardLockUntil: 0,
  guardFailsLeft: 0,
  burnReason: '',
  accounts: [],
  active: null,
  scope: { kind: 'unified', folder: 'INBOX', title: '收件箱' },
  folders: {},
  messages: [],
  searchQuery: '',
  status: 'idle',
  statusText: '',
  reading: null,
  body: null,
  bodyLoading: false,
  compose: null,
  sending: false,
  composeError: '',

  init: async () => {
    try {
      const gs = await guardState()
      if (!gs.initialized) {
        set({ guard: 'setup' })
        return
      }
      if (gs.lockedUntil > Date.now()) {
        set({ guard: 'locked', guardLockUntil: gs.lockedUntil, guardFailsLeft: BURN_AT_FAILS - gs.fails })
        return
      }
      set({ guard: 'locked', guardFailsLeft: BURN_AT_FAILS - gs.fails, guardLockUntil: 0, accounts: await loadAccounts() })
    } catch (e) {
      console.error('GUARD_INIT_ERR', e instanceof Error ? e.message : e)
      set({ guard: 'locked', guardFailsLeft: BURN_AT_FAILS })
    }
  },

  setTab: tab => set({ tab }),

  go: screen => set({ screen }),

  setupMaster: async password => {
    const err = await setupMasterGuard(password)
    if (err) return err
    set({ guard: 'locked', guardFailsLeft: BURN_AT_FAILS, guardLockUntil: 0, accounts: await loadAccounts() })
    return null
  },

  unlockMaster: async password => {
    const r = await unlockGuard(password)
    if (r.result === 'ok') {
      const accounts = await loadAccounts()
      set({ guard: 'ready', guardLockUntil: 0, guardFailsLeft: 0, accounts, screen: accounts.length ? 'inbox' : 'accounts' })
      if (accounts.length) void get().openUnified()
    } else if (r.result === 'burned') {
      await burnExtraSecrets()
      await disconnectAll()
      set({ guard: 'burned', burnReason: '主密码连续错误达上限，本地数据已焚毁', accounts: [] })
    } else if (r.result === 'locked') {
      set({ guard: 'locked', guardLockUntil: r.lockUntil ?? 0, guardFailsLeft: r.remaining ?? 0 })
    } else {
      set({ guardFailsLeft: r.remaining ?? 0 })
    }
  },

  saveAccount: async draft => {
    const email = draft.email.trim().toLowerCase()
    if (!email || !draft.host.trim() || !draft.pass) return '请填写完整：邮箱 / 服务器 / 密码（授权码）'
    const acc: MobileAccount = normalizeAccount({
      id: 'mob-' + Date.now().toString(36),
      email,
      host: draft.host.trim(),
      port: parseInt(draft.port || '993', 10) || 993,
      secure: draft.secure,
      smtpHost: draft.smtpHost?.trim() || '',
      smtpPort: parseInt(draft.smtpPort || '', 10) || 0,
      smtpSecure: draft.smtpSecure ?? true,
      color: colorFor(email)
    })
    if (!acc.smtpHost) Object.assign(acc, guessSmtp(acc.host, email))
    const client = new ImapLite()
    try {
      await client.connect({ host: acc.host, port: acc.port, secure: acc.secure, user: email, pass: draft.pass })
      await client.logout()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (isMitmMessage(msg)) {
        await burnAll('mitm')
        await burnExtraSecrets()
        await disconnectAll()
        set({ guard: 'burned', burnReason: 'TLS 证书校验失败，检测到中间人，本地数据已焚毁', accounts: [], screen: 'accounts' })
      }
      return msg
    }
    await Keychain.setGenericPassword(email, draft.pass, { service: 'linkto.imap.' + acc.id })
    const list = [...(await loadAccounts()).filter(a => a.email !== email), acc]
    await persistAccounts(list)
    set({ accounts: list })
    return null
  },

  deleteAccount: async id => {
    try { await clients.get(id)?.logout() } catch { /* ignore */ }
    clients.delete(id)
    await Keychain.resetGenericPassword({ service: 'linkto.imap.' + id })
    const list = (await loadAccounts()).filter(a => a.id !== id)
    await persistAccounts(list)
    const { active, scope } = get()
    set({
      accounts: list,
      ...(active?.id === id ? { active: null, reading: null, body: null, screen: list.length ? 'inbox' : 'accounts' } : {}),
      ...(scope.accountId === id ? { scope: { kind: 'unified', folder: 'INBOX', title: '收件箱' } } : {})
    })
  },

  openUnified: async () => {
    const accounts = get().accounts
    set({
      tab: 'mail',
      screen: 'inbox',
      active: null,
      scope: { kind: 'unified', folder: 'INBOX', title: '收件箱' },
      searchQuery: '',
      status: 'syncing',
      statusText: '同步中…',
      reading: null,
      body: null
    })
    await fetchScope(set, get, { kind: 'unified', folder: 'INBOX', title: '收件箱' }, false)
    for (const a of accounts) void loadFolders(set, get, a)
  },

  openAccount: async account => {
    set({
      tab: 'mail',
      screen: 'inbox',
      active: account,
      scope: { kind: 'account', accountId: account.id, folder: 'INBOX', title: account.email },
      searchQuery: '',
      status: 'syncing',
      statusText: '同步中…',
      reading: null,
      body: null
    })
    void loadFolders(set, get, account)
    await fetchScope(set, get, { kind: 'account', accountId: account.id, folder: 'INBOX', title: account.email }, false)
  },

  openInbox: async account => get().openAccount(account),

  openFolder: async (account, folder) => {
    set({
      tab: 'mail',
      screen: 'inbox',
      active: account,
      scope: { kind: 'account', accountId: account.id, folder, title: folder },
      searchQuery: '',
      status: 'syncing',
      statusText: '同步中…',
      reading: null,
      body: null
    })
    await fetchScope(set, get, { kind: 'account', accountId: account.id, folder, title: folder }, false)
  },

  refresh: async () => {
    const { scope, searchQuery } = get()
    await fetchScope(set, get, scope, !!searchQuery)
  },

  search: async query => {
    set({ searchQuery: query })
    await fetchScope(set, get, get().scope, !!query)
  },

  openMessage: async (m, opts) => {
    const account = get().accounts.find(a => a.id === m.accountId)
    if (!account) return
    set(opts?.stay ? { reading: m, body: null, bodyLoading: true } : { screen: 'read', reading: m, body: null, bodyLoading: true })
    try {
      const raw = await withClient(account, c => c.fetchRaw(m.mailbox, m.uid))
      const parsed = parseMime(raw)
      set({ body: { html: parsed.html, text: parsed.text, attachments: parsed.attachments }, bodyLoading: false })
      void withClient(account, c => c.markSeen(m.mailbox, m.uid)).then(() => {
        set(s => ({
          messages: s.messages.map(x => x.uid === m.uid && x.accountId === m.accountId ? { ...x, flags: [...new Set([...x.flags, '\\Seen'])] } : x),
          reading: s.reading && s.reading.uid === m.uid && s.reading.accountId === m.accountId
            ? { ...s.reading, flags: [...new Set([...s.reading.flags, '\\Seen'])] }
            : s.reading
        }))
      }).catch(() => {})
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (isMitmMessage(msg)) {
        await burnAll('mitm')
        await burnExtraSecrets()
        await disconnectAll()
        set({ guard: 'burned', burnReason: 'TLS 证书校验失败，检测到中间人，本地数据已焚毁', accounts: [], screen: 'accounts' })
        return
      }
      set({ body: { html: null, text: '正文加载失败：' + msg, attachments: [] }, bodyLoading: false })
    }
  },

  toggleSeen: async m => {
    const wasSeen = m.flags.includes('\\Seen')
    const patch = (list: MobileMessage[]) =>
      list.map(x => {
        if (x.uid !== m.uid || x.accountId !== m.accountId) return x
        const flags = x.flags.filter(f => f !== '\\Seen')
        return { ...x, flags: wasSeen ? flags : [...flags, '\\Seen'] }
      })
    set(s => ({
      messages: patch(s.messages),
      reading: s.reading && s.reading.uid === m.uid && s.reading.accountId === m.accountId ? patch([s.reading])[0] : s.reading
    }))
    const account = get().accounts.find(a => a.id === m.accountId)
    if (!account) return
    try {
      await withClient(account, c => wasSeen ? c.markUnseen(m.mailbox, m.uid) : c.markSeen(m.mailbox, m.uid))
    } catch {
      set(s => ({ messages: s.messages.map(x => x.uid === m.uid && x.accountId === m.accountId ? { ...x, flags: m.flags } : x), statusText: '标记失败，请稍后重试' }))
    }
  },

  stepReading: async dir => {
    const { messages, reading } = get()
    if (!reading || !messages.length) return
    const i = messages.findIndex(m => m.uid === reading.uid && m.accountId === reading.accountId)
    const next = messages[i + dir]
    if (!next) return
    await get().openMessage(next, { stay: true })
  },

  backToInbox: () => set({ screen: 'inbox' }),
  closeReading: () => set({ reading: null, body: null }),

  composeNew: prefill => {
    const { accounts, active } = get()
    const account = active ?? accounts[0]
    if (!account) return
    set({
      tab: 'mail',
      screen: 'compose',
      composeError: '',
      compose: {
        accountId: prefill?.accountId ?? account.id,
        to: prefill?.to ?? '',
        cc: prefill?.cc ?? '',
        subject: prefill?.subject ?? '',
        body: prefill?.body ?? '',
        inReplyTo: prefill?.inReplyTo,
        references: prefill?.references
      }
    })
  },

  composeReply: m => {
    const account = get().accounts.find(a => a.id === m.accountId) ?? get().accounts[0]
    if (!account) return
    const quote = get().body?.text ?? ''
    const date = m.date ? new Date(m.date).toLocaleString('zh-CN', { hour12: false }) : ''
    set({
      tab: 'mail',
      screen: 'compose',
      composeError: '',
      compose: {
        accountId: account.id,
        to: addressOf(m.from),
        cc: '',
        subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject,
        body: '\n\n--- 原邮件 ---\n' + m.from + ' · ' + date + '\n\n' + quote,
        inReplyTo: m.messageId,
        references: m.messageId
      }
    })
  },

  updateCompose: patch => set(s => (s.compose ? { compose: { ...s.compose, ...patch } } : {})),
  closeCompose: () => set({ compose: null, composeError: '', screen: 'inbox' }),

  lockNow: async () => {
    await disconnectAll()
    set({ guard: 'locked', tab: 'mail', screen: 'accounts', messages: [], reading: null, body: null, compose: null, status: 'idle', statusText: '' })
  },

  sendCompose: async () => {
    const { compose, accounts } = get()
    if (!compose) return
    const account = accounts.find(a => a.id === compose.accountId)
    if (!account) { set({ composeError: '没有找到发信账户' }); return }
    const to = compose.to.split(/[,;\\s]+/).map(s => s.trim()).filter(Boolean)
    if (!to.length) { set({ composeError: '请填写收件人' }); return }
    if (!compose.subject.trim() && !compose.body.trim()) { set({ composeError: '主题和正文都是空的' }); return }
    if (!account.smtpSecure) {
      set({ composeError: '当前移动版只支持 465 隐式 TLS 发信；这个账户配置为 587 STARTTLS，请改用桌面端发送。' })
      return
    }
    set({ sending: true, composeError: '' })
    const creds = await Keychain.getGenericPassword({ service: 'linkto.imap.' + account.id })
    if (!creds) { set({ sending: false, composeError: '未找到钥匙串凭据' }); return }
    const smtp = new SmtpLite()
    try {
      await smtp.connect({ host: account.smtpHost, port: account.smtpPort, user: account.email, pass: creds.password })
      await smtp.send({
        from: account.email,
        to,
        cc: compose.cc ? compose.cc.split(/[,;\\s]+/).map(s => s.trim()).filter(Boolean) : [],
        subject: compose.subject || '(无主题)',
        text: compose.body,
        inReplyTo: compose.inReplyTo,
        references: compose.references
      })
      await smtp.close()
      set({ sending: false, compose: null, screen: 'inbox', statusText: '已发送' })
    } catch (e) {
      await smtp.close()
      set({ sending: false, composeError: e instanceof Error ? e.message : String(e) })
    }
  }
}))

type Set = (partial: Partial<MailState> | ((s: MailState) => Partial<MailState>)) => void
type Get = () => MailState

async function loadFolders(set: Set, get: Get, account: MobileAccount): Promise<void> {
  try {
    const list = await withClient(account, c => c.listMailboxes())
    set({ folders: { ...get().folders, [account.id]: list } })
  } catch {
    /* 文件夹加载失败不阻塞收件箱 */
  }
}

async function fetchScope(set: Set, get: Get, scope: MailScope, searching: boolean): Promise<void> {
  const accounts = scope.kind === 'unified'
    ? get().accounts
    : get().accounts.filter(a => a.id === scope.accountId)
  if (!accounts.length) {
    set({ messages: [], status: 'ready', statusText: '' })
    return
  }
  set({ status: 'syncing', statusText: searching ? '搜索中…' : '同步中…' })
  const query = get().searchQuery
  const results = await Promise.allSettled(accounts.map(async a => {
    const list = await withClient(a, c => searching && query
      ? c.searchEnvelopes(scope.kind === 'unified' ? 'INBOX' : scope.folder, query, 40)
      : c.fetchEnvelopes(scope.kind === 'unified' ? 'INBOX' : scope.folder, 40))
    return list.map(m => withAccount(m, a, scope.kind === 'unified' ? 'INBOX' : scope.folder))
  }))
  const merged: MobileMessage[] = []
  let failed = 0
  let mitm = false
  for (const r of results) {
    if (r.status === 'fulfilled') merged.push(...r.value)
    else {
      failed++
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
      if (isMitmMessage(msg)) mitm = true
    }
  }
  if (mitm) {
    await burnAll('mitm')
    await burnExtraSecrets()
    await disconnectAll()
    set({ guard: 'burned', burnReason: 'TLS 证书校验失败，检测到中间人，本地数据已焚毁', accounts: [], messages: [], screen: 'accounts' })
    return
  }
  set({
    messages: sortMessages(merged),
    status: failed === results.length ? 'error' : 'ready',
    statusText: failed ? String(results.length - failed) + '/' + results.length + ' 个账户已同步' : ''
  })
}
