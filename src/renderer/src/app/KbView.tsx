import { useEffect, useRef, useState } from 'react'
import { useAsync, fmtFullDate, displayName } from '../lib/api'
import { api } from '../lib/api'
import { IconSearch, IconClose, IconSparkles, IconPlus, IconSave } from '../components/icons'
import { sanitizeEmailHtml } from '../lib/sanitize'
import type { KbItem } from '@shared/types'

/** 知识库视图：浏览 / 检索 / AI 问答 / 手记 */
export function KbView() {
  const { data: items, reload } = useAsync(() => api.listKbItems(), [])
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<KbItem | null>(null)
  const [chatOpen, setChatOpen] = useState(false)

  const filtered = (items ?? []).filter(i =>
    !q.trim() ||
    `${i.title} ${i.content} ${i.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase())
  )

  return (
    <div className="flex-1 h-full flex flex-col bg-[#fafafa]">
      <div className="drag-region h-[52px] shrink-0" />
      <div className="shrink-0 px-6 pb-4 flex items-center gap-3">
        <div>
          <h1 className="text-[19px] font-semibold text-zinc-900">知识库</h1>
          <p className="text-[12px] text-zinc-400 mt-0.5">从邮件沉淀的知识，可被 AI 检索问答 · {items?.length ?? 0} 条</p>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 bg-white border border-black/[0.06] rounded-xl px-3 py-2 w-64 shadow-sm">
          <IconSearch width={14} height={14} className="text-zinc-400" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="搜索知识库"
            className="flex-1 outline-none text-[13px] bg-transparent"
          />
        </div>
        <button
          onClick={() => setChatOpen(true)}
          className="flex items-center gap-1.5 text-[13px] px-3.5 py-2 rounded-xl bg-gradient-to-r from-violet-500 to-blue-500 text-white shadow-sm hover:opacity-90"
        >
          <IconSparkles width={13} height={13} /> AI 问答
        </button>
        <button
          onClick={async () => {
            const item = await api.saveToKb({ kind: 'note', title: '新手记', content: '' })
            setSelected(item)
            reload()
          }}
          className="flex items-center gap-1.5 text-[13px] px-3.5 py-2 rounded-xl bg-white border border-black/[0.06] shadow-sm text-zinc-700 hover:bg-zinc-50"
        >
          <IconPlus width={13} height={13} /> 手记
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {!filtered.length && (
          <div className="mt-24 text-center text-[13.5px] text-zinc-300">
            还没有知识条目。阅读邮件时点击「存知识库」，或新建手记。
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {filtered.map(item => (
            <button
              key={item.id}
              onClick={() => setSelected(item)}
              className="text-left rounded-2xl bg-white border border-black/[0.06] shadow-sm p-4 hover:border-blue-300 transition"
            >
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="text-[10px] px-1.5 py-px rounded bg-zinc-100 text-zinc-500">
                  {item.kind === 'note' ? '手记' : item.kind === 'summary' ? '摘要' : item.kind === 'thread' ? '会话' : '邮件'}
                </span>
                {item.tags.map(t => (
                  <span key={t} className="text-[10px] px-1.5 py-px rounded bg-blue-50 text-blue-600">
                    {t}
                  </span>
                ))}
              </div>
              <div className="text-[13.5px] font-medium text-zinc-800 truncate">{item.title}</div>
              <div className="mt-1 text-[12px] text-zinc-400 line-clamp-3 leading-relaxed">
                {item.content.slice(0, 120) || '（空白手记）'}
              </div>
              {item.sourceLabel && <div className="mt-2 text-[11px] text-zinc-300 truncate">来源：{item.sourceLabel}</div>}
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <KbEditor
          item={selected}
          onClose={() => {
            setSelected(null)
            reload()
          }}
        />
      )}
      {chatOpen && <KbChat onClose={() => setChatOpen(false)} />}
    </div>
  )
}

function KbEditor(props: { item: KbItem; onClose(): void }) {
  const [title, setTitle] = useState(props.item.title)
  const [content, setContent] = useState(props.item.content)
  const [tags, setTags] = useState(props.item.tags.join(' '))

  const save = async () => {
    await api.updateKbItem(props.item.id, {
      title,
      content,
      tags: tags.split(/[\s,，]+/).filter(Boolean)
    })
    props.onClose()
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/30 flex items-center justify-center" onClick={props.onClose}>
      <div
        className="w-[640px] max-h-[80vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-black/5 flex items-center gap-3">
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="flex-1 text-[15px] font-semibold outline-none"
            placeholder="标题"
          />
          <input
            value={tags}
            onChange={e => setTags(e.target.value)}
            className="w-40 text-[12px] outline-none bg-zinc-50 rounded-lg px-2 py-1"
            placeholder="标签（空格分隔）"
          />
        </div>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          className="flex-1 resize-none px-5 py-4 text-[13.5px] leading-relaxed outline-none selectable"
          placeholder="记录想法…"
        />
        <div className="px-5 py-3 border-t border-black/5 flex items-center">
          {props.item.sourceLabel && (
            <span className="text-[12px] text-zinc-400 truncate">来源：{props.item.sourceLabel}</span>
          )}
          <div className="flex-1" />
          <button onClick={props.onClose} className="text-[13px] px-3 py-1.5 rounded-lg text-zinc-500 hover:bg-black/5">
            取消
          </button>
          <button onClick={save} className="ml-2 text-[13px] px-3.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700">
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

function KbChat(props: { onClose(): void }) {
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const requestId = useRef(`kb-${Date.now()}`)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return api.onEvent(ev => {
      const e = ev as { type: string; requestId?: string; delta?: string; done?: boolean; error?: string }
      if (e.type !== 'ai-stream' || e.requestId !== requestId.current) return
      setMessages(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.role === 'assistant') last.text += e.delta ?? ''
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
        }
      }
    })
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 999999 })
  }, [messages])

  const ask = async () => {
    const q = input.trim()
    if (!q || streaming) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text: q }])
    setStreaming(true)
    requestId.current = `kb-${Date.now()}`
    await api.aiAskKnowledgeBase(q, requestId.current)
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/30 flex items-center justify-center" onClick={props.onClose}>
      <div
        className="w-[560px] h-[70vh] bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-black/5 flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-gradient-to-br from-violet-500 to-blue-500 flex items-center justify-center text-white">
            <IconSparkles width={11} height={11} />
          </span>
          <span className="text-[14px] font-semibold text-zinc-800">知识库问答</span>
          <span className="text-[12px] text-zinc-400">基于你收藏的邮件与手记</span>
          <div className="flex-1" />
          <button onClick={props.onClose} className="text-zinc-400 hover:text-zinc-600">
            <IconClose width={14} height={14} />
          </button>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {!messages.length && (
            <div className="text-[13px] text-zinc-300 text-center mt-16">问点什么吧，例如「我收藏过哪些关于投放的文章？」</div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap selectable ${
                  m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-800'
                }`}
              >
                {m.text}
              </div>
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-black/5 flex items-center gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && ask()}
            placeholder="向知识库提问…"
            className="flex-1 bg-zinc-50 rounded-xl px-3.5 py-2.5 text-[13px] outline-none"
          />
          <button
            onClick={ask}
            disabled={streaming}
            className="text-[13px] px-4 py-2.5 rounded-xl bg-blue-600 text-white disabled:opacity-40 hover:bg-blue-700"
          >
            {streaming ? '思考中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}
