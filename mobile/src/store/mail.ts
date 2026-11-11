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
import { forgetCachedAccount, messageKey, readMailCache, saveMailBody, saveMailList } from '../mail-cache'
import type { MailSource } from '../workbench/model'
import { isSyncFolder } from '../workbench/sync-codec'
import { validMicrosoftToken } from '../oauth/microsoft'
import { presetFor } from '../providers'
import { useWorkbench } from '../workbench/store'
import { validateMailbox } from '../imap/mailbox-name'

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
  authType?: 'password' | 'oauth-ms'
}

export type MailTab = 'mail' | 'today' | 'notes' | 'agent' | 'more' | 'fly' | 'vault' | 'settings'
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
  const preset = presetFor(email)
  if (preset.smtp) return { smtpHost: preset.smtp.host, smtpPort: preset.smtp.port, smtpSecure: preset.smtp.secure }
  return { smtpHost: host.toLowerCase().replace(/^imap\./, 'smtp.'), smtpPort: 465, smtpSecure: true }
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
  initError: string
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
    authType?: 'password' | 'oauth-ms'; accessToken?: string
  }): Promise<string | null>
  deleteAccount(id: string): Promise<void>
  openUnified(): Promise<void>
  openAccount(account: MobileAccount): Promise<void>
  openInbox(account: MobileAccount): Promise<void>
  openFolder(account: MobileAccount, folder: string): Promise<void>
  refresh(): Promise<void>
  search(query: string): Promise<void>
  openMessage(m: MobileMessage, opts?: { stay?: boolean }): Promise<void>
  openSource(source: MailSource): Promise<void>
  moveMessage(m: MobileMessage, kind: 'archive' | 'trash'): Promise<{ undo?: () => Promise<void> }>
  moveToFolder(m: MobileMessage, target: string): Promise<{ undo?: () => Promise<void> }>
  fetchBody(m: MobileMessage): Promise<MailBody>
  reloadFolders(accountId: string): Promise<void>
  changeFolder(accountId: string, action: 'create' | 'rename' | 'delete', name: string, target?: string): Promise<void>
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
const clientQueues = new Map<string, Promise<unknown>>()
let fetchSequence = 0
let readingSequence = 0

async function disconnectAll() {
  for (const c of clients.values()) c.disconnect()
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
    pass: account.authType === 'oauth-ms' ? '' : creds.password,
    accessToken: account.authType === 'oauth-ms' ? await validMicrosoftToken(account.id) : undefined
  })
  clients.set(account.id, client)
  return client
}

export function withClient<T>(account: MobileAccount, fn: (c: ImapLite) => Promise<T>, retry = true): Promise<T> {
  const execute = async () => {
    if (useMail.getState().guard !== 'ready') throw new Error('应用已锁定')
    const client = await ensureClient(account)
    try { return await fn(client) }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (retry && /未连接|网络错误|响应超时|连接超时/.test(msg) && useMail.getState().guard === 'ready') {
        if (account.authType === 'oauth-ms') { client.disconnect(); clients.delete(account.id); return fn(await ensureClient(account)) }
        await client.reconnect(); return fn(client)
      }
      throw err
    }
  }
  const next = (clientQueues.get(account.id) ?? Promise.resolve()).then(execute, execute)
  clientQueues.set(account.id, next.catch(() => undefined))
  return next
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
  initError: '',
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
    set({ guard: 'unknown', initError: '' })
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
      set({ guard: 'locked', guardFailsLeft: BURN_AT_FAILS, initError: e instanceof Error ? e.message : String(e) })
    }
  },

  setTab: tab => set({ tab }),

  go: screen => set({ screen }),

  setupMaster: async password => {
    const err = await setupMasterGuard(password)
    if (err) return err
    await get().unlockMaster(password)
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
      id: get().accounts.find(a => a.email === email)?.id ?? 'mob-' + Date.now().toString(36),
      email,
      host: draft.host.trim(),
      port: parseInt(draft.port || '993', 10) || 993,
      secure: draft.secure,
      authType: draft.authType ?? 'password',
      smtpHost: draft.smtpHost?.trim() || '',
      smtpPort: parseInt(draft.smtpPort || '', 10) || 0,
      smtpSecure: draft.smtpSecure ?? true,
      color: colorFor(email)
    })
    if (!acc.smtpHost) Object.assign(acc, guessSmtp(acc.host, email))
    const client = new ImapLite()
    try {
      await client.connect({ host: acc.host, port: acc.port, secure: acc.secure, user: email, pass: draft.authType === 'oauth-ms' ? '' : draft.pass, accessToken: draft.accessToken })
      await client.selectMailbox('INBOX')
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
    try { await clients.get(acc.id)?.logout() } catch { /* new credentials replace old connection */ }
    clients.delete(acc.id)
    const list = [...(await loadAccounts()).filter(a => a.email !== email), acc]
    await persistAccounts(list)
    set({ accounts: list })
    return null
  },

  deleteAccount: async id => {
    try { await clients.get(id)?.logout() } catch { /* ignore */ }
    clients.delete(id)
    await Keychain.resetGenericPassword({ service: 'linkto.imap.' + id })
    await forgetCachedAccount(id)
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
    const sequence = ++readingSequence
    const cached = await readMailCache().catch(() => null)
    if (sequence !== readingSequence || get().guard !== 'ready') return
    set(opts?.stay ? { reading: m, body: cached?.bodies[messageKey(m)] ?? null, bodyLoading: true } : { screen: 'read', reading: m, body: cached?.bodies[messageKey(m)] ?? null, bodyLoading: true })
    try {
      const raw = await withClient(account, c => c.fetchRaw(m.mailbox, m.uid))
      const parsed = parseMime(raw)
      if (sequence !== readingSequence || get().guard !== 'ready') return
      set({ body: { html: parsed.html, text: parsed.text, attachments: parsed.attachments }, bodyLoading: false })
      void saveMailBody(m, { html: parsed.html, text: parsed.text, attachments: parsed.attachments }).catch(() => {})
      void withClient(account, c => c.markSeen(m.mailbox, m.uid)).then(() => {
        set(s => ({
          messages: s.messages.map(x => x.uid === m.uid && x.accountId === m.accountId && x.mailbox === m.mailbox ? { ...x, flags: [...new Set([...x.flags, '\\Seen'])] } : x),
          reading: s.reading && s.reading.uid === m.uid && s.reading.accountId === m.accountId && s.reading.mailbox === m.mailbox
            ? { ...s.reading, flags: [...new Set([...s.reading.flags, '\\Seen'])] }
            : s.reading
        }))
      }).catch(() => {})
    } catch (e) {
      if (sequence !== readingSequence || get().guard !== 'ready') return
      const msg = e instanceof Error ? e.message : String(e)
      if (isMitmMessage(msg)) {
        await burnAll('mitm')
        await burnExtraSecrets()
        await disconnectAll()
        set({ guard: 'burned', burnReason: 'TLS 证书校验失败，检测到中间人，本地数据已焚毁', accounts: [], screen: 'accounts' })
        return
      }
      set({ body: cached?.bodies[messageKey(m)] ?? { html: null, text: '正文加载失败：' + msg, attachments: [] }, bodyLoading: false, statusText: cached?.bodies[messageKey(m)] ? '离线 · 正在显示已缓存的正文' : msg })
    }
  },

  openSource: async source => {
    const account = get().accounts.find(a => a.email.toLowerCase() === source.accountEmail.toLowerCase())
    if (!account) throw new Error('请先添加原邮件所属的邮箱：' + source.accountEmail)
    let message = get().messages.find(m => m.accountId === account.id && source.messageId && m.messageId === source.messageId)
    if (!message && source.messageId) {
      try { const found = await withClient(account, c => c.findMessage(source.mailbox, source.messageId!)); if (found) message = withAccount(found, account, source.mailbox) } catch { /* use cache below */ }
    }
    if (!message) {
      const cache = await readMailCache()
      message = cache.messages.find(m => m.accountId === account.id && (source.messageId ? m.messageId === source.messageId : m.mailbox === source.mailbox && m.uid === source.uid))
    }
    if (!message) throw new Error('原邮件暂不可用；待办中保留了邮件标题和来源，请联网后重试')
    set({ tab: 'mail' })
    await get().openMessage(message)
  },

  fetchBody: async m => {
    const account = get().accounts.find(a => a.id === m.accountId)
    if (!account) throw new Error('原邮箱已移除')
    const raw = await withClient(account, client => client.fetchRaw(m.mailbox, m.uid))
    const parsed = parseMime(raw)
    return { html: parsed.html, text: parsed.text, attachments: parsed.attachments }
  },

  reloadFolders: async accountId => {
    const account = get().accounts.find(a => a.id === accountId)
    if (!account) throw new Error('原邮箱已移除')
    const list = await withClient(account, c => c.listMailboxes())
    if (get().guard !== 'ready') return
    set({ folders: { ...get().folders, [accountId]: list.filter(f => !isSyncFolder(f.name) && !f.flags.some(flag => /^\\noselect$/i.test(flag))) } })
  },

  changeFolder: async (accountId, action, name, target) => {
    const account = get().accounts.find(a => a.id === accountId)
    if (!account) throw new Error('原邮箱已移除')
    if (action === 'create') name = validateMailbox(name)
    if (action === 'rename') target = validateMailbox(target ?? '')
    const delimiter = get().folders[accountId]?.find(f => f.name === name)?.delimiter
    await withClient(account, c => action === 'create' ? c.createMailbox(name) : action === 'rename' ? c.renameMailbox(name, target ?? '') : c.deleteEmptyMailbox(name), false)
    if (get().guard !== 'ready') return
    if (action === 'rename') await useWorkbench.getState().remapMailbox(account.email, name, target!, delimiter || '')
    // Cached UIDs and paths may be invalid after folder changes. Reload from server.
    await forgetCachedAccount(accountId).catch(() => {})
    const scope = get().scope
    if (scope.accountId === accountId && (scope.folder === name || (delimiter && scope.folder.startsWith(name + delimiter)))) {
      await get().openFolder(account, action === 'rename' ? target! + scope.folder.slice(name.length) : 'INBOX')
    }
    await get().reloadFolders(accountId)
  },

  moveMessage: async (m, kind) => {
    const account = get().accounts.find(a => a.id === m.accountId)
    if (!account) throw new Error('请先添加原邮箱')
    const target = await withClient(account, client => client.actionFolder(kind), false)
    return get().moveToFolder(m, target)
  },

  moveToFolder: async (m, target) => {
    const account = get().accounts.find(a => a.id === m.accountId)
    if (!account) throw new Error('请先添加原邮箱')
    const moved = await withClient(account, async client => {
      const uid = await client.moveMessage(m.mailbox, m.uid, target, m.messageId)
      return { target, uid }
    }, false)
    if (get().guard !== 'ready') return {}
    const same = (x: MobileMessage) => messageKey(x) === messageKey(m)
    await useWorkbench.getState().remapMessage(m, target, moved.uid).catch(() => set({ statusText: '邮件已移动，但待办中的来源路径未更新，请刷新后检查' }))
    set(s => ({ messages: s.messages.filter(x => !same(x)), ...(s.reading && same(s.reading) ? { reading: null, body: null, screen: 'inbox' as const } : {}) }))
    const cache = await readMailCache().catch(() => null)
    if (cache) await saveMailList(m.accountId, m.mailbox, cache.messages.filter(x => x.accountId === m.accountId && x.mailbox === m.mailbox && !same(x))).catch(() => {})
    return moved.uid ? { undo: async () => {
      const uid = await withClient(account, client => client.moveMessage(moved.target, moved.uid!, m.mailbox, m.messageId), false)
      await useWorkbench.getState().remapMessage({ ...m, mailbox: moved.target, uid: moved.uid! }, m.mailbox, uid)
      await get().refresh()
    } } : {}
  },

  toggleSeen: async m => {
    const wasSeen = m.flags.includes('\\Seen')
    const patch = (list: MobileMessage[]) =>
      list.map(x => {
        if (x.uid !== m.uid || x.accountId !== m.accountId || x.mailbox !== m.mailbox) return x
        const flags = x.flags.filter(f => f !== '\\Seen')
        return { ...x, flags: wasSeen ? flags : [...flags, '\\Seen'] }
      })
    set(s => ({
      messages: patch(s.messages),
      reading: s.reading && s.reading.uid === m.uid && s.reading.accountId === m.accountId && s.reading.mailbox === m.mailbox ? patch([s.reading])[0] : s.reading
    }))
    const account = get().accounts.find(a => a.id === m.accountId)
    if (!account) return
    try {
      await withClient(account, c => wasSeen ? c.markUnseen(m.mailbox, m.uid) : c.markSeen(m.mailbox, m.uid))
    } catch (error) {
      set(s => ({ messages: s.messages.map(x => x.uid === m.uid && x.accountId === m.accountId && x.mailbox === m.mailbox ? { ...x, flags: m.flags } : x), reading: s.reading && messageKey(s.reading) === messageKey(m) ? { ...s.reading, flags: m.flags } : s.reading, statusText: '标记失败，请稍后重试' }))
      throw error
    }
  },

  stepReading: async dir => {
    const { messages, reading } = get()
    if (!reading || !messages.length) return
    const i = messages.findIndex(m => m.uid === reading.uid && m.accountId === reading.accountId && m.mailbox === reading.mailbox)
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
    fetchSequence++; readingSequence++
    await disconnectAll()
    set({ guard: 'locked', tab: 'mail', screen: 'accounts', messages: [], reading: null, body: null, compose: null, status: 'idle', statusText: '' })
  },

  sendCompose: async () => {
    const { compose, accounts } = get()
    if (!compose) return
    const account = accounts.find(a => a.id === compose.accountId)
    if (!account) { set({ composeError: '没有找到发信账户' }); return }
    const to = compose.to.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
    if (!to.length) { set({ composeError: '请填写收件人' }); return }
    if (!compose.subject.trim() && !compose.body.trim()) { set({ composeError: '主题和正文都是空的' }); return }
    set({ sending: true, composeError: '' })
    const creds = await Keychain.getGenericPassword({ service: 'linkto.imap.' + account.id })
    if (!creds) { set({ sending: false, composeError: '未找到钥匙串凭据' }); return }
    const smtp = new SmtpLite()
    try {
      await smtp.connect({ host: account.smtpHost, port: account.smtpPort, user: account.email, pass: account.authType === 'oauth-ms' ? '' : creds.password, secure: account.smtpSecure, accessToken: account.authType === 'oauth-ms' ? await validMicrosoftToken(account.id) : undefined })
      await smtp.send({
        from: account.email,
        to,
        cc: compose.cc ? compose.cc.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean) : [],
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
    const list = (await withClient(account, c => c.listMailboxes())).filter(f => !isSyncFolder(f.name) && !f.flags.some(flag => /^\\noselect$/i.test(flag)))
    set({ folders: { ...get().folders, [account.id]: list } })
  } catch {
    /* 文件夹加载失败不阻塞收件箱 */
  }
}

async function fetchScope(set: Set, get: Get, scope: MailScope, searching: boolean): Promise<void> {
  const sequence = ++fetchSequence
  const accounts = scope.kind === 'unified'
    ? get().accounts
    : get().accounts.filter(a => a.id === scope.accountId)
  if (!accounts.length) {
    set({ messages: [], status: 'ready', statusText: '' })
    return
  }
  set({ status: 'syncing', statusText: searching ? '搜索中…' : '同步中…' })
  const query = get().searchQuery
  const cached = await readMailCache().catch(() => null)
  if (sequence !== fetchSequence || get().guard !== 'ready') return
  const cachedScope = (cached?.messages ?? []).filter(m => accounts.some(a => a.id === m.accountId) && m.mailbox === scope.folder)
  if (!searching && cachedScope.length) set({ messages: sortMessages(cachedScope) })
  const results = await Promise.allSettled(accounts.map(async a => {
    const list = await withClient(a, c => searching && query
      ? c.searchEnvelopes(scope.kind === 'unified' ? 'INBOX' : scope.folder, query, 40)
      : c.fetchEnvelopes(scope.kind === 'unified' ? 'INBOX' : scope.folder, 40))
    const messages = list.map(m => withAccount(m, a, scope.kind === 'unified' ? 'INBOX' : scope.folder))
    if (!searching && sequence === fetchSequence && get().guard === 'ready') await saveMailList(a.id, scope.folder, messages)
    return messages
  }))
  if (sequence !== fetchSequence || get().guard !== 'ready') return
  const merged: MobileMessage[] = []
  let failed = 0
  let mitm = false
  for (const [index, r] of results.entries()) {
    if (r.status === 'fulfilled') merged.push(...r.value)
    else {
      failed++
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
      if (isMitmMessage(msg)) mitm = true
      merged.push(...cachedScope.filter(m => m.accountId === accounts[index].id && (!searching || `${m.subject} ${m.from}`.toLowerCase().includes(query.toLowerCase()))))
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
    statusText: failed ? String(results.length - failed) + '/' + results.length + ' 个账户已同步 · 其余显示本机缓存' : '刚刚更新'
  })
}
