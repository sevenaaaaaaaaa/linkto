/**
 * 极简 HTML 工具（纯函数，无 DOM 依赖，主进程与单测共用）：
 *  - 实体解码（命名 / 十进制 / 十六进制）
 *  - 容错的 HTML 解析成树（空元素、原始文本元素、常见的隐式闭合）
 *  - 白名单消毒并序列化（订阅正文 / 全文抓取一律经过这里；渲染端再走一遍邮件消毒）
 *  - 纯文本提取
 */

// ---------------------------------------------------------------- 实体

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', middot: '·', bull: '•', deg: '°', plusmn: '±', times: '×', divide: '÷', micro: 'µ', para: '¶', sect: '§',
  cent: '¢', pound: '£', yen: '¥', euro: '€', curren: '¤', iexcl: '¡', iquest: '¿', shy: '­', zwj: '‍', zwnj: '‌', lrm: '‎', rlm: '‏',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐', hArr: '⇔', minus: '−', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞',
  frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', ordf: 'ª', ordm: 'º', not: '¬', macr: '¯', acute: '´', cedil: '¸', uml: '¨',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù',
  uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß', Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ', Ograve: 'Ò',
  Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', alpha: 'α', beta: 'β',
  gamma: 'γ', delta: 'δ', epsilon: 'ε', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', omega: 'ω', Delta: 'Δ', Omega: 'Ω', hearts: '♥', check: '✓'
}

/** 解码 HTML / XML 实体；未知实体原样保留 */
export function decodeEntities(s: string): string {
  if (!s || s.indexOf('&') < 0) return s
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�'
      return String.fromCodePoint(code)
    }
    const v = NAMED[body] ?? NAMED[body.toLowerCase()]
    if (v === undefined) return m
    // 没有分号的命名实体只认最常见的几个（避免把 URL 里的 &copy_id 误解）
    if (!m.endsWith(';') && !['amp', 'lt', 'gt', 'quot', 'nbsp'].includes(body)) return m
    return v
  })
}

export function escapeHtml(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------- 树

export interface HNode {
  type: 'el'
  name: string
  attrs: Record<string, string>
  children: (HNode | HText)[]
  parent: HNode | null
}

export interface HText {
  type: 'text'
  text: string
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen'])
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'template', 'iframe', 'noembed', 'noframes'])
/** 碰到这些开始标签时，打开着的 <p> 自动闭合 */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul'
])

function el(name: string, attrs: Record<string, string>, parent: HNode | null): HNode {
  return { type: 'el', name, attrs, children: [], parent }
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const k = m[1].toLowerCase()
    if (k in attrs) continue
    attrs[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return attrs
}

/** 容错解析 HTML：返回一个虚拟根节点（name='#root'） */
export function parseHtml(html: string): HNode {
  const root = el('#root', {}, null)
  let cur = root
  const s = String(html ?? '')
  let i = 0
  const n = s.length
  const pushText = (t: string) => {
    if (!t) return
    const last = cur.children[cur.children.length - 1]
    const text = decodeEntities(t)
    if (last && last.type === 'text') last.text += text
    else cur.children.push({ type: 'text', text })
  }
  const popTo = (name: string, boundary?: Set<string>): boolean => {
    for (let p: HNode | null = cur; p && p !== root; p = p.parent) {
      if (p.name === name) {
        cur = p.parent ?? root
        return true
      }
      if (boundary?.has(p.name)) return false
    }
    return false
  }
  const hasOpen = (name: string, boundary: Set<string>): boolean => {
    for (let p: HNode | null = cur; p && p !== root; p = p.parent) {
      if (p.name === name) return true
      if (boundary.has(p.name)) return false
    }
    return false
  }
  const LIST_B = new Set(['ul', 'ol', 'menu', 'table', 'div', 'section', 'article'])
  const DL_B = new Set(['dl', 'table', 'div'])
  const TR_B = new Set(['table', 'thead', 'tbody', 'tfoot'])
  const TD_B = new Set(['tr', 'table'])

  while (i < n) {
    const lt = s.indexOf('<', i)
    if (lt < 0) {
      pushText(s.slice(i))
      break
    }
    if (lt > i) pushText(s.slice(i, lt))
    i = lt
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9)
      const t = s.slice(i + 9, end < 0 ? n : end)
      cur.children.push({ type: 'text', text: t })
      i = end < 0 ? n : end + 3
      continue
    }
    if (s[i + 1] === '!' || s[i + 1] === '?') {
      const end = s.indexOf('>', i + 2)
      i = end < 0 ? n : end + 1
      continue
    }
    if (s[i + 1] === '/') {
      const m = /^<\/\s*([a-zA-Z][\w:-]*)\s*[^>]*>/.exec(s.slice(i, i + 200))
      if (!m) {
        pushText('<')
        i++
        continue
      }
      const name = m[1].toLowerCase()
      popTo(name)
      i += m[0].length
      continue
    }
    const m = /^<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/.exec(s.slice(i, i + 8000))
    if (!m) {
      pushText('<')
      i++
      continue
    }
    const name = m[1].toLowerCase()
    const attrs = parseAttrs(m[2])
    i += m[0].length
    // 隐式闭合
    if (CLOSES_P.has(name)) popTo('p', new Set(['button', 'table', 'td', 'th', 'li', 'blockquote', 'div', 'section', 'article']))
    if (name === 'li' && hasOpen('li', LIST_B)) popTo('li', LIST_B)
    if ((name === 'dt' || name === 'dd') && (hasOpen('dt', DL_B) || hasOpen('dd', DL_B))) {
      if (!popTo('dd', DL_B)) popTo('dt', DL_B)
    }
    if (name === 'tr' && hasOpen('tr', TR_B)) popTo('tr', TR_B)
    if ((name === 'td' || name === 'th') && (hasOpen('td', TD_B) || hasOpen('th', TD_B))) {
      if (!popTo('td', TD_B)) popTo('th', TD_B)
    }
    if (name === 'option' && hasOpen('option', new Set(['select']))) popTo('option')
    const node = el(name, attrs, cur)
    cur.children.push(node)
    if (VOID.has(name) || m[3] === '/') continue
    if (RAW.has(name)) {
      const re = new RegExp(`</${name}\\s*>`, 'i')
      const rest = s.slice(i)
      const mm = re.exec(rest)
      const raw = mm ? rest.slice(0, mm.index) : rest
      if (raw) node.children.push({ type: 'text', text: name === 'title' || name === 'textarea' ? decodeEntities(raw) : raw })
      i += mm ? mm.index + mm[0].length : rest.length
      continue
    }
    cur = node
  }
  return root
}

// ---------------------------------------------------------------- 查询

export function walk(node: HNode, fn: (n: HNode) => void | false) {
  for (const c of node.children) {
    if (c.type !== 'el') continue
    if (fn(c) === false) continue
    walk(c, fn)
  }
}

export function findAll(node: HNode, pred: (n: HNode) => boolean): HNode[] {
  const out: HNode[] = []
  walk(node, n => {
    if (pred(n)) out.push(n)
  })
  return out
}

export function findFirst(node: HNode, pred: (n: HNode) => boolean): HNode | null {
  let hit: HNode | null = null
  walk(node, n => {
    if (hit) return false
    if (pred(n)) {
      hit = n
      return false
    }
  })
  return hit
}

const BLOCK_TEXT = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'section', 'article', 'header', 'footer', 'table', 'ul', 'ol', 'dt', 'dd', 'figure', 'figcaption', 'hr'])
const SKIP_TEXT = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'iframe', 'svg', 'math'])

/** 节点纯文本（块级元素之间换行，空白折叠） */
export function textOf(node: HNode | HText): string {
  const parts: string[] = []
  const rec = (x: HNode | HText) => {
    if (x.type === 'text') {
      parts.push(x.text)
      return
    }
    if (SKIP_TEXT.has(x.name)) return
    if (x.name === 'br') {
      parts.push('\n')
      return
    }
    const block = BLOCK_TEXT.has(x.name)
    if (block) parts.push('\n')
    for (const c of x.children) rec(c)
    if (block) parts.push('\n')
  }
  rec(node)
  return parts
    .join('')
    .replace(/[ \t\f\v \r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** HTML 片段 → 纯文本 */
export function htmlToText(html: string): string {
  return textOf(parseHtml(html))
}

// ---------------------------------------------------------------- 链接

/** 相对链接 → 绝对；只放行 http / https（mailto 由调用方单独决定） */
export function absUrl(href: string | null | undefined, base: string | null | undefined, allowMailto = false): string | null {
  const raw = String(href ?? '').trim()
  if (!raw) return null
  if (allowMailto && /^mailto:/i.test(raw)) return raw
  try {
    const u = base ? new URL(raw, base) : new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 消毒

/** 允许保留的元素（其余元素去壳保留子内容；DROP 中的连内容一起丢） */
const ALLOW = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'section', 'article', 'header', 'footer', 'aside'
])
const DROP = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea', 'option', 'link', 'meta', 'base', 'frame',
  'frameset', 'noscript', 'template', 'svg', 'math', 'canvas', 'audio', 'video', 'head', 'title', 'dialog', 'portal', 'slot', 'noembed', 'noframes', 'xmp'
])
/** 降级成 div 的语义块（避免把文章页的 header / aside 结构样式带进来） */
const AS_DIV = new Set(['section', 'article', 'header', 'footer', 'aside'])

export interface SanitizeOptions {
  /** 相对链接的基准 */
  base?: string | null
  /** 丢掉的图片（如 1×1 跟踪像素）判定 */
  dropTinyImages?: boolean
}

function cleanAttrs(n: HNode, opts: SanitizeOptions): Record<string, string> {
  const a = n.attrs
  const out: Record<string, string> = {}
  if (n.name === 'a') {
    const href = absUrl(a.href, opts.base, true)
    if (href) out.href = href
    if (a.title) out.title = a.title
  } else if (n.name === 'img') {
    const src = absUrl(a.src || a['data-src'] || a['data-original'] || a['data-lazy-src'], opts.base)
    if (src) out.src = src
    if (a.alt) out.alt = a.alt
    if (a.title) out.title = a.title
    for (const k of ['width', 'height']) if (/^\d{1,4}$/.test(a[k] ?? '')) out[k] = a[k]
  } else if (n.name === 'td' || n.name === 'th') {
    for (const k of ['colspan', 'rowspan']) if (/^\d{1,3}$/.test(a[k] ?? '')) out[k] = a[k]
  } else if (n.name === 'time') {
    if (a.datetime) out.datetime = a.datetime
  } else if (n.name === 'ol') {
    if (/^\d{1,6}$/.test(a.start ?? '')) out.start = a.start
  }
  return out
}

function serializeAttrs(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join('')
}

/** 白名单消毒：去脚本 / 样式 / 事件 / 表单 / 内嵌框架，链接改成绝对地址并只留 http(s) / mailto */
export function sanitizeNode(node: HNode, opts: SanitizeOptions = {}): string {
  const out: string[] = []
  const rec = (x: HNode | HText) => {
    if (x.type === 'text') {
      out.push(escapeHtml(x.text))
      return
    }
    const name = x.name
    if (DROP.has(name) || name.includes(':')) return
    if (!ALLOW.has(name)) {
      for (const c of x.children) rec(c)
      return
    }
    if (name === 'img') {
      const attrs = cleanAttrs(x, opts)
      if (!attrs.src) return
      if (opts.dropTinyImages && Number(attrs.width) <= 2 && Number(attrs.height) <= 2 && attrs.width && attrs.height) return
      out.push(`<img${serializeAttrs(attrs)} loading="lazy">`)
      return
    }
    if (name === 'br' || name === 'hr') {
      out.push(`<${name}>`)
      return
    }
    const tag = AS_DIV.has(name) ? 'div' : name
    const attrs = cleanAttrs(x, opts)
    out.push(`<${tag}${serializeAttrs(attrs)}>`)
    for (const c of x.children) rec(c)
    out.push(`</${tag}>`)
  }
  for (const c of node.children) rec(c)
  return out.join('')
}

export function sanitizeHtml(html: string, opts: SanitizeOptions = {}): string {
  return sanitizeNode(parseHtml(html), opts)
    .replace(/(<p>\s*<\/p>)+/g, '')
    .trim()
}

/** 纯文本 → 安全 HTML 段落 */
export function textToHtml(text: string): string {
  return String(text ?? '')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}
