import { gcm } from '@noble/ciphers/aes.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js'
import { linkToCore } from '../native/LinkToCore'
import {
  b64FromBinary,
  b64urlDecode,
  b64urlEncode,
  binaryFromB64,
  binaryFromBytes,
  bytesFromBinary
} from '../imap/encoding'
import { WORDS } from './words'

/**
 * 萤火密信 v2 移动端实现 —— 与桌面 src/main/fly/core.ts 字节级兼容。
 *
 *  - 无长期身份：信箱号 16B 随机；链接模式的 32B 密钥只在 URL fragment
 *  - link-code：6 词口令 + 随机 salt 派生密钥；code：固定 salt，口令决定信箱
 *  - AES-256-GCM，AAD 绑定 m|mb|s|iat|ttl；正文按 256B…48KB 档位填充
 *  - PBKDF2-SHA256 600k；code 模式优先走原生（固定 UTF-8 salt），
 *    link-code 的随机字节 salt 走 @noble 异步派生，避免阻塞 JS 线程
 */

export const FLY_APP = 'linkto-fly'
export const FLY_VERSION = 2
export const CODE_WORDS = 6
export const PBKDF2_ITERATIONS = 600_000
export const MIN_TTL_SECONDS = 60
export const MAX_TTL_SECONDS = 7 * 24 * 3600

const CODE_SALT = 'linkto-fly/code/v2'
const MBOX_LABEL = 'linkto-fly/mbox/v2'
const BUCKETS = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 49152]
const MAX_PLAINTEXT_BYTES = 40_000

export type FlyMode = 'link' | 'link-code' | 'code'

export interface FlyEnvelopeHeader {
  app: typeof FLY_APP
  v: typeof FLY_VERSION
  m: FlyMode
  mb: string
  s?: string
  i: string
  c: string
  t: string
  iat: number
  ttl: number
}

export interface SealedFly {
  envelope: string
  mode: FlyMode
  mbox: string
  keyB64?: string
  code?: string
  expiresAt: number
}

export interface OpenedFly {
  text: string
  mode: FlyMode
  mbox: string
  expiresAt: number
}

export type FlyErrorCode =
  | 'bad-input'
  | 'bad-envelope'
  | 'wrong-code'
  | 'tampered'
  | 'expired'
  | 'too-long'
  | 'missing-secret'

export class FlyError extends Error {
  readonly code: FlyErrorCode
  constructor(code: FlyErrorCode, message: string) {
    super(message)
    this.name = 'FlyError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// 字节 / 编码
// ---------------------------------------------------------------------------

function utf8ToBytes(s: string): Uint8Array {
  const out: number[] = []
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F))
    else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F))
    else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F))
  }
  return Uint8Array.from(out)
}

function bytesToUtf8(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b < 0x80) { out += String.fromCharCode(b); i++ }
    else if (b >= 0xC2 && b < 0xE0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F)); i += 2
    } else if (b >= 0xE0 && b < 0xF0 && i + 2 < bytes.length) {
      out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)); i += 3
    } else if (b >= 0xF0 && b < 0xF5 && i + 3 < bytes.length) {
      const cp = (((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F)) - 0x10000
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); i += 4
    } else { out += '\uFFFD'; i++ }
  }
  return out
}

function b64(bytes: Uint8Array): string { return b64FromBinary(binaryFromBytes(bytes)) }
function fromB64(s: string): Uint8Array { return bytesFromBinary(binaryFromB64(s)) }
function b64u(bytes: Uint8Array): string { return b64urlEncode(bytes) }
function fromB64u(s: string): Uint8Array { return b64urlDecode(s) }
function hex(bytes: Uint8Array): string { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') }
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

async function randomBytes(n: number): Promise<Uint8Array> {
  // 原生 randomB64 最小返回 16B；截到调用方要求的精确长度（GCM nonce 必须 12B）
  const b64s = await linkToCore.randomB64(Math.max(n, 16))
  const bytes = fromB64(b64s)
  if (bytes.length < n) throw new Error('随机数长度不足')
  return bytes.slice(0, n)
}

function randomHex(nBytes: number): Promise<string> {
  return randomBytes(nBytes).then(hex)
}

// ---------------------------------------------------------------------------
// 口令
// ---------------------------------------------------------------------------

export function normalizeCode(input: string): string {
  let s = input
  try { s = s.normalize('NFKC') } catch { /* Hermes 老版本无 normalize */ }
  return s
    .toLowerCase()
    .trim()
    .split(/[\s\-_,，、.;；:：/|]+/)
    .filter(Boolean)
    .join(' ')
}

export function looksLikeCode(input: string): boolean {
  return normalizeCode(input).split(' ').filter(Boolean).length === CODE_WORDS
}

export async function generateCode(): Promise<string> {
  const words: string[] = []
  for (let i = 0; i < CODE_WORDS; i++) {
    const b = await randomBytes(2)
    words.push(WORDS[((b[0] << 8) | b[1]) & 0x7ff])
  }
  return words.join(' ')
}

function isCodeSalt(salt: Uint8Array): boolean {
  return bytesEqual(salt, utf8ToBytes(CODE_SALT))
}

export async function deriveKeyFromCode(code: string, salt: Uint8Array): Promise<Uint8Array> {
  const normalized = normalizeCode(code)
  if (isCodeSalt(salt)) {
    // 原生 PBKDF2 快很多；不可用时退回 @noble 异步实现
    try {
      const h = await linkToCore.pbkdf2Hex(normalized, CODE_SALT, PBKDF2_ITERATIONS)
      if (h) return Uint8Array.from(h.match(/.{2}/g)!.map(x => parseInt(x, 16)))
    } catch { /* fall through */ }
  }
  return pbkdf2Async(sha256, utf8ToBytes(normalized), salt, { c: PBKDF2_ITERATIONS, dkLen: 32 })
}

export function mboxForKey(key: Uint8Array): string {
  return hex(hmac(sha256, key, utf8ToBytes(MBOX_LABEL))).slice(0, 32)
}

export async function mboxForCode(code: string): Promise<string> {
  return mboxForKey(await deriveKeyFromCode(code, utf8ToBytes(CODE_SALT)))
}

// ---------------------------------------------------------------------------
// 信封
// ---------------------------------------------------------------------------

function clampTtl(ttl: number): number {
  if (!Number.isFinite(ttl)) return 3600
  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Math.floor(ttl)))
}

function aadOf(h: Pick<FlyEnvelopeHeader, 'm' | 'mb' | 's' | 'iat' | 'ttl'>): Uint8Array {
  return utf8ToBytes([FLY_APP, String(FLY_VERSION), h.m, h.mb, h.s ?? '', String(h.iat), String(h.ttl)].join('|'))
}

async function padToBucket(text: string, exp: number): Promise<Uint8Array> {
  const base = JSON.stringify({ t: text, exp, p: '' })
  const baseBytes = utf8ToBytes(base).length
  if (baseBytes > MAX_PLAINTEXT_BYTES || baseBytes + 16 > BUCKETS[BUCKETS.length - 1]) {
    throw new FlyError('too-long', '正文过长（上限约 40KB）')
  }
  const target = BUCKETS.find(b => b >= baseBytes + 16)!
  const padChars = target - baseBytes
  const padding = (await randomHex(Math.ceil(padChars / 2))).slice(0, padChars)
  const padded = JSON.stringify({ t: text, exp, p: padding })
  const bytes = utf8ToBytes(padded)
  if (bytes.length !== target) throw new FlyError('bad-envelope', '信封填充长度异常')
  return bytes
}

export interface SealOptions {
  mode: FlyMode
  ttlSeconds: number
  now?: number
}

export async function seal(text: string, opts: SealOptions): Promise<SealedFly> {
  if (!text) throw new FlyError('bad-input', '正文为空')
  if (opts.mode !== 'link' && opts.mode !== 'link-code' && opts.mode !== 'code') {
    throw new FlyError('bad-input', '未知的打开方式')
  }
  const now = opts.now ?? Date.now()
  const ttl = clampTtl(opts.ttlSeconds)
  const exp = now + ttl * 1000

  let key: Uint8Array
  let keyB64: string | undefined
  let code: string | undefined
  let salt: Uint8Array | undefined
  let mbox: string

  if (opts.mode === 'link') {
    key = await randomBytes(32)
    keyB64 = b64u(key)
    mbox = hex(await randomBytes(16))
  } else if (opts.mode === 'link-code') {
    code = await generateCode()
    salt = await randomBytes(16)
    key = await deriveKeyFromCode(code, salt)
    mbox = hex(await randomBytes(16))
  } else {
    code = await generateCode()
    key = await deriveKeyFromCode(code, utf8ToBytes(CODE_SALT))
    mbox = mboxForKey(key)
  }

  const header: FlyEnvelopeHeader = {
    app: FLY_APP,
    v: FLY_VERSION,
    m: opts.mode,
    mb: mbox,
    ...(salt ? { s: b64u(salt) } : {}),
    i: '',
    c: '',
    t: '',
    iat: now,
    ttl
  }
  const iv = await randomBytes(12)
  const encrypted = gcm(key, iv, aadOf(header)).encrypt(await padToBucket(text, exp))
  const ct = encrypted.slice(0, -16)
  const tag = encrypted.slice(-16)
  header.i = b64u(iv)
  header.c = b64(ct)
  header.t = b64(tag)
  key.fill(0)

  return {
    envelope: JSON.stringify(header),
    mode: opts.mode,
    mbox,
    ...(keyB64 ? { keyB64 } : {}),
    ...(code ? { code } : {}),
    expiresAt: exp
  }
}

function parseHeader(envelopeJson: string): FlyEnvelopeHeader {
  let raw: unknown
  try { raw = JSON.parse(envelopeJson) } catch { throw new FlyError('bad-envelope', '不是有效的密信信封') }
  const h = raw as Partial<FlyEnvelopeHeader>
  if (!h || h.app !== FLY_APP || h.v !== FLY_VERSION) throw new FlyError('bad-envelope', '不是有效的密信信封')
  if (h.m !== 'link' && h.m !== 'link-code' && h.m !== 'code') throw new FlyError('bad-envelope', '未知的打开方式')
  if (typeof h.mb !== 'string' || !/^[0-9a-f]{32}$/.test(h.mb)) throw new FlyError('bad-envelope', '信箱号异常')
  if (typeof h.i !== 'string' || typeof h.c !== 'string' || typeof h.t !== 'string') throw new FlyError('bad-envelope', '信封字段缺失')
  if (!Number.isFinite(h.iat) || !Number.isFinite(h.ttl)) throw new FlyError('bad-envelope', '信封时间异常')
  if (h.m === 'link-code' && (typeof h.s !== 'string' || h.s.length === 0)) throw new FlyError('bad-envelope', '口令信封缺少 salt')
  return h as FlyEnvelopeHeader
}

export function inspectEnvelope(envelopeJson: string): { mode: FlyMode; mbox: string; iat: number; ttl: number; expiresAt: number; bytes: number } {
  const h = parseHeader(envelopeJson)
  return { mode: h.m, mbox: h.mb, iat: h.iat, ttl: h.ttl, expiresAt: h.iat + h.ttl * 1000, bytes: utf8ToBytes(envelopeJson).length }
}

export async function open(envelopeJson: string, opts: { keyB64?: string; code?: string; now?: number }): Promise<OpenedFly> {
  const h = parseHeader(envelopeJson)
  const now = opts.now ?? Date.now()
  let key: Uint8Array

  if (h.m === 'link') {
    if (!opts.keyB64) throw new FlyError('missing-secret', '缺少链接密钥')
    key = fromB64u(opts.keyB64)
    if (key.length !== 32) throw new FlyError('missing-secret', '链接密钥长度异常')
  } else if (h.m === 'link-code') {
    if (!opts.code) throw new FlyError('missing-secret', '需要 6 词口令')
    key = await deriveKeyFromCode(opts.code, fromB64u(h.s!))
  } else {
    if (!opts.code) throw new FlyError('missing-secret', '需要 6 词口令')
    key = await deriveKeyFromCode(opts.code, utf8ToBytes(CODE_SALT))
    const expected = mboxForKey(key)
    if (expected !== h.mb) throw new FlyError('wrong-code', '口令不对，或密信已被读取焚毁')
  }

  let plaintext: Uint8Array
  try {
    plaintext = gcm(key, fromB64u(h.i), aadOf(h)).decrypt(Uint8Array.from([...fromB64(h.c), ...fromB64(h.t)]))
  } catch {
    throw new FlyError('wrong-code', '口令不对，或密信已被读取焚毁')
  }

  let payload: { t?: unknown; exp?: unknown }
  try { payload = JSON.parse(bytesToUtf8(plaintext)) } catch { throw new FlyError('tampered', '密信内容已损坏') }
  if (typeof payload.t !== 'string' || typeof payload.exp !== 'number') throw new FlyError('tampered', '密信内容已损坏')
  if (payload.exp <= now) throw new FlyError('expired', '密信已过期并焚毁')
  if (Math.abs(payload.exp - (h.iat + h.ttl * 1000)) > 1000) throw new FlyError('tampered', '密信有效期不一致')
  plaintext.fill(0)
  key.fill(0)
  return { text: payload.t, mode: h.m, mbox: h.mb, expiresAt: payload.exp }
}

// ---------------------------------------------------------------------------
// 链接
// ---------------------------------------------------------------------------

export interface FlyLinkParts {
  base: string
  mbox: string
  keyB64?: string
  needsCode: boolean
}

export function parseFlyLink(input: string): FlyLinkParts | null {
  const s = input.trim()
  if (/^[0-9a-f]{32}$/.test(s)) return { base: '', mbox: s, needsCode: true }
  const m = s.match(/^(https?:\/\/[^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?(?:#(.*))?$/i)
  if (!m) return null
  const base = m[1]
  const path = m[2] ?? ''
  const hash = m[3] ?? ''
  const pm = path.match(/\/r\/([0-9a-f]{32})/i)
  if (!pm) return null
  const mbox = pm[1].toLowerCase()
  const k = hash.split('&').map(x => x.split('=')).find(([key]) => key === 'k')?.[1]
  if (k) {
    try {
      if (fromB64u(decodeURIComponent(k)).length !== 32) return null
    } catch { return null }
    return { base, mbox, keyB64: decodeURIComponent(k), needsCode: false }
  }
  return { base, mbox, needsCode: true }
}

export function flyLink(base: string, sealed: SealedFly): string {
  const root = base.replace(/\/+$/, '')
  if (sealed.mode === 'link') return root + '/r/' + sealed.mbox + '#k=' + sealed.keyB64
  return root + '/r/' + sealed.mbox + '#c'
}
