import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 原生工具栏回调（来自 NSToolbar 的按钮 / 搜索框） */
export interface MacShellAction {
  action: 'compose' | 'ghost' | 'settings' | 'search' | 'search-ai'
  query?: string
}

interface NativeShellModule {
  attach(handle: Buffer, callback: (action: MacShellAction) => void): boolean
  setTitle(text: string): void
  setSearch(text: string): void
  focusSearch(): void
}

let mod: NativeShellModule | null = null
let loaded = false
let attached = false

/** 只在 macOS 加载；失败（未编译 / 架构不符 / 旧系统）时静默回退到 Web 工具栏 */
function load(): NativeShellModule | null {
  if (loaded) return mod
  loaded = true
  if (process.platform !== 'darwin') return null
  const candidates = [
    join(process.resourcesPath, 'app.asar.unpacked/native/macos-shell/linkto_shell.node'),
    join(app.getAppPath(), 'native/macos-shell/linkto_shell.node'),
    join(app.getAppPath(), 'native/macos-shell/build/Release/linkto_shell.node')
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      mod = require(file) as NativeShellModule
      return mod
    } catch (err) {
      console.warn('[mac-shell] load failed:', file, err instanceof Error ? err.message : err)
    }
  }
  return null
}

/** 在当前主窗口上挂载真正的 NSToolbar；返回是否成功 */
export function attachMacShell(win: Electron.BrowserWindow, onAction: (a: MacShellAction) => void): boolean {
  const native = load()
  if (!native) return false
  try {
    attached = native.attach(win.getNativeWindowHandle(), onAction)
    return attached
  } catch (err) {
    console.warn('[mac-shell] attach failed:', err instanceof Error ? err.message : err)
    attached = false
    return false
  }
}

export function macShellSetTitle(title: string): void {
  if (attached) mod?.setTitle(title)
}

export function macShellSetSearch(text: string): void {
  if (attached) mod?.setSearch(text)
}

/** 聚焦原生搜索框；返回 false 表示没有原生壳，调用方应回退到 Web 搜索 */
export function macShellFocusSearch(): boolean {
  if (!attached || !mod) return false
  try {
    mod.focusSearch()
    return true
  } catch {
    return false
  }
}
