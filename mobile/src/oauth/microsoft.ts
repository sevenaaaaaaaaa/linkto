import * as Keychain from 'react-native-keychain'
import { Linking } from 'react-native'
import { decodeUtf8Bytes, bytesFromBinary } from '../imap/encoding'

const clientService = 'linkto.oauth.ms.client'
const BASE = 'https://login.microsoftonline.com/common/oauth2/v2.0/'
const scope = 'openid profile email offline_access https://outlook.office365.com/IMAP.AccessAsUser.All https://outlook.office365.com/SMTP.Send'
export interface MsTokens { accessToken: string; refreshToken: string; expiresAt: number; email: string; tenantId?: string }
const form = (values: Record<string, string>) => Object.entries(values).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')
export async function msClientId(): Promise<string> { const saved = await Keychain.getGenericPassword({ service: clientService }); return saved ? saved.password : '' }
export async function saveMsClientId(id: string) { if (!/^[0-9a-f-]{36}$/i.test(id.trim())) throw new Error('请填写有效的 Microsoft 应用客户端 ID'); await Keychain.setGenericPassword('client', id.trim(), { service: clientService }) }
async function request(endpoint: string, fields: Record<string, string>, signal?: AbortSignal) {
  const response = await fetch(BASE + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(fields), signal })
  const data = await response.json()
  return { ok: response.ok, data }
}
function tokens(data: any): MsTokens {
  let claims: Record<string, string> = {}
  if (data.id_token) {
    const encoded = String(data.id_token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    claims = JSON.parse(decodeUtf8Bytes(bytesFromBinary(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)))))
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? '', expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000, email: claims.email || claims.preferred_username || '', tenantId: claims.tid }
}
export async function authorizeMicrosoft(onDevice: (code: string, url: string) => void, signal: AbortSignal): Promise<MsTokens> {
  const clientId = await msClientId()
  if (!clientId) throw new Error('先填写 Microsoft 客户端 ID；可与电脑共用同一个公共客户端应用')
  const { data, ok } = await request('devicecode', { client_id: clientId, scope }, signal)
  if (!ok) throw new Error(data.error_description ?? '获取微软授权码失败')
  onDevice(data.user_code, data.verification_uri)
  await Linking.openURL(data.verification_uri)
  const expires = Date.now() + data.expires_in * 1000
  let interval = Math.max(5, data.interval ?? 5) * 1000
  while (Date.now() < expires) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Error('授权已取消')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, interval)
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
    })
    const result = await request('token', { client_id: clientId, device_code: data.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, signal)
    if (result.data.access_token) { const value = tokens(result.data); if (!value.email.includes('@')) throw new Error('微软未返回可用的邮箱地址'); return value }
    if (result.data.error === 'authorization_pending') continue
    if (result.data.error === 'slow_down') { interval += 5000; continue }
    throw new Error(result.data.error_description ?? '微软授权失败')
  }
  throw new Error('授权已过期，请重试')
}
export async function validMicrosoftToken(accountId: string): Promise<string> {
  const service = 'linkto.imap.' + accountId
  const saved = await Keychain.getGenericPassword({ service })
  if (!saved) throw new Error('请重新授权 Microsoft 邮箱')
  const current = JSON.parse(saved.password) as MsTokens
  if (current.expiresAt > Date.now() + 120000) return current.accessToken
  const result = await request('token', { client_id: await msClientId(), refresh_token: current.refreshToken, grant_type: 'refresh_token', scope })
  if (!result.ok || !result.data.access_token) throw new Error('微软授权已失效，请在账户页重新授权')
  const next = { ...current, ...tokens(result.data), refreshToken: result.data.refresh_token || current.refreshToken, email: current.email }
  await Keychain.setGenericPassword(current.email, JSON.stringify(next), { service })
  return next.accessToken
}
