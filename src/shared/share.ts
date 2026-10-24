/**
 * 导出与分享中心：主进程 / 渲染端共用的类型与纯函数（命名模板、格式标签、目标能力）。
 * 不依赖 Electron / DOM，可单独打包做单测。
 */

/** 导出 / 分享的格式 */
export type ShareFormat = 'text' | 'rich' | 'pdf' | 'png' | 'eml' | 'md' | 'link'

export const SHARE_FORMATS: { id: ShareFormat; label: string; ext: string; desc: string }[] = [
  { id: 'text', label: '文本', ext: 'txt', desc: '标题、发件人、时间与正文的纯文本' },
  { id: 'rich', label: '富文本', ext: 'html', desc: '保留格式的 HTML（粘贴到文档 / IM 带样式）' },
  { id: 'pdf', label: 'PDF', ext: 'pdf', desc: '打印版：头部信息 + 正文 + 附件清单' },
  { id: 'png', label: '长图', ext: 'png', desc: '固定宽度的长截图，适合发微信' },
  { id: 'eml', label: 'EML', ext: 'eml', desc: '邮件原文，任何邮件客户端都能打开' },
  { id: 'md', label: 'Markdown', ext: 'md', desc: '带 front-matter 的 Markdown，附件放同名文件夹' },
  { id: 'link', label: '链接', ext: 'txt', desc: 'LinkTo 内部链接（本机定位）+ 网页版搜索链接' }
]

export const formatLabel = (f: ShareFormat) => SHARE_FORMATS.find(x => x.id === f)?.label ?? f
export const formatExt = (f: ShareFormat) => SHARE_FORMATS.find(x => x.id === f)?.ext ?? 'txt'

/** 可配置的分享目标类型（存 AppStore，密钥走 saveSecret） */
export type ShareTargetKind =
  | 'wecom'
  | 'dingtalk'
  | 'feishu'
  | 'slack'
  | 'teams'
  | 'discord'
  | 'telegram'
  | 'notion'
  | 'flomo'
  | 'readwise'
  | 'apple-notes'
  | 'md-folder'
  | 'local-folder'

/** 内置目标（无需配置）：系统分享、微信、WhatsApp、Telegram 链接、剪贴板、导出到本地；网盘目标 id 为 drive:<网盘 id> */
export type ShareBuiltinId = 'sys:share' | 'sys:wechat' | 'sys:whatsapp' | 'sys:telegram-link' | 'sys:clipboard' | 'sys:export'

export type ShareGroup = 'im' | 'work-im' | 'notes' | 'local' | 'drive' | 'system'

export const SHARE_GROUP_LABEL: Record<ShareGroup, string> = {
  im: 'IM',
  'work-im': '工作 IM',
  notes: '笔记',
  local: '本地',
  drive: '网盘',
  system: '系统'
}

export interface ShareKindMeta {
  kind: ShareTargetKind
  label: string
  group: ShareGroup
  formats: ShareFormat[]
  /** 配置字段 */
  fields: ShareField[]
  /** 设置页说明 */
  help: string
}

export interface ShareField {
  key: 'url' | 'secret' | 'token' | 'chatId' | 'parentId' | 'parentType' | 'folder' | 'pathTemplate' | 'driveId' | 'tags' | 'notesFolder' | 'apiBase'
  label: string
  placeholder?: string
  secret?: boolean
  optional?: boolean
  kind?: 'text' | 'dir' | 'drive' | 'select'
  options?: { value: string; label: string }[]
}

/** IM 文件类格式：Webhook 不能直接发文件，需归档到网盘后附链接 */
export const FILE_FORMATS: ShareFormat[] = ['pdf', 'png', 'eml', 'md']

const WEBHOOK_FIELDS = (urlPh: string, signLabel?: string): ShareField[] => [
  { key: 'url', label: 'Webhook 地址', placeholder: urlPh, secret: true },
  ...(signLabel ? [{ key: 'secret' as const, label: signLabel, placeholder: '未开启可留空', secret: true, optional: true }] : []),
  { key: 'driveId', label: '文件先存到网盘', kind: 'drive', optional: true }
]

export const SHARE_KINDS: ShareKindMeta[] = [
  {
    kind: 'wecom',
    label: '企业微信群机器人',
    group: 'work-im',
    formats: ['text', 'rich', 'link', ...FILE_FORMATS],
    fields: WEBHOOK_FIELDS('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'),
    help: '群聊 → 右上角 ⋯ → 添加群机器人 → 复制 Webhook 地址。消息按企业微信 Markdown 发送（≤4096 字节）。'
  },
  {
    kind: 'dingtalk',
    label: '钉钉群机器人',
    group: 'work-im',
    formats: ['text', 'rich', 'link', ...FILE_FORMATS],
    fields: WEBHOOK_FIELDS('https://oapi.dingtalk.com/robot/send?access_token=…', '加签密钥（SEC 开头）'),
    help: '群设置 → 机器人 → 添加自定义机器人。安全设置选「加签」时把 SEC 开头的密钥填进来；选「自定义关键词」时请把「邮件」设为关键词。'
  },
  {
    kind: 'feishu',
    label: '飞书 / Lark 群机器人',
    group: 'work-im',
    formats: ['text', 'rich', 'link', ...FILE_FORMATS],
    fields: WEBHOOK_FIELDS('https://open.feishu.cn/open-apis/bot/v2/hook/…', '签名校验密钥'),
    help: '群设置 → 群机器人 → 添加自定义机器人。开启「签名校验」时填写密钥；消息以卡片形式发送。'
  },
  {
    kind: 'slack',
    label: 'Slack',
    group: 'work-im',
    formats: ['text', 'rich', 'link', ...FILE_FORMATS],
    fields: WEBHOOK_FIELDS('https://hooks.slack.com/services/…'),
    help: 'Slack App → Incoming Webhooks → Add New Webhook to Workspace，选择频道后复制地址。消息用 Block Kit 排版。'
  },
  {
    kind: 'teams',
    label: 'Microsoft Teams',
    group: 'work-im',
    formats: ['text', 'rich', 'link', ...FILE_FORMATS],
    fields: WEBHOOK_FIELDS('https://…/workflows/…  或  https://…webhook.office.com/…'),
    help: '频道 → 工作流 →「收到 Webhook 请求时发布到频道」，或旧版 Incoming Webhook 连接器。消息以 Adaptive Card 发送。'
  },
  {
    kind: 'discord',
    label: 'Discord',
    group: 'im',
    formats: ['text', 'rich', 'link', ...FILE_FORMATS],
    fields: WEBHOOK_FIELDS('https://discord.com/api/webhooks/…'),
    help: '服务器设置 → 整合 → Webhook → 新建，复制 Webhook URL。消息以 Embed 卡片发送。'
  },
  {
    kind: 'telegram',
    label: 'Telegram 机器人',
    group: 'im',
    formats: ['text', 'rich', 'link', ...FILE_FORMATS],
    fields: [
      { key: 'token', label: 'Bot Token', placeholder: '找 @BotFather 创建机器人获得', secret: true },
      { key: 'chatId', label: 'Chat ID', placeholder: '个人 / 群组 / 频道 id，如 -100…' },
      { key: 'apiBase', label: 'API 地址', placeholder: 'https://api.telegram.org（自建 Bot API 时修改）', optional: true }
    ],
    help: '文件直接发（PDF / 长图 / EML / Markdown，机器人接口上限 50 MB）。先在 Telegram 里给机器人发一条消息或把它拉进群。'
  },
  {
    kind: 'notion',
    label: 'Notion',
    group: 'notes',
    formats: ['text', 'rich', 'md', 'link'],
    fields: [
      { key: 'token', label: 'Integration Token', placeholder: 'notion.so/my-integrations 创建后复制', secret: true },
      {
        key: 'parentType',
        label: '存到',
        kind: 'select',
        options: [
          { value: 'database', label: '数据库（每封一行）' },
          { value: 'page', label: '页面（作为子页面）' }
        ]
      },
      { key: 'parentId', label: '数据库 / 页面 ID', placeholder: '链接里 32 位的那串' },
      { key: 'apiBase', label: 'API 地址', placeholder: 'https://api.notion.com', optional: true }
    ],
    help: '在目标数据库 / 页面右上角 ⋯ → 连接 → 选中你的 Integration。数据库里若有「发件人」「日期」「链接」等同名属性会自动填写。'
  },
  {
    kind: 'flomo',
    label: 'flomo',
    group: 'notes',
    formats: ['text', 'link'],
    fields: [
      { key: 'url', label: 'API 地址', placeholder: 'https://flomoapp.com/iwh/…', secret: true },
      { key: 'tags', label: '标签', placeholder: '#邮件 #待读', optional: true }
    ],
    help: 'flomo 设置 → 扩展中心 → API，复制专属记录 API。内容为纯文本 + 标签。'
  },
  {
    kind: 'readwise',
    label: 'Readwise Reader',
    group: 'notes',
    formats: ['link', 'text', 'rich'],
    fields: [{ key: 'token', label: 'Reader API Token', placeholder: 'readwise.io/integrations → Reader API', secret: true }],
    help: 'Readwise Reader → Integrations → 复制 Reader API Token。带链接的内容直接收藏，邮件按正文存入稍后读。'
  },
  {
    kind: 'apple-notes',
    label: 'Apple 备忘录',
    group: 'notes',
    formats: ['text', 'rich', 'link'],
    fields: [{ key: 'notesFolder', label: '文件夹', placeholder: '留空 = 默认文件夹', optional: true }],
    help: '首次写入时 macOS 会询问「LinkTo 想要控制备忘录」，请点「好」。拒绝过的话：系统设置 → 隐私与安全性 → 自动化 → LinkTo → 勾选「备忘录」。'
  },
  {
    kind: 'md-folder',
    label: 'Markdown 笔记文件夹',
    group: 'notes',
    formats: ['md'],
    fields: [
      { key: 'folder', label: '笔记文件夹', kind: 'dir' },
      { key: 'pathTemplate', label: '命名模板', placeholder: '{year}/{month}/{subject}', optional: true }
    ],
    help: '适用于任何基于 Markdown 文件的笔记工具：选中笔记库里的一个文件夹，邮件按模板存成 .md，附件放在同名文件夹里。'
  },
  {
    kind: 'local-folder',
    label: '本地文件夹',
    group: 'local',
    formats: ['text', 'rich', 'pdf', 'png', 'eml', 'md'],
    fields: [{ key: 'folder', label: '文件夹', kind: 'dir' }],
    help: '直接导出到固定的本地文件夹（如 iCloud 云盘 / 同步盘里的某个目录）。'
  }
]

export const kindMeta = (k: ShareTargetKind) => SHARE_KINDS.find(x => x.kind === k)!

/** 存储的分享目标（不含密钥） */
export interface ShareTarget {
  id: string
  kind: ShareTargetKind
  name: string
  chatId?: string
  parentType?: 'database' | 'page'
  parentId?: string
  folder?: string
  pathTemplate?: string
  driveId?: string | null
  tags?: string
  notesFolder?: string
  apiBase?: string
  createdAt: number
}

/** 保存目标：密钥字段为空 = 保持原值 */
export interface ShareTargetInput extends Omit<ShareTarget, 'id' | 'createdAt'> {
  id?: string
  url?: string
  secret?: string
  token?: string
}

/** 列表里的目标（含内置 / 网盘） */
export interface ShareTargetInfo {
  id: string
  name: string
  group: ShareGroup
  kind: ShareTargetKind | 'builtin' | 'drive'
  formats: ShareFormat[]
  /** 是否对外发送（需要用户确认） */
  external: boolean
  /** 一行说明（掩码后的地址 / 目录） */
  hint?: string
  /** 已存的密钥（不回传原文）：url / secret / token 是否已填 */
  secrets?: { url: boolean; secret: boolean; token: boolean }
  config?: ShareTarget
}

export interface ShareSettings {
  /** 默认导出目录（快速导出） */
  exportDir: string | null
  /** 导出时弹出系统保存对话框（否则直接存到默认目录） */
  askWhere: boolean
  /** 上次在保存对话框里选的目录 */
  lastDir: string | null
  /** 文件命名模板 */
  nameTemplate: string
  /** PDF 含附件清单 */
  pdfAttachmentList: boolean
  /** PDF / 长图里的远程图片：follow = 跟随阅读设置 */
  remoteImages: 'follow' | 'allow' | 'block'
  /** 多封导出 PDF 时合并成一个 */
  pdfMerge: boolean
  /** 长图宽度（CSS 像素） */
  imageWidth: number
  /** IM / 笔记里的正文摘录长度（字） */
  excerptChars: number
  /** 最近使用的目标 id（新的在前） */
  recent: string[]
}

export const DEFAULT_SHARE_SETTINGS: ShareSettings = {
  exportDir: null,
  askWhere: false,
  lastDir: null,
  nameTemplate: '{date}-{subject}',
  pdfAttachmentList: true,
  remoteImages: 'follow',
  pdfMerge: true,
  imageWidth: 750,
  excerptChars: 600,
  recent: []
}

/**
 * 通用内容（非邮件）：订阅文章、网页等。由订阅阅读区的 ms:share-request 事件或 Agent 带入。
 * 正文优先用 feedItemId 在主进程取（全文 > 订阅自带正文），其次 html，再次 text。
 */
export interface ShareContent {
  kind: 'link'
  title: string
  url?: string | null
  /** 摘要 / AI 摘要（纯文本） */
  text?: string | null
  /** 正文 HTML（会再消毒） */
  html?: string | null
  /** 来源（订阅源名称 / 网站） */
  source?: string | null
  /** 发布时间 */
  date?: number | null
  /** 订阅条目 id */
  feedItemId?: string | null
}

/** 通用内容可用的格式（没有 EML 原文） */
export const CONTENT_FORMATS: ShareFormat[] = ['text', 'rich', 'md', 'link', 'pdf', 'png']

export interface ShareRequest {
  /** 邮件 id；分享通用内容时传空数组并给 content */
  messageIds: string[]
  /** 通用内容（订阅文章 / 网页）：给出时忽略 messageIds */
  content?: ShareContent | null
  targetId: string
  format: ShareFormat
  /** 连同附件（Markdown 导出到同名文件夹 / Telegram 逐个发送 / Webhook 归档到网盘后附链接） */
  includeAttachments?: boolean
  /** 多封时合并（PDF 合成一个文件；IM 合成一条消息） */
  merge?: boolean
  /** 附言（IM / 笔记开头） */
  note?: string
  /** 对外发送：界面上用户已确认 */
  confirmed?: boolean
  /** 导出：弹保存对话框 / 直接存默认目录 / 指定目录 */
  where?: 'ask' | 'quick' | 'dir'
  dir?: string
}

export interface SharePreview {
  ok: boolean
  error?: string
  target: string
  external: boolean
  /** 将发出 / 写入的文字内容（IM 消息、笔记正文、文件名列表…） */
  title: string
  body: string
  /** 将生成 / 附带的文件 */
  files: string[]
  warnings: string[]
}

export interface ShareResult {
  ok: boolean
  error?: string
  /** 成功的一句话 */
  message?: string
  paths?: string[]
  url?: string
  count?: number
  canceled?: boolean
}

export interface ShareLinks {
  app: string
  gmail: string | null
  /** Outlook 网页版邮箱入口（没有公开的搜索深链，见 webLinksFor） */
  outlook: string | null
  /** 在 Outlook 网页版搜索框里粘贴的搜索词 */
  outlookQuery?: string | null
}

// ---------------------------------------------------------------- 纯函数

const pad = (n: number) => String(n).padStart(2, '0')

/** 文件名安全化：去掉路径分隔、保留字与控制字符，压缩空白，限长 */
export function safeFileName(name: string, max = 80): string {
  const s = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
  const cut = [...s].slice(0, max).join('')
  return cut || 'untitled'
}

export interface NameVars {
  subject: string
  from: string
  fromAddr: string
  date: number
  account?: string
}

/**
 * 命名模板：{date} 2026-10-19 · {time} 0930 · {year} {month} {day} · {subject} · {from} · {fromAddr} · {account}
 * 模板里的 / 表示子目录（仅 Markdown 笔记文件夹使用）；每段单独安全化。
 */
export function renderNameTemplate(tpl: string, v: NameVars, opts: { allowDirs?: boolean } = {}): string {
  const d = new Date(v.date || Date.now())
  const vars: Record<string, string> = {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}`,
    year: String(d.getFullYear()),
    month: pad(d.getMonth() + 1),
    day: pad(d.getDate()),
    subject: (v.subject || '').trim() || '无主题',
    from: (v.from || '').trim() || (v.fromAddr || '').split('@')[0] || '未知发件人',
    fromAddr: v.fromAddr || '',
    account: v.account || ''
  }
  const raw = (tpl || '{date}-{subject}').replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m))
  const parts = raw.split('/').map(p => p.trim()).filter(Boolean)
  if (!opts.allowDirs) return safeFileName(parts.join('-'))
  return parts.map((p, i) => safeFileName(p, i === parts.length - 1 ? 80 : 40)).join('/') || 'untitled'
}

/** 同目录重名：name.ext → name (2).ext */
export function dedupeName(name: string, exists: (n: string) => boolean): string {
  if (!exists(name)) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 1000; i++) {
    const n = `${base} (${i})${ext}`
    if (!exists(n)) return n
  }
  return `${base}-${Date.now()}${ext}`
}

/** LinkTo 内部链接：linkto://open?mid=<Message-ID（不带尖括号）> */
export function appLinkFor(messageId: string | null | undefined, fallbackId?: string): string {
  const mid = String(messageId ?? '').trim().replace(/^<|>$/g, '')
  if (mid) return `linkto://open?mid=${encodeURIComponent(mid)}`
  return `linkto://open?id=${encodeURIComponent(fallbackId ?? '')}`
}

/** 解析 linkto:// 链接 → { mid } 或 { id } */
export function parseAppLink(url: string): { mid?: string; id?: string } | null {
  const m = String(url ?? '').trim().match(/^linkto:\/\/open\/?\?(.*)$/i)
  if (!m) return null
  const q = new URLSearchParams(m[1])
  const mid = q.get('mid')?.trim().replace(/^<|>$/g, '')
  const id = q.get('id')?.trim()
  if (mid) return { mid }
  if (id) return { id }
  return null
}

/**
 * 跨设备备选链接：
 *  - Gmail：按 Message-ID 精确搜索。rfc822msgid: 是 Gmail 官方搜索运算符
 *    （https://support.google.com/mail/answer/7190），#search/<查询> 是网页版搜索页的地址格式。
 *  - Outlook 网页版：微软没有公开「按条件搜索」的深链（Learn 文档只给了 /mail/deeplink/compose 撰写深链；
 *    社区实测 /mail/deeplink/search?query= 与 /mail/0/search?q= 都不会自动执行搜索，见
 *    https://learn.microsoft.com/en-us/answers/questions/721762/generating-a-link-to-an-advanced-query-search ）。
 *    因此链接只打开对应的网页版邮箱（个人账户 outlook.live.com/mail/0/，工作 / 学校账户 outlook.office.com/mail/），
 *    搜索词另给出（outlookQuery），由用户粘贴到搜索框。
 */
export function webLinksFor(messageId: string | null | undefined, subject: string, provider?: string | null): { gmail: string | null; outlook: string | null; outlookQuery: string | null } {
  const mid = String(messageId ?? '').trim().replace(/^<|>$/g, '')
  const subj = String(subject ?? '').trim()
  return {
    gmail: mid ? `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(`rfc822msgid:${mid}`)}` : null,
    outlook: subj ? (provider === 'office365' ? 'https://outlook.office.com/mail/' : 'https://outlook.live.com/mail/0/') : null,
    outlookQuery: subj ? `subject:"${subj.slice(0, 120).replace(/"/g, '')}"` : null
  }
}

/** 目标是否支持某格式 */
export function targetSupports(t: Pick<ShareTargetInfo, 'formats'>, f: ShareFormat): boolean {
  return t.formats.includes(f)
}
