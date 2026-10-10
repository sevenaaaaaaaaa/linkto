import { app, Menu, Tray, globalShortcut, nativeImage } from 'electron'
import { join, resolve } from 'node:path'

export interface NativeIntegrationOptions {
  openCompose(prefill?: Record<string, unknown>): void
  showMain(): void
  unreadTotal(): number
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
        { label: '写邮件', click: () => opts.openCompose({}) },
        { label: '打开 LinkTo', click: () => opts.showMain() }
      ])
    )
  }

  // ---- 菜单栏托盘 ----
  try {
    const icon = nativeImage.createFromPath(joinAppRenderer('logo.png'))
    if (!icon.isEmpty()) {
      tray = new Tray(icon.resize({ width: 18, height: 18 }))
      tray.setToolTip('LinkTo 林可兔')
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '打开 LinkTo', click: () => opts.showMain() },
          { label: '写邮件', click: () => opts.openCompose({}) },
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