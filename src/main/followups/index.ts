/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipcMain, Notification } from 'electron'
import type { AISettings, FollowupKind, FollowupStatus } from '@shared/types'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import { DEFAULT_NOTIFICATIONS } from '../store'
import type { AIService } from '../ai/service'
import { inQuietHours } from '../notify-policy'
import { setFollowupRegistrar } from '../agent/hooks'
import { onOutboxEvent } from '../mail/outbox'
import { FollowupService } from './service'

export { FollowupService } from './service'

let service: FollowupService | null = null

/** 跟进服务（未初始化时为 null）：Agent 工具 / 自动任务 / 同步钩子共用 */
export function followupService(): FollowupService | null {
  return service
}

export interface InitFollowupsDeps {
  store: MailStore
  appStore: AppStore
  ai: AIService
  getAISettings(): AISettings
  event(payload: unknown): void
  openCompose(prefill: Record<string, unknown>): void
  /** 点击通知：显示主窗口并打开「等待对方」 */
  showFollowups(): void
}

/** 初始化跟进闭环：服务 + IPC（followupList / Create / Update / Nudge）+ 登记钩子 + 发件队列订阅 */
export function initFollowups(deps: InitFollowupsDeps): FollowupService {
  const live = new Set<Notification>()
  const svc = new FollowupService({
    store: deps.store,
    ai: deps.ai,
    getAISettings: deps.getAISettings,
    event: deps.event,
    openCompose: deps.openCompose,
    notify: (title, body) => {
      const s = deps.appStore.get('notifications', DEFAULT_NOTIFICATIONS)
      if (!s.enabled || inQuietHours(s.quietHours, new Date()) || !Notification.isSupported()) return
      const n = new Notification({ title, body: body.slice(0, 180), silent: !s.sound })
      live.add(n)
      n.on('click', () => {
        deps.showFollowups()
        live.delete(n)
      })
      n.on('close', () => live.delete(n))
      n.show()
    }
  })
  service = svc
  setFollowupRegistrar(svc.register)
  onOutboxEvent(e => svc.onOutbox(e))

  const handlers: Record<string, (...args: any[]) => unknown> = {
    followupList: (opts?: { includeClosed?: boolean }) => svc.list(!!opts?.includeClosed),
    followupCreate: (input: { messageId: string; kind?: FollowupKind; ask?: string; waitDays?: number }) => svc.createFromMessage(input ?? ({} as never)),
    followupUpdate: (id: string, patch: { status?: FollowupStatus; waitDays?: number; ask?: string; maxAttempts?: number; kind?: FollowupKind; snoozeDays?: number }) => svc.update(String(id), patch ?? {}),
    followupNudge: (id: string) => svc.nudge(String(id))
  }
  for (const [method, handler] of Object.entries(handlers)) {
    ipcMain.handle(`api:${method}`, async (_e, ...args) => {
      try {
        return await handler(...args)
      } catch (err) {
        console.error(`[ipc:${method}]`, err)
        throw err
      }
    })
  }
  return svc
}
