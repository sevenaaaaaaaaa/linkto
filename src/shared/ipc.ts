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
  GhostItem,
  GhostSendDraft,
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
  ProviderKey,
  SmartView,
  NLQuery,
  FollowupJudgement,
  AgentAction
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
  restoreBackupApply(path: string, passphrase: string): Promise<{ ok: boolean; error?: string; added: string[]; skipped: string[]; failed: string[]; pending?: string[] }>

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

  // ---------- 收件箱纪律 ----------
  snoozeMessages(ids: string[], until: number | null): Promise<void>
  setSenderStatus(addr: string, status: 'allow' | 'deny' | 'pending', reason?: string): Promise<void>
  screenerPendingCount(): Promise<number>
  aiScreenSuggest(addr: string): Promise<{ ok: boolean; error?: string; verdict: 'allow' | 'deny'; reason: string }>
  getSplitSignals(): Promise<{ known: string[] }>
  listSmartViews(): Promise<SmartView[]>
  saveSmartView(id: string, name: string, view: SmartView['view']): Promise<void>
  deleteSmartView(id: string): Promise<void>

  // ---------- AI 纪律解法 ----------
  /** 自然语言问句 → 结构化邮件查询 */
  aiComposeQuery(question: string): Promise<{ ok: boolean; error?: string; query: NLQuery }>
  /** Snooze AI 建议：读邮件内容推荐合适时刻 */
  aiSnoozeSuggest(messageId: string): Promise<{ ok: boolean; error?: string; at: number; reason: string }>
  /** 待跟进批量判断：哪些真的需要催 */
  aiJudgeFollowups(ids: string[]): Promise<{ ok: boolean; error?: string; judgements: FollowupJudgement[] }>
  /** 待跟进催促信草稿 */
  aiFollowupDraft(messageId: string): Promise<{ ok: boolean; error?: string; subject: string; body: string }>
  /** Screener 批量 AI 审批：逐个给建议并可一键全部采纳 */
  aiScreenBatch(addrs: string[]): Promise<{ ok: boolean; error?: string; verdicts: { addr: string; verdict: 'allow' | 'deny'; reason: string }[] }>
  /** 执行 AI 编译出的结构化查询 */
  nlSearch(q: NLQuery): Promise<MessagePage>

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
  /** 执行 Agent 建议并经用户确认的动作；返回成功数与失败明细 */
  agentExecuteActions(actions: AgentAction[]): Promise<{ ok: number; failed: { index: number; error: string }[] }>
  /** AI 是否可用（未配置时 UI 置灰并引导去设置） */
  aiStatus(): Promise<{ ready: boolean; reason?: string }>

  // ---------- 幽灵信（端到端加密 · 阅后即焚） ----------
  /** 本机幽灵身份（公钥即幽灵 ID + 短指纹），首次调用自动生成并入钥匙串 */
  ghostIdentity(): Promise<{ ghostId: string; fingerprint: string }>
  ghostList(): Promise<GhostItem[]>
  /** 扫描全部账户的 .lkghost 附件：落信箱 + 永久焚毁信道（服务器与本地原始邮件） */
  ghostReceiveScan(): Promise<{ imported: number; burned: number; pending: number; error?: string }>
  /** 封装并以 .lkghost 附件投递（主题/正文全空，传输层不含内容） */
  ghostSend(draft: GhostSendDraft): Promise<{ ok: boolean; error?: string }>
  /** 双因子开信（本机私钥 + 口令）：成功即焚毁信封，明文仅驻内存 → 二次打开永久失败 */
  ghostOpen(id: string, password: string): Promise<{ ok: boolean; error?: string; body?: string }>
  /** 拒收（未读焚毁）：直接销毁密文 */
  ghostBurn(id: string): Promise<{ ok: boolean; error?: string }>
  /** 匿名中继地址（伪装 HTTPS 笔记同步 API；空=未配置） */
  ghostRelayUrl(): Promise<string>
  ghostRelaySetUrl(url: string): Promise<void>
  /** 打开幽灵信箱窗口 */
  openGhost(): Promise<void>
  /** 在防截屏焚毁阅读窗中打开一封信（口令在阅读窗内输入） */
  openGhostReader(id: string): Promise<void>

  // ---------- MCP 服务（外部 AI Agent 访问本地邮件） ----------
  getMcpStatus(): Promise<{ enabled: boolean; port: number; running: boolean; url: string; token: string; error?: string }>
  /** 开关本地 MCP 服务；首次开启自动生成 token */
  setMcpEnabled(enabled: boolean, port?: number): Promise<{ enabled: boolean; port: number; running: boolean; url: string; token: string; error?: string }>
  /** 重新生成 token（旧 token 立即失效） */
  regenerateMcpToken(): Promise<{ enabled: boolean; port: number; running: boolean; url: string; token: string; error?: string }>
}
