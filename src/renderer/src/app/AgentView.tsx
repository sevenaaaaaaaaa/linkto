import { useEffect, useRef, useState } from 'react'
import { useAsync, fmtFullDate } from '../lib/api'
import { api } from '../lib/api'
import { IconSearch, IconClose, IconSparkles, IconPlus, IconSave, IconPin, IconHeart, IconUsers, IconBellRing, IconRefresh } from '../components/icons'
import type { AgentAction, AgentActionType, AgentMemory, ContactProfile, MemoryScope } from '@shared/types'
import { Markdown } from '../components/Markdown'

const SCOPE_META: Record<MemoryScope, { label: string; icon: React.ReactNode; color: string }> = {
  fact: { label: '事实', icon: <IconPin width={11} height={11} />, color: 'var(--info)' },
  preference: { label: '偏好', icon: <IconHeart width={11} height={11} />, color: 'var(--warn)' },
  person: { label: '人物关系', icon: <IconUsers width={11} height={11} />, color: 'var(--cat-newsletter)' },
  commitment: { label: '承诺', icon: <IconBellRing width={11} height={11} />, color: 'var(--danger)' },
  routine: { label: '惯例', icon: <IconRefresh width={11} height={11} />, color: 'var(--ok)' }
}

const FILTERS: (MemoryScope | 'all')[] = ['all', 'fact', 'preference', 'person', 'commitment', 'routine']

/** Agent 视图：长期记忆管理 + Agent 对话 + 发件人画像 —— 个人 Agent 日积月累的成长面板 */
export function AgentView() {
  const [scope, setScope] = useState<MemoryScope | 'all'>('all')
  const [q, setQ] = useState('')
  const { data: memories, reload } = useAsync(() => api.listMemories(scope), [scope])
  const { data: stats, reload: reloadStats } = useAsync(() => api.memoryStats(), [scope])
  const [editing, setEditing] = useState<AgentMemory | null>(null)
  const [creating, setCreating] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [profileAddr, setProfileAddr] = useState('')
  const [profile, setProfile] = useState<ContactProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')

  const reloadAll = () => {
    reload()
    reloadStats()
  }

  useEffect(() => {
    return api.onEvent(ev => {
      const e = ev as { type: string }
      if (e.type === 'agent-changed') reloadAll()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const filtered = (memories ?? []).filter(m => {
    if (m.status === 'archived') return false
    if (!q.trim()) return true
    return `${m.title} ${m.content} ${m.entity}`.toLowerCase().includes(q.toLowerCase())
  })
  const archivedCount = (memories ?? []).filter(m => m.status === 'archived').length

  const runProfile = async () => {
    const addr = profileAddr.trim()
    if (!addr || profileLoading) return
    setProfileLoading(true)
    setProfileError('')
    setProfile(null)
    const res = await api.agentProfile(addr)
    setProfileLoading(false)
    if (res.ok && res.profile) setProfile(res.profile)
    else setProfileError(res.error ?? '生成失败')
  }

  return (
    <div className="flex-1 h-full flex flex-col bg-transparent">
      <div className="drag-region h-[52px] shrink-0" />
      <div className="shrink-0 px-6 pb-3 flex items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-accent inline-flex items-center justify-center text-on-accent">
              <IconSparkles width={13} height={13} />
            </span>
            Agent
          </h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            你的个人 AI Agent：从邮件中日积月累地了解你 · {stats ? `${stats.total} 条记忆，本周 +${stats.weekNew}` : '…'}
          </p>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 bg-white border border-ink/[0.06] rounded-xl px-3 py-2 w-56 shadow-[var(--shadow-sm)]">
          <IconSearch width={14} height={14} className="text-zinc-400" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="搜索记忆"
            className="flex-1 outline-none text-sm bg-transparent"
          />
        </div>
        <button
          onClick={() => setChatOpen(true)}
          className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-xl bg-accent text-on-accent shadow-[var(--shadow-sm)] hover:opacity-90"
        >
          <IconSparkles width={13} height={13} /> 和 Agent 聊聊
        </button>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] text-zinc-700 hover:bg-zinc-50"
        >
          <IconPlus width={13} height={13} /> 记一条
        </button>
      </div>

      {/* 分域过滤 + 发件人画像 */}
      <div className="shrink-0 px-6 pb-3 flex items-center gap-2">
        {FILTERS.map(f => {
          const active = scope === f
          const label = f === 'all' ? '全部' : SCOPE_META[f].label
          const count = f === 'all' ? stats?.total : stats?.byScope?.[f]
          return (
            <button
              key={f}
              onClick={() => setScope(f)}
              className="text-xs px-2.5 py-1.5 rounded-lg border transition"
              style={{
                background: active ? 'var(--selected)' : 'var(--surface-strong)',
                borderColor: active ? 'oklch(from var(--accent) l c h / 0.35)' : 'var(--border-soft)',
                color: active ? 'var(--accent-ink)' : 'var(--faint)'
              }}
            >
              {f !== 'all' && <span className="mr-1 inline-flex align-[-1.5px]">{SCOPE_META[f].icon}</span>}
              {label}
              {typeof count === 'number' ? ` · ${count}` : ''}
            </button>
          )
        })}
        <div className="flex-1" />
        {archivedCount > 0 && (
          <span className="text-xs text-zinc-300">{archivedCount} 条已归档</span>
        )}
        <div className="flex items-center gap-1.5 bg-white border border-ink/[0.06] rounded-xl px-3 py-1.5 w-64 shadow-[var(--shadow-sm)]">
          <span className="text-2xs text-zinc-400 shrink-0">画像</span>
          <input
            value={profileAddr}
            onChange={e => setProfileAddr(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runProfile()}
            placeholder="邮箱或域名，如 stripe.com"
            className="flex-1 outline-none text-xs bg-transparent min-w-0"
          />
          <button
            onClick={runProfile}
            disabled={profileLoading}
            className="text-xs px-2 py-0.5 rounded-md bg-ink text-app hover:bg-ink/85 disabled:opacity-40"
          >
            {profileLoading ? '分析中…' : '生成'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {/* 画像结果 */}
        {(profile || profileError) && (
          <div className="mb-4 rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] p-4">
            {profileError ? (
              <div className="text-sm text-zinc-400">{profileError}</div>
            ) : profile ? (
              <>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-base font-semibold text-zinc-800">{profile.displayName}</span>
                  <span className="text-xs text-zinc-400">{profile.addr}</span>
                  <span className="text-2xs px-1.5 py-px rounded-sm bg-zinc-100 text-zinc-500">{profile.mailCount} 封往来</span>
                  <span className="text-2xs px-1.5 py-px rounded-sm bg-zinc-100 text-zinc-500">我的回复率 {profile.myReplyRate}%</span>
                  <div className="flex-1" />
                  <button
                    onClick={() => {
                      setProfile(null)
                      setProfileError('')
                    }}
                    className="text-zinc-300 hover:text-zinc-500"
                  >
                    <IconClose width={13} height={13} />
                  </button>
                </div>
                <p className="text-sm text-zinc-600 leading-relaxed">{profile.summary}</p>
                {profile.topTopics.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {profile.topTopics.map(t => (
                      <span key={t} className="text-2xs px-2 py-0.5 rounded-full bg-violet-50 text-violet-600">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                {profile.keyFacts.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {profile.keyFacts.map(f => (
                      <li key={f} className="text-xs text-zinc-500 leading-relaxed">
                        · {f}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-2 text-2xs text-zinc-300">
                  首次联系 {fmtFullDate(profile.firstContact)} · 最近 {fmtFullDate(profile.lastContact)} · 关键事实已沉淀为人物记忆
                </div>
              </>
            ) : null}
          </div>
        )}

        {/* 最常用记忆 */}
        {scope === 'all' && stats?.topUsed?.length ? (
          <div className="mb-3 px-1 flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-zinc-400">Agent 最常用：</span>
            {stats.topUsed.map(m => (
              <span key={m.id} className="text-2xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-500 truncate max-w-[220px]" title={m.content}>
                <span className="inline-flex align-[-1.5px] mr-0.5">{SCOPE_META[m.scope]?.icon}</span> {m.title}
              </span>
            ))}
          </div>
        ) : null}

        {!filtered.length && (
          <div className="mt-24 text-center text-sm text-zinc-300">
            {scope === 'all' ? (
              <>
                Agent 的记忆还是空的。
                <br />
                阅读邮件时点击 AI 面板的「学习」按钮，或每天生成「今日商情」后 Agent 会自动学习。
              </>
            ) : (
              '这个分类下还没有记忆。'
            )}
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {filtered.map(m => {
            const meta = SCOPE_META[m.scope] ?? SCOPE_META.fact
            return (
              <div key={m.id} className="rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] p-4 group">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="text-2xs px-1.5 py-px rounded-sm inline-flex items-center gap-1" style={{ background: `${meta.color}14`, color: meta.color }}>
                    {meta.icon} {meta.label}
                  </span>
                  {m.source === 'manual' && <span className="text-2xs px-1.5 py-px rounded-sm bg-zinc-100 text-zinc-500">手动</span>}
                  {m.entity && <span className="text-2xs text-zinc-300 truncate max-w-[140px]">{m.entity}</span>}
                  <div className="flex-1" />
                  <span className="text-2xs text-zinc-300 shrink-0">×{m.useCount}</span>
                </div>
                <div className="text-sm font-medium text-zinc-800">{m.title}</div>
                <div className="mt-1 text-xs text-zinc-500 leading-relaxed line-clamp-4">{m.content}</div>
                <div className="mt-2 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="text-2xs text-zinc-300">{fmtFullDate(m.updatedAt)}</span>
                  <div className="flex-1" />
                  <button onClick={() => setEditing(m)} className="text-xs text-zinc-400 hover:text-zinc-700">
                    编辑
                  </button>
                  <button
                    onClick={async () => {
                      await api.updateMemory(m.id, { status: 'archived' })
                      reloadAll()
                    }}
                    className="text-xs text-zinc-400 hover:text-zinc-700"
                  >
                    归档
                  </button>
                  <button
                    onClick={async () => {
                      await api.deleteMemory(m.id)
                      reloadAll()
                    }}
                    className="text-xs text-red-300 hover:text-red-500"
                  >
                    删除
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {(editing || creating) && (
        <MemoryEditor
          item={editing}
          defaultScope={scope === 'all' ? 'fact' : scope}
          onClose={() => {
            setEditing(null)
            setCreating(false)
            reloadAll()
          }}
        />
      )}
      {chatOpen && <AgentChat onClose={() => setChatOpen(false)} />}
    </div>
  )
}

function MemoryEditor(props: { item: AgentMemory | null; defaultScope: MemoryScope; onClose(): void }) {
  const [scope, setScope] = useState<MemoryScope>(props.item?.scope ?? props.defaultScope)
  const [title, setTitle] = useState(props.item?.title ?? '')
  const [content, setContent] = useState(props.item?.content ?? '')
  const [entity, setEntity] = useState(props.item?.entity ?? '')

  const save = async () => {
    if (!title.trim()) return
    if (props.item) {
      await api.updateMemory(props.item.id, { title, content, scope })
      if (entity !== props.item.entity) {
        // entity 变更走删除重建（upsert 以 entity+title 去重）
        await api.deleteMemory(props.item.id)
        await api.saveMemory({ scope, title, content, entity })
      }
    } else {
      await api.saveMemory({ scope, title, content, entity })
    }
    props.onClose()
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/30 flex items-center justify-center" onClick={props.onClose}>
      <div
        className="w-[520px] bg-white rounded-2xl shadow-[var(--shadow-float)] flex flex-col overflow-hidden fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-ink/5 flex items-center gap-2">
          <span className="text-base font-semibold text-zinc-800">{props.item ? '编辑记忆' : '记一条'}</span>
          <div className="flex-1" />
          <select
            value={scope}
            onChange={e => setScope(e.target.value as MemoryScope)}
            className="text-xs bg-zinc-50 rounded-lg px-2 py-1 outline-none"
          >
            {FILTERS.filter(f => f !== 'all').map(f => (
              <option key={f} value={f}>
                <span className="inline-flex align-[-1.5px] mr-0.5">{SCOPE_META[f].icon}</span> {SCOPE_META[f].label}
              </option>
            ))}
          </select>
        </div>
        <div className="px-5 py-4 space-y-3">
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="w-full text-base font-medium outline-none bg-zinc-50 rounded-xl px-3 py-2.5"
            placeholder="标题，如：合作方坚持用邮件确认"
          />
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            className="w-full h-24 resize-none text-sm leading-relaxed outline-none bg-zinc-50 rounded-xl px-3 py-2.5"
            placeholder="记忆内容（会被 Agent 在起草/问答/商情中主动参考）"
          />
          <input
            value={entity}
            onChange={e => setEntity(e.target.value)}
            className="w-full text-xs outline-none bg-zinc-50 rounded-lg px-3 py-2"
            placeholder="关联实体（可选）：邮箱或域名，如 boss@acme.com"
          />
        </div>
        <div className="px-5 py-3 border-t border-ink/5 flex justify-end">
          <button onClick={props.onClose} className="text-sm px-3 py-1.5 rounded-lg text-zinc-500 hover:bg-ink/5">
            取消
          </button>
          <button onClick={save} className="ml-2 flex items-center gap-1.5 text-sm px-3.5 py-1.5 rounded-lg bg-blue-600 text-on-accent hover:bg-blue-700">
            <IconSave width={12} height={12} /> 保存
          </button>
        </div>
      </div>
    </div>
  )
}

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
            next[next.length - 1] = { role: 'assistant', text: `出错了：${e.error}` }
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
                {m.role === 'assistant' ? (
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