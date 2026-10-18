import type { AttachmentCategory } from '@shared/attachments'

/**
 * 附件分类（纯函数，无 IO）：扩展名 + 文件名关键词 + 邮件主题规则。
 * 关键词类（发票 / 合同 / 报价 / 简历）优先于格式类（表格 / 文档 / 图片…）；
 * 文件名没线索时再看主题，主题命中的把握更低，可交给 AI 复核。
 */

export interface ClassifyInput {
  filename: string
  contentType?: string | null
  subject?: string | null
}

export interface ClassifyResult {
  category: AttachmentCategory
  /** 0~1：文件名关键词 0.9 · 扩展名 0.8 · 主题关键词 0.6 · 兜底 0.3 */
  confidence: number
  reason: string
}

const EXT_GROUPS: Record<Exclude<AttachmentCategory, 'invoice' | 'contract' | 'quote' | 'resume' | 'other'>, string[]> = {
  calendar: ['ics', 'vcs', 'ical'],
  design: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'svg', 'tif', 'tiff', 'bmp', 'psd', 'ai', 'sketch', 'fig', 'xd', 'indd', 'eps', 'afdesign', 'raw', 'cr2', 'nef', 'dng'],
  sheet: ['xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'numbers', 'ods', 'et'],
  slides: ['ppt', 'pptx', 'pps', 'ppsx', 'key', 'odp', 'dps'],
  document: ['pdf', 'doc', 'docx', 'pages', 'odt', 'rtf', 'txt', 'md', 'wps', 'ofd', 'xps', 'epub'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'dmg', 'iso'],
  media: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'amr', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', '3gp']
}

const EXT_TO_CATEGORY = new Map<string, AttachmentCategory>()
for (const [cat, exts] of Object.entries(EXT_GROUPS)) for (const e of exts) EXT_TO_CATEGORY.set(e, cat as AttachmentCategory)

/** 关键词类：顺序即优先级（「形式发票」算报价单，「发票」算发票） */
const KEYWORD_RULES: { category: AttachmentCategory; re: RegExp }[] = [
  { category: 'quote', re: /(报价|询价|估价|quotation|\bquote\b|proforma|pro[\s_-]?forma|形式发票|采购单|采购订单|订货单|purchase[\s_-]?order|\bP\.?O\b[\s_#-]*\d|订单确认|order[\s_-]?confirm)/i },
  { category: 'invoice', re: /(发票|收据|账单|对账单|水单|回单|报销|invoice|receipt|\bbill(ing)?\b|statement(?!\s*of\s*work)|fapiao|增值税|电子票|e-?invoice)/i },
  { category: 'contract', re: /(合同|协议|契约|补充条款|保密|授权书|委托书|contract|agreement|\bnda\b|\bmsa\b|\bsow\b|statement[\s_-]*of[\s_-]*work|addendum|amendment|terms[\s_-]?of|签署|signed)/i },
  { category: 'resume', re: /(简历|履历|求职|应聘|resume|résumé|curriculum[\s_-]?vitae|\bcv\b)/i },
  { category: 'quote', re: /(订单|\border\b)/i }
]

/** 主题线索只作用于「文档 / 图片 / 表格」这些可能是扫描件 / 导出件的格式 */
const SUBJECT_APPLIES: AttachmentCategory[] = ['document', 'design', 'sheet', 'other']

export function extOf(filename: string): string {
  const m = /\.([a-z0-9]{1,10})$/i.exec(filename.trim())
  return m ? m[1].toLowerCase() : ''
}

function formatCategory(ext: string, contentType: string): AttachmentCategory | null {
  const byExt = EXT_TO_CATEGORY.get(ext)
  if (byExt) return byExt
  const ct = contentType.toLowerCase()
  if (ct.startsWith('text/calendar') || ct === 'application/ics') return 'calendar'
  if (ct.startsWith('image/')) return 'design'
  if (ct.startsWith('audio/') || ct.startsWith('video/')) return 'media'
  if (ct === 'application/pdf' || ct.includes('msword') || ct.includes('wordprocessing')) return 'document'
  if (ct.includes('spreadsheet') || ct.includes('excel') || ct === 'text/csv') return 'sheet'
  if (ct.includes('presentation') || ct.includes('powerpoint')) return 'slides'
  if (ct.includes('zip') || ct.includes('compressed') || ct.includes('x-tar') || ct.includes('x-7z') || ct.includes('rar')) return 'archive'
  return null
}

/** 文件名去扩展名、把常见分隔符换成空格，便于 \b 词边界匹配 */
function stemOf(filename: string): string {
  return filename.replace(/\.[a-z0-9]{1,10}$/i, '').replace(/[_\-.+]+/g, ' ')
}

export function classifyAttachment(input: ClassifyInput): ClassifyResult {
  const filename = input.filename || ''
  const ext = extOf(filename)
  const fmt = formatCategory(ext, input.contentType ?? '')
  // 日历邀请、音视频、压缩包不看关键词（「合同.zip」仍是压缩包更利于找回）
  if (fmt === 'calendar') return { category: 'calendar', confidence: 0.95, reason: '日历邀请格式' }
  const stem = stemOf(filename)
  if (fmt !== 'media' && fmt !== 'archive') {
    for (const r of KEYWORD_RULES) {
      if (r.re.test(stem) || r.re.test(filename)) return { category: r.category, confidence: 0.9, reason: '文件名关键词' }
    }
  }
  const base: AttachmentCategory = fmt ?? 'other'
  // 文件名没线索：看邮件主题（扫描件 / 「附件是本月账单」）
  const subject = input.subject ?? ''
  // 图片只有像扫描件时才看主题（「10 月账单」邮件里的合照仍是图片）
  const scanLike = base !== 'design' || /(scan|扫描|拍照|回执)/i.test(stem)
  if (subject && scanLike && SUBJECT_APPLIES.includes(base)) {
    for (const r of KEYWORD_RULES) {
      if (r.re.test(subject)) return { category: r.category, confidence: 0.6, reason: '邮件主题关键词' }
    }
  }
  if (fmt) return { category: fmt, confidence: ext ? 0.8 : 0.65, reason: ext ? '扩展名' : '内容类型' }
  return { category: 'other', confidence: 0.3, reason: '无法判断' }
}

export interface NoiseInput {
  filename: string
  contentType?: string | null
  size: number
  inline?: boolean
  contentId?: string | null
}

/**
 * 是否跳过索引：内联图片（cid 引用 / inline 标记）、签名 / logo 小图、S/MIME 签名、
 * winmail.dat、幽灵信信封（.lkghost，由幽灵信模块独占使用）。
 */
export function isNoiseAttachment(a: NoiseInput): boolean {
  const name = (a.filename || '').toLowerCase()
  const ct = (a.contentType || '').toLowerCase()
  if (name.endsWith('.lkghost')) return true
  if (a.inline || a.contentId) return true
  if (/^(smime\.p7s|winmail\.dat)$/.test(name) || ct.includes('pkcs7-signature')) return true
  const isImage = ct.startsWith('image/') || /\.(png|jpe?g|gif|bmp|webp)$/.test(name)
  if (isImage) {
    if (a.size > 0 && a.size < 12 * 1024) return true
    if (/^(image\d{3}|outlook-[a-z0-9]+|logo|signature|sig|banner|icon|spacer)[^/]*\.(png|jpe?g|gif)$/.test(name) && a.size < 60 * 1024) return true
  }
  return false
}

/** 常见个人邮箱域名：对方归到「发件人」而不是公司 */
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'yahoo.com', 'yahoo.co.jp', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'mail.com', 'zoho.com',
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com', '139.com', '189.cn',
  'naver.com', 'yandex.ru', 'yandex.com', 'fastmail.com', 'hey.com'
])

/** 二级公共后缀（com.cn / co.uk …）：取主体时要多跳一级 */
const SECOND_LEVEL = new Set(['com', 'net', 'org', 'gov', 'edu', 'co', 'ac', 'or', 'ne', 'go'])

/** 域名主体：mail.northwind-trading.com.cn → northwind-trading */
export function domainOrg(domain: string): string {
  const parts = domain.toLowerCase().split('.').filter(Boolean)
  if (parts.length <= 1) return parts[0] ?? ''
  let i = parts.length - 2
  if (parts.length >= 3 && SECOND_LEVEL.has(parts[i]) && parts[parts.length - 1].length === 2) i -= 1
  return parts[i] ?? parts[0]
}

/** 对方显示名：公司邮箱 → 域名主体；个人邮箱 → 显示名或邮箱前缀 */
export function counterpartyOf(addr: string | null | undefined, name?: string | null): string {
  const a = (addr ?? '').trim().toLowerCase()
  const at = a.lastIndexOf('@')
  if (at < 0) return (name ?? '').trim() || a || '未知'
  const domain = a.slice(at + 1)
  if (!PERSONAL_DOMAINS.has(domain)) return domainOrg(domain) || domain
  const n = (name ?? '').trim().replace(/^["']|["']$/g, '')
  return n || a.slice(0, at)
}
