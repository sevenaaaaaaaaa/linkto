import { app, ipcMain } from 'electron'
import type { LinkToApi } from '@shared/ipc'
import { ShareService, type ShareDeps } from './service'

/**
 * 导出与分享中心入口：独立注册 api:share* 通道（不改动 ipc.ts 既有处理器），
 * 并处理 linkto:// 内部链接（macOS open-url / 其他平台 second-instance 的 argv）。
 */

let current: ShareService | null = null
const pendingLinks: string[] = []

export function shareService(): ShareService | null {
  return current
}

type Handler<K extends keyof LinkToApi> = (...args: Parameters<LinkToApi[K]>) => Awaited<ReturnType<LinkToApi[K]>> | ReturnType<LinkToApi[K]>

/** linkto:// 链接：服务就绪前先排队 */
export function handleAppLink(url: string): void {
  if (!/^linkto:/i.test(url)) return
  if (!current) {
    pendingLinks.push(url)
    return
  }
  const r = current.openLink(url)
  if (!r.ok) console.warn('[share] open link:', r.error)
}

/** 进程启动前就要监听：macOS 通过 open-url 投递链接；Windows / Linux 走命令行参数 */
export function listenAppLinks(): void {
  app.on('open-url', (e, url) => {
    e.preventDefault()
    handleAppLink(url)
  })
  app.on('second-instance', (_e, argv) => {
    const url = argv.find(a => /^linkto:\/\//i.test(a))
    if (url) handleAppLink(url)
  })
  const first = process.argv.find(a => /^linkto:\/\//i.test(a))
  if (first) pendingLinks.push(first)
}

export function initShare(deps: ShareDeps): ShareService {
  const svc = new ShareService(deps)
  current = svc
  // 只在正式安装包里登记为系统默认的 linkto:// 处理程序（开发模式下不改动系统的协议关联）
  if (app.isPackaged) {
    try {
      if (!app.isDefaultProtocolClient('linkto')) app.setAsDefaultProtocolClient('linkto')
    } catch (err) {
      console.warn('[share] protocol register failed:', err)
    }
  }
  const handlers: { [K in keyof LinkToApi as K extends `share${string}` ? K : never]: Handler<K> } = {
    shareTargets: () => svc.targets(),
    shareSaveTarget: input => svc.saveTarget(input),
    shareRemoveTarget: id => svc.removeTarget(id),
    shareTestTarget: id => svc.test(id),
    shareSettings: () => svc.settings(),
    shareSetSettings: patch => svc.setSettings(patch ?? {}),
    sharePreview: req => svc.preview(req),
    shareSend: req => svc.send(req, { via: 'ui' }),
    shareExport: req => svc.exportFiles(req),
    shareCopy: (ids, kind) => svc.copy(ids ?? [], kind),
    shareLinks: id => svc.linksFor(id),
    shareOpenLink: url => svc.openLink(url)
  }
  for (const [method, handler] of Object.entries(handlers)) {
    ipcMain.handle(`api:${method}`, async (_event, ...args) => {
      try {
        return await (handler as (...a: unknown[]) => unknown)(...args)
      } catch (err) {
        console.error(`[ipc:${method}]`, err)
        throw err
      }
    })
  }
  // 启动前收到的链接：等主窗口加载后再定位
  if (pendingLinks.length) {
    const list = pendingLinks.splice(0)
    setTimeout(() => list.forEach(handleAppLink), 1500)
  }
  return svc
}
