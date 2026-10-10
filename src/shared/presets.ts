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
  /** 应用内分步教学：获取授权码 / 开启 IMAP 的具体操作步骤（降低门槛核心） */
  steps?: string[]
  /** 密码框的定制标签与占位符（如「授权码」「授权密码」「App 专用密码」） */
  passwordLabel?: string
  passwordPlaceholder?: string
  /** 直达官方设置页的多个入口（label → url） */
  guideLinks?: { label: string; url: string }[]
  /** 期望的授权码格式提示（用于粘贴智能识别，如 16 位字母数字） */
  codeHint?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'gmail',
    label: 'Gmail',
    hint: '支持 Google 一键授权，无需密码。也可用「应用专用密码」（需开启两步验证）。',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    domains: ['gmail.com', 'googlemail.com'],
    color: '#22c55e',
    auth: 'oauth-google',
    guideUrl: 'https://myaccount.google.com/apppasswords',
    steps: [
      '登录 Google 账号，进入「安全性」→ 开启两步验证（未开启时先开启）',
      '在两步验证页面底部找到「应用专用密码」→ 应用名称输入 LinkTo → 生成',
      '复制生成的 16 位密码，粘贴到下方密码框'
    ],
    passwordLabel: '应用专用密码',
    passwordPlaceholder: '16 位应用专用密码（不是登录密码）',
    guideLinks: [
      { label: '应用专用密码页', url: 'https://myaccount.google.com/apppasswords' },
      { label: '两步验证设置', url: 'https://myaccount.google.com/signinoptions/twosv' }
    ],
    codeHint: '16 位字母（无空格）'
  },
  {
    key: 'icloud',
    label: 'iCloud 邮件',
    hint: '使用 Apple 账户生成的「App 专用密码」（需先开启双重认证）。',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    domains: ['icloud.com', 'me.com', 'mac.com'],
    color: '#38bdf8',
    guideUrl: 'https://account.apple.com/account/manage',
    steps: [
      '登录 Apple 账户页面（account.apple.com）',
      '「登录与安全」→「App 专用密码」→ 生成密码（名称填 LinkTo）',
      '复制形如 xxxx-xxxx-xxxx-xxxx 的密码，粘贴到下方密码框'
    ],
    passwordLabel: 'App 专用密码',
    passwordPlaceholder: 'xxxx-xxxx-xxxx-xxxx',
    guideLinks: [{ label: 'Apple 账户管理', url: 'https://account.apple.com/account/manage' }],
    codeHint: '4×4 位，横杠分组'
  },
  {
    key: 'outlook',
    label: 'Outlook',
    hint: '支持微软一键授权（设备码），无需密码。',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'live.cn'],
    color: '#0ea5e9',
    auth: 'oauth-ms'
  },
  {
    key: 'office365',
    label: 'Microsoft 365',
    hint: '使用工作账户一键授权；若组织禁用个人授权需管理员开通。',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    domains: ['onmicrosoft.com'],
    color: '#2563eb',
    auth: 'oauth-ms'
  },
  {
    key: 'hotmail',
    label: 'Hotmail',
    hint: '同 Outlook，支持微软一键授权（设备码）。',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    domains: ['hotmail.com'],
    color: '#6366f1',
    auth: 'oauth-ms'
  },
  {
    key: 'qq',
    label: 'QQ 邮箱',
    hint: '在 QQ 邮箱开启 IMAP/SMTP 服务并生成「授权码」（不是 QQ 密码）。',
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    domains: ['qq.com', 'foxmail.com'],
    color: '#f59e0b',
    guideUrl: 'https://mail.qq.com',
    steps: [
      '电脑浏览器登录 QQ 邮箱网页版（mail.qq.com）',
      '「设置」→「账户」→ 往下翻到「POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务」',
      '开启「IMAP/SMTP 服务」，按提示用手机发短信验证',
      '复制弹出的 16 位授权码，粘贴到下方密码框'
    ],
    passwordLabel: '授权码',
    passwordPlaceholder: '16 位授权码（不是 QQ 密码）',
    guideLinks: [{ label: 'QQ 邮箱网页版', url: 'https://mail.qq.com' }],
    codeHint: '16 位字母数字'
  },
  {
    key: '163',
    label: '网易 163',
    hint: '在网页版开启 IMAP/SMTP 服务并新增「授权密码」。',
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    domains: ['163.com'],
    color: '#ef4444',
    guideUrl: 'https://mail.163.com',
    steps: [
      '电脑浏览器登录 163 邮箱网页版（mail.163.com）',
      '顶部「设置」→「POP3/SMTP/IMAP」',
      '开启「IMAP/SMTP 服务」，会弹出短信验证，按提示发送',
      '验证通过后点击「新增授权密码」，用手机扫码确认',
      '复制生成的授权密码，粘贴到下方密码框'
    ],
    passwordLabel: '授权密码',
    passwordPlaceholder: '16 位授权密码（不是登录密码）',
    guideLinks: [{ label: '163 邮箱网页版', url: 'https://mail.163.com' }],
    codeHint: '16 位字母数字'
  },
  {
    key: '126',
    label: '网易 126',
    hint: '同 163 邮箱：网页版开启 IMAP 服务并生成授权密码。',
    imap: { host: 'imap.126.com', port: 993, secure: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true },
    domains: ['126.com'],
    color: '#10b981',
    guideUrl: 'https://www.126.com',
    steps: [
      '电脑浏览器登录 126 邮箱网页版',
      '顶部「设置」→「POP3/SMTP/IMAP」',
      '开启「IMAP/SMTP 服务」，完成短信验证',
      '新增授权密码并复制，粘贴到下方密码框'
    ],
    passwordLabel: '授权密码',
    passwordPlaceholder: '16 位授权密码（不是登录密码）',
    guideLinks: [{ label: '126 邮箱网页版', url: 'https://www.126.com' }],
    codeHint: '16 位字母数字'
  },
  {
    key: '139',
    label: '139 邮箱',
    hint: '在中国移动 139 邮箱开启 IMAP 并获取授权码。',
    imap: { host: 'imap.139.com', port: 993, secure: true },
    smtp: { host: 'smtp.139.com', port: 465, secure: true },
    domains: ['139.com'],
    color: '#84cc16',
    guideUrl: 'https://mail.139.com',
    steps: [
      '登录 139 邮箱网页版（mail.139.com）',
      '「设置」→「客户端设置」',
      '开启 IMAP 服务，按提示获取授权码',
      '复制授权码，粘贴到下方密码框'
    ],
    passwordLabel: '授权码',
    passwordPlaceholder: '139 邮箱授权码',
    guideLinks: [{ label: '139 邮箱网页版', url: 'https://mail.139.com' }]
  },
  {
    key: 'sina',
    label: '新浪邮箱',
    hint: '在客户端设置中开启 IMAP 服务并使用授权码。',
    imap: { host: 'imap.sina.com', port: 993, secure: true },
    smtp: { host: 'smtp.sina.com', port: 465, secure: true },
    domains: ['sina.com', 'sina.cn'],
    color: '#e11d48',
    guideUrl: 'https://mail.sina.com.cn',
    steps: [
      '登录新浪邮箱网页版',
      '「设置」→「客户端 POP/IMAP/SMTP」',
      '开启 IMAP 服务并设置客户端授权码',
      '复制授权码，粘贴到下方密码框'
    ],
    passwordLabel: '授权码',
    passwordPlaceholder: '新浪邮箱授权码',
    guideLinks: [{ label: '新浪邮箱网页版', url: 'https://mail.sina.com.cn' }]
  },
  {
    key: 'exmail',
    label: '腾讯企业邮',
    hint: '管理员需在后台开启 IMAP/SMTP 服务；成员用「客户端专用密码」登录。',
    imap: { host: 'imap.exmail.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true },
    domains: ['exmail.qq.com'],
    color: '#0284c7',
    guideUrl: 'https://work.weixin.qq.com',
    steps: [
      '管理员：登录企业微信管理后台 →「应用管理」→「邮箱」→ 开启 IMAP/SMTP 服务',
      '成员：登录网页版邮箱 →「设置」→「客户端设置」→ 安全登录开启后生成「客户端专用密码」',
      '复制客户端专用密码，粘贴到下方密码框'
    ],
    passwordLabel: '客户端专用密码',
    passwordPlaceholder: '开启安全登录后生成的专用密码',
    guideLinks: [
      { label: '企业微信后台', url: 'https://work.weixin.qq.com' },
      { label: '腾讯企业邮网页版', url: 'https://exmail.qq.com' }
    ]
  },
  {
    key: 'aliyun',
    label: '阿里云邮箱',
    hint: '使用邮箱登录密码；服务器与端口已按官方推荐预填。',
    imap: { host: 'imap.mxhichina.com', port: 993, secure: true },
    smtp: { host: 'smtp.mxhichina.com', port: 465, secure: true },
    domains: ['aliyun.com', 'mxhichina.com'],
    color: '#f97316',
    guideUrl: 'https://www.aliyun.com',
    passwordLabel: '邮箱密码',
    passwordPlaceholder: '邮箱登录密码'
  },
  {
    key: 'yahoo',
    label: 'Yahoo 邮箱',
    hint: '需要生成「应用密码」（账户安全 → 生成应用密码），不能用登录密码。',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    domains: ['yahoo.com', 'yahoo.co.jp'],
    color: '#7c3aed',
    guideUrl: 'https://login.yahoo.com/account/security',
    steps: [
      '登录 Yahoo 账户安全页（login.yahoo.com/account/security）',
      '「账户安全」→「生成应用密码」',
      '选择「其他应用」，名称填 LinkTo → 生成',
      '复制生成的应用密码，粘贴到下方密码框'
    ],
    passwordLabel: '应用密码',
    passwordPlaceholder: 'Yahoo 生成的应用密码',
    guideLinks: [{ label: '账户安全页', url: 'https://login.yahoo.com/account/security' }]
  },
  {
    key: 'zoho',
    label: 'Zoho Mail',
    hint: '在 设置 → 邮件账户 中开启 IMAP 访问，并使用应用专用密码。',
    imap: { host: 'imap.zoho.com', port: 993, secure: true },
    smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    domains: ['zoho.com', 'zohomail.com'],
    color: '#e11d48',
    guideUrl: 'https://www.zoho.com/mail/help/imap-access.html',
    steps: [
      '登录 Zoho Mail 网页版',
      '「设置」→「邮件账户」→「IMAP 访问」→ 启用 IMAP',
      '「安全」→「应用专用密码」→ 生成新密码',
      '复制应用专用密码，粘贴到下方密码框'
    ],
    passwordLabel: '应用专用密码',
    passwordPlaceholder: 'Zoho 应用专用密码',
    guideLinks: [{ label: 'IMAP 帮助文档', url: 'https://www.zoho.com/mail/help/imap-access.html' }]
  },
  {
    key: 'custom',
    label: '其他账户（IMAP）',
    hint: '填写服务商提供的 IMAP / SMTP 服务器信息。',
    domains: [],
    color: '#64748b',
    passwordLabel: '密码 / 授权码',
    passwordPlaceholder: '服务商提供的密码或授权码'
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