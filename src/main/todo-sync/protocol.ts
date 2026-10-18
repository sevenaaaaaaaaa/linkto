/**
 * 待办跨设备同步 · 线格式（wire format）与合并逻辑 —— 纯函数，无 Electron 依赖（mobile/ 可照此实现）
 *
 * 载体：用户自己的一个邮箱里的隐藏 IMAP 文件夹 `LinkTo-Sync`
 *   - 不存在则创建；Gmail 上即同名标签；Proton Bridge 上为 `Folders/LinkTo-Sync`；
 *     带命名空间前缀的服务器可能是 `INBOX.LinkTo-Sync`。识别规则：路径最后一段（按 / 或 . 切分）
 *     不区分大小写等于 `LinkTo-Sync`。客户端不应把它当普通邮件文件夹展示。
 *
 * 每条待办 = 文件夹里的一封邮件（同一待办任何时刻应只有一封；出现多封时保留最新、删除其余）：
 *
 *   Subject: [linkto-todo] <wireId>
 *   X-LinkTo-Todo: <wireId>
 *   X-LinkTo-Updated: <updatedAt，毫秒时间戳，十进制>
 *   X-LinkTo-Encrypted: 1 | 0
 *   X-LinkTo-Proto: 1
 *   X-LinkTo-Device: <encodeURIComponent(设备名)>（仅供展示）
 *   Content-Type: application/json; charset=utf-8
 *   Content-Transfer-Encoding: base64
 *
 *   wireId：
 *     - 未加密：`p:` + encodeURIComponent(todo id)
 *     - 加密：  `h:` + hex(HMAC-SHA256(indexKey, todo id)) 的前 32 位
 *               indexKey = scrypt(passphrase, salt = UTF-8 "linkto-todo-sync/index/v1", N=16384, r=8, p=1, 32 字节)
 *               （加密时邮件头不暴露任何待办内容，包括可能含标题的 id）
 *
 *   正文（base64 解码后的 UTF-8 JSON）：
 *     - 明文：WireTodo = { v:1, id, title, status: 'open'|'done'|'dismissed', dueAt: ms|null,
 *                         createdAt: ms, updatedAt: ms, accountId?, messageId?, data: TodoData, device? }
 *     - 加密：{ v:1, enc:'aes-256-gcm', kdf:'scrypt', N:16384, r:8, p:1, salt, iv, tag, ct }（均为 base64）
 *               key = scrypt(passphrase, salt, 32)；iv 12 字节；AAD = UTF-8 的 wireId；
 *               ct 解密后即上面的明文 WireTodo JSON。salt 可每台设备/每次启动随机生成一次并复用。
 *
 * 同步一轮：
 *   1. 只拉所有邮件的 X-LinkTo-Todo / X-LinkTo-Updated 头（不下载正文）
 *   2. 同一 wireId 多封：保留 (updatedAt, UID) 最大的一封，其余删除（\Deleted + UID EXPUNGE）
 *   3. 远端 updatedAt > 本地 updatedAt（或本地没有）→ 下载正文，后写者胜（LWW）写入本地，
 *      本地写入时保持 data.updatedAt = 远端值（不刷新）
 *   4. 本地 updatedAt > 远端（或远端没有）→ APPEND 新版本，再删除该待办的旧版本邮件
 *   5. 墓碑：删除 = status 'dismissed'，照常传播；updatedAt 超过 30 天的墓碑从文件夹里清除，且不再上传
 *   本地 updatedAt 取 data.updatedAt，缺失时退回 createdAt。
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt } from 'node:crypto'

export const SYNC_FOLDER_NAME = 'LinkTo-Sync'
export const PROTO_VERSION = 1
export const SUBJECT_PREFIX = '[linkto-todo] '
/** 墓碑保留期：超过即从同步文件夹清除 */
export const TOMBSTONE_TTL_MS = 30 * 864e5
const INDEX_SALT = 'linkto-todo-sync/index/v1'
const KDF = { N: 16384, r: 8, p: 1 }

/** 路径是否为同步文件夹（兼容 Folders/、INBOX. 等前缀） */
export function isTodoSyncFolder(path: string | undefined | null): boolean {
  if (!path) return false
  const last = path.split(/[/.]/).pop() ?? path
  return last.toLowerCase() === SYNC_FOLDER_NAME.toLowerCase()
}

// ---------------- 数据模型 ----------------

export type TodoStatus = 'open' | 'done' | 'dismissed'

/** 线上传输的待办（明文正文） */
export interface WireTodo {
  v: number
  id: string
  title: string
  status: string
  dueAt: number | null
  createdAt: number
  updatedAt: number
  accountId?: string | null
  messageId?: string | null
  data: Record<string, unknown>
  device?: string
}

/** 本地待办行（insights 表 kind='todo'） */
export interface LocalTodo {
  id: string
  title: string
  status: string
  dueAt: number | null
  createdAt: number
  accountId?: string | null
  messageId?: string | null
  data: Record<string, unknown>
}

/** 远端一封同步邮件的头信息 */
export interface RemoteHeader {
  uid: number
  wireId: string
  updatedAt: number
  encrypted: boolean
}

export class TodoSyncError extends Error {
  readonly code: 'passphrase' | 'need-passphrase' | 'format'
  constructor(code: TodoSyncError['code'], message: string) {
    super(message)
    this.code = code
  }
}

/** 本地版本号：data.updatedAt，缺失时用 createdAt */
export function versionOf(t: Pick<LocalTodo, 'data' | 'createdAt'>): number {
  const u = Number((t.data as { updatedAt?: unknown } | undefined)?.updatedAt)
  return Number.isFinite(u) && u > 0 ? u : Number(t.createdAt) || 0
}

export function isExpiredTombstone(status: string, updatedAt: number, now: number): boolean {
  return status === 'dismissed' && updatedAt < now - TOMBSTONE_TTL_MS
}

export function toWire(t: LocalTodo, device?: string): WireTodo {
  return {
    v: PROTO_VERSION,
    id: t.id,
    title: t.title,
    status: t.status,
    dueAt: t.dueAt ?? null,
    createdAt: t.createdAt,
    updatedAt: versionOf(t),
    accountId: t.accountId ?? null,
    messageId: t.messageId ?? null,
    data: { ...t.data, updatedAt: versionOf(t) },
    ...(device ? { device } : {})
  }
}

// ---------------- 加密 ----------------

function scryptAsync(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(passphrase, salt, 32, { ...KDF, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)))
  )
}

/**
 * 口令派生的密钥环：indexKey 用于不透明 wireId；本设备一个随机 salt 加密新消息；
 * 解密按消息 salt 缓存派生结果（scrypt 很慢，每个 salt 只算一次，且走异步不阻塞主进程）。
 */
export class KeyRing {
  private cache = new Map<string, Promise<Buffer>>()
  private indexKeyP: Promise<Buffer> | null = null
  readonly ownSalt = randomBytes(16)
  private readonly passphrase: string

  constructor(passphrase: string) {
    this.passphrase = passphrase
  }

  indexKey(): Promise<Buffer> {
    this.indexKeyP ??= scryptAsync(this.passphrase, Buffer.from(INDEX_SALT, 'utf8'))
    return this.indexKeyP
  }

  keyFor(salt: Buffer): Promise<Buffer> {
    const k = salt.toString('base64')
    let p = this.cache.get(k)
    if (!p) {
      p = scryptAsync(this.passphrase, salt)
      this.cache.set(k, p)
    }
    return p
  }
}

export function wireIdFor(id: string, indexKey: Buffer | null): string {
  if (!indexKey) return `p:${encodeURIComponent(id)}`
  return `h:${createHmac('sha256', indexKey).update(id, 'utf8').digest('hex').slice(0, 32)}`
}

/** 明文 wireId 可直接还原 id；加密 wireId 返回 null */
export function plainIdOf(wireId: string): string | null {
  if (!wireId.startsWith('p:')) return null
  try {
    return decodeURIComponent(wireId.slice(2))
  } catch {
    return null
  }
}

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

async function encryptBody(plain: Buffer, keyring: KeyRing, aad: string): Promise<Buffer> {
  const key = await keyring.keyFor(keyring.ownSalt)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const env: EncEnvelope = {
    v: PROTO_VERSION,
    enc: 'aes-256-gcm',
    kdf: 'scrypt',
    ...KDF,
    salt: keyring.ownSalt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64')
  }
  return Buffer.from(JSON.stringify(env), 'utf8')
}

async function decryptBody(env: EncEnvelope, keyring: KeyRing, aad: string): Promise<Buffer> {
  if (env.enc !== 'aes-256-gcm' || env.kdf !== 'scrypt') throw new TodoSyncError('format', `不支持的加密方式：${env.enc}`)
  const key = await keyring.keyFor(Buffer.from(env.salt, 'base64'))
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'))
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()])
  } catch {
    throw new TodoSyncError('passphrase', '同步口令不正确')
  }
}

// ---------------- MIME 编解码 ----------------

function base64Lines(buf: Buffer): string {
  return (buf.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')
}

/** 编码为一封 RFC 5322 邮件（CRLF 行尾） */
export async function encodeMessage(
  todo: WireTodo,
  opts: { keyring: KeyRing | null; device?: string; address?: string; now?: number }
): Promise<{ raw: Buffer; wireId: string }> {
  const indexKey = opts.keyring ? await opts.keyring.indexKey() : null
  const wireId = wireIdFor(todo.id, indexKey)
  const plain = Buffer.from(JSON.stringify(todo), 'utf8')
  const body = opts.keyring ? await encryptBody(plain, opts.keyring, wireId) : plain
  const addr = opts.address || 'linkto-sync@localhost'
  const date = new Date(opts.now ?? Date.now())
  const msgIdLocal = createHmac('sha256', 'linkto').update(`${wireId}\n${todo.updatedAt}\n${randomBytes(4).toString('hex')}`).digest('hex').slice(0, 24)
  const headers = [
    `From: LinkTo <${addr}>`,
    `To: <${addr}>`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${msgIdLocal}@linkto.sync>`,
    `Subject: ${SUBJECT_PREFIX}${wireId}`,
    'MIME-Version: 1.0',
    `X-LinkTo-Todo: ${wireId}`,
    `X-LinkTo-Updated: ${Math.floor(todo.updatedAt)}`,
    `X-LinkTo-Encrypted: ${opts.keyring ? 1 : 0}`,
    `X-LinkTo-Proto: ${PROTO_VERSION}`,
    ...(opts.device ? [`X-LinkTo-Device: ${encodeURIComponent(opts.device).slice(0, 200)}`] : []),
    'Content-Type: application/json; charset=utf-8',
    'Content-Transfer-Encoding: base64'
  ]
  return { raw: Buffer.from(`${headers.join('\r\n')}\r\n\r\n${base64Lines(body)}\r\n`, 'utf8'), wireId }
}

/** 解析原始头（含折行延续）；键名小写 */
export function parseHeaderBlock(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let lastKey = ''
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && lastKey) {
      out[lastKey] += ' ' + line.trim()
      continue
    }
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    lastKey = line.slice(0, idx).trim().toLowerCase()
    out[lastKey] = line.slice(idx + 1).trim()
  }
  return out
}

/** 从头信息取远端元数据；不是同步邮件返回 null */
export function headerMeta(uid: number, headers: Record<string, string>): RemoteHeader | null {
  const wireId = (headers['x-linkto-todo'] ?? '').trim()
  const updatedAt = Number((headers['x-linkto-updated'] ?? '').trim())
  if (!wireId || !Number.isFinite(updatedAt)) return null
  return { uid, wireId, updatedAt, encrypted: (headers['x-linkto-encrypted'] ?? '').trim() === '1' || wireId.startsWith('h:') }
}

/** 解码一封同步邮件；keyring 为空时遇到加密正文抛 need-passphrase */
export async function decodeMessage(raw: Buffer, keyring: KeyRing | null): Promise<WireTodo> {
  const text = raw.toString('utf8')
  const sep = text.search(/\r?\n\r?\n/)
  if (sep < 0) throw new TodoSyncError('format', '同步邮件格式错误')
  const headers = parseHeaderBlock(text.slice(0, sep))
  const wireId = (headers['x-linkto-todo'] ?? '').trim()
  if (!wireId) throw new TodoSyncError('format', '同步邮件缺少 X-LinkTo-Todo')
  const bodyText = text.slice(sep).replace(/^\r?\n\r?\n/, '')
  const cte = (headers['content-transfer-encoding'] ?? '').toLowerCase()
  const body = cte === 'base64' ? Buffer.from(bodyText.replace(/\s+/g, ''), 'base64') : Buffer.from(bodyText.trim(), 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw new TodoSyncError('format', '同步邮件正文不是 JSON')
  }
  let todo: unknown = parsed
  if (parsed && typeof parsed === 'object' && 'ct' in parsed) {
    if (!keyring) throw new TodoSyncError('need-passphrase', '同步文件夹中的待办已加密，需要同步口令')
    const plain = await decryptBody(parsed as EncEnvelope, keyring, wireId)
    try {
      todo = JSON.parse(plain.toString('utf8'))
    } catch {
      throw new TodoSyncError('format', '解密后的待办不是 JSON')
    }
  }
  const t = todo as Partial<WireTodo>
  if (!t || typeof t.id !== 'string' || typeof t.title !== 'string' || !Number.isFinite(Number(t.updatedAt)))
    throw new TodoSyncError('format', '同步邮件缺少必要字段')
  return {
    v: Number(t.v) || PROTO_VERSION,
    id: t.id,
    title: t.title,
    status: ['open', 'done', 'dismissed'].includes(String(t.status)) ? String(t.status) : 'open',
    dueAt: t.dueAt == null ? null : Number(t.dueAt),
    createdAt: Number(t.createdAt) || Number(t.updatedAt),
    updatedAt: Number(t.updatedAt),
    accountId: t.accountId ?? null,
    messageId: t.messageId ?? null,
    data: t.data && typeof t.data === 'object' ? { ...t.data, updatedAt: Number(t.updatedAt) } : { updatedAt: Number(t.updatedAt) },
    ...(t.device ? { device: String(t.device) } : {})
  }
}

// ---------------- 合并（后写者胜） ----------------

export interface RemoteGroup {
  /** 已知的本地 id（明文 wireId 可还原，或与本地某条 id 的加密 wireId 吻合） */
  id: string | null
  best: RemoteHeader
  all: RemoteHeader[]
}

/** 按待办归组：同一待办可能有明文 / 加密两种 wireId（设备设置不一致时），按还原出的 id 合并 */
export function groupRemote(remote: RemoteHeader[], wireToId: Map<string, string>): Map<string, RemoteGroup> {
  const groups = new Map<string, RemoteGroup>()
  for (const h of remote) {
    const id = wireToId.get(h.wireId) ?? plainIdOf(h.wireId)
    const key = id !== null ? `id:${id}` : `w:${h.wireId}`
    const g = groups.get(key)
    if (!g) groups.set(key, { id, best: h, all: [h] })
    else {
      g.all.push(h)
      if (h.updatedAt > g.best.updatedAt || (h.updatedAt === g.best.updatedAt && h.uid > g.best.uid)) g.best = h
    }
  }
  return groups
}

export interface PullPlan {
  /** 需要下载正文的远端邮件（每组最新一封） */
  download: RemoteHeader[]
  /** 同一待办的旧版本 / 重复邮件 */
  duplicates: number[]
}

export function planPull(local: LocalTodo[], groups: Map<string, RemoteGroup>): PullPlan {
  const byId = new Map(local.map(t => [t.id, t]))
  const download: RemoteHeader[] = []
  const duplicates: number[] = []
  for (const g of groups.values()) {
    for (const h of g.all) if (h !== g.best) duplicates.push(h.uid)
    const l = g.id !== null ? byId.get(g.id) : undefined
    if (!l || g.best.updatedAt > versionOf(l)) download.push(g.best)
  }
  return { download, duplicates }
}

export type ApplyAction = 'insert' | 'update' | 'skip'

/** 远端版本落地决策；purge=true 表示这封远端邮件是过期墓碑，应从文件夹清除 */
export function decideApply(local: LocalTodo | undefined, remote: WireTodo, now: number): { action: ApplyAction; purge: boolean } {
  const purge = isExpiredTombstone(remote.status, remote.updatedAt, now)
  if (!local) return { action: purge ? 'skip' : 'insert', purge }
  return { action: remote.updatedAt > versionOf(local) ? 'update' : 'skip', purge }
}

export interface PushPlan {
  /** 需要上传新版本的本地待办，及其被取代的旧远端邮件 */
  push: { todo: LocalTodo; supersedes: number[] }[]
  /** 过期墓碑：只删远端，不再上传 */
  purge: number[]
}

export function planPush(local: LocalTodo[], groups: Map<string, RemoteGroup>, now: number): PushPlan {
  const byId = new Map<string, RemoteGroup>()
  for (const g of groups.values()) if (g.id !== null) byId.set(g.id, g)
  const push: PushPlan['push'] = []
  const purge: number[] = []
  for (const t of local) {
    const v = versionOf(t)
    const g = byId.get(t.id)
    if (isExpiredTombstone(t.status, v, now)) {
      if (g && g.best.updatedAt <= v) purge.push(...g.all.map(h => h.uid))
      continue
    }
    if (!g || v > g.best.updatedAt) push.push({ todo: t, supersedes: g ? g.all.map(h => h.uid) : [] })
  }
  return { push, purge }
}
