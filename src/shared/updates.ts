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
  error?: string
}
