import { useState } from 'react'
import type { RuleSuggestion } from '@shared/types'
import { api, fmtDate } from '../lib/api'
import { useMail } from '../stores/mail'
import { IconClose, IconLayers } from '../components/icons'
import { suggestionQuestion, useRuleSuggestions } from '../lib/rule-suggest'

const HIDE_KEY = 'ms_rule_sugg_hidden'
const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

function hiddenIds(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(HIDE_KEY) || '[]')
  } catch {
    return []
  }
}

/**
 * 收件箱顶部的规则建议：克制的一行卡片，同时最多 1 条。
 * 「建规则」= 用户接受（只作用于之后新到的邮件），建好后再问要不要顺手处理现有邮件；
 * 「不用了」= 同类永不再提；右上角关闭只是这次不显示。
 */
export function RuleSuggestionCard() {
  const { list } = useRuleSuggestions()
  const [hidden, setHidden] = useState<string[]>(hiddenIds)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ s: RuleSuggestion; ruleId: string } | null>(null)

  const s = done?.s ?? list?.find(x => !hidden.includes(x.id)) ?? null
  if (!s) return null

  const hide = (id: string) => {
    const next = [...hidden, id]
    setHidden(next)
    setOpen(false)
    setDone(null)
    try {
      sessionStorage.setItem(HIDE_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  const accept = async (applyExisting: boolean) => {
    setBusy(true)
    try {
      const r = await api.ruleSuggestionAccept(s.id, { applyExisting })
      if (!r.ok) {
        toast(r.error || '没能建规则')
        return
      }
      if (applyExisting) {
        toast(r.applied ? `已处理现有 ${r.applied} 封` : '收件箱里没有需要处理的了')
        hide(s.id)
        await useMail.getState().loadMessages()
        return
      }
      if ((s.matchCount ?? 0) > 0) setDone({ s, ruleId: r.ruleId ?? '' })
      else {
        toast(`已建规则「${s.rule.name}」，之后新到的邮件会自动处理`)
        hide(s.id)
      }
    } finally {
      setBusy(false)
    }
  }

  const btn = 'h-6 px-2 rounded-[var(--r-xs)] text-2xs font-medium whitespace-nowrap disabled:opacity-50'
  return (
    <div className="mx-3 mt-3 mb-1 rounded-[var(--r-md)] border border-[var(--border)] px-3 py-2 fade-in" style={{ background: 'var(--surface-strong)' }} data-testid="rule-suggestion-card">
      <div className="flex items-start gap-2.5">
        <span className="w-5 h-5 mt-px shrink-0 rounded-[var(--r-xs)] inline-flex items-center justify-center ai-chip">
          <IconLayers width={11} height={11} />
        </span>
        <div className="flex-1 min-w-0">
          {done ? (
            <div className="text-xs leading-[18px]" style={{ color: 'var(--fg)' }}>
              已建规则「{s.rule.name}」，之后新到的会自动处理。收件箱里还有 {s.matchCount} 封符合 —— 也一起处理吗？
            </div>
          ) : (
            <div className="text-xs leading-[18px]" style={{ color: 'var(--fg)' }} title={s.evidence}>
              {s.title} —— <span className="font-semibold">{suggestionQuestion(s)}</span>
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {done ? (
              <>
                <button disabled={busy} onClick={() => void accept(true)} className={btn} style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
                  也处理这 {s.matchCount} 封
                </button>
                <button onClick={() => hide(s.id)} className={`${btn} hover:bg-[var(--hover)]`} style={{ color: 'var(--muted)' }}>
                  只管以后的
                </button>
              </>
            ) : (
              <>
                <button disabled={busy} onClick={() => void accept(false)} className={btn} style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
                  建规则
                </button>
                <button onClick={() => setOpen(o => !o)} aria-expanded={open} className={`${btn} border border-[var(--border)] hover:bg-[var(--hover)]`} style={{ color: 'var(--fg)' }}>
                  看看会命中哪些
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    void api.ruleSuggestionDismiss(s.id, true)
                    hide(s.id)
                  }}
                  className={`${btn} hover:bg-[var(--hover)]`}
                  style={{ color: 'var(--muted)' }}
                >
                  不用了
                </button>
              </>
            )}
          </div>
          {open && !done && (
            <div className="mt-2 space-y-0.5 fade-in">
              <div className="text-2xs" style={{ color: 'var(--faint)' }}>
                {s.evidence}。收件箱里现在有 {s.matchCount ?? 0} 封会命中{(s.samples ?? []).length ? '，例如：' : '。'}
              </div>
              {(s.samples ?? []).slice(0, 5).map(m => (
                <div key={m.id} className="flex items-baseline gap-2 text-2xs">
                  <span className="truncate flex-1 min-w-0" style={{ color: 'var(--fg)' }}>{m.subject}</span>
                  <span className="shrink-0" style={{ color: 'var(--faint)' }}>
                    {m.inInbox ? '收件箱' : m.folder} · {fmtDate(m.date)}
                  </span>
                </div>
              ))}
              <button onClick={() => void api.openSettings('rules')} className="text-2xs underline underline-offset-2" style={{ color: 'var(--muted)' }}>
                改条件后再建
              </button>
            </div>
          )}
        </div>
        <button onClick={() => hide(s.id)} aria-label="这次不显示" title="这次不显示" className="icon-btn w-5 h-5 shrink-0 inline-flex items-center justify-center" style={{ color: 'var(--faint)' }}>
          <IconClose width={10} height={10} />
        </button>
      </div>
    </div>
  )
}
