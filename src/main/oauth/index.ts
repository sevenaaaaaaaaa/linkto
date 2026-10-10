import http from 'node:http'
import { shell } from 'electron'
import type { AppStore } from '../store'
import type { OAuthClientConfig, OAuthTokens, ProviderKey } from '@shared/types'

/** OAuth 应用凭据：默认空，可在 设置 → 账户 → OAuth 应用 中配置，或用环境变量覆盖。
 *  构建官方分发版时可用 LINKTO_BUILTIN_GOOGLE_CLIENT_ID / SECRET、LINKTO_BUILTIN_MS_CLIENT_ID 注入内置凭据，
 *  让用户零配置即可一键授权。 */
const DEFAULT_CLIENTS: OAuthClientConfig = {
  google: {
    clientId: process.env.LINKTO_BUILTIN_GOOGLE_CLIENT_ID ?? process.env.LINKTO_GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.LINKTO_BUILTIN_GOOGLE_CLIENT_SECRET ?? process.env.LINKTO_GOOGLE_CLIENT_SECRET ?? ''
  },
  ms: { clientId: process.env.LINKTO_BUILTIN_MS_CLIENT_ID ?? process.env.LINKTO_MS_CLIENT_ID ?? '' }
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** IMAP/SMTP 全权 scope（XOAUTH2 用） */
const GOOGLE_SCOPE = 'https://mail.google.com/ openid email'

const MS_DEVICE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode'
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const MS_SCOPE = 'offline_access https://outlook.office365.com/IMAP.AccessAsUser.All https://outlook.office365.com/SMTP.Send'

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split('.')[1]
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * OAuth 服务：Gmail 走本机回环授权（浏览器弹窗 → 127.0.0.1 回调），
 * Outlook/Hotmail 走设备码授权（无需客户端密钥）。token 存 safeStorage 密钥目录。
 */
export class OAuthService {
  private googleBusy = false
  private msBusy = false

  constructor(private appStore: AppStore) {}

  /** 生效的 OAuth 客户端配置（设置覆盖 + 环境变量兜底） */
  clients(): OAuthClientConfig {
    return this.appStore.get<OAuthClientConfig>('oauthClients', DEFAULT_CLIENTS)
  }

  saveClients(cfg: OAuthClientConfig) {
    this.appStore.set('oauthClients', cfg)
  }

  /** 保存账户 token */
  saveTokens(accountId: string, tokens: OAuthTokens) {
    this.appStore.saveSecret(`oauth:${accountId}`, JSON.stringify(tokens))
  }

  loadTokens(accountId: string): OAuthTokens | null {
    const raw = this.appStore.loadSecret(`oauth:${accountId}`)
    if (!raw) return null
    try {
      return JSON.parse(raw) as OAuthTokens
    } catch {
      return null
    }
  }

  private async refreshGoogle(refreshToken: string, clientId: string, clientSecret: string): Promise<OAuthTokens> {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
    })
    if (!res.ok) throw new Error(`Google token 刷新失败 (${res.status})：${(await res.text()).slice(0, 150)}`)
    const data = (await res.json()) as { access_token: string; expires_in: number }
    return { accessToken: data.access_token, refreshToken, expiresAt: Date.now() + (data.expires_in - 60) * 1000 }
  }

  private async refreshMs(refreshToken: string, clientId: string): Promise<OAuthTokens> {
    const res = await fetch(MS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, refresh_token: refreshToken, grant_type: 'refresh_token', scope: MS_SCOPE })
    })
    if (!res.ok) throw new Error(`Microsoft token 刷新失败 (${res.status})：${(await res.text()).slice(0, 150)}`)
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string }
    const email = data.id_token ? (decodeJwtPayload(data.id_token).preferred_username as string) : undefined
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
      email
    }
  }

  /**
   * 获取账户的有效 access token：临期自动刷新并持久化。
   * @param force 强制刷新（IMAP 认证失败后重试用）
   */
  async validToken(accountId: string, provider: ProviderKey, force = false): Promise<string> {
    const tokens = this.loadTokens(accountId)
    if (!tokens?.accessToken) throw new Error('OAuth 凭证缺失，请重新授权该账户')
    const fresh = Date.now() + 120_000
    if (!force && tokens.expiresAt > fresh) return tokens.accessToken
    const cfg = this.clients()
    if (provider === 'gmail') {
      if (!tokens.refreshToken) throw new Error('缺少 refresh token，请重新授权')
      if (!cfg.google?.clientId || !cfg.google?.clientSecret) throw new Error('Google OAuth 客户端未配置')
      const next = await this.refreshGoogle(tokens.refreshToken, cfg.google.clientId, cfg.google.clientSecret)
      this.saveTokens(accountId, next)
      return next.accessToken
    }
    // outlook / hotmail / office365
    if (!tokens.refreshToken) throw new Error('缺少 refresh token，请重新授权')
    if (!cfg.ms?.clientId) throw new Error('Microsoft OAuth 客户端未配置')
    const next = await this.refreshMs(tokens.refreshToken, cfg.ms.clientId)
    this.saveTokens(accountId, next)
    return next.accessToken
  }

  /** Google 授权是否已配置（client id + secret） */
  googleConfigured(): boolean {
    const c = this.clients().google
    return !!c?.clientId && !!c?.clientSecret
  }

  msConfigured(): boolean {
    return !!this.clients().ms?.clientId
  }

  /**
   * Gmail 授权：本机回环流程。
   * 打开系统浏览器 → 用户在 Google 页面完成授权 → 127.0.0.1:{port} 收到 code → 换 token。
   */
  async authorizeGoogle(): Promise<{ ok: boolean; error?: string; email?: string; tokens?: OAuthTokens }> {
    const cfg = this.clients().google
    if (!cfg?.clientId || !cfg?.clientSecret) return { ok: false, error: '未配置 Google OAuth 客户端（设置 → 账户 → OAuth 应用凭据）' }
    if (this.googleBusy) return { ok: false, error: '已有授权在进行中' }
    this.googleBusy = true
    try {
      let redirectUri = ''
      const code = await new Promise<string>((resolve, reject) => {
        const server = http.createServer((req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const err = url.searchParams.get('error')
          if (err) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<body style="font-family:sans-serif;text-align:center;padding-top:80px"><h2>授权已取消</h2>可以关闭此页面，回到林可兔重试。</body>')
            reject(new Error('授权已取消'))
            return
          }
          const c = url.searchParams.get('code')
          if (c) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end('<body style="font-family:sans-serif;text-align:center;padding-top:80px"><h2>✅ 授权成功</h2>可以关闭此页面，回到林可兔。</body>')
            resolve(c)
          }
        })
        server.listen(0, '127.0.0.1', async () => {
          const port = (server.address() as { port: number }).port
          redirectUri = `http://127.0.0.1:${port}`
          const authUrl =
            `${GOOGLE_AUTH_URL}?` +
            new URLSearchParams({
              client_id: cfg.clientId,
              redirect_uri: redirectUri,
              response_type: 'code',
              scope: GOOGLE_SCOPE,
              access_type: 'offline',
              prompt: 'consent',
              include_granted_scopes: 'true'
            }).toString()
          void shell.openExternal(authUrl)
        })
        setTimeout(() => {
          server.close()
          reject(new Error('授权超时（5 分钟未完成）'))
        }, 5 * 60_000).unref?.()
      })

      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      })
      if (!res.ok) throw new Error(`换取 token 失败 (${res.status})：${(await res.text()).slice(0, 150)}`)
      const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string }
      const payload = data.id_token ? decodeJwtPayload(data.id_token) : {}
      const email = (payload.email as string) ?? ''
      const tokens: OAuthTokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in - 60) * 1000,
        email
      }
      return { ok: true, email, tokens }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.googleBusy = false
    }
  }

  /**
   * Outlook/Hotmail/M365 授权：设备码流程。
   * 通过 onDevice 回调把 userCode + verificationUri 交给 UI 展示，轮询直到用户在浏览器完成登录。
   */
  async authorizeMicrosoft(
    onDevice: (info: { userCode: string; verificationUri: string }) => void
  ): Promise<{ ok: boolean; error?: string; email?: string; tokens?: OAuthTokens }> {
    const cfg = this.clients().ms
    if (!cfg?.clientId) return { ok: false, error: '未配置 Microsoft OAuth 客户端（设置 → 账户 → OAuth 应用凭据）' }
    if (this.msBusy) return { ok: false, error: '已有授权在进行中' }
    this.msBusy = true
    try {
      const deviceRes = await fetch(MS_DEVICE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cfg.clientId, scope: MS_SCOPE })
      })
      if (!deviceRes.ok) throw new Error(`获取设备码失败 (${deviceRes.status})：${(await deviceRes.text()).slice(0, 150)}`)
      const device = (await deviceRes.json()) as {
        device_code: string
        user_code: string
        verification_uri: string
        expires_in: number
        interval?: number
      }
      onDevice({ userCode: device.user_code, verificationUri: device.verification_uri })
      void shell.openExternal(device.verification_uri)

      const interval = Math.max(2, device.interval ?? 5) * 1000
      const deadline = Date.now() + device.expires_in * 1000
      for (;;) {
        await new Promise(r => setTimeout(r, interval))
        if (Date.now() > deadline) throw new Error('授权超时，请重试')
        const tokenRes = await fetch(MS_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: cfg.clientId,
            device_code: device.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          })
        })
        const data = (await tokenRes.json()) as {
          access_token?: string
          refresh_token?: string
          expires_in?: number
          id_token?: string
          error?: string
          error_description?: string
        }
        if (data.access_token) {
          const payload = data.id_token ? decodeJwtPayload(data.id_token) : {}
          const email = (payload.preferred_username as string) ?? ''
          return {
            ok: true,
            email,
            tokens: {
              accessToken: data.access_token,
              refreshToken: data.refresh_token,
              expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
              email
            }
          }
        }
        if (data.error === 'authorization_pending') continue
        if (data.error === 'slow_down') {
          await new Promise(r => setTimeout(r, 3000))
          continue
        }
        throw new Error(data.error_description ?? data.error ?? '授权失败')
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.msBusy = false
    }
  }
}

/** 判断服务商是否走 OAuth */
export function oauthKindOf(provider: ProviderKey): 'oauth-google' | 'oauth-ms' | null {
  if (provider === 'gmail') return 'oauth-google'
  if (provider === 'outlook' || provider === 'hotmail' || provider === 'office365') return 'oauth-ms'
  return null
}