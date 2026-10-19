import { useEffect, useState } from 'react'
import { useOverlayTurn, OVERLAY_PRIORITY } from '../lib/overlays'

/*
 * 原侧栏底部「让 LinkTo 认识你」引导卡已并入升级向导（app/upgrade），侧栏不再常驻引导卡。
 * 这里只留情境提示（快捷键教学），经「首次」浮层协调器排队，不与向导 / 授权说明同时出现。
 */

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

  const turn = useOverlayTurn('coach-tip', !!tip, OVERLAY_PRIORITY.tip)
  if (!tip || !turn) return null
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
