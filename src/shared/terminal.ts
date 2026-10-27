/** 本机终端应用探测（macOS）；设置与菜单共用 */
export interface TerminalAppInfo {
  id: string
  name: string
  path: string
  version?: string
}

export interface TerminalOpenResult {
  ok: boolean
  error?: string
}
