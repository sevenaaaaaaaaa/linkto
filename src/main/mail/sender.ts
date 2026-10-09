import nodemailer, { Transporter } from 'nodemailer'
import type { AccountConfig, Address, ComposeDraft } from '@shared/types'

type AddrValue = string | { name?: string; address: string }

function fmtAddr(a: Address): AddrValue {
  return a.name ? { name: a.name, address: a.address } : a.address
}

export interface MailCreds {
  pass?: string
  accessToken?: string
}

/** SMTP 发送（每账户复用 transporter；OAuth 账户 token 过期后自动重建） */
export class MailSender {
  private transporters = new Map<string, { t: Transporter; token?: string }>()

  get(account: AccountConfig, creds: MailCreds): Transporter {
    const cached = this.transporters.get(account.id)
    // OAuth 账户：token 变化（刷新后）需重建 transporter
    if (cached && (!creds.accessToken || cached.token === creds.accessToken)) return cached.t
    let auth: Record<string, unknown>
    if (creds.accessToken) {
      auth = { type: 'OAuth2', user: account.user, accessToken: creds.accessToken }
    } else {
      auth = { user: account.user, pass: creds.pass }
    }
    const t = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth,
      tls: { rejectUnauthorized: false },
      connectionTimeout: 20_000,
      greetingTimeout: 20_000
    })
    this.transporters.set(account.id, { t, token: creds.accessToken })
    return t
  }
  drop(accountId: string) {
    this.transporters.delete(accountId)
  }

  async send(account: AccountConfig, creds: MailCreds, draft: ComposeDraft): Promise<{ messageId?: string }> {
    const t = this.get(account, creds)
    const info = await t.sendMail({
      from: account.name ? { name: account.name, address: account.email } : account.email,
      to: draft.to.map(fmtAddr),
      cc: draft.cc.map(fmtAddr),
      bcc: draft.bcc.map(fmtAddr),
      subject: draft.subject,
      html: draft.html || '<p></p>',
      inReplyTo: draft.inReplyToMessageId,
      references: draft.inReplyToMessageId,
      attachments: draft.attachmentPaths.map(p => ({ path: p }))
    })
    return { messageId: info.messageId }
  }
}