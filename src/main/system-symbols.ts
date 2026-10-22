import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SF_SYMBOL_LIST, type SfSymbolWeight } from '@shared/sf-symbols'

/**
 * macOS SF Symbols 运行时服务：
 *  - 用打包进来的 Swift 小工具调用 NSImage(systemSymbolName:)，渲染成透明底黑色 mask PNG
 *  - 首次请求时渲染到 userData/system-symbols/v2/<weight>/，之后直接读缓存
 *  - 字重（regular / medium / semibold）分开缓存，切换设置时只重渲染一次
 *  - 非 macOS / 旧系统 / 工具缺失 / 单个 symbol 不存在 → 对应图标回退到 SVG（不阻塞 UI）
 * 不随安装包分发 Apple 图标资源，只在用户 Mac 上通过系统 API 生成。
 */
const execFileAsync = promisify(execFile)
const CACHE_VERSION = 'v2'
const POINT_SIZE = 18
const caches = new Map<string, Record<string, string>>()
const pendings = new Map<string, Promise<Record<string, string>>>()

const fileOf = (dir: string, name: string) => join(dir, name.replace(/\./g, '_') + '.png')

function helperPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'sf-symbols') : join(app.getAppPath(), 'packaging/macos/sf-symbols')
}

const normalizeWeight = (weight: string): SfSymbolWeight =>
  weight === 'medium' || weight === 'semibold' ? weight : 'regular'

async function renderAll(weight: SfSymbolWeight): Promise<Record<string, string>> {
  if (process.platform !== 'darwin') return {}
  const dir = join(app.getPath('userData'), 'system-symbols', CACHE_VERSION, weight)
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
        await execFileAsync(bin, [dir, String(POINT_SIZE), weight, ...missing], { timeout: 20_000, maxBuffer: 1024 * 1024 })
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

/** 返回 symbol 名称 → data URL；按字重在进程内缓存 */
export function systemSymbols(weightInput: string = 'regular'): Promise<Record<string, string>> {
  const weight = normalizeWeight(String(weightInput ?? 'regular'))
  const cached = caches.get(weight)
  if (cached) return Promise.resolve(cached)
  const running = pendings.get(weight)
  if (running) return running
  const task = renderAll(weight)
    .then(map => {
      // 空结果不缓存：首次启动时工具可能尚未就绪，后续调用还可以再试
      if (Object.keys(map).length) caches.set(weight, map)
      return map
    })
    .finally(() => {
      pendings.delete(weight)
    })
  pendings.set(weight, task)
  return task
}
