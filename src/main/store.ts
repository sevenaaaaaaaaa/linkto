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
  /** Screener 新发件人审批 */
  screenerEnabled: boolean
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
  dockBadge: true,
  screenerEnabled: true
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  actions: ['markRead', 'reply', 'delete'],
  smart: false,
  sound: true,
  perAccount: {}
}

const AI_KEY_SECRET = 'ai:apiKey'

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
  readonly connectorsDir: string
  readonly dbPath: string
  private kv!: DatabaseSync

  constructor() {
    // 保持 'mail-studio' 目录名以兼容老版本本地数据（不对外可见）
    this.dataDir = join(app.getPath('userData'), 'mail-studio')
    this.attachmentDir = join(this.dataDir, 'attachments')
    this.emlDir = join(this.dataDir, 'eml')
    this.connectorsDir = join(this.dataDir, 'connectors')
    this.dbPath = join(this.dataDir, 'mail.db')
    mkdirSync(this.attachmentDir, { recursive: true })
    mkdirSync(this.emlDir, { recursive: true })
    mkdirSync(this.connectorsDir, { recursive: true })
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

  // ---------- AI 设置：API Key 走密钥存储，不落明文 settings 表 ----------

  getAI(): AISettings {
    const s = this.get('ai', DEFAULT_AI)
    if (s.apiKey) {
      // 旧版本把 Key 明文存在 settings 表：迁入密钥存储后抹掉明文
      this.saveSecret(AI_KEY_SECRET, s.apiKey)
      this.set('ai', { ...s, apiKey: '' })
      return s
    }
    return { ...s, apiKey: this.loadSecret(AI_KEY_SECRET) }
  }

  setAI(s: AISettings) {
    this.saveSecret(AI_KEY_SECRET, s.apiKey ?? '')
    this.set('ai', { ...s, apiKey: '' })
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
  /** 清理已删除账户的密钥；非账户类密钥（如 AI Key）一律保留 */
  pruneSecrets(validIds: Set<string>) {
    try {
      for (const f of readdirSync(this.secretDir)) {
        const id = decodeURIComponent(f)
        const accountScoped = id.startsWith('acct:') || id.startsWith('oauth:')
        if (accountScoped && !validIds.has(id)) unlinkSync(join(this.secretDir, f))
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
