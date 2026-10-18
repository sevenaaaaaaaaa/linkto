import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { IconClose, IconSparkles } from '../components/icons'
import type { AgentAction, AgentActionType } from '@shared/types'
import { Markdown } from '../components/Markdown'
import { takePendingAsk } from '../lib/agent-ask'
import { AIErrorNote } from '../components/AIErrorNote'

/** Agent 视图：外壳与子页（对话 / 技能 / 自动任务 / 记忆）见 ./agent/ */
export { AgentShell as AgentView } from './agent/AgentShell'

/** Agent 回答末尾的动作块（```linkto-actions [...] ```），确认后才执行 */
const ACTION_BLOCK = /```linkto-actions\s*([\s\S]*?)```/

const ACTION_LABEL: Record<AgentActionType, string> = {
  archive: '归档',
  trash: '删除',
  markRead: '标为已读',
  markUnread: '标为未读',
  flag: '加旗标',
  snooze: '稍后处理',
  todo: '新建待办',
  draftReply: '起草回复'
}

interface PlannedAction extends AgentAction {
  ref?: string
  subject?: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  actions?: PlannedAction[]
  actionState?: 'pending' | 'running' | 'done' | 'dismissed'
  actionResult?: string
  memories?: string[]
  savedMemories?: string[]
  /** AI 失败：原始错误（渲染成「一句人话 + 动作」）与可重试的问题 */
  error?: string
  retryQ?: string
}

/** 解析回答：剥离动作块并映射 E 编号 → 邮件 id；提取「📌 记住：」建议 */
async function finalizeAnswer(text: string, refs: string[]): Promise<Pick<ChatMessage, 'text' | 'actions' | 'memories'>> {
  let actions: PlannedAction[] | undefined
  const m = text.match(ACTION_BLOCK)
  if (m) {
    text = text.replace(ACTION_BLOCK, '').trim()
    try {
      const raw = JSON.parse(m[1].trim()) as (Partial<AgentAction> & { ref?: string })[]
      const parsed: PlannedAction[] = []
      for (const r of Array.isArray(raw) ? raw.slice(0, 10) : []) {
        if (!r.type || !(r.type in ACTION_LABEL)) continue
        const n = /^E(\d+)$/i.exec(r.ref ?? '')
        const messageId = n ? refs[Number(n[1]) - 1] : undefined
        // 引用了不存在的邮件编号：丢弃，不让模型编造的目标被执行
        if (r.type !== 'todo' && !messageId) continue
        const msg = messageId ? await api.getMessage(messageId).catch(() => null) : null
        parsed.push({ ...(r as AgentAction), messageId, ref: r.ref, subject: msg?.subject })
      }
      if (parsed.length) actions = parsed
    } catch { /* 动作块不是合法 JSON：忽略，只展示回答 */ }
  }
  const memories = [...text.matchAll(/📌\s*记住[:：]\s*(.+)/g)].flatMap(x => x[1].split(/[；;]/)).map(x => x.trim()).filter(Boolean).slice(0, 3)
  return { text, actions, memories: memories.length ? memories : undefined }
}

/** panel=true：嵌在阅读页右侧栏（⌘J）；否则为居中弹窗 */
export function AgentChat(props: { onClose(): void; panel?: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [aiState, setAiState] = useState<{ ready: boolean; reason?: string } | null>(null)
  const requestId = useRef(`agent-${Date.now()}`)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api.aiStatus().then(setAiState)
  }, [])

  useEffect(() => {
    return api.onEvent(ev => {
      const e = ev as { type: string; requestId?: string; delta?: string; done?: boolean; error?: string; refs?: string[] }
      if (e.type !== 'ai-stream' || e.requestId !== requestId.current) return
      setMessages(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, text: last.text + (e.delta ?? '') }
        else next.push({ role: 'assistant', text: e.delta ?? '' })
        return next
      })
      if (e.done) {
        setStreaming(false)
        if (e.error) {
          setMessages(prev => {
            const next = [...prev]
            const retryQ = [...next].reverse().find(m => m.role === 'user')?.text
            next[next.length - 1] = { role: 'assistant', text: '', error: e.error, retryQ }
            return next
          })
          return
        }
        setMessages(prev => {
          const last = prev[prev.length - 1]
          if (last?.role === 'assistant') {
            void finalizeAnswer(last.text, e.refs ?? []).then(done =>
              setMessages(cur => {
                const next = [...cur]
                const i = next.length - 1
                if (next[i]?.role === 'assistant') next[i] = { ...next[i], ...done, actionState: done.actions ? 'pending' : undefined }
                return next
              })
            )
          }
          return prev
        })
      }
    })
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 999999 })
  }, [messages])

  // 其他页面交来的问题（待办页的「会前准备」「会后跟进」等）：挂载时和事件到达时各领取一次
  const askRef = useRef<(q: string) => void>(() => {})
  askRef.current = (q: string) => {
    if (streaming) return
    setMessages(prev => [...prev, { role: 'user', text: q }])
    setStreaming(true)
    requestId.current = `agent-${Date.now()}`
    void api.agentChat(q, requestId.current)
  }
  useEffect(() => {
    const take = () => {
      const q = takePendingAsk()
      if (q) askRef.current(q)
    }
    take()
    window.addEventListener('ms:agent-ask', take)
    return () => window.removeEventListener('ms:agent-ask', take)
  }, [])

  const patch = (i: number, p: Partial<ChatMessage>) =>
    setMessages(prev => prev.map((m, j) => (j === i ? { ...m, ...p } : m)))

  const execute = async (i: number) => {
    const actions = messages[i]?.actions
    if (!actions?.length) return
    patch(i, { actionState: 'running' })
    const res = await api.agentExecuteActions(actions.map(({ ref: _ref, subject: _subject, ...a }) => a))
    patch(i, {
      actionState: 'done',
      actionResult: res.failed.length
        ? `完成 ${res.ok} 项，失败 ${res.failed.length} 项：${res.failed.map(f => f.error).join('；')}`
        : `已完成 ${res.ok} 项`
    })
  }

  const remember = async (i: number, content: string) => {
    await api.saveMemory({ scope: 'fact', title: content.slice(0, 40), content })
    patch(i, { savedMemories: [...(messages[i]?.savedMemories ?? []), content] })
  }

  const ask = async () => {
    const q = input.trim()
    if (!q || streaming || aiState?.ready === false) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text: q }])
    setStreaming(true)
    requestId.current = `agent-${Date.now()}`
    await api.agentChat(q, requestId.current)
  }

  return (
    <div
      className={props.panel ? 'h-full flex flex-col min-h-0' : 'fixed inset-0 z-30 bg-black/30 flex items-center justify-center'}
      onClick={props.panel ? undefined : props.onClose}
    >
      <div
        className={props.panel ? 'flex-1 min-h-0 flex flex-col overflow-hidden' : 'w-[600px] h-[74vh] bg-white rounded-2xl shadow-[var(--shadow-float)] flex flex-col overflow-hidden fade-in'}
        onClick={e => e.stopPropagation()}
      >
        <div className={`border-b border-ink/5 flex items-center gap-2 ${props.panel ? 'px-4 h-11 shrink-0' : 'px-5 py-3.5'}`}>
          <span className="w-5 h-5 rounded-full bg-accent flex items-center justify-center text-on-accent">
            <IconSparkles width={11} height={11} />
          </span>
          <span className="text-base font-semibold text-zinc-800">LinkTo Agent</span>
          {!props.panel && <span className="text-xs text-zinc-400">基于长期记忆 + 知识库 + 你的邮件</span>}
          <div className="flex-1" />
          <button onClick={props.onClose} className="text-zinc-400 hover:text-zinc-600">
            <IconClose width={14} height={14} />
          </button>
        </div>
        <div ref={scrollRef} className={`flex-1 overflow-y-auto space-y-3 ${props.panel ? 'px-3 py-3' : 'px-5 py-4'}`}>
          {aiState?.ready === false && (
            <div className="rounded-xl border border-ink/[0.08] px-3.5 py-3 text-sm text-zinc-600 flex items-center gap-3">
              <span className="flex-1">Agent 需要 AI 模型才能工作（{aiState.reason}）。支持云端 API，也支持 Ollama / LM Studio 本地模型。</span>
              <button onClick={() => api.openSettings('ai')} className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg bg-accent text-on-accent">
                去配置
              </button>
            </div>
          )}
          {!messages.length && (
            <div className="text-sm text-zinc-300 text-center mt-16 leading-relaxed">
              这里的 Agent 带着你日积月累的记忆，也能替你处理邮件（执行前会先让你确认）。
              <br />
              例如：「我答应过谁什么还没办？」「把 GitHub 的通知都标为已读」「给王小明回一封，说周三下午可以」
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div
                className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed selectable ${
                  m.role === 'user' ? 'bg-accent text-on-accent whitespace-pre-wrap' : 'bg-zinc-100 text-zinc-800'
                }`}
              >
                {/* 流式过程中动作块尚未闭合：先隐藏，避免一闪而过的 JSON；「📌 记住」已有按钮，不在正文重复 */}
                {m.role === 'assistant' && m.error ? (
                  <AIErrorNote error={m.error} onRetry={m.retryQ && i === messages.length - 1 ? () => askRef.current(m.retryQ!) : undefined} />
                ) : m.role === 'assistant' ? (
                  <Markdown text={m.text.replace(/```linkto-actions[\s\S]*$/, '').replace(/^.*📌\s*记住[:：].*$/gm, '').trimEnd()} />
                ) : (
                  m.text
                )}
              </div>
              {m.actions && (
                <div className="mt-2 w-[92%] rounded-2xl border border-ink/[0.08] bg-white px-3.5 py-3">
                  <div className="text-xs font-semibold text-zinc-500 mb-2">Agent 建议执行（确认后才会生效）</div>
                  <ul className="space-y-1.5">
                    {m.actions.map((a, k) => (
                      <li key={k} className="text-sm text-zinc-700 flex gap-2">
                        <span className="shrink-0 font-medium">{ACTION_LABEL[a.type]}</span>
                        <span className="min-w-0 truncate text-zinc-500">
                          {a.type === 'todo' ? a.title : a.subject ?? a.ref}
                          {a.type === 'snooze' && a.until ? ` → ${a.until}` : ''}
                          {a.type === 'todo' && a.due ? `（${a.due}）` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {m.actionState === 'pending' && (
                    <div className="mt-3 flex gap-2">
                      <button onClick={() => void execute(i)} className="text-xs font-medium px-3 py-1.5 rounded-lg bg-accent text-on-accent">
                        确认执行（{m.actions.length}）
                      </button>
                      <button onClick={() => patch(i, { actionState: 'dismissed' })} className="text-xs px-3 py-1.5 rounded-lg text-zinc-500 hover:bg-ink/5">
                        不用了
                      </button>
                    </div>
                  )}
                  {m.actionState === 'running' && <div className="mt-2 text-xs text-zinc-400">执行中…</div>}
                  {m.actionState === 'done' && <div className="mt-2 text-xs text-zinc-500">{m.actionResult}</div>}
                  {m.actionState === 'dismissed' && <div className="mt-2 text-xs text-zinc-400">已取消</div>}
                </div>
              )}
              {m.memories && (
                <div className="mt-2 w-[92%] flex flex-wrap gap-1.5">
                  {m.memories.map(mem =>
                    m.savedMemories?.includes(mem) ? (
                      <span key={mem} className="text-xs px-2 py-1 rounded-lg text-zinc-400">已记住：{mem}</span>
                    ) : (
                      <button key={mem} onClick={() => void remember(i, mem)} className="text-xs px-2 py-1 rounded-lg border border-ink/[0.08] text-zinc-600 hover:bg-ink/5 text-left">
                        📌 记住：{mem}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className={`border-t border-ink/5 flex items-center gap-2 ${props.panel ? 'px-3 py-2.5' : 'px-4 py-3'}`}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ask()}
            placeholder="问你的 Agent…"
            className="flex-1 bg-zinc-50 rounded-xl px-3.5 py-2.5 text-sm outline-none"
          />
          <button
            onClick={ask}
            disabled={streaming || aiState?.ready === false}
            className="text-sm px-4 py-2.5 rounded-xl bg-accent text-on-accent disabled:opacity-40 hover:bg-blue-700"
          >
            {streaming ? '思考中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}