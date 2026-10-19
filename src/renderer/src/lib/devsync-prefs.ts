import { api } from './api'
import { getPrefs, setPrefs, type UiPrefs } from './prefs'
import { getThemePref, setThemePref, activePresetId, setPreset, onThemeChange, type ThemePref } from './theme'

/**
 * 个性化设置的跨设备同步（界面层偏好存在 localStorage，主进程看不到）：
 * 本窗口偏好变化时推给主进程参与同步；收到其他设备同步来的偏好时写回 localStorage 并即时生效。
 * 未开启同步时主进程只是记一份，不连网。
 */
interface Snapshot {
  prefs: UiPrefs
  theme: ThemePref
  preset: string
}

const snapshot = (): Snapshot => ({ prefs: getPrefs(), theme: getThemePref(), preset: activePresetId() })

let applying = false
let timer: ReturnType<typeof setTimeout> | null = null

function push() {
  if (applying) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void api.devsyncPushUiPrefs?.(snapshot())?.catch(() => {})
  }, 1500)
}

function apply(raw: unknown) {
  const d = raw as Partial<Snapshot> | null
  if (!d || typeof d !== 'object') return
  applying = true
  try {
    if (d.prefs && typeof d.prefs === 'object') setPrefs(d.prefs)
    if (d.theme === 'auto' || d.theme === 'light' || d.theme === 'dark') if (d.theme !== getThemePref()) setThemePref(d.theme)
    if (typeof d.preset === 'string' && d.preset !== activePresetId()) setPreset(d.preset || null)
  } finally {
    applying = false
  }
}

export function initDevSyncPrefs() {
  try {
    window.addEventListener('ms:prefs', push)
    window.addEventListener('storage', e => {
      if (e.key === 'ms_ui_prefs' || e.key === 'ms_theme' || e.key === 'ms_preset') push()
    })
    onThemeChange(push)
    api.onEvent(ev => {
      const e = ev as { type?: string; data?: unknown }
      if (e.type === 'devsync-ui-prefs') apply(e.data)
    })
    push()
  } catch {
    /* 预览 / 测试环境没有 api */
  }
}
