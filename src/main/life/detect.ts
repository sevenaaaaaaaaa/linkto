/**
 * 生活档案识别 · 启发式层（纯函数、无副作用、无 AI）
 *
 * 一封邮件（+ 可选的 PDF 附件正文）→ 一个「生活事务候选」：证件 / 保险 / 车辆 / 会员 / 域名 / 保修 / 合同 / 住房 / 税务 / 健康 / 教育 / 银行卡，
 * 带对象、机构、到期日（或预约日）、编号（只留尾号）、费用、是否「续期成功」。
 * 依据：类别关键词（中英）+ 到期 / 续期类动词 + 发件域名（政务 / 出入境 / 车管 / 保险公司 / 注册商…）+ 日期标签；营销「会员日」等降权排除。
 * 归并见 merge.ts；本文件只依赖类型与纯函数，便于独立打包做单测。
 */
import type { LifeCategory, LifeData } from '../../shared/types'
import { defaultRepeat, maskReference, scrubSensitive, DAY_MS } from '../../shared/life'
import { bodyOf, findAmounts, findDates, labeledDate, rootDomain } from '../finance/detect'

export interface LifeMailInput {
  messageId: string
  subject: string
  text: string
  snippet?: string
  html?: string | null
  fromAddr: string
  fromName: string
  date: number
  fromMe?: boolean
  isNewsletter?: boolean
  category?: string | null
  /** PDF / 文本附件正文（保单、合同、保修卡），已截断 */
  attachmentText?: string | null
  attachmentNames?: string[]
}

/** notice 到期 / 续期提醒；renewed 已续期 / 已办妥；appointment 预约（体检 / 复查）；expired 已过期 */
export type LifeEvent = 'notice' | 'renewed' | 'appointment' | 'expired'

export interface LifeCandidate {
  category: LifeCategory
  event: LifeEvent
  subject: string
  provider: string | null
  domain: string | null
  expiresAt: number | null
  amount: number | null
  currency: string | null
  reference: string | null
  repeat: LifeData['repeat']
  confidence: number
  /** 关键词命中但缺日期 / 把握不足：AI 可用时值得补一次 */
  uncertain: boolean
  /** 一句话：为什么这么判断（界面 / 日志） */
  reason: string
}

// ---------------------------------------------------------------- 关键词

const CAT_RE: Record<Exclude<LifeCategory, 'other'>, RegExp> = {
  'id-document':
    /(护照|居民身份证|身份证|驾驶证|驾照|签证|居留许可|居留证|港澳通行证|往来港澳|台湾通行证|台胞证|回乡证|社保卡|passport|\bvisa\b|driver'?s? licen[cs]e|driving licen[cs]e|residence permit|green card|national id)/i,
  insurance: /(保险|保单|续保|车险|交强险|商业险|意外险|医疗险|重疾险|寿险|财产险|家财险|旅行险|insurance|\bpolicy\b|premium|insurer)/i,
  vehicle:
    /(年检|年审|机动车.{0,6}(检验|检测)|检验有效期|车检|环保检|尾气检|上线检测|保养(提醒|到期)|\bmot\b|vehicle (inspection|registration)|registration renewal|smog check|inspection (due|reminder|expires))/i,
  membership: /(会员.{0,8}(到期|即将到期|有效期|过期|续费|续期|年费)|年卡|季卡|健身(卡|房)|会籍|membership|\bgym\b|club member)/i,
  domain: /(域名|domain name|your domain|\bdomain\b|\bssl\b|https? ?证书|ssl ?证书|证书.{0,6}(到期|过期)|certificate.{0,20}expir|云服务器|虚拟主机|\bhosting\b|\bvps\b|服务器.{0,6}到期)/i,
  warranty: /(保修|质保|延保|保固|warranty|guarantee period|applecare)/i,
  contract: /(合同|协议|\bcontract\b|\bagreement\b)/i,
  housing: /(租房|租赁合同|房屋租赁|租约|租期|房租|物业费|物业管理费|供暖费|采暖费|\blease\b|tenancy|landlord|letting agent)/i,
  tax: /(个税|个人所得税|综合所得|年度汇算|汇算清缴|纳税申报|税务申报|tax return|tax filing|self[- ]assessment|\birs\b|hmrc|报税)/i,
  health: /(体检|复查|复诊|疫苗|接种|洗牙|牙科|口腔检查|挂号|门诊预约|check-?up|physical exam|dental|vaccin|appointment (confirmed|reminder|scheduled))/i,
  education: /(学费|注册缴费|开学|学期|报名截止|考试报名|tuition|enrol(l)?ment|semester|term fees?|registration deadline)/i,
  card: /(信用卡.{0,12}(年费|换卡|卡片到期|有效期|新卡)|卡片.{0,4}(即将)?到期|换发新卡|新卡已寄出|年费.{0,6}(扣收|收取|减免)|card (is )?(expir|expiring)|annual (card )?fee|replacement card)/i
}

/** 发件域名 → 类别（命中加分） */
const DOMAIN_RE: Partial<Record<LifeCategory, RegExp>> = {
  'id-document': /(\.gov\.cn|nia\.gov\.cn|mps\.gov\.cn|\.gov|\.gov\.uk|state\.gov|embassy|consulate|vfsglobal\.com|tlscontact\.com)$/i,
  insurance: /(pingan\.com(\.cn)?|cpic\.com\.cn|picc\.com(\.cn)?|chinalife\.com\.cn|e-chinalife\.com|taikanglife\.com|newchinalife\.com|zhongan\.com|sinosig\.com|axa\.[a-z.]+|allianz\.[a-z.]+|aia\.com(\.cn)?|zurich\.[a-z.]+|geico\.com|progressive\.com|statefarm\.com|aviva\.[a-z.]+|lemonade\.com)$/i,
  vehicle: /(12123\.gov\.cn|122\.gov\.cn|dmv\.[a-z.]+|dvla\.gov\.uk)$/i,
  domain: /(godaddy\.com|namecheap\.com|aliyun\.com|alibabacloud\.com|hichina\.com|west\.cn|dnspod\.(cn|com)|cloudflare\.com|porkbun\.com|gandi\.net|name\.com|namesilo\.com|tencentcloud\.com|cloud\.tencent\.com|letsencrypt\.org|sectigo\.com|digicert\.com|hostinger\.com|bluehost\.com|vultr\.com|linode\.com|digitalocean\.com)$/i,
  tax: /(chinatax\.gov\.cn|tax\.gov|irs\.gov|hmrc\.gov\.uk)$/i,
  warranty: /(jd\.com|apple\.com|mi\.com|huawei\.com|dyson\.[a-z.]+|haier\.com|midea\.com|gree\.com|samsung\.com)$/i
}

/** 到期 / 续期 / 定期要办的动词（没有它就不是生活事务） */
const DUE_RE =
  /(保险期间|保障期间|保险期限|租期|policy period|coverage period|period of (insurance|cover)|lease term|即将到期|过期|已过期|有效期|截止|期满|届满|续保|续费|续期|续签|续租|续约|年检|年审|换证|换领|补领|申报|汇算|预约|复查|体检|保修期|质保期|缴费|年费|expir|renew|valid (until|through|thru)|due (date|by|on)|deadline|ends on|appointment|warranty (period|expires|ends)|inspection)/i

const PROMO_RE =
  /(会员日|会员专享|会员价|会员特惠|开通会员|加入会员|升级会员|立即开通|限时|特惠|优惠券|满减|折扣|大促|秒杀|抢购|领券|新品|直播间|买一送一|\bsale\b|% ?off|discount|promo(tion)?|coupon|\bdeals?\b|black friday|limited time|upgrade now|join now)/i
const OWN_RE =
  /((您|你)(的|名下|所持|持有|购买的|投保的)|贵司|尊敬的.{0,12}(先生|女士|车主|会员|客户|用户)|your (membership|policy|passport|domain|warranty|lease|plan|visa|licen[cs]e|vehicle|car|card|tax|appointment|insurance|certificate|contract|tenancy|hosting|server|ssl))/i
/** 明确归属到「你的某样东西要到期了」：营销邮件里通常没有 */
const STRONG_OWN_RE = /((您|你)(的|名下|所持|持有|购买的|投保的).{0,18}(将于|即将|将在|已于|有效期|到期|过期|续保|续费|年检)|your .{0,40}(expires|will expire|is expiring|expired|renewal|is due))/i
const RENEWED_RE =
  /(续保成功|续费成功|已续费|已续期|续期成功|续签成功|已续签|续约成功|已完成续|年检(已)?(通过|完成|合格)|检验合格|已完成.{0,4}(年检|检验|申报|体检|汇算)|换证成功|换领成功|已办结|办理完成|申报成功|已申报|已缴(纳|费)|缴费成功|successfully renewed|has been renewed|renewal (is )?(complete|confirmed|successful)|renewed (successfully|until|through)|thank you for renewing)/i
const EXPIRED_RE = /(已过期|已到期|已经过期|已失效|has expired|expired on|is now expired)/i
/** 验证码 / 链接有效期（几分钟 / 几小时）不是生活事务 */
const SHORT_VALID_RE = /(验证码|校验码|动态码|verification code|one-time (code|password)|\botp\b|有效期\s*(为|是)?\s*\d+\s*(分钟|小时)|valid for \d+ (minutes?|hours?)|expires? in \d+ (minutes?|hours?))/i
const TRAVEL_RE = /(航班|机票|值机|登机|酒店|入住|行程单|flight|boarding|hotel|itinerary)/i
/** 账单类（交给财务），信用卡账单里也有「到期还款日」 */
const STATEMENT_RE = /(还款日|最低还款|本期账单|账单金额|电子账单|statement|minimum payment|amount due)/i

// ---------------------------------------------------------------- 日期

const NEW_EXPIRY_LABEL = /(新的?有效期至|有效期(已)?(延长|顺延|更新)(至|到)|续期至|续保至|延期至|now valid (until|through)|renewed (until|through)|new expir(y|ation) date)/i
const EXPIRY_LABEL =
  /(有效期至|有效期截止|有效期到|有效期限至?|到期日期?|到期时间|截止日期|截止时间|截止到|截至|期满日?|终保日期|保险止期|保修期至|保修截止|质保期至|保修到期|租期至|租约到期|合同到期|将于|即将于|将在|请于|须于|最晚|before|expires?( on)?|expir(y|ation)( date)?|valid (until|through|thru)|renews? on|renewal date|due (date|by|on)|deadline|ends on|end date|next (inspection|service|renewal)( date)?)/i
const APPT_LABEL = /(预约时间|就诊时间|体检时间|检查时间|复查时间|接种时间|预约日期|就诊日期|体检日期|appointment (date|time|on)|scheduled (for|on))/i
const RANGE_LABEL = /(保险期间|保障期间|保险期限|租期|租赁期限|合同期限|有效期|保修期|服务期|办理时间|办理期限|申报期|缴费时间|validity|coverage period|policy period|lease term|filing period|term)/i
const PURCHASE_LABEL = /(购买日期|购买时间|下单时间|下单日期|发票日期|激活日期|purchase date|date of purchase|order date)/i

const CN_NUM: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const numOf = (s: string) => (/^\d+$/.test(s) ? Number(s) : CN_NUM[s] ?? NaN)

type DateHit = ReturnType<typeof findDates>[number]

/** 区间「A 至 B」的 B（保险期间 / 租期 / 有效期），区间要在标签附近 */
function rangeEnd(hay: string, dates: DateHit[]): number | null {
  for (let i = 0; i < dates.length - 1; i++) {
    const a = dates[i]
    const b = dates[i + 1]
    const between = hay.slice(a.end, b.index)
    if (!/^\s*(零时|0时|00:00(:00)?|起)?\s*(起)?\s*(至|到|~|～|-|–|—|to|through|until)\s*$/i.test(between)) continue
    if (b.ts <= a.ts) continue
    const before = hay.slice(Math.max(0, a.index - 40), a.index)
    if (RANGE_LABEL.test(before)) return b.ts
  }
  return null
}

/** 离到期动词最近（40 字内）的日期 */
function nearDueDate(hay: string, dates: DateHit[]): number | null {
  let best: { ts: number; dist: number } | null = null
  // 购买 / 签发 / 出生 / 缴费日期不是到期日
  const usable = dates.filter(d => !/(购买|下单|签发|发证|出生|激活|支付|付款|issued?|purchase|birth)[^\n]{0,8}$/i.test(hay.slice(Math.max(0, d.index - 14), d.index)))
  for (const m of hay.matchAll(new RegExp(DUE_RE.source, 'gi'))) {
    const at = m.index ?? 0
    for (const d of usable) {
      const dist = d.index >= at ? d.index - (at + m[0].length) : at - d.end
      if (dist > 40 || dist < -4) continue
      if (!best || dist < best.dist) best = { ts: d.ts, dist }
    }
  }
  return best?.ts ?? null
}

/** 「还有 30 天到期」「expires in 30 days」 */
function relativeExpiry(hay: string, base: number): number | null {
  const m = hay.match(/(?:还有|剩余|还剩|将在|将于)\s*(\d{1,3})\s*天(?:后)?\s*(?:到期|过期|截止)|expires? in (\d{1,3}) days|(\d{1,3}) days? (?:until|before) (?:your )?(?:\w+ ){0,3}expir/i)
  const n = Number(m?.[1] ?? m?.[2] ?? m?.[3])
  if (!Number.isFinite(n) || n <= 0) return null
  const d = new Date(base + n * DAY_MS)
  d.setHours(23, 59, 0, 0)
  return d.getTime()
}

/** 保修期时长：「保修期 2 年」「12 个月质保」「two-year warranty」→ 购买日 + 时长 */
function warrantyByDuration(hay: string, base: number, dates: DateHit[]): number | null {
  const m =
    hay.match(/(?:保修期|质保期|保修|质保|延保)\s*(?:为|是|：|:)?\s*(\d{1,2}|[一两二三四五六七八九十])\s*(年|个月)/) ??
    hay.match(/(\d{1,2}|[一两二三四五六七八九十])\s*(年|个月)\s*(?:免费)?(?:保修|质保|延保)/)
  const en = hay.match(/(\d{1,2}|one|two|three|five)[- ](year|month)s?\s+(?:limited\s+)?(?:warranty|guarantee)|warranty (?:period )?(?:of|is|:)\s*(\d{1,2}) (year|month)s?/i)
  let n = NaN
  let unit: 'y' | 'm' = 'y'
  if (m) {
    n = numOf(m[1])
    unit = m[2] === '年' ? 'y' : 'm'
  } else if (en) {
    const raw = (en[1] ?? en[3] ?? '').toLowerCase()
    n = ({ one: 1, two: 2, three: 3, five: 5 } as Record<string, number>)[raw] ?? Number(raw)
    unit = /year/i.test(en[2] ?? en[4] ?? '') ? 'y' : 'm'
  }
  if (!Number.isFinite(n) || n <= 0 || n > 120) return null
  const start = labeledDate(hay, PURCHASE_LABEL, base, dates) ?? base
  const d = new Date(start)
  if (unit === 'y') d.setFullYear(d.getFullYear() + n)
  else d.setMonth(d.getMonth() + n)
  d.setHours(23, 59, 0, 0)
  return d.getTime()
}

// ---------------------------------------------------------------- 对象 / 机构 / 编号

const PLATE_RE = /([京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-Z][·•・\s]?[A-HJ-NP-Z0-9]{5,6})/

const NAME_NOISE =
  /\s*(通知|服务|客服|中心|服务号|官方|团队|提醒|助手|notifications?|notify|no-?reply|support|team|accounts?|service|alerts?|reminders?)\s*$/i

function niceDomain(domain: string | null): string {
  if (!domain) return ''
  const label = domain.split('.')[0]
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : domain
}

function providerOf(input: LifeMailInput, hay: string, domain: string | null): string | null {
  let name = String(input.fromName || '').replace(/["']/g, '').trim()
  for (let i = 0; i < 2; i++) name = name.replace(NAME_NOISE, '').trim()
  if (name && !/@/.test(name) && !/^(no-?reply|admin|info|service|notice)$/i.test(name)) return name.slice(0, 40)
  const company = hay.match(/([一-龥A-Za-z0-9（）()·&]{2,24}?(?:保险股份有限公司|保险有限公司|有限责任公司|股份有限公司|有限公司|出入境管理局|车辆管理所|管理局|税务局|医院|大学|学院|物业|Co\.,? ?Ltd\.?|Ltd\.?|Inc\.?|LLC|GmbH|Limited))/)
  if (company) return company[1].slice(0, 40)
  return niceDomain(domain) || null
}

const DOC_TYPES: [RegExp, string][] = [
  [/护照|passport/i, '护照'],
  [/港澳通行证|往来港澳/, '港澳通行证'],
  [/台湾通行证|台胞证/, '台湾通行证'],
  [/回乡证/, '回乡证'],
  [/签证|\bvisa\b/i, '签证'],
  [/居留许可|居留证|residence permit|\bbrp\b/i, '居留许可'],
  [/驾驶证|驾照|driver'?s? licen[cs]e|driving licen[cs]e/i, '驾驶证'],
  [/社保卡/, '社保卡'],
  [/身份证|national id/i, '身份证'],
  [/green card/i, '绿卡']
]

const INS_TYPES: [RegExp, string][] = [
  [/交强险/, '交强险'],
  [/车险|商业险|机动车.{0,4}保险|auto insurance|car insurance|motor insurance|vehicle insurance/i, '车险'],
  [/重疾险|重大疾病/, '重疾险'],
  [/医疗险|医疗保险|health insurance|medical insurance/i, '医疗险'],
  [/意外险|意外伤害|accident insurance/i, '意外险'],
  [/寿险|人寿|life insurance/i, '寿险'],
  [/家财险|家庭财产|财产险|home insurance|homeowners|renters insurance|contents insurance/i, '家庭财产险'],
  [/旅行险|旅游险|travel insurance/i, '旅行险'],
  [/宠物险|pet insurance/i, '宠物险']
]

const SKIP_DOMAINS = /(^|\.)(w3\.org|schema\.org|example\.com|apple\.com|google\.com|weixin\.qq\.com|qq\.com)$/i

/** 正文里被提到的域名（排除发件方自己的域名与常见链接域名），优先「域名」二字后面的那个 */
function domainSubject(hay: string, senderRoot: string | null): string | null {
  const re = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|cn|io|dev|app|co|ai|xyz|me|top|tech|site|shop|store|info|biz|cc|tv|so|sh|link|blog|studio|design|cloud|online|com\.cn|net\.cn|org\.cn))\b/gi
  const label = hay.search(/(域名|domain( name)?|证书|certificate|主机|hosting)/i)
  let best: { name: string; dist: number } | null = null
  for (const m of hay.matchAll(re)) {
    const name = m[1].toLowerCase().replace(/^www\./, '')
    if (senderRoot && (name === senderRoot || name.endsWith(`.${senderRoot}`))) continue
    if (SKIP_DOMAINS.test(name)) continue
    const before = hay.slice(Math.max(0, (m.index ?? 0) - 1), m.index ?? 0)
    if (before === '@' || before === '/') continue
    const dist = label >= 0 ? Math.abs((m.index ?? 0) - label) : 1000 + (m.index ?? 0)
    if (!best || dist < best.dist) best = { name, dist }
  }
  return best?.name ?? null
}

function grab(hay: string, re: RegExp): string | null {
  const m = hay.match(re)
  const v = m?.[1]?.trim()
  return v ? v.replace(/[。.,，;；)）]+$/, '') : null
}

function referenceOf(category: LifeCategory, hay: string): string | null {
  let raw: string | null = null
  if (category === 'id-document') raw = grab(hay, /(?:护照|证件|身份证|驾驶证|档案|签证|通行证|passport|licen[cs]e|document)\s*(?:号码|号|编号|no\.?|number|#)\s*[:：]?\s*([A-Z0-9]{6,20})/i) ?? grab(hay, /(?:尾号|末四位|ending (?:in|with))\s*[:：]?\s*([0-9X]{4})/i)
  else if (category === 'insurance') raw = grab(hay, /(?:保单号码?|保单编号|保险单号|policy\s*(?:no\.?|number|#))\s*[:：#]?\s*([A-Z0-9][A-Z0-9-]{5,32})/i)
  else if (category === 'card') raw = grab(hay, /(?:尾号|末四位|ending (?:in|with))\s*[:：]?\s*(\d{4})/i)
  else if (category === 'contract' || category === 'housing') raw = grab(hay, /(?:合同(?:编)?号|合同编码|协议编号|contract\s*(?:no\.?|#|number)|lease\s*(?:no\.?|#|number))\s*[:：#]?\s*([A-Z0-9][A-Z0-9-]{3,32})/i)
  else if (category === 'warranty') raw = grab(hay, /(?:序列号|SN|serial(?: number| no\.?)?|保修卡号|订单号)\s*[:：#]?\s*([A-Z0-9][A-Z0-9-]{5,32})/i)
  if (!raw || !/\d/.test(raw)) return null
  return maskReference(raw, category)
}

function subjectOf(category: LifeCategory, hay: string, subjectLine: string, provider: string | null, domainName: string | null): string {
  const plate = hay.match(PLATE_RE)?.[1]?.replace(/[•・\s]/, '·')
  switch (category) {
    case 'id-document': {
      const t = DOC_TYPES.find(([re]) => re.test(subjectLine))?.[1] ?? DOC_TYPES.find(([re]) => re.test(hay))?.[1] ?? '证件'
      const holder = grab(hay, /(?:持证人|持照人|申请人|姓名|holder)\s*[:：]\s*([一-龥]{2,4}|[A-Z][a-z]+(?: [A-Z][a-z]+)?)/)
      return holder ? `${t}（${holder}）` : t
    }
    case 'insurance': {
      const t = INS_TYPES.find(([re]) => re.test(subjectLine))?.[1] ?? INS_TYPES.find(([re]) => re.test(hay))?.[1] ?? '保险'
      return plate && (t === '车险' || t === '交强险') ? `${t} · ${plate}` : t
    }
    case 'vehicle': {
      const what = /保养|service/i.test(hay) && !/年检|年审|检验|inspection|mot/i.test(hay) ? '车辆保养' : '机动车年检'
      return plate ? `${what} · ${plate}` : what
    }
    case 'domain': {
      const kind = /ssl|证书|certificate/i.test(subjectLine) ? 'SSL 证书' : /主机|服务器|hosting|vps/i.test(subjectLine) ? '主机' : '域名'
      return domainName ? (kind === '域名' ? domainName : `${kind} · ${domainName}`) : kind
    }
    case 'membership': {
      const what = /年卡/.test(hay) ? '年卡' : /健身|gym/i.test(hay) ? '健身会员' : '会员'
      return provider ? `${provider} ${what}` : what
    }
    case 'warranty': {
      const item = grab(hay, /(?:商品名称|商品|产品名称|产品型号|产品|设备|型号|product|item|model)\s*[:：]\s*([^\n，,；;]{2,40})/i)
      return item ? `${item.slice(0, 30)} 保修` : `${provider ?? ''}产品保修`.trim()
    }
    case 'housing': {
      if (/物业/.test(hay)) return '物业费'
      if (/供暖|采暖/.test(hay)) return '供暖费'
      return /lease|tenancy/i.test(hay) && !/[一-龥]/.test(subjectLine) ? 'Lease' : '租房合同'
    }
    case 'tax':
      return /汇算/.test(hay) ? '个税年度汇算' : /个税|个人所得税|综合所得/.test(hay) ? '个人所得税申报' : /self[- ]assessment/i.test(hay) ? 'Self Assessment 报税' : /tax/i.test(hay) && !/[一-龥]/.test(subjectLine) ? 'Tax return' : '纳税申报'
    case 'health':
      return /体检|physical|check-?up/i.test(hay) ? '体检' : /牙|dental/i.test(hay) ? '牙科' : /疫苗|接种|vaccin/i.test(hay) ? '疫苗接种' : /复查|复诊/.test(hay) ? '复查' : '就诊预约'
    case 'education':
      return /学费|tuition/i.test(hay) ? '学费' : /报名/.test(hay) ? '考试报名' : '注册缴费'
    case 'card': {
      const tail = hay.match(/(?:尾号|ending (?:in|with))\s*[:：]?\s*(\d{4})/i)?.[1]
      const what = /年费|annual fee/i.test(hay) ? '信用卡年费' : '信用卡到期换卡'
      return tail ? `${what}（尾号 ${tail}）` : what
    }
    case 'contract': {
      const name = grab(hay, /《([^》]{2,30})》/) ?? grab(hay, /(?:合同名称|协议名称|contract)\s*[:：]\s*([^\n，,]{2,30})/i)
      return name ?? '合同'
    }
    default:
      return subjectLine.slice(0, 30) || '生活事务'
  }
}

function amountOf(hay: string): { amount: number; currency: string } | null {
  const FEE = /(保费|续费|年费|费用|学费|物业费|租金|应缴|应付|金额|合计|总计|价格|premium|fee|price|cost|amount|total|renewal (price|amount))[^\n\d]{0,14}$/i
  for (const h of findAmounts(hay)) {
    const before = hay.slice(Math.max(0, h.index - 24), h.index)
    if (FEE.test(before) || h.score >= 3) return { amount: h.amount, currency: h.currency }
  }
  return null
}

// ---------------------------------------------------------------- 识别

/** 预筛：主题 + 正文开头是否带类别词与到期动词（便宜，用于实时与回填的第一道门） */
export function looksLife(subject: string, snippet: string): boolean {
  const hay = `${subject}\n${snippet}`
  if (!DUE_RE.test(hay)) return false
  return Object.values(CAT_RE).some(re => re.test(hay))
}

/** 一封邮件 → 生活事务候选（不是返回 null） */
export function detectLife(input: LifeMailInput): LifeCandidate | null {
  if (input.fromMe) return null
  const subjectLine = String(input.subject || '')
  const body = bodyOf(input)
  const attach = String(input.attachmentText || '').slice(0, 8000)
  const hay = `${subjectLine}\n${body}${attach ? `\n${attach}` : ''}`
  const head = `${subjectLine}\n${body.slice(0, 1200)}`
  if (SHORT_VALID_RE.test(head) && !/(护照|签证|保单|passport|policy|域名|domain)/i.test(subjectLine)) return null
  if (!DUE_RE.test(hay)) return null

  const fromDomain = rootDomain(input.fromAddr)
  const host = (input.fromAddr.split('@')[1] ?? '').toLowerCase()

  // —— 类别打分 ——
  let best: { cat: Exclude<LifeCategory, 'other'>; score: number } | null = null
  for (const [cat, re] of Object.entries(CAT_RE) as [Exclude<LifeCategory, 'other'>, RegExp][]) {
    let s = 0
    if (re.test(subjectLine)) s += 2
    if (re.test(body.slice(0, 3000))) s += 1
    else if (attach && re.test(attach)) s += 0.8
    if (DOMAIN_RE[cat]?.test(host)) s += 1.2
    if (!s) continue
    // 「合同」太泛：租房 / 物业优先归住房；保单里的「合同」不算合同
    if (cat === 'contract' && (CAT_RE.housing.test(hay) || CAT_RE.insurance.test(subjectLine))) s -= 1.5
    // 车险算保险；车辆只管年检 / 保养
    if (cat === 'vehicle' && /(车险|交强险|商业险|insurance)/i.test(subjectLine)) s -= 1.5
    // 「会员」类：信用卡年费不算会员
    if (cat === 'membership' && CAT_RE.card.test(hay)) s -= 1
    if (!best || s > best.score) best = { cat, score: s }
  }
  if (!best || best.score < 1) return null
  const category = best.cat

  const promo = PROMO_RE.test(head) || /优惠券|代金券|红包|积分|coupon|voucher|points/i.test(subjectLine)
  const own = OWN_RE.test(head)
  // 出行邮件里提到的「护照有效期需 6 个月以上」
  if (category === 'id-document' && TRAVEL_RE.test(head) && !CAT_RE['id-document'].test(subjectLine)) return null
  // 信用卡账单（还款日）交给财务
  if (category === 'card' && STATEMENT_RE.test(head) && !/(年费|换卡|新卡|卡片到期|annual fee|replacement)/i.test(head)) return null
  // 营销：会员日 / 优惠券有效期 / 限时活动——没有「您的 XX 到期」这种归属时直接排除
  if (promo && (input.isNewsletter || !STRONG_OWN_RE.test(head))) return null

  // —— 事件 ——
  const renewed = RENEWED_RE.test(head) || (!!attach && RENEWED_RE.test(attach.slice(0, 800)))
  const expired = !renewed && EXPIRED_RE.test(head)
  const appointment = category === 'health' && !renewed

  // —— 日期 ——
  const base = input.date || Date.now()
  const dates = findDates(hay, base)
  let expiresAt: number | null = null
  let dateHow = ''
  if (renewed) {
    expiresAt = labeledDate(hay, NEW_EXPIRY_LABEL, base, dates) ?? rangeEnd(hay, dates)
    if (expiresAt) dateHow = '新有效期'
  }
  if (!expiresAt && appointment) {
    expiresAt = labeledDate(hay, APPT_LABEL, base, dates)
    if (expiresAt) dateHow = '预约时间'
  }
  if (!expiresAt) {
    expiresAt = rangeEnd(hay, dates)
    if (expiresAt) dateHow = '期间止'
  }
  if (!expiresAt) {
    expiresAt = labeledDate(hay, EXPIRY_LABEL, base, dates)
    if (expiresAt) dateHow = '到期日'
  }
  if (!expiresAt && category === 'warranty') {
    expiresAt = warrantyByDuration(hay, base, dates)
    if (expiresAt) dateHow = '保修时长'
  }
  if (!expiresAt) {
    expiresAt = nearDueDate(hay, dates)
    if (expiresAt) dateHow = '正文日期'
  }
  if (!expiresAt) {
    expiresAt = relativeExpiry(hay, base)
    if (expiresAt) dateHow = '剩余天数'
  }
  // 续期成功邮件里只出现「本次缴费日」这种过去的日期：不当成新到期日
  if (renewed && expiresAt && expiresAt < base) expiresAt = null
  // 太久以前的（到期早于收信 2 年）多半是别的日期（出生日期 / 签发日期）
  if (expiresAt && expiresAt < base - 2 * 365 * DAY_MS) expiresAt = null

  const provider = providerOf(input, hay, fromDomain)
  const domainName = category === 'domain' ? domainSubject(`${subjectLine}\n${body}`, fromDomain) : null
  const subject = scrubSensitive(subjectOf(category, hay, subjectLine, provider, domainName)).slice(0, 60)
  const money = category === 'id-document' || category === 'health' ? null : amountOf(hay)

  // —— 把握 ——
  let confidence = 0.35
  confidence += Math.min(0.3, best.score * 0.1)
  if (DOMAIN_RE[category]?.test(host)) confidence += 0.1
  if (expiresAt) confidence += dateHow === '正文日期' ? 0.12 : 0.2
  if (own) confidence += 0.08
  if (renewed || expired) confidence += 0.05
  if (DUE_RE.test(subjectLine)) confidence += 0.05
  if (input.isNewsletter) confidence -= 0.2
  if (/^(re|回复|fw|fwd|转发)\s*[:：]/i.test(subjectLine.trim())) confidence -= 0.1
  confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100))

  const event: LifeEvent = renewed ? 'renewed' : appointment ? 'appointment' : expired ? 'expired' : 'notice'
  const reason = `${CAT_LABEL_SHORT[category]}关键词${DOMAIN_RE[category]?.test(host) ? ' + 机构域名' : ''}${expiresAt ? ` + ${dateHow}` : '，缺日期'}${renewed ? '（续期成功）' : ''}`
  return {
    category,
    event,
    subject,
    provider,
    domain: fromDomain,
    expiresAt,
    amount: money?.amount ?? null,
    currency: money?.currency ?? null,
    reference: referenceOf(category, hay),
    repeat: defaultRepeat(category),
    confidence,
    uncertain: confidence < 0.6 || (!expiresAt && event !== 'renewed'),
    reason
  }
}

const CAT_LABEL_SHORT: Record<LifeCategory, string> = {
  'id-document': '证件',
  insurance: '保险',
  vehicle: '车辆',
  membership: '会员',
  domain: '域名',
  warranty: '保修',
  contract: '合同',
  housing: '住房',
  tax: '税务',
  health: '健康',
  education: '教育',
  card: '银行卡',
  other: '其他'
}

/** 新建门槛：要有日期且把握够（续期成功邮件只用来归并，不单独新建无日期的条目） */
export function acceptLife(c: LifeCandidate | null): boolean {
  if (!c) return false
  if (!c.expiresAt) return false
  return c.confidence >= 0.55
}
