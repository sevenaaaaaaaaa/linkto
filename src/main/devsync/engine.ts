/**
 * LinkTo-Vault 一轮同步的编排（与传输、存储解耦：IMAP / SQLite 由 index.ts 适配，单测用内存实现）。协议见 ./protocol.ts
 */
import type { SyncTransport } from '../todo-sync/engine'
import {
  VAULT_FOLDER,
  VAULT_HEADER_NAMES,
  MAX_RECORD_BYTES,
  KeyRing,
  TodoSyncError,
  decideVault,
  decodeVaultMessage,
  encodeVaultMessage,
  groupVault,
  isExpiredVaultTombstone,
  kindTag,
  passCheck,
  localEntryOf,
  needsDownload,
  needsPush,
  recordSize,
  tombstoneEntryOf,
  vaultHeaderMeta,
  vaultWireId,
  type LocalEntry,
  type LocalItem,
  type StateRow,
  type VaultHeader,
  type VaultRecord,
  type VaultRefs
} from './protocol'

export type { SyncTransport }

export interface ApplyContext {
  updatedAt: number
  device: string | null
  deviceId: string | null
  /** 本机第一次见到这条（新设备首次拉取） */
  first: boolean
}

/** 'defer' = 暂不落地（如：另一台设备删除了账户，先问用户），本地保持原样且不推送 */
export type ApplyResult = void | 'defer'

export interface VaultAdapter {
  type: string
  category: string
  /** 落地顺序：小的先（账户在凭据之前） */
  priority?: number
  list(): LocalItem[]
  get?(id: string): LocalItem | null
  apply(id: string, data: unknown, ctx: ApplyContext): ApplyResult | Promise<ApplyResult>
  remove(id: string, ctx: ApplyContext): ApplyResult | Promise<ApplyResult>
  /** 本地「不存在」不代表删除（如凭据：本机没填的本机专用密码），不生成墓碑 */
  noLocalTombstones?: boolean
}

export interface VaultStateStore {
  all(): StateRow[]
  set(row: StateRow): void
  delete(type: string, id: string): void
}

export interface VaultRoundStats {
  pulled: number
  pushed: number
  removed: number
  conflicts: number
  oversize: number
  changedLocal: boolean
  more: boolean
  /** 本轮落地的记录（供活动记录 / 刷新界面） */
  applied: { type: string; id: string; deleted: boolean; device: string | null }[]
  /** 两边都改过、按后写者胜处理的记录 */
  conflictItems: { type: string; id: string; winner: 'remote' | 'local' }[]
  oversizeItems: { type: string; id: string; size: number }[]
}

export const newVaultStats = (): VaultRoundStats => ({
  pulled: 0,
  pushed: 0,
  removed: 0,
  conflicts: 0,
  oversize: 0,
  changedLocal: false,
  more: false,
  applied: [],
  conflictItems: [],
  oversizeItems: []
})

export async function vaultRound(opts: {
  transport: SyncTransport
  adapters: VaultAdapter[]
  state: VaultStateStore
  keyring: KeyRing
  /** 本地内容哈希（本机密钥 HMAC，不随口令变化） */
  hash(data: unknown): string
  /** 推送时为记录生成跨设备引用 */
  refsOf?(data: unknown): VaultRefs | undefined
  /** 拉取时把远端引用翻译成本机 id */
  remap?(data: unknown, refs: VaultRefs | undefined): unknown
  device?: string
  deviceId?: string
  now?: number
  limit?: number
  maxBytes?: number
  folder?: string
  stats?: VaultRoundStats
}): Promise<VaultRoundStats> {
  const { transport: tx, keyring } = opts
  const now = opts.now ?? Date.now()
  const limit = opts.limit ?? 300
  const maxBytes = opts.maxBytes ?? MAX_RECORD_BYTES
  const stats = opts.stats ?? newVaultStats()
  const indexKey = await keyring.indexKey()
  const byType = new Map(opts.adapters.map(a => [a.type, a]))

  const folder = await tx.ensureFolder(opts.folder ?? VAULT_FOLDER)
  const kinds = new Set(opts.adapters.map(a => kindTag(a.category, indexKey)))
  const all = (await tx.fetchHeaders(folder, VAULT_HEADER_NAMES)).map(m => vaultHeaderMeta(m.uid, m.headers)).filter((h): h is VaultHeader => !!h)
  // 口令校验：文件夹里有别的口令写的记录 → 中止（绝不另起一套、也不覆盖）
  const check = passCheck(indexKey)
  if (all.some(h => h.check && h.check !== check)) throw new TodoSyncError('passphrase', '同步口令不正确')
  const remote = all.filter(h => kinds.has(h.kind))
  const groups = groupVault(remote)
  const toDelete = new Set<number>()
  for (const g of groups.values()) for (const h of g.all) if (h !== g.best) toDelete.add(h.uid)

  // ---- 本地快照 ----
  const stateRows = opts.state.all().filter(s => byType.has(s.type))
  const stateByKey = new Map(stateRows.map(s => [`${s.type}\n${s.id}`, s]))
  const stateByWire = new Map(stateRows.map(s => [s.wire, s]))
  const locals = new Map<string, LocalEntry>()
  const snapshot = () => {
    locals.clear()
    for (const a of opts.adapters) {
      const seen = new Set<string>()
      for (const item of a.list()) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        const wire = vaultWireId(a.type, item.id, indexKey)
        locals.set(wire, localEntryOf(a.type, item, opts.hash(item.sig ?? item.data), stateByKey.get(`${a.type}\n${item.id}`), wire, now))
      }
      for (const st of stateRows) {
        if (st.type !== a.type || seen.has(st.id)) continue
        if (a.noLocalTombstones && !st.deleted) {
          // 本地没有、也不算删除：维持远端已知状态
          locals.set(st.wire, { type: st.type, id: st.id, wire: st.wire, item: null, hash: null, ver: st.localVer, changed: false, first: false })
          continue
        }
        locals.set(st.wire, tombstoneEntryOf(st, now))
      }
    }
  }
  snapshot()
  const setState = (row: StateRow) => {
    opts.state.set(row)
    stateByKey.set(`${row.type}\n${row.id}`, row)
    stateByWire.set(row.wire, row)
  }

  // ---- 拉：下载远端更新，按优先级落地 ----
  const want: VaultHeader[] = []
  for (const [wire, g] of groups) {
    if (isExpiredVaultTombstone(g.best, now)) {
      g.all.forEach(h => toDelete.add(h.uid))
      const st = stateByWire.get(wire)
      if (st && !locals.get(wire)?.item) {
        opts.state.delete(st.type, st.id)
        stateByWire.delete(wire)
      }
      groups.delete(wire)
      continue
    }
    if (needsDownload(g, locals.get(wire), stateByWire.get(wire))) want.push(g.best)
  }
  if (want.length > limit) stats.more = true
  const fetched: { h: VaultHeader; rec: VaultRecord }[] = []
  for (const h of want.slice(0, limit)) {
    const raw = await tx.download(folder, h.uid)
    if (!raw) continue
    try {
      fetched.push({ h, rec: await decodeVaultMessage(raw, keyring) })
    } catch (err) {
      // 口令错误：整轮中止，绝不拿本地数据覆盖读不懂的远端
      if (err instanceof TodoSyncError && err.code !== 'format') throw err
      toDelete.add(h.uid)
    }
  }
  const prio = (t: string) => byType.get(t)?.priority ?? 100
  fetched.sort((x, y) => prio(x.rec.type) - prio(y.rec.type) || x.rec.updatedAt - y.rec.updatedAt)
  for (const { h, rec } of fetched) {
    const adapter = byType.get(rec.type)
    if (!adapter) continue
    const wire = h.wireId
    const local = locals.get(wire)
    const st = stateByWire.get(wire)
    const decision = decideVault(local, rec)
    const ctx: ApplyContext = { updatedAt: rec.updatedAt, device: rec.device ?? null, deviceId: rec.deviceId ?? null, first: !local || local.first }
    if (decision === 'keep-local') {
      if (local?.changed && !local.first && st && rec.updatedAt > st.remoteVer) {
        stats.conflicts++
        stats.conflictItems.push({ type: rec.type, id: rec.id, winner: 'local' })
      }
      setState({
        type: rec.type,
        id: rec.id,
        wire,
        hash: local?.hash ?? null,
        localVer: local?.ver ?? 0,
        remoteVer: Math.max(rec.updatedAt, st?.remoteVer ?? 0),
        deleted: !local?.item,
        skipped: false
      })
      continue
    }
    if (decision === 'noop') {
      setState({ type: rec.type, id: rec.id, wire, hash: null, localVer: rec.updatedAt, remoteVer: rec.updatedAt, deleted: true, skipped: false })
      if (local) Object.assign(local, { changed: false, ver: rec.updatedAt })
      continue
    }
    if (local?.changed && !local.first && st && st.remoteVer < rec.updatedAt) {
      stats.conflicts++
      stats.conflictItems.push({ type: rec.type, id: rec.id, winner: 'remote' })
    }
    let result: ApplyResult
    if (rec.deleted) result = await adapter.remove(rec.id, ctx)
    else {
      const data = opts.remap ? opts.remap(rec.data, rec.refs) : rec.data
      result = await adapter.apply(rec.id, data, ctx)
    }
    if (result === 'defer') {
      setState({
        type: rec.type,
        id: rec.id,
        wire,
        hash: local?.hash ?? null,
        localVer: local?.ver ?? 0,
        remoteVer: rec.updatedAt,
        deleted: !local?.item,
        skipped: false
      })
      if (local) local.changed = false
      continue
    }
    const after = adapter.get ? adapter.get(rec.id) : adapter.list().find(i => i.id === rec.id) ?? null
    setState({
      type: rec.type,
      id: rec.id,
      wire,
      hash: after ? opts.hash(after.sig ?? after.data) : null,
      localVer: rec.updatedAt,
      remoteVer: rec.updatedAt,
      deleted: !after,
      skipped: false
    })
    locals.set(wire, { type: rec.type, id: rec.id, wire, item: after, hash: after ? opts.hash(after.sig ?? after.data) : null, ver: rec.updatedAt, changed: false, first: false })
    stats.pulled++
    stats.changedLocal = true
    stats.applied.push({ type: rec.type, id: rec.id, deleted: rec.deleted, device: rec.device ?? null })
  }

  // ---- 推：本地更新的上传新版本，再删旧版本 ----
  let pushed = 0
  for (const [wire, local] of locals) {
    const g = groups.get(wire)
    const st = stateByWire.get(wire)
    if (!needsPush(local, g, st)) {
      if (local.changed && !local.item && !g) {
        // 本地删除、远端从没有过：只记状态
        setState({ type: local.type, id: local.id, wire, hash: null, localVer: local.ver, remoteVer: st?.remoteVer ?? 0, deleted: true, skipped: false })
      }
      continue
    }
    if (pushed >= limit) {
      stats.more = true
      break
    }
    const adapter = byType.get(local.type)!
    const rec: VaultRecord = {
      v: 1,
      type: local.type,
      id: local.id,
      updatedAt: local.ver > 0 ? local.ver : now,
      deleted: !local.item,
      device: opts.device,
      deviceId: opts.deviceId,
      data: local.item ? local.item.data : null,
      ...(local.item && opts.refsOf ? { refs: opts.refsOf(local.item.data) } : {})
    }
    const size = recordSize(rec)
    if (size > maxBytes) {
      stats.oversize++
      stats.oversizeItems.push({ type: local.type, id: local.id, size })
      setState({ type: local.type, id: local.id, wire, hash: local.hash, localVer: local.ver, remoteVer: st?.remoteVer ?? 0, deleted: false, skipped: true })
      continue
    }
    const { raw } = await encodeVaultMessage(rec, { keyring, category: adapter.category, device: opts.device, now })
    await tx.append(folder, raw)
    g?.all.forEach(h => toDelete.add(h.uid))
    setState({ type: local.type, id: local.id, wire, hash: local.hash, localVer: rec.updatedAt, remoteVer: rec.updatedAt, deleted: !local.item, skipped: false })
    pushed++
    stats.pushed++
  }

  if (toDelete.size) {
    await tx.remove(folder, [...toDelete].sort((a, b) => a - b))
    stats.removed += toDelete.size
  }
  return stats
}
