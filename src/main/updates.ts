import { app, net, shell } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import { checksumFor } from './update-checksums'
import { INSTALL_SCRIPT } from './update-install-script'
import type { UpdateAsset, UpdateCheckResult, UpdateDownloadStatus } from '@shared/updates'

/**
 * 在线更新：检查 → 后台下载 → SHA-256 校验 → 重启/退出安装。
 *
 * 安全约束：
 *  - 只从 GitHub 域名下载安装包与 SHA256SUMS.txt
 *  - 没有校验清单就不自动安装
 *  - 安装脚本等应用退出后才替换当前 .app；新版本启动失败会回滚
 *  - 只在 macOS 安装版（app.isPackaged）上自动安装
 */
const REPO = 'sevenaaaaaaaaa/linkto'
const RELEASES_URL = 'https://github.com/' + REPO + '/releases'
const API_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest'
const CACHE_MS = 5 * 60_000
const MAX_NOTES = 12_000
const MAX_CHECKSUMS_BYTES = 256 * 1024

let cache: { at: number; result: UpdateCheckResult } | null = null
let pending: Promise<UpdateCheckResult> | null = null

let downloadState: UpdateDownloadStatus = { phase: 'idle', received: 0, total: 0 }
let readyHash: string | null = null
let installing = false
let downloadTask: Promise<{ ok: boolean; error?: string }> | null = null

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

function allowedDownloadUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    const h = u.hostname
    return h === 'github.com' || h === 'api.github.com' || h.endsWith('.githubusercontent.com')
  } catch {
    return false
  }
}

function userAgent(): string {
  return 'LinkTo/' + app.getVersion()
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
        'User-Agent': userAgent(),
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
        asset: null,
        checksumsUrl: null
      }
    }
    if (!res.ok) {
      const reason = res.status === 403 ? 'GitHub API 请求过于频繁，请稍后再试。' : 'GitHub 返回 HTTP ' + res.status
      return { currentVersion, latestVersion: null, hasUpdate: false, releaseUrl: RELEASES_URL, publishedAt: null, notes: '', asset: null, checksumsUrl: null, error: reason }
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
    const checksumAsset = (data.assets ?? []).find(a => a.name?.toLowerCase() === 'sha256sums.txt' && a.browser_download_url)
    return {
      currentVersion,
      latestVersion,
      hasUpdate,
      releaseUrl: data.html_url ?? RELEASES_URL,
      publishedAt: data.published_at ?? null,
      notes,
      asset: hasUpdate ? pickAsset(data.assets ?? []) : null,
      checksumsUrl: checksumAsset?.browser_download_url ?? null
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
      checksumsUrl: null,
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
    if (allowedDownloadUrl(url) && (u.hostname === 'github.com' || u.hostname === 'api.github.com')) {
      await shell.openExternal(url)
    }
  } catch {
    /* 非法地址忽略 */
  }
}

// ---------------------------------------------------------------------------
// 下载 + 校验
// ---------------------------------------------------------------------------

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function fetchFollowing(url: string, init: RequestInit): Promise<Response> {
  // Electron 的 net.fetch 跟随跳转后不再暴露最终 URL（res.url 为空），
  // 因此校验发起地址；GitHub 自己的 release 跳转由 TLS + GitHub 控制。
  if (!allowedDownloadUrl(url)) throw new Error('下载地址不在 GitHub 域名内')
  const res = await net.fetch(url, { ...init, redirect: 'follow' })
  if (res.url && !allowedDownloadUrl(res.url)) throw new Error('跳转后的下载地址不在 GitHub 域名内')
  return res
}

async function fetchChecksum(result: UpdateCheckResult, asset: UpdateAsset): Promise<string> {
  if (!result.checksumsUrl) throw new Error('该版本没有 SHA256SUMS.txt，已停止自动安装')
  const res = await fetchFollowing(result.checksumsUrl, {
    headers: { 'User-Agent': userAgent(), accept: 'text/plain' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error('下载校验清单失败：HTTP ' + res.status)
  const text = await res.text()
  if (text.length > MAX_CHECKSUMS_BYTES) throw new Error('校验清单过大')
  const sum = checksumFor(text, asset.name)
  if (!sum) throw new Error('校验清单里没有 ' + asset.name)
  return sum
}

async function downloadTo(url: string, tmp: string, totalHint: number): Promise<{ hash: string; size: number }> {
  const res = await fetchFollowing(url, {
    headers: { 'User-Agent': userAgent() },
    signal: AbortSignal.timeout(15 * 60_000)
  })
  if (!res.ok) throw new Error('下载失败：HTTP ' + res.status)
  if (!res.body) throw new Error('下载响应为空')
  const total = Number(res.headers.get('content-length') ?? 0) || totalHint
  const hash = createHash('sha256')
  const out = createWriteStream(tmp)
  let received = 0
  let lastTick = 0
  try {
    for await (const chunk of Readable.fromWeb(res.body as never)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      hash.update(buf)
      received += buf.length
      if (!out.write(buf)) {
        await new Promise<void>((resolveDrain, rejectDrain) => {
          const onDrain = () => {
            out.off('error', onError)
            resolveDrain()
          }
          const onError = (err: Error) => {
            out.off('drain', onDrain)
            rejectDrain(err)
          }
          out.once('drain', onDrain)
          out.once('error', onError)
        })
      }
      const now = Date.now()
      if (now - lastTick > 250) {
        lastTick = now
        downloadState = { ...downloadState, received, total: total || downloadState.total }
      }
    }
    await new Promise<void>((resolveEnd, rejectEnd) => {
      out.once('error', rejectEnd)
      out.end(resolveEnd)
    })
  } catch (err) {
    out.destroy()
    throw err
  }
  return { hash: hash.digest('hex'), size: received }
}

export function getUpdateStatus(): UpdateDownloadStatus {
  return { ...downloadState }
}

export function hasReadyUpdate(): boolean {
  return downloadState.phase === 'ready'
}

export function isUpdateInstalling(): boolean {
  return installing
}

/** 后台下载当前最新版；重复调用返回同一个任务 */
export function startUpdateDownload(): Promise<{ ok: boolean; error?: string }> {
  if (downloadState.phase === 'ready') return Promise.resolve({ ok: true })
  if (downloadTask) return downloadTask
  downloadTask = (async () => {
    try {
      const result = await checkForUpdates(false)
      if (!result.hasUpdate || !result.asset) return { ok: false, error: '当前没有可用更新' }
      const asset = result.asset
      const expected = await fetchChecksum(result, asset)
      const version = result.latestVersion ?? 'unknown'
      const dir = join(app.getPath('userData'), 'updates', version)
      mkdirSync(dir, { recursive: true })
      const safeName = asset.name.replace(/[^A-Za-z0-9._-]+/g, '_')
      const file = join(dir, safeName)
      if (existsSync(file) && statSync(file).size > 0) {
        const hash = await sha256File(file)
        if (hash === expected) {
          readyHash = expected
          downloadState = { phase: 'ready', version, received: statSync(file).size, total: statSync(file).size, file }
          return { ok: true }
        }
        rmSync(file, { force: true })
      }
      const tmp = file + '.part'
      rmSync(tmp, { force: true })
      downloadState = { phase: 'downloading', version, received: 0, total: asset.size, file }
      const got = await downloadTo(asset.url, tmp, asset.size)
      downloadState = { ...downloadState, phase: 'verifying', received: got.size, total: got.size || asset.size }
      if (got.hash !== expected) {
        rmSync(tmp, { force: true })
        downloadState = { phase: 'error', version, received: 0, total: asset.size, error: 'SHA-256 校验失败，已丢弃下载文件' }
        return { ok: false, error: downloadState.error }
      }
      renameSync(tmp, file)
      readyHash = expected
      downloadState = { phase: 'ready', version, received: got.size, total: got.size, file }
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      downloadState = { ...downloadState, phase: 'error', error: message }
      return { ok: false, error: message }
    } finally {
      downloadTask = null
    }
  })()
  return downloadTask
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------



export async function installUpdate(): Promise<{ ok: boolean; error?: string }> {
  if (installing) return { ok: false, error: '正在安装' }
  if (downloadState.phase !== 'ready' || !downloadState.file) return { ok: false, error: '还没有下载完成的更新' }
  if (process.platform !== 'darwin') return { ok: false, error: '自动安装目前只支持 macOS；请打开发布页手动安装' }
  if (!app.isPackaged) return { ok: false, error: '开发环境不支持自动安装' }
  try {
    const appPath = resolve(app.getPath('exe'), '../../..')
    if (!appPath.endsWith('.app')) return { ok: false, error: '无法定位当前应用包' }
    const expected = readyHash ?? (await sha256File(downloadState.file))
    const actual = await sha256File(downloadState.file)
    if (actual !== expected) return { ok: false, error: '安装包校验失败，请重新下载' }
    const scriptPath = join(app.getPath('userData'), 'update-install.sh')
    writeFileSync(scriptPath, INSTALL_SCRIPT, { mode: 0o755 })
    const version = downloadState.version ?? 'unknown'
    const child = spawn('/bin/sh', [scriptPath, appPath, downloadState.file, expected, version], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    installing = true
    downloadState = { ...downloadState, phase: 'installing' }
    setTimeout(() => app.quit(), 300)
    setTimeout(() => app.exit(0), 10_000)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 新版本成功启动后删掉上一版备份（安装脚本会保留到新版本启动成功） */
export function cleanupOldUpdateBundle(): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  try {
    const appPath = resolve(app.getPath('exe'), '../../..')
    const old = appPath + '.old'
    if (existsSync(old)) rmSync(old, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

export { RELEASES_URL }
