/**
 * 安全抓取（订阅 / 全文 / 新闻搜索 / 搜索 API 共用）：
 *  - 只允许 http / https（file: / data: / ftp: 等一律拒绝，重定向的每一跳都检查）
 *  - 超时、重定向次数上限、响应大小上限（边读边数，超出即中止）
 *  - 条件请求：If-None-Match / If-Modified-Since → 304
 * fetchImpl 可注入（单测用）；默认用 Node 自带 fetch。
 */

export interface SafeFetchOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  etag?: string | null
  lastModified?: string | null
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  accept?: string
  fetchImpl?: typeof fetch
}

export interface SafeFetchResult {
  status: number
  /** 最终地址（跟随重定向后） */
  url: string
  notModified: boolean
  contentType: string | null
  etag: string | null
  lastModified: string | null
  bytes: Uint8Array
  redirects: number
}

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly code: 'protocol' | 'timeout' | 'too-large' | 'redirects' | 'http' | 'network',
    public readonly status?: number
  ) {
    super(message)
    this.name = 'FetchError'
  }
}

export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) LinkTo/0.3 FeedReader (+https://github.com/sevenaaaaaaaaa/linkto)'

export function assertHttpUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(String(raw ?? '').trim())
  } catch {
    throw new FetchError('地址格式不对', 'protocol')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError(`只支持 http / https 地址（拒绝 ${u.protocol}）`, 'protocol')
  if (u.username || u.password) throw new FetchError('地址里不能带用户名密码', 'protocol')
  return u
}

/** 用户随手输入的地址补全：example.com/blog → https://example.com/blog；feed:// → https:// */
export function normalizeInputUrl(raw: string): string {
  let s = String(raw ?? '').trim()
  if (!s) return s
  s = s.replace(/^feed:\/\//i, 'https://').replace(/^feed:(https?:)/i, '$1')
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s.replace(/^\/+/, '')}`
  return s
}

const HTTP_TEXT: Record<number, string> = { 401: '需要登录（401）', 403: '拒绝访问（403）', 404: '地址不存在（404）', 410: '订阅已下线（410）', 429: '请求太频繁（429）' }

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const f = opts.fetchImpl ?? fetch
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
  const maxRedirects = opts.maxRedirects ?? 5
  const timeoutMs = opts.timeoutMs ?? 15_000
  let url = assertHttpUrl(rawUrl).toString()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let redirects = 0
    let method = opts.method ?? 'GET'
    let body = opts.body
    for (;;) {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: opts.accept ?? 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8, text/html;q=0.7, */*;q=0.5',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(opts.headers ?? {})
      }
      if (opts.etag) headers['If-None-Match'] = opts.etag
      if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified
      let res: Response
      try {
        res = await f(url, { method, headers, body, redirect: 'manual', signal: ctrl.signal })
      } catch (err) {
        if (ctrl.signal.aborted) throw new FetchError(`超时（${Math.round(timeoutMs / 1000)} 秒没有响应）`, 'timeout')
        const msg = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
        throw new FetchError(/ENOTFOUND|EAI_AGAIN/.test(msg) ? '找不到这个网站（域名解析失败）' : /ECONNREFUSED/.test(msg) ? '连接被拒绝' : /certificate|SSL|TLS/i.test(msg) ? '证书有问题，无法安全连接' : `网络错误：${msg.slice(0, 120)}`, 'network')
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const loc = res.headers.get('location')
        try {
          await res.body?.cancel()
        } catch {
          /* ignore */
        }
        if (!loc) throw new FetchError(`重定向缺少目标（${res.status}）`, 'http', res.status)
        if (++redirects > maxRedirects) throw new FetchError(`重定向次数过多（超过 ${maxRedirects} 次）`, 'redirects')
        url = assertHttpUrl(new URL(loc, url).toString()).toString()
        // 303 / 301 / 302 的 POST 按惯例改成 GET
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET'
          body = undefined
        }
        continue
      }
      const meta = {
        status: res.status,
        url,
        contentType: res.headers.get('content-type'),
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        redirects
      }
      if (res.status === 304) {
        try {
          await res.body?.cancel()
        } catch {
          /* ignore */
        }
        return { ...meta, notModified: true, bytes: new Uint8Array(0) }
      }
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) {
        try {
          await res.body?.cancel()
        } catch {
          /* ignore */
        }
        throw new FetchError(`内容太大（${Math.round(declared / 1024)} KB，上限 ${Math.round(maxBytes / 1024)} KB）`, 'too-large')
      }
      const chunks: Uint8Array[] = []
      let size = 0
      if (res.body) {
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) {
            try {
              await reader.cancel()
            } catch {
              /* ignore */
            }
            throw new FetchError(`内容太大（超过 ${Math.round(maxBytes / 1024)} KB）`, 'too-large')
          }
          chunks.push(value)
        }
      }
      const bytes = new Uint8Array(size)
      let off = 0
      for (const c of chunks) {
        bytes.set(c, off)
        off += c.byteLength
      }
      if (res.status >= 400) throw Object.assign(new FetchError(HTTP_TEXT[res.status] ?? `服务器返回 ${res.status}`, 'http', res.status), { body: new TextDecoder().decode(bytes.subarray(0, 2000)) })
      return { ...meta, notModified: false, bytes }
    }
  } catch (err) {
    if (err instanceof FetchError) throw err
    if (ctrl.signal.aborted) throw new FetchError(`超时（${Math.round(timeoutMs / 1000)} 秒没有响应）`, 'timeout')
    throw new FetchError(err instanceof Error ? err.message : String(err), 'network')
  } finally {
    clearTimeout(timer)
  }
}

/** 失败退避：1 次 → 正常间隔；之后翻倍，最长 24 小时 */
export function backoffMinutes(intervalMin: number, failures: number): number {
  if (failures <= 0) return intervalMin
  return Math.min(24 * 60, Math.max(intervalMin, 15) * 2 ** Math.min(6, failures))
}
