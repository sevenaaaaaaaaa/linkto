import { NotFoundError, PermissionError } from './types'

/** 取 access token：force=true 时强制刷新（收到 401 后重试一次） */
export type TokenGetter = (force?: boolean) => Promise<string>

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

/**
 * 带 Bearer 的 JSON 请求：401 刷新 token 重试一次；404/410 → NotFoundError；403 → PermissionError。
 * 错误信息只截取响应前 160 字，绝不带出 token。
 */
export async function apiRequest<T>(
  fetchImpl: FetchLike,
  getToken: TokenGetter,
  method: string,
  url: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt > 0)
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extraHeaders }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    if (res.status === 401 && attempt === 0) continue
    const text = await res.text()
    if (res.ok) return (text ? JSON.parse(text) : null) as T
    if (res.status === 404 || res.status === 410) throw new NotFoundError()
    if (res.status === 401 || res.status === 403) {
      throw new PermissionError(`授权失效或缺少权限（${res.status}），请在「待办与日历同步」里重新连接：${text.slice(0, 160)}`)
    }
    throw new Error(`请求失败 (${res.status})：${text.slice(0, 160)}`)
  }
  throw new Error('请求失败：授权刷新后仍被拒绝')
}

export const qs = (params: Record<string, string | number | boolean | null | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
