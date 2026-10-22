import { useEffect, useMemo, useState } from 'react'
import { useMail } from '../stores/mail'
import { useInsights, splitKey, dedupeEntities } from '../lib/insights'
import { api, displayName, fmtDate } from '../lib/api'
import { snoozeTargets, fmtSnooze } from './SnoozeMenu'
import { markdownToHtml } from '../components/Markdown'
import { TRIAGE_DONE_KEY } from './Guidance'
import type { MailInsight, MessageSummary } from '@shared/types'

/** 'YYYY-MM-DD HH:mm' → 时间戳（无效返回 null） */
function parseUntil(s?: string): number | null {
  if (!s) return null
  const t = Date.parse(s.replace(' ', 'T'))
  return Number.isFinite(t) && t > Date.now() ? t : null
}

/**
 * 逐封处理：一次只看一封「需要你处理」的邮件，四个大按钮 + 单键（E / S / R / ↓）。
 * 稍后的时间与回复草稿都来自 AI 理解结果；没有 AI 时用默认值（明早 9 点 / 空草稿）。
 */
export function TriageView() {
  const { messages, accounts, setTriage, loadMessages } = useMail()
  const insights = useInsights(st => st.byId)
  const [done, setDone] = useState<string[]>([])
  const [skipped, setSkipped] = useState<string[]>([])
  const [initial] = useState(() =>
    messages.filter(m => insights[m.id]?.section === 'act' || m.pinned).map(m => m.id)
  )

  const queue = useMemo(() => {
    const byId = new Map(messages.map(m => [m.id, m]))
    const live = initial.map(id => byId.get(id)).filter((m): m is MessageSummary => !!m && !done.includes(m.id))
    // 跳过的放到队尾，全部跳过一轮后重新开始
    return [...live.filter(m => !skipped.includes(m.id)), ...live.filter(m => skipped.includes(m.id))]
  }, [messages, initial, done, skipped])

  const cur = queue[0]
  const ins: MailInsight | undefined = cur ? insights[cur.id] : undefined
  const account = cur ? accounts.find(a => a.id === cur.accountId) : undefined
  const snoozeAction = ins?.next.find(n => n.kind === 'snooze')
  const replyAction = ins?.next.find(n => n.kind === 'reply')
  const snoozeAt = parseUntil(snoozeAction?.until) ?? snoozeTargets().find(t => t.key === 'tomorrow')?.at ?? Date.now() + 864e5
  const total = initial.length
  const progress = total ? Math.round((done.length / total) * 100) : 100

  const finish = (id: string) => setDone(d => [...d, id])
  const archive = async () => {
    if (!cur) return
    finish(cur.id)
    await api.moveMessages([cur.id], 'archive')
  }
  const snooze = async () => {
    if (!cur) return
    finish(cur.id)
    await api.snoozeMessages([cur.id], snoozeAt)
    window.dispatchEvent(new CustomEvent('ms:toast', { detail: `${fmtSnooze(snoozeAt)} 回到收件箱` }))
  }
  const reply = () => {
    if (!cur) return
    void api.openCompose({
      accountId: cur.accountId,
      to: cur.from ? [cur.from] : [],
      subject: /^回复[:：]/.test(cur.subject) ? cur.subject : `回复：${cur.subject}`,
      relatedMessageId: cur.id,
      html: replyAction?.body || ins?.quickReply ? markdownToHtml(replyAction?.body || ins?.quickReply || '') : undefined
    } as never)
    finish(cur.id)
  }
  const skip = () => cur && setSkipped(s => [...s.filter(x => x !== cur.id), cur.id])
  const exit = () => {
    setTriage(false)
    void loadMessages()
  }

  useEffect(() => {
    if (cur) void useInsights.getState().understand(cur.id)
    // 清空过一次：入门清单的这一步自动打勾
    else if (total > 0) {
      try {
        localStorage.setItem(TRIAGE_DONE_KEY, '1')
      } catch {
        /* ignore */
      }
    }
  }, [cur?.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || e.metaKey || e.ctrlKey) return
      // 拦截在捕获阶段，避免与列表的 J/K/A/S 快捷键重复执行
      const k = e.key.toLowerCase()
      if (k === 'escape') exit()
      else if (k === 'e' || k === 'a') void archive()
      else if (k === 's') void snooze()
      else if (k === 'r') reply()
      else if (k === 'arrowdown' || k === 'j') skip()
      else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <div className="drag-region native-web-titlebar h-[var(--titlebar-h)] shrink-0" />
      <div className="flex-1 overflow-y-auto flex flex-col items-center px-8 pb-10">
        <div className="w-full max-w-[680px] flex items-center gap-3 mb-6">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>逐封处理 · 需要你处理</span>
          <div className="flex-1 h-1 rounded-full" style={{ background: 'var(--border)' }}>
            <div className="h-1 rounded-full transition-[width]" style={{ width: `${progress}%`, background: 'var(--ai)', transitionDuration: 'var(--dur-3)' }} />
          </div>
          <span className="text-xs tnum" style={{ color: 'var(--fg)', fontFamily: 'var(--font-mono)' }}>
            {done.length} / {total}
          </span>
          <button onClick={exit} className="h-8 px-3 rounded-[var(--r-sm)] text-xs border border-[var(--border)] hover:bg-[var(--hover)]" style={{ color: 'var(--fg)' }}>
            退出 <kbd style={{ fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>Esc</kbd>
          </button>
        </div>

        {cur ? (
          <div key={cur.id} className="w-full max-w-[680px] rounded-[var(--r-lg)] border border-[var(--border)] p-7 flex flex-col gap-4 pop-in" style={{ background: 'var(--surface-strong)', boxShadow: 'var(--shadow)' }}>
            <div className="flex items-center gap-2.5 text-sm">
              {account && <span className="w-2.5 h-2.5 rounded-full" style={{ background: account.color }} />}
              <span className="font-semibold" style={{ color: 'var(--fg)' }}>{displayName(cur.from)}</span>
              <span style={{ color: 'var(--faint)' }}>{account?.name} · {fmtDate(cur.date)}</span>
            </div>
            <div className="text-xl font-semibold" style={{ color: 'var(--fg)', letterSpacing: '-0.01em' }}>{cur.subject || '（无主题）'}</div>
            <TriageGist ins={ins} fallback={cur.snippet} />
            {!!ins?.entities.length && (
              <div className="flex flex-wrap gap-2">
                {dedupeEntities(ins.entities).slice(0, 4).map((en, i) => (
                  <span key={i} className="text-xs h-7 px-2.5 inline-flex items-center rounded-[var(--r-sm)] border border-[var(--border)]" style={{ color: 'var(--fg)' }}>
                    {en.label}
                  </span>
                ))}
              </div>
            )}
            <div className="grid grid-cols-4 gap-2.5 pt-2">
              <BigBtn label="归档" k="E" onClick={() => void archive()} />
              <BigBtn label={`稍后 · ${fmtSnooze(snoozeAt)}`} k="S" onClick={() => void snooze()} />
              <BigBtn label={replyAction ? replyAction.label.replace(/^回复[:：]\s*/, '回复：') : '回复'} k={replyAction || ins?.quickReply ? 'R · AI 已起草' : 'R'} primary onClick={reply} />
              <BigBtn label="跳过" k="↓" onClick={skip} />
            </div>
          </div>
        ) : (
          <div className="w-full max-w-[680px] rounded-[var(--r-lg)] p-10 flex flex-col items-center gap-2 ai-chip pop-in">
            <div className="text-xl font-bold">需要你处理的，清空了</div>
            <div className="text-sm">剩下的是订阅、通知和其他邮件，可以在今日简报里一眼扫完。</div>
            <button onClick={exit} className="mt-3 h-9 px-4 rounded-[var(--r-sm)] text-sm font-semibold" style={{ background: 'var(--ai-ink)', color: 'var(--ai)' }}>
              回到收件箱
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function TriageGist(props: { ins?: MailInsight; fallback: string }) {
  if (!props.ins?.gist) return <div className="text-base leading-relaxed" style={{ color: 'var(--muted)' }}>{props.fallback}</div>
  const [pre, key, post] = splitKey(props.ins.gist, props.ins.gistKey)
  return (
    <div className="text-base leading-relaxed" style={{ color: 'var(--muted)' }}>
      {pre}
      {key && <mark className="hl">{key}</mark>}
      {post}
    </div>
  )
}

function BigBtn(props: { label: string; k: string; primary?: boolean; onClick(): void }) {
  return (
    <button
      onClick={props.onClick}
      className="h-16 px-2 rounded-[var(--r-md)] flex flex-col items-center justify-center gap-1 border transition-transform active:scale-[0.97]"
      style={
        props.primary
          ? { background: 'var(--accent)', color: 'var(--on-accent)', borderColor: 'var(--accent)' }
          : { background: 'var(--bg-soft)', color: 'var(--fg)', borderColor: 'var(--border)' }
      }
    >
      <span className="text-sm font-semibold truncate max-w-full">{props.label}</span>
      <span className="text-2xs" style={{ fontFamily: 'var(--font-mono)', opacity: 0.65 }}>{props.k}</span>
    </button>
  )
}
