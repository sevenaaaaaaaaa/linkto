import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Proton Drive for macOS 下载页（无公开 API，只能借助桌面客户端的本地同步目录） */
export const PROTON_DRIVE_DOWNLOAD_URL = 'https://proton.me/drive/download'

export interface ProtonDriveFolder {
  /** 同步目录绝对路径 */
  path: string
  /** 账户标识（从目录名解析，如 me@proton.me；旧版目录为空） */
  account: string
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 检测本机 Proton Drive 同步目录：
 * - 新版（File Provider）：~/Library/CloudStorage/ProtonDrive-<account>-folder，可能有多个账户
 * - 旧版：~/Proton Drive
 */
export function detectProtonDriveFolders(home: string = homedir()): ProtonDriveFolder[] {
  const found: ProtonDriveFolder[] = []
  const cloudStorage = join(home, 'Library/CloudStorage')
  try {
    for (const name of readdirSync(cloudStorage).sort()) {
      if (!name.toLowerCase().startsWith('protondrive')) continue
      const path = join(cloudStorage, name)
      if (!isDir(path)) continue
      const m = name.match(/^ProtonDrive-(.+?)(?:-folder)?$/i)
      found.push({ path, account: m?.[1] ?? '' })
    }
  } catch { /* CloudStorage 不存在则跳过 */ }
  const legacy = join(home, 'Proton Drive')
  if (existsSync(legacy) && isDir(legacy)) found.push({ path: legacy, account: '' })
  return found
}
