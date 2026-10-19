/**
 * .lkbak 备份文件格式（纯函数，无 Electron 依赖）
 *
 * v1（旧版）：{ app:'linkto-backup', v:1, kdf:'scrypt', salt, iv, tag, ciphertext, createdAt, accountCount, hasSecrets }
 *             ciphertext = AES-256-GCM(scrypt(口令, salt, N=16384,r=8,p=1)) 加密的 { accounts: [{ config, secret?, oauth? }] }
 * v2（本版）：外壳字段完全相同（旧版本 LinkTo 仍能打开并恢复其中的账户），另加明文头 categories（各类别条数），
 *             载荷增加 records（各中心数据）、oauthClients 与账户的 extra（文件夹偏好、设备相关标记）。
 *   records: [{ type, id, category, updatedAt, data, refs? }]（与同步记录同形，可直接交给同步适配器落地）
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import type { VaultRefs } from './protocol'
import type { DevSyncCategory } from '@shared/devsync'

export const BACKUP_APP_TAG = 'linkto-backup'

export interface BackupAccountEntry {
  config: Record<string, unknown> & { id: string; email: string; provider: string; authType?: string }
  secret?: string
  oauth?: { accessToken: string; refreshToken?: string; expiresAt: number; email?: string }
  extra?: { folderPrefs?: Record<string, unknown>; deviceBound?: boolean }
}

export interface BackupRecord {
  type: string
  id: string
  category: DevSyncCategory
  updatedAt: number
  data: unknown
  refs?: VaultRefs
}

export interface BackupPayloadV2 {
  accounts: BackupAccountEntry[]
  records?: BackupRecord[]
  oauthClients?: unknown
  /** 导出时勾选的类别 */
  categories?: DevSyncCategory[]
}

export interface BackupEnvelope {
  app: string
  v: number
  kdf: 'scrypt'
  salt: string
  iv: string
  tag: string
  ciphertext: string
  createdAt: number
  accountCount: number
  hasSecrets: boolean
  categories?: Partial<Record<DevSyncCategory, number>>
}

export class BackupFormatError extends Error {
  constructor(
    readonly code: 'not-backup' | 'passphrase' | 'format',
    message: string
  ) {
    super(message)
  }
}

const KDF = { N: 16384, r: 8, p: 1 }

export function encryptBackup(payload: BackupPayloadV2, passphrase: string, meta: { hasSecrets: boolean; createdAt?: number }): BackupEnvelope {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32, KDF)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()])
  return {
    app: BACKUP_APP_TAG,
    v: payload.records ? 2 : 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ct.toString('base64'),
    createdAt: meta.createdAt ?? Date.now(),
    accountCount: payload.accounts.length,
    hasSecrets: meta.hasSecrets,
    ...(payload.records ? { categories: countCategories(payload) } : {})
  }
}

export function countCategories(p: BackupPayloadV2): Partial<Record<DevSyncCategory, number>> {
  const out: Partial<Record<DevSyncCategory, number>> = {}
  if (p.accounts.length) out.accounts = p.accounts.length
  for (const r of p.records ?? []) out[r.category] = (out[r.category] ?? 0) + 1
  return out
}

export function parseEnvelope(text: string): BackupEnvelope {
  let env: BackupEnvelope
  try {
    env = JSON.parse(text) as BackupEnvelope
  } catch {
    throw new BackupFormatError('not-backup', '不是林可兔的备份文件')
  }
  if (!env || env.app !== BACKUP_APP_TAG) throw new BackupFormatError('not-backup', '不是林可兔的备份文件')
  if (!env.salt || !env.iv || !env.tag || !env.ciphertext) throw new BackupFormatError('format', '备份文件不完整')
  return env
}

export function decryptBackup(env: BackupEnvelope, passphrase: string): BackupPayloadV2 {
  let plain: Buffer
  try {
    const key = scryptSync(passphrase, Buffer.from(env.salt, 'base64'), 32, KDF)
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'))
    d.setAuthTag(Buffer.from(env.tag, 'base64'))
    plain = Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()])
  } catch {
    throw new BackupFormatError('passphrase', '口令错误或备份文件已损坏')
  }
  let p: Partial<BackupPayloadV2>
  try {
    p = JSON.parse(plain.toString('utf8'))
  } catch {
    throw new BackupFormatError('format', '备份内容无法解析')
  }
  return {
    accounts: Array.isArray(p.accounts) ? p.accounts.filter(a => a && a.config && typeof a.config.email === 'string') : [],
    records: Array.isArray(p.records) ? p.records.filter(r => r && typeof r.type === 'string' && typeof r.id === 'string') : [],
    oauthClients: p.oauthClients,
    categories: Array.isArray(p.categories) ? p.categories : undefined
  }
}

export function headerOf(env: BackupEnvelope) {
  return {
    version: Number(env.v) || 1,
    createdAt: Number(env.createdAt) || 0,
    accountCount: Number(env.accountCount) || 0,
    hasSecrets: !!env.hasSecrets,
    ...(env.categories ? { categories: env.categories } : {})
  }
}

export type RestoreStrategy = 'merge' | 'overwrite'

/** 单条记录恢复决策：本地没有 → 新增；合并 = 备份更新才覆盖；以备份为准 = 一律覆盖 */
export function decideRestore(local: { mtime?: number } | null, rec: { updatedAt: number }, strategy: RestoreStrategy): 'add' | 'update' | 'skip' {
  if (!local) return 'add'
  if (strategy === 'overwrite') return 'update'
  const m = local.mtime ?? 0
  return rec.updatedAt > m && m > 0 ? 'update' : 'skip'
}

/** 自动备份轮换：按文件名时间排序，保留最近 keep 份，返回要删除的文件名 */
export function rotationVictims(files: string[], keep: number, prefix = 'LinkTo-AutoBackup-'): string[] {
  const mine = files.filter(f => f.startsWith(prefix) && f.endsWith('.lkbak')).sort()
  const k = Math.max(1, Math.floor(keep) || 1)
  return mine.length > k ? mine.slice(0, mine.length - k) : []
}
