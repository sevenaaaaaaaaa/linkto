import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import { initTheme } from './lib/theme'
import { applyPrefsToDocument } from './lib/prefs'
import './styles/global.css'

initTheme()
applyPrefsToDocument()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
