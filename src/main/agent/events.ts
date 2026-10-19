/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 事件识别 · 触发匹配 · 限额（纯函数、无副作用、无 AI）
 *
 * 一封新邮件 → 命中的事件（AgentEventHit[]，带 confidence 与 reason）：
 * 发票 / 账单、付款到期、出行变更（区别于新预订）、新的出行预订、安全提醒、合同 / 协议、会议邀请、会议纪要 / 会后、快递异常、招聘求职进展。
 * 依据：邮件理解（分区 / 订阅束 / 实体）、发件域名、主题 / 正文关键词、附件名、ics、财务识别结果。
 * 本文件只依赖类型与 shared 常量，便于 esbuild 独立打包做单测；运行时调度见 event-trigger.ts。
 */
import type { AgentEventHit, AgentEventKind, AgentSkill, AgentSkillTrigger } from '../../shared/types'
import { detectLife } from '../life/detect'

export interface EventMailInput {
  messageId: string
  subject: string
  /** 纯文本正文（未下载时为空 / snippet） */
  text: string
  fromAddr: string
  fromName?: string
  /** 附件（文件名 / 类型） */
  attachments?: { filename: string; contentType?: string | null }[]
  /** 有日历邀请（text/calendar 或 .ics） */
  hasIcs?: boolean
  /** 本机账户发出的 */
  fromMe?: boolean
  isNewsletter?: boolean
  /** 邮件理解（启发式或 AI） */
  insight?: { section?: string; bundle?: string | null; gist?: string; entities?: { kind: string; label?: string; value?: string }[]; source?: string } | null
  /** 财务识别结果（detectFinance 的子集） */
  finance?: { kind: string; event?: string; amount?: number | null; currency?: string; dueAt?: number | null; confidence?: number; enterprise?: boolean } | null
  /** 收信时间（算「到期在未来」） */
  date?: number
}

export { EVENT_LABEL, EVENT_WHEN, EVENT_KINDS } from '../../shared/agent-events'

/** 识别结果的展示阈值（低于它不算命中） */
export const SHOW_MIN = 0.45
/** 自动运行技能的阈值 */
export const TRIGGER_MIN = 0.6
/** 介于两者之间：拿不准，AI 可用时值得复核 */
export function uncertain(h: AgentEventHit): boolean {
  return h.confidence >= SHOW_MIN && h.confidence < TRIGGER_MIN
}

// ---------------------------------------------------------------- 关键词

const RE = {
  // 发票 / 账单
  invoiceStrong: /(电子发票|增值税(专用|普通)?发票|数电发票|发票已开具|开具.{0,6}发票|发票(号码|代码|号)|\btax invoice\b|\binvoice\s*(#|no\.?|number)|\binvoice\b.{0,20}\b(attached|is ready|available|due)|your invoice|new invoice|invoice from)/i,
  invoiceWord: /(发票|\binvoice\b|账单|对账单|月结单|\bstatement\b|\bbill\b|收费通知|缴费通知)/i,
  invoiceFile: /(发票|invoice|\.ofd$|fapiao|账单|statement)/i,
  // 付款到期
  dueStrong: /(还款日|最后还款日|最后缴费日|付款截止|缴费截止|到期还款|即将到期.{0,6}(付款|还款|缴费)|请于.{0,24}前.{0,4}(付款|支付|还款|缴费|续费)|payment (is )?due|amount due|due date|is due (on|by|soon)|overdue|past due|已逾期|逾期未(付|还|缴)|滞纳金|autopay (will|scheduled)|将于.{0,12}(扣款|扣费))/i,
  // 出行
  travelNoun: /(航班|机票|登机|值机|航司|flight|\bairline|boarding|火车|列车|车次|高铁|动车|\btrain\b|酒店|入住|\bhotel\b|check-in date|行程|itinerary|\btrip\b|预订|booking|reservation)/i,
  travelStrongNoun: /(航班|机票|登机|flight|\bairline|火车|列车|车次|高铁|动车|\btrain\b|酒店|\bhotel\b|itinerary|行程单)/i,
  travelChange: /(航班(变动|变更|调整|取消|延误)|(变更|调整|更改)(通知|提醒)|延误|延迟起飞|取消(了)?(您|你)?的?(航班|预订|订单|行程)|(预订|订单|行程|航班|车次|列车).{0,6}(已|被)?取消|已取消|停运|停航|改签|退票|时刻(变更|调整)|登机口(变更|更改)|schedule change|flight (change|delay|cancell?ation)|(has been|was|is) (delayed|cancell?ed|rescheduled|changed)|\bdelayed\b|\bcancell?ed\b|cancellation|gate change|rebook(ed|ing)?|new departure time|itinerary change|time change)/i,
  travelBooked: /(预订成功|预定成功|预订已确认|订单已确认|出票成功|已出票|购票成功|电子客票|行程单|入住确认|确认函|booking (is )?confirmed|booking confirmation|reservation (is )?confirmed|your (reservation|booking|trip|flight)|confirmation (number|code|#)|e-?ticket|itinerary receipt|you('re| are) (all set|booked|going))/i,
  // 安全
  securityStrong: /(异常登录|可疑登录|陌生设备|新设备登录|新设备.{0,6}登录|在新(的)?设备上登录|新的登录|登录提醒|登录通知|异地登录|账号(存在)?(风险|异常)|账户(存在)?(风险|异常)|密码(已)?(被)?(重置|修改|更改|变更)|重置(您|你)?的?密码|找回密码|(两步|二次|双重|双因素|多因素)(验证|认证)|安全(提醒|警告|警报|通知)|账号安全|恢复邮箱|备用邮箱.{0,4}(变更|修改)|new sign-?in|new login|sign-?in (attempt|alert|from|on)|unusual (sign-?in|activity|login)|suspicious (activity|sign-?in|login)|someone (tried|signed|has your password)|password (was |has been )?(reset|changed)|reset your password|password reset|two-factor|2-step|\b2fa\b|security (alert|notice|notification)|new device|recovery (email|phone))/i,
  securityWeak: /(验证码|verification code|one-time (code|password)|\botp\b)/i,
  // 合同
  contractWord: /(合同|协议|\bcontract\b|\bagreement\b|\bnda\b|保密协议|框架协议|补充协议|报价单确认|statement of work|\bsow\b|\bmsa\b)/i,
  contractAction: /(待签|待签署|请签署|签署|签字|盖章|用印|已签|已签署|签约|生效|请审阅|审阅|定稿|终稿|please (review and )?sign|signature (requested|required)|ready for signature|sign the|has been signed|completed:|you('ve| have) been sent|review and sign|executed|countersign)/i,
  contractPolicy: /((服务条款|隐私政策|用户协议|隐私协议|使用条款).{0,8}(更新|变更|修订)|(terms of (service|use)|privacy (policy|notice)|user agreement).{0,20}(update|change)|we('re| are) updating our (terms|privacy))/i,
  contractFile: /(合同|协议|contract|agreement|\bnda\b|\bsow\b|\bmsa\b)/i,
  // 会议
  inviteSubject: /^(邀请|会议邀请|更新的邀请|已更新邀请|invitation|updated invitation|meeting invitation|invite)\s*[:：]|(会议邀请|邀请您参加|邀请你参加|诚邀.{0,10}(参加|出席)|you('re| are| have been) invited|has invited you|meeting request|calendar invite)/i,
  inviteReply: /^(已接受|已拒绝|暂定|accepted|declined|tentative|tentatively accepted|回复)\s*[:：]/i,
  meetingLink: /(zoom\.us\/j|teams\.microsoft\.com\/l\/meetup|meet\.google\.com|meeting\.tencent\.com|vc\.feishu\.cn|webex\.com\/meet|入会链接|会议号|meeting id)/i,
  notesSubject: /(会议纪要|会议记录|会议总结|会议小结|会议决议|会后(跟进|总结|纪要|事项)|纪要|\bminutes\b|\brecap\b|follow[- ]?up|meeting notes|meeting summary|summary of (our|the|today'?s) (meeting|call|discussion)|action items|next steps from)/i,
  notesBody: /(会议纪要|会议记录|行动项|待办事项|负责人.{0,8}(完成|截止)|action items?|next steps|owner\s*[:：]|due\s*[:：]|attendees|参会人|与会人)/i,
  notesFile: /(纪要|会议记录|minutes|meeting[-_ ]?notes|recap)/i,
  // 快递
  parcelNoun: /(快递|包裹|物流|运单|快件|派件|派送|配送|驿站|快递柜|丰巢|parcel|package|shipment|delivery|courier|tracking)/i,
  parcelIssue: /(延误|延迟(送达|派送)|退回|退件|拒收|派送失败|投递失败|配送失败|无法(派送|投递|配送|送达)|地址(有误|不详|错误)|联系不上|待取件?|待领取|请(及时)?(取件|领取)|取件码|已到.{0,8}(驿站|快递柜|自提点|代收点)|异常|滞留|丢失|破损|清关(失败|异常)|海关(扣|查验)|delay(ed)?|returned to sender|being returned|failed delivery|delivery (attempt|exception|failed|was unsuccessful)|unable to deliver|could not be delivered|held at|ready for pick-?up|awaiting (pickup|collection)|exception|customs (hold|delay))/i,
  // 求职
  jobStrong: /(面试(邀请|通知|安排|时间|反馈|结果)|笔试|测评邀请|录用(通知|意向)|offer letter|\boffer\b.{0,12}(letter|发放|确认)|入职(通知|邀请)|背景调查|背调|简历(已|被)?(查看|筛选|通过)|投递(成功|反馈)|应聘|感谢(您|你)的?(投递|申请)|interview (invitation|request|schedule|scheduled|confirmation|feedback)|invite you to (an )?interview|phone screen|your application (to|for|has|status)|thank you for (applying|your application|your interest in)|application (received|update|status)|we('d| would) like to (move forward|schedule)|unfortunately.{0,40}(position|candidates|application)|candidate)/i,
  jobWord: /(招聘|求职|职位|岗位|候选人|猎头|\bhr\b|recruit(er|ing|ment)|position|\brole\b|hiring|job)/i,
  jobDigest: /(为你推荐.{0,6}(职位|岗位)|职位推荐|新职位|jobs? (for you|alert|recommendations)|recommended jobs|new jobs)/i
}

/** 电子签平台 / 发票平台 / 出行平台的发件域名（命中即加分） */
const DOMAIN = {
  esign: /(docusign\.(net|com)|adobesign\.com|echosign\.com|hellosign\.com|dropboxsign\.com|pandadoc\.com|esign\.cn|tsign\.cn|fadada\.com|bestsign\.cn|qiyuesuo\.com|signnow\.com)$/i,
  security: /(accounts\.google\.com|account\.microsoft\.com|accountprotection\.microsoft\.com|appleid\.apple\.com|id\.apple\.com|security|noreply\.github\.com|github\.com)$/i,
  travel: /(ctrip\.com|trip\.com|qunar\.com|fliggy\.com|12306\.cn|ceair\.com|csair\.com|airchina\.com|hainanairlines\.com|booking\.com|expedia\.com|airbnb\.com|marriott\.com|hilton\.com|ihg\.com|agoda\.com|united\.com|delta\.com|aa\.com|emirates\.com|cathaypacific\.com|singaporeair\.com)$/i,
  parcel: /(sf-express\.com|sf\.com|jd\.com|cainiao\.com|zto\.com|yto\.net\.cn|sto\.cn|yundaex\.com|ems\.com\.cn|ups\.com|fedex\.com|dhl\.com|usps\.com|royalmail\.com)$/i,
  job: /(linkedin\.com|zhipin\.com|lagou\.com|liepin\.com|51job\.com|zhaopin\.com|greenhouse\.io|lever\.co|workday\.com|myworkday\.com|smartrecruiters\.com|ashbyhq\.com|mokahr\.com)$/i
}

function domainOf(addr: string): string {
  const at = String(addr || '').lastIndexOf('@')
  return at >= 0 ? addr.slice(at + 1).toLowerCase().trim() : ''
}

const clamp = (n: number) => Math.max(0, Math.min(1, Math.round(n * 100) / 100))

/** 命中的关键词原文（reason 里引用，最多 12 字） */
function hit(re: RegExp, hay: string): string | null {
  const m = re.exec(hay)
  return m ? m[0].trim().slice(0, 16) : null
}

// ---------------------------------------------------------------- 识别

/** 一封邮件 → 命中的事件（confidence ≥ SHOW_MIN，按置信度降序；custom 不在这里产生） */
export function detectEvents(input: EventMailInput): AgentEventHit[] {
  if (input.fromMe) return []
  const subject = String(input.subject || '')
  const body = String(input.text || '').slice(0, 6000)
  const head = `${subject}\n${body.slice(0, 1500)}`
  const hay = `${subject}\n${body}`
  const files = (input.attachments ?? []).map(a => String(a.filename || ''))
  const fileHay = files.join('\n')
  const domain = domainOf(input.fromAddr)
  const ins = input.insight ?? null
  const fin = input.finance ?? null
  // 订阅 / 营销：大幅降权（营销邮件里常有「发票」「航班」字样）
  const promo = !!input.isNewsletter || ins?.bundle === 'newsletter'
  const damp = (c: number) => (promo ? c * 0.55 : c)
  const out: AgentEventHit[] = []
  const add = (event: AgentEventKind, confidence: number, reason: string) => {
    const c = clamp(damp(confidence))
    if (c >= SHOW_MIN) out.push({ messageId: input.messageId, event, confidence: c, reason: promo ? `${reason}（订阅类邮件，置信度已调低）` : reason })
  }
  const hasMoney = !!fin?.amount || !!ins?.entities?.some(e => e.kind === 'money')
  const hasDeadline = !!ins?.entities?.some(e => e.kind === 'deadline')

  // ---------- 会议纪要 / 会后（先判，后面会议邀请要排除它） ----------
  let notes = 0
  let notesWhy = ''
  const notesSubj = hit(RE.notesSubject, subject)
  const notesFile = files.find(f => RE.notesFile.test(f))
  if (notesSubj && !RE.inviteSubject.test(subject)) {
    notes = /follow[- ]?up/i.test(notesSubj) && !RE.notesBody.test(body) ? 0.5 : 0.75
    notesWhy = `主题含「${notesSubj}」`
    if (RE.notesBody.test(body)) {
      notes += 0.12
      notesWhy += '，正文有行动项 / 参会人'
    }
  }
  if (notesFile) {
    notes = Math.max(notes, 0.7) + (notes ? 0.1 : 0)
    notesWhy = notesWhy ? `${notesWhy}，附件「${notesFile.slice(0, 24)}」` : `附件「${notesFile.slice(0, 24)}」像会议纪要`
  }
  // 营销 / 账单类的 follow-up 不算
  if (notes && (fin?.amount || RE.invoiceStrong.test(head))) notes -= 0.25
  if (notes) add('meeting-notes', notes, notesWhy)

  // ---------- 会议邀请 ----------
  if (!notes && !RE.inviteReply.test(subject)) {
    const inv = hit(RE.inviteSubject, subject)
    if (input.hasIcs) add('meeting-invite', inv ? 0.95 : 0.85, inv ? `日历邀请（.ics）+ 主题「${inv}」` : '附带日历邀请（.ics）')
    else if (inv) add('meeting-invite', RE.meetingLink.test(hay) || ins?.entities?.some(e => e.kind === 'time') ? 0.8 : 0.62, `主题「${inv}」${RE.meetingLink.test(hay) ? '，带入会链接' : ''}`)
    else if (RE.meetingLink.test(head) && /(会议|meeting|call|sync|讨论|评审|review)/i.test(subject) && ins?.entities?.some(e => e.kind === 'time')) add('meeting-invite', 0.55, '主题像会议，正文有时间与入会链接')
  }

  // ---------- 安全提醒 ----------
  const sec = hit(RE.securityStrong, head)
  if (sec) {
    let c = RE.securityStrong.test(subject) ? 0.82 : 0.62
    if (DOMAIN.security.test(domain)) c += 0.1
    add('security-alert', c, `${RE.securityStrong.test(subject) ? '主题' : '正文'}含「${sec}」${DOMAIN.security.test(domain) ? `，来自 ${domain}` : ''}`)
  } else if (RE.securityWeak.test(subject) && DOMAIN.security.test(domain) && /(登录|sign-?in|login|device|设备)/i.test(body)) {
    add('security-alert', 0.5, `来自 ${domain} 的验证码，正文提到登录 / 设备`)
  }

  // ---------- 出行：变更 vs 新预订 ----------
  const tNoun = hit(RE.travelStrongNoun, head) ?? (DOMAIN.travel.test(domain) ? hit(RE.travelNoun, head) : null)
  if (tNoun) {
    const change = hit(RE.travelChange, subject) ?? hit(RE.travelChange, body.slice(0, 1500))
    const booked = hit(RE.travelBooked, head)
    const fromTravel = DOMAIN.travel.test(domain)
    if (change) {
      let c = RE.travelChange.test(subject) ? 0.8 : 0.6
      if (fromTravel) c += 0.1
      add('flight-change', c, `「${tNoun}」+「${change}」${fromTravel ? `，来自 ${domain}` : ''}`)
    } else if (booked) {
      let c = RE.travelBooked.test(subject) ? 0.78 : 0.6
      if (fromTravel) c += 0.1
      add('travel-booking', c, `「${tNoun}」+「${booked}」${fromTravel ? `，来自 ${domain}` : ''}`)
    }
  }

  // ---------- 发票 / 账单 ----------
  const finInvoice = fin && (fin.kind === 'invoice' || fin.kind === 'bill' || fin.event === 'invoice' || fin.event === 'bill')
  const invStrong = hit(RE.invoiceStrong, head)
  const invWord = hit(RE.invoiceWord, subject)
  const invFile = files.find(f => RE.invoiceFile.test(f))
  if (invStrong || finInvoice || (invWord && (hasMoney || invFile)) || (invFile && hasMoney)) {
    let c = invStrong ? 0.72 : finInvoice ? 0.68 : 0.62
    const why: string[] = []
    if (invStrong) why.push(`含「${invStrong}」`)
    else if (invWord) why.push(`主题含「${invWord}」`)
    if (finInvoice) why.push(`财务识别为${fin!.kind === 'invoice' ? '发票' : '账单'}`)
    if (invFile) {
      c += 0.1
      why.push(`附件「${invFile.slice(0, 24)}」`)
    }
    if (hasMoney) {
      c += 0.08
      why.push('有金额')
    }
    // 出行确认 / 订单通知里的「发票」只是附带一句
    if (out.some(h => h.event === 'travel-booking' || h.event === 'flight-change') && !invFile) c -= 0.2
    add('invoice', c, why.join('，'))
  }

  // ---------- 付款到期 ----------
  const due = hit(RE.dueStrong, head)
  const futureDue = !!fin?.dueAt && fin.dueAt > (input.date ?? 0) - 86_400_000
  if (due || (futureDue && fin && fin.kind !== 'subscription')) {
    let c = due ? (RE.dueStrong.test(subject) ? 0.78 : 0.62) : 0.55
    if (futureDue) c += 0.08
    if (hasMoney) c += 0.06
    if (hasDeadline) c += 0.04
    add('payment-due', c, [due ? `含「${due}」` : '', futureDue ? '财务识别出应付日' : '', hasMoney ? '有金额' : ''].filter(Boolean).join('，'))
  }

  // ---------- 合同 / 协议 ----------
  if (!RE.contractPolicy.test(head)) {
    const cWord = hit(RE.contractWord, head)
    const cAct = hit(RE.contractAction, head)
    const cFile = files.find(f => RE.contractFile.test(f))
    const esign = DOMAIN.esign.test(domain)
    // 会议纪要里顺带提到的「SOW 终稿」之类不算合同（主题没提合同、也没有合同附件时）
    const inNotes = notes > 0 && !RE.contractWord.test(subject) && !cFile
    if (!inNotes && (esign || (cWord && (cAct || cFile)) || (cFile && cAct))) {
      let c = esign ? 0.85 : RE.contractWord.test(subject) ? 0.72 : 0.6
      const why: string[] = []
      if (esign) why.push(`电子签平台 ${domain}`)
      if (cWord) why.push(`含「${cWord}」`)
      if (cAct) why.push(`「${cAct}」`)
      if (cFile) {
        c += 0.08
        why.push(`附件「${cFile.slice(0, 24)}」`)
      }
      add('contract', c, why.join('，'))
    }
  }

  // ---------- 快递异常 ----------
  const pNoun = hit(RE.parcelNoun, head) ?? (DOMAIN.parcel.test(domain) ? domain : null)
  const pIssue = hit(RE.parcelIssue, subject) ?? hit(RE.parcelIssue, body.slice(0, 1500))
  // 出行变更里的「延误」不算快递
  if (pNoun && pIssue && !out.some(h => h.event === 'flight-change')) {
    let c = RE.parcelIssue.test(subject) ? 0.78 : 0.6
    if (DOMAIN.parcel.test(domain) || ins?.entities?.some(e => e.kind === 'tracking')) c += 0.08
    add('package-issue', c, `「${pNoun}」+「${pIssue}」`)
  }

  // ---------- 求职进展 ----------
  if (!RE.jobDigest.test(subject)) {
    const js = hit(RE.jobStrong, head)
    if (js) {
      let c = RE.jobStrong.test(subject) ? 0.78 : 0.6
      if (DOMAIN.job.test(domain)) c += 0.08
      if (/^unfortunately|^candidate$/i.test(js) && !RE.jobWord.test(head)) c -= 0.2
      add('job-application', c, `含「${js}」${DOMAIN.job.test(domain) ? `，来自 ${domain}` : ''}`)
    }
  }

  // ---------- 生活事务到期 / 续期提醒（证件 / 保险 / 年检 / 域名 / 会员 / 保修…；识别规则同生活档案） ----------
  // 置信度不落在「拿不准」区间（不送 AI 复核：复核提示词里没有这个事件）
  const life = detectLife({ messageId: input.messageId, subject, text: body, fromAddr: input.fromAddr, fromName: input.fromName ?? '', date: input.date ?? Date.now(), isNewsletter: promo })
  if (life && life.expiresAt && life.event !== 'renewed' && life.confidence >= 0.6) add('renewal-notice', Math.max(TRIGGER_MIN, life.confidence), `生活事务：${life.subject} 将于 ${new Date(life.expiresAt).toLocaleDateString('zh-CN')} 到期（${life.reason}）`)

  return out.sort((a, b) => b.confidence - a.confidence)
}

/** 合并两次识别（启发式 → AI 理解后再识别 / AI 复核）：同一事件取较高置信度 */
export function mergeHits(a: AgentEventHit[], b: AgentEventHit[]): AgentEventHit[] {
  const m = new Map<AgentEventKind, AgentEventHit>()
  for (const h of [...a, ...b]) {
    const old = m.get(h.event)
    if (!old || h.confidence > old.confidence) m.set(h.event, h)
  }
  return [...m.values()].sort((x, y) => y.confidence - x.confidence)
}

/** AI 复核结果（{"events":[{"event","confidence","reason"}]}）→ 合法的命中；不认识的事件丢弃 */
export function parseReview(raw: unknown, messageId: string, asked: AgentEventKind[]): { confirmed: AgentEventHit[]; rejected: AgentEventKind[] } {
  const list = Array.isArray((raw as { events?: unknown })?.events) ? ((raw as { events: unknown[] }).events as Record<string, unknown>[]) : []
  const confirmed: AgentEventHit[] = []
  for (const e of list) {
    const ev = String(e?.event ?? '') as AgentEventKind
    if (!asked.includes(ev)) continue
    const c = Number(e?.confidence)
    if (!Number.isFinite(c) || c < TRIGGER_MIN) continue
    confirmed.push({ messageId, event: ev, confidence: clamp(Math.min(c, 0.9)), reason: `AI 复核：${String(e?.reason ?? '').slice(0, 60) || '确认'}` })
  }
  return { confirmed, rejected: asked.filter(a => !confirmed.some(c => c.event === a)) }
}

// ---------------------------------------------------------------- 触发匹配

export interface TriggerMail {
  fromAddr: string
  fromName?: string
  subject: string
  accountId?: string | null
}

const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase()

/** 过滤条件：全部满足才算（空条件视为满足）。发件人 / 主题为不区分大小写的「包含」，多个关键词用逗号 / 空格分隔任一即可 */
export function triggerMatches(match: AgentSkillTrigger['match'], mail: TriggerMail): boolean {
  if (!match) return true
  const anyOf = (needle: string | null | undefined, hay: string) => {
    const words = norm(needle).split(/[,，、\s]+/).filter(Boolean)
    return !words.length || words.some(w => hay.includes(w))
  }
  if (!anyOf(match.from, `${norm(mail.fromName)} <${norm(mail.fromAddr)}>`)) return false
  if (!anyOf(match.subject, norm(mail.subject))) return false
  if (match.accountId && match.accountId !== mail.accountId) return false
  return true
}

function hasCondition(match: AgentSkillTrigger['match']): boolean {
  return !!(match && (norm(match.from) || norm(match.subject) || match.accountId))
}

export interface TriggerPlan {
  skillId: string
  skillName: string
  event: AgentEventKind
  hit: AgentEventHit
  notify: boolean
}

/**
 * 命中的事件 × 技能的 triggers → 要运行的技能（每个技能至多一次；同一封邮件最多 maxPerMessage 个技能，按置信度优先）。
 * custom 触发器不需要事件，只看 match 条件（必须至少有一个条件，防止「所有新邮件都跑」）。
 */
export function planTriggers(skills: Pick<AgentSkill, 'id' | 'name' | 'triggers'>[], hits: AgentEventHit[], mail: TriggerMail & { messageId: string }, opts: { minConfidence?: number; maxPerMessage?: number } = {}): TriggerPlan[] {
  const min = opts.minConfidence ?? TRIGGER_MIN
  const plans: TriggerPlan[] = []
  for (const s of skills) {
    let best: TriggerPlan | null = null
    for (const t of s.triggers ?? []) {
      if (!t || !t.enabled) continue
      if (!triggerMatches(t.match, mail)) continue
      let h: AgentEventHit | undefined
      if (t.event === 'custom') {
        if (!hasCondition(t.match)) continue
        h = { messageId: mail.messageId, event: 'custom', confidence: 1, reason: '满足自定义条件' }
      } else h = hits.find(x => x.event === t.event && x.confidence >= min)
      if (!h) continue
      if (!best || h.confidence > best.hit.confidence) best = { skillId: s.id, skillName: s.name, event: h.event, hit: h, notify: !!t.notify }
    }
    if (best) plans.push(best)
  }
  return plans.sort((a, b) => b.hit.confidence - a.hit.confidence).slice(0, opts.maxPerMessage ?? 2)
}

// ---------------------------------------------------------------- 限额

export interface TriggerLimits {
  perHour: number
  perDay: number
}

export const DEFAULT_TRIGGER_LIMITS: TriggerLimits = { perHour: 6, perDay: 30 }

/** 最近的运行时刻 → 还能不能再跑；不能时给出原因 */
export function quotaCheck(runTimes: number[], now: number, limits: TriggerLimits = DEFAULT_TRIGGER_LIMITS): { ok: boolean; reason: string | null } {
  const hour = runTimes.filter(t => t > now - 3_600_000 && t <= now).length
  const day = runTimes.filter(t => t > now - 86_400_000 && t <= now).length
  if (day >= limits.perDay) return { ok: false, reason: `事件触发今天已运行 ${day} 次（上限 ${limits.perDay}）` }
  if (hour >= limits.perHour) return { ok: false, reason: `事件触发最近一小时已运行 ${hour} 次（上限 ${limits.perHour}）` }
  return { ok: true, reason: null }
}

/** 只对实时新到的邮件：到达登记后 maxAgeMs 内、且邮件本身不太旧 */
export function isLiveArrival(a: { arrivedAt: number | null; date: number; now: number }, maxAgeMs = 24 * 3_600_000): boolean {
  if (!a.arrivedAt) return false
  if (a.now - a.arrivedAt > maxAgeMs) return false
  // 睡眠唤醒补拉的旧信（发出已超过 2 天）不算实时
  return a.now - a.date <= 2 * 86_400_000
}

// ---------------------------------------------------------------- 会后纪要拆解的结构化输出

export interface NotesAction {
  owner: 'me' | 'other'
  who: string
  to: string[]
  what: string
  due: string | null
  kind: 'reply' | 'document'
}

/** 技能输出末尾的 ```json {"actions":[…]} ``` 块 → 行动项；同时返回去掉该块的正文 */
export function extractNotesActions(text: string): { text: string; actions: NotesAction[] } {
  const src = String(text ?? '')
  const re = /```(?:json)?\s*(\{[\s\S]*?"actions"[\s\S]*?\})\s*```/i
  const m = re.exec(src)
  if (!m) return { text: src, actions: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(m[1])
  } catch {
    return { text: src, actions: [] }
  }
  const list = Array.isArray((parsed as { actions?: unknown })?.actions) ? ((parsed as { actions: Record<string, unknown>[] }).actions) : []
  const actions: NotesAction[] = []
  for (const a of list.slice(0, 20)) {
    const what = String(a?.what ?? '').trim().slice(0, 140)
    if (!what) continue
    const to = (Array.isArray(a?.to) ? a.to : typeof a?.to === 'string' ? [a.to] : []).map(x => String(x).trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 5)
    actions.push({
      owner: a?.owner === 'me' ? 'me' : 'other',
      who: String(a?.who ?? '').trim().slice(0, 40),
      to,
      what,
      due: typeof a?.due === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a.due) ? a.due.slice(0, 10) : null,
      kind: a?.kind === 'document' ? 'document' : 'reply'
    })
  }
  return { text: (src.slice(0, m.index) + src.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n').trim(), actions }
}

// ---------------------------------------------------------------- 会后跟进

export interface EndedMeeting {
  todoId: string
  title: string
  messageId: string | null
  endedAt: number
}

/** 待办里的会议 → 最近 windowMs 内已结束的（endsAt，缺省 startsAt + 1h），且没提示过 */
export function recentlyEndedMeetings(
  todos: { id: string; title: string; messageId: string | null; status: string; meeting?: { startsAt: number; endsAt?: number | null } | null }[],
  now: number,
  prompted: Set<string>,
  windowMs = 24 * 3_600_000
): EndedMeeting[] {
  const out: EndedMeeting[] = []
  for (const t of todos) {
    const m = t.meeting
    if (!m || !Number.isFinite(m.startsAt) || t.status === 'dismissed') continue
    const end = m.endsAt && m.endsAt > m.startsAt ? m.endsAt : m.startsAt + 3_600_000
    if (end > now || end < now - windowMs) continue
    if (prompted.has(t.id)) continue
    out.push({ todoId: t.id, title: t.title, messageId: t.messageId, endedAt: end })
  }
  return out.sort((a, b) => b.endedAt - a.endedAt)
}

// ---------------------------------------------------------------- 保存技能时清洗 triggers

const KNOWN_EVENTS: AgentEventKind[] = ['invoice', 'payment-due', 'flight-change', 'travel-booking', 'security-alert', 'contract', 'meeting-invite', 'meeting-notes', 'package-issue', 'job-application', 'custom', 'renewal-notice']

/** 编辑器 / IPC 传来的 triggers → 合法的列表（未知事件丢弃，同一事件只留一条）；不是数组返回 undefined（不覆盖） */
export function sanitizeTriggers(list: unknown): AgentSkillTrigger[] | undefined {
  if (!Array.isArray(list)) return undefined
  const out: AgentSkillTrigger[] = []
  for (const t of list as Record<string, any>[]) {
    const event = String(t?.event ?? '') as AgentEventKind
    if (!KNOWN_EVENTS.includes(event) || out.some(x => x.event === event)) continue
    const m = t?.match && typeof t.match === 'object' ? t.match : null
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null)
    const match = m ? { from: s(m.from), subject: s(m.subject), accountId: s(m.accountId) } : null
    out.push({ event, enabled: !!t?.enabled, notify: !!t?.notify, match: match && (match.from || match.subject || match.accountId) ? match : null })
  }
  return out
}
