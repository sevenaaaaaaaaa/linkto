import type { AccountConfig, Address, ComposeDraft, SendResult } from '@shared/types'
import type { MailStore } from '../db'
import type { MailSender, MailCreds } from './sender'
import type { SyncEngine } from './sync-engine'

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

function buildSentRaw(account: AccountConfig, draft: ComposeDraft, messageId?: string): string {
  const addr = (a: { name?: string; address: string }) => (a.name ? `${a.name} <${a.address}>` : a.address)
  const date = new Date().toUTCString()
  return [
    `From: ${addr({ name: account.name, address: account.email })}`,
    `To: ${draft.to.map(addr).join(', ')}`,
    draft.cc.length ? `Cc: ${draft.cc.map(addr).join(', ')}` : '',
    `Subject: ${draft.subject}`,
    `Date: ${date}`,
    messageId ? `Message-ID: ${messageId}` : `Message-ID: <${Math.random().toString(36).slice(2)}@linkto.local>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    draft.html || '<p></p>'
  ]
    .filter(Boolean)
    .join('\r\n')
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
    const creds = await this.deps.getCreds(account)
    try {
      const info = await sender.send(account, creds, draft)
      const row = draft.relatedMessageId ? store.getMessageRow(draft.relatedMessageId) : null
      if (row) {
        const flags = new Set(String(row.flags ?? '').split(' ').filter(Boolean))
        flags.add('\\Answered')
        store.updateMessageFlags(row.id, [...flags])
      }
      // 尝试存入已发送
      try {
        const worker = engine.getWorker(account.id)
        if (worker) {
          const sentPath = await worker.specialFolderPath('sent')
          if (sentPath) await worker.appendRaw(sentPath, buildSentRaw(account, draft, info.messageId))
        }
      } catch { /* 存已发送失败不影响发送结果 */ }
      return { ok: true, messageId: info.messageId }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
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
