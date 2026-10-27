import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Keychain from 'react-native-keychain'
import { gcm } from '@noble/ciphers/aes.js'
import { linkToCore } from '../native/LinkToCore'
import { binaryFromB64, binaryFromBytes, b64FromBinary, bytesFromBinary, decodeUtf8Bytes } from '../imap/encoding'

/**
 * 本机保险箱：Keychain 里只放 32B 数据密钥，密文整表放 AsyncStorage。
 * 列表接口不返回 secret 正文；只有 reveal 才解密单条。
 * 与 Mac 版共用条目结构（note / secret），但不做跨设备同步。
 */

export type VaultKind = 'note' | 'secret'

export interface VaultItem {
  id: string
  kind: VaultKind
  title: string
  body: string
  createdAt: number
  updatedAt: number
}

export interface VaultItemMeta {
  id: string
  kind: VaultKind
  title: string
  preview: string
  createdAt: number
  updatedAt: number
}

const KEY_SERVICE = 'linkto.vault.key'
const DATA_KEY = 'linkto.vault.v1'
const AAD = 'linkto-vault/v1'

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

function b64(bytes: Uint8Array): string { return b64FromBinary(binaryFromBytes(bytes)) }
function fromB64(s: string): Uint8Array { return bytesFromBinary(binaryFromB64(s)) }
function hex(bytes: Uint8Array): string { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') }

async function randomBytes(n: number): Promise<Uint8Array> {
  const s = await linkToCore.randomB64(Math.max(n, 16))
  return fromB64(s).slice(0, n)
}

async function loadKey(): Promise<Uint8Array> {
  const existing = await Keychain.getGenericPassword({ service: KEY_SERVICE })
  if (existing) return fromB64(existing.password)
  // 已有密文却没有密钥：不要生成新密钥覆盖旧数据（旧数据已无法解密，但至少不静默换钥）
  if (await AsyncStorage.getItem(DATA_KEY)) throw new Error('保险箱密钥丢失，已拒绝生成新密钥覆盖旧数据')
  const key = await randomBytes(32)
  await Keychain.setGenericPassword('vault', b64(key), { service: KEY_SERVICE })
  return key
}

async function decryptItems(): Promise<VaultItem[]> {
  const raw = await AsyncStorage.getItem(DATA_KEY)
  if (!raw) return []
  const key = await loadKey()
  const box = JSON.parse(raw) as { v?: number; n?: string; c?: string }
  if (box.v !== 1 || typeof box.n !== 'string' || typeof box.c !== 'string') throw new Error('保险箱数据损坏')
  try {
    const plain = gcm(key, fromB64(box.n), utf8ToBytes(AAD)).decrypt(fromB64(box.c))
    const list = JSON.parse(decodeUtf8Bytes(plain)) as VaultItem[]
    return Array.isArray(list) ? list : []
  } catch {
    throw new Error('保险箱密钥不匹配或数据损坏；为避免覆盖，已拒绝写入')
  } finally {
    key.fill(0)
  }
}

async function encryptItems(items: VaultItem[]): Promise<void> {
  const key = await loadKey()
  try {
    const nonce = await randomBytes(12)
    const encrypted = gcm(key, nonce, utf8ToBytes(AAD)).encrypt(utf8ToBytes(JSON.stringify(items)))
    await AsyncStorage.setItem(DATA_KEY, JSON.stringify({ v: 1, n: b64(nonce), c: b64(encrypted) }))
  } finally {
    key.fill(0)
  }
}

let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

export function listVault(): Promise<VaultItemMeta[]> {
  return serial(async () => {
    const items = await decryptItems()
    return items
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(i => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        preview: i.kind === 'secret' ? '' : i.body.slice(0, 80),
        createdAt: i.createdAt,
        updatedAt: i.updatedAt
      }))
  })
}

export function addVaultItem(input: { kind: VaultKind; title: string; body: string }): Promise<VaultItemMeta> {
  return serial(async () => {
    const items = await decryptItems()
    const now = Date.now()
    const item: VaultItem = {
      id: hex(await randomBytes(8)),
      kind: input.kind,
      title: input.title.trim() || (input.kind === 'secret' ? '未命名密码' : '未命名暂存'),
      body: input.body,
      createdAt: now,
      updatedAt: now
    }
    await encryptItems([item, ...items].slice(0, 500))
    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      preview: item.kind === 'secret' ? '' : item.body.slice(0, 80),
      createdAt: now,
      updatedAt: now
    }
  })
}

export function removeVaultItem(id: string): Promise<boolean> {
  return serial(async () => {
    const items = await decryptItems()
    const next = items.filter(i => i.id !== id)
    if (next.length === items.length) return false
    await encryptItems(next)
    return true
  })
}

export function revealVaultItem(id: string): Promise<VaultItem | null> {
  return serial(async () => {
    const items = await decryptItems()
    return items.find(i => i.id === id) ?? null
  })
}
