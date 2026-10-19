import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AISettings, NotificationAction, QuietHours } from '@shared/types'

export type { AISettings }

export interface GeneralSettings {
  remoteImages: 'block' | 'allow'
  deleteBehavior: 'trash' | 'perm'
  density: 'cozy' | 'compact'
  launchAtLogin: boolean
  dockBadge: boolean
  /** Screener 新发件人审批 */
  screenerEnabled: boolean
  /** 定期整理：已读的订阅 / 通知邮件 N 天后自动归档（0 / 缺省 = 关闭） */
  cleanupNewsletterDays?: number
  cleanupNotificationDays?: number
}

export interface NotificationSettings {
  enabled: boolean
  actions: [NotificationAction, NotificationAction, NotificationAction]
  smart: boolean
  sound: boolean
  perAccount: Record<string, { enabled: boolean; sound: string }>
  /** 免打扰时段（默认关闭；支持跨午夜） */
  quietHours?: QuietHours
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
  perAccount: {},
  quietHours: { enabled: false, start: '22:00', end: '08:00' }
}

const AI_KEY_SECRET = 'ai:apiKey'

export type SecretState = 'idle' | 'pending' | 'ready' | 'failed'

/** 钥匙串不可用时的降级存储（base64 混淆，旧版本写入的格式）；不是该格式返回 null */
function decodePlain(buf: Buffer): string | null {
  const s = buf.subarray(0, 6).toString('utf8')
  if (s !== 'plain:') return null
  try {
    return decodeURIComponent(escape(atob(buf.toString('utf8').slice(6))))
  } catch {
    return ''
  }
}

export const DEFAULT_AI: AISettings = {
  enabled: false,
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  model: 'glm-4.7',
  autoClassify: false,
  autoSummary: false,
  // 自动化会把新邮件内容发给所配置的 AI 服务：默认关闭，由用户在 设置 → AI 主动开启
  autoInsights: false,
  autoDigest: false,
  // 邮件理解：仅在 AI 已启用并配置后生效（aiReady），默认随 AI 一起打开
  autoUnderstand: true,
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
    // 钥匙串授权还没完成时界面拿到的是空 Key：此时保存空 Key 不应抹掉真实的 Key
    if (!s.apiKey && this.secretState === 'pending') {
      this.set('ai', { ...s, apiKey: '' })
      return
    }
    this.saveSecret(AI_KEY_SECRET, s.apiKey ?? '')
    this.set('ai', { ...s, apiKey: '' })
  }

  // ---------- 密钥（safeStorage → 钥匙串级保护） ----------
  //
  // 启动时由 unlockSecrets() 用异步 safeStorage（钥匙串读取在后台线程，不阻塞主线程 / 不挡窗口）
  // 一次解密全部密钥文件进内存；之后 loadSecret 只读内存。
  // 以前在启动阶段同步调用 safeStorage：一旦 macOS 弹出钥匙串授权（ad-hoc 签名每次构建都变，
  // 「始终允许」随之失效），主线程卡在授权对话框上，窗口迟迟不出现，看起来就是「启动卡住」。

  private secretCache = new Map<string, string>()
  private secretState: SecretState = 'idle'
  private unlockPromise: Promise<SecretState> | null = null
  /** 授权进行中时的写入：解锁后按顺序落盘 */
  private queuedWrites = new Map<string, string>()
  /** 每个密钥的写入序号：异步加密完成时只落最新一次 */
  private writeSeq = new Map<string, number>()
  private asyncCrypto: boolean | null = null
  private pendingReadWarned = new Set<string>()
  /** 解锁开始 / 结束时间（启动诊断） */
  secretTiming: { startedAt: number; settledAt: number } = { startedAt: 0, settledAt: 0 }

  /** 当前钥匙串状态：idle 未开始 / pending 等待系统授权 / ready 可用 / failed 被拒绝或不可用 */
  secretsState(): SecretState {
    return this.secretState
  }

  /**
   * 解锁密钥：异步读取钥匙串（不阻塞主线程），解密全部密钥文件到内存。
   * 没有任何加密的密钥文件（首次运行）时不访问钥匙串。可重复调用（返回同一个 Promise）。
   */
  unlockSecrets(): Promise<SecretState> {
    if (this.unlockPromise) return this.unlockPromise
    this.secretState = 'pending'
    this.secretTiming.startedAt = Date.now()
    this.unlockPromise = (async (): Promise<SecretState> => {
      const encrypted: { id: string; buf: Buffer }[] = []
      try {
        for (const f of readdirSync(this.secretDir)) {
          const id = decodeURIComponent(f)
          const buf = readFileSync(join(this.secretDir, f))
          const plain = decodePlain(buf)
          if (plain !== null) this.secretCache.set(id, plain)
          else encrypted.push({ id, buf })
        }
      } catch (err) {
        console.error('[secrets] read secret dir failed:', err)
      }
      if (encrypted.length) {
        let ok = false
        try {
          ok = await safeStorage.isAsyncEncryptionAvailable()
        } catch (err) {
          console.error('[secrets] keychain unavailable:', err)
        }
        this.asyncCrypto = ok
        if (!ok) return this.settle('failed')
        for (const { id, buf } of encrypted) {
          // 授权期间读过（拿到的是空值）的密钥：期间写入的值可能是「读不到 → 自动生成」的（MCP 令牌、幽灵身份…），
          // 解出的真实值优先，丢弃临时值，绝不让它覆盖已有密钥
          const provisional = this.pendingReadWarned.has(id)
          if (this.secretCache.has(id) && !provisional) continue // 授权期间被明确重写：以新值为准
          try {
            const r = await safeStorage.decryptStringAsync(buf)
            if (provisional && this.secretCache.has(id)) {
              if (r.result) {
                this.queuedWrites.delete(id)
                this.secretCache.set(id, r.result)
                console.warn(`[secrets] "${id}" was written while keychain was pending; keeping the stored value`)
              }
            } else this.secretCache.set(id, r.result)
            if (r.shouldReEncrypt) this.writeEncrypted(id, r.result)
          } catch (err) {
            // 与旧逻辑一致：解不开（换了钥匙串条目等）当作没有
            console.warn('[secrets] decrypt failed for', id, err instanceof Error ? err.message : err)
          }
        }
      }
      return this.settle('ready')
    })()
    return this.unlockPromise
  }

  /** 解锁被拒 / 不可用后，用户点「重试」：走同步 safeStorage（会再次弹出系统授权，用户主动操作时可以接受） */
  retryUnlockSync(): SecretState {
    try {
      if (!safeStorage.isEncryptionAvailable()) return this.secretState
      for (const f of readdirSync(this.secretDir)) {
        const id = decodeURIComponent(f)
        if (this.secretCache.has(id)) continue
        const buf = readFileSync(join(this.secretDir, f))
        const plain = decodePlain(buf)
        try {
          this.secretCache.set(id, plain ?? safeStorage.decryptString(buf))
        } catch {
          /* 解不开当作没有 */
        }
      }
      this.asyncCrypto = null
      return this.settle('ready')
    } catch (err) {
      console.error('[secrets] retry unlock failed:', err)
      return this.secretState
    }
  }

  private settle(state: SecretState): SecretState {
    this.secretState = state
    this.secretTiming.settledAt = Date.now()
    // 授权期间的写入按顺序落盘
    const queued = [...this.queuedWrites]
    this.queuedWrites.clear()
    for (const [id, v] of queued) {
      if (v) this.writeEncrypted(id, v)
      else this.removeSecretFile(id)
    }
    return state
  }

  saveSecret(id: string, secret: string) {
    if (!secret) {
      this.secretCache.set(id, '')
      this.writeSeq.set(id, (this.writeSeq.get(id) ?? 0) + 1)
      if (this.secretState === 'pending') this.queuedWrites.set(id, '')
      else this.removeSecretFile(id)
      return
    }
    this.secretCache.set(id, secret)
    if (this.secretState === 'pending') {
      this.queuedWrites.set(id, secret)
      return
    }
    this.writeEncrypted(id, secret)
  }

  /** 加密落盘：优先异步（不阻塞主线程），钥匙串不可用时退回 base64 混淆（与旧逻辑一致） */
  private writeEncrypted(id: string, secret: string) {
    const file = join(this.secretDir, encodeURIComponent(id))
    const seq = (this.writeSeq.get(id) ?? 0) + 1
    this.writeSeq.set(id, seq)
    const writePlain = () => writeFileSync(file, Buffer.from('plain:' + btoa(unescape(encodeURIComponent(secret))), 'utf8'))
    if (this.secretState === 'failed') {
      writePlain()
      return
    }
    void (async () => {
      if (this.asyncCrypto === null) {
        try {
          this.asyncCrypto = await safeStorage.isAsyncEncryptionAvailable()
        } catch {
          this.asyncCrypto = false
        }
      }
      if (this.writeSeq.get(id) !== seq) return
      if (this.asyncCrypto) {
        const buf = await safeStorage.encryptStringAsync(secret)
        if (this.writeSeq.get(id) === seq) writeFileSync(file, buf)
        return
      }
      if (safeStorage.isEncryptionAvailable()) writeFileSync(file, safeStorage.encryptString(secret))
      else writePlain()
    })().catch(err => {
      console.error('[secrets] write failed for', id, err)
      if (this.writeSeq.get(id) === seq) writePlain()
    })
  }

  private removeSecretFile(id: string) {
    const file = join(this.secretDir, encodeURIComponent(id))
    if (existsSync(file)) unlinkSync(file)
  }

  loadSecret(id: string): string {
    const cached = this.secretCache.get(id)
    if (cached !== undefined) return cached
    const file = join(this.secretDir, encodeURIComponent(id))
    if (!existsSync(file)) return ''
    const buf = readFileSync(file)
    const plain = decodePlain(buf)
    if (plain !== null) return plain
    // 系统授权对话框还开着：绝不在主线程同步读钥匙串（会把整个应用卡在对话框上）
    if (this.secretState === 'pending') {
      if (!this.pendingReadWarned.has(id)) {
        this.pendingReadWarned.add(id)
        console.warn(`[secrets] "${id}" requested while keychain authorization is pending; returning empty for now`)
      }
      return ''
    }
    if (this.secretState === 'failed') return ''
    // 解锁之后才出现的文件（或尚未解锁）：同步解密兜底
    try {
      if (!safeStorage.isEncryptionAvailable()) return ''
      const v = safeStorage.decryptString(buf)
      if (this.secretState === 'ready') this.secretCache.set(id, v)
      return v
    } catch {
      return ''
    }
  }

  deleteSecret(id: string) {
    this.secretCache.delete(id)
    this.queuedWrites.delete(id)
    this.writeSeq.set(id, (this.writeSeq.get(id) ?? 0) + 1)
    this.removeSecretFile(id)
  }

  /** 清理已删除账户的密钥；非账户类密钥（AI Key、mcp:token、幽灵信身份等）一律保留 */
  pruneSecrets(validIds: Set<string>) {
    try {
      for (const f of readdirSync(this.secretDir)) {
        const id = decodeURIComponent(f)
        const accountScoped = id.startsWith('acct:') || id.startsWith('oauth:')
        if (accountScoped && !validIds.has(id)) {
          unlinkSync(join(this.secretDir, f))
          this.secretCache.delete(id)
        }
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
