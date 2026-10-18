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