import { useEffect, useState } from 'react'
import { useMail } from '../stores/mail'
import { api } from '../lib/api'
import { goAgent } from '../lib/route'
import { IconClose } from '../components/icons'

const DISMISS_KEY = 'ms_onboard_dismissed'
export const TRIAGE_DONE_KEY = 'ms_triage_cleared'

function safeGet(k: string) {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* 存储不可用时只影响本次 */
  }
}

/**
 * 「让 LinkTo 认识你」：五步清单，完成情况自动检测（不靠用户手动勾）。
 * 全部完成或关闭后不再出现；每一步点击直接跳到对应位置。
 */
export function OnboardingCard() {
  const accounts = useMail(st => st.accounts)
  const [hidden, setHidden] = useState(() => safeGet(DISMISS_KEY) === '1')
  const [state, setState] = useState({ ai: false, memory: false, mcp: false })
  const triageDone = safeGet(TRIAGE_DONE_KEY) === '1'

  useEffect(() => {
    if (hidden) return
    const check = () => {
      void Promise.all([
        api.aiStatus().catch(() => ({ ready: false })),
        api.memoryStats().catch(() => ({ total: 0 })),
        api.getMcpStatus().catch(() => ({ enabled: false }))
      ]).then(([ai, mem, mcp]) => setState({ ai: ai.ready, memory: (mem as { total: number }).total > 0, mcp: (mcp as { enabled: boolean }).enabled }))
    }
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [hidden])

  if (hidden) return null
  const steps = [
    { label: '连接你的邮箱', done: accounts.length > 0, go: () => api.openSettings('accounts') },
    { label: '选择 AI 模型（云端或本地）', done: state.ai, go: () => api.openSettings('ai') },
    { label: '用「逐封处理」清空一次', done: triageDone, go: () => useMail.getState().setTriage(true) },
    { label: '教 Agent 记住一件事', done: state.memory, go: () => goAgent('memory') },
    { label: '把 LinkTo 接到 Claude Code（MCP）', done: state.mcp, go: () => api.openSettings('integrations') }
  ]
  const doneCount = steps.filter(s => s.done).length
  if (doneCount === steps.length) return null
  const dismiss = () => {
    safeSet(DISMISS_KEY, '1')
    setHidden(true)
  }

  return (
    <div className="mx-2 mb-2 rounded-[var(--r-md)] p-3 flex flex-col gap-2" style={{ background: 'var(--rail-bg)', color: 'var(--rail-fg)' }}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold flex-1">让 LinkTo 认识你</span>
        <span className="text-2xs tnum" style={{ color: 'var(--ai)', fontFamily: 'var(--font-mono)' }}>
          {doneCount} / {steps.length}
        </span>
        <button onClick={dismiss} aria-label="不再显示" title="不再显示" className="w-5 h-5 inline-flex items-center justify-center rounded-[var(--r-xs)]" style={{ color: 'var(--rail-muted)' }}>
          <IconClose width={10} height={10} />
        </button>
      </div>
      <div className="h-1 rounded-full" style={{ background: 'var(--rail-line)' }}>
        <div className="h-1 rounded-full" style={{ width: `${(doneCount / steps.length) * 100}%`, background: 'var(--ai)' }} />
      </div>
      <div className="flex flex-col gap-0.5">
        {steps.map(s => (
          <button
            key={s.label}
            onClick={s.go}
            disabled={s.done}
            className="text-left text-xs leading-5 rounded-[var(--r-xs)] px-1 -mx-1 hover:bg-[var(--rail-line)] disabled:hover:bg-transparent"
            style={{ color: s.done ? 'var(--rail-muted)' : 'var(--rail-fg)', textDecoration: s.done ? 'line-through' : 'none' }}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const MOUSE_KEY = 'ms_mouse_actions'
const TIPS_SEEN_KEY = 'ms_tips_seen'
const TIPS: Record<string, { key: string; text: string; threshold: number }> = {
  archive: { key: 'E', text: '归档', threshold: 10 },
  snooze: { key: 'S', text: '稍后处理', threshold: 6 },
  move: { key: 'V', text: '移动到文件夹', threshold: 6 },
  reply: { key: 'R', text: '回复', threshold: 8 }
}

/** 记一次「用鼠标完成的操作」；达到阈值后提示一次对应快捷键 */
export function noteMouseAction(action: keyof typeof TIPS) {
  window.dispatchEvent(new CustomEvent('ms:mouse-action', { detail: action }))
}

/**
 * 情境提示：只在你真的在重复某件事时出现，且每种只出现一次。
 * 例：用鼠标归档满 10 封 →「下次按 E 就行」。
 */
export function CoachTip() {
  const [tip, setTip] = useState<{ action: string; key: string; text: string; count: number } | null>(null)
  useEffect(() => {
    const on = (e: Event) => {
      const action = (e as CustomEvent<string>).detail
      const def = TIPS[action]
      if (!def) return
      let counts: Record<string, number> = {}
      let seen: string[] = []
      try {
        counts = JSON.parse(safeGet(MOUSE_KEY) || '{}')
        seen = JSON.parse(safeGet(TIPS_SEEN_KEY) || '[]')
      } catch {
        /* 损坏的本地数据按空处理 */
      }
      counts[action] = (counts[action] ?? 0) + 1
      safeSet(MOUSE_KEY, JSON.stringify(counts))
      if (counts[action] >= def.threshold && !seen.includes(action)) {
        safeSet(TIPS_SEEN_KEY, JSON.stringify([...seen, action]))
        setTip({ action, key: def.key, text: def.text, count: counts[action] })
      }
    }
    window.addEventListener('ms:mouse-action', on)
    return () => window.removeEventListener('ms:mouse-action', on)
  }, [])

  if (!tip) return null
  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-[320px] rounded-[var(--r-md)] px-4 py-3 pop-in"
      style={{ background: 'var(--rail-bg)', color: 'var(--rail-fg)', boxShadow: 'var(--shadow-float)' }}
    >
      <div className="text-sm leading-relaxed">
        你已经用鼠标{tip.text}了 {tip.count} 次。下次按{' '}
        <kbd className="px-1.5 rounded-[var(--r-xs)] font-semibold ai-chip" style={{ fontFamily: 'var(--font-mono)' }}>{tip.key}</kbd> 就行。
      </div>
      <div className="mt-2 flex gap-3 text-xs">
        <button onClick={() => setTip(null)} style={{ color: 'var(--ai)' }}>知道了</button>
        <button
          onClick={() => {
            safeSet(TIPS_SEEN_KEY, JSON.stringify(Object.keys(TIPS)))
            setTip(null)
          }}
          style={{ color: 'var(--rail-muted)' }}
        >
          不再提示
        </button>
      </div>
    </div>
  )
}
