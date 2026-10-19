import { app, BrowserWindow, Menu, powerMonitor, shell } from 'electron'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AppStore, DEFAULT_GENERAL, DEFAULT_NOTIFICATIONS } from './store'
import { MailStore } from './db'
import { SyncEngine, friendlyError } from './mail/sync-engine'
import { MailSender } from './mail/sender'
import { Outbox } from './mail/outbox'
import { AIService, aiReady } from './ai/service'
import { evalAiRules, hasAiCondition } from './rules/engine'
import { createCleanupRunner } from './mail/cleanup'
import { startTodoReminders } from './todo-reminders'
import { collectTodoFromInsight, collectMeetingTodo } from './todo-collect'
import { RULE_AI_JUDGE } from './ai/prompts'
import type { MailBundle, MailSection, RuleAction } from '@shared/types'
import { LocalEngine } from './ai/local-engine'
import { InsightsService } from './ai/insights'
import { AgentService } from './ai/agent'
import { UnderstandService } from './ai/understand'
import { readFolderPrefs } from './mail/folder-prefs'
import { OAuthService } from './oauth'
import { BackupService } from './backup'
import { GhostService } from './ghost/service'
import { Notifier } from './notify'
import { initNativeIntegration, setTrayUnread, applyLoginItem } from './native-integration'
import { registerIpc, type AppContext } from './ipc'
import { McpService } from './mcp/server'
import { TodoSyncService, notifyLocalChange } from './todo-sync'
import { notifyLocalChange as notifyIntegrationChange } from './todo-integrations'
import { DEFAULT_AI } from './store'
import { classifyAccountError } from '@shared/errors'
import { initAttachments, attachmentService } from './attachments'
import { ProjectService } from './projects/service'
import { registerProjectIpc } from './projects/ipc'
import { FinanceService } from './finance/service'
import { registerFinanceIpc } from './finance/ipc'
import { startFinanceReminders } from './finance/reminders'
import { AgentRuntime } from './agent/runtime'
import { registerAgentIpc } from './agent/ipc'
import { initJobs } from './jobs'
import { AiBudget } from './jobs/budget'
import { initFollowups, followupService } from './followups'
import { initRuleSuggest } from './rule-suggest'
import { initLife, lifeService } from './life'
import { initShare, listenAppLinks } from './share'
import { initFeeds } from './feeds'
import { initTrace, traceOnArrival, stopTrace, openTraceCapture } from './trace'
import { registerUpgradeIpc } from './upgrade'

// 兜底：邮件客户端常驻大量后台 socket，第三方库（如 ImapFlow）会异步 emit error，
// 任何漏网异常只记日志，不允许直接击穿主进程弹崩溃框
process.on('uncaughtException', err => {
  console.error('[main] uncaughtException:', err)
})
process.on('unhandledRejection', reason => {
  console.error('[main] unhandledRejection:', reason)
})

let appStore: AppStore
let mailStore: MailStore
let engine: SyncEngine
let classifyMessages: ((ids: string[]) => Promise<void>) | null = null
let runRuleActions: ((messageId: string, actions: RuleAction[]) => Promise<void>) | null = null

/** 新邮件到达：执行普通规则的副作用动作，再按需让 AI 判断含自然语言条件的规则 */
async function handleArrival(accountId: string, messageId: string, ruleActions: RuleAction[]) {
  await applyArrivalActions(messageId, ruleActions)
  const rules = mailStore.listRules().filter(r => r.enabled && hasAiCondition(r))
  const ai = appStore.getAI()
  if (!rules.length || !aiReady(ai)) return
  let row = mailStore.getMessageRow(messageId)
  if (!row) return
  // AI 判断要看正文：未预取的先拉一次
  if (!row.body_fetched) {
    await engine.getWorker(accountId)?.downloadBody(row.folder_path, row.uid).catch(() => {})
    row = mailStore.getMessageRow(messageId) ?? row
  }
  const mail = `发件人：${row.from_name ?? ''} <${row.from_addr ?? ''}>\n主题：${row.subject ?? ''}\n正文：${String(row.text || row.snippet || '').slice(0, 3000)}`
  const actions = await evalAiRules(
    rules,
    {
      from: row.from_addr ?? '',
      to: (() => { try { return (JSON.parse(row.to_json || '[]') as { address: string }[]).map(a => a.address).join(',') } catch { return '' } })(),
      subject: row.subject ?? '',
      listId: row.list_id ?? null,
      isNewsletter: !!row.is_newsletter,
      hasAttachment: !!row.has_attachments,
      snippet: row.snippet ?? ''
    },
    async criteria => {
      const answer = await aiService.complete([
        { role: 'system', content: RULE_AI_JUDGE },
        { role: 'user', content: `条件：${criteria}\n\n邮件：\n${mail}` }
      ])
      return /"match"\s*:\s*true/i.test(answer)
    }
  )
  await applyArrivalActions(messageId, actions)
}

async function applyArrivalActions(messageId: string, actions: RuleAction[]) {
  if (!actions.length) return
  if (actions.some(a => a.type === 'notify')) {
    const row = mailStore.getMessageRow(messageId)
    if (row) {
      notifier.notify(
        { accountId: row.account_id, messageId, subject: row.subject ?? '', from: row.from_name || row.from_addr || '', category: row.category ?? 'personal' },
        0,
        true
      )
    }
  }
  await runRuleActions?.(messageId, actions)
}
const autoClassifyQueue: string[] = []
let autoClassifyTimer: NodeJS.Timeout | null = null

function queueAutoClassify(messageId: string) {
  autoClassifyQueue.push(messageId)
  scheduleAutoClassify()
}

function scheduleAutoClassify() {
  if (autoClassifyTimer || !autoClassifyQueue.length) return
  autoClassifyTimer = setTimeout(() => {
    autoClassifyTimer = null
    const batch = autoClassifyQueue.splice(0, 30)
    scheduleAutoClassify()
    void classifyMessages?.(batch)
      .then(() => broadcast({ type: 'messages-changed' }))
      .catch(err => console.error('[auto-classify]', err))
  }, 3000)
}
let sender: MailSender
let localEngine: LocalEngine
let aiService: AIService
let notifier: Notifier
let outbox: Outbox
let insights: InsightsService
let agent: AgentService
let understand: UnderstandService
let oauth: OAuthService
let backupService: BackupService
let ghost: GhostService
let mcp: McpService | null = null
let todoSync: TodoSyncService | null = null
let projects: ProjectService | null = null
let finance: FinanceService | null = null
let jobs: ReturnType<typeof initJobs> | null = null
let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
const composeWindows = new Set<BrowserWindow>()

const statuses = new Map<string, { status: 'connected' | 'syncing' | 'error' | 'disabled'; text: string }>()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
  // 导出与分享：linkto:// 内部链接（open-url / 二次启动参数）定位邮件
  listenAppLinks()
}

function broadcast(payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('event', payload)
  }
  // 已读 / 删除 / 移动 / snooze 等本地操作都会广播 messages-changed：
  // 统一在此刷新 Dock 角标与托盘未读数（之前只在同步引擎回调里刷新，标已读后角标要等下一轮同步）
  const type = (payload as { type?: string } | null)?.type
  if (type === 'messages-changed' || type === 'new-mail') scheduleBadgeUpdate()
}

let badgeTimer: NodeJS.Timeout | null = null
function scheduleBadgeUpdate() {
  if (badgeTimer) return
  badgeTimer = setTimeout(() => {
    badgeTimer = null
    try {
      updateDockBadge()
    } catch (err) {
      console.error('[badge]', err)
    }
  }, 250)
}

/** 点击通知：显示（必要时重建）主窗口；带 messageId 时在主窗口打开该邮件 */
function focusMainForNotification(messageId?: string) {
  let win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const fresh = !win
  if (!win) {
    createMainWindow()
    win = mainWindow
  }
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  app.focus({ steal: true })
  if (!messageId) return
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send('event', { type: 'open-message', messageId })
  }
  if (fresh || win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(send, 800))
  else send()
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#F4F5F7',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })
  mainWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/mail' })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function createSettingsWindow(tab?: string) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    if (tab) settingsWindow.webContents.send('event', { type: 'settings-navigate', tab })
    return
  }
  settingsWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 820,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#F4F5F7',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  settingsWindow.loadFile(join(__dirname, '../renderer/settings.html'), {
    hash: tab ? `/${tab}` : '/general'
  })
  settingsWindow.once('ready-to-show', () => settingsWindow?.show())
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

function createComposeWindow(prefill?: Record<string, unknown>) {
  const win = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 560,
    minHeight: 460,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#F4F5F7',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const query = prefill ? `?prefill=${encodeURIComponent(JSON.stringify(prefill))}` : ''
  win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/compose${query}` })
  win.once('ready-to-show', () => win.show())
  composeWindows.add(win)
  win.on('closed', () => composeWindows.delete(win))
}

let ghostWindow: BrowserWindow | null = null

/** 幽灵信箱窗口（写信/收信管理；此窗可复制自己的幽灵 ID，不做防截屏） */
function createGhostWindow() {
  if (ghostWindow && !ghostWindow.isDestroyed()) {
    ghostWindow.show()
    ghostWindow.focus()
    return
  }
  ghostWindow = new BrowserWindow({
    width: 880,
    height: 660,
    minWidth: 640,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#F4F5F7',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  ghostWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/ghost' })
  ghostWindow.once('ready-to-show', () => ghostWindow?.show())
  ghostWindow.on('closed', () => {
    ghostWindow = null
  })
}

let ghostReaderWindow: BrowserWindow | null = null

/** 焚毁阅读窗：防截屏/录屏（系统级捕获窗口内容为黑），复制/选中在页面层禁用 */
function createGhostReaderWindow(id: string) {
  if (ghostReaderWindow && !ghostReaderWindow.isDestroyed()) ghostReaderWindow.close()
  ghostReaderWindow = new BrowserWindow({
    width: 640,
    height: 600,
    minWidth: 480,
    minHeight: 420,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#0d1f1e',
    show: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  ghostReaderWindow.loadFile(join(__dirname, '../renderer/index.html'), {
    hash: `/ghostread?id=${encodeURIComponent(id)}`
  })
  // 兜底：任何情况下确保阅读窗可见（阅后即焚窗必须所见即所得）
  ghostReaderWindow.once('ready-to-show', () => ghostReaderWindow?.show())
  ghostReaderWindow.webContents.once('did-finish-load', () => ghostReaderWindow?.showInactive())
  // 系统级防截屏/录屏：任何屏幕捕获中本窗口均为黑块
  ghostReaderWindow.setContentProtection(true)
  ghostReaderWindow.on('closed', () => {
    ghostReaderWindow = null
  })
}

function updateDockBadge() {
  const unread = mailStore.unreadCounts().reduce((s, u) => s + u.unread, 0)
  if (!appStore.get('general', DEFAULT_GENERAL).dockBadge) {
    app.setBadgeCount(0)
    setTrayUnread(0)
    return
  }
  app.setBadgeCount(unread)
  setTrayUnread(unread)
}

function buildAppMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'LinkTo',
      submenu: [
        { role: 'about', label: '关于 LinkTo（林可兔）' },
        { type: 'separator' },
        {
          label: '设置…',
          accelerator: 'Cmd+,',
          click: () => createSettingsWindow()
        },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 LinkTo' }
      ]
    },
    {
      label: '邮件',
      submenu: [
        {
          label: '新邮件',
          accelerator: 'Cmd+N',
          click: () => createComposeWindow()
        },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function bootstrap() {
  appStore = new AppStore()
  appStore.initKv()
  const db = new DatabaseSync(appStore.dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec(MailStore.SCHEMA)
  mailStore = new MailStore(db)
  // FTS 索引完整性自检：external-content 表与原表不一致时（旧数据/崩溃残留）自动重建
  try {
    db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')").run()
  } catch {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
  }
  // 旧库迁移：发件队列时间戳（新库建表时已含该列）
  try {
    db.exec('ALTER TABLE drafts ADD COLUMN send_at INTEGER')
  } catch { /* 列已存在 */ }
  // 旧库迁移：置顶（pin）与魔法排序顺序
  try {
    db.exec('ALTER TABLE messages ADD COLUMN pinned INTEGER DEFAULT 0')
    db.exec('ALTER TABLE messages ADD COLUMN pinned_order INTEGER')
  } catch { /* 列已存在 */ }
  // 旧库迁移：OAuth 认证类型
  try {
    db.exec('ALTER TABLE accounts ADD COLUMN auth_type TEXT')
  } catch { /* 列已存在 */ }
  // 旧库迁移：Snooze 稍后处理
  try {
    db.exec('ALTER TABLE messages ADD COLUMN snoozed_until INTEGER')
  } catch { /* 列已存在 */ }
  // 旧库迁移：模板分类
  try {
    db.exec("ALTER TABLE templates ADD COLUMN category TEXT DEFAULT ''")
  } catch { /* 列已存在 */ }
  // Screener 首次初始化：存量发件人全部视为已知（只筛从现在起的新面孔）
  try {
    const screened = (db.prepare('SELECT COUNT(*) AS c FROM sender_screening').get() as any).c as number
    if (screened === 0) mailStore.seedExistingSenders()
  } catch { /* 表刚建好 */ }

  oauth = new OAuthService(appStore)

  sender = new MailSender()
  localEngine = new LocalEngine(appStore)
  aiService = new AIService(() => appStore.getAI())
  aiService.attachLocalEngine(localEngine)

  outbox = new Outbox({
    store: mailStore,
    sender,
    engine,
    listAccounts: () => mailStore.listAccounts(),
    getPassword: accountId => appStore.loadSecret(`acct:${accountId}`),
    getCreds: async account =>
      account.authType === 'oauth'
        ? { accessToken: await oauth.validToken(account.id, account.provider) }
        : { pass: appStore.loadSecret(`acct:${account.id}`) },
    event: payload => broadcast(payload)
  })

  ghost = new GhostService({
    appStore,
    store: mailStore,
    sender,
    getCreds: async account =>
      account.authType === 'oauth'
        ? { accessToken: await oauth.validToken(account.id, account.provider) }
        : { pass: appStore.loadSecret(`acct:${account.id}`) },
    event: payload => broadcast(payload)
  })

  insights = new InsightsService({
    ai: aiService,
    store: mailStore,
    getAISettings: () => appStore.getAI(),
    event: payload => broadcast(payload),
    // Agent 长期记忆注入（agent 稍后初始化，闭包延迟求值）
    getMemoryContext: q => agent?.memoryBlock(q) || null,
    onDailyGenerated: ids => void agent?.learnFromMessages(ids, 6),
    downloadBody: async (accountId, folderPath, uid) => {
      await engine?.getWorker(accountId)?.downloadBody(folderPath, uid)
    }
  })

  agent = new AgentService({
    ai: aiService,
    store: mailStore,
    getAISettings: () => appStore.getAI(),
    event: payload => broadcast(payload)
  })

  understand = new UnderstandService({
    ai: aiService,
    store: mailStore,
    getAISettings: () => appStore.getAI(),
    event: payload => broadcast(payload),
    getMemoryContext: q => agent?.memoryBlock(q) || null,
    // engine 稍后初始化，闭包延迟求值
    getWorker: accountId => engine?.getWorker(accountId),
    // 自动收集待办：「需要你处理」且有明确事项的邮件进待办（幂等）
    onInsight: ins => {
      // 项目自动归并（同一会话 > 对方 > 关键词；拿不准的进「建议归入」）
      projects?.onMessage(ins.messageId)
      const a = collectTodoFromInsight(mailStore, ins)
      const b = collectMeetingTodo(mailStore, ins)
      // 财务中心：账单 / 订阅 / 订单 / 企业往来自动收集（排队异步，幂等）
      finance?.onInsight(ins)
      // 生活档案：证件 / 保险 / 年检 / 域名 / 会员 / 保修等到期事务自动收集（排队异步，幂等）
      lifeService()?.onInsight(ins)
      // 事件触发技能：实时新到的邮件命中发票 / 行程变更等事件 → 自动运行对应技能
      jobs?.events.onInsight(ins)
      if (a || b) {
        broadcast({ type: 'todos-changed' })
        notifyLocalChange()
        notifyIntegrationChange()
      }
    }
  })

  engine = new SyncEngine(
    mailStore,
    appStore,
    {
      status: (accountId, status, text) => {
        statuses.set(accountId, { status, text })
        // 首次整理引导：账户首次完成初始同步时登记
        jobs?.onAccountStatus(accountId, status)
        broadcast({ type: 'account-status', accountId, status, text, errorKind: status === 'error' ? classifyAccountError(text) : undefined })
      },
      progress: (accountId, text) => broadcast({ type: 'sync-progress', accountId, text }),
      changed: accountId => {
        broadcast({ type: 'messages-changed', accountId })
      },
      newMail: (accountId, messageId, subject, from, category) => {
        broadcast({ type: 'new-mail', accountId, subject, from })
        notifier.notify({ accountId, messageId, subject, from, category })
        // 自动提炼（正则预过滤账单/会议/Newsletter，命中才花一次 AI 调用）
        const ai = appStore.getAI()
        const row = mailStore.getMessageRow(messageId)
        if (ai.enabled && ai.autoInsights && row && InsightsService.worthExtracting(row.subject, row.snippet ?? '', !!row.is_newsletter)) {
          void insights.extractFromMessage(messageId).catch(() => {})
        }
        // 「自动分类新邮件」：攒 3 秒成一批，一次 AI 调用分完（启发式结果先生效，AI 结果覆盖）
        if (ai.autoClassify && aiReady(ai)) queueAutoClassify(messageId)
      },
      arrived: (accountId, messageId, ruleActions) => {
        void handleArrival(accountId, messageId, ruleActions).catch(err => console.error('[rules]', err))
        // 事件触发技能：登记「实时到达」（回填 / 初始同步不走这里，不会触发）；须在 understand.onArrival 之前
        jobs?.events.markArrival(messageId)
        // 跟进闭环：对方回信 → 结束对应的跟进
        followupService()?.onArrival(messageId)
        // 留痕：书面确认的回信 → 对方已确认 / 有异议
        traceOnArrival(messageId)
        // 邮件理解：新到收件箱邮件排入后台 AI 队列（启发式结果按需即时计算）
        try {
          understand.onArrival(messageId)
        } catch (err) {
          console.error('[understand]', err)
        }
      },
      // 待办同步文件夹有新版本（其他设备写入）
      todoSyncExists: accountId => todoSync?.onRemoteExists(accountId),
      // 附件中心：新邮件的附件元数据（BODYSTRUCTURE）入索引
      attachmentParts: (accountId, messageId, parts) => attachmentService()?.indexParts(accountId, messageId, parts)
    },
    () => mailStore.listRules(),
    // 账户凭据：OAuth 账户取有效 token（临期自动刷新），密码账户读加密密钥
    async (account, force) => {
      if (account.authType === 'oauth') {
        return { accessToken: await oauth.validToken(account.id, account.provider, force) }
      }
      return { pass: appStore.loadSecret(`acct:${account.id}`) }
    },
    // 文件夹偏好：每轮完整同步读取，关闭同步的文件夹跳过拉取
    () => readFolderPrefs(appStore)
  )

  backupService = new BackupService({
    store: mailStore,
    appStore,
    engine,
    sender,
    oauth,
    event: payload => broadcast(payload)
  })

  notifier = new Notifier(
    () => appStore.get('notifications', DEFAULT_NOTIFICATIONS),
    {
      markRead: async messageId => {
        const row = mailStore.getMessageRow(messageId)
        if (!row) return
        const flags = new Set(String(row.flags ?? '').split(' ').filter(Boolean))
        flags.add('\\Seen')
        mailStore.updateMessageFlags(messageId, [...flags])
        broadcast({ type: 'messages-changed' })
        await engine.getWorker(row.account_id)?.setFlags(row.folder_path, row.uid, ['\\Seen'], []).catch(() => {})
      },
      trash: async messageId => {
        const row = mailStore.getMessageRow(messageId)
        if (!row) return
        const worker = engine.getWorker(row.account_id)
        const trashPath = await worker?.specialFolderPath('trash')
        if (worker && trashPath) await worker.moveToFolder(row.folder_path, row.uid, trashPath).catch(() => {})
        else mailStore.deleteMessageCascade(messageId)
        broadcast({ type: 'messages-changed' })
      },
      flag: async messageId => {
        const row = mailStore.getMessageRow(messageId)
        if (!row) return
        const flags = new Set(String(row.flags ?? '').split(' ').filter(Boolean))
        flags.add('\\Flagged')
        mailStore.updateMessageFlags(messageId, [...flags])
        broadcast({ type: 'messages-changed' })
        await engine.getWorker(row.account_id)?.setFlags(row.folder_path, row.uid, ['\\Flagged'], []).catch(() => {})
      },
      archive: async messageId => {
        const row = mailStore.getMessageRow(messageId)
        if (!row) return
        const worker = engine.getWorker(row.account_id)
        const archivePath = await worker?.archiveTargetPath()
        if (worker && archivePath) await worker.moveToFolder(row.folder_path, row.uid, archivePath).catch(() => {})
      },
      focus: messageId => focusMainForNotification(messageId),
      describe: messageId => {
        const row = mailStore.getMessageRow(messageId)
        if (!row) return null
        let insight: { section: MailSection; bundle: MailBundle | null } | null = null
        try {
          // AI 结果已就绪用 AI，否则即时计算启发式（同步、无模型调用）
          const i = understand?.getInsights([messageId])[messageId]
          if (i) insight = { section: i.section, bundle: i.bundle }
        } catch (err) {
          console.error('[notify] insight failed:', err)
        }
        return {
          insight,
          snoozedUntil: row.snoozed_until ?? null,
          seen: String(row.flags ?? '').includes('\\Seen')
        }
      },
      reply: (accountId, messageId) => {
        const row = mailStore.getMessageRow(messageId)
        createComposeWindow({
          accountId,
          relatedMessageId: messageId,
          to: row?.from_addr ? [row.from_addr] : [],
          subject: row?.subject ? `回复：${row.subject}` : ''
        })
      }
    }
  )

  mcp = new McpService({ store: mailStore, appStore, event: payload => broadcast(payload) })
  todoSync = new TodoSyncService({ store: mailStore, appStore, engine, event: payload => broadcast(payload) })
  finance = new FinanceService({
    store: mailStore,
    ai: aiService,
    getAISettings: () => appStore.getAI(),
    event: payload => broadcast(payload),
    onTodosChanged: () => {
      notifyLocalChange()
      notifyIntegrationChange()
    }
  })

  const ctx: AppContext = {
    store: mailStore,
    appStore,
    engine,
    sender,
    ai: aiService,
    localEngine,
    notifier,
    outbox,
    insights,
    agent,
    understand,
    oauth,
    backup: backupService,
    ghost,
    mcp,
    todoSync,
    statuses,
    event: (_win, payload) => broadcast(payload),
    openCompose: prefill => createComposeWindow(prefill as Record<string, unknown>),
    openGhost: () => createGhostWindow(),
    openGhostReader: id => createGhostReaderWindow(id),
    openSettings: tab => createSettingsWindow(tab),
    getPassword: accountId => appStore.loadSecret(`acct:${accountId}`)
  }
  const internal = registerIpc(ctx)
  // 附件中心：索引 / 分类 / 缓存策略 / 网盘归档（独立注册 api:attach* 通道）
  initAttachments({ db, store: mailStore, appStore, engine: () => engine, ai: aiService, getAISettings: () => appStore.getAI(), event: payload => broadcast(payload), finance: () => finance })
  projects = new ProjectService({ store: mailStore, ai: aiService, getAISettings: () => appStore.getAI(), event: payload => broadcast(payload) })
  registerProjectIpc(projects)
  registerFinanceIpc(finance)
  // 导出与分享中心（IPC share* · 离屏渲染 PDF / 长图 · IM / 笔记 / 网盘目标 · linkto:// 链接）
  initShare({
    store: mailStore,
    appStore,
    engine: () => engine,
    call: internal.call,
    event: payload => broadcast(payload),
    mainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    openMessage: id => focusMainForNotification(id)
  })
  // 跟进闭环：发出后在等对方（IPC followup* · 登记钩子 · 发件队列订阅；到期检查由自动任务「跟进检查」驱动）
  initFollowups({
    store: mailStore,
    appStore,
    ai: aiService,
    getAISettings: () => appStore.getAI(),
    event: payload => broadcast(payload),
    openCompose: prefill => createComposeWindow(prefill),
    showFollowups: () => {
      focusMainForNotification()
      mainWindow?.webContents.send('event', { type: 'open-followups' })
    }
  })
  // 主动建议规则：从反复的手动操作里挖掘可自动化的习惯（IPC ruleSuggestion*；挖掘由自动任务「规则建议」每天驱动）
  initRuleSuggest({ db, store: mailStore, call: internal.call, runRuleActions: internal.runRuleActions, event: payload => broadcast(payload) })
  // 生活档案：到期 / 续期类事务（IPC life* · 到期提醒；每日补扫由自动任务「生活档案整理」驱动）
  initLife({
    store: mailStore,
    appStore,
    ai: aiService,
    getAISettings: () => appStore.getAI(),
    event: payload => broadcast(payload),
    onTodosChanged: () => {
      notifyLocalChange()
      notifyIntegrationChange()
    },
    openLife: id => {
      focusMainForNotification()
      mainWindow?.webContents.send('event', { type: 'open-life', id })
    }
  })
  // 升级向导状态 + 侧栏入口数据量（IPC upgrade* / sidebarUsage）
  try {
    registerUpgradeIpc({ appStore, db })
  } catch (err) {
    console.error('[upgrade] init failed:', err)
  }
  // 订阅：RSS / Atom / JSON Feed 与 AI 搜索订阅（IPC feed*；抓取由自动任务「订阅源更新 / AI 搜索订阅 / 今日订阅精华」驱动）
  initFeeds({ db, store: mailStore, appStore, ai: aiService, getAISettings: () => appStore.getAI(), event: payload => broadcast(payload) })
  // 留痕：口头 / 聊天里说定的事 → 可追溯记录（IPC trace* · 书面确认对账 · LinkTo-Trace 跨设备同步）
  initTrace({
    store: mailStore,
    appStore,
    ai: aiService,
    engine,
    getAISettings: () => appStore.getAI(),
    event: payload => broadcast(payload),
    openCompose: prefill => createComposeWindow(prefill),
    onTodosChanged: () => {
      notifyLocalChange()
      notifyIntegrationChange()
    },
    openCapture: () => {
      // 用户主动触发（Dock / 托盘 / 全局快捷键）：显示主窗口后在窗口内打开浮层（不另开新窗口）
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow()
      else {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
      const win = mainWindow
      if (!win) return
      const send = () => !win.isDestroyed() && win.webContents.send('event', { type: 'trace-capture' })
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(send, 1500))
      else send()
    },
    openTrace: id => {
      focusMainForNotification()
      mainWindow?.webContents.send('event', { type: 'open-trace', id })
    }
  })
  // Agent 运行时：工具调用式多步循环 + 会话 + 技能（api:agent*），并把无界面技能运行交给自动任务
  const agentRuntime = new AgentRuntime({
      store: mailStore,
      appStore,
      ai: aiService,
      agent,
      understand,
      finance,
      projects,
      attachments: () => attachmentService(),
      call: internal.call,
      event: payload => broadcast(payload),
      openCompose: prefill => createComposeWindow(prefill as Record<string, unknown>),
      getAISettings: () => appStore.getAI()
    })
  registerAgentIpc(agentRuntime)
  // MCP：外部 Agent 也能用这些只读工具（财务 / 项目 / 附件 / 待跟进…），不覆盖既有工具
  mcp.attachExtraTools({ list: () => agentRuntime.readTools(), run: (name, args) => agentRuntime.runReadTool(name, args) })
  classifyMessages = internal.aiClassify
  runRuleActions = internal.runRuleActions
  // 后台自动任务（待办补扫 / 财务 / 附件 / 项目 / 知识库学习 / 每日简报 / 定期整理 / 定时技能）+ 活动记录 + 首次整理引导
  try {
    jobs = initJobs({
      db,
      store: mailStore,
      appStore,
      ai: aiService,
      understand,
      agent,
      insights,
      finance: () => finance,
      projects: () => projects,
      attachments: () => attachmentService(),
      budget: new AiBudget(appStore),
      event: payload => broadcast(payload),
      // 定期整理：已读的旧订阅 / 通知按设置天数自动归档（原独立定时器，改由调度器每小时调用）
      cleanup: createCleanupRunner({ appStore, store: mailStore, archive: internal.archive, onChanged: () => broadcast({ type: 'messages-changed' }) }),
      showActivity: () => {
        focusMainForNotification()
        mainWindow?.webContents.send('event', { type: 'open-agent-activity' })
      }
    })
  } catch (err) {
    // 自动任务初始化失败不影响收发信主流程
    console.error('[jobs] init failed:', err)
  }

  buildAppMenu()
  const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow()
    else {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  }
  initNativeIntegration({
    openCompose: prefill => createComposeWindow(prefill as Record<string, unknown> | undefined),
    showMain: () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
      else if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      } else createMainWindow()
    },
    unreadTotal: () => mailStore.unreadCounts().reduce((s, u) => s + u.unread, 0),
    quickAddTodo: () => {
      showMainWindow()
      mainWindow?.webContents.send('event', { type: 'quick-add-todo' })
    },
    quickTrace: () => openTraceCapture()
  })
  // 待办提醒：会议 / 固定时间开始前 5 分钟、带时刻的截止前 15 分钟（跟随通知总开关）
  startTodoReminders({
    store: mailStore,
    enabled: () => appStore.get('notifications', DEFAULT_NOTIFICATIONS).enabled,
    openTodo: id => {
      showMainWindow()
      mainWindow?.webContents.send('event', { type: 'open-todo', id })
    }
  })
  // 款项提醒：到期前 3 天 / 当天、续费前 3 天、试用结束前 2 天（跟随通知总开关与免打扰）
  startFinanceReminders({
    finance,
    settings: () => appStore.get('notifications', DEFAULT_NOTIFICATIONS),
    markReminded: (id, keys) => mailStore.updateInsight(id, { data: { reminded: keys } }),
    openFinance: id => {
      showMainWindow()
      mainWindow?.webContents.send('event', { type: 'open-finance', id })
    }
  })
  // 开机自启（跟随设置；hidden 避免抢占前台）
  applyLoginItem(appStore.get('general', DEFAULT_GENERAL).launchAtLogin)

  // 启动所有启用账户的同步
  for (const account of mailStore.listAccounts()) {
    if (!account.enabled) {
      statuses.set(account.id, { status: 'disabled', text: '已停用' })
      continue
    }
    if (account.authType === 'oauth') {
      if (!oauth.loadTokens(account.id)) {
        statuses.set(account.id, { status: 'error', text: 'OAuth 凭证缺失，请重新授权' })
        continue
      }
      engine.startAccount(account)
      continue
    }
    const password = appStore.loadSecret(`acct:${account.id}`)
    if (!password) {
      statuses.set(account.id, { status: 'error', text: '未找到登录凭证，请重新输入密码' })
      continue
    }
    engine.startAccount(account)
  }
  // 睡眠唤醒后旧 IMAP socket 多半已失效：立即重连，而不是等 socket 超时才发现
  powerMonitor.on('resume', () => engine.reconnectAll())
  outbox.start()
  // 邮件理解：启动后补跑最新 30 封未读收件箱邮件（等首轮同步与正文预取先跑一会儿）
  setTimeout(() => {
    try {
      understand.startupScan()
    } catch (err) {
      console.error('[understand] startup scan failed:', err)
    }
  }, 20_000)
  // Snooze 到期释放：每 30 秒检查，到点邮件自动回到收件箱
  setInterval(() => {
    try {
      if (mailStore.releaseDueSnoozed(Date.now()).length) broadcast({ type: 'messages-changed' })
    } catch { /* 下一轮兜底 */ }
  }, 30_000)
  updateDockBadge()
  // 本地 MCP 服务：默认关闭，按设置启动（失败只记录状态，不影响主流程）
  void mcp.apply().catch(err => console.error('[mcp] start failed:', err))
  // 待办跨设备同步（未开启时只挂定时器、不连网）
  todoSync.start()
}

app.whenReady().then(() => {
  createMainWindow()
  bootstrap().catch(err => {
    console.error('bootstrap failed:', err)
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    else if (!mainWindow) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  todoSync?.stop()
  stopTrace()
  jobs?.stop()
  attachmentService()?.stop()
  engine?.stopAll()
  void mcp?.stop()
})

export { createSettingsWindow, createComposeWindow }
