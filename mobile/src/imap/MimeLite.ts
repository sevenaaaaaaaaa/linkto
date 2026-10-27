import { binaryFromB64, bytesFromBinary, decodeBytes, decodeWords } from './encoding'

export interface ParsedAttachment {
  filename: string
  contentType: string
  size: number
  contentId?: string
  inline: boolean
}

export interface ParsedMail {
  html: string | null
  text: string | null
  attachments: ParsedAttachment[]
}

interface HeaderMap {
  [key: string]: string
}

interface ContentType {
  type: string
  params: Record<string, string>
}

function splitHeadersBody(raw: string): { head: string; body: string } {
  const i1 = raw.indexOf('\r\n\r\n')
  const i2 = raw.indexOf('\n\n')
  const i = i1 >= 0 && (i2 < 0 || i1 < i2) ? i1 : i2
  if (i < 0) return { head: raw, body: '' }
  return { head: raw.slice(0, i), body: raw.slice(i + (i === i1 ? 4 : 2)) }
}

function parseHeaders(head: string): HeaderMap {
  const out: HeaderMap = {}
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    out[key] = out[key] ? out[key] + ' ' + m[2] : m[2]
  }
  return out
}

export function parseContentType(value: string | undefined): ContentType {
  const raw = (value ?? '').trim()
  if (!raw) return { type: 'text/plain', params: {} }
  const [type, ...rest] = raw.split(';')
  const params: Record<string, string> = {}
  for (const piece of rest) {
    const eq = piece.indexOf('=')
    if (eq < 0) continue
    const key = piece.slice(0, eq).trim().toLowerCase()
    let v = piece.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1')
    params[key] = v
  }
  return { type: (type || 'text/plain').trim().toLowerCase(), params }
}

function decodeTransfer(body: string, encoding: string): string {
  const enc = (encoding || '').toLowerCase().trim()
  if (enc === 'base64') return binaryFromB64(body)
  if (enc === 'quoted-printable') {
    return body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
  }
  return body
}

function toText(binary: string, charset: string): string {
  return decodeBytes(bytesFromBinary(binary), charset || 'utf-8')
}

function filenameOf(headers: HeaderMap, partType: string): string {
  const ct = parseContentType(headers['content-type'])
  const cd = parseContentType(headers['content-disposition'])
  const name = cd.params.filename ?? ct.params.name ?? ''
  if (name) return decodeWords(name)
  return '附件.' + (partType.split('/')[1] || 'bin')
}

/** 阅读用 HTML 消毒：脚本/iframe/事件属性/javascript: 全部去掉；WebView 里还会关闭 JS */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/<object\b[\s\S]*?<\/object\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '')
}

/** 把 HTML 包成适合手机/iPad 阅读的完整文档；showImages=false 时 CSP 只允许 data: 图片 */
export function wrapHtml(html: string, opts: { showImages: boolean; dark?: boolean }): string {
  const bg = opts.dark ? '#14181b' : '#fffdf7'
  const fg = opts.dark ? '#e8e6df' : '#1f2226'
  const csp = opts.showImages
    ? "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src data:;"
    : "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;"
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
    '<style>' +
    'html,body{margin:0;padding:0;background:' + bg + ';color:' + fg + ';}' +
    'body{font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:16px 18px 40px;word-wrap:break-word;overflow-wrap:anywhere;}' +
    'img{max-width:100%!important;height:auto!important;border-radius:8px;}' +
    'table{max-width:100%!important;border-collapse:collapse;display:block;overflow-x:auto;}' +
    'pre{white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,.04);padding:10px;border-radius:8px;}' +
    'blockquote{margin:8px 0;padding-left:12px;border-left:2px solid rgba(0,129,126,.35);color:inherit;opacity:.85;}' +
    'a{color:' + (opts.dark ? '#6fd6cf' : '#006265') + ';}' +
    '</style></head><body>' + sanitizeHtml(html) + '</body></html>'
}

function parsePart(headers: HeaderMap, body: string): ParsedMail {
  const ct = parseContentType(headers['content-type'])
  const transfer = headers['content-transfer-encoding'] ?? ''

  if (ct.type.startsWith('multipart/') && ct.params.boundary) {
    const boundary = ct.params.boundary
    const parts = body.split('--' + boundary)
    const parsed: ParsedMail[] = []
    for (let i = 0; i < parts.length; i++) {
      let p = parts[i]
      if (i === 0) {
        const nl = p.indexOf('\r\n')
        if (nl >= 0) p = p.slice(nl + 2)
        else continue
      }
      if (p.startsWith('--')) break
      const { head, body: partBody } = splitHeadersBody(p)
      parsed.push(parsePart(parseHeaders(head), partBody))
    }
    const html = parsed.map(p => p.html).filter(Boolean).pop() ?? null
    const text = parsed.map(p => p.text).filter(Boolean).join('\n\n') || null
    return { html, text, attachments: parsed.flatMap(p => p.attachments) }
  }

  const binary = decodeTransfer(body, transfer)
  const charset = ct.params.charset ?? 'utf-8'

  if (ct.type === 'text/html') {
    return { html: toText(binary, charset), text: null, attachments: [] }
  }
  if (ct.type === 'text/plain' || ct.type === '') {
    const text = toText(binary, charset).replace(/\r\n/g, '\n').trim()
    return { html: null, text, attachments: [] }
  }

  const disposition = parseContentType(headers['content-disposition'])
  const contentId = (headers['content-id'] ?? '').replace(/^<|>$/g, '').trim()
  return {
    html: null,
    text: null,
    attachments: [{
      filename: filenameOf(headers, ct.type),
      contentType: ct.type,
      size: binary.length,
      ...(contentId ? { contentId } : {}),
      inline: disposition.type === 'inline' || !!contentId
    }]
  }
}

/** 解析 IMAP 取回的完整 MIME 消息（raw 为 latin1 二进制字符串） */
export function parseMime(rawInput: string): ParsedMail {
  const raw = rawInput.replace(/\u0000LIT\u0000/g, '')
  const { head, body } = splitHeadersBody(raw)
  return parsePart(parseHeaders(head), body)
}
