import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AISettings, NotificationAction } from '@shared/types'

export type { AISettings }

export interface GeneralSettings {
  remoteImages: 'block' | 'allow'
  deleteBehavior: 'trash' | 'perm'
  density: 'cozy' | 'compact'
  launchAtLogin: boolean
  dockBadge: boolean
}

export interface NotificationSettings {
  enabled: boolean
  actions: [NotificationAction, NotificationAction, NotificationAction]
  smart: boolean
  sound: boolean
  perAccount: Record<string, { enabled: boolean; sound: string }>
}

export const DEFAULT_GENERAL: GeneralSettings = {
  remoteImages: 'block',
  deleteBehavior: 'trash',
  density: 'cozy',
  launchAtLogin: false,
  dockBadge: true
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  actions: ['markRead', 'reply', 'delete'],
  smart: false,
  sound: true,
  perAccount: {}
}

export const DEFAULT_AI: AISettings = {
  enabled: false,
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  model: 'glm-4.7',
  autoClassify: false,
  autoSummary: false,
  autoInsights: true,
  autoDigest: true,
  customPrompts: []
}

/** 应用级设置 / 密钥 / 附件路径管理 */
export class AppStore {
  readonly dataDir: string
  readonly attachmentDir: string
  readonly emlDir: string
  readonly dbPath: string
  private kv!: DatabaseSync

  constructor() {
    // 保持 'mail-studio' 目录名以兼容老版本本地数据（不对外可见）
    this.dataDir = join(app.getPath('userData'), 'mail-studio')
    this.attachmentDir = join(this.dataDir, 'attachments')
    this.emlDir = join(this.dataDir, 'eml')
    this.dbPath = join(this.dataDir, 'mail.db')
    mkdirSync(this.attachmentDir, { recursive: true })
    mkdirSync(this.emlDir, { recursive: true })
    const secretDir = join(this.dataDir, 'secrets')
    mkdirSync(secretDir, { recursive: true })
    this.secretDir = secretDir
  }

  private secretDir: string

  initKv() {
    this.kv = new DatabaseSync(this.dbPath)
    this.kv.exec('PRAGMA journal_mode=WAL')
    this.kv.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  }

  get<T>(key: string, fallback: T): T {
    const row = this.kv.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return fallback
    try {
      return { ...fallback, ...(JSON.parse(row.value) as object) } as T
    } catch {
      return fallback
    }
  }

  set(key: string, value: unknown) {
    this.kv
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  getRaw<T>(key: string, fallback: T): T {
    const row = this.kv.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  // ---------- 密钥（safeStorage → 钥匙串级保护） ----------

  saveSecret(id: string, secret: string) {
    const file = join(this.secretDir, encodeURIComponent(id))
    if (!secret) {
      if (existsSync(file)) unlinkSync(file)
      return
    }
    if (safeStorage.isEncryptionAvailable()) {
      writeFileSync(file, safeStorage.encryptString(secret))
    } else {
      // 降级：base64 混淆（仅在系统钥匙串不可用时）
      writeFileSync(file, Buffer.from('plain:' + btoa(unescape(encodeURIComponent(secret))), 'utf8'))
    }
  }

  loadSecret(id: string): string {
    const file = join(this.secretDir, encodeURIComponent(id))
    if (!existsSync(file)) return ''
    const buf = readFileSync(file)
    try {
      if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf)
      const s = buf.toString('utf8')
      return s.startsWith('plain:') ? decodeURIComponent(escape(atob(s.slice(6)))) : ''
    } catch {
      return ''
    }
  }

  deleteSecret(id: string) {
    const file = join(this.secretDir, encodeURIComponent(id))
    if (existsSync(file)) unlinkSync(file)
  }

  /** 清理已不存在账户的残留密钥 */
  pruneSecrets(validIds: Set<string>) {
    try {
      for (const f of readdirSync(this.secretDir)) {
        const id = decodeURIComponent(f)
        if (!validIds.has(id)) unlinkSync(join(this.secretDir, f))
      }
    } catch {
      /* ignore */
    }
  }

  attachmentPath(attachmentId: string): string {
    return join(this.attachmentDir, attachmentId.replace(/[^a-zA-Z0-9_-]/g, ''))
  }

  /** eml 原文镜像路径：eml/<accountId>/<safeFolder>/<uid>.eml（离线可读、可重解析） */
  emlPath(accountId: string, folderPath: string, uid: number): string {
    const safeFolder = encodeURIComponent(folderPath).replace(/[^a-zA-Z0-9_-]/g, '_')
    const dir = join(this.emlDir, accountId.replace(/[^a-zA-Z0-9_-]/g, ''), safeFolder)
    mkdirSync(dir, { recursive: true })
    return join(dir, `${uid}.eml`)
  }
}
