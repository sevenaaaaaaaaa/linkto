/** 对外请求：统一超时与中文错误 */

export class ShareHttpError extends Error {}

function netError(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `请求超时（${Math.round(timeoutMs / 1000)} 秒没有响应）`
  const code = e?.cause?.code ?? ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '找不到服务器（域名解析失败），检查地址或网络'
  if (code === 'ECONNREFUSED') return '连接被拒绝（服务没开或端口不对）'
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return '连接被对方重置，稍后再试'
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时，检查网络或代理'
  if (/CERT|SSL|TLS/i.test(code) || /certificate/i.test(e?.cause?.message ?? '')) return '证书校验失败（地址或代理的 HTTPS 证书有问题）'
  return `网络错误：${e?.cause?.message ?? e?.message ?? String(err)}`
}

export interface HttpRes {
  status: number
  text: string
  json: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function httpRequest(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<HttpRes> {
  if (!/^https?:\/\//i.test(url)) throw new ShareHttpError('地址需以 http:// 或 https:// 开头')
  const timeoutMs = init.timeoutMs ?? 15000
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw new ShareHttpError(netError(err, timeoutMs))
  }
  let text = ''
  try {
    text = await res.text()
  } catch {
    /* 空响应 */
  }
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, text, json }
}

export function postJson(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs?: number): Promise<HttpRes> {
  return httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(body), timeoutMs })
}
