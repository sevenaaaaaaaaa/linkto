import { gcm } from '@noble/ciphers/aes.js'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { utf8, unb64 } from '../storage/encrypted'
import { decodeUtf8Bytes } from '../imap/encoding'
import type { MobileAccount } from '../store/mail'
import type { WorkItem } from '../workbench/model'

export const BACKUP_LIMIT = 32 * 1024 * 1024
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
const number = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
export interface BackupEnvelope { app: string; v: number; kdf: string; salt: string; iv: string; tag: string; ciphertext: string; createdAt: number }
export interface RestoredAccount { account: MobileAccount; secret?: string; reason?: string; desktopOnly?: boolean }
export interface BackupPlan { accounts: RestoredAccount[]; items: WorkItem[]; msClientId?: string; ai?: { baseUrl: string; model: string; key?: string }; unsupported: number; createdAt: number }

export function parseBackup(raw: string): BackupEnvelope {
  if (raw.length > BACKUP_LIMIT) throw new Error('备份文件超过 32 MB，请在电脑按类别重新导出')
  let env: Record<string, unknown>
  try { env = object(JSON.parse(raw)) } catch { throw new Error('不是有效的 LinkTo .lkbak 备份文件') }
  if (env.app !== 'linkto-backup') throw new Error('不是 LinkTo 备份文件，请选择 .lkbak 文件')
  if (![1, 2].includes(Number(env.v)) || env.kdf !== 'scrypt') throw new Error('暂不支持此备份版本，请先更新应用')
  for (const key of ['salt', 'iv', 'tag', 'ciphertext']) {
    if (typeof env[key] !== 'string' || !(env[key] as string).length || (env[key] as string).length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(env[key] as string)) throw new Error('备份文件不完整或已损坏')
  }
  if (unb64(text(env.salt)).length !== 16 || unb64(text(env.iv)).length !== 12 || unb64(text(env.tag)).length !== 16) throw new Error('备份加密参数无效')
  return env as unknown as BackupEnvelope
}

export async function unlockBackup(env: BackupEnvelope, passphrase: string): Promise<BackupPlan> {
  if (!passphrase) throw new Error('请输入导出备份时设置的口令')
  const key = await scryptAsync(utf8(passphrase), unb64(env.salt), { N: 16384, r: 8, p: 1, dkLen: 32, maxmem: 64 * 1024 * 1024, asyncTick: 8 })
  let payload: Record<string, unknown>
  let plain: Uint8Array | undefined
  try {
    const ciphertext = unb64(env.ciphertext), tag = unb64(env.tag)
    const combined = new Uint8Array(ciphertext.length + tag.length); combined.set(ciphertext); combined.set(tag, ciphertext.length)
    plain = gcm(key, unb64(env.iv)).decrypt(combined)
    payload = object(JSON.parse(decodeUtf8Bytes(plain)))
  } catch { throw new Error('备份口令不正确，或文件已损坏；手机数据未改变') }
  finally { key.fill(0); plain?.fill(0) }
  if (!Array.isArray(payload.accounts) || payload.accounts.length > 500 || (payload.records != null && !Array.isArray(payload.records))) throw new Error('备份内容格式无效；手机数据未改变')
  const accounts: RestoredAccount[] = []
  const ms = object(object(payload.oauthClients).ms)
  const msClientId = /^[a-f0-9-]{36}$/i.test(text(ms.clientId)) ? text(ms.clientId) : undefined
  for (const [index, raw] of payload.accounts.entries()) {
    const entry = object(raw), c = object(entry.config), imap = object(c.imap), smtp = object(c.smtp)
    const email = text(c.email).trim().toLowerCase(), host = text(imap.host).trim(), provider = text(c.provider)
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || !host || !Number.isInteger(imap.port) || number(imap.port) < 1 || number(imap.port) > 65535) throw new Error(`备份中第 ${index + 1} 个邮箱配置无效；尚未恢复`)
    const local = (value: string) => /^(?:localhost|.*\.localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)$/i.test(value)
    const desktopOnly = provider === 'proton' || local(host) || local(text(smtp.host)) || object(entry.extra).deviceBound === true
    const isOAuth = c.authType === 'oauth', microsoft = ['outlook', 'hotmail', 'office365', 'microsoft'].includes(provider) || /(?:outlook|office365)\.com$/i.test(host)
    let secret = text(entry.secret) || undefined, reason: string | undefined
    let authType: MobileAccount['authType'] = 'password'
    if (desktopOnly) { secret = undefined; reason = '依赖电脑上的 Bridge / 本机服务，手机无法直连' }
    else if (isOAuth) {
      // Desktop refresh tokens may require a confidential client. Re-authorize on the phone.
      secret = undefined
      authType = microsoft ? 'oauth-ms' : 'password'
      reason = microsoft ? '请在手机重新授权 Microsoft 邮箱' : '请补充此邮箱的应用专用密码 / 授权码'
    } else if (!secret) reason = '备份未包含密码，请补充应用专用密码 / 授权码'
    if (secret && secret.length > 65536) throw new Error('备份中的账户凭据过长')
    accounts.push({ account: { id: `restore-${index}`, email, username: text(c.user, email), host, port: number(imap.port, 993), secure: imap.secure !== false, smtpHost: text(smtp.host, host.replace(/^imap\./, 'smtp.')), smtpPort: number(smtp.port, 465), smtpSecure: smtp.secure !== false, color: /^#[0-9a-f]{6}$/i.test(text(c.color)) ? text(c.color) : '#596477', displayName: text(c.name, email), authType, credentialState: reason ? 'required' : 'ready' }, secret, reason, desktopOnly })
  }
  const items: WorkItem[] = []; let unsupported = 0
  let ai: BackupPlan['ai']
  const records = (payload.records ?? []) as unknown[]
  if (records.length > 100000) throw new Error('备份记录过多，请在电脑按类别重新导出')
  for (const raw of records) {
    const record = object(raw), data = object(record.data), inner = object(data.data), type = text(record.type)
    if (type === 'setting.ai') {
      const baseUrl = text(data.baseURL, text(data.baseUrl)), model = text(data.model)
      if (/^https?:\/\//.test(baseUrl) && model) ai = { baseUrl, model, ...(typeof data.apiKey === 'string' && data.apiKey ? { key: data.apiKey } : {}) }
    } else if (type === 'oauth-clients') { /* Restored separately from top-level oauthClients. */ }
    else if (['ins.todo', 'ins.memo'].includes(type) || (type === 'kb' && data.kind === 'note')) {
      if (!text(record.id) || !text(data.title) || !number(record.updatedAt)) throw new Error('备份中存在无效的待办 / 随手记记录')
      const memo = type !== 'ins.todo', updatedAt = number(record.updatedAt)
      const content = memo && type === 'kb' ? text(data.content) : text(inner.content, text(inner.notes))
      let source = object(inner.source)
      // Desktop record IDs are local. Resolve portable Message-ID/account refs.
      if (!source.accountEmail) {
        const localMessage = text(data.messageId, text(data.sourceMessageId)), parts = localMessage.split('::')
        const refs = object(record.refs), accountRefs = object(refs.a), messageRefs = object(refs.m)
        const oldAccountId = text(data.accountId, parts[0])
        const config = payload.accounts.map(a => object(object(a).config)).find(a => a.id === oldAccountId)
        const email = config ? text(config.email) : text(accountRefs[oldAccountId]).split('|').slice(1).join('|')
        const header = text(messageRefs[localMessage])
        if (email && header) source = { accountEmail: email.toLowerCase(), mailbox: parts.length >= 3 ? parts.slice(1, -1).join('::') : 'INBOX', uid: Number(parts[parts.length - 1]) || 0, messageId: header, subject: text(data.title), from: '', date: number(data.createdAt, updatedAt) }
      }
      if (data.status != null && !['open', 'done', 'dismissed'].includes(text(data.status))) throw new Error('备份中存在不支持的任务状态；尚未恢复')
      for (const field of ['collection', 'content', 'notes']) if (inner[field] != null && typeof inner[field] !== 'string') throw new Error('备份中的记录字段无效')
      const validSource = typeof source.accountEmail === 'string' && typeof source.mailbox === 'string' && Number.isInteger(source.uid) && number(source.uid, -1) >= 0 && typeof source.subject === 'string' && typeof source.from === 'string' && typeof source.date === 'number'
      items.push({ id: type === 'kb' ? `kb:${text(record.id)}` : text(record.id), kind: memo ? 'memo' : 'todo', title: text(data.title).slice(0, 240), status: ['open', 'done', 'dismissed'].includes(text(data.status)) ? data.status as WorkItem['status'] : 'open', dueAt: data.dueAt == null ? null : number(data.dueAt) || null, createdAt: number(data.createdAt, updatedAt), data: { ...inner, updatedAt, content, notes: content, reminder: false, ...(validSource ? { source: source as unknown as WorkItem['data']['source'] } : { source: undefined }) } })
    } else unsupported++
  }
  return { accounts, items, msClientId, ai, unsupported, createdAt: number(env.createdAt) }
}
