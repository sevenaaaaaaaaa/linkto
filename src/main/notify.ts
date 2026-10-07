import { Notification, BrowserWindow } from 'electron'
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

  notify(info: NewMailInfo, unreadTotal: number) {
    const s = this.getSettings()
    if (!s.enabled) return
    const per = s.perAccount[info.accountId]
    if (per && per.enabled === false) return
    if (s.smart && info.category !== 'personal') return
    if (!per && s.smart && info.category !== 'personal') return

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
    void unreadTotal
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
