import type { ProviderKey } from './types'

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
    hint: '微软已关闭 IMAP 的密码登录，请用「一键授权」（设备码）。首次使用需在 Azure 注册一个 OAuth 应用（一次性，约 3 分钟）。',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    domains: ['outlook.com', 'outlook.cn', 'outlook.com.cn', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.co.jp', 'live.com', 'live.cn', 'live.co.uk', 'live.fr', 'live.jp', 'msn.com', 'passport.com'],
    color: '#0ea5e9',
    auth: 'oauth-ms',
    guideUrl: 'https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040',
    passwordLabel: '应用密码（多数账户已不可用）',
    passwordPlaceholder: '微软已停用 IMAP 密码登录，建议改用一键授权',
    guideLinks: [
      { label: 'Outlook 官方 IMAP 设置', url: 'https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040' },
      { label: 'Azure 应用注册', url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' },
      { label: '注册应用图文指南', url: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app' },
      { label: '微软账户安全页', url: 'https://account.live.com/proofs/manage' }
    ]
  },
  {
    key: 'office365',
    label: 'Microsoft 365',
    hint: '使用工作账户一键授权；若组织禁用第三方授权需管理员在 Microsoft Entra 中开通。',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    domains: ['onmicrosoft.com'],
    color: '#2563eb',
    auth: 'oauth-ms',
    guideUrl: 'https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/pop3-and-imap4/pop3-and-imap4',
    passwordLabel: '密码 / 应用密码',
    passwordPlaceholder: '仅当组织仍允许基本认证时可用，建议改用一键授权',
    guideLinks: [
      { label: 'Microsoft 365 IMAP 官方说明', url: 'https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/pop3-and-imap4/pop3-and-imap4' },
      { label: 'Azure 应用注册', url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' },
      { label: '注册应用图文指南', url: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app' }
    ]
  },
  {
    key: 'hotmail',
    label: 'Hotmail',
    hint: '同 Outlook：微软已关闭 IMAP 的密码登录，请用「一键授权」（设备码），首次需在 Azure 注册 OAuth 应用。',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    domains: [], // 旧账户 key 保留；新增 Hotmail 统一走 Microsoft 入口
    color: '#6366f1',
    auth: 'oauth-ms',
    guideUrl: 'https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040',
    passwordLabel: '应用密码（多数账户已不可用）',
    passwordPlaceholder: '微软已停用 IMAP 密码登录，建议改用一键授权',
    guideLinks: [
      { label: 'Hotmail / Outlook 官方 IMAP 设置', url: 'https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040' },
      { label: 'Azure 应用注册', url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' },
      { label: '注册应用图文指南', url: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app' },
      { label: '微软账户安全页', url: 'https://account.live.com/proofs/manage' }
    ]
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
    label: '阿里邮箱',
    hint: '个人版 @aliyun.com：网页版开启 IMAP/SMTP 后，用邮箱密码登录。',
    imap: { host: 'imap.aliyun.com', port: 993, secure: true },
    smtp: { host: 'smtp.aliyun.com', port: 465, secure: true },
    domains: ['aliyun.com'],
    color: '#f97316',
    guideUrl: 'https://mail.aliyun.com',
    steps: [
      '登录阿里邮箱网页版（mail.aliyun.com）',
      '「设置」→「POP3/SMTP/IMAP」→ 开启 IMAP/SMTP 服务并保存',
      '在下方填写邮箱登录密码'
    ],
    passwordLabel: '邮箱密码',
    passwordPlaceholder: '邮箱登录密码',
    guideLinks: [{ label: '阿里邮箱网页版', url: 'https://mail.aliyun.com' }]
  },
  {
    key: 'aliyun-ent',
    label: '阿里企业邮',
    hint: '企业自有域名邮箱：管理员开启 IMAP/SMTP 后，用邮箱密码或三方客户端安全密码登录。',
    imap: { host: 'imap.qiye.aliyun.com', port: 993, secure: true },
    smtp: { host: 'smtp.qiye.aliyun.com', port: 465, secure: true },
    domains: [],
    color: '#ea580c',
    guideUrl: 'https://qiye.aliyun.com',
    steps: [
      '登录阿里企业邮箱网页版（qiye.aliyun.com）',
      '「设置」→「账户与安全」→ 若开启了三方客户端安全密码，先生成一个',
      '在下方填写邮箱密码（或三方客户端安全密码）'
    ],
    passwordLabel: '密码 / 安全密码',
    passwordPlaceholder: '邮箱密码或三方客户端安全密码',
    guideLinks: [{ label: '阿里企业邮网页版', url: 'https://qiye.aliyun.com' }]
  },
  {
    key: 'feishu',
    label: '飞书邮箱',
    hint: '在飞书邮箱设置中开启 IMAP/SMTP 并生成「专用密码」。',
    imap: { host: 'imap.feishu.cn', port: 993, secure: true },
    smtp: { host: 'smtp.feishu.cn', port: 465, secure: true },
    domains: [],
    color: '#3370ff',
    guideUrl: 'https://www.feishu.cn',
    steps: [
      '打开飞书 →「邮箱」→ 右上角「设置」',
      '「第三方邮件客户端」→ 开启 IMAP/SMTP，生成专用密码',
      '复制专用密码，粘贴到下方密码框'
    ],
    passwordLabel: '专用密码',
    passwordPlaceholder: '飞书生成的专用密码（不是飞书登录密码）'
  },
  {
    key: 'lark',
    label: 'Lark Mail',
    hint: 'Lark 国际版：在邮箱设置中开启 IMAP/SMTP 并生成专用密码。',
    imap: { host: 'imap.larksuite.com', port: 993, secure: true },
    smtp: { host: 'smtp.larksuite.com', port: 465, secure: true },
    domains: [],
    color: '#1456f0',
    guideUrl: 'https://www.larksuite.com',
    steps: [
      '打开 Lark →「Mail」→ Settings',
      '「Third-party email clients」→ 开启 IMAP/SMTP，生成专用密码',
      '复制专用密码，粘贴到下方密码框'
    ],
    passwordLabel: '专用密码',
    passwordPlaceholder: 'Lark 生成的专用密码'
  },
  {
    key: 'proton',
    label: 'Proton Mail',
    hint: '通过本机 Proton Mail Bridge 收发（需付费套餐）；使用 Bridge 显示的密码，不是 Proton 登录密码。',
    imap: { host: '127.0.0.1', port: 1143, secure: false },
    smtp: { host: '127.0.0.1', port: 1025, secure: false },
    domains: ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'],
    color: '#6d4aff',
    guideUrl: 'https://proton.me/mail/bridge',
    steps: [
      '下载安装 Proton Mail Bridge 并登录你的 Proton 账户',
      '在 Bridge 中点击该账户 →「Mailbox details」',
      '复制 Bridge 显示的用户名与密码（端口默认 IMAP 1143 / SMTP 1025），粘贴到下方',
      '使用期间保持 Bridge 运行（可设为开机启动）'
    ],
    passwordLabel: 'Bridge 密码',
    passwordPlaceholder: 'Bridge「Mailbox details」中显示的密码',
    guideLinks: [{ label: '下载 Proton Mail Bridge', url: 'https://proton.me/mail/bridge' }]
  },
  {
    key: 'yahoo',
    label: 'Yahoo 邮箱',
    hint: '需要生成「应用密码」（账户安全 → 生成应用密码），不能用登录密码。',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    domains: ['yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.ca', 'yahoo.com.au', 'yahoo.com.tw', 'yahoo.com.hk', 'yahoo.co.in'],
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
    key: 'yeah',
    label: '网易 Yeah',
    hint: '与网易 163 / 126 一样，先开启 IMAP/SMTP，再生成客户端授权密码。',
    imap: { host: 'imap.yeah.net', port: 993, secure: true },
    smtp: { host: 'smtp.yeah.net', port: 465, secure: true },
    domains: ['yeah.net'],
    color: '#ef4444',
    guideUrl: 'https://mail.yeah.net',
    steps: ['登录 Yeah 邮箱网页版 → 设置 → POP3/SMTP/IMAP', '开启 IMAP/SMTP 服务，完成验证并生成客户端授权密码', '复制授权密码到下方，不要使用网页登录密码'],
    passwordLabel: '授权密码',
    passwordPlaceholder: '网易生成的客户端授权密码'
  },
  {
    key: 'yahoo-jp',
    label: 'Yahoo! JAPAN',
    hint: '日本 Yahoo 使用独立服务器；先在网页设置中允许 IMAP/SMTP 与第三方客户端访问。',
    imap: { host: 'imap.mail.yahoo.co.jp', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.co.jp', port: 465, secure: true },
    domains: ['yahoo.co.jp', 'ymail.ne.jp'],
    color: '#7c3aed',
    guideUrl: 'https://support.yahoo-net.jp/PccMail/s/article/H000007321',
    passwordLabel: 'Yahoo! JAPAN 密码',
    passwordPlaceholder: '日本 Yahoo 账户的客户端登录密码'
  },
  {
    key: 'naver',
    label: 'NAVER 邮箱',
    hint: '在网页设置开启 IMAP/SMTP，启用两步验证并生成应用密码。',
    imap: { host: 'imap.naver.com', port: 993, secure: true },
    smtp: { host: 'smtp.naver.com', port: 587, secure: false },
    domains: ['naver.com'],
    color: '#03a94d',
    guideUrl: 'https://help.naver.com/service/30029/contents/21344?osType=COMMONOS',
    steps: ['登录 NAVER Mail → 设置 → POP3/IMAP → 开启 IMAP/SMTP', '在 NAVER 账户安全设置开启两步验证，生成应用密码', '粘贴生成的应用密码；服务器与加密方式已自动填好'],
    passwordLabel: '应用密码',
    passwordPlaceholder: 'NAVER 两步验证设置中生成的应用密码'
  },
  {
    key: 'aol',
    label: 'AOL Mail',
    hint: '在 AOL 账户安全设置生成第三方应用密码，使用完整邮箱地址登录。',
    imap: { host: 'imap.aol.com', port: 993, secure: true },
    smtp: { host: 'smtp.aol.com', port: 465, secure: true },
    domains: ['aol.com', 'aim.com'],
    color: '#222222',
    guideUrl: 'https://help.aol.com/articles/how-do-i-use-other-email-applications-to-send-and-receive-my-aol-mail',
    guideLinks: [{ label: 'AOL 账户安全', url: 'https://login.aol.com/account/security' }],
    passwordLabel: '应用密码',
    passwordPlaceholder: 'AOL 生成的第三方应用密码'
  },
  {
    key: 'agentmail',
    label: 'AgentMail',
    hint: '使用 Inbox 邮箱地址和 API Key，通过标准 IMAP/SMTP 收发。自定义域名也可选此入口。',
    imap: { host: 'imap.agentmail.to', port: 993, secure: true },
    smtp: { host: 'smtp.agentmail.to', port: 465, secure: true },
    domains: ['agentmail.to'],
    color: '#6366f1',
    guideUrl: 'https://docs.agentmail.to/imap-smtp',
    steps: ['在 AgentMail Console → Inboxes 复制要接入的 Inbox 邮箱地址', '在 API Keys 生成或复制此 Inbox 可用的 API Key', '受限 Key 需包含 inbox_read、message_read、message_update、message_send 及全部 label_*_read 权限；详见官方文档', '邮箱填 Inbox 地址，密码填 API Key，服务器已预填'],
    passwordLabel: 'API Key',
    passwordPlaceholder: 'AgentMail API Key'
  },
  {
    key: 'agent',
    label: '其他 Agent 邮箱',
    hint: '接入服务商提供的 IMAP/SMTP 或本机协议桥。只有 REST API / Webhook 的服务暂不能直接连接，请使用服务商的协议桥或转发到已接入邮箱。',
    domains: [],
    color: '#8b5cf6',
    passwordLabel: '客户端密码 / 协议访问令牌',
    passwordPlaceholder: '服务商用于 IMAP/SMTP 的凭据'
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
  const domain = email.trim().split('@')[1]?.toLowerCase() ?? ''
  return (
    PROVIDER_PRESETS.find(p => p.key !== 'custom' && p.domains.includes(domain)) ??
    (domain.endsWith('.onmicrosoft.com') ? PROVIDER_PRESETS.find(p => p.key === 'office365') : undefined) ??
    PROVIDER_PRESETS.find(p => p.key === 'custom')!
  )
}

export const isMicrosoftProvider = (key: ProviderKey): boolean => ['outlook', 'hotmail', 'office365'].includes(key)

/** common 租户授权后根据微软返回的租户选择个人 / 组织服务器，不需要用户区分品牌。 */
export function microsoftProviderFor(email: string, tenantId?: string): 'outlook' | 'office365' {
  if (tenantId) return tenantId === '9188040d-6c67-4c5b-b112-36a304b66dad' ? 'outlook' : 'office365'
  return presetFor(email).key === 'outlook' ? 'outlook' : 'office365'
}

/** 展示优先级独立于旧 key，已有账户与备份继续兼容。 */
const PICK_ORDER: ProviderKey[] = ['proton', 'gmail', 'outlook', 'icloud', 'custom', '163', 'qq', 'yahoo', 'naver', 'aol', 'exmail', 'agentmail', 'agent', '139', 'sina', 'aliyun', 'aliyun-ent', 'feishu', 'lark', 'zoho']
export const ACCOUNT_PROVIDER_CHOICES = PICK_ORDER.map(key => {
  const p = PROVIDER_PRESETS.find(p => p.key === key)!
  return { ...p, label: key === 'outlook' ? 'Microsoft 邮箱' : key === '163' ? '网易邮箱' : key === 'custom' ? '自定义邮箱' : p.label }
})

export const ACCOUNT_COLORS = [
  '#3b82f6', '#22c55e', '#a855f7', '#38bdf8', '#0d9488',
  '#84cc16', '#f97316', '#ef4444', '#be123c', '#64748b'
]
