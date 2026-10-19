/* eslint-disable @typescript-eslint/no-explicit-any */
import { BrowserWindow, dialog, ipcMain, Notification, app } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AISettings } from '@shared/types'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import { DEFAULT_NOTIFICATIONS } from '../store'
import type { AIService } from '../ai/service'
import { inQuietHours } from '../notify-policy'
import { LifeService } from './service'
import { buildLifeIcs } from './plan'

export { LifeService } from './service'

let service: LifeService | null = null

/** 生活档案服务（未初始化时为 null）：Agent 工具 / 自动任务 / 首次整理共用 */
export function lifeService(): LifeService | null {
  return service
}

export interface InitLifeDeps {
  store: MailStore
  appStore: AppStore
  ai: AIService
  getAISettings(): AISettings
  event(payload: unknown): void
  /** 生成提醒待办后通知跨设备 / 外部同步 */
  onTodosChanged?(id: string): void
  /** 点击提醒通知：显示主窗口并打开对应条目 */
  openLife(id: string): void
}

const ymd = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 初始化生活档案：服务 + IPC（life*）+ 到期提醒（每分钟看一次，受通知总开关与免打扰约束，记 reminded 防重复） */
export function initLife(deps: InitLifeDeps): LifeService {
  const svc = new LifeService({ store: deps.store, ai: deps.ai, getAISettings: deps.getAISettings, event: deps.event, onTodosChanged: deps.onTodosChanged })
  service = svc

  const handlers: Record<string, (...args: any[]) => unknown> = {
    lifeList: () => svc.list(),
    lifeCreate: (input: any) => svc.create(input ?? { data: {} }),
    lifeUpdate: (id: string, patch: any) => svc.update(String(id), patch ?? {}),
    lifeDelete: (id: string) => svc.remove(String(id)),
    lifeScan: (days: number) => svc.scan(Number(days) || 730),
    lifeMakeTodo: (id: string) => svc.makeTodo(String(id)),
    lifeFromMessage: (messageId: string) => svc.fromMessage(String(messageId))
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

  ipcMain.handle('api:lifeExportIcs', async (e, ids?: string[] | null) => {
    try {
      const rows = svc.rows(false).filter(r => r.dueAt && r.status !== 'done' && (!ids?.length || ids.includes(r.id)))
      if (!rows.length) return { ok: false, error: '没有带到期日的事务' }
      const win = BrowserWindow.fromWebContents(e.sender)
      const opt = { title: '导出日历（.ics）', defaultPath: join(app.getPath('documents'), `生活档案-${ymd(Date.now())}.ics`), filters: [{ name: 'iCalendar', extensions: ['ics'] }] }
      const res = win ? await dialog.showSaveDialog(win, opt) : await dialog.showSaveDialog(opt)
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      writeFileSync(res.filePath, buildLifeIcs(rows.map(r => ({ id: r.id, title: r.title, dueAt: r.dueAt, data: r.data }))), 'utf8')
      return { ok: true, path: res.filePath, count: rows.length }
    } catch (err) {
      console.error('[ipc:lifeExportIcs]', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 到期提醒
  const live = new Set<Notification>()
  const tick = () => {
    try {
      const s = deps.appStore.get('notifications', DEFAULT_NOTIFICATIONS)
      // 测试用：只计算并记 reminded、不弹通知（与 LINKTO_JOBS_TICK_MS 同类的开发开关）
      const dry = process.env.LINKTO_LIFE_REMIND_DRY_RUN === '1'
      if (!dry && (!s.enabled || !Notification.isSupported())) return
      if (!dry && inQuietHours(s.quietHours, new Date())) return
      const due = svc.dueReminders(Date.now())
      if (due.length) deps.event({ type: 'life-changed' })
      if (dry) {
        for (const { id, reminder } of due) console.log(`[life] reminder (dry run) ${id}: ${reminder.title} | ${reminder.body}`)
        return
      }
      // 一次最多弹 2 条，其余合成一条汇总（首次扫描后可能同时有很多条跨过阈值）
      const shown = due.length > 3 ? due.slice(0, 2) : due
      const list = shown.map(x => ({ id: x.id, title: x.reminder.title, body: x.reminder.body }))
      if (due.length > shown.length) list.push({ id: '', title: `还有 ${due.length - shown.length} 件生活事务临近到期`, body: due.slice(2, 6).map(x => x.reminder.title).join('；') })
      for (const { id, title, body } of list) {
        const n = new Notification({ title, body: body.slice(0, 180), silent: !s.sound })
        live.add(n)
        n.on('click', () => {
          deps.openLife(id)
          live.delete(n)
        })
        n.on('close', () => live.delete(n))
        n.show()
      }
    } catch (err) {
      console.error('[life] reminders failed:', err)
    }
  }
  setTimeout(tick, Number(process.env.LINKTO_LIFE_REMIND_START_MS) || 25_000)
  setInterval(tick, 60_000)
  return svc
}
