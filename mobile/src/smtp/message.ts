export interface OutgoingMail {
  from: string
  to: string[]
  cc?: string[]
  subject: string
  text: string
  inReplyTo?: string
  references?: string
}

function utf8ToBinary(s: string): string {
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x80) out += String.fromCharCode(cp)
    else if (cp < 0x800) out += String.fromCharCode(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F))
    else if (cp < 0x10000) out += String.fromCharCode(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F))
    else out += String.fromCharCode(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F))
  }
  return out
}

function b64(s: string): string {
  return btoa(utf8ToBinary(s))
}

function encodeHeader(s: string): string {
  return /^[\x20-\x7E]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?='
}

function nowRfc2822(): string {
  return new Date().toUTCString().replace(/GMT$/, '+0000')
}

/** 纯文本邮件（UTF-8 base64），带 Date/Message-ID/In-Reply-To；做 dot-stuffing */
export function buildMessage(mail: OutgoingMail, now = Date.now()): string {
  const id = '<' + now.toString(36) + '.' + Math.random().toString(36).slice(2, 10) + '@linkto.mobile>'
  const bodyB64 = b64(mail.text).replace(/(.{76})/g, '$1\r\n')
  const headers = [
    'From: ' + mail.from,
    'To: ' + mail.to.join(', '),
    ...(mail.cc?.length ? ['Cc: ' + mail.cc.join(', ')] : []),
    'Subject: ' + encodeHeader(mail.subject),
    'Date: ' + nowRfc2822(),
    'Message-ID: ' + id,
    ...(mail.inReplyTo ? ['In-Reply-To: ' + mail.inReplyTo] : []),
    ...(mail.references ? ['References: ' + mail.references] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64'
  ]
  const raw = headers.join('\r\n') + '\r\n\r\n' + bodyB64 + '\r\n'
  return raw
    .split('\r\n')
    .map(line => (line.startsWith('.') ? '.' + line : line))
    .join('\r\n')
}

/** RFC 5322 地址提取（用于回复时的收件人） */
export function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/)
  return (m ? m[1] : from).trim()
}
