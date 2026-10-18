import type { AttachmentCategory } from '@shared/attachments'
import type { AttachmentInvoiceFields, FinancePdfCheck } from '@shared/types'

/**
 * 附件正文的纯函数（无 IO，可独立打包单测）：
 *  - 纯文本编码探测（UTF-8 / UTF-16 / GBK / Big5 / Shift_JIS）、HTML 去标签
 *  - PDF 文本层整理：文本项拼行、康熙部首等兼容字符归一、重复页眉页脚去除、扫描件判定
 *  - 正文关键词再分类（发票 / 合同 / 报价 / 简历）
 *  - 发票字段抽取（发票号 / 开票日期 / 价税合计 / 销售方 / 购买方）与财务记录核对
 */

// ---------------------------------------------------------------- 编码探测

/** 文本类附件扩展名（直接读取，不走 PDF 解析） */
export const PLAIN_EXTS = new Set(['txt', 'text', 'csv', 'tsv', 'md', 'markdown', 'log', 'json', 'xml', 'yaml', 'yml', 'ini', 'html', 'htm', 'xhtml', 'eml', 'ics', 'vcf', 'srt', 'rtf'])

export type TextKind = 'pdf' | 'plain' | 'html' | 'eml' | null

/** 按扩展名 / 内容类型判断怎么取正文；null = 不支持（图片 / Office / 压缩包…） */
export function textKindOf(ext: string, contentType?: string | null): TextKind {
  const e = (ext || '').toLowerCase()
  const ct = (contentType || '').toLowerCase()
  if (e === 'pdf' || ct === 'application/pdf') return 'pdf'
  if (e === 'eml' || ct === 'message/rfc822') return 'eml'
  if (e === 'html' || e === 'htm' || e === 'xhtml' || ct === 'text/html') return 'html'
  if (PLAIN_EXTS.has(e) || ct.startsWith('text/')) return 'plain'
  return null
}

function tryDecode(label: string, buf: Uint8Array, fatal: boolean): string | null {
  try {
    return new TextDecoder(label, { fatal }).decode(buf)
  } catch {
    return null
  }
}

function countBad(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0xfffd || (c < 0x20 && c !== 9 && c !== 10 && c !== 13 && c !== 12)) n++
  }
  return n
}

/** 常用汉字 / 假名 / 拉丁字符占比：用于在 GBK / Big5 / Shift_JIS 之间挑最「像话」的 */
function plausibility(s: string): number {
  let good = 0
  let total = 0
  for (const ch of s.slice(0, 20000)) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) continue
    total++
    // 常用汉字区 / 中文标点 / 全角
    if ((c >= 0x4e00 && c <= 0x9fa5) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) good++
  }
  return total ? good / total : 1
}

/**
 * 字节 → 文本：BOM → 严格 UTF-8（容忍末尾被截断的半个字符）→ UTF-16 嗅探 →
 * GBK（gb18030）/ Big5 / Shift_JIS 取替换字符最少、常用字占比最高的 → 兜底 windows-1252。
 */
export function decodeBuffer(buf: Uint8Array): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: tryDecode('utf-8', buf.subarray(3), false) ?? '', encoding: 'utf-8' }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: tryDecode('utf-16le', buf.subarray(2), false) ?? '', encoding: 'utf-16le' }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { text: tryDecode('utf-16be', buf.subarray(2), false) ?? '', encoding: 'utf-16be' }
  for (let k = 0; k <= 3 && k < buf.length; k++) {
    const s = tryDecode('utf-8', k ? buf.subarray(0, buf.length - k) : buf, true)
    if (s != null) return { text: s, encoding: 'utf-8' }
  }
  // 无 BOM 的 UTF-16：奇 / 偶位置大量 0 字节
  const sample = buf.subarray(0, Math.min(buf.length, 4000))
  let zeroOdd = 0
  let zeroEven = 0
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) (i % 2 ? zeroOdd++ : zeroEven++)
  if (zeroOdd > sample.length * 0.3) return { text: tryDecode('utf-16le', buf, false) ?? '', encoding: 'utf-16le' }
  if (zeroEven > sample.length * 0.3) return { text: tryDecode('utf-16be', buf, false) ?? '', encoding: 'utf-16be' }
  let best: { text: string; encoding: string; score: number } | null = null
  for (const [label, name] of [['gb18030', 'gbk'], ['big5', 'big5'], ['shift_jis', 'shift_jis']] as const) {
    const s = tryDecode(label, buf, false)
    if (s == null) continue
    const bad = countBad(s) / Math.max(1, s.length)
    const score = bad * 10 - plausibility(s)
    if (!best || score < best.score - 1e-9) best = { text: s, encoding: name, score }
  }
  if (best && best.score < -0.5) return { text: best.text, encoding: best.encoding }
  return { text: tryDecode('windows-1252', buf, false) ?? '', encoding: 'windows-1252' }
}

// ---------------------------------------------------------------- HTML

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…', yen: '¥', copy: '©', reg: '®' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** HTML → 纯文本：去 script / style / 注释，块级标签换行，表格单元格用制表符 */
export function htmlToPlain(html: string): string {
  const s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|noscript|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/?(p|div|tr|table|ul|ol|h[1-6]|section|article|header|footer|blockquote|pre|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return tidyText(decodeEntities(s))
}

/** 行尾空白、连续空行收敛到一个空行 */
export function tidyText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------- PDF 文本层

/**
 * 康熙部首（⼦ ⽇ ⾦…）/ CJK 部首补充 / 兼容汉字 → 统一汉字。
 * 很多中文 PDF 字体的 ToUnicode 把常用字映射到部首区，复制出来「看着一样」但搜不到。
 */
export function normalizeCjk(s: string): string {
  return s.replace(/[\u2e80-\u2fdf\uf900-\ufaff]/g, c => RADICAL_SUPPLEMENT.get(c) ?? c.normalize('NFKC'))
}

/** CJK 部首补充区（U+2E80–2EFF）没有 NFKC 分解，按 Unicode EquivalentUnifiedIdeograph 映射常用的 */
const RADICAL_SUPPLEMENT = (() => {
  const from = '\u2e81\u2e84\u2e85\u2e86\u2e87\u2e88\u2e89\u2e8a\u2e8c\u2e8e\u2e90\u2e92\u2e93\u2e94\u2e95\u2e96\u2e98\u2e99\u2e9b\u2e9d\u2e9e\u2e9f\u2ea0\u2ea1\u2ea2\u2ea3\u2ea4\u2ea6\u2ea7\u2ea8\u2ea9\u2eaa\u2eab\u2eac\u2ead\u2eae\u2eaf\u2eb0\u2eb1\u2eb2\u2eb7\u2eb9\u2eba\u2ebb\u2ebc\u2ebd\u2ebe\u2ebf\u2ec0\u2ec1\u2ec2\u2ec3\u2ec4\u2ec5\u2ec6\u2ec8\u2ec9\u2eca\u2ecb\u2ecc\u2ecd\u2ece\u2ecf\u2ed0\u2ed1\u2ed2\u2ed3\u2ed4\u2ed6\u2ed7\u2ed8\u2ed9\u2eda\u2edb\u2edc\u2edd\u2edf\u2ee0\u2ee2\u2ee3\u2ee4\u2ee5\u2ee6\u2ee7\u2ee8\u2ee9\u2eea\u2eeb\u2eec\u2eed\u2eee\u2eef\u2ef0\u2ef1\u2ef2\u2ef3'
  const to = '厂乙亻冂几刀刂卜小兀尢巳幺彑彐忄扌攵旡月歺母民氵氺灬爫丬牛犭王疋罒示礻竹糹纟罓罒羊耂肀聿月臼艹艹艹虎衤覀西见角讠贝足车辶辶辶阝钅長镸长门阝雨青韦页风飞食飠饣马骨鬼鱼鸟卤麦黄黾斉齐歯齿竜龙龜亀龟'
  const m = new Map<string, string>()
  for (let i = 0; i < from.length; i++) m.set(from[i], to[i])
  return m
})()

export interface PdfTextItem {
  str: string
  hasEOL?: boolean
  /** [a, b, c, d, x, y] */
  transform?: number[]
  width?: number
  height?: number
}

/** 一页的文本项 → 文本：按 y 坐标断行，行距明显变大时空一行（段落），同一行里有间隙补空格 */
export function itemsToText(items: PdfTextItem[]): string {
  let out = ''
  let lastY: number | null = null
  let lastH = 0
  let lastXEnd: number | null = null
  for (const it of items) {
    const y = it.transform?.[5]
    const x = it.transform?.[4]
    const h = Math.abs(it.height || it.transform?.[3] || 0)
    const lh = lastH || h || 10
    if (y != null && lastY != null && out) {
      const dy = Math.abs(lastY - y)
      if (!out.endsWith('\n') && dy > Math.max(2, lh * 0.5)) out += '\n'
      else if (!out.endsWith('\n') && lastXEnd != null && x != null && it.str && x - lastXEnd > Math.max(1.5, lh * 0.25) && !/\s$/.test(out) && !/^\s/.test(it.str)) out += ' '
      if (out.endsWith('\n') && !out.endsWith('\n\n') && dy > lh * 1.9 && it.str.trim()) out += '\n'
    }
    out += it.str
    if (it.hasEOL) out += '\n'
    if (y != null && it.str) {
      lastY = y
      if (h) lastH = h
    }
    if (x != null && it.str) lastXEnd = x + (it.width || 0)
  }
  return out
}

/** 页码样式的行（「- 3 -」「第 3 页 共 10 页」「Page 3 of 10」「3 / 10」）：数字归一后比较；其他行按原文比较 */
const PAGE_NO = /^(?:page\s*)?[-–—(\[]?\s*\d+\s*[-–—)\]]?(?:\s*(?:\/|of|共)\s*\d+\s*页?)?$|^第\s*\d+\s*页(?:\s*[,，/]?\s*共\s*\d+\s*页)?$/i
const edgeKey = (l: string) => {
  const t = l.trim().replace(/\s+/g, ' ')
  return PAGE_NO.test(t) ? `#page:${t.replace(/\d+/g, '#')}` : t
}

/**
 * 去掉重复的页眉页脚：每页最前 / 最后两行里，在 ≥60% 的页（至少 3 页）都出现的同一行（页码行数字归一后比较）。
 * 「第 3 页 共 10 页」「- 3 -」「公司名 · 内部资料」这类都会被去掉；正文行不受影响。
 */
export function stripRepeatedEdges(pages: string[]): string[] {
  if (pages.length < 3) return pages
  const split = pages.map(p => p.split('\n'))
  const edgesOf = (lines: string[]): number[] => {
    const idx = lines.map((l, i) => (l.trim() ? i : -1)).filter(i => i >= 0)
    return [...new Set([...idx.slice(0, 2), ...idx.slice(-2)])]
  }
  const counts = new Map<string, number>()
  for (const lines of split) {
    const keys = new Set(edgesOf(lines).map(i => edgeKey(lines[i])))
    for (const k of keys) if (k && k.length <= 80) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.6))
  return split.map(lines => {
    const drop = new Set(edgesOf(lines).filter(i => (counts.get(edgeKey(lines[i])) ?? 0) >= threshold))
    return drop.size ? lines.filter((_, i) => !drop.has(i)).join('\n') : lines.join('\n')
  })
}

/** 有效字符数（不含空白） */
export function solidChars(s: string): number {
  return s.replace(/\s+/g, '').length
}

/** 文本层几乎为空（平均每页不到 15 个字）→ 扫描件 / 纯图片 PDF */
export function looksScanned(totalSolidChars: number, pagesRead: number): boolean {
  return pagesRead > 0 && totalSolidChars / pagesRead < 15
}

/** 分页文本 → 最终正文：页间用换页符（\f）分隔，便于按页读取 */
export function joinPages(pages: string[]): string {
  return stripRepeatedEdges(pages.map(p => tidyText(normalizeCjk(p))))
    .map(p => tidyText(p))
    .join('\n\f\n')
}

/** 按页取：from / to 从 1 开始（含）；正文里没有分页符时视作一页 */
export function slicePages(text: string, from?: number | null, to?: number | null): { text: string; from: number; to: number; total: number } {
  const pages = text.split('\n\f\n')
  const total = pages.length
  const a = Math.min(Math.max(1, Math.floor(from ?? 1)), total)
  const b = Math.min(Math.max(a, Math.floor(to ?? total)), total)
  return { text: pages.slice(a - 1, b).join('\n\f\n'), from: a, to: b, total }
}

// ---------------------------------------------------------------- 正文关键词再分类

type ContentCat = Extract<AttachmentCategory, 'invoice' | 'contract' | 'quote' | 'resume'>

/** 每类若干信号：w = 权重（2 = 几乎只在这类文档出现） */
const CONTENT_SIGNALS: Record<ContentCat, { re: RegExp; w: number }[]> = {
  invoice: [
    { re: /发票代码/, w: 2 },
    { re: /发票号码/, w: 2 },
    { re: /价税合计/, w: 2 },
    { re: /开票日期/, w: 1 },
    { re: /纳税人识别号|统一社会信用代码/, w: 1 },
    { re: /税\s*额/, w: 1 },
    { re: /增值税|电子发票|普通发票|专用发票|全电发票|数电票/, w: 1 },
    { re: /销售方|购买方|销方|购方/, w: 1 },
    { re: /\binvoice\s*(no\.?|number|#|date)/i, w: 2 },
    { re: /\b(tax\s*invoice|vat\s*(no|number|reg)|amount\s*due|total\s*due|balance\s*due)\b/i, w: 2 },
    { re: /\b(bill\s*to|billed\s*to|subtotal|tax)\b/i, w: 1 },
    { re: /\breceipt\s*(no\.?|number|#)/i, w: 2 }
  ],
  contract: [
    { re: /甲\s*方/, w: 1 },
    { re: /乙\s*方/, w: 1 },
    { re: /甲方[\s\S]{0,400}乙方/, w: 1 },
    { re: /(本|此)(合同|协议)/, w: 2 },
    { re: /违约(责任|金)?/, w: 2 },
    { re: /签订|签署|盖章|生效/, w: 1 },
    { re: /争议(解决)?|仲裁|管辖/, w: 1 },
    { re: /\b(agreement|contract)\b/i, w: 1 },
    { re: /\b(the\s+)?part(y|ies)\b/i, w: 1 },
    { re: /\b(hereinafter|whereas|governing\s+law|indemnif\w*|termination)\b/i, w: 2 },
    { re: /\bconfidential(ity)?\b/i, w: 1 }
  ],
  quote: [
    { re: /报价单|报价表|报\s*价/, w: 2 },
    { re: /\bquotation\b|\bquote\s*(no\.?|number|#)/i, w: 2 },
    { re: /单\s*价|\bunit\s*price\b/i, w: 1 },
    { re: /有效期|报价有效|\bvalid(ity)?\s*(until|for|period)?\b/i, w: 1 },
    { re: /数\s*量|\bqty\b|\bquantity\b/i, w: 1 },
    { re: /交货期|交期|\blead\s*time\b|\bdelivery\s*terms?\b/i, w: 1 }
  ],
  resume: [
    { re: /简\s*历|履\s*历|\bcurriculum\s+vitae\b|\brésumé\b|\bresume\b/i, w: 2 },
    { re: /工作经历|工作经验|\bwork\s+experience\b|\bemployment\s+history\b|\bexperience\b/i, w: 1 },
    { re: /教育背景|教育经历|\beducation\b/i, w: 1 },
    { re: /求职意向|期望(薪资|职位)|\bobjective\b/i, w: 2 },
    { re: /项目经验|项目经历|自我评价|专业技能|\bskills\b/i, w: 1 },
    { re: /出生(年月|日期)|毕业(院校|时间)|学\s*历/, w: 1 }
  ]
}

export function contentScores(text: string): Record<ContentCat, number> {
  const t = text.slice(0, 12000)
  const out = { invoice: 0, contract: 0, quote: 0, resume: 0 } as Record<ContentCat, number>
  for (const cat of Object.keys(CONTENT_SIGNALS) as ContentCat[]) {
    for (const s of CONTENT_SIGNALS[cat]) if (s.re.test(t)) out[cat] += s.w
  }
  return out
}

/** 正文看起来是发票 */
export function looksLikeInvoice(text: string): boolean {
  const s = contentScores(text)
  return s.invoice >= 4 && s.invoice >= s.contract && s.invoice >= s.quote
}

export interface ContentClassifyInput {
  category: AttachmentCategory
  confidence: number
  /** rule / ai / manual / content */
  source: string
}

/**
 * 拿不准的附件（规则把握 < 0.85，或只被认成「文档 / 其他」）用正文再判一次：
 * 最高分类 ≥ 4 分且领先第二名 ≥ 2 分才改；手动改过的不动。返回 null = 不改。
 */
export function classifyByContent(cur: ContentClassifyInput, text: string): { category: AttachmentCategory; confidence: number; reason: string } | null {
  if (cur.source === 'manual') return null
  const unsure = cur.confidence < 0.85 || cur.category === 'document' || cur.category === 'other' || cur.source === 'ai'
  if (!unsure || solidChars(text) < 20) return null
  const scores = contentScores(text)
  const ranked = (Object.entries(scores) as [ContentCat, number][]).sort((a, b) => b[1] - a[1])
  const [top, second] = ranked
  if (top[1] < 4 || top[1] - second[1] < 2) return null
  const confidence = Math.min(0.95, 0.6 + top[1] * 0.05)
  if (top[0] === cur.category) return confidence > cur.confidence ? { category: top[0], confidence, reason: '正文关键词确认' } : null
  return { category: top[0], confidence, reason: '正文关键词' }
}

// ---------------------------------------------------------------- 发票字段

const num = (s: string | undefined | null): number | null => {
  if (!s) return null
  const n = Number(String(s).replace(/[,\s]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }

const ymdOf = (y: string | number, m: string | number, d: string | number): string | null => {
  const yy = Number(y)
  const mm = Number(m)
  const dd = Number(d)
  if (!(yy >= 1990 && yy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

const CUR_MAP: Record<string, string> = { $: 'USD', us$: 'USD', usd: 'USD', '€': 'EUR', eur: 'EUR', '£': 'GBP', gbp: 'GBP', '¥': 'CNY', rmb: 'CNY', cny: 'CNY', jpy: 'JPY', hkd: 'HKD', hk$: 'HKD', sgd: 'SGD', aud: 'AUD', cad: 'CAD' }

/** 全角标点 / 全角空格换成半角，方便正则 */
function flat(text: string): string {
  return normalizeCjk(text)
    .replace(/：/g, ':')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/￥/g, '¥')
    .replace(/[\u3000\u00a0]/g, ' ')
}

function cleanName(s: string | undefined | null): string | null {
  const v = String(s ?? '')
    .replace(/^[\s:]+|[\s:,;，；]+$/g, '')
    .trim()
  if (v.length < 2 || /^(名称|纳税人识别号|地址|电话|开户行)/.test(v)) return null
  return v.slice(0, 80)
}

/**
 * 从发票正文里抽字段：中文增值税发票（发票号码 / 发票代码 / 开票日期 / 价税合计（小写）/ 销售方 / 购买方名称），
 * 英文 Invoice（Invoice No. / Invoice Date / Total Due / Bill To / From）。抽不到的字段为 null。
 */
export function extractInvoiceFields(text: string): AttachmentInvoiceFields {
  const s = flat(text).slice(0, 20000)
  const out: AttachmentInvoiceFields = { invoiceNo: null, invoiceCode: null, issueDate: null, total: null, tax: null, currency: null, seller: null, buyer: null }
  const zh = /发票号码|价税合计|开票日期|发票代码/.test(s)

  out.invoiceNo = /发票号码\s*:?\s*(\d{8,20})/.exec(s)?.[1] ?? /\b(?:invoice|receipt)\s*(?:no\.?|number|num\.?|#)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-/]{2,30})/i.exec(s)?.[1] ?? null
  out.invoiceCode = /发票代码\s*:?\s*(\d{10,12})/.exec(s)?.[1] ?? null

  const zd = /开票日期\s*:?\s*(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/.exec(s)
  if (zd) out.issueDate = ymdOf(zd[1], zd[2], zd[3])
  if (!out.issueDate) {
    const ed = /\b(?:invoice\s*date|date\s*of\s*issue|issue\s*date|issued\s*on|date)\s*:?\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/i.exec(s)
    if (ed) out.issueDate = ymdOf(ed[1], ed[2], ed[3])
  }
  if (!out.issueDate) {
    const em = /\b(?:invoice\s*date|date\s*of\s*issue|issue\s*date|issued\s*on|date)\s*:?\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s)
    const mo = em ? MONTHS[em[1].toLowerCase().slice(0, em[1].toLowerCase().startsWith('sept') ? 4 : 3)] : undefined
    if (em && mo) out.issueDate = ymdOf(em[3], mo, em[2])
  }

  if (zh) {
    const t = /价税合计[\s\S]{0,80}?小写\)?\s*:?\s*¥?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/.exec(s) ?? /价税合计[^\n]{0,60}?¥\s*([0-9][0-9,]*(?:\.\d{1,2})?)/.exec(s)
    out.total = num(t?.[1])
    if (out.total != null) out.currency = 'CNY'
    out.tax = num(/(?:^|[^价])税\s*额\s*(?:合计)?\s*:\s*¥?\s*([0-9][0-9,]*\.\d{1,2})/m.exec(s)?.[1])
    for (const [key, re] of [
      ['buyer', /(?:购买方|购方|买方)(?:信息)?\s*(?:名\s*称)?\s*:?\s*(?:名\s*称\s*:?\s*)?([^\s:]{2,60})/],
      ['seller', /(?:销售方|销方|卖方)(?:信息)?\s*(?:名\s*称)?\s*:?\s*(?:名\s*称\s*:?\s*)?([^\s:]{2,60})/]
    ] as const) {
      const v = cleanName(re.exec(s)?.[1])
      if (v) out[key] = v
    }
  }
  if (out.total == null) {
    // 英文：优先 Total Due / Amount Due / Grand Total / Balance Due，最后才是单独的 Total（排除 Subtotal）
    const res = [
      /\b(?:total\s*due|amount\s*due|grand\s*total|balance\s*due|total\s*amount(?:\s*due)?|invoice\s*total)\b\s*(?:\(([A-Z]{3})\))?\s*:?\s*(US\$|HK\$|USD|EUR|GBP|CNY|RMB|JPY|HKD|SGD|AUD|CAD|\$|€|£|¥)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i,
      /(?<!sub)\btotal\b\s*(?:\(([A-Z]{3})\))?\s*:?\s*(US\$|HK\$|USD|EUR|GBP|CNY|RMB|JPY|HKD|SGD|AUD|CAD|\$|€|£|¥)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i
    ]
    for (const re of res) {
      const m = re.exec(s)
      if (!m) continue
      const n = num(m[3])
      if (n == null) continue
      out.total = n
      const cur = (m[1] || m[2] || '').toLowerCase()
      out.currency = CUR_MAP[cur] ?? (cur ? cur.toUpperCase() : null)
      break
    }
    if (out.tax == null) out.tax = num(/\b(?:tax|vat|gst)\b[^\n0-9]{0,20}?([0-9][0-9,]*\.\d{1,2})/i.exec(s)?.[1])
  }
  if (!out.buyer) out.buyer = cleanName(/\b(?:bill(?:ed)?\s*to|buyer|customer|sold\s*to)\s*:\s*([^\n]{2,80})/i.exec(s)?.[1])
  if (!out.seller) out.seller = cleanName(/\b(?:from|seller|vendor|supplier|issued\s*by)\s*:\s*([^\n]{2,80})/i.exec(s)?.[1])
  return out
}

/** 至少抽到了金额或发票号 */
export function hasInvoiceFields(f: AttachmentInvoiceFields | null | undefined): f is AttachmentInvoiceFields {
  return !!f && (f.total != null || !!f.invoiceNo)
}

// ---------------------------------------------------------------- 财务核对

const normRef = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

export function fmtAmount(n: number, currency?: string | null): string {
  const cur = (currency || 'CNY').toUpperCase()
  const v = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return cur === 'CNY' ? `¥${v}` : `${cur} ${v}`
}

/**
 * 财务记录 vs 发票 PDF：金额（±0.01）与发票号（只比字母数字）各比一次，任一不符即 matched=false；
 * 记录里缺的一方不算矛盾（note 里写明 PDF 上的值）。PDF 既无金额也无发票号时返回 null（无从核对）。
 */
export function checkAgainstPdf(
  rec: { amount: number | null | undefined; currency?: string | null; invoiceNo?: string | null },
  f: AttachmentInvoiceFields | null | undefined,
  attachmentId?: string | null,
  now = Date.now()
): FinancePdfCheck | null {
  if (!hasInvoiceFields(f)) return null
  const notes: string[] = []
  let matched = true
  const cur = f.currency || rec.currency || 'CNY'
  if (f.total != null && rec.amount != null) {
    if (Math.abs(f.total - rec.amount) >= 0.01) {
      matched = false
      notes.push(`金额不符：记录 ${fmtAmount(rec.amount, rec.currency)} · PDF ${fmtAmount(f.total, cur)}`)
    } else notes.push('金额一致')
  } else if (f.total != null) notes.push(`记录未识别金额，PDF 为 ${fmtAmount(f.total, cur)}`)
  if (f.invoiceNo && rec.invoiceNo) {
    if (normRef(f.invoiceNo) !== normRef(rec.invoiceNo)) {
      matched = false
      notes.push(`发票号不符：记录 ${rec.invoiceNo} · PDF ${f.invoiceNo}`)
    } else notes.push('发票号一致')
  } else if (f.invoiceNo) notes.push(`PDF 发票号 ${f.invoiceNo}`)
  return { amount: f.total ?? null, invoiceNo: f.invoiceNo ?? null, matched, note: notes.join('；'), attachmentId: attachmentId ?? null, checkedAt: now }
}

/** 两次核对结果是否等价（避免无意义的写库 / 刷新） */
export function samePdfCheck(a: FinancePdfCheck | null | undefined, b: FinancePdfCheck | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.amount === b.amount && (a.invoiceNo ?? null) === (b.invoiceNo ?? null) && a.matched === b.matched && (a.note ?? '') === (b.note ?? '') && (a.attachmentId ?? null) === (b.attachmentId ?? null)
}
