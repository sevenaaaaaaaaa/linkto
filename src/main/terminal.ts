import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import type { TerminalAppInfo, TerminalOpenResult } from '@shared/terminal'

const execFileAsync = promisify(execFile)

interface Candidate {
  id: string
  name: string
  paths: string[]
}

/**
 * macOS 常见终端。顺序也是偏好顺序：系统 Terminal 先，其后是第三方。
 * 只探测已安装的；菜单 / 设置按探测结果动态列出，不写死某个用户机器。
 */
const CANDIDATES: Candidate[] = [
  {
    id: 'com.apple.Terminal',
    name: '终端 Terminal',
    paths: ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app']
  },
  { id: 'com.googlecode.iterm2', name: 'iTerm2', paths: ['/Applications/iTerm.app', join(homedir(), 'Applications/iTerm.app')] },
  { id: 'dev.warp.Warp-Stable', name: 'Warp', paths: ['/Applications/Warp.app', join(homedir(), 'Applications/Warp.app')] },
  { id: 'com.github.wez.wezterm', name: 'WezTerm', paths: ['/Applications/WezTerm.app', join(homedir(), 'Applications/WezTerm.app')] },
  { id: 'org.alacritty', name: 'Alacritty', paths: ['/Applications/Alacritty.app', join(homedir(), 'Applications/Alacritty.app')] },
  { id: 'net.kovidgoyal.kitty', name: 'kitty', paths: ['/Applications/kitty.app', join(homedir(), 'Applications/kitty.app')] },
  { id: 'com.mitchellh.ghostty', name: 'Ghostty', paths: ['/Applications/Ghostty.app', join(homedir(), 'Applications/Ghostty.app')] },
  { id: 'co.zeit.hyper', name: 'Hyper', paths: ['/Applications/Hyper.app', join(homedir(), 'Applications/Hyper.app')] },
  { id: 'org.tabby', name: 'Tabby', paths: ['/Applications/Tabby.app', join(homedir(), 'Applications/Tabby.app')] }
]

function versionOf(appPath: string): string | undefined {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || undefined
  } catch {
    return undefined
  }
}

/** 只返回本机实际存在的终端；非 macOS 返回空 */
export function detectTerminalApps(): TerminalAppInfo[] {
  if (process.platform !== 'darwin') return []
  const out: TerminalAppInfo[] = []
  const seen = new Set<string>()
  for (const c of CANDIDATES) {
    const path = c.paths.find(p => existsSync(p))
    if (!path || seen.has(path)) continue
    seen.add(path)
    const version = versionOf(path)
    out.push({ id: c.id, name: c.name, path, ...(version ? { version } : {}) })
  }
  return out
}

/** 默认用系统 Terminal；没有则第一个检测到的 */
export function defaultTerminalId(apps: TerminalAppInfo[]): string | undefined {
  return apps.find(a => a.id === 'com.apple.Terminal')?.id ?? apps[0]?.id
}

/**
 * 在指定终端打开一个目录。用 /usr/bin/open -a <app> <dir>：
 *  - Terminal / iTerm / Warp 都会在新窗口/新标签里落到该目录
 *  - 不支持目录参数的终端会退化为“只打开应用”
 * 不做 shell 拼接，路径作为 argv 传入，避免命令注入。
 */
export async function openTerminalAt(appPath: string, cwd: string): Promise<TerminalOpenResult> {
  if (!existsSync(appPath)) return { ok: false, error: '终端应用不存在：' + appPath }
  if (!existsSync(cwd)) return { ok: false, error: '目录不存在：' + cwd }
  try {
    await execFileAsync('/usr/bin/open', ['-a', appPath, cwd], { timeout: 15000 })
    return { ok: true }
  } catch (err) {
    try {
      await execFileAsync('/usr/bin/open', ['-a', appPath], { timeout: 15000 })
      return { ok: true }
    } catch (fallbackErr) {
      const e = fallbackErr as { stderr?: string; message?: string }
      return { ok: false, error: (e.stderr || e.message || String(err)).slice(0, 300) }
    }
  }
}
