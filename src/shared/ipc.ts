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
  /** 姓名里命中的区间（拼音联想命中时用于高亮；子串命中时不给，按输入文字高亮） */
  nameHit?: [number, number] | null
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
  onboardingScanStart(opts: { days: number; accountIds?: string[] | null; steps: ('todo' | 'finance' | 'attachments' | 'kb' | 'projects' | 'life')[] }): Promise<void>
  onboardingScanDismiss(): Promise<void>
}

// ---------- 自动任务全局设置 / 首次整理「稍后」（追加） ----------

export interface LinkToApi {
  agentJobSettings(): Promise<import('./types').AgentJobSettings>
  agentJobSetSettings(patch: Partial<import('./types').AgentJobSettings>): Promise<import('./types').AgentJobSettings>
  /** 首次整理「稍后」：本次启动不再提示，下次启动再提醒一次 */
  onboardingScanLater(): Promise<void>
}

// ---------- 事件触发 / 跟进闭环 / 附件正文（与上面的 LinkToApi 声明合并） ----------

export interface LinkToApi {
  /** 一封邮件命中的事件（阅读页展示「已识别：发票 → 已运行 xx 技能」） */
  agentEventsFor(messageId: string): Promise<{ hits: import('./types').AgentEventHit[]; runs: { skillId: string; at: number; activityId?: string | null }[] }>

  /** 跟进列表（默认进行中的） */
  followupList(opts?: { includeClosed?: boolean }): Promise<import('./types').InsightRecord[]>
  /** 手动登记一条跟进（例如对已发出的某封邮件「等对方回复，N 天后提醒我」） */
  followupCreate(input: { messageId: string; kind?: import('./types').FollowupKind; ask?: string; waitDays?: number }): Promise<string>
  followupUpdate(id: string, patch: { status?: import('./types').FollowupStatus; waitDays?: number; ask?: string; maxAttempts?: number; kind?: import('./types').FollowupKind; snoozeDays?: number }): Promise<void>
  /** 立刻为到期的跟进再起草一封催促（打开撰写窗，不发送） */
  followupNudge(id: string): Promise<{ ok: boolean; error?: string }>

  /** 附件正文（PDF 文本层 / 纯文本）；未提取过时现取并缓存 */
  readAttachmentText(attachmentId: string, maxChars?: number): Promise<{ ok: boolean; text?: string; info?: import('./types').AttachmentTextInfo; error?: string }>
  /** 已缓存的附件正文信息（有正文 / 页数 / 字数；不触发提取、不含正文）；未授权读取附件内容时为空 */
  readAttachmentTextInfo(attachmentIds: string[]): Promise<Record<string, import('./types').AttachmentTextInfo>>
}

// ---------- 规则建议 / 生活档案（与上面的 LinkToApi 声明合并） ----------

export interface LinkToApi {
  /** 当前的规则建议（status=new，按价值排序） */
  ruleSuggestions(): Promise<import('./types').RuleSuggestion[]>
  /** 接受：按（可能被用户改过的）规则创建并启用；applyExisting=true 时对现有命中邮件执行一次 */
  ruleSuggestionAccept(id: string, opts?: { rule?: Omit<import('./types').Rule, 'id' | 'order' | 'enabled'>; applyExisting?: boolean }): Promise<{ ok: boolean; ruleId?: string; applied?: number; error?: string }>
  /** 忽略：forever=true 同类（同指纹）不再建议；否则 30 天内不再提 */
  ruleSuggestionDismiss(id: string, forever?: boolean): Promise<void>
  /** 阅读停留信号：打开一封未读邮件后，几秒内切走且没有滚动 / 点击 = noRead；读了 = read（只记元数据，用于「这类邮件你通常不看」的规则建议） */
  ruleSuggestReadSignal(sig: { messageId: string; verdict: 'noRead' | 'read'; dwellMs?: number }): Promise<boolean>

  lifeList(): Promise<import('./types').InsightRecord[]>
  lifeCreate(input: { title: string; dueAt?: number | null; data: Partial<import('./types').LifeData> }): Promise<string>
  lifeUpdate(id: string, patch: { title?: string; dueAt?: number | null; status?: 'open' | 'done'; data?: Partial<import('./types').LifeData> }): Promise<void>
  lifeDelete(id: string): Promise<void>
  /** 从最近 N 天邮件里识别生活事务（进度经 'life-scan' 事件推送） */
  lifeScan(days: number): Promise<{ created: number; merged: number; scanned: number }>
  /** 导出 .ics（系统保存对话框） */
  lifeExportIcs(ids?: string[] | null): Promise<{ ok: boolean; canceled?: boolean; path?: string; count?: number; error?: string }>
}

// ---------- 生活档案（追加：生成待办 / 阅读页加入） ----------

export interface LinkToApi {
  /** 生成提醒待办（kind='todo'，dueAt = 建议办理日或到期日）；已生成过返回原待办 id */
  lifeMakeTodo(id: string): Promise<string | null>
  /** 阅读页「加入生活档案」：已收返回所在条目；否则识别（规则 → AI）后新建 */
  lifeFromMessage(messageId: string): Promise<{ id: string | null; created: boolean }>
}

// ---------- 附件内容读取授权（与上面的 LinkToApi 声明合并） ----------

export interface LinkToApi {
  contentAccessGet(): Promise<import('./types').AttachmentAccessSettings>
  contentAccessSet(patch: Partial<import('./types').AttachmentAccessSettings>): Promise<import('./types').AttachmentAccessSettings>
}

// ---------- 扫描件 / 图片识字（OCR）（与上面的 LinkToApi 声明合并） ----------

export interface LinkToApi {
  /** 本机 / AI 识字各自能不能用（按平台、AI 设置与授权） */
  ocrStatus(): Promise<import('./types').OcrAvailability>
  /** 对扫描件 / 图片附件做文字识别；engine 为空 = 用设置里的方式。进度经事件 'attachment-ocr-progress' 推送 */
  ocrAttachment(
    attachmentId: string,
    engine?: import('./types').OcrEngine | null,
    maxChars?: number
  ): Promise<{ ok: boolean; text?: string; info?: import('./types').AttachmentTextInfo; error?: string; blocked?: import('./types').AttachmentAccessBlock }>
  /** 清除已提取的附件正文缓存（PDF 文本层 / 纯文本 / 识字结果），之后按需重新提取 */
  clearAttachmentTextCache(): Promise<{ removed: number }>
}

// ---------- 导出与分享中心（与上面的 LinkToApi 声明合并） ----------

export interface LinkToApi {
  /** 全部分享目标：已配置的 IM / 工作 IM / 笔记 / 本地文件夹 + 网盘 + 内置（系统分享、微信、WhatsApp、剪贴板、导出） */
  shareTargets(): Promise<import('./share').ShareTargetInfo[]>
  /** 新建 / 更新目标；url / secret / token 留空 = 保持原值（密钥经钥匙串加密保存） */
  shareSaveTarget(input: import('./share').ShareTargetInput): Promise<{ ok: boolean; error?: string; id?: string }>
  shareRemoveTarget(id: string): Promise<void>
  /** 测试发送（Webhook / Telegram 发一条测试消息；Notion / 备忘录只检查连接与权限，不写入） */
  shareTestTarget(id: string): Promise<import('./share').ShareResult>
  shareSettings(): Promise<import('./share').ShareSettings>
  shareSetSettings(patch: Partial<import('./share').ShareSettings>): Promise<import('./share').ShareSettings>
  /** 发送前预览：将发出的文字、生成的文件名与提示 */
  sharePreview(req: import('./share').ShareRequest): Promise<import('./share').SharePreview>
  /** 发送到目标（对外发送必须带 confirmed: true，界面确认后才调用） */
  shareSend(req: import('./share').ShareRequest): Promise<import('./share').ShareResult>
  /** 导出到本地：where = ask（保存对话框）/ quick（默认导出目录）/ dir（指定目录） */
  shareExport(req: import('./share').ShareRequest): Promise<import('./share').ShareResult>
  /** 复制到剪贴板：纯文本 / 富文本（HTML + 纯文本双格式）/ 链接 / 长图 */
  shareCopy(messageIds: string[], kind: 'text' | 'rich' | 'link' | 'png'): Promise<import('./share').ShareResult>
  /** 一封邮件的链接：linkto:// 内部链接 + Gmail / Outlook 网页版备选 */
  shareLinks(messageId: string): Promise<import('./share').ShareLinks | null>
  /** 打开 linkto://open?mid=… 链接：在主窗口定位到这封邮件 */
  shareOpenLink(url: string): Promise<{ ok: boolean; error?: string; id?: string }>
}

// ---------- 订阅（RSS / Atom / JSON Feed）与 AI 搜索订阅（与上面的 LinkToApi 声明合并） ----------

export interface LinkToApi {
  feedSources(): Promise<import('./feeds').FeedSource[]>
  /** 只检查地址：是订阅 → 返回它；是网页 → 返回页面声明的订阅（没有时试常见路径） */
  feedDiscover(url: string): Promise<{ ok: boolean; isFeed?: boolean; title?: string | null; candidates: import('./feeds').FeedCandidate[]; error?: string }>
  /** 添加订阅源（网页地址自动发现；多个候选时返回 candidates 让用户选） */
  feedAddSource(input: { url: string; group?: string | null; title?: string | null; intervalMin?: number | null; fullText?: boolean }): Promise<{
    ok: boolean
    source?: import('./feeds').FeedSource
    candidates?: import('./feeds').FeedCandidate[]
    existing?: import('./feeds').FeedSource
    discovered?: boolean
    added?: number
    error?: string
  }>
  feedUpdateSource(id: string, patch: { title?: string; group?: string | null; intervalMin?: number | null; fullText?: boolean; enabled?: boolean; topic?: Partial<import('./feeds').FeedTopic> }): Promise<import('./feeds').FeedSource | null>
  feedDeleteSource(id: string): Promise<void>
  feedRenameGroup(from: string, to: string | null): Promise<void>
  /** 立即更新（不传 = 全部启用的订阅源） */
  feedRefresh(ids?: string[] | null): Promise<import('./feeds').FeedRefreshResult>
  feedItems(query: import('./feeds').FeedItemQuery): Promise<import('./feeds').FeedItem[]>
  feedItem(id: string): Promise<import('./feeds').FeedItemDetail | null>
  feedMarkRead(ids: string[], read: boolean): Promise<void>
  /** 范围内全部标已读（before：只标这之前抓到的），返回条数 */
  feedMarkAllRead(scope: import('./feeds').FeedScope, before?: number | null): Promise<number>
  feedStar(id: string, starred: boolean): Promise<void>
  /** 抓取原文并提取正文（已消毒） */
  feedFullText(id: string): Promise<{ ok: boolean; html?: string; error?: string }>
  feedSummarize(id: string, force?: boolean): Promise<{ ok: boolean; text?: string; error?: string }>
  /** 加入阅读清单（insights kind='reading'） */
  feedToReading(id: string): Promise<{ ok: boolean; id?: string; created?: boolean; error?: string }>
  feedUnreadTotal(): Promise<number>
  feedAddTopic(input: Partial<import('./feeds').FeedTopic> & { query: string; group?: string | null }): Promise<import('./feeds').FeedSource>
  feedRunTopic(id: string): Promise<import('./feeds').FeedTopicRunResult>
  feedGetSettings(): Promise<import('./feeds').FeedSettings>
  feedSetSettings(patch: Partial<import('./feeds').FeedSettings>): Promise<import('./feeds').FeedSettings>
  /** 搜索 API Key 是否已填（不回传 Key 本身） */
  feedSearchKeys(): Promise<Record<import('./feeds').SearchApiProvider, boolean>>
  feedSetSearchKey(provider: import('./feeds').SearchApiProvider, key: string | null): Promise<Record<import('./feeds').SearchApiProvider, boolean>>
  /** OPML 导入（系统打开对话框） */
  feedImportOpml(): Promise<{ ok: boolean; canceled?: boolean; added: number; skipped: number; failed: { url: string; error: string }[]; error?: string }>
  feedImportOpmlText(text: string): Promise<{ ok: boolean; added: number; skipped: number; failed: { url: string; error: string }[]; error?: string }>
  /** OPML 导出（系统保存对话框） */
  feedExportOpml(): Promise<{ ok: boolean; canceled?: boolean; path?: string; count?: number; error?: string }>
  /** 今日订阅精华（不传 day = 今天的，没有则最近一份） */
  feedDigest(day?: string | null): Promise<import('./feeds').FeedDigest | null>
  feedGenerateDigest(): Promise<{ ok: boolean; digest?: import('./feeds').FeedDigest; error?: string }>
}

// ---------- 留痕（与上面的 LinkToApi 声明合并；数据模型见 ./trace） ----------

export interface TraceUpdatePatch {
  title?: string
  channel?: import('./trace').TraceChannel
  occurredAt?: number | null
  parties?: import('./trace').TraceParty[]
  summary?: import('./trace').TraceSummary | null
  /** 追加原始材料 */
  addMaterials?: Omit<import('./trace').TraceMaterial, 'id' | 'addedAt'>[]
  /** 移除原始材料（旧内容进版本历史，可追溯） */
  removeMaterialIds?: string[]
  /** 手动改状态 */
  status?: import('./trace').TraceStatus
  /** 关联（项目 / 款项 / 邮件 / 待办） */
  link?: Partial<import('./trace').TraceLinks>
  unlink?: Partial<import('./trace').TraceLinks>
}

export interface LinkToApi {
  traceList(): Promise<import('./trace').TraceRecord[]>
  /** 新建；organize = 'ai' / 'template' 时随后整理一次（AI 不可用时退回模板） */
  traceCreate(input: import('./trace').TraceInput, opts?: { organize?: 'ai' | 'template' | null }): Promise<{ id: string; organized?: { ok: boolean; by?: 'ai' | 'template'; error?: string; warnings?: string[] } }>
  /** 内容改动会把旧内容压进版本历史并重算哈希；reason 写进历史 */
  traceUpdate(id: string, patch: TraceUpdatePatch, reason?: string): Promise<{ ok: boolean; error?: string }>
  /** 删除 = 墓碑（跨设备同步可传播），不出现在列表里 */
  traceDelete(id: string): Promise<void>
  /** 整理：ai = AI 整理（不编造；金额 / 日期必须来自材料）；template = 按模板摘录 */
  traceOrganize(id: string, mode: 'ai' | 'template'): Promise<{ ok: boolean; by?: 'ai' | 'template'; error?: string; warnings?: string[]; excluded?: number }>
  /** 截图识字（用户主动粘贴 / 拖入；仍受附件内容读取与 OCR、云端 AI 授权约束） */
  traceOcrImage(input: { dataUrl: string; name?: string | null }): Promise<{ ok: boolean; text?: string; method?: string; note?: string | null; error?: string; blocked?: import('./types').AttachmentAccessBlock }>
  /** 起草书面确认邮件（打开撰写窗，不发送）并登记跟进（kind=reply） */
  traceConfirmDraft(id: string, opts?: { to?: string[]; waitDays?: number }): Promise<{ ok: boolean; error?: string; draftId?: string; followupId?: string | null; reopened?: boolean }>
  /** 立即检查书面确认的发出 / 回信状态；返回有变化的条数 */
  traceCheckReplies(): Promise<number>
  /** 阅读页「记为留痕」：已记过返回原记录 */
  traceFromMessage(messageId: string): Promise<{ id: string | null; created: boolean }>
  /** 由约定事项生成待办（index 为空 = 整条留痕一个待办） */
  traceMakeTodo(id: string, index?: number | null): Promise<string | null>
  /** 把一条约定记进 Agent 记忆（承诺），由用户点击确认 */
  traceRemember(id: string, index: number): Promise<{ ok: boolean; id?: string; error?: string }>
  traceVerify(id: string): Promise<{ ok: boolean; hash: string; computed: string; versions: boolean[] } | null>
  /** 导出存档（系统保存对话框） */
  traceExport(id: string, format: 'md' | 'pdf'): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
  /** 发给自己一封存档邮件：打开撰写窗（收件人 = 自己），不自动发送 */
  traceArchiveMail(id: string): Promise<{ ok: boolean; error?: string }>
  /** 打开「记一笔留痕」浮层（全局快捷键 / Dock / 托盘同一入口） */
  traceOpenCapture(): Promise<void>
  /** AI 整理 / 截图识字是否可用 */
  traceCapabilities(): Promise<{ ai: boolean; aiReason?: string | null; cloud: boolean; cloudAllowed: boolean; ocr: import('./types').OcrAvailability | null }>
  traceSyncStatus(): Promise<import('./trace').TraceSyncStatus>
  traceSyncConfigure(input: { enabled: boolean }): Promise<{ ok: boolean; error?: string; status: import('./trace').TraceSyncStatus }>
  traceSyncNow(): Promise<import('./trace').TraceSyncStatus>

  // ---------- 搜索索引 / 拼音 ----------
  /** 中文搜索索引状态（存量邮件回填进度）；进度变化另以 'search-index-progress' 事件推送 */
  searchIndexStatus(): Promise<SearchIndexStatus>
  /** 文本 → 拼音键（不含汉字的返回 null）；asNames = 按人名处理姓氏多音字。匹配用 shared/pinyin-match */
  pinyinKeys(texts: string[], asNames?: boolean): Promise<(import('./pinyin-match').PinyinKey | null)[]>
}

// ---------- 升级向导 · 侧栏（与上面的 LinkToApi 声明合并；纯函数与类型见 ./upgrade） ----------

export interface LinkToApi {
  /** 升级向导状态（启动时已定下 fresh / upgrade 身份） */
  upgradeState(): Promise<import('./upgrade').UpgradeState>
  /** 完成或跳过向导：记下看过的功能版本（默认当前向导版本） */
  upgradeSetSeen(input?: { edition?: string | null; outcome?: 'done' | 'skipped' }): Promise<import('./upgrade').UpgradeState>
  /** 「稍后」：本次启动不再出现，计数 +1 */
  upgradeLater(): Promise<import('./upgrade').UpgradeState>
  /** 各侧栏入口的数据量（只读计数），用于升级用户「已经在用的入口默认钉住」 */
  sidebarUsage(): Promise<Record<'feeds' | 'life' | 'trace' | 'finance' | 'kb' | 'attachments' | 'snoozed' | 'flagged' | 'pinned', number>>
}

// ---------- 跨设备同步与备份（devsync* / backupx*；与上面的 LinkToApi 声明合并，类型见 ./devsync） ----------

export interface LinkToApi {
  devsyncStatus(): Promise<import('./devsync').DevSyncStatus>
  /** 开启 / 关闭 / 改类别；邮箱、口令、设备名与待办同步共用。开启时立即同步一轮 */
  devsyncConfigure(input: import('./devsync').DevSyncConfigureInput): Promise<{ ok: boolean; error?: string; status: import('./devsync').DevSyncStatus }>
  devsyncNow(): Promise<import('./devsync').DevSyncStatus>
  /** 生成给另一台电脑的短时配对包（含同步邮箱凭据，15 分钟有效） */
  devsyncCreatePairing(): Promise<import('./devsync').DevSyncPairingOffer>
  /** 在新电脑导入配对包：自动添加同步邮箱、写入口令并开启同步 */
  devsyncImportPairing(link: string, pin: string): Promise<import('./devsync').DevSyncPairingResult>
  /** 另一台设备删除了账户：delete = 本机也删除；keep = 本机保留 */
  devsyncResolveDelete(key: string, action: 'delete' | 'keep'): Promise<import('./devsync').DevSyncStatus>
  /** 试用另一台设备同步来的本机专用凭据（用户确认后） */
  devsyncUseCandidate(accountId: string): Promise<{ ok: boolean; error?: string }>
  /** 界面偏好（localStorage）推给主进程，参与「个性化设置」同步 */
  devsyncPushUiPrefs(data: unknown): Promise<void>
  devsyncUiPrefs(): Promise<unknown>
  backupxExport(input: { targetId: string; passphrase: string; includeSecrets: boolean; categories?: import('./devsync').DevSyncCategory[] }): Promise<{ ok: boolean; error?: string; path?: string; counts?: Partial<Record<import('./devsync').DevSyncCategory, number>> }>
  backupxPick(): Promise<{ ok: boolean; error?: string; path?: string; header?: import('./devsync').BackupxHeader }>
  backupxInspect(path: string, passphrase: string): Promise<{ ok: boolean; error?: string; header?: import('./devsync').BackupxHeader; counts?: Partial<Record<import('./devsync').DevSyncCategory, number>>; hasSecrets?: boolean }>
  backupxRestore(path: string, passphrase: string, opts: { categories?: import('./devsync').DevSyncCategory[]; strategy?: 'merge' | 'overwrite' }): Promise<import('./devsync').BackupxRestoreResult>
  backupxAutoGet(): Promise<import('./devsync').BackupxAutoSettings>
  backupxAutoSet(input: Partial<import('./devsync').BackupxAutoSettings> & { passphrase?: string; pickDir?: boolean }): Promise<{ ok: boolean; error?: string; settings: import('./devsync').BackupxAutoSettings }>
  backupxAutoRun(): Promise<{ ok: boolean; error?: string; path?: string; removed?: number }>
}

/** 中文搜索索引状态 */
export interface SearchIndexStatus {
  enabled: boolean
  /** 已建索引的邮件数 */
  indexed: number
  total: number
  /** 存量邮件回填中（期间未入索引的邮件走慢速兜底，结果仍完整） */
  building: boolean
}

