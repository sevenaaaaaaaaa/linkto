import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  FlyError,
  flyLink,
  inspectEnvelope,
  looksLikeCode,
  mboxForCode,
  open,
  parseFlyLink,
  seal,
  type FlyMode
} from './crypto'

/** 用户自己的中继；可在设置里覆盖。不要写死别人的地址。 */
export const DEFAULT_RELAY = 'https://linkto-ghost-relay.nownexts.workers.dev'
const RELAY_KEY = 'linkto.fly.relay'
const MAX_RESPONSE_BYTES = 256 * 1024

export async function getRelayUrl(): Promise<string> {
  try {
    const v = await AsyncStorage.getItem(RELAY_KEY)
    return (v?.trim() || DEFAULT_RELAY).replace(/\/+$/, '')
  } catch {
    return DEFAULT_RELAY
  }
}

export async function setRelayUrl(url: string): Promise<void> {
  const v = url.trim().replace(/\/+$/, '')
  if (v) await AsyncStorage.setItem(RELAY_KEY, v)
  else await AsyncStorage.removeItem(RELAY_KEY)
}

function assertRelay(base: string): void {
  // 不用 URL：Hermes 上并不总有全局 URL，正则足够覆盖 relay 地址
  const m = base.match(/^(https?):\/\/([^/?#]+)(?:[/?#]|$)/i)
  if (!m) throw new FlyError('bad-input', '中继地址无效（必须是 https）')
  const host = m[2].toLowerCase().replace(/:\d+$/, '')
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  if (m[1].toLowerCase() !== 'https' && !(m[1].toLowerCase() === 'http' && local)) {
    throw new FlyError('bad-input', '中继必须是 https（本机调试可用 http://127.0.0.1）')
  }
}

async function request(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, {
      ...init,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
      signal: controller.signal
    })
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_RESPONSE_BYTES) throw new FlyError('bad-envelope', '中继响应过大')
    return res
  } finally {
    clearTimeout(timer)
  }
}

export interface FlyComposeResult {
  ok: boolean
  error?: string
  mode?: FlyMode
  link?: string
  portal?: string
  code?: string
  mbox?: string
  expiresAt?: number
  sealedBytes?: number
}

export async function composeFly(input: { text: string; mode: FlyMode; ttlSeconds: number }): Promise<FlyComposeResult> {
  const base = await getRelayUrl()
  try {
    assertRelay(base)
    const sealed = await seal(input.text, { mode: input.mode, ttlSeconds: input.ttlSeconds })
    const res = await request(base + '/api/v2/box', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ e: sealed.envelope, ttl: Math.max(60, Math.floor((sealed.expiresAt - Date.now()) / 1000)) })
    })
    if (!res.ok) {
      if (res.status === 404) return { ok: false, error: '中继没有 v2 端点，请重新部署 relay/' }
      const detail = await res.text().catch(() => '')
      return { ok: false, error: '中继拒收：HTTP ' + res.status + (detail ? ' · ' + detail.slice(0, 100) : '') }
    }
    return {
      ok: true,
      mode: sealed.mode,
      ...(sealed.mode === 'code' ? { portal: base + '/' } : { link: flyLink(base, sealed) }),
      ...(sealed.code ? { code: sealed.code } : {}),
      mbox: sealed.mbox,
      expiresAt: sealed.expiresAt,
      sealedBytes: sealed.envelope.length
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface FlyOpenResult {
  ok: boolean
  error?: string
  text?: string
  mode?: FlyMode
  expiresAt?: number
  burned?: boolean
  mbox?: string
  /** 链接需要口令但调用方还没给 */
  needsCode?: boolean
}

export async function openFly(input: string, code?: string): Promise<FlyOpenResult> {
  const raw = (input || '').trim()
  if (!raw) return { ok: false, error: '请粘贴链接或 6 个词的口令' }
  let base = ''
  let mbox = ''
  let keyB64: string | undefined
  let viaCode = false

  const parsed = parseFlyLink(raw)
  if (parsed) {
    base = parsed.base
    mbox = parsed.mbox
    keyB64 = parsed.keyB64
  } else if (looksLikeCode(raw)) {
    base = await getRelayUrl()
    try { mbox = await mboxForCode(raw) } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
    viaCode = true
  } else {
    return { ok: false, error: '不是有效的密信链接，也不是 6 个词的口令' }
  }

  if (!base) base = await getRelayUrl()
  try {
    assertRelay(base)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const given = (code ?? '').trim() || (viaCode ? raw : '')
  if (!keyB64 && !given) return { ok: false, error: '这封密信需要 6 词口令', needsCode: true }
  if (!keyB64 && !looksLikeCode(given)) return { ok: false, error: '口令必须是 6 个词', needsCode: true }

  try {
    const res = await request(base + '/api/v2/box/' + mbox, { method: 'GET' })
    if (res.status === 404 || res.status === 410) {
      return {
        ok: false,
        error: viaCode
          ? '没有找到这封密信：口令可能抄错，或已被焚毁 / 过期'
          : '这封密信不存在、已被读取焚毁，或已过期'
      }
    }
    if (!res.ok) return { ok: false, error: '中继读取失败：HTTP ' + res.status }
    const body = (await res.json()) as { e?: unknown }
    if (typeof body.e !== 'string') return { ok: false, error: '中继返回了无法识别的密文' }
    const head = inspectEnvelope(body.e)
    if (head.mbox !== mbox) return { ok: false, error: '中继返回了另一封密信' }
    if (head.mode === 'link' && !keyB64) return { ok: false, error: '链接不完整：密钥在 # 号后面，请让对方重发完整链接' }
    if (head.mode !== 'link' && !given) return { ok: false, error: '这封密信需要 6 词口令', needsCode: true }
    if (head.mode !== 'link' && !looksLikeCode(given)) return { ok: false, error: '口令必须是 6 个词', needsCode: true }

    const opened = await open(body.e, {
      ...(keyB64 ? { keyB64 } : {}),
      ...(head.mode !== 'link' ? { code: given } : {})
    })

    let burned = false
    try {
      const del = await request(base + '/api/v2/box/' + mbox, { method: 'DELETE' })
      burned = del.ok
    } catch { burned = false }

    return { ok: true, text: opened.text, mode: opened.mode, expiresAt: opened.expiresAt, burned, mbox }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/abort/i.test(msg)) return { ok: false, error: '读取超时，请检查网络后重试' }
    return { ok: false, error: msg }
  }
}
