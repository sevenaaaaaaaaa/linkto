/**
 * 零依赖的 HTML 小工具（主进程没有 DOM）：
 * - parseHtml：容错的轻量解析（隐式闭合 p / li / td / tr，忽略不匹配的结束标签）
 * - htmlToMarkdown：邮件正文 → Markdown（标题 / 列表 / 引用 / 链接 / 代码 / 数据表格；版式表格按块展开）
 * - htmlToPlain：→ 纯文本（摘录、flomo、Telegram）
 * - sanitizeHtml：→ 可放进剪贴板 / 备忘录的安全 HTML（去脚本、事件属性、javascript: 链接，按需拦远程图）
 * 纯函数，可单独打包单测。
 */

export interface HNode {
  tag: string
  attrs: Record<string, string>
  children: (HNode | string)[]
  parent: HNode | null
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param'])
/** 内容整段丢弃的元素 */
const DROP = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'embed', 'frameset', 'frame', 'xml', 'o:p'])
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp'])
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'center', 'address', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'hr', 'table', 'thead', 'tbody',
  'tfoot', 'tr', 'td', 'th', 'caption', 'form', 'fieldset', 'body', 'html'
])
/** 打开这些标签时隐式闭合一个未闭合的 <p> */
const CLOSES_P = new Set(['p', 'div', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr', 'section', 'article', 'header', 'footer', 'dl'])

const NAMED: Record<string, string> = {
  nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', mdash: '—', ndash: '–', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', bull: '•', yen: '¥', euro: '€', pound: '£',
  times: '×', divide: '÷', deg: '°', zwnj: '', zwj: '', shy: '', ensp: ' ', emsp: ' ', thinsp: ' ', cent: '¢', sect: '§', para: '¶'
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
      try {
        return String.fromCodePoint(code)
      } catch {
        return ''
      }
    }
    const v = NAMED[e.toLowerCase()]
    return v === undefined ? m : v
  })
}

export const escapeHtml = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const ATTR_RE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  let m: RegExpExecArray | null
  ATTR_RE.lastIndex = 0
  while ((m = ATTR_RE.exec(src))) {
    const name = m[1].toLowerCase()
    if (name in out) continue
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return out
}

/** 容错解析为节点树（根节点 tag = '#root'） */
export function parseHtml(html: string): HNode {
  const root: HNode = { tag: '#root', attrs: {}, children: [], parent: null }
  let cur = root
  const src = String(html ?? '')
  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let last = 0
  let m: RegExpExecArray | null
  const inStack = (tag: string) => {
    for (let n: HNode | null = cur; n && n !== root; n = n.parent) if (n.tag === tag) return true
    return false
  }
  const closeTo = (tag: string, stopAt?: Set<string>) => {
    for (let n: HNode | null = cur; n && n !== root; n = n.parent) {
      if (stopAt && stopAt.has(n.tag)) return
      if (n.tag === tag) {
        cur = n.parent ?? root
        return
      }
    }
  }
  while ((m = re.exec(src))) {
    if (m.index > last) cur.children.push(decodeEntities(src.slice(last, m.index)))
    last = re.lastIndex
    if (!m[2]) continue // 注释 / doctype / CDATA
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    if (closing) {
      if (inStack(tag)) closeTo(tag)
      continue
    }
    const attrStr = m[3] ?? ''
    // 隐式闭合
    if (CLOSES_P.has(tag) && inStack('p')) closeTo('p', new Set(['td', 'th', 'li', 'blockquote', 'div']))
    if (tag === 'li') closeTo('li', new Set(['ul', 'ol']))
    if (tag === 'dt' || tag === 'dd') {
      closeTo('dt', new Set(['dl']))
      closeTo('dd', new Set(['dl']))
    }
    if (tag === 'tr') closeTo('tr', new Set(['table', 'tbody', 'thead', 'tfoot']))
    if (tag === 'td' || tag === 'th') {
      closeTo('td', new Set(['tr', 'table']))
      closeTo('th', new Set(['tr', 'table']))
    }
    const node: HNode = { tag, attrs: parseAttrs(attrStr), children: [], parent: cur }
    cur.children.push(node)
    const selfClosed = /\/\s*$/.test(attrStr)
    if (VOID.has(tag) || selfClosed) continue
    if (RAW_TEXT.has(tag)) {
      // 原样文本元素：直接吃到对应结束标签
      const end = src.toLowerCase().indexOf(`</${tag}`, last)
      const stop = end < 0 ? src.length : end
      node.children.push(src.slice(last, stop))
      const close = end < 0 ? src.length : src.indexOf('>', end)
      last = close < 0 ? src.length : close + 1
      re.lastIndex = last
      continue
    }
    cur = node
  }
  if (last < src.length) cur.children.push(decodeEntities(src.slice(last)))
  return root
}

const isNode = (c: HNode | string): c is HNode => typeof c !== 'string'
const textOf = (n: HNode | string): string => (isNode(n) ? (DROP.has(n.tag) ? '' : n.children.map(textOf).join('')) : n)
const hidden = (n: HNode) => /display\s*:\s*none/i.test(n.attrs.style ?? '') || 'hidden' in n.attrs

// ---------------------------------------------------------------- Markdown

const mdEscape = (s: string) => s.replace(/([\\`*_[\]])/g, '\\$1')
const safeUrl = (u: string) => /^(https?:|mailto:|tel:)/i.test(u.trim())
const mdUrl = (u: string) => u.trim().replace(/ /g, '%20').replace(/\)/g, '%29').replace(/\(/g, '%28')

interface Ctx {
  mode: 'md' | 'text'
  pre: boolean
  listDepth: number
}

/** 行内内容（遇到块级子元素时按块拼） */
function inline(nodes: (HNode | string)[], ctx: Ctx): string {
  let out = ''
  for (const c of nodes) {
    if (!isNode(c)) {
      out += ctx.pre ? c : (ctx.mode === 'md' ? mdEscape(c) : c).replace(/[\s\u00a0]+/g, ' ')
      continue
    }
    if (DROP.has(c.tag) || hidden(c)) continue
    if (BLOCK.has(c.tag)) {
      // 块级输出用哨兵包起来：外层整理空白时原样保留（列表缩进 / 代码块）
      out += `\n\n\u0001${block(c, ctx)}\u0002\n\n`
      continue
    }
    out += inlineNode(c, ctx)
  }
  return out
}

function inlineNode(n: HNode, ctx: Ctx): string {
  const md = ctx.mode === 'md'
  const inner = () => inline(n.children, ctx)
  switch (n.tag) {
    case 'br':
      return '\n'
    case 'img': {
      const alt = (n.attrs.alt ?? '').trim()
      const src = n.attrs.src ?? ''
      if (md && /^https?:/i.test(src)) return `![${mdEscape(alt)}](${mdUrl(src)})`
      return alt ? `[${alt}]` : ''
    }
    case 'a': {
      const href = (n.attrs.href ?? '').trim()
      const t = inner().trim()
      if (!href || !safeUrl(href)) return t
      if (!md) return t && t !== href && !href.startsWith('mailto:') ? `${t}（${href}）` : t || href
      if (!t) return `<${href}>`
      if (t === mdEscape(href) || t === href) return `<${href}>`
      return `[${t.replace(/\n+/g, ' ')}](${mdUrl(href)})`
    }
    case 'strong':
    case 'b': {
      const t = inner()
      return md && t.trim() ? wrap(t, '**') : t
    }
    case 'em':
    case 'i':
    case 'cite': {
      const t = inner()
      return md && t.trim() ? wrap(t, '*') : t
    }
    case 'del':
    case 's':
    case 'strike': {
      const t = inner()
      return md && t.trim() ? wrap(t, '~~') : t
    }
    case 'code':
    case 'kbd':
    case 'tt': {
      const t = textOf(n)
      return md && t.trim() ? '`' + t.replace(/`/g, '\u02cb') + '`' : t
    }
    case 'input':
    case 'button':
    case 'select':
      return ''
    default:
      return inner()
  }
}

/** 保留首尾空白在标记外：** text ** → ** 无效 */
function wrap(t: string, mark: string): string {
  const m = t.match(/^(\s*)([\s\S]*?)(\s*)$/)!
  return `${m[1]}${mark}${m[2]}${mark}${m[3]}`
}

const tidyInline = (s: string) =>
  s
    .split(/\u0001([\s\S]*?)\u0002/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .split('\n')
            .map(l => l.replace(/[ \t]+/g, ' ').trim())
            .join('\n')
    )
    .join('')
    .replace(/\n[ \t]*\n(\s*\n)+/g, '\n\n')
    .replace(/^\s*\n|\n\s*$/g, '')

function children(n: HNode, ctx: Ctx): string {
  return tidyInline(inline(n.children, ctx))
}

function isDataTable(t: HNode): boolean {
  const rows = collect(t, 'tr', 'table')
  if (rows.length < 2) return false
  if (collect(t, 'table').length > 0) return false
  if (collect(t, 'th', 'table').length > 0) return true
  const widths = rows.map(r => r.children.filter(c => isNode(c) && (c.tag === 'td' || c.tag === 'th')).length)
  if (widths[0] < 2 || !widths.every(w => w === widths[0])) return false
  // 单元格里有块级元素的多半是版式表格
  return !rows.some(r => r.children.some(c => isNode(c) && c.children.some(x => isNode(x) && ['div', 'p', 'table', 'ul', 'ol', 'h1', 'h2', 'h3'].includes(x.tag))))
}

/** 子孙里的某标签（不穿过 stop 标签） */
function collect(n: HNode, tag: string, stop?: string): HNode[] {
  const out: HNode[] = []
  const walk = (x: HNode) => {
    for (const c of x.children) {
      if (!isNode(c)) continue
      if (c.tag === tag) out.push(c)
      if (stop && c.tag === stop) continue
      walk(c)
    }
  }
  walk(n)
  return out
}

function block(n: HNode, ctx: Ctx): string {
  if (DROP.has(n.tag) || hidden(n)) return ''
  const md = ctx.mode === 'md'
  switch (n.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const t = children(n, ctx).replace(/\n+/g, ' ')
      return t ? (md ? `${'#'.repeat(Number(n.tag[1]))} ${t}` : t) : ''
    }
    case 'hr':
      return md ? '---' : '————'
    case 'pre': {
      const t = textOf(n).replace(/\n$/, '')
      return md ? '```\n' + t.replace(/```/g, '``\u200b`') + '\n```' : t
    }
    case 'blockquote': {
      const t = children(n, ctx)
      return t ? t.split('\n').map(l => (md ? `> ${l}`.trimEnd() : `│ ${l}`.trimEnd())).join('\n') : ''
    }
    case 'ul':
    case 'ol': {
      const items = n.children.filter((c): c is HNode => isNode(c) && c.tag === 'li')
      const start = Number(n.attrs.start) || 1
      return items
        .map((li, i) => {
          const marker = n.tag === 'ol' ? `${start + i}. ` : md ? '- ' : '• '
          // 嵌套列表紧跟在条目文字后（不空行）
          const body = children(li, { ...ctx, listDepth: ctx.listDepth + 1 }).replace(/\n{2,}(?=(?:- |• |\d+\. ))/g, '\n')
          const ind = ' '.repeat(marker.length)
          return marker + body.split('\n').map((l, j) => (j === 0 || !l ? l : ind + l)).join('\n')
        })
        .filter(s => s.trim().length > 2)
        .join('\n')
    }
    case 'table': {
      if (md && isDataTable(n)) {
        const rows = collect(n, 'tr', 'table').map(r =>
          r.children
            .filter((c): c is HNode => isNode(c) && (c.tag === 'td' || c.tag === 'th'))
            .map(c => children(c, ctx).replace(/\n+/g, ' ').replace(/\|/g, '\\|'))
        )
        const w = rows[0].length
        return [`| ${rows[0].join(' | ')} |`, `|${' --- |'.repeat(w)}`, ...rows.slice(1).map(r => `| ${r.join(' | ')} |`)].join('\n')
      }
      // 版式表格：每个单元格当作一个块
      const cells = collect(n, 'tr', 'table').flatMap(r => r.children.filter((c): c is HNode => isNode(c) && (c.tag === 'td' || c.tag === 'th')))
      if (!cells.length) return children(n, ctx)
      return cells.map(c => children(c, ctx)).filter(Boolean).join('\n\n')
    }
    default:
      return children(n, ctx)
  }
}

function finalize(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 邮件 HTML → Markdown */
export function htmlToMarkdown(html: string): string {
  const root = parseHtml(html)
  const body = collect(root, 'body')[0] ?? root
  return finalize(children(body, { mode: 'md', pre: false, listDepth: 0 }))
}

/** 邮件 HTML → 纯文本（保留段落与列表结构） */
export function htmlToPlain(html: string): string {
  const root = parseHtml(html)
  const body = collect(root, 'body')[0] ?? root
  return finalize(children(body, { mode: 'text', pre: false, listDepth: 0 }))
}

// ---------------------------------------------------------------- 安全 HTML（剪贴板 / 备忘录）

const STRIP_TAGS = new Set([...DROP, 'link', 'meta', 'base', 'form', 'input', 'button', 'select', 'textarea', 'option', 'html', 'body'])
const DROP_TAGS = new Set([...DROP, 'link', 'meta', 'base', 'textarea', 'select', 'option'])

/**
 * 重新序列化为安全 HTML：只保留标签与非危险属性。
 * allowRemote=false 时 http(s) 图片与背景图被去掉；resolveImg 可把 cid: 换成 data: URI。
 */
export function sanitizeHtml(html: string, opts: { allowRemote: boolean; resolveImg?(src: string): string | null; keepStyle?: boolean }): string {
  const root = parseHtml(html)
  const ser = (c: HNode | string): string => {
    if (!isNode(c)) return escapeHtml(c).replace(/\u00a0/g, '&nbsp;')
    // 打印版（Shadow DOM 隔离）保留邮件自带的 <style>：去掉 @import / expression / 脚本 URL，远程 url() 按设置拦截
    if (c.tag === 'style' && opts.keepStyle) {
      let css = c.children.filter((x): x is string => typeof x === 'string').join('')
      css = css.replace(/@import[^;]*;?/gi, '').replace(/expression\s*\(/gi, '(').replace(/url\(\s*(['"]?)\s*(javascript|vbscript)[^)]*\)/gi, 'none').replace(/<\/?\s*style/gi, '')
      if (!opts.allowRemote) css = css.replace(/url\(\s*(['"]?)https?:[^)]*\)/gi, 'none')
      return `<style>${css}</style>`
    }
    if (c.tag === 'head' && opts.keepStyle) return c.children.filter((x): x is HNode => isNode(x) && x.tag === 'style').map(ser).join('')
    if (DROP_TAGS.has(c.tag)) return ''
    // 拦下的远程图 / 取不到的内嵌图：不留破图标，只留替代文字
    if (c.tag === 'img') {
      const src = c.attrs.src ?? ''
      const blocked = (/^https?:/i.test(src) && !opts.allowRemote) || (/^cid:/i.test(src) && !opts.resolveImg?.(src)) || !src
      if (blocked) return c.attrs.alt?.trim() ? `<span style="color:#86909c">[${escapeHtml(c.attrs.alt.trim())}]</span>` : ''
    }
    const inner = c.children.map(ser).join('')
    if (STRIP_TAGS.has(c.tag) || c.tag.includes(':')) return inner
    const attrs: string[] = []
    for (const [k, v0] of Object.entries(c.attrs)) {
      let v = v0
      if (k.startsWith('on') || k === 'srcdoc' || k === 'formaction' || k === 'xmlns' || k.includes(':')) continue
      if ((k === 'href' || k === 'src' || k === 'action' || k === 'background' || k === 'poster') && /^\s*(javascript|vbscript|data:text\/html)/i.test(v)) continue
      if (k === 'src' && c.tag === 'img') {
        if (/^cid:/i.test(v)) {
          const r = opts.resolveImg?.(v) ?? null
          if (!r) continue
          v = r
        } else if (/^https?:/i.test(v) && !opts.allowRemote) continue
        else if (!/^(https?:|data:image\/)/i.test(v)) continue
      }
      if (k === 'background' && (!opts.allowRemote || !/^https?:/i.test(v))) continue
      if (k === 'style') {
        v = v.replace(/expression\s*\(/gi, '(').replace(/url\(\s*(['"]?)\s*(javascript|vbscript)[^)]*\)/gi, 'none')
        if (!opts.allowRemote) v = v.replace(/url\(\s*(['"]?)https?:[^)]*\)/gi, 'none')
      }
      attrs.push(` ${k}="${escapeHtml(v)}"`)
    }
    if (c.tag === 'a' && attrs.some(a => a.startsWith(' href='))) attrs.push(' rel="noopener noreferrer"')
    const open = `<${c.tag}${attrs.join('')}>`
    return VOID.has(c.tag) ? open : `${open}${inner}</${c.tag}>`
  }
  return root.children.map(ser).join('')
}

/** 正文摘录：去空白后截到 max 字，尽量在句末断开 */
export function excerpt(text: string, max: number): string {
  const t = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
  const chars = [...t]
  if (chars.length <= max) return t
  const cut = chars.slice(0, max).join('')
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('. '), cut.lastIndexOf('\n'), cut.lastIndexOf('！'), cut.lastIndexOf('？'))
  return (stop > max * 0.6 ? cut.slice(0, stop + 1) : cut).trimEnd() + '…'
}
