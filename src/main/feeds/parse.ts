import type { FeedEnclosure, FeedFormat } from '@shared/feeds'
import { absUrl, decodeEntities, escapeHtml, htmlToText, sanitizeHtml } from './html'

/**
 * 订阅解析（纯函数，单测覆盖）：RSS 2.0 / RSS 0.9x、RSS 1.0（RDF）、Atom 1.0 / 0.3、JSON Feed 1.x。
 *  - 自己写的容错 XML 解析：CDATA、实体、注释、处理指令、DOCTYPE、命名空间前缀、未闭合标签
 *  - 编码：BOM → Content-Type charset → <?xml encoding?> / <meta charset>（GBK / GB18030 / Big5 / Shift_JIS …）
 *  - 相对链接按 xml:base / 条目链接 / 订阅地址解析为绝对地址
 *  - 正文一律白名单消毒
 */

export interface ParsedItem {
  guid: string | null
  url: string | null
  title: string
  author: string | null
  /** 已消毒的 HTML */
  contentHtml: string
  /** 纯文本摘要（≤ 300 字） */
  summary: string
  publishedAt: number | null
  updatedAt: number | null
  enclosures: FeedEnclosure[]
}

export interface ParsedFeed {
  format: FeedFormat
  title: string
  siteUrl: string | null
  description: string | null
  items: ParsedItem[]
}

export class FeedParseError extends Error {
  constructor(
    message: string,
    public readonly kind: 'html' | 'empty' | 'invalid' = 'invalid'
  ) {
    super(message)
    this.name = 'FeedParseError'
  }
}

// ---------------------------------------------------------------- 编码

const LABELS: Record<string, string> = {
  gb2312: 'gbk', gbk: 'gbk', 'x-gbk': 'gbk', cp936: 'gbk', gb18030: 'gb18030', big5: 'big5', 'big5-hkscs': 'big5', 'shift_jis': 'shift_jis', sjis: 'shift_jis',
  'euc-jp': 'euc-jp', 'euc-kr': 'euc-kr', 'iso-8859-1': 'windows-1252', latin1: 'windows-1252', 'windows-1252': 'windows-1252', 'utf8': 'utf-8', 'utf-8': 'utf-8',
  'utf-16': 'utf-16le', 'utf-16le': 'utf-16le', 'utf-16be': 'utf-16be', 'koi8-r': 'koi8-r', 'windows-1251': 'windows-1251'
}

function normLabel(l: string | null | undefined): string | null {
  const k = String(l ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '')
  if (!k) return null
  return LABELS[k] ?? k
}

function tryDecode(bytes: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes)
  } catch {
    return null
  }
}

/** 字节 → 字符串：BOM > HTTP charset > 文档内声明 > UTF-8 */
export function decodeBody(bytes: Uint8Array, contentType?: string | null): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3))
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return tryDecode(bytes.subarray(2), 'utf-16le') ?? ''
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return tryDecode(bytes.subarray(2), 'utf-16be') ?? ''
  const fromHeader = normLabel(/charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1])
  // 文档内声明只看前 2KB（ASCII 兼容编码下声明本身是 ASCII）
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
  const fromXml = normLabel(/<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1])
  const fromMeta = normLabel(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1])
  for (const label of [fromHeader, fromXml, fromMeta]) {
    if (!label) continue
    const s = tryDecode(bytes, label)
    if (s != null) return s
  }
  return new TextDecoder('utf-8').decode(bytes)
}

// ---------------------------------------------------------------- XML

export interface XNode {
  name: string
  attrs: Record<string, string>
  children: (XNode | string)[]
  parent: XNode | null
}

function xattrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  return attrs
}

/** 容错 XML 解析：名字一律小写；CDATA 作为原样文本；实体解码；不配对的结束标签忽略 */
export function parseXml(xml: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, children: [], parent: null }
  let cur = root
  const s = xml
  const n = s.length
  let i = 0
  const text = (t: string) => {
    if (!t) return
    const last = cur.children[cur.children.length - 1]
    if (typeof last === 'string') cur.children[cur.children.length - 1] = last + t
    else cur.children.push(t)
  }
  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt < 0) {
      text(decodeEntities(s.slice(i)))
      break
    }
    if (lt > i) text(decodeEntities(s.slice(i, lt)))
    i = lt
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9)
      text(s.slice(i + 9, end < 0 ? n : end))
      i = end < 0 ? n : end + 3
      continue
    }
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (s.startsWith('<!DOCTYPE', i) || s.startsWith('<!doctype', i)) {
      // 跳过 DOCTYPE（含内部子集 [...]）；不展开自定义实体（防实体膨胀）
      let depth = 0
      let j = i + 9
      for (; j < n; j++) {
        if (s[j] === '[') depth++
        else if (s[j] === ']') depth--
        else if (s[j] === '>' && depth <= 0) break
      }
      i = j + 1
      continue
    }
    if (s[i + 1] === '?' || s[i + 1] === '!') {
      const end = s.indexOf('>', i + 2)
      i = end < 0 ? n : end + 1
      continue
    }
    if (s[i + 1] === '/') {
      const end = s.indexOf('>', i + 2)
      const name = s.slice(i + 2, end < 0 ? n : end).trim().toLowerCase()
      i = end < 0 ? n : end + 1
      for (let p: XNode | null = cur; p && p !== root; p = p.parent) {
        if (p.name === name) {
          cur = p.parent ?? root
          break
        }
      }
      continue
    }
    const m = /^<([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/.exec(s.slice(i, i + 16000))
    if (!m) {
      text('<')
      i++
      continue
    }
    const node: XNode = { name: m[1].toLowerCase(), attrs: xattrs(m[2]), children: [], parent: cur }
    cur.children.push(node)
    i += m[0].length
    if (m[3] !== '/') cur = node
  }
  return root
}

const local = (name: string) => name.slice(name.indexOf(':') + 1)

function kids(n: XNode | null | undefined, name?: string): XNode[] {
  if (!n) return []
  const out: XNode[] = []
  for (const c of n.children) if (typeof c !== 'string' && (!name || c.name === name || local(c.name) === name)) out.push(c)
  return out
}

/** 第一个匹配的子元素：名字可带前缀（精确匹配），不带前缀的按本地名匹配 */
function child(n: XNode | null | undefined, ...names: string[]): XNode | null {
  if (!n) return null
  for (const name of names) {
    for (const c of n.children) {
      if (typeof c === 'string') continue
      if (name.includes(':') ? c.name === name : c.name === name) return c
    }
  }
  for (const name of names) {
    if (name.includes(':')) continue
    for (const c of n.children) if (typeof c !== 'string' && local(c.name) === name) return c
  }
  return null
}

export function xtext(n: XNode | null | undefined): string {
  if (!n) return ''
  let out = ''
  for (const c of n.children) out += typeof c === 'string' ? c : xtext(c)
  return out
}

/** 子元素序列化回标记（description 里没有转义的 HTML） */
function innerXml(n: XNode): string {
  let out = ''
  for (const c of n.children) {
    if (typeof c === 'string') out += escapeHtml(c)
    else {
      const attrs = Object.entries(c.attrs)
        .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
        .join('')
      out += `<${local(c.name)}${attrs}>${innerXml(c)}</${local(c.name)}>`
    }
  }
  return out
}

/** 可能含 HTML 的字段：有子元素 → 序列化；否则文本本身就是（解码后的）HTML */
function htmlOf(n: XNode | null | undefined): string {
  if (!n) return ''
  return n.children.some(c => typeof c !== 'string') ? innerXml(n) : xtext(n)
}

/** Atom 的 text construct：type=text / html / xhtml */
function atomHtml(n: XNode | null | undefined): string {
  if (!n) return ''
  const type = (n.attrs.type ?? 'text').toLowerCase()
  if (type === 'xhtml' || type.includes('xhtml')) return innerXml(n)
  if (type === 'html' || type.includes('html')) return htmlOf(n)
  return escapeHtml(xtext(n)).replace(/\n/g, '<br>')
}

const clean = (s: string | null | undefined) => decodeEntities(String(s ?? '')).replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------- 日期

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
}
const ZONES: Record<string, number> = {
  UT: 0, UTC: 0, GMT: 0, Z: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
  CET: 60, CEST: 120, BST: 60, IST: 330, JST: 540, KST: 540, HKT: 480, SGT: 480, AEST: 600, AEDT: 660, MSK: 180
}

function zoneMinutes(z: string | undefined | null): number | null {
  if (!z) return null
  const t = z.trim()
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(t)
  if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0))
  const v = ZONES[t.toUpperCase()]
  return v === undefined ? null : v
}

function build(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, zone: number | null): number | null {
  if (y < 100) y += y < 70 ? 2000 : 1900
  if (mo < 0 || mo > 11 || d < 1 || d > 31 || h > 24 || mi > 59 || s > 60) return null
  const t = zone == null ? new Date(y, mo, d, h, mi, s).getTime() : Date.UTC(y, mo, d, h, mi, s) - zone * 60_000
  return Number.isFinite(t) ? t : null
}

/** 解析订阅里各种写法的日期；时区缺省按本地时间。不合理（早于 1990 或晚于一年后）返回 null */
export function parseFeedDate(raw: string | null | undefined, now = Date.now()): number | null {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ')
  if (!s) return null
  let t: number | null = null
  let m: RegExpExecArray | null
  if ((m = /^\d{10}$/.exec(s))) t = Number(s) * 1000
  else if ((m = /^\d{13}$/.exec(s))) t = Number(s)
  else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?|[A-Za-z]{2,4})?$/.exec(s)))
    t = build(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), zoneMinutes(m[7] ? (/^[+-]\d{2}$/.test(m[7]) ? `${m[7]}00` : m[7]) : null))
  else if ((m = /^(?:[A-Za-z]{2,9}\.?,?\s*)?(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?[\s-]+(\d{2,4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([+-]\d{2}:?\d{2}|[A-Za-z]{1,5})?/.exec(s))) {
    const mo = MONTHS[m[2].toLowerCase()]
    if (mo !== undefined) t = build(+m[3], mo, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7] ? zoneMinutes(m[7]) ?? 0 : 0)
  } else if ((m = /^(?:[A-Za-z]{2,9},?\s*)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?\s*([+-]\d{2}:?\d{2}|[A-Za-z]{1,5})?$/i.exec(s))) {
    // Oct 19, 2026 08:30 PM
    const mo = MONTHS[m[1].toLowerCase()]
    let h = +(m[4] ?? 0)
    if (m[7]?.toUpperCase() === 'PM' && h < 12) h += 12
    if (m[7]?.toUpperCase() === 'AM' && h === 12) h = 0
    if (mo !== undefined) t = build(+m[3], mo, +m[2], h, +(m[5] ?? 0), +(m[6] ?? 0), m[8] ? zoneMinutes(m[8]) : null)
  } else if ((m = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(?:(上午|下午)?\s*(\d{1,2})[:：时点](\d{1,2})?(?:[:：分](\d{1,2}))?)?/.exec(s))) {
    let h = +(m[5] ?? 0)
    if (m[4] === '下午' && h < 12) h += 12
    t = build(+m[1], +m[2] - 1, +m[3], h, +(m[6] ?? 0), +(m[7] ?? 0), null)
  } else if ((m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([+-]\d{2}:?\d{2}|Z)?$/.exec(s)))
    t = build(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7] ? zoneMinutes(m[7]) : null)
  if (t == null) {
    const p = Date.parse(s)
    t = Number.isFinite(p) ? p : null
  }
  if (t == null) return null
  if (t < Date.UTC(1990, 0, 1) || t > now + 366 * 864e5) return null
  return t
}

// ---------------------------------------------------------------- 条目

function summaryOf(html: string, max = 300): string {
  const t = htmlToText(html).replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function finishItem(raw: { guid?: string | null; url?: string | null; title?: string; author?: string | null; content?: string; summary?: string; published?: string | null; updated?: string | null; enclosures?: FeedEnclosure[] }, base: string | null, now: number, strictBase = false): ParsedItem {
  const url = absUrl(raw.url, base)
  // Atom 按 xml:base 解析相对链接；RSS 没有 base 概念，按条目链接解析（多数站点的习惯）
  const itemBase = strictBase ? base : url ?? base
  const contentHtml = sanitizeHtml(raw.content || raw.summary || '', { base: itemBase, dropTinyImages: true })
  const summarySrc = raw.summary && raw.summary.trim() ? raw.summary : raw.content || ''
  const summary = summaryOf(summarySrc)
  // 标题一般是纯文本；只有像真正的行内标签时才按 HTML 取文字（避免把「Hello <World>」吃掉）
  const rawTitle = raw.title ?? ''
  let title = clean(/<\/?(b|i|em|strong|span|a|code|br|sup|sub|mark|small|u|s|font|q)(\s[^>]*)?>/i.test(rawTitle) ? htmlToText(rawTitle) : rawTitle)
  if (!title) title = summary ? (summary.length > 60 ? `${summary.slice(0, 59)}…` : summary) : '（无标题）'
  const publishedAt = parseFeedDate(raw.published, now)
  const updatedAt = parseFeedDate(raw.updated, now)
  return {
    guid: raw.guid ? clean(raw.guid).slice(0, 500) || null : null,
    url,
    title: title.slice(0, 300),
    author: raw.author ? clean(raw.author).slice(0, 120) || null : null,
    contentHtml,
    summary,
    publishedAt: publishedAt ?? updatedAt,
    updatedAt,
    enclosures: (raw.enclosures ?? [])
      .map(e => ({ ...e, url: absUrl(e.url, itemBase) ?? '' }))
      .filter(e => e.url)
      .slice(0, 8)
  }
}

function enclosureOf(n: XNode): FeedEnclosure | null {
  const url = n.attrs.url || n.attrs.href
  if (!url) return null
  const len = Number(n.attrs.length || n.attrs.filesize)
  return { url, type: n.attrs.type || (n.attrs.medium ? `${n.attrs.medium}/*` : null), length: Number.isFinite(len) && len > 0 ? len : null }
}

function xmlBase(n: XNode | null, fallback: string | null): string | null {
  const b = n?.attrs['xml:base']
  return b ? absUrl(b, fallback) ?? fallback : fallback
}

function parseRss(rss: XNode, feedUrl: string | null, now: number): ParsedFeed {
  const ch = child(rss, 'channel') ?? rss
  const linkNode = kids(ch, 'link').find(l => !l.name.includes(':')) ?? null
  const siteUrl = absUrl(xtext(linkNode).trim(), feedUrl) ?? absUrl(kids(ch, 'link').find(l => l.attrs.href && (l.attrs.rel ?? 'alternate') === 'alternate')?.attrs.href, feedUrl)
  const base = xmlBase(ch, feedUrl ?? siteUrl)
  // RSS 0.9x / 部分网站把 item 放在 rss 根下
  const items = kids(ch, 'item').length ? kids(ch, 'item') : kids(rss, 'item')
  return {
    format: 'rss',
    title: clean(xtext(child(ch, 'title'))) || siteUrl || feedUrl || '未命名订阅',
    siteUrl,
    description: clean(htmlToText(htmlOf(child(ch, 'description')))) || null,
    items: items.map(it => {
      const guidNode = child(it, 'guid')
      const guid = xtext(guidNode).trim() || null
      const links = kids(it, 'link')
      const plainLink = links.find(l => !l.name.includes(':') && (xtext(l).trim() || l.attrs.href))
      let url = plainLink ? xtext(plainLink).trim() || plainLink.attrs.href || null : links.find(l => l.attrs.href && (l.attrs.rel ?? 'alternate') === 'alternate')?.attrs.href ?? null
      if (!url && guid && guidNode?.attrs.ispermalink !== 'false' && /^https?:\/\//i.test(guid)) url = guid
      const encl = [...kids(it, 'enclosure'), ...kids(it, 'media:content').filter(x => x.attrs.url)].map(enclosureOf).filter((x): x is FeedEnclosure => !!x)
      return finishItem(
        {
          guid,
          url,
          title: xtext(child(it, 'title')),
          author: xtext(child(it, 'dc:creator', 'author')) || null,
          content: htmlOf(child(it, 'content:encoded')) || htmlOf(child(it, 'description')),
          summary: htmlOf(child(it, 'description')),
          published: xtext(child(it, 'pubdate', 'dc:date', 'published', 'issued')) || null,
          updated: xtext(child(it, 'updated', 'dc:modified', 'atom:updated')) || null,
          enclosures: encl
        },
        xmlBase(it, base),
        now
      )
    })
  }
}

function parseRdf(rdf: XNode, feedUrl: string | null, now: number): ParsedFeed {
  const ch = child(rdf, 'channel')
  const siteUrl = absUrl(xtext(child(ch, 'link')).trim(), feedUrl)
  const base = feedUrl ?? siteUrl
  const items = kids(rdf, 'item').length ? kids(rdf, 'item') : kids(ch, 'item')
  return {
    format: 'rdf',
    title: clean(xtext(child(ch, 'title'))) || siteUrl || feedUrl || '未命名订阅',
    siteUrl,
    description: clean(htmlToText(htmlOf(child(ch, 'description')))) || null,
    items: items.map(it =>
      finishItem(
        {
          guid: it.attrs['rdf:about'] || null,
          url: xtext(child(it, 'link')).trim() || it.attrs['rdf:about'] || null,
          title: xtext(child(it, 'title')),
          author: xtext(child(it, 'dc:creator')) || null,
          content: htmlOf(child(it, 'content:encoded')) || htmlOf(child(it, 'description')),
          summary: htmlOf(child(it, 'description')),
          published: xtext(child(it, 'dc:date', 'pubdate')) || null,
          updated: null
        },
        base,
        now
      )
    )
  }
}

function atomLink(n: XNode, base: string | null): string | null {
  const links = kids(n, 'link')
  const alt = links.find(l => (l.attrs.rel ?? 'alternate') === 'alternate' && (!l.attrs.type || /html/i.test(l.attrs.type))) ?? links.find(l => (l.attrs.rel ?? 'alternate') === 'alternate') ?? null
  return absUrl(alt?.attrs.href ?? (alt ? xtext(alt) : ''), base)
}

function parseAtom(feed: XNode, feedUrl: string | null, now: number): ParsedFeed {
  const base = xmlBase(feed, feedUrl)
  const siteUrl = atomLink(feed, base)
  return {
    format: 'atom',
    title: clean(htmlToText(atomHtml(child(feed, 'title')))) || siteUrl || feedUrl || '未命名订阅',
    siteUrl,
    description: clean(htmlToText(atomHtml(child(feed, 'subtitle', 'tagline')))) || null,
    items: kids(feed, 'entry').map(e => {
      const eb = xmlBase(e, base)
      const content = child(e, 'content')
      const summary = child(e, 'summary')
      const author = child(child(e, 'author'), 'name') ?? child(e, 'author') ?? child(e, 'dc:creator')
      const encl = kids(e, 'link').filter(l => l.attrs.rel === 'enclosure').map(enclosureOf).filter((x): x is FeedEnclosure => !!x)
      // content 带 src（外链正文）时只用摘要
      const contentHtml = content && !content.attrs.src ? atomHtml(content) : ''
      return finishItem(
        {
          guid: xtext(child(e, 'id')).trim() || null,
          url: atomLink(e, eb) ?? (content?.attrs.src ? absUrl(content.attrs.src, eb) : null),
          title: htmlToText(atomHtml(child(e, 'title'))),
          author: xtext(author).trim() || null,
          content: contentHtml,
          summary: atomHtml(summary),
          published: xtext(child(e, 'published', 'issued', 'created', 'dc:date')) || xtext(child(e, 'updated', 'modified')) || null,
          updated: xtext(child(e, 'updated', 'modified')) || null,
          enclosures: encl
        },
        eb,
        now,
        true
      )
    })
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseJsonFeed(j: any, feedUrl: string | null, now: number): ParsedFeed {
  if (!j || typeof j !== 'object' || !Array.isArray(j.items)) throw new FeedParseError('不是 JSON Feed（缺少 items）')
  const siteUrl = absUrl(typeof j.home_page_url === 'string' ? j.home_page_url : null, feedUrl)
  const base = feedUrl ?? siteUrl
  const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
  return {
    format: 'json',
    title: clean(str(j.title)) || siteUrl || feedUrl || '未命名订阅',
    siteUrl,
    description: clean(str(j.description)) || null,
    items: j.items
      .filter((it: any) => it && typeof it === 'object')
      .map((it: any) => {
        const author = it.authors?.[0]?.name ?? it.author?.name ?? null
        const text = str(it.content_text)
        const content = str(it.content_html) || (text ? escapeHtml(text).replace(/\n/g, '<br>') : '')
        const attachments: FeedEnclosure[] = Array.isArray(it.attachments)
          ? it.attachments.filter((a: any) => a && typeof a.url === 'string').map((a: any) => ({ url: a.url, type: typeof a.mime_type === 'string' ? a.mime_type : null, length: Number(a.size_in_bytes) || null }))
          : []
        return finishItem(
          {
            guid: it.id != null ? str(it.id) : null,
            url: str(it.url) || str(it.external_url) || null,
            title: str(it.title),
            author: author ? str(author) : null,
            content,
            summary: str(it.summary) ? escapeHtml(str(it.summary)) : '',
            published: str(it.date_published) || null,
            updated: str(it.date_modified) || null,
            enclosures: attachments
          },
          base,
          now
        )
      })
  }
}

/** 文本像不像订阅（嗅探，用于自动发现时判断用户给的是订阅地址还是网页） */
export function sniffFeed(text: string): FeedFormat | 'html' | null {
  const head = text.replace(/^﻿/, '').trimStart().slice(0, 4000)
  if (head.startsWith('{')) return /"version"\s*:\s*"https?:\/\/jsonfeed\.org/i.test(head) || /"items"\s*:/.test(head) ? 'json' : null
  const lower = head.toLowerCase()
  if (/<rss[\s>]/.test(lower)) return 'rss'
  if (/<(?:[\w-]+:)?rdf[\s>]/.test(lower) && /purl\.org\/rss\/1\.0|<item[\s>]|<channel[\s>]/.test(lower)) return 'rdf'
  if (/<(?:[\w-]+:)?feed[\s>]/.test(lower)) return 'atom'
  if (/<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/.test(lower)) return 'html'
  return null
}

/** 解析订阅正文（已解码的字符串）；feedUrl 用作相对链接基准 */
export function parseFeed(text: string, feedUrl: string | null = null, now = Date.now()): ParsedFeed {
  const s = String(text ?? '').replace(/^﻿/, '')
  if (!s.trim()) throw new FeedParseError('内容为空', 'empty')
  const trimmed = s.trimStart()
  if (trimmed.startsWith('{')) {
    let j: unknown
    try {
      j = JSON.parse(trimmed)
    } catch {
      throw new FeedParseError('JSON 格式错误')
    }
    return parseJsonFeed(j, feedUrl, now)
  }
  const doc = parseXml(s)
  const top = kids(doc).find(n => !n.name.startsWith('?'))
  if (!top) throw new FeedParseError('不是有效的订阅（没有根元素）')
  const ln = local(top.name)
  if (ln === 'rss') return parseRss(top, feedUrl, now)
  if (ln === 'rdf') return parseRdf(top, feedUrl, now)
  if (ln === 'feed') return parseAtom(top, feedUrl, now)
  if (ln === 'channel') return parseRss(top, feedUrl, now)
  if (ln === 'html' || sniffFeed(s) === 'html') throw new FeedParseError('这是网页，不是订阅地址', 'html')
  throw new FeedParseError(`不认识的订阅格式（<${top.name}>）`)
}
