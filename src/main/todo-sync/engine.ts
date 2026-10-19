/**
 * 一轮同步的编排（与传输解耦：IMAP 由 AccountWorker 适配，测试可用内存实现）。协议见 ./protocol.ts
 */
import {
  SYNC_FOLDER_NAME,
  KeyRing,
  TodoSyncError,
  decideApply,
  decodeMessage,
  encodeMessage,
  groupRemote,
  headerMeta,
  planPull,
  planPush,
  toWire,
  wireIdFor,
  type LocalTodo,
  type RemoteHeader
} from './protocol'

/** 同步文件夹的读写（实现必须串行化、不与邮件同步穿插） */
export interface SyncTransport {
  ensureFolder(name: string): Promise<string>
  fetchHeaders(folder: string, names: string[]): Promise<{ uid: number; headers: Record<string, string> }[]>
  download(folder: string, uid: number): Promise<Buffer | null>
  append(folder: string, raw: Buffer): Promise<unknown>
  remove(folder: string, uids: number[]): Promise<void>
}

/** 本地待办存取 */
export interface SyncLocalStore {
  list(): LocalTodo[]
  /** 写入远端版本：data.updatedAt 原样保留，不刷新 */
  upsert(t: LocalTodo): void
  hasAccount(id: string): boolean
  hasMessage(id: string): boolean
}

export interface RoundStats {
  pulled: number
  pushed: number
  removed: number
  /** 本轮写过本地（即使中途出错，调用方也应刷新界面） */
  changedLocal: boolean
  /** 超出单轮上限，需要再跑一轮 */
  more: boolean
}

export const newStats = (): RoundStats => ({ pulled: 0, pushed: 0, removed: 0, changedLocal: false, more: false })

/** 一轮：拉头 → 拉新（LWW 落地）→ 推新 → 删除重复 / 旧版本 / 过期墓碑 */
export async function syncRound(opts: {
  transport: SyncTransport
  local: SyncLocalStore
  keyring: KeyRing | null
  device?: string
  now?: number
  limit?: number
  stats?: RoundStats
  /** 同步文件夹（默认待办的 LinkTo-Sync；留痕用 LinkTo-Trace，同一协议） */
  folder?: string
}): Promise<RoundStats> {
  const { transport: tx, local: db, keyring } = opts
  const now = opts.now ?? Date.now()
  const limit = opts.limit ?? 200
  const stats = opts.stats ?? newStats()
  const indexKey = keyring ? await keyring.indexKey() : null

  const folder = await tx.ensureFolder(opts.folder ?? SYNC_FOLDER_NAME)
  const remote: RemoteHeader[] = (await tx.fetchHeaders(folder, ['X-LinkTo-Todo', 'X-LinkTo-Updated', 'X-LinkTo-Encrypted']))
    .map(m => headerMeta(m.uid, m.headers))
    .filter((h): h is RemoteHeader => !!h)

  const wireMap = (list: LocalTodo[]) => new Map(list.map(t => [wireIdFor(t.id, indexKey), t.id]))
  let local = db.list()
  let groups = groupRemote(remote, wireMap(local))
  const toDelete = new Set<number>()

  // ---- 拉：远端更新的下载正文，后写者胜落地 ----
  const pull = planPull(local, groups)
  pull.duplicates.forEach(u => toDelete.add(u))
  if (pull.download.length > limit) stats.more = true
  const byId = new Map(local.map(t => [t.id, t]))
  for (const h of pull.download.slice(0, limit)) {
    const raw = await tx.download(folder, h.uid)
    if (!raw) continue
    let wire
    try {
      wire = await decodeMessage(raw, keyring)
    } catch (err) {
      // 口令错误 / 缺口令：整轮中止，绝不拿本地数据覆盖读不懂的远端
      if (err instanceof TodoSyncError && err.code !== 'format') throw err
      // 损坏的单封：删掉，免得每轮重复下载
      toDelete.add(h.uid)
      continue
    }
    const { action, purge } = decideApply(byId.get(wire.id), wire, now)
    if (purge) toDelete.add(h.uid)
    if (action === 'skip') continue
    db.upsert({
      id: wire.id,
      title: wire.title,
      status: wire.status,
      dueAt: wire.dueAt,
      createdAt: wire.createdAt,
      // 关联的账户 / 邮件在本机不存在时不挂（各设备账户 id 可能不同）
      accountId: wire.accountId && db.hasAccount(wire.accountId) ? wire.accountId : null,
      messageId: wire.messageId && db.hasMessage(wire.messageId) ? wire.messageId : null,
      data: { ...wire.data, updatedAt: wire.updatedAt }
    })
    stats.pulled++
    stats.changedLocal = true
  }

  // ---- 推：本地更新的上传新版本，再删旧版本 ----
  if (stats.changedLocal) {
    local = db.list()
    groups = groupRemote(remote, wireMap(local))
  }
  const push = planPush(local, groups, now)
  push.purge.forEach(u => toDelete.add(u))
  if (push.push.length > limit) stats.more = true
  for (const { todo, supersedes } of push.push.slice(0, limit)) {
    const { raw } = await encodeMessage(toWire(todo, opts.device), { keyring, device: opts.device, now })
    await tx.append(folder, raw)
    supersedes.forEach(u => toDelete.add(u))
    stats.pushed++
  }

  if (toDelete.size) {
    await tx.remove(folder, [...toDelete].sort((a, b) => a - b))
    stats.removed = toDelete.size
  }
  return stats
}
