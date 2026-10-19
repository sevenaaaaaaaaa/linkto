/* eslint-disable @typescript-eslint/no-explicit-any */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AISettings } from '@shared/types'
import type { FeedItemQuery, FeedScope, FeedSettings, FeedTopic, SearchApiProvider } from '@shared/feeds'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import type { AIService } from '../ai/service'
import { FeedService } from './service'
import { FeedStore } from './store'
import { decodeBody } from './parse'

export { FeedService } from './service'

let service: FeedService | null = null

/** 订阅服务（未初始化时为 null）：自动任务 / Agent 工具共用 */
export function feedService(): FeedService | null {
  return service
}

export interface InitFeedsDeps {
  db: DatabaseSync
  store: MailStore
  appStore: AppStore
  ai: AIService
  getAISettings(): AISettings
  event(payload: unknown): void
}

const ymd = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const scopeOf = (s: any): FeedScope => {
  const k = s?.kind
  if (k === 'source' && s.id) return { kind: 'source', id: String(s.id) }
  if (k === 'group' && s.name) return { kind: 'group', name: String(s.name) }
  if (k === 'starred' || k === 'topics' || k === 'digest') return { kind: k }
  return { kind: 'all' }
}

/** 初始化订阅：数据表 + 服务 + IPC（feed*）。抓取由自动任务「订阅源更新 / AI 搜索订阅 / 今日订阅精华」驱动 */
export function initFeeds(deps: InitFeedsDeps): FeedService {
  const svc = new FeedService({ store: deps.store, appStore: deps.appStore, ai: deps.ai, getAISettings: deps.getAISettings, event: deps.event }, new FeedStore(deps.db))
  service = svc

  const handlers: Record<string, (...args: any[]) => unknown> = {
    feedSources: () => svc.sources(),
    feedDiscover: (url: string) => svc.discover(String(url ?? '')),
    feedAddSource: (input: any) => svc.addSource({ url: String(input?.url ?? ''), group: input?.group ?? null, title: input?.title ?? null, intervalMin: input?.intervalMin ?? null, fullText: !!input?.fullText }),
    feedUpdateSource: (id: string, patch: any) => svc.updateSource(String(id), patch ?? {}),
    feedDeleteSource: (id: string) => svc.deleteSource(String(id)),
    feedRenameGroup: (from: string, to: string | null) => svc.renameGroup(String(from), to ?? null),
    feedRefresh: (ids?: string[] | null) => svc.refresh({ ids: Array.isArray(ids) ? ids.map(String) : null, force: true }),
    feedItems: (q: any) => svc.items({ scope: scopeOf(q?.scope), filter: q?.filter === 'all' || q?.filter === 'starred' ? q.filter : 'unread', q: q?.q ?? '', limit: q?.limit, before: q?.before ?? null } as FeedItemQuery),
    feedItem: (id: string) => svc.item(String(id)),
    feedMarkRead: (ids: string[], read: boolean) => svc.markRead((ids ?? []).map(String), read !== false),
    feedMarkAllRead: (scope: any, before?: number | null) => svc.markAllRead({ scope: scopeOf(scope) }, before ?? null),
    feedStar: (id: string, starred: boolean) => svc.star(String(id), !!starred),
    feedFullText: (id: string) => svc.fullText(String(id)),
    feedSummarize: (id: string, force?: boolean) => svc.summarize(String(id), !!force),
    feedToReading: (id: string) => svc.toReading(String(id)),
    feedUnreadTotal: () => svc.unreadTotal(),
    feedAddTopic: (input: Partial<FeedTopic> & { query: string; group?: string | null }) => svc.addTopic(input ?? { query: '' }),
    feedRunTopic: (id: string) => svc.runTopic(String(id), { ai: true }),
    feedGetSettings: () => svc.settings(),
    feedSetSettings: (patch: Partial<FeedSettings>) => svc.setSettings(patch ?? {}),
    feedSearchKeys: () => svc.searchKeys(),
    feedSetSearchKey: (provider: SearchApiProvider, key: string | null) => svc.setSearchKey(provider, key),
    feedImportOpmlText: (text: string) => svc.importOpml(String(text ?? '')),
    feedDigest: (day?: string | null) => svc.digest(day ?? null),
    feedGenerateDigest: () => svc.generateDigest({ ai: true })
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

  // OPML 导入：系统打开对话框（限 5MB）
  ipcMain.handle('api:feedImportOpml', async e => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender)
      const opt = { title: '导入 OPML', properties: ['openFile' as const], filters: [{ name: 'OPML', extensions: ['opml', 'xml'] }] }
      const res = win ? await dialog.showOpenDialog(win, opt) : await dialog.showOpenDialog(opt)
      if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true, added: 0, skipped: 0, failed: [] }
      if (statSync(res.filePaths[0]).size > 5 * 1024 * 1024) return { ok: false, added: 0, skipped: 0, failed: [], error: '文件太大（上限 5MB）' }
      return await svc.importOpml(decodeBody(new Uint8Array(readFileSync(res.filePaths[0]))))
    } catch (err) {
      console.error('[ipc:feedImportOpml]', err)
      return { ok: false, added: 0, skipped: 0, failed: [], error: err instanceof Error ? err.message : String(err) }
    }
  })

  // OPML 导出：系统保存对话框
  ipcMain.handle('api:feedExportOpml', async e => {
    try {
      const count = svc.sources().filter(s => s.kind === 'feed').length
      if (!count) return { ok: false, error: '还没有订阅源' }
      const win = BrowserWindow.fromWebContents(e.sender)
      const opt = { title: '导出 OPML', defaultPath: join(app.getPath('documents'), `LinkTo-订阅-${ymd(Date.now())}.opml`), filters: [{ name: 'OPML', extensions: ['opml'] }] }
      const res = win ? await dialog.showSaveDialog(win, opt) : await dialog.showSaveDialog(opt)
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      writeFileSync(res.filePath, svc.exportOpml(), 'utf8')
      return { ok: true, path: res.filePath, count }
    } catch (err) {
      console.error('[ipc:feedExportOpml]', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  return svc
}
