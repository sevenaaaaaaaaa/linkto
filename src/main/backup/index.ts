import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { dialog, BrowserWindow } from 'electron'
import type { AccountConfig, OAuthTokens } from '@shared/types'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import type { SyncEngine } from '../mail/sync-engine'
import type { MailSender } from '../mail/sender'
import type { OAuthService } from '../oauth'

const APP_TAG = 'linkto-backup'
const FORMAT_VERSION = 1
const EXT = '.lkbak'

export interface BackupTarget {
  id: string
  label: string
  path: string
  available: boolean
}

export interface BackupMeta {
  createdAt: number
  accountCount: number
  hasSecrets: boolean
}

interface BackupEnvelope {
  app: string
  v: number
  kdf: 'scrypt'
  salt: string
  iv: string
  tag: string
  ciphertext: string
  // 头部明文字段（无需口令即可读取，用于恢复前展示）
  createdAt: number
  accountCount: number
  hasSecrets: boolean
}

interface BackupPayload {
  accounts: { config: AccountConfig; secret?: string; oauth?: OAuthTokens }[]
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 })
}

/** 加密：AES-256-GCM + scrypt 口令派生（跨设备安全，不依赖本机钥匙串） */
function encryptJson(data: unknown, passphrase: string) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { salt, iv, tag: cipher.getAuthTag(), ciphertext }
}

function decryptJson<T>(env: { salt: string; iv: string; tag: string; ciphertext: string }, passphrase: string): T {
  const key = deriveKey(passphrase, Buffer.from(env.salt, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()])
  return JSON.parse(plaintext.toString('utf8')) as T
}

/**
 * 账户配置备份与恢复：口令加密的 .lkbak 文件，投递到 iCloud Drive / Dropbox / Proton Drive
 * 的本地同步目录即自动云同步，实现跨设备恢复，免重复填写。
 */
export class BackupService {
  constructor(
    private deps: {
      store: MailStore
      appStore: AppStore
      engine: SyncEngine
      sender: MailSender
      oauth: OAuthService
      event(payload: unknown): void
    }
  ) {}

  /** 可用的备份目标（检测各网盘的本地同步目录） */
  listTargets(): BackupTarget[] {
    const home = this.deps.appStore.dataDir.split('/Library/')[0]
    const candidates: BackupTarget[] = []
    const push = (id: string, label: string, path: string) =>
      candidates.push({ id, label, path, available: existsSync(path) })

    push('icloud', 'iCloud Drive', join(home, 'Library/Mobile Documents/iCloud~com~apple~CloudDocs'))
    // 第三方网盘在 macOS 上通常挂载在 ~/Library/CloudStorage/
    const cloudStorage = join(home, 'Library/CloudStorage')
    try {
      for (const name of readdirSync(cloudStorage)) {
        const lower = name.toLowerCase()
        if (lower.includes('dropbox')) push('dropbox', 'Dropbox', join(cloudStorage, name))
        else if (lower.includes('proton')) push('proton', 'Proton Drive', join(cloudStorage, name))
        else if (lower.includes('onedrive')) push('onedrive', 'OneDrive', join(cloudStorage, name))
        else if (lower.includes('nutstore') || lower.includes('jianguoyun')) push('nutstore', '坚果云', join(cloudStorage, name))
      }
    } catch { /* CloudStorage 不存在则跳过 */ }
    push('dropbox-fallback', 'Dropbox（~/Dropbox）', join(home, 'Dropbox'))
    return candidates
  }

  /** 组装备份内容 */
  private collect(includeSecrets: boolean): BackupPayload {
    const accounts = this.deps.store.listAccounts().map(a => {
      const item: BackupPayload['accounts'][number] = { config: a }
      if (includeSecrets) {
        if (a.authType === 'oauth') {
          const oauth = this.deps.oauth.loadTokens(a.id)
          if (oauth) item.oauth = oauth
        } else {
          const secret = this.deps.appStore.loadSecret(`acct:${a.id}`)
          if (secret) item.secret = secret
        }
      }
      return item
    })
    return { accounts }
  }

  /** 导出备份到指定目标目录，返回文件完整路径 */
  async exportTo(
    targetId: string,
    passphrase: string,
    includeSecrets: boolean
  ): Promise<{ ok: boolean; error?: string; path?: string; accountCount?: number }> {
    if (!passphrase || passphrase.length < 4) return { ok: false, error: '请设置至少 4 位的备份口令' }
    let dir = ''
    if (targetId === 'pick') {
      const win = BrowserWindow.getAllWindows()[0]
      const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      if (res.canceled || !res.filePaths[0]) return { ok: false, error: '未选择目录' }
      dir = res.filePaths[0]
    } else {
      const target = this.listTargets().find(t => t.id === targetId)
      if (!target?.available) return { ok: false, error: '该备份目标不可用（未检测到同步目录）' }
      dir = target.path
    }
    const payload = this.collect(includeSecrets)
    if (!payload.accounts.length) return { ok: false, error: '还没有账户可备份' }
    const { salt, iv, tag, ciphertext } = encryptJson(payload, passphrase)
    const env: BackupEnvelope = {
      app: APP_TAG,
      v: FORMAT_VERSION,
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      createdAt: Date.now(),
      accountCount: payload.accounts.length,
      hasSecrets: includeSecrets
    }
    const ts = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '')
    const path = join(dir, `LinkTo-Backup-${ts}${EXT}`)
    try {
      writeFileSync(path, JSON.stringify(env, null, 2))
      return { ok: true, path, accountCount: payload.accounts.length }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 选择一个备份文件并读取头部信息（无需口令） */
  async pickForRestore(): Promise<{ ok: boolean; error?: string; path?: string; meta?: BackupMeta }> {
    const win = BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: '林可兔备份', extensions: ['lkbak'] }]
    })
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: '未选择备份文件' }
    const path = res.filePaths[0]
    try {
      const env = JSON.parse(readFileSync(path, 'utf8')) as BackupEnvelope
      if (env.app !== APP_TAG) return { ok: false, error: '不是林可兔的备份文件' }
      return { ok: true, path, meta: { createdAt: env.createdAt, accountCount: env.accountCount, hasSecrets: env.hasSecrets } }
    } catch (err) {
      return { ok: false, error: `读取失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** 用口令解密并恢复账户（同 provider+email 已存在则跳过），返回恢复摘要 */
  async restoreApply(
    path: string,
    passphrase: string
  ): Promise<{ ok: boolean; error?: string; added: string[]; skipped: string[]; failed: string[] }> {
    const added: string[] = []
    const skipped: string[] = []
    const failed: string[] = []
    try {
      const env = JSON.parse(readFileSync(path, 'utf8')) as BackupEnvelope
      const payload = decryptJson<BackupPayload>(env, passphrase)
      const existing = this.deps.store.listAccounts()
      for (const item of payload.accounts) {
        const c = item.config
        if (!c?.email) continue
        const dup = existing.find(a => a.provider === c.provider && a.email.toLowerCase() === c.email.toLowerCase())
        if (dup) {
          skipped.push(`${c.email}（已存在）`)
          continue
        }
        try {
          const id = `${c.id}` || `restored-${Date.now()}-${Math.random().toString(36).slice(2)}`
          const account: AccountConfig = { ...c, id, createdAt: c.createdAt || Date.now(), authType: c.authType ?? 'password' }
          this.deps.store.upsertAccount(account)
          if (account.authType === 'oauth' && item.oauth) {
            this.deps.oauth.saveTokens(id, item.oauth)
          } else if (item.secret) {
            this.deps.appStore.saveSecret(`acct:${id}`, item.secret)
          }
          if (account.enabled) this.deps.engine.startAccount(account)
          this.deps.sender.drop(id)
          added.push(`${account.email}${item.secret || item.oauth ? '（含凭据）' : '（需重新输入密码/重新授权）'}`)
        } catch (err) {
          failed.push(`${c.email}：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      this.deps.event({ type: 'accounts-changed' })
      return { ok: true, added, skipped, failed }
    } catch {
      return { ok: false, error: '口令错误或备份文件已损坏', added, skipped, failed }
    }
  }
}

export { EXT as BACKUP_EXT }