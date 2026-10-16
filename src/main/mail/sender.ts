import nodemailer, { Transporter } from 'nodemailer'
import type { AccountConfig, Address, ComposeDraft } from '@shared/types'

type AddrValue = string | { name?: string; address: string }

function fmtAddr(a: Address): AddrValue {
  return a.name ? { name: a.name, address: a.address } : a.address
}

/** 仅生成 RFC822 原文、不发送（keepBcc：已发送副本保留密送人） */
const rawComposer = nodemailer.createTransport({ streamTransport: true, buffer: true, keepBcc: true } as any)

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

  async send(account: AccountConfig, creds: MailCreds, draft: ComposeDraft): Promise<{ messageId?: string; raw?: Buffer }> {
    const t = this.get(account, creds)
    const mail = {
      from: account.name ? { name: account.name, address: account.email } : account.email,
      to: draft.to.map(fmtAddr),
      cc: draft.cc.map(fmtAddr),
      bcc: draft.bcc.map(fmtAddr),
      subject: draft.subject,
      html: draft.html || '<p></p>',
      inReplyTo: draft.inReplyToMessageId,
      references: draft.inReplyToMessageId,
      attachments: draft.attachmentPaths.map(p => ({ path: p }))
    }
    const info = await t.sendMail(mail)
    // 「已发送」副本：用同一份选项 + 同一 Message-ID 重新编码，保证编码/附件/Bcc 与实际发出的一致
    let raw: Buffer | undefined
    try {
      const built = await rawComposer.sendMail({ ...mail, messageId: info.messageId })
      raw = built.message as Buffer
    } catch { /* 生成副本失败只影响存入已发送 */ }
    return { messageId: info.messageId, raw }
  }
}