import { BrowserWindow, ipcMain, dialog, shell, app } from 'electron'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BackupService } from './backup'
import type { GhostService } from './ghost/service'
import type {
  AccountConfig,
  AccountDraft,
  AIChatMessage,
  Attachment,
  CloudDriveConfig,
  ComposeDraft,
  GhostSendDraft,
  KbItem,
  MessageQuery,
  Rule,
  SendResult,
  Signature,
  ProviderKey,
  OAuthTokens,
  AgentAction,
  RuleAction,
  FolderPref,
  TodoData
} from '@shared/types'
import type { LinkToApi } from '@shared/ipc'
import type { MailStore } from './db'
import type { AppStore } from './store'
import { DEFAULT_AI, DEFAULT_GENERAL, DEFAULT_NOTIFICATIONS, type AISettings, type GeneralSettings, type NotificationSettings } from './store'
import type { SyncEngine } from './mail/sync-engine'
import type { MailSender } from './mail/sender'
import type { AIService } from './ai/service'
import { BUILTIN_CONNECTORS } from './connectors/builtin'
import { installUserConnector, listUserConnectorFiles, loadUserConnectors, removeUserConnector, USER_CONNECTOR_TEMPLATE } from './connectors/user-loader'
import { driveTest, listDrives, removeDrive, saveDrive, syncEmlMirror, uploadAttachment, uploadEml } from './cloud-drive'
import { detectProtonDriveFolders, PROTON_DRIVE_DOWNLOAD_URL } from './cloud-drive/proton'
import { presetFor, ACCOUNT_COLORS, PROVIDER_PRESETS } from './mail/presets'
import { searchTerms, rankByTerms } from './search-terms'
import { todoFromMessage } from './todo-collect'
import { aiReady } from './ai/service'
import { TODO_PLAN } from './ai/prompts'
import { Outbox } from './mail/outbox'
import { InsightsService } from './ai/insights'
import type { AgentService } from './ai/agent'
import type { OAuthService } from './oauth'
import type { McpService } from './mcp/server'
import type { Notifier } from './notify'
import { applyLoginItem } from './native-integration'
import { LocalEngine, type DownloadProgress } from './ai/local-engine'
import type { AccountWorker } from './mail/sync-engine'
import type { UnderstandService } from './ai/understand'
import { DEFAULT_FOLDER_PREF, readFolderPrefs, writeFolderPref } from './mail/folder-prefs'
import { notifyLocalChange as notifySyncChange, isTodoSyncEnabled, type TodoSyncService } from './todo-sync'
import { initTodoIntegrations, notifyLocalChange as notifyIntegrationChange } from './todo-integrations'

/** 待办有本地改动：通知跨设备同步与外部服务同步 */
function notifyLocalChange(id?: string) {
  notifySyncChange(id)
  notifyIntegrationChange()
}

/** 按 LinkToApi 契约约束的处理器类型（参数元组 → 返回值） */
type Api<K extends keyof LinkToApi> = (
  args: Parameters<LinkToApi[K]>,
  win: BrowserWindow
) => Awaited<ReturnType<LinkToApi[K]>> | ReturnType<LinkToApi[K]>

const SEP = '::'
const messageIdOf = (accountId: string, folderPath: string, uid: number) => `${accountId}${SEP}${folderPath}${SEP}${uid}`

export interface AppContext {
  store: MailStore
  appStore: AppStore
  engine: SyncEngine
  sender: MailSender
  ai: AIService
  localEngine: LocalEngine
  notifier: Notifier
  outbox: Outbox
  insights: InsightsService
  agent: AgentService
  understand: UnderstandService
  oauth: OAuthService
  backup: BackupService
  ghost: GhostService
  mcp: McpService
  todoSync: TodoSyncService
  event(win: BrowserWindow, payload: unknown): void
  openCompose(prefill?: Partial<ComposeDraft>): void
  openGhost(): void
  openGhostReader(id: string): void
  openSettings(tab?: string): void
  statuses: Map<string, { status: 'connected' | 'syncing' | 'error' | 'disabled'; text: string }>
  getPassword(accountId: string): string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type ApiHandler = (args: any, win: BrowserWindow) => Promise<unknown> | unknown

export function registerIpc(ctx: AppContext) {
  const { store, appStore, engine, sender, ai, outbox, insights, agent, oauth, backup, notifier, localEngine, ghost } = ctx

  // 待办与日历同步（Apple 提醒事项 / 日历、Google、Microsoft）：启动定时同步
  const todoIntegrations = initTodoIntegrations({
    store,
    appStore,
    oauth,
    emit: payload => ctx.event(null as never, payload),
    onDevice: info => ctx.event(null as never, { type: 'oauth-device', userCode: info.userCode, verificationUri: info.verificationUri })
  })

  // 幽灵信信道焚毁：复用永久删除（服务器 + 本地级联）
  ghost.deleteMails = async (ids: string[]) => {
    for (const id of ids) await moveOrDelete(id, 'perm')
    ctx.event(null as never, { type: 'messages-changed' })
  }

  /** 账户发送凭据：OAuth 账户取 access token，密码账户读密钥 */
  async function credsFor(account: AccountConfig): Promise<{ pass?: string; accessToken?: string }> {
    if (account.authType === 'oauth') return { accessToken: await oauth.validToken(account.id, account.provider) }
    return { pass: ctx.getPassword(account.id) }
  }

  // ---------- 工具 ----------

  function accountById(id: string): AccountConfig | undefined {
    return store.listAccounts().find(a => a.id === id)
  }

  async function withWorker(messageId: string, fn: (worker: AccountWorker, folderPath: string, uid: number) => Promise<void>) {
    const row = store.getMessageRow(messageId)
    if (!row) return
    const worker = engine.getWorker(row.account_id)
    if (worker) await fn(worker, row.folder_path, row.uid)
  }

  async function moveOrDelete(messageId: string, mode: 'trash' | 'archive' | 'perm') {
    const row = store.getMessageRow(messageId)
    if (!row) return
    const worker = engine.getWorker(row.account_id)
    if (mode === 'perm') {
      store.deleteMessageCascade(messageId)
      if (worker) await worker.deletePermanent(row.folder_path, row.uid).catch(() => {})
    } else {
      if (worker) {
        const targetPath = mode === 'trash' ? await worker.specialFolderPath('trash') : await worker.archiveTargetPath()
        if (targetPath) {
          await worker.moveToFolder(row.folder_path, row.uid, targetPath).catch(() => {})
          return
        }
      }
      store.deleteMessageCascade(messageId)
    }
    ctx.event(BrowserWindow.getAllWindows()[0], { type: 'messages-changed' })
  }

  /** 重复规则的下一次时间（保持原时刻） */
  function nextOccurrence(base: number, rep: NonNullable<TodoData['repeat']>): number {
    const d = new Date(base)
    const n = Math.max(1, rep.interval ?? 1)
    if (rep.freq === 'daily') d.setDate(d.getDate() + n)
    else if (rep.freq === 'weekly') d.setDate(d.getDate() + 7 * n)
    else if (rep.freq === 'monthly') d.setMonth(d.getMonth() + n)
    else {
      // 工作日：跳过周六日
      do d.setDate(d.getDate() + 1)
      while (d.getDay() === 0 || d.getDay() === 6)
    }
    // 已经过去很久的（如补完旧任务）：滚动到今天之后
    while (d.getTime() < Date.now() - 864e5) d.setDate(d.getDate() + (rep.freq === 'monthly' ? 30 : rep.freq === 'weekly' ? 7 : 1))
    return d.getTime()
  }

  // ---------- Agent 动作 / 规则动作执行 ----------

  function requireRow(messageId: string | undefined) {
    const row = messageId ? store.getMessageRow(messageId) : null
    if (!row) throw new Error('找不到这封邮件（可能已被移走）')
    return row
  }

  async function runAgentAction(a: AgentAction) {
    switch (a.type) {
      case 'archive':
      case 'trash':
        requireRow(a.messageId)
        await moveOrDelete(a.messageId!, a.type)
        return
      case 'markRead':
      case 'markUnread':
        requireRow(a.messageId)
        await handlers.markRead([[a.messageId!], a.type === 'markRead'] as never, undefined as never)
        return
      case 'flag':
        requireRow(a.messageId)
        await handlers.markFlagged([[a.messageId!], true] as never, undefined as never)
        return
      case 'snooze': {
        requireRow(a.messageId)
        const until = a.until ? Date.parse(a.until.replace(' ', 'T')) : NaN
        if (!Number.isFinite(until) || until <= Date.now()) throw new Error('稍后处理的时间无效')
        store.setSnoozed([a.messageId!], until)
        return
      }
      case 'todo': {
        const title = (a.title ?? '').trim()
        if (!title) throw new Error('待办缺少标题')
        store.insertInsight({
          id: `todo-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'todo',
          messageId: a.messageId && store.getMessageRow(a.messageId) ? a.messageId : null,
          title,
          data: { from: 'Agent' },
          dueAt: a.due ? Date.parse(a.due) || null : null
        })
        notifyLocalChange()
        return
      }
      case 'draftReply': {
        const row = requireRow(a.messageId)
        const html = (a.body ?? '')
          .split(/\n{2,}/)
          .map(p => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`)
          .join('')
        // 只打开撰写窗供用户修改，绝不自动发送
        await ctx.openCompose({
          accountId: row.account_id,
          relatedMessageId: row.id,
          to: row.from_addr ? [row.from_addr] : [],
          subject: row.subject ? `回复：${row.subject}` : '',
          html
        } as never)
        return
      }
      default:
        throw new Error(`不支持的动作：${(a as { type: string }).type}`)
    }
  }

  /** 规则命中后的动作（新邮件到达时由主进程调用；分类类动作已在同步时生效） */
  async function runRuleActions(messageId: string, actions: RuleAction[]) {
    const row = store.getMessageRow(messageId)
    if (!row) return
    // 移动类动作放最后，避免先移走后其他动作找不到邮件
    const isMove = (t: string) => t === 'moveTrash' || t === 'moveFolder' || t === 'archive'
    const ordered = [...actions].sort((x, y) => Number(isMove(x.type)) - Number(isMove(y.type)))
    for (const action of ordered) {
      try {
        switch (action.type) {
          case 'setCategory':
            if (action.value) store.setCategory([messageId], action.value as never)
            break
          case 'markNewsletter':
            store.setNewsletterFlag(messageId, true)
            break
          case 'markRead':
            await handlers.markRead([[messageId], true] as never, undefined as never)
            break
          case 'flag':
            await handlers.markFlagged([[messageId], true] as never, undefined as never)
            break
          case 'unflag':
            await handlers.markFlagged([[messageId], false] as never, undefined as never)
            break
          case 'saveToKb': {
            const full = store.getMessageFull(messageId)
            store.saveKbItem({
              id: randomUUID(),
              kind: 'message',
              title: row.subject || '（无主题）',
              content: (full?.text || row.snippet || '').slice(0, 20_000),
              sourceMessageId: messageId,
              sourceLabel: row.from_name || row.from_addr || null,
              tags: ['规则'],
              createdAt: Date.now()
            })
            break
          }
          case 'runConnector': {
            const [instanceId, actionId] = (action.value ?? '').split(':')
            if (instanceId && actionId) await handlers.runConnectorAction([instanceId, actionId, {}, messageId] as never, undefined as never)
            break
          }
          case 'moveTrash':
            await moveOrDelete(messageId, 'trash')
            break
          case 'moveFolder':
            if (action.value) await handlers.moveToFolder([[messageId], action.value] as never, undefined as never)
            break
          case 'archive':
            await moveOrDelete(messageId, 'archive')
            break
          case 'pin':
            await handlers.pinMessages([[messageId], true] as never, undefined as never)
            break
          case 'snooze': {
            const hours = Math.max(1, Number(action.value) || 3)
            store.setSnoozed([messageId], Date.now() + hours * 3600_000)
            break
          }
          case 'createTodo':
            store.insertInsight({
              id: `todo-rule-${messageId}`.slice(0, 120),
              kind: 'todo',
              messageId,
              title: action.value ? `${action.value}：${row.subject || '邮件'}` : row.subject || '（无主题）',
              data: { from: '规则' },
              dueAt: null
            })
            notifyLocalChange()
            break
          // notify 由主进程通知模块处理
        }
      } catch (err) {
        console.error('[rules]', action.type, err)
      }
    }
    ctx.event(null as never, { type: 'messages-changed' })
  }

  // ---------- AI 任务 ----------

  function msgTextForAI(row: any): string {
    const text = (row.text || '').slice(0, 4000)
    return `发件人：${row.from_name ?? ''} <${row.from_addr ?? ''}>\n主题：${row.subject ?? ''}\n正文：\n${text}`
  }

  function threadTextForAI(messageId: string): string {
    const row = store.getMessageRow(messageId)
    if (!row) return ''
    const thread = store
      .getMessages({ scope: 'folder', folderId: row.folder_id, limit: 500, offset: 0 })
      .items.filter(m => m.threadId === row.thread_id)
      .sort((a, b) => a.date - b.date)
    if (thread.length <= 1) return msgTextForAI(row)
    return thread
      .map((m, i) => `【第${i + 1}封】${msgTextForAI(store.getMessageRow(m.id))}`)
      .join('\n\n———\n\n')
  }

  async function aiChat(messages: AIChatMessage[]): Promise<string> {
    return ai.complete(messages)
  }

  const handlers: Record<string, ApiHandler> = {
    // ================= 账户 =================

    listAccounts: () => {
      const accounts = store.listAccounts()
      const unread = Object.fromEntries(store.unreadCounts().map(u => [u.accountId, u.unread]))
      return accounts.map(a => ({
        ...a,
        status: ctx.statuses.get(a.id)?.status ?? (a.enabled ? 'connected' : 'disabled'),
        statusText: ctx.statuses.get(a.id)?.text ?? '',
        unread: unread[a.id] ?? 0
      }))
    },

    addAccount: async ([draft]: [AccountDraft]) => {
      try {
        const id = randomUUID()
        const account: AccountConfig = {
          id,
          provider: draft.provider,
          name: draft.name || draft.email,
          email: draft.email,
          color: draft.color || ACCOUNT_COLORS[Math.floor(Math.random() * ACCOUNT_COLORS.length)],
          enabled: true,
          signatureId: null,
          imap: draft.imap,
          smtp: draft.smtp,
          user: draft.user || draft.email,
          authType: draft.authType ?? 'password',
          createdAt: Date.now()
        }
        // 先验证再保存（OAuth 账户用 token 实测，密码账户走 IMAP 密码验证）
        if (draft.authType === 'oauth') {
          const tokens = JSON.parse(draft.password) as OAuthTokens
          const verify = (await handlers.verifyAccountOAuth([draft, tokens.accessToken], null as never)) as { ok: boolean; error?: string }
          if (!verify.ok) return verify
          oauth.saveTokens(id, tokens)
        } else {
          const verify = await handlers.verifyAccount([draft], null as never)
          const v = verify as { ok: boolean; error?: string }
          if (!v.ok) return v
          appStore.saveSecret(`acct:${id}`, draft.password)
        }
        store.upsertAccount(account)
        engine.startAccount(account)
        return { ok: true, account }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    verifyAccount: async ([draft]: [AccountDraft]) => {
      const { ImapFlow } = await import('imapflow')
      const client = new ImapFlow({
        host: draft.imap.host,
        port: draft.imap.port,
        secure: draft.imap.secure,
        auth: { user: draft.user || draft.email, pass: draft.password },
        logger: false,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        clientInfo: { name: 'LinkTo', vendor: 'LinkTo', version: app.getVersion() }
      })
      // 短连接兜底：吞掉异步 socket 错误（超时等），避免以 uncaughtException 击穿主进程
      client.on('error', () => {})
      try {
        await client.connect()
        // 163/126 等登录成功但 SELECT 才报 Unsafe Login：验证时一并打开收件箱，避免「验证通过、同步失败」
        await client.mailboxOpen('INBOX', { readOnly: true })
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/auth|login|credentials|invalid/i.test(msg)) return { ok: false, error: '登录失败：请检查用户名与授权码/应用专用密码' }
        if (/timeout|ETIMEDOUT/i.test(msg)) return { ok: false, error: '连接超时：请检查网络、服务器地址与端口' }
        if (/ENOTFOUND/i.test(msg)) return { ok: false, error: '无法解析服务器地址' }
        if (/ECONNREFUSED/i.test(msg)) return { ok: false, error: '连接被拒绝：请检查端口与加密方式' }
        if (/WRONG_VERSION_NUMBER|WRONG_VERSION|tls|ssl|certificate|handshake/i.test(msg))
          return { ok: false, error: 'TLS 加密握手失败：该端口可能不是 SSL/TLS——请把「加密方式」改为 STARTTLS 或无加密后重试' }
        return { ok: false, error: msg.slice(0, 160) }
      } finally {
        try {
          client.close()
        } catch { /* ignore */ }
      }
    },

    updateAccount: async ([id, patch]: [string, Partial<AccountDraft>]) => {
      const current = accountById(id)
      if (!current) return
      const next: AccountConfig = {
        ...current,
        name: patch.name ?? current.name,
        color: patch.color ?? current.color,
        enabled: patch.name != null ? current.enabled : current.enabled,
        imap: patch.imap ?? current.imap,
        smtp: patch.smtp ?? current.smtp,
        user: patch.user ?? current.user
      }
      store.upsertAccount(next)
      if (patch.password) appStore.saveSecret(`acct:${id}`, patch.password)
      sender.drop(id)
      engine.startAccount(next)
    },

    setAccountEnabled: async ([id, enabled]: [string, boolean]) => {
      const current = accountById(id)
      if (!current) return
      store.upsertAccount({ ...current, enabled })
      if (enabled) engine.startAccount(current)
      else engine.stopAccount(id)
    },

    deleteAccount: async ([id]: [string]) => {
      engine.stopAccount(id)
      sender.drop(id)
      appStore.deleteSecret(`acct:${id}`)
      appStore.deleteSecret(`oauth:${id}`)
      todoIntegrations.forgetAccount(id)
      store.deleteAccount(id)
      const valid = store.listAccounts()
      appStore.pruneSecrets(new Set([...valid.map(a => `acct:${a.id}`), ...valid.map(a => `oauth:${a.id}`)]))
    },

    syncAccountNow: async ([id]: [string]) => {
      const current = accountById(id)
      if (!current?.enabled) return
      // 已有 worker：原连接上立即完整同步（不重建连接、不丢 IDLE）；否则启动
      const worker = engine.getWorker(id)
      if (worker) worker.syncNow()
      else engine.startAccount(current)
    },

    // ================= OAuth（Gmail / Outlook 一键授权） =================

    getOAuthClientConfig: () => oauth.clients(),

    setOAuthClientConfig: ([cfg]: [Parameters<typeof oauth.saveClients>[0]]) => oauth.saveClients(cfg),

    /** 用 access token 验证 IMAP 连接（OAuth 添加账户时） */
    verifyAccountOAuth: async ([draft, accessToken]: [AccountDraft, string]) => {
      const { ImapFlow } = await import('imapflow')
      const client = new ImapFlow({
        host: draft.imap.host,
        port: draft.imap.port,
        secure: draft.imap.secure,
        auth: { user: draft.user || draft.email, accessToken },
        logger: false,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        clientInfo: { name: 'LinkTo', vendor: 'LinkTo', version: app.getVersion() }
      })
      // 短连接兜底：同 verifyAccount
      client.on('error', () => {})
      try {
        await client.connect()
        // 163/126 等登录成功但 SELECT 才报 Unsafe Login：验证时一并打开收件箱，避免「验证通过、同步失败」
        await client.mailboxOpen('INBOX', { readOnly: true })
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/auth|login|credentials|invalid/i.test(msg)) return { ok: false, error: 'OAuth 验证失败：token 无效或 scope 不足' }
        if (/timeout|ETIMEDOUT/i.test(msg)) return { ok: false, error: '连接超时：请检查网络' }
        return { ok: false, error: msg.slice(0, 160) }
      } finally {
        try {
          client.close()
        } catch { /* ignore */ }
      }
    },

    /**
     * 一键授权添加账户：Gmail 走回环授权弹窗，Outlook/Hotmail/M365 走设备码授权。
     * 微软流程中通过 'oauth-device' 事件把 userCode 推给 UI 展示。
     * 成功后自动建账户并启动同步，返回 { ok, email, accountId? }。
     */
    oauthAuthorize: async ([provider]: [ProviderKey]) => {
      try {
        let tokens: { accessToken: string; refreshToken?: string; expiresAt: number; email?: string } | undefined
        let email = ''
        if (provider === 'gmail') {
          const res = await oauth.authorizeGoogle()
          if (!res.ok || !res.tokens) return { ok: false, error: res.error }
          tokens = res.tokens
          email = res.email ?? ''
        } else if (provider === 'outlook' || provider === 'hotmail' || provider === 'office365') {
          const res = await oauth.authorizeMicrosoft(info => {
            ctx.event(null as never, { type: 'oauth-device', userCode: info.userCode, verificationUri: info.verificationUri })
          })
          if (!res.ok || !res.tokens) return { ok: false, error: res.error }
          tokens = res.tokens
          email = res.email ?? ''
        } else {
          return { ok: false, error: '该服务商不支持 OAuth，请使用授权码/应用专用密码添加' }
        }
        if (!email) return { ok: false, error: '授权成功但未能获取邮箱地址' }

        // 同邮箱重新授权：更新已有账户的 token 并重启同步
        const existing = store.listAccounts().find(a => a.provider === provider && a.email.toLowerCase() === email.toLowerCase())
        if (existing && tokens) {
          oauth.saveTokens(existing.id, tokens)
          sender.drop(existing.id)
          engine.startAccount({ ...existing, authType: 'oauth' })
          return { ok: true, email, accountId: existing.id, reauthorized: true }
        }

        const preset = PROVIDER_PRESETS.find(p => p.key === provider)!
        if (!preset.imap || !preset.smtp) return { ok: false, error: '预设缺少服务器配置' }
        const draft: AccountDraft = {
          provider,
          name: `${preset.label}`,
          email,
          color: preset.color,
          imap: preset.imap,
          smtp: preset.smtp,
          user: email,
          password: JSON.stringify(tokens),
          authType: 'oauth'
        }
        // addAccount 内部会用 token 实测 IMAP 并保存 tokens，无需重复验证
        const added = (await handlers.addAccount([draft], null as never)) as { ok: boolean; error?: string; account?: AccountConfig }
        if (!added.ok) return { ok: false, error: added.error ?? '添加账户失败' }
        return { ok: true, email, accountId: added.account?.id }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    // ================= 备份与恢复 =================

    listBackupTargets: () => backup.listTargets(),

    createBackup: ([targetId, passphrase, includeSecrets]: [string, string, boolean]) =>
      backup.exportTo(targetId, passphrase, includeSecrets),

    restoreBackupPick: () => backup.pickForRestore(),

    restoreBackupApply: ([path, passphrase]: [string, string]) => backup.restoreApply(path, passphrase),

    // ================= 幽灵信（端到端加密 · 阅后即焚） =================

    ghostIdentity: () => ghost.identity(),

    ghostList: () => ghost.list(),

    ghostReceiveScan: async () => ghost.receiveScan(),

    ghostSend: async ([draft]: [GhostSendDraft]) => ghost.send(draft),

    ghostOpen: ([id, password]: [string, string]) => ghost.openItem(id, password),

    ghostBurn: ([id]: [string]) => ghost.burn(id),

    ghostRelayUrl: () => ghost.relayUrl(),

    ghostRelaySetUrl: ([url]: [string]) => {
      ghost.setRelayUrl(url)
    },

    openGhost: () => ctx.openGhost(),

    openGhostReader: ([id]: [string]) => ctx.openGhostReader(id),

    // ================= 文件夹 / 邮件 =================

    listFolders: () => store.listFolders(),

    getMessages: ([query]: [MessageQuery]) => store.getMessages(query),

    getMessage: async ([id]: [string]) => {
      let full = store.getMessageFull(id)
      if (!full) return null
      if (!full.text && !full.html) {
        const row = store.getMessageRow(id)
        const worker = engine.getWorker(row.account_id)
        if (worker) {
          // 快路径：本地 eml 镜像直接解析（离线可用、零网络）
          const local = await worker.hydrateFromLocalEml(row.folder_path, row.uid).catch(() => false)
          if (!local) {
            try {
              await worker.downloadBody(row.folder_path, row.uid)
            } catch (err) {
              // 失败原因广播给 UI（Reader 显示可重试提示），不再静默
              ctx.event(null as never, {
                type: 'body-download-error',
                messageId: id,
                error: err instanceof Error ? err.message : String(err)
              })
            }
          }
          full = store.getMessageFull(id)
        }
      }
      return full
    },

    markRead: async ([ids, read]: [string[], boolean]) => {
      for (const id of ids) {
        const row = store.getMessageRow(id)
        if (!row) continue
        const flags = new Set(String(row.flags ?? '').split(' ').filter(Boolean))
        if (read) flags.add('\\Seen')
        else flags.delete('\\Seen')
        store.updateMessageFlags(id, [...flags])
        void withWorker(id, (w, fp, uid) =>
          w.setFlags(fp, uid, read ? ['\\Seen'] : [], read ? [] : ['\\Seen'])
        )
      }
    },

    markFlagged: async ([ids, flagged]: [string[], boolean]) => {
      for (const id of ids) {
        const row = store.getMessageRow(id)
        if (!row) continue
        const flags = new Set(String(row.flags ?? '').split(' ').filter(Boolean))
        if (flagged) flags.add('\\Flagged')
        else flags.delete('\\Flagged')
        store.updateMessageFlags(id, [...flags])
        void withWorker(id, (w, fp, uid) =>
          w.setFlags(fp, uid, flagged ? ['\\Flagged'] : [], flagged ? [] : ['\\Flagged'])
        )
      }
    },

    markAnswered: async ([id]: [string]) => {
      const row = store.getMessageRow(id)
      if (!row) return
      const flags = new Set(String(row.flags ?? '').split(' ').filter(Boolean))
      flags.add('\\Answered')
      store.updateMessageFlags(id, [...flags])
      void withWorker(id, (w, fp, uid) => w.setFlags(fp, uid, ['\\Answered'], []))
    },

    moveMessages: async ([ids, target]: [string[], 'trash' | 'archive']) => {
      for (const id of ids) await moveOrDelete(id, target)
    },

    moveToFolder: async ([ids, folderId]: [string[], string]) => {
      const folder = store.listFolders().find(f => f.id === folderId)
      if (!folder) return { ok: 0, failed: ids.length }
      let ok = 0
      let failed = 0
      for (const id of ids) {
        const row = store.getMessageRow(id)
        if (!row) { failed++; continue }
        if (row.account_id !== folder.accountId) { failed++; continue }
        const worker = engine.getWorker(row.account_id)
        if (!worker) { failed++; continue }
        try {
          await worker.moveToFolder(row.folder_path, row.uid, folder.path)
          ok++
        } catch { failed++ }
      }
      ctx.event(null as never, { type: 'messages-changed' })
      return { ok, failed }
    },

    deleteMessages: async ([ids]: [string[]]) => {
      const s: GeneralSettings = appStore.get('general', DEFAULT_GENERAL)
      for (const id of ids) await moveOrDelete(id, s.deleteBehavior === 'perm' ? 'perm' : 'trash')
    },

    // 契约是 MessageSummary[]（命令面板「邮件直达」）；此前返回整页对象导致面板渲染崩溃
    searchMessages: ([q, limit]: [string, number]) => store.getMessages({ scope: 'search', search: q, limit, offset: 0 }).items,

    getAttachment: ([id]: [string]) => {
      const a = store.getAttachment(id)
      if (!a) return null
      try {
        const data = readFileSync(a.path)
        return { filename: a.filename, contentType: a.contentType, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }
      } catch {
        return null
      }
    },

    getInlineImage: ([id]: [string]) => {
      const a = store.getAttachment(id)
      if (!a) return null
      try {
        const data = readFileSync(a.path)
        return { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }
      } catch {
        return null
      }
    },

    saveAttachment: async ([id]: [string]) => {
      const a = store.getAttachment(id)
      if (!a) return { ok: false }
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const res = await dialog.showSaveDialog(win, { defaultPath: a.filename })
      if (res.canceled || !res.filePath) return { ok: false }
      try {
        const { copyFileSync } = await import('node:fs')
        copyFileSync(a.path, res.filePath)
        return { ok: true, path: res.filePath }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    },

    // ================= 撰写 / 发送 =================

    sendMail: async ([draft]: [ComposeDraft]) => outbox.sendNow(draft),

    scheduleSend: ([draft, sendAt]: [ComposeDraft, number]) => {
      if (!draft.accountId) return { ok: false, error: '账户不存在' }
      if (!Number.isFinite(sendAt) || sendAt < Date.now() - 30_000) return { ok: false, error: '发送时间无效' }
      outbox.schedule(draft, sendAt)
      return { ok: true }
    },

    cancelScheduledSend: ([id]: [string]) => outbox.cancel(id),

    listScheduledSends: () =>
      outbox.list().map(d => ({
        id: d.id,
        accountId: d.accountId,
        to: d.to.map(a => a.address),
        subject: d.subject,
        sendAt: d.sendAt,
        createdAt: d.sendAt
      })),

    saveDraft: ([draft]: [ComposeDraft]) => {
      store.saveDraft({
        id: draft.id,
        accountId: draft.accountId,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        html: draft.html,
        updatedAt: Date.now()
      })
    },

    listDrafts: () => store.listDrafts(),

    deleteDraft: ([id]: [string]) => store.deleteDraft(id),

    pickFiles: async () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
      return res.filePaths.map(p => {
        const stat = (() => {
          try {
            return require('node:fs').statSync(p)
          } catch {
            return { size: 0 }
          }
        })()
        return { path: p, name: basename(p), size: stat.size ?? 0 }
      })
    },

    openExternal: ([url]: [string]) => {
      if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url)
    },

    // ================= 设置 =================

    getGeneralSettings: () => appStore.get('general', DEFAULT_GENERAL),
    setGeneralSettings: ([s]: [GeneralSettings]) => {
      appStore.set('general', s)
      // 开机自启跟随设置即时生效
      applyLoginItem(s.launchAtLogin)
    },
    getNotificationSettings: () => appStore.get('notifications', DEFAULT_NOTIFICATIONS),
    setNotificationSettings: ([s]: [NotificationSettings]) => appStore.set('notifications', s),
    notifyTest: async () => (await notifier.test()).ok,
    /** 测试通知并回传投递结果（系统通知失败原因 / 是否走了 AppleScript 兜底） */
    notifyTestResult: () => notifier.test(),
    getAISettings: () => appStore.getAI(),
    setAISettings: ([s]: [AISettings]) => appStore.setAI(s),
    // ---- 内置本地引擎 ----
    aiLocalStatus: () => localEngine.localStatus(),
    aiLocalDownload: async ([modelId]: [string]) => {
      const onProgress = (p: DownloadProgress) => ctx.event(null as never, { type: 'ai-local-download', ...p })
      const res = await localEngine.download(modelId, onProgress)
      return res
    },
    aiLocalCancelDownload: () => {
      localEngine.cancelDownload()
      return true
    },
    aiLocalRemove: ([modelId]: [string]) => localEngine.removeModel(modelId),
    /** 探测本机推理服务（Ollama / LM Studio / llama.cpp），返回首个在线端点与模型列表 */
    aiProbeLocal: async () => {
      const candidates = [
        { baseURL: 'http://localhost:11434/v1', provider: 'Ollama', native: 'http://localhost:11434/api/tags' },
        { baseURL: 'http://127.0.0.1:11434/v1', provider: 'Ollama', native: 'http://127.0.0.1:11434/api/tags' },
        { baseURL: 'http://localhost:1234/v1', provider: 'LM Studio', native: '' },
        { baseURL: 'http://127.0.0.1:8080/v1', provider: 'llama.cpp', native: '' }
      ]
      const fetchModels = async (url: string): Promise<string[]> => {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(1200) })
          if (!res.ok) return []
          const j = (await res.json()) as { models?: { name?: string; model?: string }[]; data?: { id?: string }[] }
          if (Array.isArray(j.models)) return j.models.map(m => m.model ?? m.name ?? '').filter(Boolean)
          if (Array.isArray(j.data)) return j.data.map(m => m.id ?? '').filter(Boolean)
          return []
        } catch {
          return []
        }
      }
      for (const c of candidates) {
        const models = await fetchModels(c.native || `${c.baseURL}/models`)
        if (models.length) return { found: true, baseURL: c.baseURL, provider: c.provider, models }
      }
      return { found: false, baseURL: '', provider: '', models: [] }
    },
    /** 按当前 baseURL 拉取模型列表（OpenAI 兼容 /models，失败回退 Ollama 原生 /api/tags） */
    aiListModels: async () => {
      const s = appStore.getAI()
      const base = s.baseURL.replace(/\/+$/, '')
      const tryFetch = async (url: string, native: boolean): Promise<string[]> => {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
          if (!res.ok) return []
          const j = (await res.json()) as { models?: { name?: string; model?: string }[]; data?: { id?: string }[] }
          if (native && Array.isArray(j.models)) return j.models.map(m => m.model ?? m.name ?? '').filter(Boolean)
          if (Array.isArray(j.data)) return j.data.map(m => m.id ?? '').filter(Boolean)
          return []
        } catch {
          return []
        }
      }
      let models = await tryFetch(`${base}/models`, false)
      if (!models.length) models = await tryFetch(`${base.replace(/\/v1$/, '')}/api/tags`, true)
      return { models, error: models.length ? undefined : '未拉取到模型（服务未在线或端点不支持）' }
    },

    // ================= 签名 / 模板 / 规则 =================

    listSignatures: () => store.listSignatures(),
    saveSignature: ([s]: [Signature]) => store.saveSignature(s),
    deleteSignature: ([id]: [string]) => store.deleteSignature(id),

    listTemplates: () => store.listTemplates(),
    saveTemplate: ([t]: [import('@shared/types').MailTemplate]) => store.saveTemplate(t),
    deleteTemplate: ([id]: [string]) => store.deleteTemplate(id),

    listRules: () => store.listRules(),
    saveRule: ([r]: [Rule]) => {
      store.saveRule(r)
      engine.applyRulesAll(store.listRules())
    },
    deleteRule: ([id]: [string]) => {
      store.deleteRule(id)
      engine.applyRulesAll(store.listRules())
    },
    reorderRules: ([ids]: [string[]]) => {
      ids.forEach((id, i) => {
        const rule = store.listRules().find(r => r.id === id)
        if (rule) store.saveRule({ ...rule, order: i })
      })
      engine.applyRulesAll(store.listRules())
    },

    // ================= AI =================

    aiStream: async ([requestId, messages]: [string, { role: string; content: string }[]]) => {
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
      try {
        await ai.stream(requestId, messages as AIChatMessage[], delta => {
          if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta, done: false })
        })
        if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta: '', done: true })
      } catch (err) {
        if (win && !win.isDestroyed())
          win.webContents.send('event', {
            type: 'ai-stream',
            requestId,
            delta: '',
            done: true,
            error: err instanceof Error ? err.message : String(err)
          })
      }
    },

    aiCancel: ([requestId]: [string]) => ai.cancel(requestId),

    aiClassify: async ([messageIds]: [string[]]) => {
      const s = appStore.getAI()
      if (!s.enabled) return
      const rows = messageIds.map(id => ({ id, row: store.getMessageRow(id) })).filter(r => r.row)
      if (!rows.length) return
      const list = rows
        .map((r, i) => `${i + 1}. [${r.id}] 发件人:${r.row.from_addr ?? ''} | 主题:${r.row.subject ?? ''} | 摘要:${(r.row.snippet ?? '').slice(0, 80)}`)
        .join('\n')
      const answer = await aiChat([
        {
          role: 'system',
          content:
            '你是邮件分类助手。把每封邮件分为：personal（真人写给你的私人/工作邮件）、notification（系统通知：验证码、账单、物流等事务性邮件）、newsletter（新闻订阅/营销内容）、noise（垃圾/促销噪声）。只输出 JSON 数组，格式：[{"i":序号,"c":"类别"}]，不要其他文字。'
        },
        { role: 'user', content: list }
      ])
      const match = answer.match(/\[[\s\S]*\]/)
      if (!match) return
      try {
        const parsed = JSON.parse(match[0]) as { i: number; c: string }[]
        for (const p of parsed) {
          const target = rows[p.i - 1]
          if (target && ['personal', 'notification', 'newsletter', 'noise'].includes(p.c)) {
            store.setCategory([target.id], p.c as never)
            if (p.c === 'newsletter') store.setNewsletterFlag(target.id, true)
          }
        }
      } catch { /* 忽略解析失败 */ }
    },

    aiSummarize: async ([messageId, requestId]: [string, string]) => {
      const text = threadTextForAI(messageId)
      store.setAiSummarized(messageId)
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
      try {
        await ai.stream(requestId, [
          { role: 'system', content: '你是邮件摘要助手。用简体中文输出要点式摘要：先一句话结论，再列出 2-4 个要点（如有行动项请标注）。控制在 150 字内。直接输出内容，不要开头客套。' },
          { role: 'user', content: text }
        ], delta => {
          if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta, done: false })
        })
        if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta: '', done: true })
      } catch (err) {
        if (win && !win.isDestroyed())
          win.webContents.send('event', { type: 'ai-stream', requestId, delta: '', done: true, error: err instanceof Error ? err.message : String(err) })
      }
    },

    aiDraftReply: async ([messageId, tone, requestId]: [string, string, string]) => {
      const text = threadTextForAI(messageId)
      const row = store.getMessageRow(messageId)
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
      try {
        const mem = agent.memoryPrompt(`${row?.subject ?? ''} ${row?.from_addr ?? ''}`)
        await ai.stream(requestId, [
          {
            role: 'system',
            content: `你是邮件回复助手。根据下面的邮件内容，用简体中文起草一封${tone}的回复。直接输出 HTML 格式的邮件正文（可用 <p>、<ul><li>、<b>），不要包含称呼抬头和落款签名，不要输出代码块标记。${mem.block}`
          },
          { role: 'user', content: `${text}\n\n（收件人是：${row?.from_addr ?? ''}）` }
        ], delta => {
          if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta, done: false })
        })
        if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta: '', done: true })
      } catch (err) {
        if (win && !win.isDestroyed())
          win.webContents.send('event', { type: 'ai-stream', requestId, delta: '', done: true, error: err instanceof Error ? err.message : String(err) })
      }
    },

    aiExtractTasks: async ([messageId, requestId]: [string, string]) => {
      const text = msgTextForAI(store.getMessageRow(messageId))
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
      try {
        await ai.stream(requestId, [
          { role: 'system', content: '从邮件中提取待办事项（行动项、截止时间、责任人）。用简体中文 markdown 无序列表输出，每项一行。没有待办则输出「未发现待办事项」。' },
          { role: 'user', content: text }
        ], delta => {
          if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta, done: false })
        })
        if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta: '', done: true })
      } catch (err) {
        if (win && !win.isDestroyed())
          win.webContents.send('event', { type: 'ai-stream', requestId, delta: '', done: true, error: err instanceof Error ? err.message : String(err) })
      }
    },

    aiAskKnowledgeBase: async ([question, requestId]: [string, string]) => {
      const scored = rankByTerms(store.listKbItems(), searchTerms(question), i => ({ title: i.title, body: `${i.content} ${i.tags.join(' ')}` }))
        .slice(0, 8)
      const context = scored.length
        ? scored.map((s, i) => `[${i + 1}] ${s.item.title}\n${s.item.content.slice(0, 1500)}`).join('\n\n———\n\n')
        : '（知识库中没有找到相关内容）'
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
      try {
        const mem = agent.memoryPrompt(question)
        await ai.stream(requestId, [
          {
            role: 'system',
            content:
              '你是知识库问答助手。仅根据提供的知识库内容回答问题，用简体中文。引用来源时标注 [编号]。如果知识库中没有相关内容，明确说明。' + mem.block
          },
          { role: 'user', content: `知识库内容：\n${context}\n\n问题：${question}` }
        ], delta => {
          if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta, done: false })
        })
        if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta: '', done: true })
      } catch (err) {
        if (win && !win.isDestroyed())
          win.webContents.send('event', { type: 'ai-stream', requestId, delta: '', done: true, error: err instanceof Error ? err.message : String(err) })
      }
    },

    aiTagKbItem: async ([kbItemId]: [string]) => {
      const item = store.listKbItems().find(i => i.id === kbItemId)
      if (!item) return
      const s = appStore.getAI()
      if (!s.enabled) return
      try {
        const answer = await aiChat([
          { role: 'system', content: '为以下内容生成 3-5 个简短标签（简体中文，每个 2-6 字）。只输出 JSON 数组，如 ["产品","复盘"]。' },
          { role: 'user', content: `${item.title}\n${item.content.slice(0, 2000)}` }
        ])
        const m = answer.match(/\[[\s\S]*?\]/)
        if (m) {
          const tags = JSON.parse(m[0]) as string[]
          if (Array.isArray(tags)) store.updateKbItem(kbItemId, { tags: tags.slice(0, 5).map(String) })
        }
      } catch { /* ignore */ }
    },

    // ================= 知识库 =================

    saveToKb: ([input]: [{ messageId?: string; kind: KbItem['kind']; title: string; content: string; tags?: string[] }]) => {
      let sourceLabel: string | null = null
      if (input.messageId) {
        const row = store.getMessageRow(input.messageId)
        if (row) {
          sourceLabel = `${row.from_addr ?? ''} · ${row.subject ?? ''}`
          store.setSavedKb(input.messageId, true)
        }
      }
      const item: KbItem = {
        id: randomUUID(),
        kind: input.kind,
        title: input.title || '（无标题）',
        content: input.content,
        sourceMessageId: input.messageId ?? null,
        sourceLabel,
        tags: input.tags ?? [],
        createdAt: Date.now()
      }
      store.saveKbItem(item)
      return item
    },

    listKbItems: () => store.listKbItems(),
    deleteKbItem: ([id]: [string]) => store.deleteKbItem(id),
    updateKbItem: ([id, patch]: [string, Partial<Pick<KbItem, 'title' | 'content' | 'tags'>>]) => store.updateKbItem(id, patch),

    // ================= 智能洞察 =================

    insightExtract: ([messageId]: [string]) => insights.extractFromMessage(messageId),

    generateDaily: ([force]: [boolean | undefined]) => insights.generateDaily(!!force),

    companyInsight: ([domain]: [string]) => insights.companyProfile(domain),

    listCompanyDomains: () => store.listCompanyDomains().slice(0, 24),

    listInsights: ([kind]: [string]) => store.listInsights(kind),

    setInsightStatus: ([id, status]: [string, string]) => {
      // 待办走 updateInsight 刷新 updatedAt：跨设备同步与外部同步都按它判断本地改动
      if (store.getInsight(id)?.kind === 'todo') {
        store.updateInsight(id, { status })
        notifyLocalChange(id)
      } else store.setInsightStatus(id, status)
    },

    deleteInsight: ([id]: [string]) => {
      todoIntegrations.noteLocalDelete(id)
      // 待办同步开启时删除待办 = 写墓碑（dismissed），硬删会被其他设备的副本同步回来
      if (isTodoSyncEnabled() && store.listTodosForSync().some(t => t.id === id)) {
        store.updateInsight(id, { status: 'dismissed' })
        notifyLocalChange(id)
      } else {
        store.deleteInsight(id)
        notifyLocalChange()
      }
    },

    saveMemo: ([title, content]: [string, string]) => {
      const id = 'memo-today'
      store.insertInsight({
        id,
        kind: 'memo',
        title: title || '备忘录',
        data: { content },
        period: new Date().toISOString().slice(0, 10)
      })
    },

    // ================= 收件箱纪律 =================

    snoozeMessages: ([ids, until]: [string[], number | null]) => {
      store.setSnoozed(ids, until)
      ctx.event(null as never, { type: 'messages-changed' })
    },

    setSenderStatus: ([addr, status, reason]: [string, 'allow' | 'deny' | 'pending', string | undefined]) => {
      store.setSenderStatus(addr, status, reason ?? '')
      ctx.event(null as never, { type: 'messages-changed' })
    },

    screenerPendingCount: () => store.screenerPendingCount(),

    aiScreenSuggest: ([addr]: [string]) => insights.screenSuggest(addr),

    getSplitSignals: () => ({ known: store.getKnownSenders() }),

    listSmartViews: () => store.listSmartViews(),

    saveSmartView: ([id, name, view]: [string, string, Record<string, unknown>]) => store.saveSmartView(id, name, view),

    deleteSmartView: ([id]: [string]) => store.deleteSmartView(id),

    // ================= AI 纪律解法 =================

    aiComposeQuery: ([question]: [string]) => insights.composeQuery(question),

    nlSearch: ([q]: [Record<string, unknown>]) => store.runNLQuery(q as never),

    aiSnoozeSuggest: ([messageId]: [string]) => insights.snoozeSuggest(messageId),

    aiJudgeFollowups: ([ids]: [string[]]) => insights.judgeFollowups(ids),

    aiFollowupDraft: ([messageId]: [string]) => insights.followupDraft(messageId),

    aiScreenBatch: ([addrs]: [string[]]) => insights.screenBatch(addrs),

    // ================= 置顶 / 魔法排序 / 批量提问 =================

    pinMessages: ([ids, pinned]: [string[], boolean]) => store.setPinned(ids, pinned),

    aiRankMessages: ([ids]: [string[]]) => insights.rankMessages(ids),

    aiAskBulk: ([ids, question]: [string[], string]) => insights.askBulk(ids, question, agent.memoryBlock(question)),

    // ================= Agent 记忆（个人 Agent 成长系统） =================

    listMemories: ([scope]: [string | undefined]) => store.listMemories((scope as never) ?? 'all'),

    saveMemory: ([input]: [{ scope: string; title: string; content: string; entity?: string }]) =>
      store.upsertMemory({
        scope: input.scope as never,
        title: input.title,
        content: input.content,
        entity: input.entity ?? '',
        source: 'manual',
        confidence: 1
      }),

    updateMemory: ([id, patch]: [string, { title?: string; content?: string; scope?: string; status?: string }]) =>
      store.updateMemory(id, patch as never),

    deleteMemory: ([id]: [string]) => store.deleteMemory(id),

    memoryStats: () => store.memoryStats(),

    agentLearn: ([messageId]: [string]) => agent.learnFromMessage(messageId),

    agentProfile: ([addr]: [string]) => agent.profile(addr),

    agentChat: async ([question, requestId]: [string, string]) => {
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
      try {
        const { system, user, mailRefs } = await agent.chat(question)
        await ai.stream(requestId, [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ], delta => {
          if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta, done: false })
        })
        // refs：回答里 E1、E2… 对应的邮件 id，渲染进程据此把动作块映射到具体邮件
        if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta: '', done: true, refs: mailRefs })
      } catch (err) {
        if (win && !win.isDestroyed())
          win.webContents.send('event', { type: 'ai-stream', requestId, delta: '', done: true, error: err instanceof Error ? err.message : String(err) })
      }
    },

    agentExecuteActions: async ([actions]: [AgentAction[]]) => {
      let ok = 0
      const failed: { index: number; error: string }[] = []
      for (const [index, a] of (actions ?? []).slice(0, 20).entries()) {
        try {
          await runAgentAction(a)
          ok++
        } catch (err) {
          failed.push({ index, error: err instanceof Error ? err.message : String(err) })
        }
      }
      ctx.event(null as never, { type: 'messages-changed' })
      return { ok, failed }
    },

    aiStatus: () => {
      const s = appStore.getAI()
      if (aiReady(s)) return { ready: true }
      if (!s.enabled) return { ready: false, reason: 'AI 未开启' }
      return { ready: false, reason: '未配置 API Key' }
    },

    createTodo: ([input]: [{ title: string; dueAt?: number | null; data?: Record<string, unknown> }]) => {
      const id = `todo-manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      store.insertInsight({ id, kind: 'todo', title: input.title.slice(0, 200), data: { from: 'manual', updatedAt: Date.now(), ...(input.data ?? {}) }, dueAt: input.dueAt ?? null })
      ctx.event(null as never, { type: 'todos-changed' })
      notifyLocalChange(id)
      return id
    },

    updateTodo: ([id, patch]: [string, { title?: string; dueAt?: number | null; status?: string; data?: Record<string, unknown> }]) => {
      const before = store.listInsights('todo').find(t => t.id === id)
      store.updateInsight(id, patch)
      // 重复任务：完成时按规则生成下一次（复制维度、清空子任务勾选与外部映射）
      const rep = (before?.data as TodoData | undefined)?.repeat
      if (before && rep && before.status === 'open' && patch.status === 'done') {
        const base = before.dueAt ?? Date.now()
        const next = nextOccurrence(base, rep)
        const d = before.data as TodoData
        store.insertInsight({
          id: `todo-rep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          kind: 'todo',
          accountId: before.accountId,
          messageId: before.messageId,
          title: before.title,
          data: {
            ...d,
            checklist: d.checklist?.map(c => ({ ...c, done: false })),
            fixedAt: d.fixedAt ? d.fixedAt + (next - base) : d.fixedAt,
            external: undefined,
            doneAt: undefined,
            doneBy: undefined,
            inbox: false,
            updatedAt: Date.now()
          } as Record<string, unknown>,
          dueAt: next
        })
      }
      ctx.event(null as never, { type: 'todos-changed' })
      notifyLocalChange(id)
    },

    todoFromMessage: ([messageId]: [string]) => {
      const ins = ctx.understand.getInsights([messageId])[messageId]
      const id = todoFromMessage(store, ins, messageId)
      ctx.event(null as never, { type: 'todos-changed' })
      if (id) notifyLocalChange(id)
      return id
    },

    aiPlanTodos: async ([ids]: [string[]]) => {
      if (!aiReady(appStore.getAI())) return { ok: false, error: 'AI 未配置', plans: [] }
      const todos = store.listInsights('todo').filter(t => ids.includes(t.id))
      if (!todos.length) return { ok: true, plans: [] }
      const lines = todos.map(t => {
        const row = t.messageId ? store.getMessageRow(t.messageId) : null
        const due = t.dueAt ? new Date(t.dueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '无'
        return `- id=${t.id} | ${t.title} | 截止：${due}${row ? ` | 来自邮件：${row.from_name || row.from_addr} 《${row.subject}》` : ''}`
      })
      const mem = agent.memoryPrompt(todos.map(t => t.title).join(' '), 6)
      try {
        const answer = await ai.complete([
          { role: 'system', content: TODO_PLAN + (mem.block ? `\n${mem.block}` : '') },
          { role: 'user', content: `现在：${new Date().toLocaleString('zh-CN', { weekday: 'long' })}\n待办：\n${lines.join('\n')}` }
        ])
        const m = answer.match(/\{[\s\S]*\}/)
        const parsed = m ? (JSON.parse(m[0]) as { plans?: { id: string; minutes: number; priority: number; reason: string }[] }) : { plans: [] }
        const plans = (parsed.plans ?? [])
          .filter(p => ids.includes(p.id))
          .map(p => ({
            id: p.id,
            minutes: Math.min(240, Math.max(5, Math.round(Number(p.minutes) / 5) * 5 || 25)),
            priority: ([1, 2, 3].includes(Number(p.priority)) ? Number(p.priority) : 2) as 1 | 2 | 3,
            reason: String(p.reason ?? '').slice(0, 24)
          }))
        for (const p of plans) store.updateInsight(p.id, { data: { minutes: p.minutes, priority: p.priority, aiReason: p.reason } })
        ctx.event(null as never, { type: 'todos-changed' })
        notifyLocalChange()
        return { ok: true, plans }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), plans: [] }
      }
    },

    saveTodoSet: ([title, todos, messageId]: [string, { title: string; due?: string | null }[], string | null | undefined]) => {
      const setId = `set-${Date.now()}`
      todos.forEach(t => {
        store.insertInsight({
          id: `todo-${setId}-${t.title}`.replace(/\s+/g, '_').slice(0, 120),
          kind: 'todo',
          messageId: messageId ?? null,
          title: t.title,
          data: { set: setId, setTitle: title, from: '批量提问' },
          dueAt: t.due ? Date.parse(t.due) || null : null
        })
      })
      notifyLocalChange()
    },

    // ================= 连接器 =================

    listConnectorManifests: () => [...BUILTIN_CONNECTORS.map(c => c.manifest), ...loadUserConnectors(ctx.appStore).map(c => c.manifest)],

    listUserConnectors: () => listUserConnectorFiles(ctx.appStore),

    installUserConnector: async ([jsonText]: [string]) => {
      const res = installUserConnector(ctx.appStore, jsonText)
      if (res.ok) ctx.event(null as never, { type: 'connectors-changed' })
      return res
    },

    removeUserConnector: async ([id]: [string]) => {
      const res = removeUserConnector(ctx.appStore, id)
      if (res.ok) {
        // 顺带清理该连接器的实例配置
        for (const inst of store.listConnectorInstances().filter(i => i.manifestId === id)) {
          store.deleteConnectorInstance(inst.id)
        }
        ctx.event(null as never, { type: 'connectors-changed' })
      }
      return res
    },

    getUserConnectorTemplate: () => USER_CONNECTOR_TEMPLATE,

    listConnectorInstances: () => store.listConnectorInstances(),

    connectConnector: async ([manifestId, config]: [string, Record<string, string>]) => {
      const manifest = [...BUILTIN_CONNECTORS, ...loadUserConnectors(ctx.appStore)].find(c => c.manifest.id === manifestId)
      if (!manifest) return { ok: false, error: '未知连接器' }
      const required = manifest.manifest.settingsFields?.filter(f => f.required) ?? []
      for (const f of required) {
        if (!config[f.key]) return { ok: false, error: `请填写 ${f.label}` }
      }
      store.saveConnectorInstance({ id: randomUUID(), manifestId, enabled: true, config })
      return { ok: true }
    },

    disconnectConnector: ([instanceId]: [string]) => store.deleteConnectorInstance(instanceId),

    runConnectorAction: async ([instanceId, actionId, params, messageId]: [string, string, Record<string, string>, string | undefined]) => {
      const instance = store.listConnectorInstances().find(i => i.id === instanceId)
      if (!instance) return { ok: false, error: '连接器未配置' }
      const connector = [...BUILTIN_CONNECTORS, ...loadUserConnectors(ctx.appStore)].find(c => c.manifest.id === instance.manifestId)
      if (!connector) return { ok: false, error: '未知连接器' }
      let payload: unknown = params
      if (messageId) {
        const full = store.getMessageFull(messageId)
        if (full) {
          payload = {
            from: full.from?.address,
            fromName: full.from?.name,
            subject: full.subject,
            text: (full.text ?? '').slice(0, 8000),
            html: full.html,
            date: full.date,
            ...params
          }
        }
      }
      try {
        const result = await connector.exec(actionId, params, instance.config, payload)
        return { ok: true, result }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    // ================= 网盘备份 =================

    listCloudDrives: () => listDrives(ctx.appStore),

    saveCloudDrive: async ([cfg, secret]: [CloudDriveConfig, string]) => {
      // 新建时先生成 id，连接测试用同一 id（否则探针找不到刚保存的网盘）
      const id = cfg.id || randomUUID()
      const res = saveDrive(ctx.appStore, { ...cfg, id }, secret)
      if (res.ok) {
        // 保存成功即自动测一次连接，把结果透出给 UI
        const probe = await driveTest(ctx.appStore, id)
        return probe.ok ? { ok: true } : { ok: true, error: `已保存，但连接测试未通过：${probe.error ?? '未知原因'}` }
      }
      return res
    },

    removeCloudDrive: ([id]: [string]) => removeDrive(ctx.appStore, id),

    testCloudDrive: ([id]: [string]) => driveTest(ctx.appStore, id),

    cloudUpload: async ([messageId, driveId, what, attachmentId]: [string, string, 'eml' | 'attachment' | 'attachments', string | undefined]) => {
      const full = ctx.store.getMessageFull(messageId)
      if (!full) return { ok: false, error: '邮件不存在' }
      if (what === 'eml') {
        const p = ctx.appStore.emlPath(full.accountId, full.folderPath, full.uid)
        return uploadEml(ctx.appStore, p, full.subject, full.uid, full.date, driveId)
      }
      if (what === 'attachment') {
        const att = full.attachments.find(a => a.id === attachmentId)
        if (!att) return { ok: false, error: '附件不存在' }
        return uploadAttachment(ctx.appStore, ctx.appStore.attachmentPath(att.id), att.filename, driveId)
      }
      // 全部附件
      const atts = full.attachments.filter(a => !a.inline)
      if (!atts.length) return { ok: false, error: '这封邮件没有附件' }
      let okCount = 0
      let lastErr = ''
      for (const att of atts) {
        const res = await uploadAttachment(ctx.appStore, ctx.appStore.attachmentPath(att.id), att.filename, driveId)
        if (res.ok) okCount++
        else lastErr = res.error ?? '未知错误'
      }
      return okCount ? { ok: true, count: okCount, error: okCount < atts.length ? `${atts.length - okCount} 个失败：${lastErr}` : undefined } : { ok: false, error: lastErr }
    },

    cloudSyncEml: ([driveId]: [string]) => syncEmlMirror(ctx.appStore, driveId),

    pickDirectory: async ([title]: [string | undefined]) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const res = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] })
      return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
    },

    detectProtonDrive: () => ({ folders: detectProtonDriveFolders(), downloadUrl: PROTON_DRIVE_DOWNLOAD_URL }),

    // ================= Newsletter =================

    unsubscribe: ([messageId, method]: [string, 'http' | 'mailto']) => {
      const row = store.getMessageRow(messageId)
      if (!row?.list_unsubscribe) return { ok: false, error: '该邮件没有退订入口' }
      const header = String(row.list_unsubscribe)
      const urls = [...header.matchAll(/<(https?:\/\/[^>]+)>/g)].map(m => m[1])
      const mailtos = [...header.matchAll(/<(mailto:[^>]+)>/g)].map(m => m[1])
      if (method === 'http' && urls.length) {
        void shell.openExternal(urls[0])
        return { ok: true }
      }
      if (method === 'mailto' && mailtos.length) {
        void shell.openExternal(mailtos[0])
        return { ok: true }
      }
      if (urls.length) {
        void shell.openExternal(urls[0])
        return { ok: true }
      }
      if (mailtos.length) {
        void shell.openExternal(mailtos[0])
        return { ok: true }
      }
      return { ok: false, error: '未找到可用的退订方式' }
    },

    setNewsletterSender: ([snd, subscribed]: [string, boolean]) => store.setNewsletterSubscribed(snd, subscribed),
    listNewsletterSenders: () => store.listNewsletterSenders(),

    // ================= 邮件理解 =================

    getMailInsights: (([ids]) => ctx.understand.getInsights(Array.isArray(ids) ? ids : [])) satisfies Api<'getMailInsights'>,

    understandMessage: (([id, force]) => ctx.understand.understand(id, !!force)) satisfies Api<'understandMessage'>,

    todayBrief: (([accountId]) => ctx.understand.todayBrief(accountId ?? null)) satisfies Api<'todayBrief'>,

    getFolderPrefs: (() => {
      const stored = readFolderPrefs(appStore)
      const out: Record<string, FolderPref> = {}
      for (const f of store.listFolders()) out[f.id] = stored[f.id] ?? { ...DEFAULT_FOLDER_PREF }
      return { ...stored, ...out }
    }) satisfies Api<'getFolderPrefs'>,

    setFolderPref: (([folderId, patch]) => {
      if (!folderId) return
      const before = readFolderPrefs(appStore)[folderId] ?? DEFAULT_FOLDER_PREF
      const after = writeFolderPref(appStore, folderId, patch ?? {})
      // 重新开启同步：立即触发一轮完整同步把该文件夹补上
      if (!before.sync && after.sync) {
        const folder = store.listFolders().find(f => f.id === folderId)
        if (folder) engine.getWorker(folder.accountId)?.syncNow()
      }
      ctx.event(null as never, { type: 'folders-changed' })
    }) satisfies Api<'setFolderPref'>,

    suggestMoveTarget: (([messageId]) => ctx.understand.suggestMoveTarget(messageId)) satisfies Api<'suggestMoveTarget'>,

    senderContext: (([messageId]) => ctx.understand.senderContext(messageId)) satisfies Api<'senderContext'>,

    // ================= MCP 服务 =================

    getMcpStatus: () => ctx.mcp.status(),
    setMcpEnabled: ([enabled, port]: [boolean, number | undefined]) => ctx.mcp.setEnabled(!!enabled, port),
    regenerateMcpToken: () => ctx.mcp.regenerateToken(),

    // ================= 待办跨设备同步 =================

    todoSyncStatus: () => ctx.todoSync.status(),
    todoSyncConfigure: ([input]: [{ enabled: boolean; accountId: string | null; passphrase?: string; encrypt?: boolean; deviceName?: string }]) =>
      ctx.todoSync.configure(input),
    todoSyncNow: () => ctx.todoSync.syncNow(),

    // ================= 待办与日历同步 =================

    todoIntegrationsStatus: (() => todoIntegrations.status()) satisfies Api<'todoIntegrationsStatus'>,
    todoIntegrationListTargets: (([provider, accountId]) => todoIntegrations.listTargets(provider, accountId)) satisfies Api<'todoIntegrationListTargets'>,
    todoIntegrationConnect: (([provider, opts]) => todoIntegrations.connect(provider, opts ?? {})) satisfies Api<'todoIntegrationConnect'>,
    todoIntegrationUpdate: (([provider, patch]) => todoIntegrations.update(provider, patch ?? {})) satisfies Api<'todoIntegrationUpdate'>,
    todoIntegrationSyncNow: (([provider]) => todoIntegrations.syncNow(provider ?? null)) satisfies Api<'todoIntegrationSyncNow'>,
    todoIntegrationDisconnect: (([provider]) => todoIntegrations.disconnect(provider)) satisfies Api<'todoIntegrationDisconnect'>,
    calendarBusyBlocks: (([from, to]) => todoIntegrations.busyBlocks(Number(from), Number(to))) satisfies Api<'calendarBusyBlocks'>,

    // ================= 窗口 / 应用 =================

    openSettings: ([tab]: [string | undefined]) => ctx.openSettings(tab),
    openCompose: ([prefill]: [Partial<ComposeDraft> | undefined]) => ctx.openCompose(prefill),

    getVersions: () => ({ app: app.getVersion(), electron: process.versions.electron, node: process.versions.node }),
    quit: () => app.quit()
  }

  for (const [method, handler] of Object.entries(handlers)) {
    ipcMain.handle(`api:${method}`, async (event, ...args) => {
      try {
        return await handler(args, event.sender as unknown as BrowserWindow)
      } catch (err) {
        console.error(`[ipc:${method}]`, err)
        throw err
      }
    })
  }

  // 主进程内部复用的能力（与渲染进程调用走同一实现）
  return {
    runRuleActions,
    archive: (messageId: string) => moveOrDelete(messageId, 'archive'),
    aiClassify: async (messageIds: string[]): Promise<void> => {
      await handlers.aiClassify([messageIds], undefined as never)
    }
  }
}


export type { Attachment }
