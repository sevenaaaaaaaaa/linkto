import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SF_SYMBOL_LIST } from '@shared/sf-symbols'

/**
 * macOS SF Symbols 运行时服务：
 *  - 用打包进来的 Swift 小工具调用 NSImage(systemSymbolName:)，渲染成透明底黑色 mask PNG
 *  - 第一次请求时渲染到 userData/system-symbols/v1/，之后直接读缓存
 *  - 非 macOS / 旧系统 / 工具缺失 / 单个 symbol 不存在 → 对应图标回退到 SVG（不阻塞 UI）
 * 不随安装包分发 Apple 图标资源，只在用户 Mac 上通过系统 API 生成。
 */
const execFileAsync = promisify(execFile)
const CACHE_VERSION = 'v1'
const POINT_SIZE = 18
let cache: Record<string, string> | null = null
let pending: Promise<Record<string, string>> | null = null

const fileOf = (dir: string, name: string) => join(dir, name.replace(/\./g, '_') + '.png')

function helperPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'sf-symbols') : join(app.getAppPath(), 'packaging/macos/sf-symbols')
}

async function renderAll(): Promise<Record<string, string>> {
  if (process.platform !== 'darwin') return {}
  const dir = join(app.getPath('userData'), 'system-symbols', CACHE_VERSION)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return {}
  }
  const missing = SF_SYMBOL_LIST.filter(name => !existsSync(fileOf(dir, name)))
  if (missing.length) {
    const bin = helperPath()
    if (existsSync(bin)) {
      try {
        await execFileAsync(bin, [dir, String(POINT_SIZE), ...missing], { timeout: 20_000, maxBuffer: 1024 * 1024 })
      } catch {
        /* 工具失败：已渲染的缓存仍然可用，其余回退 SVG */
      }
    }
  }
  const out: Record<string, string> = {}
  for (const name of SF_SYMBOL_LIST) {
    try {
      out[name] = `data:image/png;base64,${readFileSync(fileOf(dir, name)).toString('base64')}`
    } catch {
      /* 缺失的 symbol 由渲染层回退 */
    }
  }
  return out
}

/** 返回 symbol 名称 → data URL；结果在进程内缓存 */
export function systemSymbols(): Promise<Record<string, string>> {
  if (cache) return Promise.resolve(cache)
  if (pending) return pending
  pending = renderAll()
    .then(map => {
      // 空结果不缓存：首次启动时工具可能尚未就绪，后续调用还可以再试
      if (Object.keys(map).length) cache = map
      return map
    })
    .finally(() => {
      pending = null
    })
  return pending
}
