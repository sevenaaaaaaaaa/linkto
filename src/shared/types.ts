// LinkTo 共享领域类型
// 主进程 / 渲染进程 / 预加载三方共用，改动需保持向后兼容

// ---------- 账户 ----------

export type ProviderKey =
  | 'gmail'
  | 'outlook'
  | 'office365'
  | 'hotmail'
  | 'icloud'
  | 'qq'
  | '163'
  | '126'
  | '139'
  | 'sina'
  | 'exmail'
  | 'aliyun'
  | 'yahoo'
  | 'zoho'
  | 'aliyun-ent'
  | 'feishu'
  | 'lark'
  | 'proton'
  | 'custom'

export interface ImapConfig {
  host: string
  port: number
  secure: boolean
}

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
}

export interface AccountConfig {
  id: string
  provider: ProviderKey
  /** 显示名称，如 "Seven Gmail" */
  name: string
  email: string
  color: string
  enabled: boolean
  /** 默认签名 id，null 表示不附加 */
  signatureId: string | null
  imap: ImapConfig
  smtp: SmtpConfig
  user: string
  /** 认证方式：password 应用专用密码/授权码 · oauth OAuth 2.0（XOAUTH2） */
  authType?: 'password' | 'oauth'
  createdAt: number
}

export interface AccountDraft {
  provider: ProviderKey
  name: string
  email: string
  color: string
  imap: ImapConfig
  smtp: SmtpConfig
  user: string
  password: string
  authType?: 'password' | 'oauth'
}

// ---------- OAuth（Gmail / Outlook 授权登录） ----------

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  /** 过期时间（毫秒时间戳） */
  expiresAt: number
  /** 授权的邮箱（从 id_token 解出） */
  email?: string
}

export interface OAuthClientConfig {
  /** Google Cloud OAuth 客户端（桌面应用类型） */
  google?: { clientId: string; clientSecret: string }
  /** Azure 应用注册的客户端 ID（公共客户端，无需密钥） */
  ms?: { clientId: string }
}

export interface AccountWithStatus extends AccountConfig {
  status: 'connected' | 'syncing' | 'error' | 'disabled'
  statusText: string
  unread: number
}

// ---------- 文件夹 ----------

export type SpecialFolder =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'junk'
  | 'archive'
  | 'all'
  | null

export interface Folder {
  id: string
  accountId: string
  /** IMAP 路径，如 INBOX 或 "Sent Messages" */
  path: string
  name: string
  special: SpecialFolder
  total: number
  unread: number
  hidden: boolean
}

// ---------- 邮件 ----------

export interface Address {
  name?: string
  address: string
}

export type MessageCategory = 'personal' | 'notification' | 'newsletter' | 'noise'

export interface Attachment {
  id: string
  messageId: string
  filename: string
  contentType: string
  size: number
  inline: boolean
  contentId?: string
}

export interface MessageSummary {
  id: string
  accountId: string
  folderId: string
  folderPath: string
  uid: number
  threadId: string
  messageId: string | null
  inReplyTo: string | null
  from: Address | null
  to: Address[]
  cc: Address[]
  replyTo: Address | null
  subject: string
  snippet: string
  date: number
  size: number
  unread: boolean
  flagged: boolean
  answered: boolean
  forwarded: boolean
  hasAttachments: boolean
  hasDraft: boolean
  category: MessageCategory
  isNewsletter: boolean
  listUnsubscribe: string | null
  savedToKb: boolean
  aiSummarized: boolean
  /** 用户置顶（pin），在所有列表中优先显示 */
  pinned: boolean
  /** 稍后处理：到时自动回到收件箱 */
  snoozedUntil: number | null
  /** Screener：发件人待审 / 已拒（仅待审视图内显示） */
  screening?: 'pending' | 'deny' | null
}

export interface MessageFull extends MessageSummary {
  html: string | null
  text: string | null
  attachments: Attachment[]
  references: string[]
  listId: string | null
}

export type ScopeKind =
  | 'unified'
  | 'folder'
  | 'account'
  | 'flagged'
  | 'unread'
  | 'newsletter'
  | 'category'
  | 'search'
  | 'pinned'
  | 'snoozed'
  | 'screener'
  | 'followup'

// ---------- 收件箱纪律 ----------

/** Screener 发件人筛选状态 */
export interface SenderScreening {
  addr: string
  status: 'pending' | 'allow' | 'deny'
  reason: string
  decidedAt: number | null
  createdAt: number
}

/** 可保存的智能视图：scope + 过滤 + 排序 + 聚合的组合快照 */
export interface SmartView {
  id: string
  name: string
  view: {
    scope: Scope
    filter?: string
    sort?: ListSort
    gravity?: number
    groupThreads?: boolean
  }
  createdAt: number
}

/** 空 Scope 类型引用（SmartView 内使用） */
export interface Scope {
  kind: ScopeKind
  title: string
  folderId?: string
  accountId?: string
  category?: 'personal' | 'notification' | 'newsletter' | 'noise'
}

export interface MessageQuery {
  scope: ScopeKind
  folderId?: string
  accountId?: string
  category?: MessageCategory
  search?: string
  limit: number
  offset: number
}

export interface MessagePage {
  items: MessageSummary[]
  total: number
}

// ---------- 通用设置 ----------

export interface GeneralSettings {
  /** 远程图片策略：block 拦截 / allow 显示 */
  remoteImages: 'block' | 'allow'
  /** 删除行为：trash 移到废纸篓 / perm 永久删除 */
  deleteBehavior: 'trash' | 'perm'
  density: 'cozy' | 'compact'
  launchAtLogin: boolean
  dockBadge: boolean
  /** Screener 新发件人审批：新发件人邮件先进入待审队列 */
  screenerEnabled: boolean
  /** 定期整理：已读的订阅邮件 N 天后自动归档（0 / 缺省 = 关闭） */
  cleanupNewsletterDays?: number
  /** 定期整理：已读的通知类邮件 N 天后自动归档（0 / 缺省 = 关闭） */
  cleanupNotificationDays?: number
}

export interface NotificationSettings {
  enabled: boolean
  /** 通知动作 1/2/3，Canary 式 */
  actions: [NotificationAction, NotificationAction, NotificationAction]
  /** 智能通知：仅个人邮件 / 需要你处理的邮件触发 */
  smart: boolean
  sound: boolean
  perAccount: Record<string, { enabled: boolean; sound: string }>
  /** 免打扰时段（默认关闭；支持跨午夜） */
  quietHours?: QuietHours
}

export interface QuietHours {
  enabled: boolean
  /** "HH:MM" */
  start: string
  /** "HH:MM" */
  end: string
}

export type NotificationAction =
  | 'none'
  | 'markRead'
  | 'reply'
  | 'delete'
  | 'archive'
  | 'flag'

// ---------- 签名 / 模板 ----------

export interface Signature {
  id: string
  name: string
  html: string
  /** 默认用于哪些账户：['all'] 或 accountId 列表 */
  defaults: string[]
  updatedAt: number
}

export interface MailTemplate {
  id: string
  name: string
  to: string
  subject: string
  html: string
  updatedAt: number
  /** 分类（如「商务往来」）；空/缺省视为「未分类」 */
  category?: string
}

// ---------- 规则 ----------

/** ai：用自然语言描述的条件，由 AI 在新邮件到达后判断（value 即条件描述） */
export type RuleField = 'from' | 'to' | 'subject' | 'listId' | 'hasAttachment' | 'isNewsletter' | 'ai'
export type RuleOp = 'contains' | 'equals' | 'startsWith' | 'endsWith' | 'regex' | 'is'

export interface RuleCondition {
  field: RuleField
  op: RuleOp
  value: string
}

export type RuleActionType =
  | 'markRead'
  | 'flag'
  | 'unflag'
  | 'setCategory'
  | 'moveTrash'
  | 'markNewsletter'
  | 'saveToKb'
  | 'notify'
  /** 执行连接器动作，value = `${instanceId}:${actionId}` */
  | 'runConnector'
  /** 移到文件夹，value = 目标文件夹 id（同账户） */
  | 'moveFolder'
  | 'archive'
  | 'pin'
  /** 稍后处理，value = 小时数 */
  | 'snooze'
  /** 建待办，value = 标题前缀（空则用邮件主题） */
  | 'createTodo'

export interface RuleAction {
  type: RuleActionType
  value?: string
}

export interface Rule {
  id: string
  name: string
  enabled: boolean
  order: number
  conditions: RuleCondition[]
  actions: RuleAction[]
}

// ---------- Agent 动作（用户确认后执行） ----------

export type AgentActionType = 'archive' | 'trash' | 'markRead' | 'markUnread' | 'flag' | 'snooze' | 'todo' | 'draftReply'

export interface AgentAction {
  type: AgentActionType
  /** 目标邮件（todo 可省略） */
  messageId?: string
  /** snooze 截止：YYYY-MM-DD HH:mm */
  until?: string
  /** todo 标题 */
  title?: string
  /** todo 截止：YYYY-MM-DD */
  due?: string
  /** draftReply 回复正文（纯文本） */
  body?: string
  reason?: string
}

// ---------- AI ----------

export interface AISettings {
  enabled: boolean
  baseURL: string
  apiKey: string
  model: string
  autoClassify: boolean
  autoSummary: boolean
  /** 新邮件自动提炼：账单/会议→待办、Newsletter→阅读清单（需 AI） */
  autoInsights: boolean
  /** 每天自动生成当日商情（重点 / digest / 备忘录 / 清理建议）（需 AI） */
  autoDigest: boolean
  /** 新邮件自动「邮件理解」（要点 / 分区 / 实体 / 建议动作，结果本地缓存）（需 AI） */
  autoUnderstand: boolean
  /** 用户自定义咒语：启用后追加到所有 AI 功能的系统提示 */
  customPrompts: CustomPrompt[]
}

export interface CustomPrompt {
  id: string
  name: string
  text: string
  enabled: boolean
}

export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// ---------- 知识库 ----------

export type KbKind = 'message' | 'thread' | 'note' | 'summary'

export interface KbItem {
  id: string
  kind: KbKind
  title: string
  content: string
  sourceMessageId: string | null
  sourceLabel: string | null
  tags: string[]
  createdAt: number
}

// ---------- 连接器 ----------

export type ConnectorAuthKind = 'none' | 'webhook' | 'apiKey'

export interface ConnectorActionParam {
  key: string
  label: string
  required?: boolean
  type?: 'text' | 'textarea'
}

export interface ConnectorActionDef {
  id: string
  name: string
  params?: ConnectorActionParam[]
}

export interface ConnectorManifest {
  id: string
  name: string
  description: string
  icon: string
  color: string
  auth: ConnectorAuthKind
  settingsFields?: ConnectorActionParam[]
  actions: ConnectorActionDef[]
}

export interface ConnectorInstance {
  id: string
  manifestId: string
  enabled: boolean
  config: Record<string, string>
}

// ---------- 网盘备份（WebDAV / Dropbox / 本地同步目录，存 eml 原文与附件） ----------

/** local：本地同步目录（如 Proton Drive / iCloud Drive 的同步文件夹），复制文件即由网盘客户端自动上云 */
export type CloudDriveKind = 'webdav' | 'dropbox' | 'local'

export interface CloudDriveConfig {
  id: string
  kind: CloudDriveKind
  name: string
  /** WebDAV 服务器根 URL（如 https://nas.local:5006）；Dropbox 留空 */
  url: string
  /** WebDAV 用户名；Dropbox 留空 */
  username: string
  /** 远端根目录（如 /LinkTo） */
  remotePath: string
  /** 本地同步目录的绝对路径（仅 kind = 'local'） */
  localPath?: string
}

// ---------- 撰写 ----------

export interface ComposeDraft {
  id: string
  accountId: string
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  inReplyToMessageId?: string
  /** 回复/转发时引用的原邮件 id */
  relatedMessageId?: string
  attachmentPaths: string[]
}

export interface SendResult {
  ok: boolean
  error?: string
  messageId?: string
}

// ---------- 事件（主进程 → 渲染进程推送） ----------

export type MailEvent =
  | { type: 'accounts-changed' }
  | { type: 'folders-changed' }
  | { type: 'messages-changed'; accountId?: string }
  | { type: 'account-status'; accountId: string; status: 'connected' | 'syncing' | 'error' | 'disabled'; text: string }
  | { type: 'sync-progress'; accountId: string; text: string }
  | { type: 'ai-stream'; requestId: string; delta: string; done: boolean; error?: string }
  | { type: 'new-mail'; accountId: string; subject: string; from: string }
  | { type: 'outbox-changed' }
  | { type: 'mail-sent'; subject: string; to: string }
  | { type: 'insights-changed' }
  | { type: 'connectors-changed' }
  | { type: 'ghost-changed' }
  | { type: 'ai-local-download'; modelId: string; received: number; total: number; percent: number; done?: boolean; error?: string }
  /** 邮件理解结果新增/更新（AI 结果异步到达） */
  | { type: 'mail-insights'; ids: string[] }
  /** 点击系统通知：主窗口打开指定邮件 */
  | { type: 'open-message'; messageId: string }

// ---------- 智能洞察 ----------

// ---------- 待办（GTD）：存在 insights 表 kind='todo' 的 data 里 ----------

export type TodoKind = 'reply' | 'task' | 'meeting'
export type TodoProvider = 'apple-reminders' | 'apple-calendar' | 'google-tasks' | 'google-calendar' | 'ms-todo' | 'ms-calendar'

export interface TodoChecklistItem {
  id: string
  text: string
  done: boolean
}

export interface TodoMeeting {
  /** 入会链接（Zoom / Teams / Meet / 腾讯会议 / 飞书会议 / Webex） */
  url: string
  provider: 'zoom' | 'teams' | 'meet' | 'tencent' | 'feishu' | 'webex' | 'other'
  startsAt: number
  endsAt?: number | null
  /** 会议号 / 密码（如有） */
  code?: string
}

/** 待办的全部维度（insights.data）。所有字段可选，旧数据照常可读 */
export interface TodoData {
  /** 来源：mail / agent / rule / manual / bulk / mcp / meeting / 外部服务名 */
  from?: string
  todoKind?: TodoKind
  /** 预估时长（分钟） */
  minutes?: number
  /** 1 高 · 2 中 · 3 低 */
  priority?: 1 | 2 | 3
  /** 固定开始时间（ms）：会议、约好的电话 */
  fixedAt?: number | null
  aiReason?: string
  auto?: boolean
  /** 项目 / 清单 */
  project?: string
  tags?: string[]
  /** 情境：@电脑 / @电话 / @外出 / @等待 … */
  context?: string
  /** 所需精力 */
  energy?: 'low' | 'mid' | 'high'
  notes?: string
  checklist?: TodoChecklistItem[]
  /** 重复：完成后按规则生成下一次 */
  repeat?: { freq: 'daily' | 'weekdays' | 'weekly' | 'monthly'; interval?: number } | null
  meeting?: TodoMeeting | null
  /** 还在收集箱（未整理） */
  inbox?: boolean
  doneAt?: number
  doneBy?: string
  /** 最后修改时间（ms），跨设备同步按它合并 */
  updatedAt?: number
  /** 与外部服务的映射：各服务里的 id / 所属清单 / 上次同步 */
  external?: Partial<Record<TodoProvider, { id: string; listId?: string; etag?: string; syncedAt: number }>>
}

/** swipe：营销灵感收藏（公司洞察挑出的范本邮件） */
export type InsightKind = 'todo' | 'reading' | 'daily' | 'memo' | 'company' | 'swipe'

export interface InsightRecord {
  id: string
  kind: InsightKind
  messageId: string | null
  accountId: string | null
  title: string
  status: 'open' | 'done'
  dueAt: number | null
  createdAt: number
  data: Record<string, unknown>
}

export interface TodoExtract {
  title: string
  due?: string | null
  amount?: string | null
  link?: string | null
}

export interface ReadingExtract {
  title: string
  url?: string | null
  summary?: string | null
}

export interface DigestTheme {
  theme: string
  summary: string
  count: number
}

export interface DeleteSuggestion {
  messageId: string
  subject: string
  from: string
  reason: string
}

export interface DailyDigest {
  highlights: string[]
  themes: DigestTheme[]
  memo: string
  deleteSuggestions: DeleteSuggestion[]
  stats: { total: number; senders: number }
  generatedAt: number
}

export interface CompanyInsight {
  company: string
  domain: string
  summary: string
  timeline: { period: string; event: string }[]
  strategy: string
  credibility: { score: number; reasons: string }
  conversionIndex: { score: number; reasons: string }
  mailCount: number
  generatedAt: number
  /** 营销拆解（v2）：每条都能回到原邮件 */
  cadence?: string
  launches?: { messageId: string; date: string; title: string; angle: string; subject: string }[]
  campaigns?: { messageIds: string[]; period: string; theme: string; offer: string; tactics: string[] }[]
  conversionPoints?: { messageId: string; subject: string; date: number; stage: string; triggers: string[]; cta: string; why: string }[]
  bestPicks?: { messageId: string; subject: string; date: number; why: string; learn: string[]; stage: string; triggers: string[] }[]
}

/** 营销灵感收藏条目（insights kind='swipe' 的 data） */
export interface SwipeData {
  company: string
  domain: string
  why: string
  learn: string[]
  stage: string
  triggers: string[]
  date: number
}

export interface ScheduledSend {
  id: string
  accountId: string
  to: string[]
  subject: string
  sendAt: number
  createdAt: number
}

// ---------- AI 收件箱纪律解法 ----------

/** 自然语言搜索：AI 把问句编译成结构化查询 */
export interface NLQuery {
  text?: string
  sender?: string
  subject?: string
  category?: 'personal' | 'notification' | 'newsletter' | 'noise' | null
  isNewsletter?: boolean | null
  hasAttachment?: boolean | null
  unreadOnly?: boolean | null
  /** 相对时间：最近 N 天 */
  withinDays?: number | null
  /** 时间区间（ISO 日期） */
  after?: string | null
  before?: string | null
  /** 无法结构化的部分退回关键词检索 */
  fallbackText?: string | null
}

/** 待跟进邮件的 AI 判断 */
export interface FollowupJudgement {
  messageId: string
  needsFollowup: boolean
  urgency: 'high' | 'medium' | 'low'
  reason: string
}

// ---------- 列表排序 / 魔法排序 / 批量提问 ----------

export type ListSort = 'date' | 'dateAsc' | 'unread' | 'smart'

export interface RankedMessage {
  id: string
  reason: string
}

export interface BulkTodo {
  title: string
  due?: string | null
}

// ---------- Agent 记忆（个人 Agent 成长系统） ----------

/** 记忆域：fact 事实 · preference 偏好 · person 人物关系 · commitment 承诺 · routine 惯例 */
export type MemoryScope = 'fact' | 'preference' | 'person' | 'commitment' | 'routine'

export interface AgentMemory {
  id: string
  scope: MemoryScope
  /** 关联实体（发件人地址 / 域名 / 主题词），用于定向召回 */
  entity: string
  title: string
  content: string
  source: 'auto' | 'manual'
  sourceMessageId?: string | null
  confidence: number
  useCount: number
  lastUsedAt?: number | null
  status: 'active' | 'archived'
  createdAt: number
  updatedAt: number
}

export interface ContactProfile {
  addr: string
  displayName: string
  mailCount: number
  firstContact: number
  lastContact: number
  /** 我对该发件人的回复率（0-100） */
  myReplyRate: number
  topTopics: string[]
  summary: string
  keyFacts: string[]
  generatedAt: number
}

// ---------- 幽灵信（端到端加密 · 阅后即焚） ----------

/** 信箱中的一封加密信（密文落盘，未开信前无任何可读元数据） */
export interface GhostItem {
  id: string
  receivedAt: number
  sealedBytes: number
}

/** 发送草稿：经指定账户哑管道投递，内容全密文 */
export interface GhostSendDraft {
  accountId: string
  /** 收件人真实邮箱（仅投递用，不出现在信封内容中）；via='relay' 时可空 */
  to: string
  /** 收件人幽灵 ID（X25519 公钥 SPKI DER, base64） */
  ghostId: string
  /** 打开口令（双因子之一，与收件人私钥缺一不可） */
  password: string
  text: string
  /** 投递通道：mail=邮箱哑管道（默认）/ relay=匿名中继（伪装 HTTPS，无需邮箱账户） */
  via?: 'mail' | 'relay'
}

// ---------- 邮件理解（每封一次 AI/启发式理解，列表 / 阅读页 / 今日简报 / Agent 共用） ----------

export type MailSection = 'act' | 'wait' | 'fyi' | 'bundle'
export type MailBundle = 'newsletter' | 'notification' | 'screener'

export interface MailEntity {
  kind: 'time' | 'deadline' | 'money' | 'code' | 'link' | 'tracking'
  /** 显示用短标签，如「周三 15:00」「¥12,800」「482913」 */
  label: string
  /** 机器可用值：ISO 时间 / 数字金额字符串 / 验证码 / URL */
  value: string
  action: 'calendar' | 'todo' | 'copy' | 'open' | null
}

export interface MailNextAction {
  kind: 'reply' | 'todo' | 'snooze' | 'archive' | 'open' | 'forward'
  /** 按钮文字即建议，如「回复：周三 15:00 可以」「稍后到周三上午」「建待办：准备预算」 */
  label: string
  /** reply/forward: 草稿正文（纯文本）；todo: 标题；snooze: until 'YYYY-MM-DD HH:mm'；open: url */
  body?: string
  title?: string
  due?: string | null
  until?: string
  url?: string
}

export interface MailInsight {
  messageId: string
  section: MailSection
  bundle: MailBundle | null
  /** 一句话要点（≤60 字），列表行和阅读页要点卡共用 */
  gist: string
  /** gist 里需要荧光标出的关键短语（必须是 gist 的子串），可为 null */
  gistKey: string | null
  /** 0-100，「需要你处理」分区内排序依据 */
  urgency: number
  entities: MailEntity[]
  /** 正文里值得荧光划出的原句片段（必须逐字出现在正文中，≤4 条，每条 ≤80 字） */
  highlights: string[]
  next: MailNextAction[]
  /** 快速回复草稿（纯文本，可空） */
  quickReply: string
  source: 'ai' | 'heuristic'
  updatedAt: number
}

export interface FolderPref {
  pinned: boolean
  sync: boolean
}

export interface TodayBrief {
  headline: string
  lines: string[]
  actCount: number
  waitCount: number
  dueToday: number
  source: 'ai' | 'heuristic'
}
