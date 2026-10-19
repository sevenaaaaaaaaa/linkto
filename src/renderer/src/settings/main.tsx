import ReactDOM from 'react-dom/client'
import SettingsApp from './SettingsApp'
import { initTheme } from '../lib/theme'
import { applyPrefsToDocument } from '../lib/prefs'
import '../styles/global.css'
import { initDevSyncPrefs } from '../lib/devsync-prefs'

// 设置窗与主窗口同一套明暗 / 主题预设 / 个性化（同源 localStorage）
initTheme()
applyPrefsToDocument()
// 个性化设置参与跨设备同步（设置 → 同步与备份）
initDevSyncPrefs()

ReactDOM.createRoot(document.getElementById('root')!).render(<SettingsApp />)
