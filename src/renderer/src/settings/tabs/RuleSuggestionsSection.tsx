import { useEffect, useState } from 'react'
import type { Rule, RuleSuggestion } from '@shared/types'
import { api, fmtDate } from '../../lib/api'
import { describeAction, describeCondition, suggestionQuestion, useRuleSuggestions } from '../../lib/rule-suggest'
import { RuleEditor } from './RulesTab'

/**
 * 设置 → 自动化 →「建议的规则」：从你反复的手动操作里挖掘出的习惯。
 * 展开看证据与样本邮件，可改条件 / 动作后再接受（复用规则编辑器），可选「同时处理现有 N 封」；忽略 30 天 / 永不建议。
 */
export function RuleSuggestionsSection(props: { onAccepted(): void }) {
  const { list } = useRuleSuggestions()
  const [openId, setOpenId] = useState<string | null>(null)
  const [folders, setFolders] = useState<Record<string, string>>({})
  useEffect(() => {
    void api.listFolders().then(fs => setFolders(Object.fromEntries(fs.map(f => [f.id, f.name]))))
  }, [])

  if (!list) return null
  if (!list.length)
    return (
      <div className="text-xs leading-relaxed rounded-[var(--r-md)] px-4 py-3" style={{ color: 'var(--faint)', background: 'var(--bg-soft)' }}>
        还没有建议。LinkTo 会留意你反复做的手动操作（总把某类邮件归档、移到某个文件夹、加旗标…），同一类邮件近 30 天里在至少 3 天被同样处理、且几乎每封都这样处理时，才会在这里和收件箱顶部提一次。你接受之前不会建规则，也不会动任何邮件。
      </div>
    )
  return (
    <div className="space-y-2" data-testid="rule-suggestions">
      {list.map(s => (
        <SuggestionItem
          key={s.id}
          s={s}
          open={openId === s.id}
          onToggle={() => setOpenId(id => (id === s.id ? null : s.id))}
          folderName={id => folders[id]}
          onAccepted={props.onAccepted}
        />
      ))}
    </div>
  )
}

function SuggestionItem(props: { s: RuleSuggestion; open: boolean; onToggle(): void; folderName(id: string): string | undefined; onAccepted(): void }) {
  const { s } = props
  const [draft, setDraft] = useState<Rule>(() => ({ id: s.id, name: s.rule.name, enabled: true, order: 0, conditions: s.rule.conditions, actions: s.rule.actions }))
  const [applyExisting, setApplyExisting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const n = s.matchCount ?? 0

  const accept = async (edited: boolean) => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.ruleSuggestionAccept(s.id, {
        ...(edited ? { rule: { name: draft.name, conditions: draft.conditions, actions: draft.actions } } : {}),
        applyExisting
      })
      if (!r.ok) {
        setMsg(r.error || '没能创建')
        return
      }
      window.dispatchEvent(new CustomEvent('ms:toast', { detail: r.applied ? `已建规则，并处理了现有 ${r.applied} 封` : '已建规则' }))
      props.onAccepted()
    } finally {
      setBusy(false)
    }
  }

  const btn = 'h-7 px-2.5 rounded-[var(--r-sm)] text-xs font-medium whitespace-nowrap disabled:opacity-50'
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border)]" style={{ background: 'var(--surface-strong)' }}>
      <div className="px-3.5 py-3">
        <div className="text-sm leading-snug" style={{ color: 'var(--fg)' }}>
          {s.title} —— <span className="font-semibold">{suggestionQuestion(s)}</span>
        </div>
        <div className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
          {s.rule.conditions.map(c => describeCondition(c)).join(' 且 ')} → {s.rule.actions.map(a => describeAction(a, props.folderName)).join('、')}
          <span style={{ color: 'var(--faint)' }}> · 收件箱里现在有 {n} 封会命中</span>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button disabled={busy} onClick={() => void accept(false)} className={btn} style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
            建规则
          </button>
          <button onClick={props.onToggle} aria-expanded={props.open} className={`${btn} border border-[var(--border)] hover:bg-[var(--hover)]`} style={{ color: 'var(--fg)' }}>
            {props.open ? '收起' : '看证据 / 改一改'}
          </button>
          <span className="flex-1" />
          <button disabled={busy} onClick={() => void api.ruleSuggestionDismiss(s.id, false)} className={`${btn} hover:bg-[var(--hover)]`} style={{ color: 'var(--muted)' }} title="30 天内不再提这一条">
            忽略
          </button>
          <button disabled={busy} onClick={() => void api.ruleSuggestionDismiss(s.id, true)} className={`${btn} hover:bg-[var(--hover)]`} style={{ color: 'var(--muted)' }} title="同一发件方的同类建议以后都不再提">
            永不建议
          </button>
        </div>
        {!props.open && n > 0 && (
          <label className="mt-2 flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--muted)' }}>
            <input type="checkbox" checked={applyExisting} onChange={e => setApplyExisting(e.target.checked)} />
            同时处理收件箱里现有的 {n} 封
          </label>
        )}
        {msg && <div className="mt-2 text-xs" style={{ color: 'var(--danger-ink)' }}>{msg}</div>}
      </div>

      {props.open && (
        <div className="border-t border-[var(--border-soft)] px-3.5 py-3 space-y-3 fade-in">
          <div>
            <div className="text-2xs font-semibold mb-1" style={{ color: 'var(--faint)', letterSpacing: '0.04em' }}>证据</div>
            <div className="text-xs leading-relaxed" style={{ color: 'var(--fg)' }}>{s.evidence}</div>
          </div>
          {(s.samples ?? []).length > 0 && (
            <div>
              <div className="text-2xs font-semibold mb-1" style={{ color: 'var(--faint)', letterSpacing: '0.04em' }}>会命中的邮件（样本）</div>
              <div className="rounded-[var(--r-sm)] border border-[var(--border-soft)] divide-y divide-[var(--border-soft)]">
                {(s.samples ?? []).map(m => (
                  <div key={m.id} className="flex items-baseline gap-3 px-2.5 py-1.5 text-xs">
                    <span className="truncate flex-1 min-w-0" style={{ color: 'var(--fg)' }}>{m.subject}</span>
                    <span className="truncate max-w-[150px] shrink-0" style={{ color: 'var(--faint)' }}>{m.from}</span>
                    <span className="shrink-0 tnum" style={{ color: 'var(--faint)' }}>{m.inInbox ? '收件箱' : m.folder} · {fmtDate(m.date)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="rounded-[var(--r-md)] px-1 py-1" style={{ background: 'var(--bg-soft)' }}>
            <div className="px-3 pt-2">
              <RuleEditor
                rule={draft}
                onChange={setDraft}
                onSave={() => void accept(true)}
                saveLabel={busy ? '创建中…' : '按这个创建'}
                hideEnabled
                footer={
                  <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--muted)' }}>
                    <input type="checkbox" checked={applyExisting} onChange={e => setApplyExisting(e.target.checked)} />
                    同时处理收件箱里现有的{n ? ` ${n} 封（按建议的条件）` : '邮件'}
                  </label>
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
