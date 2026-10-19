import { useEffect, useRef, useState } from 'react'
import { useView, goView, viewFromHash } from '../lib/route'
import { initLiquidGlass } from '../lib/liquid-glass'
import { Sidebar } from './Sidebar'
import { AccountRail } from './AccountRail'
import { FolderManager } from './FolderManager'
import { TriageView } from './TriageView'
import { TodoView } from './TodoView'
import { FinanceView } from './finance/FinanceView'
import { LifeView } from './life/LifeView'
import { FeedsView } from './feeds/FeedsView'
import { TraceView } from './trace/TraceView'
import { TraceCaptureHost } from './trace/TraceCapture'
import { openFinance } from '../lib/finance'
import { ContextRail } from './ContextRail'
import { MovePalette } from './MovePalette'
import { CoachTip } from './Guidance'
import { getPrefs, usePrefs } from '../lib/prefs'
import { useInsightEvents } from '../lib/insights'
import { MessageList } from './MessageList'
import { Reader } from './Reader'
import { KbView } from './KbView'
import { InsightsView } from './InsightsView'
import { AgentView } from './AgentView'
import { AttachmentsView } from './attachments/AttachmentsView'
import { ProjectsView } from './projects/ProjectsView'
import { ProjectPickerHost } from './projects/ProjectBits'
import { OnboardingScanHost } from './agent/AutomationPanel'
import { SkillRunHost } from './agent/skill-ui'
import { ContentAccessHost } from './attachments/ContentAccess'
import { UpgradeWizardHost } from './upgrade/UpgradeWizard'
import { CommandPalette } from './CommandPalette'
import { ShareHost, openShare, currentShareIds } from './share/SharePanel'
import { LensLayer, RipplePanel, SonarBar, DropWell } from './interactions'
import { useMail } from '../stores/mail'
import { api } from '../lib/api'
import { cycleTheme, themeLabel } from '../lib/theme'
import { IconClock } from '../components/icons'
import type { ScheduledSend } from '@shared/types'
import { describeAIError, friendlyFailure, isAIError, type ToastPayload } from '../lib/ai-error'
import { useConnectivity } from '../lib/connectivity'

export function MailShell() {
  const view = useView()
  const triage = useMail(st => st.triage)
  const rail = useMail(st => st.rail)
  usePrefs() // 订阅个性化偏好：设置窗改动后即时应用到根节点
  useInsightEvents()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [toast, setToastState] = useState<ToastPayload | null>(null)
  const toastTimer = useRef(0)
  /** 全局 toast：字符串（旧用法）或带动作按钮的对象；字符串若是可识别的 AI 错误，自动附上「去设置 AI」等动作 */
  const setToast = (detail: string | ToastPayload | null | undefined, fallbackMs = 2200) => {
    window.clearTimeout(toastTimer.current)
    if (!detail) return setToastState(null)
    let payload: ToastPayload = typeof detail === 'string' ? { text: detail } : detail
    if (typeof detail === 'string' && isAIError(detail)) {
      const v = describeAIError(detail)
      payload = { text: v.text, actions: v.action ? [v.action] : undefined, tone: 'danger' }
    }
    setToastState(payload)
    const ms = payload.duration ?? (payload.actions?.length ? 6000 : fallbackMs)
    toastTimer.current = window.setTimeout(() => setToastState(null), ms)
  }
  useConnectivity(setToast)
  const [outbox, setOutbox] = useState<ScheduledSend[]>([])

  // Liquid Glass 真折射滤镜（lensing）：Electron/Chromium 下启用，其余环境纯 blur 降级
  useEffect(() => {
    initLiquidGlass()
  }, [])

  const loadOutbox = () => void api.listScheduledSends().then(setOutbox)

  // 全局 toast（主题 / 预设 / 命令面板反馈）+ 发件队列事件
  useEffect(() => {
    const onToast = (e: Event) => setToast((e as CustomEvent<string | ToastPayload>).detail)
    window.addEventListener('ms:toast', onToast)
    return () => window.removeEventListener('ms:toast', onToast)
  }, [])

  useEffect(() => {
    loadOutbox()
    // 账户状态实时刷新（节流 1s，同步引擎状态变化频繁）
    let statusTimer = 0
    let progressTimer = 0
    const onEv = (ev: unknown) => {
      const e = ev as { type: string; subject?: string; to?: string; accountId?: string; text?: string }
      if (e.type === 'outbox-changed') loadOutbox()
      // 托盘 / ⌥⌘T「新建待办」、待办提醒点击：切到待办页再交给 TodoView（等它挂载）
      if (e.type === 'quick-add-todo' || e.type === 'open-todo') {
        goView('todo')
        const id = (e as { id?: string }).id
        setTimeout(() => window.dispatchEvent(new CustomEvent(e.type === 'open-todo' ? 'ms:todo-open' : 'ms:todo-quick', { detail: id })), 250)
      }
      // 款项提醒点击：打开财务页对应款项
      if (e.type === 'open-finance') openFinance((e as { id?: string }).id)
      if (e.type === 'mail-sent') {
        setToast(`已发送：${e.subject ?? ''}`, 2600)
      }
      if (e.type === 'account-status') {
        // 同步完成/出错时清除进度条文本
        if (e.accountId && (e.text === '已连接' || e.text === '连接失败' || e.text === '已停用')) {
          useMail.getState().setSyncProgress(e.accountId, '')
        }
        if (!statusTimer) statusTimer = window.setTimeout(() => { statusTimer = 0; void useMail.getState().loadAccounts() }, 1000)
      }
      if (e.type === 'sync-progress' && e.accountId) {
        if (!progressTimer) progressTimer = window.setTimeout(() => { progressTimer = 0 }, 300)
        useMail.getState().setSyncProgress(e.accountId, e.text ?? '')
      }
    }
    const off = api.onEvent(onEv)
    return () => {
      void off()
      if (statusTimer) clearTimeout(statusTimer)
      if (progressTimer) clearTimeout(progressTimer)
    }
  }, [])

  // 侧栏 ⌘K 按钮等入口
  useEffect(() => {
    const onToggle = () => setPaletteOpen(o => !o)
    window.addEventListener('ms:toggle-palette', onToggle)
    return () => window.removeEventListener('ms:toggle-palette', onToggle)
  }, [])

  // 全局指针跟随高光：为 [data-glow] 元素写入 --mx/--my，让光斑随鼠标在玻璃表面流动
  useEffect(() => {
    let raf = 0
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const el = (e.target as HTMLElement).closest?.('[data-glow]') as HTMLElement | null
        if (!el) return
        const r = el.getBoundingClientRect()
        el.style.setProperty('--mx', `${e.clientX - r.left}px`)
        el.style.setProperty('--my', `${e.clientY - r.top}px`)
      })
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      const meta = e.metaKey || e.ctrlKey

      if (meta && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setPaletteOpen(o => !o)
        return
      }
      // ⌘⇧E：分享 / 导出面板（当前邮件或多选）
      if (meta && e.shiftKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault()
        openShare(currentShareIds())
        return
      }
      // ⌘J：阅读页右侧栏切到 Agent（再按一次收起）
      if (meta && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault()
        goView('mail')
        useMail.getState().toggleRail('agent')
        return
      }
      // ⌘1…⌘9 切到第 N 个账户，⌘0 回到全部账户（与账户栏顺序一致）
      if (meta && /^[0-9]$/.test(e.key) && !typing) {
        e.preventDefault()
        const { accounts, setAccountCtx } = useMail.getState()
        const n = Number(e.key)
        if (n === 0) setAccountCtx(null)
        else if (accounts[n - 1]) setAccountCtx(accounts[n - 1].id)
        return
      }
      if (meta && (e.key === 't' || e.key === 'T') && !typing) {
        e.preventDefault()
        const next = cycleTheme()
        window.dispatchEvent(new CustomEvent('ms:toast', { detail: `主题：${themeLabel(next)}` }))
        return
      }
      if (meta && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        void useMail.getState().loadAccounts()
        void useMail.getState().loadFolders()
        void useMail.getState().loadMessages()
        return
      }
      if (typing) return
      // 单键快捷键可在「个性化」里关闭（与输入法 / 无障碍工具冲突时）
      if (!meta && !getPrefs().singleKey && /^[a-zA-Z]$/.test(e.key)) return

      const state = useMail.getState()
      const idx = state.messages.findIndex(m => m.id === state.selectedId)
      // Esc：退出多选模式
      if (e.key === 'Escape' && (state.selectedIds.size > 1 || (state.selectedIds.size === 1 && !state.selectedIds.has(state.selectedId ?? '')))) {
        useMail.setState({ selectedIds: state.selectedId ? new Set([state.selectedId]) : new Set() })
        return
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        const next = state.messages[Math.min(idx + 1, state.messages.length - 1)]
        if (next) state.select(next.id)
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = state.messages[Math.max(idx - 1, 0)]
        if (prev) state.select(prev.id)
      } else if (e.key === 'r' && state.selectedId) {
        void api.openCompose({
          accountId: state.messages[idx]?.accountId,
          to: state.messages[idx]?.from ? [state.messages[idx].from!] : [],
          subject: `回复：${state.messages[idx]?.subject ?? ''}`,
          relatedMessageId: state.selectedId
        } as never)
      } else if ((e.key === 't' || e.key === 'T') && state.selectedId && viewFromHash() === 'mail') {
        // 邮件转待办：用邮件理解的建议 / 截止生成，已存在则不重复
        e.preventDefault()
        void api.todoFromMessage(state.selectedId).then(id => {
          window.dispatchEvent(new CustomEvent('ms:toast', { detail: id ? '已加入待办（侧栏「待办」查看）' : '没能转成待办' }))
        })
      } else if ((e.key === 'v' || e.key === 'V') && state.selectedId) {
        // 移动面板：AI 先猜目标文件夹
        e.preventDefault()
        const ids = state.selectedIds.size > 1 ? [...state.selectedIds] : [state.selectedId]
        window.dispatchEvent(new CustomEvent('ms:move', { detail: ids }))
      } else if ((e.key === 'a' || e.key === 'e') && state.selectedId) {
        const id = state.selectedId
        // Triage：归档后自动跳下一封（单遍清空节奏）
        const next = state.messages[idx + 1] ?? state.messages[idx - 1]
        void api.moveMessages([id], 'archive').then(() => state.loadMessages()).catch(err => setToast(friendlyFailure('归档失败', err)))
        if (next) state.select(next.id)
        // 波纹批量：单发归档触发同类邮件涌现建议
        window.dispatchEvent(new CustomEvent('ms:ripple', { detail: { ids: [id], action: 'archive' } }))
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedId) {
        const id = state.selectedId
        const next = state.messages[idx + 1] ?? state.messages[idx - 1]
        void api.deleteMessages([id]).then(() => state.loadMessages()).catch(err => setToast(friendlyFailure('删除失败', err)))
        if (next) state.select(next.id)
        window.dispatchEvent(new CustomEvent('ms:ripple', { detail: { ids: [id], action: 'trash' } }))
      } else if ((e.key === 's' || e.key === 'S') && state.selectedId) {
        // Triage：稍后处理（到点自动回归收件箱）
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('ms:snooze-menu', { detail: [state.selectedId] }))
      } else if (e.key === 'f' && meta) {
        e.preventDefault()
        ;(document.querySelector('input[data-mail-search]') as HTMLInputElement | null)?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="h-full flex">
      <AccountRail />
      <Sidebar />
      <FolderManager />
      <CoachTip />
      <LensLayer />
      <RipplePanel />
      <SonarBar />
      {view === 'kb' ? <KbView /> : view === 'insights' ? <InsightsView /> : view === 'agent' ? <AgentView /> : view === 'todo' ? <TodoView /> : view === 'attachments' ? <AttachmentsView /> : view === 'projects' ? <ProjectsView /> : view === 'finance' ? <FinanceView /> : view === 'life' ? <LifeView /> : view === 'feeds' ? <FeedsView /> : view === 'trace' ? <TraceView /> : triage ? <TriageView /> : (
        <>
          <MessageList />
          <Reader />
          <ContextRail />
          <MovePalette />
          {/* 液态投放井：仅邮件视图且右侧栏收起时（避免压住 Agent 输入框）；发件队列打开时自动上移让位 */}
          {!rail && <DropWell bottom={outbox.length ? 296 : 24} />}
        </>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ProjectPickerHost />
      <SkillRunHost />
      <OnboardingScanHost />
      <ContentAccessHost />
      <UpgradeWizardHost />
      <ShareHost />
      <TraceCaptureHost />

      {/* 发件队列（延迟 / 定时发送）：右下角浮条，可逐条撤销 */}
      {outbox.length > 0 && (
        <div className="fixed bottom-6 right-6 z-40 w-[300px] liquid-glass rounded-[var(--r-md)] p-2 pop-in">
          <div className="px-2 pt-1 pb-1.5 text-2xs font-semibold tracking-[0.06em] uppercase" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
            发件队列 · {outbox.length}
          </div>
          <div className="flex flex-col gap-0.5 max-h-[220px] overflow-y-auto">
            {outbox.map(s => (
              <div key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg">
                <span className="leading-none shrink-0" style={{ color: 'var(--warn)' }}><IconClock width={14} height={14} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate" style={{ color: 'var(--fg)' }}>{s.subject || '（无主题）'}</div>
                  <div className="text-2xs" style={{ color: 'var(--faint)' }}>
                    {new Date(s.sendAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} → {s.to[0] ?? ''}
                  </div>
                </div>
                <button
                  onClick={() => void api.cancelScheduledSend(s.id)}
                  className="text-xs px-2 py-1 rounded-lg shrink-0 hover:bg-[var(--hover)]"
                  style={{ color: 'var(--danger)' }}
                >
                  撤销
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && (
        <div
          role={toast.tone === 'danger' ? 'alert' : 'status'}
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[min(560px,calc(100vw-48px))] flex items-center gap-3 liquid-glass text-sm fade-in ${
            toast.actions?.length ? 'pl-4 pr-1.5 py-1.5 rounded-[var(--r-md)]' : 'px-4 py-2 rounded-full'
          }`}
          style={{ color: 'var(--fg)' }}
        >
          {toast.tone === 'danger' && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--danger)' }} />}
          <span className="min-w-0">{toast.text}</span>
          {toast.actions?.map(a => (
            <button
              key={a.label}
              onClick={() => {
                a.run()
                setToast(null)
              }}
              className="shrink-0 h-7 px-3 rounded-[var(--r-sm)] text-xs font-medium transition-opacity hover:opacity-90"
              style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
