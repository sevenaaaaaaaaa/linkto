import { useEffect, useState } from 'react'
import { useMail } from '../stores/mail'
import { api, displayName } from '../lib/api'
import { goView } from '../lib/route'
import { IconBook, IconBrain, IconClose, IconFileText, IconRobot, IconUser } from '../components/icons'
import { AgentChat } from './AgentView'
import { ContactTimelineLinks } from './projects/ProjectBits'
import { RailAgentHost } from './agent/RailSkills'

type SenderContext = NonNullable<Awaited<ReturnType<typeof api.senderContext>>>

/**
 * 阅读页右侧栏（v3）：
 * - 上下文：这位联系人和你的往来、Agent 记得的事、你答应过的事、相关知识库 / 邮件（原「发件人画像」）
 * - Agent：⌘J，同一个对话里问邮件、问知识库，并让它替你执行（确认后生效）
 */
export function ContextRail() {
  const { rail, selectedId, selectedIds, toggleRail, messages } = useMail()
  const [ctx, setCtx] = useState<SenderContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [learned, setLearned] = useState('')
  const multi = selectedIds.size > 1

  useEffect(() => {
    setLearned('')
    if (rail !== 'context' || !selectedId) {
      setCtx(null)
      return
    }
    let alive = true
    setLoading(true)
    void api
      .senderContext(selectedId)
      .then(c => alive && setCtx(c))
      .catch(() => alive && setCtx(null))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [rail, selectedId])

  if (!rail) return null
  const msg = messages.find(m => m.id === selectedId)

  const learn = async () => {
    if (!selectedId) return
    setLearned('学习中…')
    const res = await api.agentLearn(selectedId)
    setLearned(res.ok ? (res.learned.length ? `记住了 ${res.learned.length} 条` : '没有新的长期信息') : res.error ?? '学习失败')
    if (res.ok && res.learned.length) void api.senderContext(selectedId).then(setCtx)
  }

  return (
    <aside
      aria-label={rail === 'agent' ? 'Agent' : '上下文'}
      className="w-[var(--context-w)] shrink-0 h-full flex flex-col border-l border-[var(--border)]"
      style={{ background: 'var(--bg)' }}
    >
      <div className="drag-region h-[var(--titlebar-h)] shrink-0 flex items-center gap-1 px-2 border-b border-[var(--border-soft)]">
        <Tab active={rail === 'context'} onClick={() => toggleRail('context')} icon={<IconUser width={13} height={13} />} label="上下文" />
        <Tab active={rail === 'agent'} onClick={() => toggleRail('agent')} icon={<IconRobot width={13} height={13} />} label="Agent" kbd="⌘J" />
        <div className="flex-1" />
        <button
          onClick={() => toggleRail(rail)}
          aria-label="收起右侧栏"
          title="收起"
          className="no-drag icon-btn w-7 h-7 inline-flex items-center justify-center"
          style={{ color: 'var(--faint)' }}
        >
          <IconClose width={12} height={12} />
        </button>
      </div>

      {rail === 'agent' ? (
        <div className="flex-1 min-h-0">
          <RailAgentHost onClose={() => toggleRail('agent')}>
          <AgentChat panel onClose={() => toggleRail('agent')} />
          </RailAgentHost>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-5">
          {!selectedId || multi ? (
            <Empty text={multi ? '多选时，右侧栏的 Agent 可以基于选中的邮件回答问题' : '打开一封邮件，这里会显示你和发件人的往来、Agent 记得的事，以及你答应过的事'} />
          ) : loading && !ctx ? (
            <div className="space-y-3">
              {[60, 90, 75, 85].map((w, i) => (
                <div key={i} className="h-3 rounded-sm shimmer" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : ctx ? (
            <>
              <div className="flex items-center gap-3">
                <span className="w-10 h-10 shrink-0 rounded-[var(--r-md)] inline-flex items-center justify-center text-md font-semibold" style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}>
                  {[...(ctx.name || ctx.addr)][0]?.toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--fg)' }}>{ctx.name || displayName(msg?.from ?? null)}</div>
                  <div className="text-xs truncate" style={{ color: 'var(--faint)' }}>{ctx.addr}</div>
                </div>
              </div>
              <div className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
                往来 {ctx.total} 封{ctx.sentByMe ? ` · 你发过 ${ctx.sentByMe} 封` : ''}
                {ctx.lastAt ? ` · 上次 ${new Date(ctx.lastAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}` : ''}
              </div>

              <Block title="Agent 记得" icon={<IconBrain width={12} height={12} />}>
                {ctx.memories.length ? (
                  ctx.memories.map((m, i) => <Card key={i}>{m}</Card>)
                ) : (
                  <div className="text-xs" style={{ color: 'var(--faint)' }}>还没有关于 Ta 的记忆</div>
                )}
                <button
                  onClick={() => void learn()}
                  className="mt-1 self-start text-xs h-7 px-2.5 rounded-[var(--r-sm)] border border-[var(--border)] hover:bg-[var(--hover)]"
                  style={{ color: 'var(--fg)' }}
                >
                  {learned || '从这封邮件学习'}
                </button>
              </Block>

              {ctx.promises.length > 0 && (
                <Block title="你答应过">
                  {ctx.promises.map((p, i) => (
                    <div key={i} className="text-sm leading-relaxed px-3 py-2 rounded-[var(--r-sm)]" style={{ background: 'var(--ai-soft)', color: 'var(--fg)' }}>
                      {p}
                    </div>
                  ))}
                </Block>
              )}

              {ctx.related.length > 0 && (
                <Block title="相关">
                  {ctx.related.map(r => (
                    <button
                      key={r.id}
                      onClick={() => (r.kind === 'kb' ? goView('kb') : useMail.getState().select(r.id))}
                      className="flex items-center gap-2 text-sm text-left hover:underline"
                      style={{ color: 'var(--fg)' }}
                    >
                      {r.kind === 'kb' ? <IconBook width={13} height={13} /> : <IconFileText width={13} height={13} />}
                      <span className="truncate">{r.title}</span>
                    </button>
                  ))}
                </Block>
              )}

              <ContactTimelineLinks addr={ctx.addr} />

              <button
                onClick={() => goView('insights')}
                className="self-start text-xs underline underline-offset-2"
                style={{ color: 'var(--muted)' }}
              >
                查看这家公司的完整洞察 →
              </button>
            </>
          ) : (
            <Empty text="暂时拿不到这位联系人的上下文" />
          )}
        </div>
      )}
    </aside>
  )
}

function Tab(props: { active: boolean; onClick(): void; icon: React.ReactNode; label: string; kbd?: string }) {
  return (
    <button
      onClick={props.onClick}
      aria-pressed={props.active}
      className="no-drag h-7 px-2.5 inline-flex items-center gap-1.5 rounded-[var(--r-sm)] text-xs transition-colors"
      style={props.active ? { background: 'var(--selected)', color: 'var(--fg)', fontWeight: 600 } : { color: 'var(--muted)' }}
    >
      {props.icon}
      {props.label}
      {props.kbd && <kbd className="text-2xs" style={{ fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>{props.kbd}</kbd>}
    </button>
  )
}

function Block(props: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-2xs font-semibold inline-flex items-center gap-1.5" style={{ color: 'var(--faint)', letterSpacing: '0.04em' }}>
        {props.icon}
        {props.title}
      </h3>
      {props.children}
    </section>
  )
}

function Card(props: { children: React.ReactNode }) {
  return (
    <div className="text-sm leading-relaxed px-3 py-2 rounded-[var(--r-sm)] border border-[var(--border)]" style={{ background: 'var(--surface-strong)', color: 'var(--fg)' }}>
      {props.children}
    </div>
  )
}

function Empty(props: { text: string }) {
  return <div className="mt-10 text-center text-xs leading-relaxed px-2" style={{ color: 'var(--faint)' }}>{props.text}</div>
}
