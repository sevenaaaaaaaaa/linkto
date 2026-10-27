/** IMAP/MIME 共用解码：UTF-8 手写回退、RFC2047 头、latin1 裸 UTF-8 修复 */

export function decodeUtf8Bytes(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  const n = bytes.length
  while (i < n) {
    const b = bytes[i]
    if (b < 0x80) { out += String.fromCharCode(b); i++ }
    else if (b >= 0xC2 && b < 0xE0 && i + 1 < n && (bytes[i + 1] & 0xC0) === 0x80) {
      out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F)); i += 2
    } else if (b >= 0xE0 && b < 0xF0 && i + 2 < n && (bytes[i + 1] & 0xC0) === 0x80 && (bytes[i + 2] & 0xC0) === 0x80) {
      out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)); i += 3
    } else if (b >= 0xF0 && b < 0xF5 && i + 3 < n && (bytes[i + 1] & 0xC0) === 0x80 && (bytes[i + 2] & 0xC0) === 0x80 && (bytes[i + 3] & 0xC0) === 0x80) {
      const cp = (((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F)) - 0x10000
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); i += 4
    } else { out += '\uFFFD'; i++ }
  }
  return out
}

export function decodeBytes(bytes: Uint8Array, charset: string): string {
  const cs = (charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '')
  try {
    const Decoder = TextDecoder as unknown as new (enc: string) => TextDecoder
    return new Decoder(cs).decode(bytes)
  } catch {
    if (/^utf-?8$/.test(cs)) return decodeUtf8Bytes(bytes)
    try {
      const Decoder = TextDecoder as unknown as new (enc: string) => TextDecoder
      return new Decoder('latin1').decode(bytes)
    } catch {
      return String.fromCharCode(...Array.from(bytes))
    }
  }
}

/** RFC2047: =?charset?B/Q?data?= */
export function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc2: string, data: string) => {
    try {
      const charset = cs.toLowerCase()
      const bytes =
        enc2.toLowerCase() === 'b'
          ? Uint8Array.from(atob(data), c => c.charCodeAt(0))
          : Uint8Array.from(
              data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))),
              c => c.charCodeAt(0)
            )
      return decodeBytes(bytes, charset)
    } catch {
      return data
    }
  })
}

/** 服务端以裸 UTF-8（非 RFC2047）发头时的 latin1→utf8 修复 */
export function fixUtf8(s: string): string {
  if (!/[\u0080-\u00ff]/.test(s)) return s
  const bytes = Uint8Array.from(s.split('').map(c => c.charCodeAt(0)))
  const out = decodeUtf8Bytes(bytes)
  return out.includes('\uFFFD') ? s : out
}

export function binaryFromBytes(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...Array.from(bytes.subarray(i, i + 8192)))
  return out
}

export function bytesFromBinary(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

export function b64FromBinary(s: string): string {
  return btoa(s)
}

export function binaryFromB64(b64: string): string {
  return atob(b64.replace(/\s+/g, ''))
}

export function b64urlEncode(bytes: Uint8Array): string {
  return b64FromBinary(binaryFromBytes(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  return bytesFromBinary(binaryFromB64(b64))
}
