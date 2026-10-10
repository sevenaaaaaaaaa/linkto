import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { CloudDriveConfig } from '@shared/types'
import type { AppStore } from '../store'

/**
 * 网盘备份模块：把邮件 eml 原文与附件保存到用户自己的云盘 / NAS。
 * - WebDAV：通用协议，覆盖群晖 DSM、威联通 QNAP、Nextcloud / ownCloud、Alist、坚果云等
 * - Dropbox：官方 HTTP API（长期访问令牌）
 * 密钥（WebDAV 密码 / Dropbox token）经 AppStore safeStorage 加密存钥匙串，配置本体明文存 KV。
 */

const KV_KEY = 'cloud-drives'
const SECRET_PREFIX = 'drive-'

export function listDrives(appStore: AppStore): CloudDriveConfig[] {
  return appStore.getRaw<CloudDriveConfig[]>(KV_KEY, [])
}

export function saveDrive(appStore: AppStore, cfg: CloudDriveConfig, secret: string): { ok: boolean; error?: string } {
  if (!cfg.name.trim()) return { ok: false, error: '名称不能为空' }
  if (cfg.kind === 'webdav' && !/^https?:\/\//i.test(cfg.url)) return { ok: false, error: 'WebDAV 服务器地址需以 http(s):// 开头' }
  if (cfg.kind === 'webdav' && !cfg.username.trim()) return { ok: false, error: 'WebDAV 需要用户名' }
  if (cfg.kind === 'dropbox' && !secret.trim()) return { ok: false, error: 'Dropbox 需要访问令牌' }
  const list = listDrives(appStore)
  const i = list.findIndex(d => d.id === cfg.id)
  if (i >= 0) list[i] = cfg
  else list.push(cfg)
  appStore.set(KV_KEY, list)
  if (secret.trim()) appStore.saveSecret(SECRET_PREFIX + cfg.id, secret.trim())
  return { ok: true }
}

export function removeDrive(appStore: AppStore, id: string): void {
  appStore.set(KV_KEY, listDrives(appStore).filter(d => d.id !== id))
  appStore.deleteSecret(SECRET_PREFIX + id)
}

function secretOf(appStore: AppStore, id: string): string {
  return appStore.loadSecret(SECRET_PREFIX + id)
}

/** 规范化远端根目录：确保以 / 开头、无尾斜杠；空则默认 /LinkTo */
function rootOf(cfg: CloudDriveConfig): string {
  let p = cfg.remotePath.trim() || '/LinkTo'
  if (!p.startsWith('/')) p = '/' + p
  return p.replace(/\/+$/, '')
}

// ================= WebDAV 客户端（fetch 实现，零依赖） =================

async function davReq(cfg: CloudDriveConfig, secret: string, path: string, method: string, body?: Buffer): Promise<Response> {
  const base = cfg.url.replace(/\/+$/, '')
  const headers: Record<string, string> = {
    Authorization: 'Basic ' + Buffer.from(`${cfg.username}:${secret}`, 'utf8').toString('base64')
  }
  if (body) headers['Content-Type'] = 'application/octet-stream'
  if (method === 'PROPFIND') headers.Depth = '0'
  return fetch(base + encodeURI(path), { method, headers, body: body ? new Uint8Array(body) : undefined })
}

async function davMkdirp(cfg: CloudDriveConfig, secret: string, dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean)
  let cur = ''
  for (const p of parts) {
    cur += '/' + p
    const res = await davReq(cfg, secret, cur + '/', 'MKCOL')
    // 405 = 目录已存在
    if (!res.ok && res.status !== 405) throw new Error(`创建目录 ${cur} 失败：HTTP ${res.status}`)
  }
}

async function davExists(cfg: CloudDriveConfig, secret: string, path: string): Promise<boolean> {
  const res = await davReq(cfg, secret, path, 'PROPFIND')
  return res.status === 207 || res.ok
}

// ================= Dropbox 客户端 =================

async function dbxMkdirp(token: string, dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean)
  let cur = ''
  for (const p of parts) {
    cur += '/' + p
    const res = await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: cur, autorename: false })
    })
    // 409 = 已存在
    if (!res.ok && res.status !== 409) throw new Error(`Dropbox 创建目录 ${cur} 失败：HTTP ${res.status}`)
  }
}

// ================= 统一上层接口 =================

async function driveUpload(appStore: AppStore, driveId: string, remotePath: string, data: Buffer): Promise<{ ok: boolean; error?: string; path?: string }> {
  const cfg = listDrives(appStore).find(d => d.id === driveId)
  if (!cfg) return { ok: false, error: '网盘不存在' }
  const secret = secretOf(appStore, driveId)
  if (!secret) return { ok: false, error: '网盘密钥缺失，请重新保存配置' }
  const full = rootOf(cfg) + remotePath
  try {
    if (cfg.kind === 'dropbox') {
      await dbxMkdirp(secret, full.split('/').slice(0, -1).join('/'))
      const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Dropbox-API-Arg': JSON.stringify({ path: full, mode: 'overwrite', autorename: false }),
          'Content-Type': 'application/octet-stream'
        },
        body: new Uint8Array(data)
      })
      if (!res.ok) throw new Error(`Dropbox 上传失败：HTTP ${res.status}`)
    } else {
      await davMkdirp(cfg, secret, full.split('/').slice(0, -1).join('/'))
      const res = await davReq(cfg, secret, full, 'PUT', data)
      if (!res.ok) throw new Error(`WebDAV 上传失败：HTTP ${res.status}`)
    }
    return { ok: true, path: full }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function driveExists(appStore: AppStore, driveId: string, remotePath: string): Promise<boolean> {
  const cfg = listDrives(appStore).find(d => d.id === driveId)
  if (!cfg) return false
  const secret = secretOf(appStore, driveId)
  const full = rootOf(cfg) + remotePath
  try {
    if (cfg.kind === 'dropbox') {
      const res = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: full })
      })
      return res.ok
    }
    return await davExists(cfg, secret, full)
  } catch {
    return false
  }
}

/** 连接测试：递归建根目录 + 上传探针文件 */
export async function driveTest(appStore: AppStore, driveId: string): Promise<{ ok: boolean; error?: string }> {
  const probe = Buffer.from(`LinkTo probe ${new Date().toISOString()}`)
  return driveUpload(appStore, driveId, '/.linkto-probe.txt', probe)
}

/** 文件名安全化：去掉路径分隔与控制字符 */
function safeName(name: string): string {
  return name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'untitled'
}

/** 上传单封邮件的 eml 原文（易读命名：日期-主题-uid.eml） */
export function uploadEml(appStore: AppStore, emlPath: string, subject: string, uid: number, date: number, driveId: string): Promise<{ ok: boolean; error?: string; path?: string }> {
  if (!existsSync(emlPath)) return Promise.resolve({ ok: false, error: 'eml 原文镜像尚未生成（联网同步后自动落盘），稍后再试' })
  const day = new Date(date || Date.now())
  const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`
  const name = safeName(`${stamp}-${subject || '无主题'}-${uid}`)
  return driveUpload(appStore, driveId, `/eml/${name}.eml`, readFileSync(emlPath))
}

/** 上传附件（按原始文件名，覆盖同名） */
export function uploadAttachment(appStore: AppStore, attachmentPath: string, filename: string, driveId: string): Promise<{ ok: boolean; error?: string; path?: string }> {
  if (!existsSync(attachmentPath)) return Promise.resolve({ ok: false, error: '附件文件不存在，请先联网让客户端拉取该附件' })
  return driveUpload(appStore, driveId, `/attachments/${safeName(filename)}`, readFileSync(attachmentPath))
}

/** 全量增量同步 eml 镜像：远端同结构 eml/<accountId>/<folder>/<uid>.eml，已存在则跳过 */
export async function syncEmlMirror(appStore: AppStore, driveId: string): Promise<{ ok: boolean; error?: string; uploaded?: number; skipped?: number }> {
  const emlDir = appStore.emlDir
  if (!existsSync(emlDir)) return { ok: false, error: '本地尚无 eml 镜像' }
  const tasks: { abs: string; rel: string }[] = []
  const walk = (dir: string, rel: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const relPath = `${rel}/${e.name}`
      if (e.isDirectory()) walk(join(dir, e.name), relPath)
      else if (e.isFile() && e.name.endsWith('.eml')) tasks.push({ abs: join(dir, e.name), rel: relPath })
    }
  }
  walk(emlDir, '')
  let uploaded = 0
  let skipped = 0
  // 串行上传，避免对 NAS 造成并发压力
  for (const t of tasks) {
    try {
      if (await driveExists(appStore, driveId, `/eml${t.rel}`)) {
        skipped++
        continue
      }
      const res = await driveUpload(appStore, driveId, `/eml${t.rel}`, readFileSync(t.abs))
      if (res.ok) uploaded++
    } catch {
      // 单文件失败不中断整体同步
    }
  }
  return { ok: true, uploaded, skipped }
}