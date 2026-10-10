import { Notification, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import type { NotificationSettings } from '@shared/types'

export interface NewMailInfo {
  accountId: string
  messageId: string
  subject: string
  from: string
  category: string
}

/** 新邮件系统通知（含 Canary 式快捷操作按钮） */
export class Notifier {
  constructor(
    private getSettings: () => NotificationSettings,
    private handlers: {
      markRead(messageId: string): Promise<void>
      trash(messageId: string): Promise<void>
      flag(messageId: string): Promise<void>
      archive(messageId: string): Promise<void>
      focus(): void
      reply(accountId: string, messageId: string): void
    }
  ) {}

  notify(info: NewMailInfo, unreadTotal: number, force = false) {
    const s = this.getSettings()
    if (!s.enabled && !force) return
    const per = s.perAccount[info.accountId]
    if (!force && per && per.enabled === false) return
    if (!force && s.smart && info.category !== 'personal') return
    if (!force && !per && s.smart && info.category !== 'personal') return

    const title = info.subject || '（无主题）'
    const body = info.from
    const notification = new Notification({
      title,
      body,
      silent: !s.sound,
      actions: s.actions
        .filter(a => a !== 'none')
        .slice(0, 2)
        .map(a => ({ type: 'button' as const, text: ACTION_LABEL[a] ?? a }))
    })
    const active = s.actions.filter(a => a !== 'none').slice(0, 2)
    notification.on('action', (_e, index: number) => {
      void this.runAction(active[index], info)
    })
    notification.on('click', () => this.handlers.focus())
    notification.show()
    // macOS 未签名应用无法显示系统通知（UNUserNotificationCenter 需要签名 bundle）。
    // 触发 'failed' 或 1.5s 内未 'show' 则降级为 AppleScript 通知（经通知中心，点击不可定位窗口）。
    let shown = false
    const fallback = () => {
      if (shown) return
      shown = true
      this.appleScriptNotify(title, body)
    }
    const timer = setTimeout(fallback, 1500)
    notification.on('show', () => {
      shown = true
      clearTimeout(timer)
    })
    notification.on('failed', () => {
      clearTimeout(timer)
      fallback()
    })
    void unreadTotal
  }

  /** AppleScript 兜底：display notification 走系统通知中心（宿主为 Script Editor） */
  private appleScriptNotify(title: string, body: string) {
    if (process.platform !== 'darwin') return
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const script = `display notification "${esc(body)}" with title "林可兔 LinkTo" subtitle "${esc(title)}"`
    execFile('osascript', ['-e', script], () => {})
  }

  private async runAction(action: string, info: NewMailInfo) {
    switch (action) {
      case 'markRead':
        await this.handlers.markRead(info.messageId)
        break
      case 'delete':
        await this.handlers.trash(info.messageId)
        break
      case 'archive':
        await this.handlers.archive(info.messageId)
        break
      case 'flag':
        await this.handlers.flag(info.messageId)
        break
      case 'reply':
        this.handlers.reply(info.accountId, info.messageId)
        break
    }
  }
}

const ACTION_LABEL: Record<string, string> = {
  markRead: '标为已读',
  reply: '回复',
  delete: '删除',
  archive: '归档',
  flag: '标记'
}

export function focusMainWindow() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents.getURL().includes('index.html')) {
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
      return
    }
  }
}
