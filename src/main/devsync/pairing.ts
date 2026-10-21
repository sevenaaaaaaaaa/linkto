import { createCipheriv, createDecipheriv, randomBytes, randomInt, scryptSync } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * 设备配对（DevSync fast setup）：
 *  旧电脑把「同步邮箱账户 + 同步口令 + 可选 OAuth 应用配置 / 幽灵信中继」封成一个短时配对包，
 *  新电脑粘贴链接 + 输入配对码即可自动添加同步邮箱、开启同步并把其余账户与数据拉回来。
 *
 *  - 配对包用 scrypt(配对码) → AES-256-GCM 加密；链接里只有密文与盐，配对码单独传递
 *  - 15 分钟过期；链接形如 linkto://pair?d=<base64url>
 *  - 配对码 10 位 base32（去掉 I/O/0/1），形如 XXXXX-XXXXX；足够抵抗离线穷举
 */

export interface PairingPayload {
  v: 1
  createdAt: number
  expiresAt: number
  /** 生成配对的设备名（仅用于展示） */
  device: string
  /** 同步邮箱账户：restoreAccounts 使用的 { config, secret?, oauth? } */
  account: { config: Record<string, unknown>; secret?: string; oauth?: unknown }
  passphrase: string
  categories: Record<string, boolean>
  oauthClients?: unknown
  ghostRelay?: string | null
}

export interface PairingOffer {
  link: string
  pin: string
  expiresAt: number
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PIN_LEN = 10
export const PAIRING_TTL_MS = 15 * 60_000
const MAX_DATA = 256 * 1024
const AAD = Buffer.from('linkto-pair-v1', 'utf8')

export const normalizePairingPin = (pin: string): string => pin.toUpperCase().replace(/[^A-Z0-9]/g, '')

function deriveKey(pin: string, salt: Buffer): Buffer {
  return scryptSync(normalizePairingPin(pin), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

function randomPin(): string {
  let out = ''
  for (let i = 0; i < PIN_LEN; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

const formatPin = (pin: string): string => `${pin.slice(0, 5)}-${pin.slice(5)}`

/** 加密配对包，返回可复制的 linkto:// 链接与配对码 */
export function sealPairing(
  input: Omit<PairingPayload, 'v' | 'createdAt' | 'expiresAt'>,
  now = Date.now()
): PairingOffer {
  const pin = randomPin()
  const payload: PairingPayload = { v: 1, createdAt: now, expiresAt: now + PAIRING_TTL_MS, ...input }
  const raw = deflateRawSync(Buffer.from(JSON.stringify(payload), 'utf8'))
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(pin, salt), iv)
  cipher.setAAD(AAD)
  const ct = Buffer.concat([cipher.update(raw), cipher.final()])
  const env = {
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64')
  }
  const data = Buffer.from(JSON.stringify(env), 'utf8').toString('base64url')
  return { link: `linkto://pair?d=${data}`, pin: formatPin(pin), expiresAt: payload.expiresAt }
}

function linkData(input: string): string {
  // 聊天工具 / 邮件经常把长链接折行：先去掉所有空白再解析
  const s = input.replace(/\s+/g, '')
  if (!s) return ''
  if (s.startsWith('linkto://')) {
    try {
      const u = new URL(s)
      return u.searchParams.get('d') ?? ''
    } catch {
      return ''
    }
  }
  // 也接受只粘贴 ?d= 后面的数据
  return s
}

export type OpenPairingResult = { ok: true; payload: PairingPayload } | { ok: false; error: string }

/** 用配对码解开链接；错误信息直接可展示 */
export function openPairing(link: string, pin: string, now = Date.now()): OpenPairingResult {
  const data = linkData(link)
  if (!data) return { ok: false, error: '配对链接为空或格式不对（应以 linkto://pair 开头）' }
  if (data.length > MAX_DATA) return { ok: false, error: '配对链接过长，可能不是 LinkTo 的配对链接' }
  const p = normalizePairingPin(pin)
  if (p.length !== PIN_LEN) return { ok: false, error: '配对码应为 10 位（形如 5 位-5 位）' }
  try {
    const env = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as {
      v?: number
      salt?: string
      iv?: string
      tag?: string
      ct?: string
    }
    if (env.v !== 1 || !env.salt || !env.iv || !env.tag || !env.ct) return { ok: false, error: '配对链接已损坏' }
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(p, Buffer.from(env.salt, 'base64')), Buffer.from(env.iv, 'base64'))
    decipher.setAAD(AAD)
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
    const raw = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()])
    const payload = JSON.parse(inflateRawSync(raw, { maxOutputLength: 2 * 1024 * 1024 }).toString('utf8')) as PairingPayload
    if (payload.v !== 1) return { ok: false, error: '配对包版本过新，请先升级 LinkTo' }
    if (!payload.account?.config?.email) return { ok: false, error: '配对包里没有同步邮箱' }
    if (!payload.passphrase || payload.passphrase.length < 6) return { ok: false, error: '配对包里没有有效的同步口令' }
    if (!Number.isFinite(payload.expiresAt) || payload.expiresAt < now) {
      return { ok: false, error: '配对链接已过期（15 分钟内有效），请在另一台电脑重新生成' }
    }
    return { ok: true, payload }
  } catch {
    return { ok: false, error: '配对码不正确，或链接已损坏' }
  }
}
