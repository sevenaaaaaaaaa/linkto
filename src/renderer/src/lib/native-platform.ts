/**
 * macOS 原生外观开关：
 *  - data-os="mac"：系统字体（SF Pro / SF Mono）
 *  - data-native-material="1"：主窗口 / 设置窗口侧栏透出原生 vibrancy 磨砂
 * 撰写窗、幽灵信窗口保持实底（内容卡片对比度优先）。
 */
export const isMacOS = /Mac/i.test(navigator.platform) || /Macintosh/.test(navigator.userAgent)

export function initNativePlatform(): void {
  const el = document.documentElement
  el.dataset.os = isMacOS ? 'mac' : 'other'
  if (!isMacOS) return
  const isSettings = location.pathname.endsWith('settings.html')
  const isSheet = location.hash.startsWith('#/compose') || location.hash.startsWith('#/ghost')
  if (isSettings || !isSheet) el.dataset.nativeMaterial = '1'
  // 主进程成功挂上 NSToolbar 时，loadFile 会带 ?nativeShell=1；Web 顶部让出原生工具栏高度
  if (!isSheet && new URLSearchParams(location.search).get('nativeShell') === '1') el.dataset.nativeShell = '1'
}
