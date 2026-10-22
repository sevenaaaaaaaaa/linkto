import { app, BrowserWindow, Menu, Tray, clipboard, globalShortcut, nativeImage, screen, shell } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface NativeIntegrationOptions {
  openCompose(prefill?: Record<string, unknown>): void
  showMain(): void
  unreadTotal(): number
  /** 打开主窗口并聚焦「添加待办」 */
  quickAddTodo?(): void
  /** 打开主窗口里的「记一笔留痕」浮层 */
  quickTrace?(): void
  /** 打开主窗口并聚焦搜索框 */
  focusSearch?(): void
  /** 打开幽灵信 / 设置（Dock 与菜单栏） */
  openGhost?(): void
  openSettings?(): void
}

/** 解析 mailto:URL → 预填写信（地址/主题/正文） */
export function parseMailto(url: string): { to: string; subject: string; body: string } | null {
  if (!/^mailto:/i.test(url)) return null
  try {
    const u = new URL(url.replace(/^mailto:/i, 'mailto:'))
    return {
      to: decodeURIComponent(u.pathname || ''),
      subject: u.searchParams.get('subject') ?? '',
      body: u.searchParams.get('body') ?? ''
    }
  } catch {
    return null
  }
}

let tray: Tray | null = null

/** 记一笔留痕的全局快捷键 */
const TRACE_SHORTCUT = 'Alt+Shift+CommandOrControl+L'

/**
 * 原生系统集成：mailto 协议接管、Dock 菜单、菜单栏托盘、全局快捷键。
 * 在 app.whenReady 之后调用。
 */
export function initNativeIntegration(opts: NativeIntegrationOptions): void {
  // ---- mailto: 接管为默认邮件客户端 ----
  if (process.defaultApp && process.argv.length >= 2) {
    // dev 模式：electron . 需显式传入口路径
    app.setAsDefaultProtocolClient('mailto', process.execPath, [resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient('mailto')
  }

  // macOS / 打包应用收到 mailto 唤起
  app.on('open-url', (_e, url) => {
    const m = parseMailto(url)
    if (m) opts.openCompose({ to: m.to, subject: m.subject, body: m.body })
    else opts.showMain()
  })

  // ---- Dock 右键菜单 ----
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(
      Menu.buildFromTemplate([
        { label: '搜索邮件…', click: () => opts.focusSearch?.() },
        { label: '写邮件', click: () => opts.openCompose({}) },
        { label: '新建待办…', click: () => opts.quickAddTodo?.() },
        ...(opts.quickTrace ? [{ label: '记一笔留痕…', click: () => opts.quickTrace?.() }] : []),
        { type: 'separator' },
        ...(opts.openGhost ? [{ label: '加密沟通（幽灵信）', click: () => opts.openGhost?.() }] : []),
        ...(opts.openSettings ? [{ label: '设置…', click: () => opts.openSettings?.() }] : []),
        { label: '打开 LinkTo', click: () => opts.showMain() }
      ])
    )
  }

  // ---- 菜单栏托盘 ----
  try {
    // 优先用模板图（纯黑 + alpha），Electron 会自动加载同目录的 @2x 版本；
    // 设为 template 后 macOS 按菜单栏明暗自动着色
    let trayIcon = nativeImage.createFromPath(joinAppRenderer('tray-Template.png'))
    if (!trayIcon.isEmpty()) {
      trayIcon.setTemplateImage(true)
    } else {
      // 模板图缺失时回退到彩色 logo
      const icon = nativeImage.createFromPath(joinAppRenderer('logo.png'))
      // 1x + 2x 两档表示：只给 18px 单倍图时 Retina 菜单栏会按 2 倍拉伸发糊
      trayIcon = nativeImage.createEmpty()
      if (!icon.isEmpty()) {
        for (const scaleFactor of [1, 2]) {
          const size = 18 * scaleFactor
          trayIcon.addRepresentation({ scaleFactor, buffer: icon.resize({ width: size, height: size, quality: 'best' }).toPNG() })
        }
      }
    }
    if (!trayIcon.isEmpty()) {
      tray = new Tray(trayIcon)
      tray.setToolTip('LinkTo 林可兔')
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '打开 LinkTo', click: () => opts.showMain() },
          { label: '搜索邮件…', click: () => opts.focusSearch?.() },
          { label: '写邮件', click: () => opts.openCompose({}) },
          { label: '新建待办…', accelerator: 'Alt+CommandOrControl+T', click: () => opts.quickAddTodo?.() },
          ...(opts.quickTrace ? [{ label: '记一笔留痕…', accelerator: TRACE_SHORTCUT, click: () => opts.quickTrace?.() }] : []),
          { type: 'separator' },
          ...(opts.openGhost ? [{ label: '加密沟通（幽灵信）', click: () => opts.openGhost?.() }] : []),
          ...(opts.openSettings ? [{ label: '设置…', click: () => opts.openSettings?.() }] : []),
          { type: 'separator' },
          {
            id: 'unread',
            label: '未读 0 封',
            enabled: false
          },
          { type: 'separator' },
          { label: '退出', role: 'quit' }
        ])
      )
    }
  } catch {
    /* 托盘图标缺失不致命 */
  }

  // ---- 全局快捷键 ----
  globalShortcut.register('CommandOrControl+Shift+M', () => opts.openCompose({}))
  globalShortcut.register('CommandOrControl+Shift+L', () => opts.showMain())
  // 随时记一笔：⌥⌘T 打开 LinkTo 的「添加待办」
  if (opts.quickAddTodo) globalShortcut.register('Alt+CommandOrControl+T', () => opts.quickAddTodo!())
  // 记一笔留痕：⌥⇧⌘L（⌥⌘L 是 Finder / Safari / Chrome 的「下载」，全局注册会抢走它们）；被占用时只跳过，不影响其他快捷键
  if (opts.quickTrace) {
    try {
      if (!globalShortcut.register(TRACE_SHORTCUT, () => opts.quickTrace!())) console.warn(`[shortcut] ${TRACE_SHORTCUT} 已被占用，跳过`)
    } catch {
      /* 平台不支持该组合 */
    }
  }

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}

/** 托盘同步未读数（在 Dock 角标更新时一并调用） */
export function setTrayUnread(count: number): void {
  if (!tray) return
  tray.setToolTip(`LinkTo 林可兔 · 未读 ${count} 封`)
  // 菜单项 label 无法运行时改写（需重建菜单），用 tooltip 承载未读数
}

function joinAppRenderer(name: string): string {
  // 打包后在 out/main 下，dev 同构；renderer 产物与 main 同级
  return join(__dirname, '../renderer', name)
}

/** 按设置应用开机自启 */
export function applyLoginItem(openAtLogin: boolean): void {
  app.setLoginItemSettings({ openAtLogin })
}

// ================================================================ macOS 原生细节

/**
 * 原生右键菜单：文本编辑（拼写建议 / 剪切拷贝粘贴）、选中文本（朗读 / 服务 / 共享）、
 * 链接（打开 / 拷贝）、图片（拷贝）。应用自己右键菜单以外的区域终于有 macOS 该有的行为。
 * GhostRead 焚毁阅读窗不挂这个（刻意禁用右键）。
 */
export function attachNativeContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const template = nativeContextTemplate(win, params)
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win })
  })
}

function nativeContextTemplate(win: BrowserWindow, params: Electron.ContextMenuParams): Electron.MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin'
  const items: Electron.MenuItemConstructorOptions[] = []
  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, 5)
    for (const s of suggestions) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) })
    if (!suggestions.length) items.push({ label: '没有拼写建议', enabled: false })
    items.push({
      label: `添加到词典：“${params.misspelledWord}”`,
      click: () => void win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
    })
    items.push({ type: 'separator' })
  }
  if (params.isEditable) {
    items.push(
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '拷贝' },
      { role: 'paste', label: '粘贴' },
      { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
      { role: 'delete', label: '删除' },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' }
    )
  } else if (params.selectionText.trim()) {
    const text = params.selectionText.trim()
    items.push({ role: 'copy', label: '拷贝' })
    if (isMac) {
      items.push(
        { role: 'startSpeaking', label: '朗读' },
        { type: 'separator' },
        { role: 'services', label: '服务', submenu: [] },
        { role: 'shareMenu', label: '共享…', sharingItem: { texts: [text] } }
      )
    }
  }
  if (params.linkURL) {
    if (items.length) items.push({ type: 'separator' })
    items.push(
      { label: '打开链接', click: () => void shell.openExternal(params.linkURL) },
      { label: '拷贝链接', click: () => clipboard.writeText(params.linkURL) }
    )
  }
  if ((params.mediaType === 'image' || params.mediaType === 'canvas') && params.x >= 0 && params.y >= 0) {
    if (items.length) items.push({ type: 'separator' })
    items.push({ label: '拷贝图片', click: () => win.webContents.copyImageAt(params.x, params.y) })
  }
  if (!app.isPackaged) {
    if (items.length) items.push({ type: 'separator' })
    items.push({ label: '检查元素', click: () => win.webContents.inspectElement(params.x, params.y) })
  }
  return items
}

interface SavedWindowState {
  x: number
  y: number
  width: number
  height: number
  maximized?: boolean
}

/**
 * 记住主窗口位置与大小（原生应用的基本行为）。
 * 放在 userData 下，不依赖 appStore；窗口移出所有屏幕时回退默认位置。
 */
export function installWindowState(win: BrowserWindow, min = { width: 960, height: 600 }): void {
  const file = join(app.getPath('userData'), 'window-state.json')
  let saved: SavedWindowState | null = null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as SavedWindowState
    if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y) && parsed.width > 0 && parsed.height > 0) saved = parsed
  } catch {
    /* 首次运行 / 文件损坏 */
  }
  if (saved) {
    const visible = screen.getAllDisplays().some(d => {
      const a = d.workArea
      return saved!.x + saved!.width > a.x && saved!.x < a.x + a.width && saved!.y + saved!.height > a.y && saved!.y < a.y + a.height
    })
    if (visible) {
      win.setBounds({
        x: saved.x,
        y: saved.y,
        width: Math.max(min.width, saved.width),
        height: Math.max(min.height, saved.height)
      })
    }
    if (saved.maximized) win.maximize()
  }
  let timer: NodeJS.Timeout | null = null
  const persist = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (win.isDestroyed()) return
      const b = win.getNormalBounds()
      try {
        writeFileSync(file, JSON.stringify({ ...b, maximized: win.isMaximized() }))
      } catch {
        /* 磁盘不可写不影响使用 */
      }
    }, 500)
  }
  win.on('resize', persist)
  win.on('move', persist)
  win.on('maximize', persist)
  win.on('unmaximize', persist)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    if (win.isDestroyed()) return
    const b = win.getNormalBounds()
    try {
      writeFileSync(file, JSON.stringify({ ...b, maximized: win.isMaximized() }))
    } catch {
      /* ignore */
    }
  })
}

/** macOS「关于 LinkTo」面板（应用菜单第一项 / About 面板） */
export function setNativeAboutPanel(): void {
  if (process.platform !== 'darwin') return
  try {
    app.setAboutPanelOptions({
      applicationName: 'LinkTo',
      applicationVersion: app.getVersion(),
      version: app.getVersion(),
      copyright: '© 2026 LinKTo · OpenFlow',
      credits: 'AI 原生邮件工作台',
      website: 'https://github.com/sevenaaaaaaaaa/linkto'
    })
  } catch {
    /* 旧系统不支持时忽略 */
  }
}
