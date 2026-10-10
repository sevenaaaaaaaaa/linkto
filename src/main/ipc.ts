import { BrowserWindow, ipcMain, dialog, shell, app } from 'electron'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BackupService } from './backup'
import type {
  AccountConfig,
  AccountDraft,
  AIChatMessage,
  Attachment,
  ComposeDraft,
  KbItem,
  MessageQuery,
  Rule,
  SendResult,
  Signature,
  ProviderKey,
  OAuthTokens
} from '@shared/types'
import type { LinkToApi } from '@shared/ipc'
import type { MailStore } from './db'
import type { AppStore } from './store'
import { DEFAULT_AI, DEFAULT_GENERAL, DEFAULT_NOTIFICATIONS, type AISettings, type GeneralSettings, type NotificationSettings } from './store'
import type { SyncEngine } from './mail/sync-engine'
import type { MailSender } from './mail/sender'
import type { AIService } from './ai/service'
import { BUILTIN_CONNECTORS } from './connectors/builtin'
import { presetFor, ACCOUNT_COLORS, PROVIDER_PRESETS } from './mail/presets'
import { Outbox } from './mail/outbox'
import { InsightsService } from './ai/insights'
import type { AgentService } from './ai/agent'
import type { OAuthService } from './oauth'
import type { Notifier } from './notify'
import type { AccountWorker } from './mail/sync-engine'

const SEP = '::'
const messageIdOf = (accountId: string, folderPath: string, uid: number) => `${accountId}${SEP}${folderPath}${SEP}${uid}`

export interface AppContext {
  store: MailStore
  appStore: AppStore
  engine: SyncEngine
  sender: MailSender
  ai: AIService
  notifier: Notifier
  outbox: Outbox
  insights: InsightsService
  agent: AgentService
  oauth: OAuthService
  backup: BackupService
  event(win: BrowserWindow, payload: unknown): void
  openCompose(prefill?: Partial<ComposeDraft>): void
  openSettings(tab?: string): void
  statuses: Map<string, { status: 'connected' | 'syncing' | 'error' | 'disabled'; text: string }>
  getPassword(accountId: string): string
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type ApiHandler = (args: any, win: BrowserWindow) => Promise<unknown> | unknown

export function registerIpc(ctx: AppContext) {
  const { store, appStore, engine, sender, ai, outbox, insights, agent, oauth, backup } = ctx

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
      const target = mode === 'trash' ? 'trash' : 'archive'
      if (worker) {
        const targetPath = await worker.specialFolderPath(target)
        if (targetPath) {
          await worker.moveToFolder(row.folder_path, row.uid, targetPath).catch(() => {})
          return
        }
      }
      store.deleteMessageCascade(messageId)
    }
    ctx.event(BrowserWindow.getAllWindows()[0], { type: 'messages-changed' })
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
        greetingTimeout: 15_000
      })
      try {
        await client.connect()
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
      store.deleteAccount(id)
      const valid = store.listAccounts()
      appStore.pruneSecrets(new Set([...valid.map(a => `acct:${a.id}`), ...valid.map(a => `oauth:${a.id}`)]))
    },

    syncAccountNow: async ([id]: [string]) => {
      const current = accountById(id)
      if (current?.enabled) engine.startAccount(current)
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
        greetingTimeout: 15_000
      })
      try {
        await client.connect()
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

    searchMessages: ([q, limit]: [string, number]) => {
      const ids = store.searchIds(q, limit)
      const page = store.getMessages({ scope: 'search', search: q, limit, offset: 0 })
      return page
    },

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
    setGeneralSettings: ([s]: [GeneralSettings]) => appStore.set('general', s),
    getNotificationSettings: () => appStore.get('notifications', DEFAULT_NOTIFICATIONS),
    setNotificationSettings: ([s]: [NotificationSettings]) => appStore.set('notifications', s),
    getAISettings: () => appStore.get('ai', DEFAULT_AI),
    setAISettings: ([s]: [AISettings]) => appStore.set('ai', s),

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
      const s = appStore.get('ai', DEFAULT_AI)
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
      const items = store.listKbItems()
      const q = question.toLowerCase()
      const scored = items
        .map(i => {
          const hay = `${i.title} ${i.content} ${i.tags.join(' ')}`.toLowerCase()
          const terms = q.split(/\s+/).filter(t => t.length > 1)
          let score = 0
          for (const t of terms) if (hay.includes(t)) score += 1
          return { item: i, score }
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
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
      const s = appStore.get('ai', DEFAULT_AI)
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

    setInsightStatus: ([id, status]: [string, string]) => store.setInsightStatus(id, status),

    deleteInsight: ([id]: [string]) => store.deleteInsight(id),

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
        const { system, user } = await agent.chat(question)
        await ai.stream(requestId, [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ], delta => {
          if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta, done: false })
        })
        if (win && !win.isDestroyed()) win.webContents.send('event', { type: 'ai-stream', requestId, delta: '', done: true })
      } catch (err) {
        if (win && !win.isDestroyed())
          win.webContents.send('event', { type: 'ai-stream', requestId, delta: '', done: true, error: err instanceof Error ? err.message : String(err) })
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
    },

    // ================= 连接器 =================

    listConnectorManifests: () => BUILTIN_CONNECTORS.map(c => c.manifest),

    listConnectorInstances: () => store.listConnectorInstances(),

    connectConnector: async ([manifestId, config]: [string, Record<string, string>]) => {
      const manifest = BUILTIN_CONNECTORS.find(c => c.manifest.id === manifestId)
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
      const builtin = BUILTIN_CONNECTORS.find(c => c.manifest.id === instance.manifestId)
      if (!builtin) return { ok: false, error: '未知连接器' }
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
        const result = await builtin.exec(actionId, params, instance.config, payload)
        return { ok: true, result }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

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
}


export type { Attachment }
