import type { MessageCategory } from '@shared/types'

export interface ClassifyInput {
  subject: string
  fromAddress: string
  fromName?: string
  listUnsubscribe?: string | null
  listId?: string | null
  precedence?: string | null
  autoSubmitted?: string | null
  text?: string
}

const NEWSLETTER_FROM = /(newsletter|news@|digest|bulletin|mailer|mailing-list|list-)/i
const NOTIFICATION_FROM =
  /(no-?reply|donotreply|do-?not-?reply|notification[s]?(?!\.)|notify|noreply|alert[s]?@|updates@|announce|service@|support@|account@|billing@|invoice@|receipt)/i
const NOISE_SUBJECT =
  /(促销|优惠|折扣|特惠|钜惠|秒杀|限时|专享|红包|优惠券|清仓|大促|双11|双11|618|广告|推广|免费领|惊喜|福利|降价|sale|deal|promo|discount|offer|% off|limited time|flash sale)/i
const NOISE_FROM = /(promo|marketing|ads?@|广告|营销|bounce|spam)/i
const NOTIFICATION_SUBJECT =
  /(验证码|验证碼|安全|登录|账单|发票|订单|发货|快递|物流|收据|支付|提醒|确认|通知|receipt|invoice|order|shipped|delivery|security|verify|verification|confirm|notification|alert|billing|payment|statement|password|signin|sign-in|updated|expired|reminder)/i

/** 启发式分类：本地运行，零成本、零隐私顾虑；AI 分类可覆盖其结果 */
export function heuristicClassify(msg: ClassifyInput): { category: MessageCategory; isNewsletter: boolean } {
  const from = `${msg.fromAddress} ${msg.fromName ?? ''}`
  const subject = msg.subject ?? ''
  const bulkHeaders = !!msg.listUnsubscribe || !!msg.listId || /bulk/i.test(msg.precedence ?? '')

  if (bulkHeaders || NEWSLETTER_FROM.test(from)) {
    return { category: 'newsletter', isNewsletter: true }
  }

  if (NOISE_SUBJECT.test(subject) || NOISE_FROM.test(from)) {
    return { category: 'noise', isNewsletter: /unsubscribe|退订/i.test(`${subject} ${msg.text?.slice(0, 2000) ?? ''}`) }
  }

  const transactional = NOTIFICATION_FROM.test(from) || NOTIFICATION_SUBJECT.test(subject) || !!msg.autoSubmitted
  if (transactional) {
    return { category: 'notification', isNewsletter: false }
  }

  return { category: 'personal', isNewsletter: false }
}

export function normalizeSubject(s: string): string {
  return (s ?? '')
    .replace(/^\s*((re|fw|fwd|答复|回复|转发)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
