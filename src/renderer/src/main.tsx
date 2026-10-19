import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import { initTheme } from './lib/theme'
import { applyPrefsToDocument } from './lib/prefs'
import './styles/global.css'
import { initDevSyncPrefs } from './lib/devsync-prefs'

initTheme()
applyPrefsToDocument()
// 个性化设置参与跨设备同步（设置 → 同步与备份）
initDevSyncPrefs()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
