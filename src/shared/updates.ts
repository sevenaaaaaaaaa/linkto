/** 在线更新检查结果（GitHub Releases） */
export interface UpdateAsset {
  name: string
  url: string
  size: number
}

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string | null
  hasUpdate: boolean
  releaseUrl: string | null
  publishedAt: string | null
  notes: string
  asset: UpdateAsset | null
  /** Release 里的 SHA256SUMS.txt；没有它就不自动安装 */
  checksumsUrl?: string | null
  error?: string
}

/** 后台下载 / 安装状态 */
export type UpdatePhase = 'idle' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error'

export interface UpdateDownloadStatus {
  phase: UpdatePhase
  version?: string
  received: number
  total: number
  error?: string
  /** 已下载文件所在位置（主进程内部使用；渲染层不需要） */
  file?: string
}
