import { app, net, shell } from 'electron'
import type { UpdateAsset, UpdateCheckResult } from '@shared/updates'

/**
 * 在线更新检查：读取 GitHub Releases 的 latest，不依赖 electron-updater。
 *  - 只做「检查 + 打开发布页/下载安装包」，不静默替换正在运行的应用
 *  - GitHub 公共 API 有速率限制，结果缓存 5 分钟
 *  - 下载地址只允许 GitHub 域名，避免被伪造的 release 数据带偏
 */
const REPO = 'sevenaaaaaaaaa/linkto'
const RELEASES_URL = `https://github.com/${REPO}/releases`
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const CACHE_MS = 5 * 60_000
const MAX_NOTES = 12_000

let cache: { at: number; result: UpdateCheckResult } | null = null
let pending: Promise<UpdateCheckResult> | null = null

function parseVersion(v: string): { nums: number[]; pre: string } {
  const raw = v.replace(/^v/i, '').trim()
  const [base, pre = ''] = raw.split('-', 2)
  return { nums: base.split('.').map(n => Number.parseInt(n, 10) || 0), pre }
}

/** 语义版本比较：支持 0.4.2 / 0.4.1-nightly.20261022；正式版高于同号预发布 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  if (!x.pre && y.pre) return 1
  if (x.pre && !y.pre) return -1
  return x.pre === y.pre ? 0 : x.pre > y.pre ? 1 : -1
}

function pickAsset(assets: { name?: string; browser_download_url?: string; size?: number }[]): UpdateAsset | null {
  const named = assets
    .filter(a => a.name && a.browser_download_url)
    .map(a => ({ name: a.name!, url: a.browser_download_url!, size: a.size ?? 0 }))
  const mac = process.platform === 'darwin'
  const win = process.platform === 'win32'
  const linux = process.platform === 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  let candidates: UpdateAsset[] = []
  if (mac) {
    candidates = named.filter(a => /\.(dmg|zip)$/i.test(a.name) && (a.name.includes(arch) || !/x64/i.test(a.name)))
    const dmg = candidates.find(a => /\.dmg$/i.test(a.name))
    const zip = candidates.find(a => /\.zip$/i.test(a.name))
    return dmg ?? zip ?? candidates[0] ?? null
  }
  if (win) candidates = named.filter(a => /\.exe$/i.test(a.name))
  else if (linux) candidates = named.filter(a => /\.AppImage$/i.test(a.name))
  return candidates[0] ?? null
}

async function fetchLatest(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const res = await net.fetch(API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `LinkTo/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: controller.signal
    })
    if (res.status === 404) {
      return {
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        releaseUrl: RELEASES_URL,
        publishedAt: null,
        notes: 'GitHub 上还没有发布版本。',
        asset: null
      }
    }
    if (!res.ok) {
      const reason = res.status === 403 ? 'GitHub API 请求过于频繁，请稍后再试。' : `GitHub 返回 HTTP ${res.status}`
      return { currentVersion, latestVersion: null, hasUpdate: false, releaseUrl: RELEASES_URL, publishedAt: null, notes: '', asset: null, error: reason }
    }
    const data = (await res.json()) as {
      tag_name?: string
      body?: string
      html_url?: string
      published_at?: string
      assets?: { name?: string; browser_download_url?: string; size?: number }[]
    }
    const latestVersion = data.tag_name ? data.tag_name.replace(/^v/i, '') : null
    const hasUpdate = !!latestVersion && compareVersions(latestVersion, currentVersion) > 0
    const notes = (data.body ?? '').slice(0, MAX_NOTES)
    return {
      currentVersion,
      latestVersion,
      hasUpdate,
      releaseUrl: data.html_url ?? RELEASES_URL,
      publishedAt: data.published_at ?? null,
      notes,
      asset: hasUpdate ? pickAsset(data.assets ?? []) : null
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      releaseUrl: RELEASES_URL,
      publishedAt: null,
      notes: '',
      asset: null,
      error: aborted ? '连接 GitHub 超时，请检查网络后重试。' : '无法连接 GitHub，请检查网络后重试。'
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 检查最新版本；force=true 忽略 5 分钟缓存 */
export function checkForUpdates(force = false): Promise<UpdateCheckResult> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.result)
  if (pending) return pending
  pending = fetchLatest()
    .then(result => {
      if (!result.error) cache = { at: Date.now(), result }
      return result
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** 只允许打开 GitHub 的发布/下载地址 */
export async function openUpdateUrl(url: string): Promise<void> {
  try {
    const u = new URL(url)
    const allowed = u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname === 'objects.githubusercontent.com' || u.hostname === 'api.github.com')
    if (allowed) await shell.openExternal(url)
  } catch {
    /* 非法地址忽略 */
  }
}

export { RELEASES_URL }
