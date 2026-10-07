import nodemailer, { Transporter } from 'nodemailer'
import type { AccountConfig, Address, ComposeDraft } from '@shared/types'

type AddrValue = string | { name?: string; address: string }

function fmtAddr(a: Address): AddrValue {
  return a.name ? { name: a.name, address: a.address } : a.address
}

/** SMTP 发送（每账户复用 transporter） */
export class MailSender {
  private transporters = new Map<string, Transporter>()

  get(account: AccountConfig, password: string): Transporter {
    let t = this.transporters.get(account.id)
    if (!t) {
      t = nodemailer.createTransport({
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        auth: { user: account.user, pass: password },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 20_000,
        greetingTimeout: 20_000
      })
      this.transporters.set(account.id, t)
    }
    return t
  }

  drop(accountId: string) {
    this.transporters.delete(accountId)
  }

  async send(account: AccountConfig, password: string, draft: ComposeDraft): Promise<{ messageId?: string }> {
    const t = this.get(account, password)
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
