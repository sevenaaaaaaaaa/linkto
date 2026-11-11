import { create } from 'zustand'
import * as Keychain from 'react-native-keychain'
import { useMail, withClient } from '../store/mail'
import { randomBytes } from '../storage/encrypted'
import { onWorkbenchChange, useWorkbench } from './store'
import { SyncCodec } from './sync-codec'
import type { WorkItem } from './model'

interface Config { enabled: boolean; accountEmail: string; passphrase: string }
const service = 'linkto.workbench.sync'
let timer: ReturnType<typeof setTimeout> | null = null
let running: Promise<void> | null = null
let rerun = false
let generation = 0
let ring: { pass: string; codec: SyncCodec } | null = null
export const useWorkSync = create<{ busy: boolean; error: string; lastSync: number | null; enabled: boolean }>(() => ({ busy: false, error: '', lastSync: null, enabled: false }))
export async function readSyncConfig(): Promise<Config | null> {
  const value = await Keychain.getGenericPassword({ service })
  return value ? JSON.parse(value.password) as Config : null
}
export async function configureWorkSync(config: Config) {
  if (config.enabled && (!config.accountEmail || config.passphrase.length < 6)) throw new Error('选择同步邮箱，并填写至少 6 位的同一份同步口令')
  await Keychain.setGenericPassword('sync', JSON.stringify(config), { service })
  useWorkSync.setState({ enabled: config.enabled, error: '' })
  if (ring) { await ring.codec.clear(); ring = null }
  if (config.enabled) await syncWorkbench()
}
export function pauseWorkSync() {
  generation++
  if (timer) clearTimeout(timer)
  timer = null
  const previous = ring; ring = null
  if (previous) void previous.codec.clear()
  useWorkSync.setState({ busy: false })
}
export function scheduleWorkSync() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; void syncWorkbench() }, 2500)
}
onWorkbenchChange(scheduleWorkSync)

/** Existing desktop encrypted mailbox protocol; download/decrypt before any upload. */
export function syncWorkbench(): Promise<void> {
  if (running) { rerun = true; return running }
  const epoch = generation
  const current = () => epoch === generation && useMail.getState().guard === 'ready'
  running = (async () => {
    if (!current()) return
    const config = await readSyncConfig()
    useWorkSync.setState({ enabled: !!config?.enabled })
    if (!config?.enabled) return
    const account = useMail.getState().accounts.find(a => a.email.toLowerCase() === config.accountEmail.toLowerCase())
    if (!account) { useWorkSync.setState({ error: '请先在手机添加用于同步的同一个邮箱' }); return }
    if (!ring || ring.pass !== config.passphrase) ring = { pass: config.passphrase, codec: new SyncCodec(config.passphrase, randomBytes) }
    const codec = ring.codec
    useWorkSync.setState({ busy: true, error: '' })
    try {
      await withClient(account, async client => {
        const folder = await client.ensureSyncFolder()
        try {
          const headers = await client.syncHeaders(folder)
          const latest = new Map<string, { uid: number; version: number }>()
          for (const item of headers) {
            const id = item.headers['x-linkto-todo'] || item.headers['x-linkto-memo']
            const version = Number(item.headers['x-linkto-updated'])
            if (!id || !Number.isFinite(version)) continue
            const previous = latest.get(id)
            if (!previous || version > previous.version || version === previous.version && item.uid > previous.uid) latest.set(id, { uid: item.uid, version })
          }
          const local = useWorkbench.getState().items
          const known = new Map<string, WorkItem>()
          for (const item of local) { known.set(await codec.wireId(item.id), item); known.set(`p:${encodeURIComponent(item.id)}`, item) }
          const pulled: WorkItem[] = []
          for (const [id, remote] of latest) {
            if (!current()) return
            if ((known.get(id)?.data.updatedAt ?? -1) >= remote.version) continue
            // Wrong passphrase aborts here; no upload has happened yet.
            pulled.push(await codec.decode(await client.fetchRaw(folder, remote.uid)))
          }
          if (!current()) return
          if (pulled.length) await useWorkbench.getState().applyRemote(pulled)
          for (const item of useWorkbench.getState().items) {
            if (!current()) return
            if (item.status === 'dismissed' && item.data.updatedAt < Date.now() - 30 * 864e5) continue
            const id = await codec.wireId(item.id)
            // An equal-version plaintext record must still be replaced with an encrypted one.
            const version = latest.get(id)?.version ?? -1
            if (item.data.updatedAt > version) await client.appendSync(folder, await codec.encode(item))
          }
        } finally { await client.selectMailbox('INBOX').catch(() => {}) }
      })
      if (current()) useWorkSync.setState({ lastSync: Date.now(), error: '' })
    } catch (err) {
      if (current()) useWorkSync.setState({ error: err instanceof Error ? err.message : String(err) })
    } finally { if (current()) useWorkSync.setState({ busy: false }) }
  })().catch(err => { if (current()) useWorkSync.setState({ error: String(err) }) }).finally(() => {
    running = null
    if (rerun && current()) { rerun = false; scheduleWorkSync() }
  })
  return running
}
