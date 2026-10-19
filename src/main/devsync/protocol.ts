/**
 * 通用加密同步通道（LinkTo-Vault）· 线格式与合并规则 —— 纯函数，无 Electron 依赖
 *
 * 为什么新建文件夹而不是复用 LinkTo-Sync：
 *   - 旧版本 / 手机端只认识 LinkTo-Sync 里的待办（X-LinkTo-Todo），把账户、记忆等放进去会被当成待办或被反复下载；
 *   - 待办与留痕继续走各自的文件夹（LinkTo-Sync / LinkTo-Trace，协议不变），这里只承载其余类别。
 *   三个文件夹共用同一个同步邮箱与同一个口令（KeyRing 同一套 scrypt 参数与 index salt）。
 *
 * 载体：同步邮箱里的隐藏 IMAP 文件夹 `LinkTo-Vault`（识别规则同 LinkTo-Sync：路径最后一段不区分大小写）。
 * 每条记录 = 一封邮件（同一记录任何时刻应只有一封；多封时保留最新、删除其余）：
 *
 *   Subject: [linkto-vault] <wireId>
 *   X-LinkTo-Vault: <wireId>          wireId = "v:" + hex(HMAC-SHA256(indexKey, "vault\n" + type + "\n" + id))[0..32)
 *   X-LinkTo-Kind: <kindTag>          kindTag = "k:" + hex(HMAC-SHA256(indexKey, "kind\n" + category))[0..12)
 *                                     （不透明，只用于按类别过滤：关闭的类别不下载）
 *   X-LinkTo-Updated: <updatedAt ms>
 *   X-LinkTo-Tomb: 1 | 0              墓碑（删除）标记，用于过期清理（不含内容）
 *   X-LinkTo-Check: <hex(HMAC(indexKey, "vault-check"))[0..8)>  口令校验：与本机算出的不同 = 口令不一致，整轮中止
 *                                     （wireId / kindTag 都由口令派生，口令不对时什么都匹配不上，不校验就会悄悄另起一套）
 *   X-LinkTo-Proto: 1
 *   Content-Type: application/json; Content-Transfer-Encoding: base64
 *
 *   正文：始终加密（含凭据，不提供明文模式）
 *     { v:1, enc:'aes-256-gcm', kdf:'scrypt', N, r, p, salt, iv, tag, ct }，AAD = wireId，
 *     ct 解密后 = VaultRecord JSON：{ v, type, id, updatedAt, deleted, device, deviceId, data, refs }
 *     refs：跨设备引用 { a: { 本机账户 id → 账户键 provider|email }, m: { 本机邮件 id → Message-ID 头 } }，
 *     拉取时映射回本机 id，映射不到的保留原值（不挂接）。
 *
 * 合并：后写者胜（updatedAt 大者胜；相等时保留远端，不来回覆盖）。删除 = 墓碑记录（deleted=true, data=null），
 *       照常传播；超过 30 天的墓碑从文件夹清除。本地变更靠「快照 + 哈希」发现（不侵入各模块的写路径）：
 *       与上次同步时的哈希不同 = 本地改过 → 版本号取模块自带的修改时间（没有则取当前时间）。
 *       首次接触（本机没有状态）且远端已有同一条时，以远端为准（新设备不会拿空白 / 默认值覆盖老设备）。
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { KeyRing, TodoSyncError, parseHeaderBlock } from '../todo-sync/protocol'

export const VAULT_FOLDER = 'LinkTo-Vault'
export const VAULT_PROTO = 1
export const VAULT_SUBJECT_PREFIX = '[linkto-vault] '
export const VAULT_TOMBSTONE_TTL_MS = 30 * 864e5
/** 单条记录加密前的上限：超过的不同步（计入 oversize，设置页提示） */
export const MAX_RECORD_BYTES = 512 * 1024
export const VAULT_HEADER_NAMES = ['X-LinkTo-Vault', 'X-LinkTo-Updated', 'X-LinkTo-Kind', 'X-LinkTo-Tomb', 'X-LinkTo-Check']

export { KeyRing, TodoSyncError }

export function isVaultFolder(path: string | undefined | null): boolean {
  if (!path) return false
  const last = path.split(/[/.]/).pop() ?? path
  return last.toLowerCase() === VAULT_FOLDER.toLowerCase()
}

// ---------------- 记录 ----------------

export interface VaultRefs {
  /** 本机账户 id → 跨设备账户键 */
  a?: Record<string, string>
  /** 本机邮件 id → Message-ID 头 */
  m?: Record<string, string>
}

export interface VaultRecord {
  v: number
  type: string
  id: string
  updatedAt: number
  deleted: boolean
  device?: string
  deviceId?: string
  data: unknown
  refs?: VaultRefs
}

export interface VaultHeader {
  uid: number
  wireId: string
  updatedAt: number
  kind: string
  tomb: boolean
  check: string
}

/** 稳定序列化：键排序，用于哈希（同样的内容在任何设备上得到同样的字符串） */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null'
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(x => canonicalJson(x === undefined ? null : x)).join(',')}]`
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).filter(k => o[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

export function hashData(key: Buffer | string, data: unknown): string {
  return createHmac('sha256', key).update(canonicalJson(data), 'utf8').digest('hex').slice(0, 40)
}

export function vaultWireId(type: string, id: string, indexKey: Buffer): string {
  return `v:${createHmac('sha256', indexKey).update(`vault\n${type}\n${id}`, 'utf8').digest('hex').slice(0, 32)}`
}

export function passCheck(indexKey: Buffer): string {
  return createHmac('sha256', indexKey).update('vault-check', 'utf8').digest('hex').slice(0, 8)
}

export function kindTag(category: string, indexKey: Buffer): string {
  return `k:${createHmac('sha256', indexKey).update(`kind\n${category}`, 'utf8').digest('hex').slice(0, 12)}`
}

// ---------------- 加密 / MIME ----------------

interface EncEnvelope {
  v: number
  enc: 'aes-256-gcm'
  kdf: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
  iv: string
  tag: string
  ct: string
}

async function seal(plain: Buffer, keyring: KeyRing, aad: string): Promise<Buffer> {
  const key = await keyring.keyFor(keyring.ownSalt)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const env: EncEnvelope = {
    v: VAULT_PROTO,
    enc: 'aes-256-gcm',
    kdf: 'scrypt',
    N: 16384,
    r: 8,
    p: 1,
    salt: keyring.ownSalt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64')
  }
  return Buffer.from(JSON.stringify(env), 'utf8')
}

async function open(env: EncEnvelope, keyring: KeyRing, aad: string): Promise<Buffer> {
  if (env.enc !== 'aes-256-gcm' || env.kdf !== 'scrypt') throw new TodoSyncError('format', `不支持的加密方式：${env.enc}`)
  const key = await keyring.keyFor(Buffer.from(env.salt, 'base64'))
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'))
    d.setAAD(Buffer.from(aad, 'utf8'))
    d.setAuthTag(Buffer.from(env.tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()])
  } catch {
    throw new TodoSyncError('passphrase', '同步口令不正确')
  }
}

const b64Lines = (buf: Buffer) => (buf.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')

/** 记录明文的字节数（判断是否超限） */
export function recordSize(rec: VaultRecord): number {
  return Buffer.byteLength(JSON.stringify(rec), 'utf8')
}

export async function encodeVaultMessage(
  rec: VaultRecord,
  opts: { keyring: KeyRing; category: string; device?: string; now?: number }
): Promise<{ raw: Buffer; wireId: string; size: number }> {
  const indexKey = await opts.keyring.indexKey()
  const wireId = vaultWireId(rec.type, rec.id, indexKey)
  const plain = Buffer.from(JSON.stringify(rec), 'utf8')
  const body = await seal(plain, opts.keyring, wireId)
  const date = new Date(opts.now ?? Date.now())
  const mid = createHmac('sha256', 'linkto').update(`${wireId}\n${rec.updatedAt}\n${randomBytes(4).toString('hex')}`).digest('hex').slice(0, 24)
  const headers = [
    'From: LinkTo <linkto-sync@localhost>',
    'To: <linkto-sync@localhost>',
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${mid}@linkto.vault>`,
    `Subject: ${VAULT_SUBJECT_PREFIX}${wireId}`,
    'MIME-Version: 1.0',
    `X-LinkTo-Vault: ${wireId}`,
    `X-LinkTo-Kind: ${kindTag(opts.category, indexKey)}`,
    `X-LinkTo-Updated: ${Math.floor(rec.updatedAt)}`,
    `X-LinkTo-Tomb: ${rec.deleted ? 1 : 0}`,
    `X-LinkTo-Check: ${passCheck(indexKey)}`,
    `X-LinkTo-Proto: ${VAULT_PROTO}`,
    ...(opts.device ? [`X-LinkTo-Device: ${encodeURIComponent(opts.device).slice(0, 200)}`] : []),
    'Content-Type: application/json; charset=utf-8',
    'Content-Transfer-Encoding: base64'
  ]
  return { raw: Buffer.from(`${headers.join('\r\n')}\r\n\r\n${b64Lines(body)}\r\n`, 'utf8'), wireId, size: plain.length }
}

export function vaultHeaderMeta(uid: number, headers: Record<string, string>): VaultHeader | null {
  const wireId = (headers['x-linkto-vault'] ?? '').trim()
  const updatedAt = Number((headers['x-linkto-updated'] ?? '').trim())
  if (!wireId || !Number.isFinite(updatedAt)) return null
  return { uid, wireId, updatedAt, kind: (headers['x-linkto-kind'] ?? '').trim(), tomb: (headers['x-linkto-tomb'] ?? '').trim() === '1', check: (headers['x-linkto-check'] ?? '').trim() }
}

export async function decodeVaultMessage(raw: Buffer, keyring: KeyRing): Promise<VaultRecord> {
  const text = raw.toString('utf8')
  const sep = text.search(/\r?\n\r?\n/)
  if (sep < 0) throw new TodoSyncError('format', '同步邮件格式错误')
  const headers = parseHeaderBlock(text.slice(0, sep))
  const wireId = (headers['x-linkto-vault'] ?? '').trim()
  if (!wireId) throw new TodoSyncError('format', '同步邮件缺少 X-LinkTo-Vault')
  const bodyText = text.slice(sep).replace(/^\r?\n\r?\n/, '')
  const body = Buffer.from(bodyText.replace(/\s+/g, ''), 'base64')
  let env: unknown
  try {
    env = JSON.parse(body.toString('utf8'))
  } catch {
    throw new TodoSyncError('format', '同步邮件正文不是 JSON')
  }
  if (!env || typeof env !== 'object' || !('ct' in env)) throw new TodoSyncError('format', '同步记录未加密')
  const plain = await open(env as EncEnvelope, keyring, wireId)
  let rec: Partial<VaultRecord>
  try {
    rec = JSON.parse(plain.toString('utf8'))
  } catch {
    throw new TodoSyncError('format', '解密后的记录不是 JSON')
  }
  if (!rec || typeof rec.type !== 'string' || typeof rec.id !== 'string' || !Number.isFinite(Number(rec.updatedAt)))
    throw new TodoSyncError('format', '同步记录缺少必要字段')
  // wireId 与内容必须吻合（防止被挪用到另一条记录名下）
  const indexKey = await keyring.indexKey()
  if (vaultWireId(rec.type, rec.id, indexKey) !== wireId) throw new TodoSyncError('format', '同步记录与索引不符')
  return {
    v: Number(rec.v) || VAULT_PROTO,
    type: rec.type,
    id: rec.id,
    updatedAt: Number(rec.updatedAt),
    deleted: !!rec.deleted,
    device: rec.device ? String(rec.device) : undefined,
    deviceId: rec.deviceId ? String(rec.deviceId) : undefined,
    data: rec.deleted ? null : rec.data ?? null,
    refs: rec.refs && typeof rec.refs === 'object' ? rec.refs : undefined
  }
}

// ---------------- 本地状态与合并决策 ----------------

/** 每条记录在本机的同步状态（devsync_state 表） */
export interface StateRow {
  type: string
  id: string
  wire: string
  /** 上次同步时本地内容的哈希；null = 本地没有（已删除 / 只见过远端墓碑） */
  hash: string | null
  /** 本地内容的版本（上次推送或落地远端时的 updatedAt） */
  localVer: number
  /** 见过的远端最新版本 */
  remoteVer: number
  deleted: boolean
  /** 超过大小上限，未推送 */
  skipped: boolean
}

export interface LocalItem {
  id: string
  data: unknown
  /** 模块自带的修改时间（没有就不填） */
  mtime?: number
  /** 参与哈希的部分（不填 = data）：如 OAuth 凭据只看 refresh token，access token 每小时刷新不算改动 */
  sig?: unknown
}

export interface LocalEntry {
  type: string
  id: string
  wire: string
  item: LocalItem | null
  hash: string | null
  ver: number
  changed: boolean
  /** 本机第一次见到（没有同步状态） */
  first: boolean
}

/** 由快照 + 状态得出本地版本：哈希变了 = 本地改过 */
export function localEntryOf(type: string, item: LocalItem, hash: string, st: StateRow | undefined, wire: string, now: number): LocalEntry {
  if (!st) return { type, id: item.id, wire, item, hash, ver: item.mtime && item.mtime > 0 ? item.mtime : 0, changed: true, first: true }
  if (st.deleted || st.hash !== hash) {
    const base = item.mtime && item.mtime > 0 ? item.mtime : now
    return { type, id: item.id, wire, item, hash, ver: Math.max(base, st.localVer + 1), changed: true, first: false }
  }
  return { type, id: item.id, wire, item, hash, ver: st.localVer, changed: false, first: false }
}

/** 本地已不存在、状态里还在的记录 → 本地删除（墓碑） */
export function tombstoneEntryOf(st: StateRow, now: number): LocalEntry {
  if (st.deleted) return { type: st.type, id: st.id, wire: st.wire, item: null, hash: null, ver: st.localVer, changed: false, first: false }
  return { type: st.type, id: st.id, wire: st.wire, item: null, hash: null, ver: Math.max(now, st.localVer + 1), changed: true, first: false }
}

export interface RemoteGroup {
  best: VaultHeader
  all: VaultHeader[]
}

export function groupVault(remote: VaultHeader[]): Map<string, RemoteGroup> {
  const out = new Map<string, RemoteGroup>()
  for (const h of remote) {
    const g = out.get(h.wireId)
    if (!g) out.set(h.wireId, { best: h, all: [h] })
    else {
      g.all.push(h)
      if (h.updatedAt > g.best.updatedAt || (h.updatedAt === g.best.updatedAt && h.uid > g.best.uid)) g.best = h
    }
  }
  return out
}

/** 是否需要下载远端这一组的最新版本 */
export function needsDownload(g: RemoteGroup, local: LocalEntry | undefined, st: StateRow | undefined): boolean {
  if (!local && !st) return !g.best.tomb
  if (local?.first || !st) return true
  // 远端比上次见过的新就下载（即使本地也改过：用于判定冲突、按后写者胜）
  return g.best.updatedAt > st.remoteVer
}

export type ApplyDecision = 'apply' | 'keep-local' | 'noop'

/** 远端记录落地决策：远端更新则落地；本地更新则保留（稍后推送）；首次接触以远端为准 */
export function decideVault(local: LocalEntry | undefined, remote: Pick<VaultRecord, 'updatedAt' | 'deleted'>): ApplyDecision {
  if (!local) return remote.deleted ? 'noop' : 'apply'
  if (local.first) {
    if (!local.item) return remote.deleted ? 'noop' : 'apply'
    // 首次接触：远端活记录 → 以远端为准；远端墓碑 → 只有确知本地更早时才删（不知道修改时间就保留）
    if (!remote.deleted) return 'apply'
    const m = local.item.mtime ?? 0
    return m > 0 && remote.updatedAt > m ? 'apply' : 'keep-local'
  }
  if (remote.updatedAt > local.ver) return remote.deleted && !local.item ? 'noop' : 'apply'
  return 'keep-local'
}

/** 本地这一条是否需要推送 */
export function needsPush(local: LocalEntry, g: RemoteGroup | undefined, st: StateRow | undefined): boolean {
  if (!local.item) {
    // 本地删除：远端有活记录才需要推墓碑
    return local.changed && !!g && !g.best.tomb && local.ver > g.best.updatedAt
  }
  if (local.changed) return !g || local.ver > g.best.updatedAt
  // 没改过但远端没有（文件夹被清空 / 墓碑被清理）：补传（超限跳过的除外）
  return !g && !st?.skipped
}

export function isExpiredVaultTombstone(h: VaultHeader, now: number): boolean {
  return h.tomb && h.updatedAt < now - VAULT_TOMBSTONE_TTL_MS
}
