import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scryptSync,
  createHash
} from 'node:crypto'

/**
 * 幽灵信信封（端到端加密 · 阅后即焚）
 *
 * 安全模型：
 *  - 内容密钥 K（随机 32B）加密正文，K 被双重包裹：
 *      w1: K → 收件人幽灵公钥（X25519 临时密钥协商 + HKDF + AES-GCM），持有私钥才能解
 *      w2: K → 口令 P（scrypt 派生 + AES-GCM），知道口令才能解
 *    两层同时解开才能拿到 K —— 「密钥 + 密码」双因子。
 *  - 信封不含发件人任何信息；正文/主题在传输层全程密文。
 *  - ch 字段预留投递通道（mail=邮箱哑管道 / relay=匿名中继，中继为 Phase B）。
 */

const HKDF_INFO = Buffer.from('linkto-ghost-wrap1-v1')
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const

export interface GhostBox {
  iv: string
  ct: string
  tag: string
}

export interface GhostEnvelope {
  app: 'linkto-ghost'
  v: 1
  ch: 'mail' | 'relay'
  /** 一次性公钥（X25519 SPKI DER, base64） */
  eph: string
  salt2: string
  w1: GhostBox
  w2: GhostBox
  ct: GhostBox
  createdAt: number
}

interface GhostPayload {
  kind: 'ghost-mail'
  body: string
  createdAt: number
}

export interface GhostIdentity {
  /** 公钥 SPKI DER（base64）——对外分发的幽灵 ID 本体 */
  spki: string
  /** 私钥 PKCS8 DER（base64）——仅存本机钥匙串 */
  pkcs8: string
}

export function createIdentity(): GhostIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    pkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  }
}

/** 幽灵 ID 指纹（短哈希，供人工比对防掉包） */
export function fingerprintOf(spkiB64: string): string {
  const h = createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex')
  return (h.slice(0, 16).match(/.{4}/g) ?? []).join('-')
}

function box(key: Buffer, plaintext: Buffer): GhostBox {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plaintext), c.final()])
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') }
}

function unbox(key: Buffer, b: GhostBox): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'base64'))
  d.setAuthTag(Buffer.from(b.tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(b.ct, 'base64')), d.final()])
}

function wrapKeyForPub(recipientSpkiB64: string, k: Buffer): { eph: string; box: GhostBox } {
  const eph = generateKeyPairSync('x25519')
  const recipPub = createPublicKey({ key: Buffer.from(recipientSpkiB64, 'base64'), format: 'der', type: 'spki' })
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipPub })
  const key1 = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 32))
  return { eph: eph.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), box: box(key1, k) }
}

function unwrapKeyWithPriv(envelope: GhostEnvelope, pkcs8B64: string): Buffer {
  const ephPub = createPublicKey({ key: Buffer.from(envelope.eph, 'base64'), format: 'der', type: 'spki' })
  const priv = createPrivateKey({ key: Buffer.from(pkcs8B64, 'base64'), format: 'der', type: 'pkcs8' })
  const shared = diffieHellman({ privateKey: priv, publicKey: ephPub })
  const key1 = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 32))
  return unbox(key1, envelope.w1)
}

function wrapKeyForPassword(password: string, salt2: Buffer, k: Buffer): GhostBox {
  const key2 = scryptSync(password, salt2, 32, SCRYPT_OPTS)
  return box(key2, k)
}

function unwrapKeyWithPassword(envelope: GhostEnvelope, password: string): Buffer {
  const key2 = scryptSync(password, Buffer.from(envelope.salt2, 'base64'), 32, SCRYPT_OPTS)
  return unbox(key2, envelope.w2)
}

/** 封装一封幽灵信：正文 + 口令 → 信封 JSON（ch 指定投递通道：mail=邮箱哑管道 / relay=匿名中继） */
export function sealEnvelope(text: string, password: string, recipientSpkiB64: string, channel: 'mail' | 'relay' = 'mail'): string {
  if (!password) throw new Error('需要设置打开口令')
  const k = randomBytes(32)
  const payload: GhostPayload = { kind: 'ghost-mail', body: text, createdAt: Date.now() }
  const envelope: GhostEnvelope = {
    app: 'linkto-ghost',
    v: 1,
    ch: channel,
    eph: '',
    salt2: randomBytes(16).toString('base64'),
    w1: { iv: '', ct: '', tag: '' },
    w2: { iv: '', ct: '', tag: '' },
    ct: box(k, Buffer.from(JSON.stringify(payload), 'utf8')),
    createdAt: Date.now()
  }
  const w1 = wrapKeyForPub(recipientSpkiB64, k)
  envelope.eph = w1.eph
  envelope.w1 = w1.box
  envelope.w2 = wrapKeyForPassword(password, Buffer.from(envelope.salt2, 'base64'), k)
  return JSON.stringify(envelope)
}

/**
 * 试开第一层（不消耗信封）：验证信封是否发往本机幽灵身份。
 * 仅做 w1 解包测试，不返回内容密钥。
 */
export function isAddressedTo(envelope: GhostEnvelope, pkcs8B64: string): boolean {
  try {
    unwrapKeyWithPriv(envelope, pkcs8B64)
    return true
  } catch {
    return false
  }
}

/** 双因子开信：本机私钥 + 口令，全部通过才返回正文 */
export function openEnvelope(envelope: GhostEnvelope, password: string, pkcs8B64: string): string {
  const k = unwrapKeyWithPriv(envelope, pkcs8B64) // 私钥因子
  const kByPass = unwrapKeyWithPassword(envelope, password) // 口令因子
  if (!k.equals(kByPass)) throw new Error('口令错误')
  const payload = JSON.parse(unbox(k, envelope.ct).toString('utf8')) as GhostPayload
  if (payload.kind !== 'ghost-mail') throw new Error('不是幽灵信')
  return payload.body
}

export function parseEnvelope(json: string | Buffer): GhostEnvelope {
  const env = JSON.parse(typeof json === 'string' ? json : json.toString('utf8')) as GhostEnvelope
  if (env.app !== 'linkto-ghost' || env.v !== 1) throw new Error('不是幽灵信信封')
  return env
}