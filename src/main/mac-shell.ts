import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 原生工具栏回调（来自 NSToolbar 的按钮 / 搜索框） */
export interface MacShellAction {
  action: 'compose' | 'ghost' | 'settings' | 'search' | 'search-ai' | 'theme' | 'close'
  query?: string
}

interface NativeShellModule {
  attach(handle: Buffer, callback: (action: MacShellAction) => void, kind: 'main' | 'settings'): boolean
  setTitle(text: string): void
  setSearch(text: string): void
  focusSearch(): void
  customize(): boolean
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

function attach(win: Electron.BrowserWindow, onAction: (a: MacShellAction) => void, kind: 'main' | 'settings'): boolean {
  const native = load()
  if (!native) return false
  try {
    return native.attach(win.getNativeWindowHandle(), onAction, kind)
  } catch (err) {
    console.warn('[mac-shell] attach failed:', kind, err instanceof Error ? err.message : err)
    return false
  }
}

/** 主窗口：真正的 NSToolbar（搜索 / AI / 写邮件 / 幽灵信 / 设置） */
export function attachMacShell(win: Electron.BrowserWindow, onAction: (a: MacShellAction) => void): boolean {
  attached = attach(win, onAction, 'main')
  return attached
}

/** 设置窗口：轻量 NSToolbar（标题 / 切换外观 / 关闭），可原生自定义 */
export function attachSettingsShell(win: Electron.BrowserWindow, onAction: (a: MacShellAction) => void): boolean {
  return attach(win, onAction, 'settings')
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

/** 打开主窗口工具栏的原生自定义面板（拖动排序 / 显示隐藏，系统自动保存） */
export function macShellCustomize(): boolean {
  if (!attached || !mod) return false
  try {
    return mod.customize()
  } catch {
    return false
  }
}
