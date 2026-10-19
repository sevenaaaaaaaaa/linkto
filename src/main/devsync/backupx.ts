/**
 * 备份 v2（backupx*）：.lkbak 可选包含各中心数据（向后兼容旧备份）；恢复时按类别勾选、显示条数、冲突策略；
 * 定期自动备份（自动任务调度器，每周一次，保留最近 N 份）。格式见 ./backup-format.ts。
 */
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { BackupxAutoSettings, BackupxHeader, BackupxRestoreResult, DevSyncCategory } from '@shared/devsync'
import { DEVSYNC_CATEGORIES } from '@shared/devsync'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import type { OAuthService } from '../oauth'
import type { BackupService } from '../backup'
import type { JobDef } from '../jobs/scheduler'
import { readFolderPrefs } from '../mail/folder-prefs'
import type { DevSyncService } from './index'
import {
  BackupFormatError,
  countCategories,
  decideRestore,
  decryptBackup,
  encryptBackup,
  headerOf,
  parseEnvelope,
  rotationVictims,
  type BackupAccountEntry,
  type BackupPayloadV2,
  type RestoreStrategy
} from './backup-format'
import { isDeviceBoundAccount } from './refs'

/* eslint-disable @typescript-eslint/no-explicit-any */

const AUTO_KEY = 'backupxAuto'
const AUTO_PASS = 'backupx:auto-pass'
const WEEK_MS = 7 * 864e5

export interface BackupxDeps {
  store: MailStore
  appStore: AppStore
  oauth: OAuthService
  backup: BackupService
  devsync: DevSyncService
  event(payload: unknown): void
}

const ALL: DevSyncCategory[] = DEVSYNC_CATEGORIES.map(c => c.id)

export class BackupX {
  constructor(private deps: BackupxDeps) {}

  // ---------------------------------------------------------------- 导出

  private payload(categories: DevSyncCategory[], includeSecrets: boolean): BackupPayloadV2 {
    const cats = new Set(categories)
    const accounts: BackupAccountEntry[] = []
    if (cats.has('accounts')) {
      const prefs = readFolderPrefs(this.deps.appStore)
      for (const a of this.deps.store.listAccounts()) {
        const folderPrefs: Record<string, unknown> = {}
        for (const [id, p] of Object.entries(prefs)) if (id.startsWith(`${a.id}::`)) folderPrefs[id.slice(a.id.length + 2)] = p
        const e: BackupAccountEntry = { config: a as any, extra: { folderPrefs, deviceBound: isDeviceBoundAccount(a) } }
        if (includeSecrets) {
          if (a.authType === 'oauth') {
            const t = this.deps.oauth.loadTokens(a.id)
            if (t) e.oauth = t
          } else {
            const s = this.deps.appStore.loadSecret(`acct:${a.id}`)
            if (s) e.secret = s
          }
        }
        accounts.push(e)
      }
    }
    return {
      accounts,
      records: this.deps.devsync.exportRecords(cats, includeSecrets),
      ...(cats.has('accounts') && includeSecrets ? { oauthClients: this.deps.devsync.oauthClientsForBackup() } : {}),
      categories
    }
  }

  private resolveDir(targetId: string, dir?: string | null): string {
    if (targetId === 'pick') {
      if (!dir || !existsSync(dir)) throw new Error('备份目录不存在')
      return dir
    }
    const t = this.deps.backup.listTargets().find(x => x.id === targetId)
    if (!t?.available) throw new Error('该备份目标不可用（未检测到同步目录）')
    return t.path
  }

  private write(dir: string, prefix: string, content: string): string {
    const ts = new Date().toISOString().slice(0, 19).replace(/[-T:]/g, '')
    let path = join(dir, `${prefix}${ts}.lkbak`)
    for (let seq = 2; existsSync(path); seq++) path = join(dir, `${prefix}${ts}-${seq}.lkbak`)
    writeFileSync(path, content)
    return path
  }

  async exportTo(input: {
    targetId: string
    passphrase: string
    includeSecrets: boolean
    categories?: DevSyncCategory[]
    dir?: string | null
  }): Promise<{ ok: boolean; error?: string; path?: string; counts?: Partial<Record<DevSyncCategory, number>> }> {
    if (!input?.passphrase || input.passphrase.length < 4) return { ok: false, error: '请设置至少 4 位的备份口令' }
    let dir = ''
    try {
      if (input.targetId === 'pick' && !input.dir) {
        const win = BrowserWindow.getAllWindows()[0]
        const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
        if (res.canceled || !res.filePaths[0]) return { ok: false, error: '未选择目录' }
        dir = res.filePaths[0]
      } else dir = this.resolveDir(input.targetId, input.dir)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const cats = (input.categories?.length ? input.categories : ALL).filter(c => ALL.includes(c))
    const payload = this.payload(cats, !!input.includeSecrets)
    if (!payload.accounts.length && !payload.records?.length) return { ok: false, error: '所选类别里没有可备份的内容' }
    const env = encryptBackup(payload, input.passphrase, { hasSecrets: !!input.includeSecrets })
    try {
      const path = this.write(dir, 'LinkTo-Backup-', JSON.stringify(env, null, 2))
      return { ok: true, path, counts: countCategories(payload) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ---------------------------------------------------------------- 恢复

  async pick(): Promise<{ ok: boolean; error?: string; path?: string; header?: BackupxHeader }> {
    const win = BrowserWindow.getAllWindows()[0]
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '林可兔备份', extensions: ['lkbak'] }] })
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: '未选择备份文件' }
    return this.header(res.filePaths[0])
  }

  header(path: string): { ok: boolean; error?: string; path?: string; header?: BackupxHeader } {
    try {
      return { ok: true, path, header: headerOf(parseEnvelope(readFileSync(path, 'utf8'))) }
    } catch (err) {
      return { ok: false, error: err instanceof BackupFormatError ? err.message : `读取失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** 用口令解开，返回各类别条数（恢复前勾选用） */
  inspect(path: string, passphrase: string): { ok: boolean; error?: string; header?: BackupxHeader; counts?: Partial<Record<DevSyncCategory, number>>; hasSecrets?: boolean } {
    try {
      const env = parseEnvelope(readFileSync(path, 'utf8'))
      const p = decryptBackup(env, passphrase)
      return { ok: true, header: headerOf(env), counts: countCategories(p), hasSecrets: p.accounts.some(a => a.secret || a.oauth) }
    } catch (err) {
      return { ok: false, error: err instanceof BackupFormatError ? err.message : err instanceof Error ? err.message : String(err) }
    }
  }

  async restore(path: string, passphrase: string, opts: { categories?: DevSyncCategory[]; strategy?: RestoreStrategy }): Promise<BackupxRestoreResult> {
    const result: BackupxRestoreResult = { ok: false, perCategory: {}, accounts: { added: [], updated: [], skipped: [], failed: [], pending: [] } }
    let p: BackupPayloadV2
    try {
      p = decryptBackup(parseEnvelope(readFileSync(path, 'utf8')), passphrase)
    } catch (err) {
      return { ...result, error: err instanceof BackupFormatError ? err.message : err instanceof Error ? err.message : String(err) }
    }
    const strategy: RestoreStrategy = opts?.strategy === 'overwrite' ? 'overwrite' : 'merge'
    const cats = new Set<DevSyncCategory>(opts?.categories?.length ? opts.categories : ALL)
    // 先恢复账户：签名的「默认用于哪些账户」等引用要映射到本机账户
    const records = p.records ?? []
    if (cats.has('accounts')) {
      this.deps.devsync.restoreOAuthClients(p.oauthClients, strategy)
      result.accounts = await this.deps.devsync.restoreAccounts(p.accounts, strategy)
      result.perCategory.accounts = { added: result.accounts.added.length, updated: result.accounts.updated.length, skipped: result.accounts.skipped.length }
    }
    for (const r of records) {
      await this.applyRecord(r, strategy, cats, result)
    }
    result.ok = true
    this.deps.devsync.broadcastChanges(records.filter(r => cats.has(r.category)).map(r => r.type))
    for (const t of ['accounts-changed', 'todos-changed', 'finance-changed', 'projects-changed', 'life-changed', 'followups-changed', 'kb-changed', 'agent-changed', 'trace-changed', 'insights-changed'])
      this.deps.event({ type: t })
    this.deps.devsync.schedule()
    return result
  }

  private async applyRecord(r: NonNullable<BackupPayloadV2['records']>[number], strategy: RestoreStrategy, cats: Set<DevSyncCategory>, result: BackupxRestoreResult) {
    if (!cats.has(r.category)) return
    const slot = (result.perCategory[r.category] ??= { added: 0, updated: 0, skipped: 0 })
    try {
      const d = await this.deps.devsync.restoreRecord(r, local => decideRestore(local, r, strategy), { shareSecrets: cats.has('shareSecrets'), aiKey: cats.has('aiKey') })
      if (d === 'add') slot.added++
      else if (d === 'update') slot.updated++
      else slot.skipped++
    } catch {
      slot.skipped++
    }
  }

  // ---------------------------------------------------------------- 自动备份

  autoSettings(): BackupxAutoSettings {
    const raw = this.deps.appStore.getRaw<Partial<BackupxAutoSettings>>(AUTO_KEY, {}) ?? {}
    return {
      enabled: !!raw.enabled,
      targetId: raw.targetId || 'icloud',
      dir: raw.dir ?? null,
      keep: Math.min(52, Math.max(1, Number(raw.keep) || 4)),
      includeSecrets: raw.includeSecrets !== false,
      categories: raw.categories ?? Object.fromEntries(DEVSYNC_CATEGORIES.map(c => [c.id, c.id === 'threads' ? false : !c.parent])),
      hasPassphrase: !!this.deps.appStore.loadSecret(AUTO_PASS),
      lastAt: raw.lastAt ?? null,
      lastPath: raw.lastPath ?? null,
      lastError: raw.lastError ?? null
    }
  }

  async setAuto(input: Partial<BackupxAutoSettings> & { passphrase?: string; pickDir?: boolean }): Promise<{ ok: boolean; error?: string; settings: BackupxAutoSettings }> {
    const cur = this.autoSettings()
    const fail = (error: string) => ({ ok: false, error, settings: this.autoSettings() })
    if (input.passphrase) {
      if (input.passphrase.length < 4) return fail('备份口令至少 4 位')
      this.deps.appStore.saveSecret(AUTO_PASS, input.passphrase)
    }
    let dir = input.dir ?? cur.dir
    if (input.pickDir) {
      const win = BrowserWindow.getAllWindows()[0]
      const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      if (res.canceled || !res.filePaths[0]) return fail('未选择目录')
      dir = res.filePaths[0]
    }
    const next = {
      ...cur,
      ...input,
      dir,
      keep: Math.min(52, Math.max(1, Number(input.keep ?? cur.keep) || 4))
    }
    delete (next as any).passphrase
    delete (next as any).pickDir
    delete (next as any).hasPassphrase
    if (next.enabled && !this.deps.appStore.loadSecret(AUTO_PASS)) return fail('请先设置自动备份的口令')
    this.deps.appStore.set(AUTO_KEY, next)
    return { ok: true, settings: this.autoSettings() }
  }

  /** 跑一次自动备份（调度器每周调用；也可手动「立即备份一次」） */
  async runAuto(manual = false): Promise<{ ok: boolean; error?: string; path?: string; removed?: number }> {
    const s = this.autoSettings()
    if (!s.enabled && !manual) return { ok: false, error: '未开启' }
    const pass = this.deps.appStore.loadSecret(AUTO_PASS)
    if (!pass) return { ok: false, error: '未设置自动备份口令' }
    try {
      const dir = this.resolveDir(s.targetId, s.dir)
      const cats = (Object.entries(s.categories) as [DevSyncCategory, boolean][]).filter(([, v]) => v).map(([k]) => k)
      const payload = this.payload(cats, s.includeSecrets)
      const env = encryptBackup(payload, pass, { hasSecrets: s.includeSecrets })
      const path = this.write(dir, 'LinkTo-AutoBackup-', JSON.stringify(env))
      let removed = 0
      for (const f of rotationVictims(readdirSync(dir), s.keep)) {
        try {
          unlinkSync(join(dir, f))
          removed++
        } catch {
          /* 网盘占用等，下次再清 */
        }
      }
      this.deps.appStore.set(AUTO_KEY, { ...this.deps.appStore.getRaw<object>(AUTO_KEY, {}), lastAt: Date.now(), lastPath: path, lastError: null })
      return { ok: true, path, removed }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.deps.appStore.set(AUTO_KEY, { ...this.deps.appStore.getRaw<object>(AUTO_KEY, {}), lastError: msg })
      return { ok: false, error: msg }
    }
  }

  /** 自动任务：每周一次（开关跟随自动备份设置） */
  job(): JobDef {
    return {
      id: 'auto-backup',
      name: '定期自动备份',
      description: '每周把账户与各中心数据加密备份到所选网盘目录，只保留最近几份（设置 → 同步与备份）',
      category: 'collect',
      ai: 'none',
      cadence: { kind: 'every', ms: WEEK_MS },
      defaultEnabled: false,
      getEnabled: () => this.autoSettings().enabled,
      setEnabled: v => {
        const cur = this.deps.appStore.getRaw<object>(AUTO_KEY, {}) ?? {}
        this.deps.appStore.set(AUTO_KEY, { ...cur, enabled: v && !!this.deps.appStore.loadSecret(AUTO_PASS) })
      },
      run: async () => {
        const r = await this.runAuto()
        if (!r.ok) {
          if (r.error === '未开启') return { summary: '未开启' }
          throw new Error(r.error ?? '自动备份失败')
        }
        return {
          summary: `已备份${r.removed ? `，清理 ${r.removed} 份旧备份` : ''}`,
          activity: { source: 'job', title: '定期自动备份', detail: `已写入 ${r.path}${r.removed ? `；按「保留最近 ${this.autoSettings().keep} 份」清理了 ${r.removed} 份旧备份` : ''}` }
        }
      }
    }
  }
}

let current: BackupX | null = null
export const backupX = () => current

export function registerBackupxIpc(bx: BackupX) {
  current = bx
  const handlers: Record<string, (...args: any[]) => unknown> = {
    backupxExport: (input: any) => bx.exportTo(input ?? {}),
    backupxPick: () => bx.pick(),
    backupxInspect: (path: string, passphrase: string) => bx.inspect(String(path), String(passphrase ?? '')),
    backupxRestore: (path: string, passphrase: string, opts: any) => bx.restore(String(path), String(passphrase ?? ''), opts ?? {}),
    backupxAutoGet: () => bx.autoSettings(),
    backupxAutoSet: (input: any) => bx.setAuto(input ?? {}),
    backupxAutoRun: () => bx.runAuto(true)
  }
  for (const [method, handler] of Object.entries(handlers)) {
    ipcMain.handle(`api:${method}`, async (_e, ...args) => {
      try {
        return await handler(...args)
      } catch (err) {
        console.error(`[ipc:${method}]`, err instanceof Error ? err.message : String(err))
        throw err
      }
    })
  }
}
