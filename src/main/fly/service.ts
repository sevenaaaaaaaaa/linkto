import { randomBytes } from 'node:crypto'
import {
  FlyError,
  flyLink,
  inspectEnvelope,
  isMbox,
  looksLikeCode,
  mboxForCode,
  open,
  parseFlyLink,
  seal,
  type FlyMode
} from './core'

/**
 * 萤火密信服务：封装后的投递与读取。
 *
 * 与 v1 幽灵信的根本差别：
 *  - 不创建、不读取任何长期身份（没有 X25519 设备私钥，没有公钥目录）
 *  - 不写本地信箱清单，正文只在主进程内存里停留到阅读窗取走
 *  - 中继只看到随机信箱号 + 定长密文；信箱号用后即弃，无法关联第二封
 *  - 口令由本机 CSPRNG 生成，不接受用户自选弱口令
 */

export interface FlyComposeInput {
  text: string
  mode: FlyMode
  ttlSeconds: number
}

export interface FlyComposeResult {
  ok: boolean
  error?: string
  mode?: FlyMode
  /** 仅链接 / 链接+口令模式有链接 */
  link?: string
  /** 口令模式（链接+口令 / 纯口令）的 6 个词 */
  code?: string
  /** 纯口令模式给收件人的入口（只需网址 + 口令） */
  portal?: string
  mbox?: string
  expiresAt?: number
  /** 密文大小（字节） */
  sealedBytes?: number
}

export interface FlyOpenResult {
  ok: boolean
  error?: string
  /** 主进程内存中的一次性取件号；阅读窗用它取正文，取走即删 */
  token?: string
  mode?: FlyMode
  expiresAt?: number
  /** 服务端密文是否已确认焚毁 */
  burned?: boolean
}

interface Stashed {
  text: string
  expiresAt: number
}

const STASH_TTL_MS = 5 * 60 * 1000
const MAX_RESPONSE_BYTES = 256 * 1024

export class FlyService {
  private readonly stash = new Map<string, Stashed>()
  /** 短时缓存密文，供口令输错后就地重试（不含任何密钥/明文） */
  private readonly recent = new Map<string, { e: string; at: number }>()

  constructor(
    private readonly deps: {
      getSetting: (key: string) => string
      setSetting: (key: string, value: string) => void
      fetchImpl?: typeof fetch
    }
  ) {}

  relayUrl(): string {
    const read = (key: string): string => {
      const v = this.deps.getSetting(key)
      return typeof v === 'string' ? v.trim() : ''
    }
    const own = read('fly.relayUrl')
    if (own) return own.replace(/\/+$/, '')
    // 兼容：老用户已在幽灵信里配过中继，不必再填一次
    return read('ghost.relayUrl').replace(/\/+$/, '')
  }

  setRelayUrl(url: string): void {
    this.deps.setSetting('fly.relayUrl', url.trim().replace(/\/+$/, ''))
  }

  private assertRelay(base: string): void {
    let u: URL
    try {
      u = new URL(base)
    } catch {
      throw new FlyError('bad-input', '中继地址无效')
    }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
      throw new FlyError('bad-input', '中继必须是 https（本机调试可用 http://127.0.0.1）')
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const f = this.deps.fetchImpl ?? fetch
    const res = await f(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', ...(init.headers ?? {}) }
    })
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_RESPONSE_BYTES) throw new FlyError('bad-envelope', '中继响应过大')
    return res
  }

  // ---------- 写 ----------

  async compose(input: FlyComposeInput): Promise<FlyComposeResult> {
    const base = this.relayUrl()
    if (!base) return { ok: false, error: '还没有配置中继地址（下方可填，部署见 relay/README.md）' }
    try {
      this.assertRelay(base)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    let sealed
    try {
      sealed = seal(input.text, { mode: input.mode, ttlSeconds: input.ttlSeconds })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    try {
      const res = await this.request(base + '/api/v2/box', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ e: sealed.envelope, ttl: Math.floor((sealed.expiresAt - Date.now()) / 1000) })
      })
      if (!res.ok) {
        if (res.status === 404) {
          return { ok: false, error: '中继没有 v2 端点：请用仓库 relay/ 重新部署（见 relay/README.md）' }
        }
        const detail = await res.text().catch(() => '')
        return { ok: false, error: '中继拒收：HTTP ' + res.status + (detail ? ' · ' + detail.slice(0, 120) : '') }
      }
    } catch (err) {
      return { ok: false, error: '投递失败：' + (err instanceof Error ? err.message : String(err)) }
    }

    return {
      ok: true,
      mode: sealed.mode,
      ...(sealed.mode === 'code' ? { portal: base + '/' } : { link: flyLink(base, sealed) }),
      ...(sealed.code ? { code: sealed.code } : {}),
      mbox: sealed.mbox,
      expiresAt: sealed.expiresAt,
      sealedBytes: Buffer.byteLength(sealed.envelope)
    }
  }

  // ---------- 读 ----------

  /**
   * 打开入口：完整链接 / 32 位信箱号 / 6 词口令。
   * 成功解密后立即请求中继焚毁；失败（口令错/过期）不焚毁，允许重试。
   */
  async open(input: string, code?: string): Promise<FlyOpenResult> {
    const raw = (input || '').trim()
    if (!raw) return { ok: false, error: '请粘贴链接或 6 个词的口令' }

    let base = ''
    let mbox = ''
    let keyB64: string | undefined
    let viaCode = false

    const parsed = parseFlyLink(raw)
    if (parsed) {
      base = parsed.base || this.relayUrl()
      mbox = parsed.mbox
      keyB64 = parsed.keyB64
    } else if (looksLikeCode(raw)) {
      // 纯口令：口令决定信箱号，不需要链接
      base = this.relayUrl()
      if (!base) return { ok: false, error: '纯口令模式需要先配置中继地址' }
      try {
        mbox = mboxForCode(raw)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      viaCode = true
    } else {
      return { ok: false, error: '不是有效的密信链接或 6 词口令' }
    }

    if (!base) return { ok: false, error: '链接里没有中继地址，且本机未配置中继' }
    try {
      this.assertRelay(base)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    // 口令只在“链接+口令 / 纯口令”时需要；链接自带密钥时忽略口令字段
    const given = (code ?? '').trim() || (viaCode ? raw : '')
    if (!keyB64 && given && !looksLikeCode(given)) {
      return { ok: false, error: '口令必须是 6 个词（用空格分开）' }
    }

    // 同一封信的口令输错重试时复用内存中的密文，不重复消耗读取次数
    let envelope = ''
    const hit = this.recent.get(mbox)
    if (hit && Date.now() - hit.at < 120_000) {
      envelope = hit.e
    } else {
      try {
        const res = await this.request(base + '/api/v2/box/' + mbox, { method: 'GET' })
        if (res.status === 404 || res.status === 410) {
          return {
            ok: false,
            error: viaCode
              ? '没有找到这封密信：口令可能抄错，或密信已被焚毁 / 过期'
              : '这封密信不存在、已被读取焚毁，或已过期'
          }
        }
        if (!res.ok) return { ok: false, error: '中继读取失败：HTTP ' + res.status }
        const body = (await res.json()) as { e?: unknown }
        if (typeof body.e !== 'string') return { ok: false, error: '中继返回了无法识别的密文' }
        envelope = body.e
        this.recent.set(mbox, { e: envelope, at: Date.now() })
        if (this.recent.size > 16) {
          const oldest = [...this.recent.entries()].sort((a, b) => a[1].at - b[1].at)[0]
          if (oldest) this.recent.delete(oldest[0])
        }
      } catch (err) {
        return { ok: false, error: '读取失败：' + (err instanceof Error ? err.message : String(err)) }
      }
    }

    // 先看密文头部再决定要什么密钥——避免把“链接被截断”误报成“口令不对”
    let head: ReturnType<typeof inspectEnvelope>
    try {
      head = inspectEnvelope(envelope)
    } catch {
      return { ok: false, error: '中继返回的不是一封萤火密信' }
    }
    if (head.mbox !== mbox) return { ok: false, error: '中继返回了另一封密信' }
    if (head.mode === 'link' && !keyB64) {
      return { ok: false, error: '链接不完整：密钥在 # 号后面，请让对方重新发完整链接' }
    }
    if (head.mode !== 'link' && !given) return { ok: false, error: '这封密信需要 6 词口令' }
    if (head.mode !== 'link' && !looksLikeCode(given)) {
      return { ok: false, error: '口令必须是 6 个词（用空格分开）' }
    }

    let opened
    try {
      opened = open(envelope, {
        ...(keyB64 ? { keyB64 } : {}),
        ...(head.mode !== 'link' ? { code: given } : {})
      })
    } catch (err) {
      // link 模式的密钥正确（就在链接里），GCM 失败只可能是密文被改动
      const msg =
        err instanceof FlyError
          ? err.code === 'wrong-code' && head.mode === 'link'
            ? '密文校验失败：链接可能被改动过'
            : err.message
          : '打开失败'
      return { ok: false, error: msg }
    }

    const burned = await this.burn(base, mbox)
    this.recent.delete(mbox)
    return {
      ok: true,
      token: this.stashText(opened.text),
      mode: opened.mode,
      expiresAt: opened.expiresAt,
      burned
    }
  }

  /** 请求中继焚毁。失败不抛错：密文仍受 TTL 约束，超时自动删除。 */
  async burn(base: string, mbox: string): Promise<boolean> {
    try {
      const res = await this.request(base + '/api/v2/box/' + mbox, { method: 'DELETE' })
      return res.ok
    } catch {
      return false
    }
  }

  // ---------- 一次性取件（主进程内存，不经磁盘） ----------

  private stashText(text: string): string {
    this.sweep()
    const token = randomBytes(16).toString('hex')
    this.stash.set(token, { text, expiresAt: Date.now() + STASH_TTL_MS })
    return token
  }

  take(token: string): string | null {
    const item = this.stash.get(token)
    if (!item) return null
    this.stash.delete(token)
    if (item.expiresAt < Date.now()) return null
    return item.text
  }

  drop(token: string): void {
    this.stash.delete(token)
  }

  private sweep(): void {
    const now = Date.now()
    for (const [k, v] of this.stash) if (v.expiresAt < now) this.stash.delete(k)
  }

  /** 仅用于 UI 预览：不泄露正文，只给有效期 */
  inspect(envelopeJson: string): ReturnType<typeof inspectEnvelope> {
    return inspectEnvelope(envelopeJson)
  }
}

