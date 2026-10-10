import type {
  AccountConfig,
  AccountDraft,
  AccountWithStatus,
  AISettings,
  Attachment,
  CompanyInsight,
  ComposeDraft,
  ConnectorInstance,
  ConnectorManifest,
  CloudDriveConfig,
  DailyDigest,
  Folder,
  GeneralSettings,
  InsightKind,
  InsightRecord,
  KbItem,
  MailTemplate,
  MessageFull,
  MessagePage,
  MessageQuery,
  MessageSummary,
  NotificationSettings,
  RankedMessage,
  Rule,
  ScheduledSend,
  SendResult,
  Signature,
  BulkTodo,
  AgentMemory,
  ContactProfile,
  MemoryScope,
  OAuthClientConfig,
  ProviderKey
} from './types'

/** 渲染进程可调用的全部 API（经 contextBridge 暴露） */
export interface LinkToApi {
  // ---------- 账户 ----------
  listAccounts(): Promise<AccountWithStatus[]>
  addAccount(draft: AccountDraft): Promise<{ ok: boolean; error?: string; account?: AccountConfig }>
  verifyAccount(draft: AccountDraft): Promise<{ ok: boolean; error?: string }>
  updateAccount(id: string, patch: Partial<AccountDraft>): Promise<void>
  setAccountEnabled(id: string, enabled: boolean): Promise<void>
  deleteAccount(id: string): Promise<void>
  syncAccountNow(id: string): Promise<void>

  // ---------- OAuth 一键授权（Gmail / Outlook） ----------
  /** OAuth 应用凭据（Google client id/secret、Microsoft client id） */
  getOAuthClientConfig(): Promise<OAuthClientConfig>
  setOAuthClientConfig(cfg: OAuthClientConfig): Promise<void>
  /** 一键授权并添加账户；微软设备码流程中监听 'oauth-device' 事件展示 userCode */
  oauthAuthorize(provider: ProviderKey): Promise<{ ok: boolean; error?: string; email?: string; accountId?: string }>

  // ---------- 备份与恢复（账户配置跨设备迁移） ----------
  listBackupTargets(): Promise<{ id: string; label: string; path: string; available: boolean }[]>
  createBackup(targetId: string, passphrase: string, includeSecrets: boolean): Promise<{ ok: boolean; error?: string; path?: string; accountCount?: number }>
  /** 打开文件选择器并返回备份文件头部信息（无需口令） */
  restoreBackupPick(): Promise<{ ok: boolean; error?: string; path?: string; meta?: { createdAt: number; accountCount: number; hasSecrets: boolean } }>
  /** 用口令解密并恢复账户 */
  restoreBackupApply(path: string, passphrase: string): Promise<{ ok: boolean; error?: string; added: string[]; skipped: string[]; failed: string[] }>

  // ---------- 文件夹与邮件 ----------
  listFolders(): Promise<Folder[]>
  getMessages(query: MessageQuery): Promise<MessagePage>
  getMessage(id: string): Promise<MessageFull | null>
  markRead(ids: string[], read: boolean): Promise<void>
  markFlagged(ids: string[], flagged: boolean): Promise<void>
  markAnswered(id: string): Promise<void>
  moveMessages(ids: string[], targetSpecial: 'trash' | 'archive'): Promise<void>
  /** 移动邮件到任意文件夹（IMAP MOVE） */
  moveToFolder(ids: string[], folderId: string): Promise<{ ok: number; failed: number }>
  deleteMessages(ids: string[]): Promise<void>
  searchMessages(q: string, limit: number): Promise<MessageSummary[]>
  getAttachment(id: string): Promise<{ filename: string; contentType: string; data: ArrayBuffer } | null>
  getInlineImage(attachmentId: string): Promise<{ data: ArrayBuffer } | null>
  saveAttachment(id: string): Promise<{ ok: boolean; path?: string }>

  // ---------- 撰写 / 发送 ----------
  sendMail(draft: ComposeDraft): Promise<SendResult>
  scheduleSend(draft: ComposeDraft, sendAt: number): Promise<{ ok: boolean; error?: string }>
  cancelScheduledSend(id: string): Promise<void>
  listScheduledSends(): Promise<ScheduledSend[]>
  saveDraft(draft: ComposeDraft): Promise<void>
  listDrafts(): Promise<ComposeDraft[]>
  deleteDraft(id: string): Promise<void>
  pickFiles(): Promise<{ path: string; name: string; size: number }[]>
  openExternal(url: string): Promise<void>

  // ---------- 设置 ----------
  getGeneralSettings(): Promise<GeneralSettings>
  setGeneralSettings(s: GeneralSettings): Promise<void>
  getNotificationSettings(): Promise<NotificationSettings>
  setNotificationSettings(s: NotificationSettings): Promise<void>
  notifyTest(): Promise<boolean>
  getAISettings(): Promise<AISettings>
  setAISettings(s: AISettings): Promise<void>
  aiProbeLocal(): Promise<{ found: boolean; baseURL: string; provider: string; models: string[] }>
  aiListModels(): Promise<{ models: string[]; error?: string }>
  /** 内置本地引擎（node-llama-cpp + Metal） */
  aiLocalStatus(): Promise<{ models: { id: string; label: string; desc: string; downloaded: boolean; sizeBytes: number; sizeText: string }[] }>
  aiLocalDownload(modelId: string): Promise<{ ok: boolean; error?: string }>
  aiLocalCancelDownload(): Promise<boolean>
  aiLocalRemove(modelId: string): Promise<{ ok: boolean; error?: string }>

  // ---------- 签名 / 模板 / 规则 ----------
  listSignatures(): Promise<Signature[]>
  saveSignature(s: Signature): Promise<void>
  deleteSignature(id: string): Promise<void>
  listTemplates(): Promise<MailTemplate[]>
  saveTemplate(t: MailTemplate): Promise<void>
  deleteTemplate(id: string): Promise<void>
  listRules(): Promise<Rule[]>
  saveRule(r: Rule): Promise<void>
  deleteRule(id: string): Promise<void>
  reorderRules(ids: string[]): Promise<void>

  // ---------- AI ----------
  aiStream(requestId: string, messages: { role: string; content: string }[]): Promise<void>
  aiCancel(requestId: string): Promise<void>
  aiClassify(messageIds: string[]): Promise<void>
  aiSummarize(messageId: string, requestId: string): Promise<void>
  aiDraftReply(messageId: string, tone: string, requestId: string): Promise<void>
  aiExtractTasks(messageId: string, requestId: string): Promise<void>
  aiAskKnowledgeBase(question: string, requestId: string): Promise<void>
  aiTagKbItem(kbItemId: string): Promise<void>

  // ---------- 知识库 ----------
  saveToKb(input: { messageId?: string; kind: KbItem['kind']; title: string; content: string; tags?: string[] }): Promise<KbItem>
  listKbItems(): Promise<KbItem[]>
  deleteKbItem(id: string): Promise<void>
  updateKbItem(id: string, patch: Partial<Pick<KbItem, 'title' | 'content' | 'tags'>>): Promise<void>

  // ---------- 智能洞察（需自配 AI） ----------
  /** 单封提炼：账单/会议 → 待办，Newsletter → 阅读清单 */
  insightExtract(messageId: string): Promise<{ ok: boolean; error?: string; created: string[] }>
  /** 每日商情：当日重点 + 主题 digest + 备忘录 + 清理建议 */
  generateDaily(force?: boolean): Promise<{ ok: boolean; error?: string; digest?: DailyDigest }>
  /** 公司洞察：时间线 + 运营策略 + 品牌可信度 + 转化指数 */
  companyInsight(domain: string): Promise<{ ok: boolean; error?: string; insight?: CompanyInsight }>
  /** 发件人域名榜（公司洞察选择器用） */
  listCompanyDomains(): Promise<{ domain: string; name: string; count: number }[]>
  listInsights(kind: InsightKind | 'all'): Promise<InsightRecord[]>
  setInsightStatus(id: string, status: 'open' | 'done'): Promise<void>
  deleteInsight(id: string): Promise<void>
  saveMemo(title: string, content: string): Promise<void>

  // ---------- 置顶 / 魔法排序 / 批量提问 ----------
  pinMessages(ids: string[], pinned: boolean): Promise<void>
  /** 魔法排序：AI 按重要性为选中邮件排序并写入 pin 顺序 */
  aiRankMessages(ids: string[]): Promise<{ ok: boolean; error?: string; ranked: RankedMessage[] }>
  /** 多选提问：AI 基于选中邮件回答问题并提炼 todo 清单 */
  aiAskBulk(ids: string[], question: string): Promise<{ ok: boolean; error?: string; answer: string; todos: BulkTodo[] }>
  /** 把一批 todo 存为清单（智能洞察 → 待办，按清单分组展示） */
  saveTodoSet(title: string, todos: BulkTodo[], messageId?: string | null): Promise<void>

  // ---------- 连接器 ----------
  listConnectorManifests(): Promise<ConnectorManifest[]>
  listConnectorInstances(): Promise<ConnectorInstance[]>
  connectConnector(manifestId: string, config: Record<string, string>): Promise<{ ok: boolean; error?: string }>
  disconnectConnector(instanceId: string): Promise<void>
  runConnectorAction(instanceId: string, actionId: string, params: Record<string, string>, messageId?: string): Promise<{ ok: boolean; error?: string; result?: unknown }>
  /** 用户自定义连接器：安装（粘贴 JSON）/ 清单 / 卸载 / 示例模板 */
  installUserConnector(jsonText: string): Promise<{ ok: boolean; error?: string; id?: string }>
  listUserConnectors(): Promise<{ id: string; name: string; error?: string }[]>
  removeUserConnector(id: string): Promise<{ ok: boolean; error?: string }>
  getUserConnectorTemplate(): Promise<string>

  // ---------- 网盘备份（WebDAV / Dropbox，存 eml 原文与附件） ----------
  listCloudDrives(): Promise<CloudDriveConfig[]>
  saveCloudDrive(cfg: CloudDriveConfig, secret: string): Promise<{ ok: boolean; error?: string }>
  removeCloudDrive(id: string): Promise<void>
  testCloudDrive(id: string): Promise<{ ok: boolean; error?: string }>
  /** what: 'eml' 单封原文 / 'attachment' 单个附件 / 'attachments' 全部附件 */
  cloudUpload(messageId: string, driveId: string, what: 'eml' | 'attachment' | 'attachments', attachmentId?: string): Promise<{ ok: boolean; error?: string; path?: string; count?: number }>
  /** 全量增量同步本地 eml 镜像到网盘 */
  cloudSyncEml(driveId: string): Promise<{ ok: boolean; error?: string; uploaded?: number; skipped?: number }>

  // ---------- Newsletter ----------
  unsubscribe(messageId: string, method: 'http' | 'mailto'): Promise<{ ok: boolean; error?: string }>
  setNewsletterSender(sender: string, subscribed: boolean): Promise<void>
  listNewsletterSenders(): Promise<{ sender: string; subscribed: boolean; count: number; latestAt: number }[]>

  // ---------- 窗口 / 应用 ----------
  openSettings(tab?: string): Promise<void>
  openCompose(prefill?: Partial<ComposeDraft>): Promise<void>
  onEvent(cb: (ev: unknown) => void): () => void
  getVersions(): Promise<{ app: string; electron: string; node: string }>
  quit(): Promise<void>

  // ---------- Agent 记忆（个人 Agent 成长系统） ----------
  listMemories(scope?: MemoryScope | 'all'): Promise<AgentMemory[]>
  saveMemory(input: { scope: MemoryScope; title: string; content: string; entity?: string }): Promise<AgentMemory>
  updateMemory(id: string, patch: Partial<Pick<AgentMemory, 'title' | 'content' | 'scope' | 'status'>>): Promise<void>
  deleteMemory(id: string): Promise<void>
  /** 记忆成长统计：总量 / 分域 / 本周新增 / 最常用 */
  memoryStats(): Promise<{ total: number; byScope: Record<string, number>; weekNew: number; topUsed: AgentMemory[] }>
  /** 让 Agent 学习一封邮件，沉淀长期记忆（发件人事实 / 偏好 / 承诺） */
  agentLearn(messageId: string): Promise<{ ok: boolean; error?: string; learned: AgentMemory[] }>
  /** 发件人画像：关系总结 + 高频主题 + 我的回复率（结果沉淀为 person 记忆） */
  agentProfile(addr: string): Promise<{ ok: boolean; error?: string; profile?: ContactProfile }>
  /** Agent 对话：基于长期记忆 + 知识库 + 近期邮件检索回答 */
  agentChat(question: string, requestId: string): Promise<void>
}
