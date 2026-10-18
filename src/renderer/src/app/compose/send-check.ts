import type { Address } from '@shared/types'
import { isValidEmail } from './recipients'

export type SendIssueKey = 'no-recipient' | 'bad-address' | 'no-subject' | 'missing-attachment' | 'self-in-reply'

export interface SendIssue {
  key: SendIssueKey
  /** block：发不出去，只能返回修改；warn：提醒，可仍要发送 */
  tone: 'block' | 'warn'
  title: string
  detail?: string
}

/** 正文 / 主题里提到附件的说法（中英） */
const ATTACH_HINT = /见附件|附件|附上|附图|附表|随信附|请查收.{0,6}(文件|资料)|attached|attachment|enclosed|see attached/i

export function collectSendIssues(p: {
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  bodyText: string
  attachmentCount: number
  isReply: boolean
  myAddrs: string[]
}): SendIssue[] {
  const issues: SendIssue[] = []
  const all = [...p.to, ...p.cc, ...p.bcc]
  if (!all.length) {
    issues.push({ key: 'no-recipient', tone: 'block', title: '还没有收件人', detail: '至少填一位收件人、抄送或密送。' })
  }
  const bad = all.filter(a => !isValidEmail(a.address))
  if (bad.length) {
    issues.push({
      key: 'bad-address',
      tone: 'block',
      title: bad.length === 1 ? '有个地址格式不对' : `有 ${bad.length} 个地址格式不对`,
      detail: bad.map(a => a.address).join('、')
    })
  }
  if (!p.subject.trim()) {
    issues.push({ key: 'no-subject', tone: 'warn', title: '主题是空的', detail: '没有主题的邮件容易被忽略或误判为垃圾邮件。' })
  }
  if (!p.attachmentCount && ATTACH_HINT.test(`${p.subject}\n${p.bodyText}`)) {
    const m = `${p.subject}\n${p.bodyText}`.match(ATTACH_HINT)
    issues.push({ key: 'missing-attachment', tone: 'warn', title: '提到了附件，但还没添加', detail: m ? `检测到「${m[0]}」` : undefined })
  }
  if (p.isReply) {
    const mine = new Set(p.myAddrs.map(a => a.toLowerCase()))
    const self = all.filter(a => mine.has(a.address.toLowerCase()))
    if (self.length) {
      issues.push({ key: 'self-in-reply', tone: 'warn', title: '收件人里包含你自己', detail: self.map(a => a.address).join('、') })
    }
  }
  return issues
}
