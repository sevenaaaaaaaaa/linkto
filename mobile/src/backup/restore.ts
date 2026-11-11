import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Keychain from 'react-native-keychain'
import { encryptedStore, randomBytes, b64, serial } from '../storage/encrypted'
import { useMail } from '../store/mail'
import { useWorkbench } from '../workbench/store'
import type { WorkItem } from '../workbench/model'
import { pauseWorkSync, scheduleWorkSync } from '../workbench/sync'
import { restoreJournal, rollbackRestore, type RestoreJournal } from './journal'
import type { BackupPlan } from './format'
export interface RestoreOptions { accounts: boolean; items: boolean; ai: boolean }
export interface RestoreReceipt { accounts: number; items: number; skipped: number; pending: string[]; desktopOnly: string[]; unsupported: number; ai: boolean }
const disk = encryptedStore<WorkItem[]>('workbench', () => [])
export function applyBackup(plan: BackupPlan, options: RestoreOptions): Promise<RestoreReceipt> {
  return serial('backup-restore', () => serial('workbench', async () => {
    const active = () => { if (useMail.getState().guard !== 'ready') throw new Error('应用已锁定，请解锁后恢复') }
    active()
    if (useMail.getState().sending) throw new Error('请等待当前邮件发送完成后再恢复')
    pauseWorkSync()
    const report: RestoreReceipt = { accounts: 0, items: 0, skipped: 0, pending: [], desktopOnly: [], unsupported: plan.unsupported, ai: false }
    const accounts = [...useMail.getState().accounts], known = new Set(accounts.map(a => a.email.toLowerCase()))
    const secrets: Array<{ service: string; username: string; password: string }> = []
    if (options.accounts) for (const entry of plan.accounts) {
      if (entry.desktopOnly) { report.desktopOnly.push(entry.account.email); continue }
      if (known.has(entry.account.email.toLowerCase())) { report.skipped++; continue }
      known.add(entry.account.email.toLowerCase())
      const id = `mob-${b64(await randomBytes(16)).replace(/[^a-z0-9]/gi, '')}`
      accounts.push({ ...entry.account, id }); report.accounts++
      if (entry.reason) report.pending.push(`${entry.account.email} · ${entry.reason}`)
      if (entry.secret) secrets.push({ service: `linkto.imap.${id}`, username: entry.account.username ?? entry.account.email, password: entry.secret })
    }
    const local = await disk.read(), merged = new Map(local.map(item => [item.id, item]))
    if (options.items) for (const item of plan.items) {
      const previous = merged.get(item.id)
      if (previous && previous.data.updatedAt >= item.data.updatedAt) { report.skipped++; continue }
      merged.set(item.id, item); report.items++
    }
    if (options.accounts && plan.msClientId && !await Keychain.getGenericPassword({ service: 'linkto.oauth.ms.client' })) secrets.push({ service: 'linkto.oauth.ms.client', username: 'client', password: plan.msClientId })
    if (options.ai && plan.ai?.key) secrets.push({ service: 'linkto.ai.key', username: 'ai', password: plan.ai.key })
    const keys = ['linkto.accounts.v1', 'linkto.workbench.v1', 'linkto.ai.base', 'linkto.ai.model']
    const snapshot: RestoreJournal = { values: await Promise.all(keys.map(async key => [key, await AsyncStorage.getItem(key)] as [string, string | null])), secrets: [] }
    for (const service of new Set([...secrets.map(s => s.service), 'linkto.workbench.key'])) {
      const previous = await Keychain.getGenericPassword({ service })
      snapshot.secrets.push(previous ? { service, username: previous.username, password: previous.password } : { service, password: null })
    }
    active(); await restoreJournal.write(snapshot)
    try {
      for (const secret of secrets) { active(); await Keychain.setGenericPassword(secret.username, secret.password, { service: secret.service }) }
      active(); if (options.items && report.items) await disk.write([...merged.values()])
      active(); if (options.accounts && report.accounts) await AsyncStorage.setItem('linkto.accounts.v1', JSON.stringify(accounts))
      if (options.ai && plan.ai) {
        active(); await AsyncStorage.setItem('linkto.ai.base', plan.ai.baseUrl)
        active(); await AsyncStorage.setItem('linkto.ai.model', plan.ai.model); report.ai = true
      }
      active(); await restoreJournal.write(null); active()
    } catch (error) {
      if (useMail.getState().guard === 'burned') {
        await Promise.allSettled([...snapshot.secrets.map(secret => Keychain.resetGenericPassword({ service: secret.service })), ...snapshot.values.map(([key]) => AsyncStorage.removeItem(key)), AsyncStorage.removeItem('linkto.restore-journal.v1'), Keychain.resetGenericPassword({ service: 'linkto.restore-journal.key' })])
        throw new Error('应用已清理本机数据，本次恢复已停止')
      } else {
        try { await rollbackRestore(snapshot) }
        catch { throw new Error('恢复未完成，原数据已保留在加密恢复日志中。请重启应用自动还原') }
      }
      throw new Error(`恢复未完成，已撤回本次改动：${error instanceof Error ? error.message : String(error)}`)
    }
    if (options.accounts) useMail.setState({ accounts })
    if (options.items) useWorkbench.setState({ items: [...merged.values()], loaded: true })
    scheduleWorkSync()
    return report
  }))
}
