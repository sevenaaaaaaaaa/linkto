import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AppStore, DEFAULT_GENERAL, DEFAULT_NOTIFICATIONS } from './store'
import { MailStore } from './db'
import { SyncEngine, friendlyError } from './mail/sync-engine'
import { MailSender } from './mail/sender'
import { Outbox } from './mail/outbox'
import { AIService } from './ai/service'
import { InsightsService } from './ai/insights'
import { AgentService } from './ai/agent'
import { Notifier, focusMainWindow } from './notify'
import { registerIpc, type AppContext } from './ipc'
import { DEFAULT_AI } from './store'

let appStore: AppStore
let mailStore: MailStore
let engine: SyncEngine
let sender: MailSender
let aiService: AIService
let notifier: Notifier
let outbox: Outbox
let insights: InsightsService
let agent: AgentService
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
}

function broadcast(payload: unknown) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('event', payload)
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#f8f3e8',
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
    width: 900,
    height: 640,
    minWidth: 760,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#f8f3e8',
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
    backgroundColor: '#faf7f0',
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

function updateDockBadge() {
  if (!appStore.get('general', DEFAULT_GENERAL).dockBadge) {
    app.setBadgeCount(0)
    return
  }
  const unread = mailStore.unreadCounts().reduce((s, u) => s + u.unread, 0)
  app.setBadgeCount(unread)
}

function buildAppMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'LinkTo',
      submenu: [
        { role: 'about', label: '关于 LinkTo' },
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
  db.exec(MailStore.SCHEMA)
  mailStore = new MailStore(db)
  // 旧库迁移：发件队列时间戳（新库建表时已含该列）
  try {
    db.exec('ALTER TABLE drafts ADD COLUMN send_at INTEGER')
  } catch { /* 列已存在 */ }
  // 旧库迁移：置顶（pin）与魔法排序顺序
  try {
    db.exec('ALTER TABLE messages ADD COLUMN pinned INTEGER DEFAULT 0')
    db.exec('ALTER TABLE messages ADD COLUMN pinned_order INTEGER')
  } catch { /* 列已存在 */ }

  sender = new MailSender()
  aiService = new AIService(() => appStore.get('ai', DEFAULT_AI))

  outbox = new Outbox({
    store: mailStore,
    sender,
    engine,
    listAccounts: () => mailStore.listAccounts(),
    getPassword: accountId => appStore.loadSecret(`acct:${accountId}`),
    event: payload => broadcast(payload)
  })

  insights = new InsightsService({
    ai: aiService,
    store: mailStore,
    getAISettings: () => appStore.get('ai', DEFAULT_AI),
    event: payload => broadcast(payload),
    // Agent 长期记忆注入（agent 稍后初始化，闭包延迟求值）
    getMemoryContext: q => agent?.memoryBlock(q) || null,
    onDailyGenerated: ids => void agent?.learnFromMessages(ids, 6)
  })

  agent = new AgentService({
    ai: aiService,
    store: mailStore,
    getAISettings: () => appStore.get('ai', DEFAULT_AI),
    event: payload => broadcast(payload)
  })

  engine = new SyncEngine(
    mailStore,
    appStore,
    {
      status: (accountId, status, text) => {
        statuses.set(accountId, { status, text })
        broadcast({ type: 'account-status', accountId, status, text })
      },
      progress: (accountId, text) => broadcast({ type: 'sync-progress', accountId, text }),
      changed: accountId => {
        broadcast({ type: 'messages-changed', accountId })
        updateDockBadge()
      },
      newMail: (accountId, messageId, subject, from, category) => {
        broadcast({ type: 'new-mail', accountId, subject, from })
        notifier.notify({ accountId, messageId, subject, from, category }, 0)
        // 自动提炼（正则预过滤账单/会议/Newsletter，命中才花一次 AI 调用）
        const ai = appStore.get('ai', DEFAULT_AI)
        const row = mailStore.getMessageRow(messageId)
        if (ai.enabled && ai.autoInsights && row && InsightsService.worthExtracting(row.subject, row.snippet ?? '', !!row.is_newsletter)) {
          void insights.extractFromMessage(messageId).catch(() => {})
        }
      }
    },
    () => mailStore.listRules()
  )

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
        await engine.getWorker(row.account_id)?.setFlags(row.folder_path, row.uid, ['\\Flagged'], []).catch(() => {})
      },
      archive: async messageId => {
        const row = mailStore.getMessageRow(messageId)
        if (!row) return
        const worker = engine.getWorker(row.account_id)
        const archivePath = await worker?.specialFolderPath('archive')
        if (worker && archivePath) await worker.moveToFolder(row.folder_path, row.uid, archivePath).catch(() => {})
      },
      focus: () => focusMainWindow(),
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

  const ctx: AppContext = {
    store: mailStore,
    appStore,
    engine,
    sender,
    ai: aiService,
    notifier,
    outbox,
    insights,
    agent,
    statuses,
    event: (_win, payload) => broadcast(payload),
    openCompose: prefill => createComposeWindow(prefill as Record<string, unknown>),
    openSettings: tab => createSettingsWindow(tab),
    getPassword: accountId => appStore.loadSecret(`acct:${accountId}`)
  }
  registerIpc(ctx)

  buildAppMenu()

  // 启动所有启用账户的同步
  for (const account of mailStore.listAccounts()) {
    if (!account.enabled) {
      statuses.set(account.id, { status: 'disabled', text: '已停用' })
      continue
    }
    const password = appStore.loadSecret(`acct:${account.id}`)
    if (!password) {
      statuses.set(account.id, { status: 'error', text: '未找到登录凭证，请重新输入密码' })
      continue
    }
    engine.startAccount(account, password)
  }
  outbox.start()
  // 定期学习：每 30 分钟检查一次是否该生成当日商情
  setInterval(() => void insights.maybeAutoDaily().catch(() => {}), 30 * 60_000)
  void insights.maybeAutoDaily().catch(() => {})
  updateDockBadge()
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
  engine?.stopAll()
})

export { createSettingsWindow, createComposeWindow }
