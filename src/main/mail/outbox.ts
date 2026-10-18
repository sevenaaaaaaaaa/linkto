import { advanceTodoOnReply } from '../todo-collect'
import { notifyLocalChange } from '../todo-sync'
import type { AccountConfig, Address, ComposeDraft, SendResult } from '@shared/types'
import type { MailStore } from '../db'
import type { MailSender, MailCreds } from './sender'
import { friendlyError, type SyncEngine } from './sync-engine'

export interface OutboxDraft {
  id: string
  accountId: string
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  sendAt: number
}

export interface OutboxDeps {
  store: MailStore
  sender: MailSender
  engine: SyncEngine
  listAccounts(): AccountConfig[]
  getPassword(accountId: string): string
  /** 发送凭据（OAuth 账户取 access token，密码账户取密钥） */
  getCreds(account: AccountConfig): Promise<MailCreds>
  event(payload: unknown): void
}

/**
 * SMTP 服务器会自动把发出的邮件存入「已发送」的服务商：再 APPEND 会出现两封。
 * Proton Bridge（本机回环地址）同样由 Proton 服务端保存。
 */
function smtpAutoSavesSent(account: AccountConfig): boolean {
  if (['gmail', 'outlook', 'office365', 'hotmail'].includes(account.provider)) return true
  return /^(127\.0\.0\.1|localhost|::1)$/i.test(account.smtp.host)
}

/**
 * 发件队列：立即发送 / 延迟发送（30s 撤销窗口）/ 定时发送共用一条通路。
 * 到期的定时邮件由 10s 轮询发出，失败退避重试（最多 5 次后放弃并移除）。
 */
export class Outbox {
  private timer: ReturnType<typeof setInterval> | null = null
  private attempts = new Map<string, number>()
  private ticking = false

  constructor(private deps: OutboxDeps) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 10_000)
    void this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 立即发送的完整流程（sendMail IPC 与到期定时邮件共用） */
  async sendNow(draft: ComposeDraft): Promise<SendResult> {
    const { store, sender, engine } = this.deps
    const account = this.deps.listAccounts().find(a => a.id === draft.accountId)
    if (!account) return { ok: false, error: '账户不存在' }
    try {
      const creds = await this.deps.getCreds(account)
      const info = await sender.send(account, creds, draft)
      const row = draft.relatedMessageId ? store.getMessageRow(draft.relatedMessageId) : null
      if (row) {
        const flags = new Set(String(row.flags ?? '').split(' ').filter(Boolean))
        flags.add('\\Answered')
        store.updateMessageFlags(row.id, [...flags])
        // 回信即推进：这封邮件上的「回复类」待办自动完成
        if (advanceTodoOnReply(store, row.id)) {
          this.deps.event({ type: 'todos-changed' })
          notifyLocalChange()
        }
      }
      // 尝试存入已发送
      try {
        const worker = engine.getWorker(account.id)
        if (worker && info.raw && !smtpAutoSavesSent(account)) {
          const sentPath = await worker.specialFolderPath('sent')
          if (sentPath) await worker.appendRaw(sentPath, info.raw, info.messageId)
        }
      } catch { /* 存已发送失败不影响发送结果 */ }
      return { ok: true, messageId: info.messageId }
    } catch (err) {
      return { ok: false, error: friendlySendError(err) }
    }
  }

  /** 调度一封定时/延迟邮件（draft 需含 id；sendAt 为时间戳） */
  schedule(draft: ComposeDraft, sendAt: number) {
    this.deps.store.saveDraft({
      id: draft.id,
      accountId: draft.accountId,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      html: draft.html,
      updatedAt: Date.now(),
      sendAt
    })
    this.attempts.delete(draft.id)
    this.deps.event({ type: 'outbox-changed' })
    void this.tick()
  }

  cancel(id: string) {
    this.deps.store.deleteDraft(id)
    this.attempts.delete(id)
    this.deps.event({ type: 'outbox-changed' })
  }

  list(): OutboxDraft[] {
    return this.deps.store.listScheduled()
  }

  private async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      const due = this.deps.store.dueScheduled(Date.now())
      if (!due.length) return
      for (const d of due) {
        const draft: ComposeDraft = {
          id: d.id,
          accountId: d.accountId,
          to: d.to,
          cc: d.cc,
          bcc: d.bcc,
          subject: d.subject,
          html: d.html,
          attachmentPaths: []
        }
        const res = await this.sendNow(draft)
        if (res.ok) {
          this.deps.store.deleteDraft(d.id)
          this.attempts.delete(d.id)
          this.deps.event({ type: 'mail-sent', subject: d.subject, to: d.to.map(a => a.address).join(', ') })
        } else {
          const n = (this.attempts.get(d.id) ?? 0) + 1
          this.attempts.set(d.id, n)
          if (n >= 5) {
            // 放弃：退回草稿（清除 send_at），由用户手动处理
            this.deps.store.saveDraft({
              id: d.id, accountId: d.accountId, to: d.to, cc: d.cc, bcc: d.bcc,
              subject: d.subject, html: d.html, updatedAt: Date.now(), sendAt: null
            })
            this.attempts.delete(d.id)
          } else {
            // 退避 60s * n 后重试
            this.deps.store.saveDraft({
              id: d.id, accountId: d.accountId, to: d.to, cc: d.cc, bcc: d.bcc,
              subject: d.subject, html: d.html, updatedAt: Date.now(), sendAt: Date.now() + 60_000 * n
            })
          }
        }
      }
      this.deps.event({ type: 'outbox-changed' })
    } finally {
      this.ticking = false
    }
  }
}

/** SMTP 发送错误中文化：先看投递类（收件人 / 大小 / 拒收），再复用账户连接错误的归类（登录 / 超时 / 网络 / TLS） */
export function friendlySendError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/[\u4e00-\u9fff]/.test(msg) && !/^[\x00-\x7f]/.test(msg)) return msg
  if (/No recipients|recipient.*(rejected|invalid|unknown)|mailbox unavailable|User unknown|\b55[03]\b/i.test(msg))
    return '收件人地址被服务器拒收：检查地址是否填写正确'
  if (/\b552\b|size|too large|exceeds/i.test(msg)) return '邮件太大被服务器拒收：减少或压缩附件后再试'
  if (/\b554\b|spam|blocked|rejected/i.test(msg)) return '服务器拒收了这封邮件（可能被判为垃圾邮件），稍后再试或联系邮箱服务商'
  const friendly = friendlyError(err)
  return /[\u4e00-\u9fff]/.test(friendly) ? friendly : `发送失败：${friendly}`
}
