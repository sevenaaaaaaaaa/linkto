import { gcm } from '@noble/ciphers/aes.js'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { binaryFromBytes, bytesFromBinary, decodeUtf8Bytes } from '../imap/encoding'
import type { WorkItem } from './model'

const utf8 = (s: string) => Uint8Array.from(unescape(encodeURIComponent(s)), c => c.charCodeAt(0))
const b64 = (bytes: Uint8Array) => btoa(binaryFromBytes(bytes))
const unb64 = (text: string) => bytesFromBinary(atob(text))
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const KDF = { N: 16384, r: 8, p: 1, dkLen: 32, maxmem: 64 * 1024 * 1024, asyncTick: 8 }
export const SYNC_FOLDER = 'LinkTo-Sync'
export const isSyncFolder = (path: string) => /(?:^|[/.])LinkTo-(?:Sync|Trace|Vault)$/i.test(path)

export const parseHeaders = (raw: string) => {
  const headers: Record<string, string> = {}
  for (const line of raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index > 0) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim()
  }
  return headers
}

/** Byte-compatible with desktop todo-sync v1. Memo headers are ignored by older clients. */
export class SyncCodec {
  private keys = new Map<string, Promise<Uint8Array>>()
  private salt: Promise<Uint8Array>
  constructor(private passphrase: string, private random: (length: number) => Promise<Uint8Array>) { this.salt = random(16) }
  private key(salt: Uint8Array) {
    const id = b64(salt)
    let key = this.keys.get(id)
    if (!key) { key = scryptAsync(utf8(this.passphrase), salt, KDF); this.keys.set(id, key) }
    return key
  }
  async wireId(id: string) {
    const index = await this.key(utf8('linkto-todo-sync/index/v1'))
    return `h:${hex(hmac(sha256, index, utf8(id))).slice(0, 32)}`
  }
  async encode(item: WorkItem): Promise<string> {
    const wireId = await this.wireId(item.id)
    const salt = await this.salt, iv = await this.random(12)
    const data = { v: 1, ...item, updatedAt: item.data.updatedAt }
    const encrypted = gcm(await this.key(salt), iv, utf8(wireId)).encrypt(utf8(JSON.stringify(data)))
    const envelope = { v: 1, enc: 'aes-256-gcm', kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: b64(salt), iv: b64(iv), tag: b64(encrypted.slice(-16)), ct: b64(encrypted.slice(0, -16)) }
    const body = b64(utf8(JSON.stringify(envelope))).match(/.{1,76}/g)?.join('\r\n') ?? ''
    return [
      'From: LinkTo <linkto-sync@localhost>', 'To: <linkto-sync@localhost>', `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${hex(await this.random(16))}@linkto.sync>`, `Subject: [linkto-${item.kind === 'memo' ? 'memo' : 'todo'}] ${wireId}`,
      'MIME-Version: 1.0', `${item.kind === 'memo' ? 'X-LinkTo-Memo' : 'X-LinkTo-Todo'}: ${wireId}`,
      `X-LinkTo-Updated: ${Math.floor(item.data.updatedAt)}`, 'X-LinkTo-Encrypted: 1', 'X-LinkTo-Proto: 1',
      'Content-Type: application/json; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body, ''
    ].join('\r\n')
  }
  async decode(raw: string): Promise<WorkItem> {
    const split = raw.search(/\r?\n\r?\n/)
    if (split < 0) throw new Error('同步邮件格式错误')
    const headers = parseHeaders(raw.slice(0, split))
    const wireId = headers['x-linkto-todo'] || headers['x-linkto-memo']
    if (!wireId) throw new Error('不是 LinkTo 同步记录')
    const body = raw.slice(split).trim()
    const envelope = JSON.parse(headers['content-transfer-encoding']?.toLowerCase() === 'base64' ? decodeUtf8Bytes(unb64(body.replace(/\s/g, ''))) : body)
    let value = envelope
    if ((wireId.startsWith('h:') || headers['x-linkto-encrypted'] === '1') && envelope.ct === undefined) throw new Error('同步记录缺少加密正文')
    if (envelope.ct !== undefined) {
      if (envelope.N !== KDF.N || envelope.r !== KDF.r || envelope.p !== KDF.p || envelope.enc !== 'aes-256-gcm' || envelope.kdf !== 'scrypt') throw new Error('不支持的同步加密格式')
      const salt = unb64(envelope.salt), iv = unb64(envelope.iv), tag = unb64(envelope.tag), ct = unb64(envelope.ct)
      if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || ct.length > 2 * 1024 * 1024) throw new Error('同步记录格式无效')
      const encrypted = new Uint8Array(ct.length + tag.length); encrypted.set(ct); encrypted.set(tag, ct.length)
      try { value = JSON.parse(decodeUtf8Bytes(gcm(await this.key(salt), iv, utf8(wireId)).decrypt(encrypted))) }
      catch { throw new Error('同步口令不正确或记录已损坏；本机数据未上传') }
    }
    if (typeof value.id !== 'string' || typeof value.title !== 'string' || !Number.isFinite(value.updatedAt) || !['open', 'done', 'dismissed'].includes(value.status)) throw new Error('同步记录字段无效')
    if ((value.kind ?? 'todo') !== (headers['x-linkto-memo'] ? 'memo' : 'todo')) throw new Error('同步记录类型与正文不匹配')
    if (headers['x-linkto-encrypted'] === '1' && await this.wireId(value.id) !== wireId) throw new Error('同步记录标识不匹配')
    return { id: value.id, kind: headers['x-linkto-memo'] ? 'memo' : 'todo', title: value.title, status: value.status,
      dueAt: value.dueAt == null ? null : Number(value.dueAt), createdAt: Number(value.createdAt) || value.updatedAt,
      data: { ...(value.data ?? {}), updatedAt: value.updatedAt } }
  }
  async clear() { for (const key of this.keys.values()) (await key).fill(0); this.keys.clear(); this.passphrase = '' }
}
