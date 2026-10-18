import type { FolderPref } from '@shared/types'
import type { AppStore } from '../store'

/** 文件夹偏好（置顶 / 是否同步），存 settings 表 'folderPrefs'：Record<folderId, FolderPref> */
const KEY = 'folderPrefs'

export const DEFAULT_FOLDER_PREF: FolderPref = { pinned: false, sync: true }

export function readFolderPrefs(appStore: AppStore): Record<string, FolderPref> {
  const raw = appStore.getRaw<Record<string, Partial<FolderPref>>>(KEY, {})
  const out: Record<string, FolderPref> = {}
  for (const [id, p] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    out[id] = { pinned: !!p?.pinned, sync: p?.sync !== false }
  }
  return out
}

export function writeFolderPref(appStore: AppStore, folderId: string, patch: Partial<FolderPref>): FolderPref {
  const all = readFolderPrefs(appStore)
  const cur = all[folderId] ?? DEFAULT_FOLDER_PREF
  const next: FolderPref = {
    pinned: typeof patch.pinned === 'boolean' ? patch.pinned : cur.pinned,
    sync: typeof patch.sync === 'boolean' ? patch.sync : cur.sync
  }
  // 与默认一致的条目不落库，保持设置表精简
  if (next.pinned === DEFAULT_FOLDER_PREF.pinned && next.sync === DEFAULT_FOLDER_PREF.sync) delete all[folderId]
  else all[folderId] = next
  appStore.set(KEY, all)
  return next
}
