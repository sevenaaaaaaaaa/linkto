import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import { initTheme } from './lib/theme'
import { applyPrefsToDocument } from './lib/prefs'
import './styles/global.css'
import { initDevSyncPrefs } from './lib/devsync-prefs'
import { initNativePlatform } from './lib/native-platform'
import { loadSystemSymbols } from './lib/system-symbols'

initNativePlatform()
// 撰写 / 幽灵信 / 焚毁阅读窗不加载整套 SF Symbols；它们只用少量图标，回退 SVG 即可
if (!/^#\/(compose|ghost|fly)/.test(location.hash)) loadSystemSymbols()
initTheme()
applyPrefsToDocument()
// 个性化设置参与跨设备同步（设置 → 同步与备份）
initDevSyncPrefs()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
