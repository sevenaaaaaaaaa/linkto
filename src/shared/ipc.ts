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
  AgentAction,
  MailInsight,
  FolderPref,
  TodayBrief,
  TodoProvider,
  TodoIntegrationStatus,
  TodoIntegrationConfig,
  TodoSyncDirection,
  CalendarBusyBlock
} from './types'
import type {
  ArchiveJobStatus,
  ArchivePreview,
  ArchiveSuggestion,
  AttachmentCategory,
  AttachmentCloudCopy,
  AttachmentItem,
  AttachmentQuery,
  AttachmentSettings,
  AttachmentStats,
  ReleasePlan
} from './attachments'

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
  listBackupTargets(): Promise<{ id: string; label: string; path: string; available: boolean; hint?: string; downloadUrl?: string }[]>
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
  /** 收件人联想：按「我发过的 > 往来频次 > 最近」排序，子串匹配姓名 / 地址（不含本机账户地址） */
  suggestRecipients(query: string, limit?: number): Promise<RecipientSuggestion[]>
  /** 撰写窗 AI（要点成文 / 改写 / 起主题）：结果以 'ai-stream' 事件只推给发起请求的窗口 */
  aiComposeAssist(requestId: string, input: ComposeAssistInput): Promise<void>
  /** 拖入窗口的文件 → 本地路径（webUtils.getPathForFile；非本地文件返回空串） */
  pathForFile(file: File): string
  openExternal(url: string): Promise<void>

  // ---------- 设置 ----------
  getGeneralSettings(): Promise<GeneralSettings>
  setGeneralSettings(s: GeneralSettings): Promise<void>
  getNotificationSettings(): Promise<NotificationSettings>
  setNotificationSettings(s: NotificationSettings): Promise<void>
  notifyTest(): Promise<boolean>
  /** 发送测试通知并返回投递结果：native = 系统通知；applescript = 系统通知失败后的兜底；none = 都失败 */
  notifyTestResult(): Promise<{ ok: boolean; via: 'native' | 'applescript' | 'none'; error?: string }>
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
  /** 待办（GTD）：新建 / 局部更新（data 合并，存时长、优先级、排布结果等） */
  createTodo(input: { title: string; dueAt?: number | null; data?: Record<string, unknown> }): Promise<string>
  updateTodo(id: string, patch: { title?: string; dueAt?: number | null; status?: 'open' | 'done' | 'dismissed'; data?: Record<string, unknown> }): Promise<void>
  /** AI 估时长 / 定优先级 / 给理由（排布本身在渲染层确定性完成） */
  /** 邮件转待办（用邮件理解的建议 / 截止）；已存在则返回原 id */
  todoFromMessage(messageId: string): Promise<string | null>
  aiPlanTodos(ids: string[]): Promise<{ ok: boolean; error?: string; plans: { id: string; minutes: number; priority: 1 | 2 | 3; reason: string }[] }>
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
  /** 选择本地目录（本地同步目录类网盘用），取消返回 null */
  pickDirectory(title?: string): Promise<string | null>
  /** 检测本机 Proton Drive 同步目录（可能多账户），附带客户端下载地址 */
  detectProtonDrive(): Promise<{ folders: { path: string; account: string }[]; downloadUrl: string }>

  // ---------- 附件中心（索引 / 分类 / 本地缓存策略 / 网盘归档） ----------
  /** 浏览附件索引（含尚未下载、只有元数据的附件） */
  attachList(query: AttachmentQuery): Promise<{ items: AttachmentItem[]; total: number }>
  /** 本地占用统计（按分类 / 账户 / 年份 / 对方）、最大文件、重复文件 */
  attachStats(): Promise<AttachmentStats>
  /** 立即增量扫描一次（新附件入索引、算哈希、AI 补充分类） */
  attachRescan(): Promise<AttachmentStats>
  /** 按附件 id 取状态（阅读窗附件卡：已在哪些网盘 / 是否已释放） */
  attachStatus(ids: string[]): Promise<Record<string, { cached: boolean; releasedAt: number | null; cloud: AttachmentCloudCopy[]; category: AttachmentCategory; pinned: boolean }>>
  attachGetSettings(): Promise<AttachmentSettings>
  attachSetSettings(patch: Partial<AttachmentSettings>): Promise<AttachmentSettings>
  attachSetCategory(ids: string[], category: AttachmentCategory): Promise<void>
  attachPin(ids: string[], pinned: boolean): Promise<void>
  /** 释放清单：不传 ids = 按策略建议；传 ids = 手动选择（同样过安全判定） */
  attachReleasePlan(ids?: string[] | null): Promise<ReleasePlan>
  /** 执行释放（逐个重新做安全判定，只删 LinkTo 附件缓存目录里的文件） */
  attachRelease(ids: string[]): Promise<{ released: number; bytes: number; skipped: { id: string; filename: string; reason: string }[] }>
  /** 确保附件在本地（释放 / 未下载的：eml 镜像 → IMAP → 网盘副本） */
  attachEnsureLocal(id: string): Promise<{ ok: boolean; id?: string; error?: string; via?: 'cache' | 'eml' | 'imap' | 'cloud' }>
  /** 整理建议：近 N 天未归档的附件与可释放空间、可用的归档目标 */
  attachSuggest(windowDays?: number): Promise<ArchiveSuggestion>
  /** 归档预览：目标目录结构与每个附件的动作；template 不传用设置里的模板 */
  attachArchivePreview(driveId: string, ids: string[], template?: string): Promise<ArchivePreview>
  /** 开始归档（后台队列；进度通过 { type: 'attachments-job', status } 事件推送） */
  attachArchiveStart(driveId: string, ids: string[]): Promise<ArchiveJobStatus | null>
  attachArchiveControl(action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<ArchiveJobStatus | null>
  attachArchiveStatus(): Promise<ArchiveJobStatus | null>
  /** 在 Finder 中显示网盘副本（本地同步目录）或打开云端网页位置 */
  attachReveal(id: string, driveId?: string): Promise<{ ok: boolean; error?: string }>
  /** 用系统默认应用打开（需要时先重新下载） */
  attachOpen(id: string): Promise<{ ok: boolean; error?: string }>
  /** 多选保存到本地目录 */
  attachSaveMany(ids: string[]): Promise<{ ok: boolean; count: number; dir?: string; failed: number; error?: string }>
  /** 图片缩略图（data URL） */
  attachThumbs(ids: string[]): Promise<Record<string, string>>
  /** 一键添加 Proton Drive（检测同步目录，复用网盘保存流程）；未安装时返回下载地址 */
  attachAddProton(): Promise<{ ok: boolean; error?: string; downloadUrl: string; driveId?: string }>

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
  /** 联网状态（主进程 net.isOnline）+ 断网期间暂存、待联网后同步的操作数 */
  connectivity(): Promise<{ online: boolean; pendingOps: number }>

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

  // ---------- 邮件理解（每封一次理解，列表 / 阅读页 / 简报 / Agent 共用） ----------
  /** 批量取邮件理解结果（缺失的立即用启发式补齐并返回；AI 结果异步到达后发 'mail-insights' 事件） */
  getMailInsights(ids: string[]): Promise<Record<string, MailInsight>>
  /** 立即对一封邮件跑 AI 理解（用户打开邮件时调用；AI 未就绪则返回启发式结果） */
  understandMessage(id: string, force?: boolean): Promise<MailInsight | null>
  todayBrief(accountId?: string | null): Promise<TodayBrief>
  getFolderPrefs(): Promise<Record<string, FolderPref>>
  setFolderPref(folderId: string, patch: Partial<FolderPref>): Promise<void>
  /** 移动建议：同一发件人历史邮件最常在的非收件箱文件夹 */
  suggestMoveTarget(messageId: string): Promise<{ folderId: string; reason: string } | null>
  /** 发件人上下文（右侧栏）：往来统计、Agent 记忆、你答应过的事、相关知识库条目 */
  senderContext(messageId: string): Promise<{ addr: string; name: string; total: number; lastAt: number | null; sentByMe: number; memories: string[]; promises: string[]; related: { id: string; title: string; kind: 'kb' | 'message' }[] } | null>

  // ---------- MCP 服务（外部 AI Agent 访问本地邮件） ----------
  getMcpStatus(): Promise<{ enabled: boolean; port: number; running: boolean; url: string; token: string; error?: string }>
  /** 开关本地 MCP 服务；首次开启自动生成 token */
  setMcpEnabled(enabled: boolean, port?: number): Promise<{ enabled: boolean; port: number; running: boolean; url: string; token: string; error?: string }>
  /** 重新生成 token（旧 token 立即失效） */
  regenerateMcpToken(): Promise<{ enabled: boolean; port: number; running: boolean; url: string; token: string; error?: string }>

  // ---------- 待办跨设备同步（经自己邮箱的隐藏文件夹 LinkTo-Sync） ----------
  todoSyncStatus(): Promise<TodoSyncStatus>
  /** 保存设置；开启时立即同步一轮，口令不对等错误在 error 中返回 */
  todoSyncConfigure(input: { enabled: boolean; accountId: string | null; passphrase?: string; encrypt?: boolean; deviceName?: string }): Promise<{ ok: boolean; error?: string; status: TodoSyncStatus }>
  todoSyncNow(): Promise<TodoSyncStatus>
  // ---------- 待办与日历同步（Apple 提醒事项 / 日历、Google Tasks / Calendar、Microsoft To Do / Outlook 日历） ----------
  /** 各服务的可用性、授权与同步状态 */
  todoIntegrationsStatus(): Promise<TodoIntegrationStatus[]>
  /** 列出可选的目标清单 / 日历（Google / Microsoft 需传账户） */
  todoIntegrationListTargets(provider: TodoProvider, accountId?: string | null): Promise<{ ok: boolean; error?: string; targets: { id: string; name: string }[] }>
  /** 连接：Apple 检查自动化权限；Google / Microsoft 对所选账户做增量授权（微软设备码通过 'oauth-device' 事件推送） */
  todoIntegrationConnect(
    provider: TodoProvider,
    opts?: { accountId?: string | null; listId?: string | null; listName?: string | null; direction?: TodoSyncDirection }
  ): Promise<{ ok: boolean; error?: string }>
  todoIntegrationUpdate(provider: TodoProvider, patch: Partial<TodoIntegrationConfig>): Promise<TodoIntegrationStatus[]>
  /** 立即同步（不传 = 全部已启用的服务） */
  todoIntegrationSyncNow(provider?: TodoProvider | null): Promise<{ ok: boolean; error?: string }>
  /** 断开：停用并清除该服务的额外授权；已同步的待办保留 */
  todoIntegrationDisconnect(provider: TodoProvider): Promise<TodoIntegrationStatus[]>
  /** 已启用「忙碌时段」的日历在 [from, to) 内的日程（排程避让用） */
  calendarBusyBlocks(from: number, to: number): Promise<CalendarBusyBlock[]>
}

/** 待办同步状态（设置 + 运行态）；进度变化时主进程广播 { type: 'todo-sync-status', status } */
export interface TodoSyncStatus {
  enabled: boolean
  accountId: string | null
  encrypt: boolean
  lastSyncAt: number | null
  lastError: string | null
  deviceName: string
  hasPassphrase: boolean
  running: boolean
  folder: string
  lastStats: { pulled: number; pushed: number; removed: number; at: number } | null
}

/** 收件人联想条目 */
export interface RecipientSuggestion {
  name: string
  address: string
  /** 我发给 TA 的次数（已发送文件夹） */
  sentByMe: number
  /** 往来总次数 */
  total: number
  lastAt: number
}

/** 撰写窗 AI 改写风格 */
export type ComposeRewriteStyle = 'polish' | 'formal' | 'concise' | 'friendly' | 'en' | 'zh'

/** 撰写窗 AI 请求 */
export interface ComposeAssistInput {
  /** points：用要点写完整邮件；rewrite：改写选中文字或全文；subject：根据正文起主题 */
  task: 'points' | 'rewrite' | 'subject'
  /** points 为要点；rewrite 为待改写文本；subject 为正文 */
  text: string
  style?: ComposeRewriteStyle
  subject?: string
  /** 收件人显示名（或地址） */
  recipients?: string[]
  /** 发件人名字（用于语气 / 自称） */
  fromName?: string
  /** 正在回复 / 转发的原邮件（作为上下文） */
  relatedMessageId?: string
}

// ---------- 项目 / 时间线（与上面的 LinkToApi 声明合并；实现见 src/main/projects/ipc.ts） ----------

export interface LinkToApi {
  /** 全部项目 + 统计（最近动态 / 未读 / 待办 / 款项合计 / 附件数） */
  listProjects(): Promise<import('./projects').ProjectListItem[]>
  /** 项目详情：会话、待办、款项、附件、规则版摘要 */
  getProject(id: string): Promise<import('./projects').ProjectDetail | null>
  /** 新建（不传 id）或局部更新；改名会同步待办里的项目名；改了对方 / 关键词会回扫已有邮件 */
  saveProject(input: { id?: string | null; data: Partial<import('./types').ProjectData> }): Promise<import('./projects').ProjectRecord>
  deleteProject(id: string): Promise<void>
  /** 从一封邮件 / 它所在的会话建项目（带入对方域名、成员、关键词、会话） */
  projectFromMessage(messageId: string): Promise<import('./projects').ProjectRecord | null>
  /** 把邮件（连同所在会话）加入项目 */
  projectAddMessages(projectId: string, messageIds: string[]): Promise<import('./projects').ProjectRecord | null>
  /** 把邮件所在会话移出项目，之后不再自动归入 */
  projectRemoveMessages(projectId: string, messageIds: string[]): Promise<import('./projects').ProjectRecord | null>
  /** 「建议归入」一键确认 / 忽略 */
  projectResolveSuggestion(projectId: string, threadId: string, accept: boolean): Promise<import('./projects').ProjectRecord | null>
  /** 按项目的对方 / 关键词回扫已有邮件 */
  projectRescan(projectId: string): Promise<{ added: number; suggested: number }>
  /** 项目时间线：邮件 / 附件 / 待办 / 款项 / 里程碑 */
  projectTimeline(projectId: string): Promise<import('./projects').TimelineEvent[]>
  /** 与某个联系人（邮箱地址）或公司（域名）的全部往来时间线 */
  contactTimeline(key: string): Promise<import('./projects').ContactTimeline | null>
  /** AI 项目摘要（进展 / 卡点 / 下一步 + 来源邮件）；AI 未配置时返回规则版 */
  projectSummarize(projectId: string): Promise<{ ok: boolean; error?: string; summary: import('./types').ProjectSummary | null }>
  /** 从最近 N 天的企业往来里发现候选项目（AI 已配置用 AI 聚类，否则按对方聚类） */
  discoverProjects(days?: number): Promise<{ ok: boolean; error?: string; source: 'ai' | 'heuristic'; candidates: import('./projects').ProjectCandidate[] }>
}

// ---------- 财务中心（账单 / 订阅 / 电商订单 / 企业对账）：insights kind='finance' ----------

/** 财务列表：全部未删除的款项 + 「可能闲置」的订阅 id */
export interface FinanceListResult {
  records: InsightRecord[]
  idle: string[]
}

/** 手动新增款项 */
export interface FinanceInput {
  title?: string
  dueAt?: number | null
  accountId?: string | null
  messageId?: string | null
  data?: Partial<import('./types').FinanceData>
}

export interface FinanceScanResult {
  ok: boolean
  error?: string
  scanned: number
  created: number
  merged: number
}

/** 款项详情里的关联邮件摘要 */
export interface FinanceMessageRef {
  id: string
  subject: string
  from: string
  date: number
  accountId: string
  seen: boolean
}

/**
 * 财务中心 API（与上方 LinkToApi 声明合并）。
 * 事件：'finance-changed'（款项变化）、'finance-scan'（{ done, total, created, merged, finished, error? } 回填进度）、
 * 'open-finance'（{ id }，提醒通知点击后打开某笔款项）。
 */
export interface LinkToApi {
  financeList(): Promise<FinanceListResult>
  financeCreate(input: FinanceInput): Promise<string>
  financeUpdate(id: string, patch: { title?: string; dueAt?: number | null; data?: Partial<import('./types').FinanceData> }): Promise<void>
  /** 删除（自动收集来的记为墓碑，关联邮件不再被收集） */
  financeDelete(id: string): Promise<void>
  /** 标记已付 / 撤销；订阅标记已付 = 本期已续费并顺延到下一期 */
  financeMarkPaid(id: string, paid: boolean): Promise<void>
  /** 生成提醒待办（已生成则返回原待办 id） */
  financeMakeTodo(id: string): Promise<string | null>
  /** 邮件阅读页「加入财务」：已在某笔款项里则返回它 */
  financeFromMessage(messageId: string): Promise<{ id: string | null; created: boolean }>
  financeMessages(ids: string[]): Promise<FinanceMessageRef[]>
  /** 手动配对（发票 / 付款 / 回单 → 同一 matchId，之后自动对账不再改动） */
  financePair(ids: string[]): Promise<string | null>
  /** 拆开配对 */
  financeUnpair(ids: string[]): Promise<void>
  /** 扫描最近 N 天邮件回填（进度经 'finance-scan' 事件） */
  financeScan(days: number): Promise<FinanceScanResult>
  /** 导出 CSV（系统保存对话框）：按对方 / 期间 / 指定 id 过滤 */
  financeExportCsv(opts: { counterparty?: string | null; from?: number | null; to?: number | null; ids?: string[] | null; name?: string | null }): Promise<{ ok: boolean; canceled?: boolean; path?: string; count?: number; error?: string }>
}

// ---------- Agent 运行时 / 技能 / 自动任务（与上面的 LinkToApi 声明合并） ----------

export interface LinkToApi {
  /** 发起一次运行：步骤经 'agent-step' 事件推送（{ runId, threadId, step }）；skillId 给出时按技能说明与参数执行 */
  agentRun(input: {
    runId: string
    threadId?: string | null
    text: string
    skillId?: string | null
    params?: Record<string, string | number>
    context?: { messageId?: string | null; projectId?: string | null }
  }): Promise<{ ok: boolean; threadId: string; error?: string }>
  /** 确认 / 拒绝一个等待中的写操作；remember=true 时本对话内同类工具不再询问 */
  agentApprove(runId: string, callId: string, approve: boolean, remember?: boolean): Promise<void>
  agentCancel(runId: string): Promise<void>
  agentTools(): Promise<import('./types').AgentToolInfo[]>
  agentThreads(): Promise<import('./types').AgentThreadSummary[]>
  agentThread(id: string): Promise<import('./types').AgentThread | null>
  agentDeleteThread(id: string): Promise<void>

  agentSkills(): Promise<import('./types').AgentSkill[]>
  /** 新建 / 更新自定义技能，或修改内置技能的 pinned / schedule / autoApprove */
  agentSaveSkill(skill: import('./types').AgentSkill): Promise<import('./types').AgentSkill>
  agentDeleteSkill(id: string): Promise<void>

  agentJobs(): Promise<import('./types').AgentJobInfo[]>
  agentJobSet(id: string, patch: { enabled?: boolean }): Promise<import('./types').AgentJobInfo[]>
  agentJobRunNow(id: string): Promise<{ ok: boolean; result?: string; error?: string }>
  agentActivity(limit?: number): Promise<import('./types').AgentActivity[]>

  onboardingScanStatus(): Promise<import('./types').OnboardingScanStatus>
  /** 开始首次整理：days 天内的邮件，按勾选的步骤依次跑（进度经 'onboarding-scan' 事件推送） */
  onboardingScanStart(opts: { days: number; accountIds?: string[] | null; steps: ('todo' | 'finance' | 'attachments' | 'kb' | 'projects')[] }): Promise<void>
  onboardingScanDismiss(): Promise<void>
}
