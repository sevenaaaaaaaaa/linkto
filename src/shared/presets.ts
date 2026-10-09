import type { ProviderKey } from '@shared/types'

export interface ProviderPreset {
  key: ProviderKey
  label: string
  /** 官方帮助说明（如何获取授权码/应用专用密码） */
  hint: string
  imap?: { host: string; port: number; secure: boolean }
  smtp?: { host: string; port: number; secure: boolean }
  /** 常见域名自动匹配 */
  domains: string[]
  color: string
  /** 认证方式：password 授权码/应用专用密码 · oauth-google Google 授权弹窗 · oauth-ms 微软设备码授权 */
  auth?: 'password' | 'oauth-google' | 'oauth-ms'
  /** 官方引导页（获取授权码/应用专用密码） */
  guideUrl?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'gmail',
    label: 'Gmail',
    hint: '需要开启两步验证，并使用「应用专用密码」（Google 账号 → 安全性 → 应用专用密码）登录，不能用邮箱登录密码。',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    domains: ['gmail.com', 'googlemail.com'],
    color: '#22c55e',
    auth: 'oauth-google',
    guideUrl: 'https://myaccount.google.com/apppasswords'
  },
  {
    key: 'icloud',
    label: 'iCloud 邮件',
    hint: '在 Apple 账户 → 登录与安全 → App 专用密码 中生成密码。',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, },
    domains: ['icloud.com', 'me.com', 'mac.com'],
    color: '#38bdf8',
    guideUrl: 'https://account.apple.com/account/manage'
  },
  {
    key: 'outlook',
    label: 'Outlook',
    hint: '若开启两步验证，请使用应用密码；Microsoft 个人账户可能需要在账户安全中允许基础验证。',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'live.cn'],
    color: '#0ea5e9',
    auth: 'oauth-ms'
  },
  {
    key: 'office365',
    label: 'Microsoft 365',
    hint: '使用工作账户登录；若组织禁用基础验证需要管理员开通。',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    domains: ['onmicrosoft.com'],
    color: '#2563eb',
    auth: 'oauth-ms'
  },
  {
    key: 'hotmail',
    label: 'Hotmail',
    hint: '同 Outlook，需要应用密码或允许基础验证。',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    domains: ['hotmail.com'],
    color: '#6366f1',
    auth: 'oauth-ms'
  },
  {
    key: 'qq',
    label: 'QQ 邮箱',
    hint: '在 QQ 邮箱网页版 → 设置 → 账户 中开启 IMAP/SMTP 服务并生成「授权码」（不是 QQ 密码）。',
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    domains: ['qq.com', 'foxmail.com'],
    color: '#f59e0b',
    guideUrl: 'https://mail.qq.com'
  },
  {
    key: '163',
    label: '网易 163',
    hint: '在网页版 设置 → POP3/IMAP/SMTP 中开启 IMAP/SMTP 服务并新增「授权密码」。',
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    domains: ['163.com'],
    color: '#ef4444',
    guideUrl: 'https://mail.163.com'
  },
  {
    key: '126',
    label: '网易 126',
    hint: '同 163 邮箱，开启服务并使用授权密码。',
    imap: { host: 'imap.126.com', port: 993, secure: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true },
    domains: ['126.com'],
    color: '#10b981',
    guideUrl: 'https://www.126.com'
  },
  {
    key: '139',
    label: '139 邮箱',
    hint: '在中国移动 139 邮箱 设置 → 客户端设置 中开启 IMAP 并获取授权码。',
    imap: { host: 'imap.139.com', port: 993, secure: true },
    smtp: { host: 'smtp.139.com', port: 465, secure: true },
    domains: ['139.com'],
    color: '#84cc16',
    guideUrl: 'https://mail.139.com'
  },
  {
    key: 'sina',
    label: '新浪邮箱',
    hint: '在客户端设置中开启 IMAP 服务并使用授权码。',
    imap: { host: 'imap.sina.com', port: 993, secure: true },
    smtp: { host: 'smtp.sina.com', port: 465, secure: true },
    domains: ['sina.com', 'sina.cn'],
    color: '#e11d48',
    guideUrl: 'https://mail.sina.com.cn'
  },
  {
    key: 'exmail',
    label: '腾讯企业邮',
    hint: '管理员需在后台开启 IMAP/SMTP 服务；登录密码即客户端密码（安全登录开启时用客户端专用密码）。',
    imap: { host: 'imap.exmail.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true },
    domains: ['exmail.qq.com'],
    color: '#0284c7',
    guideUrl: 'https://work.weixin.qq.com'
  },
  {
    key: 'aliyun',
    label: '阿里云邮箱',
    hint: '使用邮箱登录密码；服务器与端口已按官方推荐预填。',
    imap: { host: 'imap.mxhichina.com', port: 993, secure: true },
    smtp: { host: 'smtp.mxhichina.com', port: 465, secure: true },
    domains: ['aliyun.com', 'mxhichina.com'],
    color: '#f97316',
    guideUrl: 'https://www.aliyun.com'
  },
  {
    key: 'yahoo',
    label: 'Yahoo 邮箱',
    hint: '需要生成「应用密码」（账户安全 → 生成应用密码），不能用登录密码。',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    domains: ['yahoo.com', 'yahoo.co.jp'],
    color: '#7c3aed',
    guideUrl: 'https://login.yahoo.com/account/security'
  },
  {
    key: 'zoho',
    label: 'Zoho Mail',
    hint: '在 设置 → 邮件账户 中开启 IMAP 访问，并使用应用专用密码。',
    imap: { host: 'imap.zoho.com', port: 993, secure: true },
    smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    domains: ['zoho.com', 'zohomail.com'],
    color: '#e11d48',
    guideUrl: 'https://www.zoho.com/mail/help/imap-access.html'
  },
  {
    key: 'custom',
    label: '其他账户（IMAP）',
    hint: '填写服务商提供的 IMAP / SMTP 服务器信息。',
    domains: [],
    color: '#64748b'
  }
]

export function presetFor(email: string): ProviderPreset {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  return (
    PROVIDER_PRESETS.find(p => p.key !== 'custom' && p.domains.includes(domain)) ??
    PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]
  )
}

export const ACCOUNT_COLORS = [
  '#3b82f6', '#22c55e', '#a855f7', '#38bdf8', '#0d9488',
  '#84cc16', '#f97316', '#ef4444', '#be123c', '#64748b'
]
