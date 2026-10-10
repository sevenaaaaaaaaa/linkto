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
}

export interface NotificationSettings {
  enabled: boolean
  /** 通知动作 1/2/3，Canary 式 */
  actions: [NotificationAction, NotificationAction, NotificationAction]
  smart: boolean
  sound: boolean
  /** 仅个人邮件通知（智能通知模式） */
  perAccount: Record<string, { enabled: boolean; sound: string }>
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
}

// ---------- 规则 ----------

export type RuleField = 'from' | 'to' | 'subject' | 'listId' | 'hasAttachment' | 'isNewsletter'
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

// ---------- 智能洞察 ----------

export type InsightKind = 'todo' | 'reading' | 'daily' | 'memo' | 'company'

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
}

export interface ScheduledSend {
  id: string
  accountId: string
  to: string[]
  subject: string
  sendAt: number
  createdAt: number
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
