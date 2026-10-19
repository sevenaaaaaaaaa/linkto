import { app, ipcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { AppStore } from './store'
import { WIZARD_EDITION, featureKey, type UpgradeState } from '@shared/upgrade'

/**
 * 升级向导状态（AppStore 'upgradeWizard'）+ 侧栏「有数据就钉住」的数据量统计。
 * IPC：upgradeState / upgradeSetSeen / upgradeLater / sidebarUsage（只增不改）
 */

interface Persist {
  v: 1
  kind: 'fresh' | 'upgrade'
  lastSeen: string | null
  lastSeenApp: string | null
  later: number
}

const KEY = 'upgradeWizard'

export function registerUpgradeIpc(deps: { appStore: AppStore; db: DatabaseSync }) {
  const { appStore, db } = deps

  const count = (sql: string): number => {
    try {
      return Number((db.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0)
    } catch {
      // 表还没建（功能模块初始化失败等）按 0 处理
      return 0
    }
  }

  const load = (): Persist => {
    const st = appStore.getRaw<Persist | null>(KEY, null)
    if (st && st.v === 1) return { v: 1, kind: st.kind === 'fresh' ? 'fresh' : 'upgrade', lastSeen: st.lastSeen ?? null, lastSeenApp: st.lastSeenApp ?? null, later: st.later ?? 0 }
    // 第一次带着向导启动：当时已有账户 = 老用户升级；没有账户 = 全新安装（向导交给添加账户之后的首次整理）
    const hasAccounts = count('SELECT COUNT(*) AS n FROM accounts') > 0
    const fresh: Persist = { v: 1, kind: hasAccounts ? 'upgrade' : 'fresh', lastSeen: null, lastSeenApp: null, later: 0 }
    appStore.set(KEY, fresh)
    return fresh
  }

  // 启动时就定下 fresh / upgrade（否则新用户添加账户后才第一次读取，会被误判为升级）
  load()

  const view = (st: Persist): UpgradeState => ({
    appVersion: app.getVersion(),
    edition: WIZARD_EDITION,
    lastSeen: st.lastSeen,
    kind: st.kind,
    later: st.later,
    lastSeenApp: st.lastSeenApp
  })

  const handlers: Record<string, (...args: any[]) => unknown> = {
    upgradeState: () => view(load()),
    /** 完成或跳过向导：记下看过的功能版本（默认当前向导版本） */
    upgradeSetSeen: (input?: { edition?: string | null; outcome?: 'done' | 'skipped' }) => {
      const st = load()
      const edition = featureKey(input?.edition ?? WIZARD_EDITION) ?? WIZARD_EDITION
      const next: Persist = { ...st, lastSeen: edition, lastSeenApp: app.getVersion(), later: 0 }
      appStore.set(KEY, next)
      return view(next)
    },
    upgradeLater: () => {
      const st = load()
      const next = { ...st, later: st.later + 1 }
      appStore.set(KEY, next)
      return view(next)
    },
    /** 各侧栏入口的数据量（只读计数），用于升级用户「已经在用的入口默认钉住」 */
    sidebarUsage: () => ({
      feeds: count('SELECT COUNT(*) AS n FROM feed_sources'),
      life: count("SELECT COUNT(*) AS n FROM insights WHERE kind = 'life' AND status != 'dismissed'"),
      trace: count("SELECT COUNT(*) AS n FROM insights WHERE kind = 'trace' AND status != 'dismissed'"),
      finance: count("SELECT COUNT(*) AS n FROM insights WHERE kind = 'finance' AND status != 'dismissed'"),
      kb: count('SELECT COUNT(*) AS n FROM kb_items'),
      // 附件：只算用户自己动过的（钉住 / 释放 / 归档到网盘 / 手动改分类），自动索引不算「在用」
      attachments: count("SELECT COUNT(*) AS n FROM attachment_index WHERE pinned = 1 OR released_at IS NOT NULL OR (cloud_json IS NOT NULL AND cloud_json != '[]') OR category_source = 'user'"),
      snoozed: count('SELECT COUNT(*) AS n FROM messages WHERE snoozed_until IS NOT NULL'),
      flagged: count("SELECT COUNT(*) AS n FROM messages WHERE flags LIKE '%\\Flagged%'"),
      pinned: count('SELECT COUNT(*) AS n FROM messages WHERE pinned = 1')
    })
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
}
