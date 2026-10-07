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
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'gmail',
    label: 'Gmail',
    hint: '需要开启两步验证，并使用「应用专用密码」（Google 账号 → 安全性 → 应用专用密码）登录，不能用邮箱登录密码。',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    domains: ['gmail.com', 'googlemail.com'],
    color: '#22c55e'
  },
  {
    key: 'icloud',
    label: 'iCloud 邮件',
    hint: '在 Apple 账户 → 登录与安全 → App 专用密码 中生成密码。',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, },
    domains: ['icloud.com', 'me.com', 'mac.com'],
    color: '#38bdf8'
  },
  {
    key: 'outlook',
    label: 'Outlook',
    hint: '若开启两步验证，请使用应用密码；Microsoft 个人账户可能需要在账户安全中允许基础验证。',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'live.cn'],
    color: '#0ea5e9'
  },
  {
    key: 'office365',
    label: 'Microsoft 365',
    hint: '使用工作账户登录；若组织禁用基础验证需要管理员开通。',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    domains: ['onmicrosoft.com'],
    color: '#2563eb'
  },
  {
    key: 'hotmail',
    label: 'Hotmail',
    hint: '同 Outlook，需要应用密码或允许基础验证。',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    domains: ['hotmail.com'],
    color: '#6366f1'
  },
  {
    key: 'qq',
    label: 'QQ 邮箱',
    hint: '在 QQ 邮箱网页版 → 设置 → 账户 中开启 IMAP/SMTP 服务并生成「授权码」（不是 QQ 密码）。',
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    domains: ['qq.com', 'foxmail.com'],
    color: '#f59e0b'
  },
  {
    key: '163',
    label: '网易 163',
    hint: '在网页版 设置 → POP3/IMAP/SMTP 中开启 IMAP/SMTP 服务并新增「授权密码」。',
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    domains: ['163.com'],
    color: '#ef4444'
  },
  {
    key: '126',
    label: '网易 126',
    hint: '同 163 邮箱，开启服务并使用授权密码。',
    imap: { host: 'imap.126.com', port: 993, secure: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true },
    domains: ['126.com'],
    color: '#10b981'
  },
  {
    key: '139',
    label: '139 邮箱',
    hint: '在中国移动 139 邮箱 设置 → 客户端设置 中开启 IMAP 并获取授权码。',
    imap: { host: 'imap.139.com', port: 993, secure: true },
    smtp: { host: 'smtp.139.com', port: 465, secure: true },
    domains: ['139.com'],
    color: '#84cc16'
  },
  {
    key: 'sina',
    label: '新浪邮箱',
    hint: '在客户端设置中开启 IMAP 服务并使用授权码。',
    imap: { host: 'imap.sina.com', port: 993, secure: true },
    smtp: { host: 'smtp.sina.com', port: 465, secure: true },
    domains: ['sina.com', 'sina.cn'],
    color: '#e11d48'
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
