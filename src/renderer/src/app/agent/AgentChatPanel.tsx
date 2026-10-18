import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRef, AgentSkill, AgentStep, AgentThreadSummary, AgentTurn } from '@shared/types'
import { api } from '../../lib/api'
import { useMail } from '../../stores/mail'
import { useView } from '../../lib/route'
import { takePendingAsk } from '../../lib/agent-ask'
import { Markdown } from '../../components/Markdown'
import { AIErrorNote } from '../../components/AIErrorNote'
import { IconChevronDown, IconChevronRight, IconClose, IconPlus, IconSparkles } from '../../components/icons'
import { ActionRow, ConfirmCard, IconArrowUp, IconMail, IconSlash, IconStop, IconTrashSm, RefChips, StepRow, type ToolStep } from './chat-parts'

/**
 * Agent 对话面板（左侧 Agent「对话」页与右侧上下文栏共用）：
 * 会话列表 · 步骤流（工具调用逐行、写操作确认卡）· Markdown 回答 + 来源胶囊 · 「/」技能 · ⌘↩ 发送 / Esc 停止
 */

interface UIUser {
  role: 'user'
  text: string
  at: number
  skillId?: string | null
}
interface UIAssistant {
  role: 'assistant'
  text: string
  at: number
  steps: AgentStep[]
  refs: AgentRef[]
  runId?: string
  running?: boolean
  error?: string
  cancelled?: boolean
  /** 失败后可重试的请求 */
  retry?: RunReq
}
type UITurn = UIUser | UIAssistant

interface RunReq {
  text: string
  skillId?: string | null
  params?: Record<string, string | number>
  /** 显式上下文（技能库按某封邮件运行）；缺省时用右侧栏的当前邮件 */
  context?: { messageId?: string | null; projectId?: string | null } | null
}

const consumedInitial = new WeakSet<object>()

/** 把一个步骤并入助手回合（与主进程的持久化合并规则一致） */
function applyStep(t: UIAssistant, step: AgentStep): UIAssistant {
  const steps = t.steps.slice()
  switch (step.kind) {
    case 'text': {
      const last = steps[steps.length - 1]
      if (last?.kind === 'text') steps[steps.length - 1] = { kind: 'text', delta: last.delta + step.delta }
      else steps.push(step)
      return { ...t, steps }
    }
    case 'plan':
      if (steps[steps.length - 1]?.kind === 'text') steps.pop()
      steps.push(step)
      return { ...t, steps }
    case 'tool': {
      const i = steps.findIndex(s => s.kind === 'tool' && s.callId === step.callId)
      if (i >= 0) steps[i] = step
      else steps.push(step)
      return { ...t, steps }
    }
    case 'refs':
      return { ...t, refs: step.refs }
    case 'done': {
      if (steps[steps.length - 1]?.kind === 'text') steps.pop()
      return { ...t, steps, text: step.text, refs: step.refs, running: false, cancelled: step.cancelled }
    }
    case 'error':
      return { ...t, running: false, error: step.message }
  }
}

function fromTurns(list: AgentTurn[]): UITurn[] {
  return list.map(t =>
    t.role === 'user'
      ? { role: 'user', text: t.text, at: t.at, skillId: t.skillId }
      : {
          role: 'assistant',
          text: t.text,
          at: t.at,
          steps: (t.steps ?? []).filter(s => s.kind !== 'error'),
          refs: t.refs ?? [],
          error: (t.steps?.find(s => s.kind === 'error') as { message?: string } | undefined)?.message
        }
  )
}

/** 回合里「最终回答之前」的部分：最后一个非文本步骤及其之前 */
function splitTurn(t: UIAssistant): { process: AgentStep[]; live: string } {
  let last = -1
  t.steps.forEach((s, i) => {
    if (s.kind !== 'text') last = i
  })
  const live = t.steps
    .slice(last + 1)
    .map(s => (s.kind === 'text' ? s.delta : ''))
    .join('')
  return { process: t.steps.slice(0, last + 1), live }
}

export function AgentChatPanel(props: {
  threadId?: string | null
  panel?: boolean
  onClose?(): void
  /** 打开即发起：普通提问或按技能运行 */
  initial?: { text?: string; skillId?: string | null; params?: Record<string, string | number>; context?: { messageId?: string | null; projectId?: string | null } | null } | null
  onThreadChange?(id: string): void
}) {
  const panel = !!props.panel
  const view = useView()
  const selectedId = useMail(s => s.selectedId)
  const messages = useMail(s => s.messages)
  const [threadId, setThreadId] = useState<string | null>(props.threadId ?? null)
  const [threads, setThreads] = useState<AgentThreadSummary[]>([])
  const [turns, setTurns] = useState<UITurn[]>([])
  const [input, setInput] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [aiState, setAiState] = useState<{ ready: boolean; reason?: string } | null>(null)
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [skill, setSkill] = useState<{ skill: AgentSkill; params: Record<string, string | number> } | null>(null)
  const [pickIndex, setPickIndex] = useState(0)
  const [listOpen, setListOpen] = useState(false)
  const [mailContext, setMailContext] = useState(true)
  const [deciding, setDeciding] = useState<string | null>(null)
  const runRef = useRef<string | null>(null)
  const threadRef = useRef<string | null>(threadId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  runRef.current = runId
  threadRef.current = threadId

  // 当前邮件上下文：右侧栏在邮件视图里，跟随阅读页选中的邮件
  const contextMsg = panel && view === 'mail' && selectedId && mailContext ? messages.find(m => m.id === selectedId) ?? { id: selectedId, subject: '', from: null } : null
  useEffect(() => setMailContext(true), [selectedId])

  const loadThreads = useCallback(() => {
    void api.agentThreads().then(setThreads).catch(() => {})
  }, [])

  useEffect(() => {
    void api.aiStatus().then(setAiState).catch(() => {})
    void api.agentSkills().then(setSkills).catch(() => {})
    loadThreads()
  }, [loadThreads])

  // 外部指定的会话
  useEffect(() => {
    if (props.threadId === undefined || props.threadId === threadRef.current) return
    void openThread(props.threadId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.threadId])

  // 首次挂载：带了 threadId 就载入
  useEffect(() => {
    if (props.threadId) void openThread(props.threadId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openThread = async (id: string | null) => {
    setListOpen(false)
    // 切走正在运行的对话：先停止（避免确认卡悬空）
    if (runRef.current) {
      void api.agentCancel(runRef.current)
      setRunId(null)
      runRef.current = null
    }
    setThreadId(id)
    setSkill(null)
    if (!id) {
      setTurns([])
      return
    }
    const t = await api.agentThread(id).catch(() => null)
    if (threadRef.current !== id) return
    setTurns(t ? fromTurns(t.messages) : [])
    stick.current = true
  }

  // 步骤事件：按 runId 认领
  useEffect(() => {
    return api.onEvent(ev => {
      const e = ev as { type: string; runId?: string; step?: AgentStep }
      if (e.type === 'agent-threads-changed') return loadThreads()
      if (e.type === 'agent-skills-changed') return void api.agentSkills().then(setSkills).catch(() => {})
      if (e.type !== 'agent-step' || !e.step || !e.runId || e.runId !== runRef.current) return
      const step = e.step
      setTurns(prev => {
        const i = prev.findIndex(t => t.role === 'assistant' && t.runId === e.runId)
        if (i < 0) return prev
        const next = prev.slice()
        next[i] = applyStep(prev[i] as UIAssistant, step)
        return next
      })
      if (step.kind === 'done' || step.kind === 'error') setRunId(null)
    })
  }, [loadThreads])

  // 跟随滚动：用户往上翻时不打扰
  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [turns])
  const onScroll = () => {
    const el = scrollRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const send = useCallback(
    async (req: RunReq, opts: { fresh?: boolean } = {}) => {
      if (runRef.current) return
      const text = req.text.trim()
      if (!text && !req.skillId) return
      const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const sk = req.skillId ? skills.find(s => s.id === req.skillId) : null
      const tid = opts.fresh ? null : threadRef.current
      if (opts.fresh) {
        setThreadId(null)
        threadRef.current = null
      }
      const userTurn: UIUser = { role: 'user', text: text || `运行技能「${sk?.name ?? req.skillId}」`, at: Date.now(), skillId: req.skillId ?? null }
      const placeholder: UIAssistant = { role: 'assistant', text: '', at: Date.now(), steps: [], refs: [], runId: id, running: true, retry: req }
      setTurns(prev => [...(opts.fresh ? [] : prev), userTurn, placeholder])
      setRunId(id)
      runRef.current = id
      stick.current = true
      // 需要针对一封邮件的技能（contextKind='message'）：显式上下文 > params.messageId > 当前邮件
      const pm = req.params?.messageId
      const ctx = req.context?.messageId || req.context?.projectId
        ? { messageId: req.context.messageId ?? null, projectId: req.context.projectId ?? null }
        : pm
          ? { messageId: String(pm) }
          : contextMsg
            ? { messageId: contextMsg.id }
            : undefined
      try {
        const res = await api.agentRun({ runId: id, threadId: tid, text, skillId: req.skillId ?? null, params: req.params, context: ctx })
        if (!res.ok) {
          setTurns(prev => prev.map(t => (t.role === 'assistant' && t.runId === id ? { ...t, running: false, error: res.error ?? '没能开始运行' } : t)))
          setRunId(null)
          return
        }
        if (res.threadId && res.threadId !== threadRef.current) {
          setThreadId(res.threadId)
          threadRef.current = res.threadId
          props.onThreadChange?.(res.threadId)
        }
      } catch (err) {
        setTurns(prev => prev.map(t => (t.role === 'assistant' && t.runId === id ? { ...t, running: false, error: err instanceof Error ? err.message : String(err) } : t)))
        setRunId(null)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skills, contextMsg?.id, props.onThreadChange]
  )

  // 打开即发起（技能库「运行」、自动任务结果「继续追问」等）
  useEffect(() => {
    const init = props.initial
    if (!init || consumedInitial.has(init) || (!init.text?.trim() && !init.skillId)) return
    consumedInitial.add(init)
    void send({ text: init.text ?? '', skillId: init.skillId ?? null, params: init.params, context: init.context ?? null }, { fresh: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.initial])

  // 其他页面交来的问题（命令面板 / 待办「会前准备」/ 搜索）：挂载时和事件到达时各领取一次，开新对话
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    const take = () => {
      if (runRef.current) return
      const q = takePendingAsk()
      if (q) void sendRef.current({ text: q }, { fresh: true })
    }
    take()
    window.addEventListener('ms:agent-ask', take)
    return () => window.removeEventListener('ms:agent-ask', take)
  }, [])

  const cancel = () => {
    if (runRef.current) void api.agentCancel(runRef.current)
  }

  const decide = async (callId: string, approve: boolean, remember?: boolean) => {
    if (!runRef.current) return
    setDeciding(callId)
    await api.agentApprove(runRef.current, callId, approve, remember).catch(() => {})
    setDeciding(null)
  }

  const newThread = () => {
    if (runRef.current) cancel()
    void openThread(null)
    setInput('')
    inputRef.current?.focus()
  }

  const deleteThread = async (id: string) => {
    await api.agentDeleteThread(id).catch(() => {})
    if (id === threadRef.current) void openThread(null)
    loadThreads()
  }

  // ---------------------------------------------------------------- 输入框

  const picking = !skill && /^[/／][^\s]*$/.test(input)
  const pickList = useMemo(() => {
    if (!picking) return []
    const q = input.slice(1).toLowerCase()
    return skills.filter(s => !q || `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(q)).slice(0, 8)
  }, [picking, input, skills])
  useEffect(() => setPickIndex(0), [input])

  const chooseSkill = (s: AgentSkill) => {
    const params: Record<string, string | number> = {}
    for (const p of s.params ?? []) if (p.default !== undefined) params[p.key] = p.default
    setSkill({ skill: s, params })
    setInput('')
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const submit = () => {
    if (runRef.current || aiState?.ready === false) return
    if (skill) {
      const missing = (skill.skill.params ?? []).filter(p => p.required && !String(skill.params[p.key] ?? '').trim())
      if (missing.length) return
      const needsMail = (skill.skill as AgentSkill & { contextKind?: 'message' | null }).contextKind === 'message'
      void send({ text: input.trim(), skillId: skill.skill.id, params: needsMail && contextMsg && !skill.params.messageId ? { ...skill.params, messageId: contextMsg.id } : skill.params })
      setSkill(null)
      setInput('')
      return
    }
    const q = input.trim()
    if (!q || picking) return
    setInput('')
    void send({ text: q })
  }

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (picking && pickList.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPickIndex(i => (i + 1) % pickList.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPickIndex(i => (i - 1 + pickList.length) % pickList.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        chooseSkill(pickList[pickIndex] ?? pickList[0])
        return
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'Escape') {
      if (runRef.current) {
        e.preventDefault()
        cancel()
      } else if (picking) setInput('')
      else if (skill) setSkill(null)
    }
  }

  // 运行中按 Esc 停止（焦点不在输入框时也生效，只在面板内）
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !runRef.current) return
      if (rootRef.current && document.activeElement && rootRef.current.contains(document.activeElement)) {
        e.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  // 自动增高
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, panel ? 140 : 200)}px`
  }, [input, panel])

  const suggestions = useMemo(() => {
    if (contextMsg) {
      return [
        '这封邮件要我做什么？有截止时间吗？',
        '帮我起草一封得体的回复',
        '我和发件人之前都聊过什么？有没有我答应过 TA 的事？',
        '这封邮件里有要付的钱或要开的票吗？',
        '把这封邮件里的事项建成待办'
      ]
    }
    return [
      '今天有哪些邮件需要我处理？按紧急程度排',
      '这个月花了多少钱？订阅一年要多少？',
      '我发出去还没人回的邮件有哪些？',
      '有哪些逾期的待办和待付款？',
      '最近收到了哪些合同或发票附件？',
      '各个项目现在进展到哪了？'
    ]
  }, [contextMsg])

  const current = threads.find(t => t.id === threadId)
  const running = !!runId
  const canSend = !running && aiState?.ready !== false && (skill ? !(skill.skill.params ?? []).some(p => p.required && !String(skill.params[p.key] ?? '').trim()) : !!input.trim() && !picking)

  // ---------------------------------------------------------------- 渲染

  const threadList = (
    <div className="flex flex-col gap-0.5">
      {threads.length === 0 && (
        <div className="px-2 py-3 text-xs" style={{ color: 'var(--faint)' }}>
          还没有对话
        </div>
      )}
      {threads.map(t => (
        <div key={t.id} className="group relative">
          <button
            type="button"
            onClick={() => void openThread(t.id)}
            className="w-full text-left h-8 pl-2.5 pr-8 rounded-[var(--r-sm)] text-xs truncate transition-colors hover:bg-[var(--hover)]"
            style={t.id === threadId ? { background: 'var(--selected)', color: 'var(--fg)', fontWeight: 600 } : { color: 'var(--muted)' }}
            title={t.title}
          >
            {t.title}
          </button>
          <button
            type="button"
            onClick={() => void deleteThread(t.id)}
            aria-label={`删除对话「${t.title}」`}
            title="删除"
            className="absolute right-1 top-1 w-6 h-6 rounded-[var(--r-xs)] inline-flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-[var(--hover-strong)]"
            style={{ color: 'var(--faint)' }}
          >
            <IconTrashSm width={12} height={12} />
          </button>
        </div>
      ))}
    </div>
  )

  return (
    <div ref={rootRef} className={`h-full min-h-0 flex ${panel ? 'flex-col' : 'flex-row'}`} style={{ background: panel ? undefined : 'var(--bg)' }}>
      {/* 会话列表：页面模式是左侧一列，右侧栏模式折叠成下拉 */}
      {!panel && (
        <aside className="w-[220px] shrink-0 h-full flex flex-col border-r border-[var(--border-soft)]">
          <div className="h-12 shrink-0 px-3 flex items-center">
            <button
              type="button"
              onClick={newThread}
              className="no-drag w-full h-8 px-2.5 rounded-[var(--r-sm)] text-xs font-medium inline-flex items-center gap-1.5 border border-[var(--border)] hover:bg-[var(--hover)]"
              style={{ color: 'var(--fg)' }}
            >
              <IconPlus width={12} height={12} />
              新对话
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">{threadList}</div>
        </aside>
      )}

      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <div className={`relative shrink-0 flex items-center gap-1 border-b border-[var(--border-soft)] ${panel ? 'h-10 px-2' : 'h-12 px-5'}`}>
          {panel ? (
            <button
              type="button"
              onClick={() => setListOpen(o => !o)}
              aria-expanded={listOpen}
              className="no-drag min-w-0 h-7 px-2 rounded-[var(--r-sm)] inline-flex items-center gap-1 text-xs hover:bg-[var(--hover)]"
              style={{ color: 'var(--fg)' }}
            >
              <span className="truncate font-medium">{current?.title ?? '新对话'}</span>
              <IconChevronDown width={11} height={11} style={{ color: 'var(--faint)' }} />
            </button>
          ) : (
            <div className="min-w-0 flex items-center gap-2">
              <span className="text-sm font-semibold truncate" style={{ color: 'var(--fg)' }}>
                {current?.title ?? '新对话'}
              </span>
              {running && <span className="text-2xs" style={{ color: 'var(--faint)' }}>运行中…</span>}
            </div>
          )}
          <div className="flex-1" />
          {panel && (
            <button type="button" onClick={newThread} title="新对话" aria-label="新对话" className="no-drag icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--muted)' }}>
              <IconPlus width={13} height={13} />
            </button>
          )}
          {panel && listOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setListOpen(false)} />
              <div
                className="absolute z-30 left-2 right-2 top-9 max-h-[60vh] overflow-y-auto rounded-[var(--r-md)] border border-[var(--border)] p-1.5 pop-in"
                style={{ background: 'var(--surface-strong)', boxShadow: 'var(--shadow-float)' }}
              >
                <button
                  type="button"
                  onClick={newThread}
                  className="w-full h-8 px-2.5 mb-1 rounded-[var(--r-sm)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--hover)]"
                  style={{ color: 'var(--fg)' }}
                >
                  <IconPlus width={12} height={12} />
                  新对话
                </button>
                {threadList}
              </div>
            </>
          )}
        </div>

        <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto">
          <div className={`mx-auto flex flex-col gap-5 ${panel ? 'px-3 py-4' : 'max-w-[760px] px-6 py-6'}`}>
            {aiState?.ready === false && (
              <div className="rounded-[var(--r-md)] border border-[var(--border)] px-3.5 py-3 text-xs leading-5 flex items-center gap-3" style={{ background: 'var(--surface-strong)', color: 'var(--muted)' }}>
                <span className="flex-1">Agent 需要 AI 模型才能工作（{aiState.reason}）。云端 API、Ollama / LM Studio 本地模型都可以。</span>
                <button type="button" onClick={() => api.openSettings('ai')} className="shrink-0 h-7 px-3 rounded-[var(--r-sm)] text-xs font-semibold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
                  去配置
                </button>
              </div>
            )}

            {!turns.length && (
              <Empty
                panel={panel}
                hasContext={!!contextMsg}
                suggestions={suggestions}
                disabled={aiState?.ready === false}
                onPick={q => void send({ text: q })}
              />
            )}

            {turns.map((t, i) =>
              t.role === 'user' ? (
                <div key={i} className="flex justify-end fade-in">
                  <div
                    className="max-w-[88%] rounded-[var(--r-md)] px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap selectable"
                    style={{ background: 'var(--bg-soft)', color: 'var(--fg)', borderTopRightRadius: 'var(--r-xs)' }}
                  >
                    {t.skillId && (
                      <span className="mr-1.5 inline-flex items-center gap-0.5 text-2xs align-[1px]" style={{ color: 'var(--faint)' }}>
                        <IconSlash width={10} height={10} />
                        技能
                      </span>
                    )}
                    {t.text}
                  </div>
                </div>
              ) : (
                <AssistantTurn
                  key={i}
                  turn={t}
                  panel={panel}
                  deciding={deciding}
                  onDecide={(callId, approve, remember) => void decide(callId, approve, remember)}
                  onRetry={t.retry && i === turns.length - 1 && !running ? () => void send(t.retry!) : undefined}
                />
              )
            )}
          </div>
        </div>

        {/* 输入区 */}
        <div className={`shrink-0 ${panel ? 'px-3 pb-3 pt-2' : 'px-6 pb-5 pt-2'}`}>
          <div className={`relative ${panel ? '' : 'max-w-[760px] mx-auto'}`}>
            {picking && (
              <div
                role="listbox"
                aria-label="技能"
                className="absolute z-30 left-0 right-0 bottom-full mb-2 max-h-72 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border)] p-1.5 pop-in"
                style={{ background: 'var(--surface-strong)', boxShadow: 'var(--shadow-float)' }}
              >
                {pickList.length ? (
                  pickList.map((s, k) => (
                    <button
                      key={s.id}
                      type="button"
                      role="option"
                      aria-selected={k === pickIndex}
                      onMouseEnter={() => setPickIndex(k)}
                      onClick={() => chooseSkill(s)}
                      className="w-full text-left px-2.5 py-1.5 rounded-[var(--r-sm)] flex items-baseline gap-2"
                      style={k === pickIndex ? { background: 'var(--hover-strong)' } : undefined}
                    >
                      <span className="shrink-0 text-xs font-medium" style={{ color: 'var(--fg)' }}>
                        /{s.name}
                      </span>
                      <span className="min-w-0 truncate text-2xs" style={{ color: 'var(--faint)' }}>
                        {s.description}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="px-2.5 py-2 text-xs" style={{ color: 'var(--faint)' }}>
                    {skills.length ? '没有匹配的技能' : '还没有技能，可以在 Agent 的技能库里添加'}
                  </div>
                )}
              </div>
            )}

            <div className="rounded-[var(--r-md)] border border-[var(--border)] focus-within:border-[var(--border-strong)] transition-colors" style={{ background: 'var(--surface-strong)' }}>
              {(contextMsg || skill) && (
                <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2">
                  {contextMsg && !skill && (
                    <span className="h-6 max-w-full pl-2 pr-1 rounded-full inline-flex items-center gap-1 text-2xs border border-[var(--border)]" style={{ color: 'var(--muted)' }}>
                      <IconMail width={11} height={11} />
                      <span className="truncate max-w-[200px]">{contextMsg.subject || '当前邮件'}</span>
                      <button type="button" onClick={() => setMailContext(false)} aria-label="不带当前邮件" className="w-4 h-4 inline-flex items-center justify-center rounded-full hover:bg-[var(--hover-strong)]">
                        <IconClose width={8} height={8} />
                      </button>
                    </span>
                  )}
                  {skill && <SkillForm value={skill} onChange={setSkill} panel={panel} />}
                </div>
              )}
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={onKey}
                rows={1}
                disabled={aiState?.ready === false}
                placeholder={skill ? '补充说明（可选）' : running ? 'Agent 正在工作…  Esc 停止' : '问 Agent，或输入 / 选择技能'}
                className="block w-full resize-none bg-transparent outline-none px-3 pt-2.5 pb-1 text-sm leading-6 selectable"
                style={{ color: 'var(--fg)' }}
                aria-label="给 Agent 的消息"
              />
              <div className="flex items-center gap-1.5 px-2 pb-2">
                <button
                  type="button"
                  onClick={() => {
                    setInput('/')
                    inputRef.current?.focus()
                  }}
                  title="技能（输入 /）"
                  aria-label="选择技能"
                  className="no-drag icon-btn w-7 h-7 inline-flex items-center justify-center"
                  style={{ color: 'var(--faint)' }}
                >
                  <IconSlash width={13} height={13} />
                </button>
                <span className="text-2xs" style={{ color: 'var(--faint)' }}>
                  {running ? 'Esc 停止' : '⌘↩ 发送'}
                </span>
                <div className="flex-1" />
                {running ? (
                  <button
                    type="button"
                    onClick={cancel}
                    aria-label="停止"
                    title="停止（Esc）"
                    className="h-7 px-2.5 rounded-[var(--r-sm)] inline-flex items-center gap-1.5 text-xs font-medium border border-[var(--border)] hover:bg-[var(--hover)]"
                    style={{ color: 'var(--fg)' }}
                  >
                    <IconStop width={11} height={11} />
                    停止
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!canSend}
                    aria-label={skill ? '运行技能' : '发送'}
                    className="h-7 px-2.5 rounded-[var(--r-sm)] inline-flex items-center gap-1 text-xs font-semibold transition-transform active:scale-[.97] disabled:opacity-35"
                    style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                  >
                    {skill ? '运行' : <IconArrowUp width={13} height={13} />}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 助手回合

function AssistantTurn(props: { turn: UIAssistant; panel: boolean; deciding: string | null; onDecide(callId: string, approve: boolean, remember?: boolean): void; onRetry?: () => void }) {
  const t = props.turn
  const { process, live } = splitTurn(t)
  const answer = t.running ? live : t.text || live
  const tools = process.filter((s): s is ToolStep => s.kind === 'tool')
  const reads = tools.filter(s => s.risk === 'read')
  const [open, setOpen] = useState(false)
  const collapsed = !t.running && reads.length > 0 && !open
  const thinking = t.running && !answer && !tools.some(s => s.status === 'running' || s.status === 'awaiting')

  return (
    <div className="flex flex-col gap-2.5 fade-in">
      {/* 过程：运行中逐步展开；结束后查询步骤折叠成一行，写操作始终可见 */}
      {process.length > 0 &&
        (collapsed ? (
          <>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="self-start max-w-full h-7 px-2 -mx-2 rounded-[var(--r-sm)] inline-flex items-center gap-1.5 text-xs hover:bg-[var(--hover)]"
              style={{ color: 'var(--faint)' }}
            >
              <IconChevronRight width={11} height={11} />
              <span className="truncate">
                查证 {reads.length} 步 · {[...new Set(reads.map(s => s.title))].slice(0, 4).join('、')}
              </span>
            </button>
            {tools
              .filter(s => s.risk !== 'read')
              .map(s => (
                <ActionRow key={s.callId} step={s} />
              ))}
          </>
        ) : (
          <div className="flex flex-col gap-1">
            {!t.running && reads.length > 0 && (
              <button type="button" onClick={() => setOpen(false)} className="self-start h-6 px-2 -mx-2 rounded-[var(--r-sm)] inline-flex items-center gap-1.5 text-2xs hover:bg-[var(--hover)]" style={{ color: 'var(--faint)' }}>
                <IconChevronDown width={11} height={11} />
                收起过程
              </button>
            )}
            {process.map((s, k) => {
              if (s.kind === 'plan')
                return (
                  <div key={k} className="text-xs leading-5 py-0.5 fade-in" style={{ color: 'var(--muted)' }}>
                    {s.text}
                  </div>
                )
              if (s.kind === 'text')
                return s.delta.trim() ? (
                  <div key={k} className="text-xs leading-5 fade-in" style={{ color: 'var(--muted)' }}>
                    {s.delta.trim()}
                  </div>
                ) : null
              if (s.kind !== 'tool') return null
              if (s.status === 'awaiting')
                return (
                  <div key={s.callId} className="my-1.5">
                    <ConfirmCard step={s} busy={props.deciding === s.callId} onDecide={(a, r) => props.onDecide(s.callId, a, r)} />
                  </div>
                )
              if (s.risk !== 'read' && s.status !== 'running') return <ActionRow key={s.callId} step={s} />
              return <StepRow key={s.callId} step={s} />
            })}
          </div>
        ))}

      {thinking && (
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--faint)' }}>
          <span className="w-1.5 h-1.5 rounded-full animate-pulse motion-reduce:animate-none" style={{ background: 'var(--ai-line)' }} />
          {process.length ? '整理中…' : '思考中…'}
        </div>
      )}

      {answer.trim() && (
        <div className="pl-3 border-l-2 text-sm leading-relaxed selectable" style={{ borderColor: 'var(--ai-line)', color: 'var(--fg)' }}>
          <Markdown text={answer} />
        </div>
      )}

      {t.cancelled && (
        <div className="text-2xs" style={{ color: 'var(--faint)' }}>
          已停止
        </div>
      )}
      {t.error && <AIErrorNote error={t.error} onRetry={props.onRetry} />}
      {!t.running && t.refs.length > 0 && <RefChips refs={t.refs} />}
    </div>
  )
}

// ---------------------------------------------------------------- 空状态 / 技能参数

function Empty(props: { panel: boolean; hasContext: boolean; suggestions: string[]; disabled?: boolean; onPick(q: string): void }) {
  return (
    <div className={`flex flex-col ${props.panel ? 'gap-3 pt-2' : 'gap-4 pt-10'}`}>
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded-[var(--r-xs)] inline-flex items-center justify-center ai-chip">
          <IconSparkles width={12} height={12} />
        </span>
        <span className={`${props.panel ? 'text-sm' : 'text-base'} font-semibold`} style={{ color: 'var(--fg)' }}>
          {props.hasContext ? '关于这封邮件，想问点什么？' : '我能查你的邮件、待办、财务、项目、附件和知识库'}
        </span>
      </div>
      <p className="text-xs leading-5" style={{ color: 'var(--faint)' }}>
        Agent 会先查证再回答；归档、建待办、标记已付这类操作会先让你确认，发信永远要你点头。
      </p>
      <div className={`grid gap-1.5 ${props.panel ? 'grid-cols-1' : 'grid-cols-2'}`}>
        {props.suggestions.map(q => (
          <button
            key={q}
            type="button"
            disabled={props.disabled}
            onClick={() => props.onPick(q)}
            className="text-left px-3 py-2 rounded-[var(--r-sm)] border border-[var(--border-soft)] text-xs leading-5 hover:bg-[var(--hover)] hover:border-[var(--border)] transition-colors disabled:opacity-50"
            style={{ color: 'var(--muted)', background: 'var(--surface)' }}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  )
}

function SkillForm(props: { value: { skill: AgentSkill; params: Record<string, string | number> }; onChange(v: { skill: AgentSkill; params: Record<string, string | number> } | null): void; panel: boolean }) {
  const { skill, params } = props.value
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    if ((skill.params ?? []).some(p => p.kind === 'project')) void api.listProjects().then(list => setProjects(list.map(p => ({ id: p.id, name: p.data.name })))).catch(() => {})
  }, [skill])
  const set = (k: string, v: string | number) => props.onChange({ skill, params: { ...params, [k]: v } })
  const field = 'h-6 px-2 rounded-[var(--r-xs)] border border-[var(--border)] bg-transparent text-2xs outline-none focus:border-[var(--border-strong)]'
  return (
    <div className="w-full flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="h-6 pl-2 pr-1 rounded-full inline-flex items-center gap-1 text-2xs font-semibold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          /{skill.name}
          <button type="button" onClick={() => props.onChange(null)} aria-label="取消技能" className="w-4 h-4 inline-flex items-center justify-center rounded-full hover:opacity-70">
            <IconClose width={8} height={8} />
          </button>
        </span>
        <span className="min-w-0 truncate text-2xs" style={{ color: 'var(--faint)' }}>
          {skill.description}
        </span>
      </div>
      {(skill.params ?? []).length > 0 && (
        <div className={`grid gap-1.5 ${props.panel ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {(skill.params ?? []).map(p => (
            <label key={p.key} className="flex items-center gap-1.5 min-w-0">
              <span className="shrink-0 text-2xs" style={{ color: 'var(--muted)' }}>
                {p.label}
                {p.required ? '*' : ''}
              </span>
              {p.kind === 'select' ? (
                <select value={String(params[p.key] ?? '')} onChange={e => set(p.key, e.target.value)} className={`${field} min-w-0 flex-1`} style={{ color: 'var(--fg)' }}>
                  <option value="">—</option>
                  {(p.options ?? []).map(o => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : p.kind === 'project' ? (
                <select value={String(params[p.key] ?? '')} onChange={e => set(p.key, e.target.value)} className={`${field} min-w-0 flex-1`} style={{ color: 'var(--fg)' }}>
                  <option value="">—</option>
                  {projects.map(o => (
                    <option key={o.id} value={o.name}>
                      {o.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={p.kind === 'days' ? 'number' : p.kind === 'date' ? 'date' : 'text'}
                  min={p.kind === 'days' ? 1 : undefined}
                  value={String(params[p.key] ?? '')}
                  placeholder={p.placeholder ?? (p.kind === 'contact' ? '邮箱或域名' : '')}
                  onChange={e => set(p.key, p.kind === 'days' ? Number(e.target.value) || '' : e.target.value)}
                  className={`${field} min-w-0 flex-1`}
                  style={{ color: 'var(--fg)' }}
                />
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
