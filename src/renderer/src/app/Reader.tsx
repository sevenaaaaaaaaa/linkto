import { useEffect, useMemo, useRef, useState } from 'react'
import { api, useMailEvent, fmtFullDate, displayName, fmtSize } from '../lib/api'
import { useMail } from '../stores/mail'
import { sanitizeEmailHtml, activateRemoteImages } from '../lib/sanitize'
import {
  IconReply, IconReplyAll, IconForward, IconArchive, IconTrash, IconFlag,
  IconSparkles, IconAttach, IconSave, IconPlug, IconUnsub, IconChevronDown, IconTask, IconRefresh
} from '../components/icons'
import type { Attachment, ConnectorInstance, GeneralSettings, MessageFull } from '@shared/types'

interface AIState {
  text: string
  streaming: boolean
  error?: string
}

export function Reader() {
  const { selectedId, loadMessages } = useMail()
  const [msg, setMsg] = useState<MessageFull | null>(null)
  const [settings, setSettings] = useState<GeneralSettings | null>(null)
  const [ai, setAi] = useState<AIState>({ text: '', streaming: false })
  const [aiMode, setAiMode] = useState<'summary' | 'draft' | 'tasks' | null>(null)
  const [connectors, setConnectors] = useState<ConnectorInstance[]>([])
  const [connectorMenu, setConnectorMenu] = useState(false)
  const [toast, setToast] = useState('')
  const [showRemote, setShowRemote] = useState(false)
  const [remoteCount, setRemoteCount] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef('')

  useEffect(() => {
    void api.getGeneralSettings().then(setSettings)
    void api.listConnectorInstances().then(setConnectors)
  }, [])

  // 加载当前邮件
  useEffect(() => {
    if (!selectedId) {
      setMsg(null)
      return
    }
    let alive = true
    setMsg(null)
    setAi({ text: '', streaming: false })
    setAiMode(null)
    setShowRemote(false)
    void api.getMessage(selectedId).then(m => {
      if (!alive) return
      setMsg(m)
      if (m && m.unread) void api.markRead([m.id], true).then(() => loadMessages())
    })
    return () => {
      alive = false
    }
  }, [selectedId, loadMessages])

  const cidMap = useMemo(() => {
    const map: Record<string, string> = {}
    if (msg) {
      for (const a of msg.attachments) {
        if (a.inline && a.contentId) map[a.contentId.toLowerCase()] = a.id
      }
    }
    return map
  }, [msg])

  // 渲染正文（Shadow DOM 隔离样式）
  useEffect(() => {
    const host = bodyRef.current
    if (!host) return
    host.innerHTML = ''
    if (!msg) return
    const allowRemote = (settings?.remoteImages ?? 'block') === 'allow' || showRemote
    const source = msg.html ?? (msg.text ? `<p style="white-space:pre-wrap">${escapeHtmlMinor(msg.text)}</p>` : '<p style="color:#999">（此邮件没有正文内容）</p>')
    const { html, remoteImages } = sanitizeEmailHtml(source, {
      allowRemote,
      resolveCid: cid => cidMap[cid.toLowerCase()] ?? cidMap[`<${cid.toLowerCase()}>`] ?? null
    })
    setRemoteCount(allowRemote ? 0 : remoteImages)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<style>
      :host { all: initial; display:block; font-size:14px; line-height:1.65; color:#27272a; word-break: break-word; }
      * { max-width: 100% !important; }
      img { height:auto; }
      a { color:#2563eb; }
      table { border-collapse: collapse; }
      p { margin: 0.5em 0; }
    </style><div id="ms-body">${html}</div>`
    const root = shadow.getElementById('ms-body')!
    // 链接走系统浏览器
    root.addEventListener('click', e => {
      const target = (e.target as HTMLElement).closest('a')
      if (target) {
        e.preventDefault()
        void api.openExternal(target.href)
      }
    })
  }, [msg, settings, showRemote, cidMap])

  const showBlocked = () => setShowRemote(true)

  // ---------- AI ----------

  const runAI = async (mode: 'summary' | 'draft' | 'tasks') => {
    if (!msg) return
    const requestId = `ai-${Date.now()}`
    requestRef.current = requestId
    setAiMode(mode)
    setAi({ text: '', streaming: true })
    if (mode === 'summary') void api.aiSummarize(msg.id, requestId)
    if (mode === 'tasks') void api.aiExtractTasks(msg.id, requestId)
    if (mode === 'draft') {
      const tone = '友好而专业'
      await api.aiDraftReply(msg.id, tone, requestId)
    }
  }

  useMailEvent(ev => {
    if (ev.type === 'ai-stream') {
      if (ev.requestId !== requestRef.current) return
      setAi(prev => ({
        text: prev.text + ev.delta,
        streaming: !ev.done,
        error: ev.error
      }))
    }
  })

  const useAiDraft = () => {
    if (!msg) return
    const to = msg.replyTo ? [{ name: msg.replyTo.name, address: msg.replyTo.address }] : msg.from ? [msg.from] : []
    void api.openCompose({
      accountId: msg.accountId,
      to,
      subject: /^回复[:：]/i.test(msg.subject) ? msg.subject : `回复：${msg.subject}`,
      inReplyToMessageId: msg.messageId ?? undefined,
      relatedMessageId: msg.id,
      html: ai.text
    } as never)
  }

  // ---------- 操作 ----------

  const act = async (action: 'archive' | 'trash' | 'flag' | 'unread') => {
    if (!msg) return
    if (action === 'archive') await api.moveMessages([msg.id], 'archive')
    if (action === 'trash') await api.deleteMessages([msg.id])
    if (action === 'flag') await api.markFlagged([msg.id], !msg.flagged)
    if (action === 'unread') await api.markRead([msg.id], false)
    useMail.getState().select(null)
    await loadMessages()
  }

  const reply = (all: boolean) => {
    if (!msg) return
    const to = msg.replyTo ? [msg.replyTo] : msg.from ? [msg.from] : []
    const cc = all ? msg.cc.filter(a => a.address !== to[0]?.address) : []
    void api.openCompose({
      accountId: msg.accountId,
      to,
      cc,
      subject: /^回复[:：]/i.test(msg.subject) ? msg.subject : `回复：${msg.subject}`,
      inReplyToMessageId: msg.messageId ?? undefined,
      relatedMessageId: msg.id,
      quoteMessageId: msg.id
    } as never)
  }

  const forward = () => {
    if (!msg) return
    void api.openCompose({
      accountId: msg.accountId,
      subject: /^转发[:：]/i.test(msg.subject) ? msg.subject : `转发：${msg.subject}`,
      relatedMessageId: msg.id,
      quoteMessageId: msg.id,
      forwardOf: msg.id
    } as never)
  }

  const saveToKb = async () => {
    if (!msg) return
    await api.saveToKb({
      messageId: msg.id,
      kind: 'message',
      title: msg.subject || displayName(msg.from),
      content: msg.text?.slice(0, 8000) || msg.snippet,
      tags: []
    })
    void api.aiTagKbItem(msg.id)
    showToast('已保存到知识库')
    await loadMessages()
  }

  const shareConnector = async (instanceId: string, actionId: string) => {
    if (!msg) return
    setConnectorMenu(false)
    const res = await api.runConnectorAction(instanceId, actionId, {}, msg.id)
    showToast(res.ok ? '已通过连接器发送' : `连接器失败：${res.error}`)
  }

  const unsubscribe = async () => {
    if (!msg) return
    const hasHttp = /<https?:/i.test(msg.listUnsubscribe ?? '')
    const res = await api.unsubscribe(msg.id, hasHttp ? 'http' : 'mailto')
    showToast(res.ok ? '已打开退订流程' : res.error ?? '退订失败')
  }

  const showToast = (t: string) => {
    setToast(t)
    setTimeout(() => setToast(''), 2500)
  }

  if (!selectedId || !msg) {
    return (
      <div className="flex-1 h-full flex items-center justify-center bg-[#fafafa]">
        <div className="text-center">
          <div className="text-[15px] text-zinc-300 font-medium">选择一封邮件开始阅读</div>
          <div className="mt-1.5 text-[12.5px] text-zinc-300/80">支持 ⌘K 快速搜索 · J/K 切换 · R 回复</div>
        </div>
      </div>
    )
  }

  const atts = msg.attachments.filter(a => !a.inline)
  const canUnsub = !!msg.listUnsubscribe

  return (
    <div className="flex-1 h-full flex flex-col bg-[#fafafa] relative">
      {/* 顶部工具栏 */}
      <div className="drag-region h-[52px] shrink-0" />
      <div className="shrink-0 px-6 pb-3 flex items-center gap-1.5">
        <ToolButton onClick={() => reply(false)} icon={<IconReply width={14} height={14} />} label="回复" />
        <ToolButton onClick={() => reply(true)} icon={<IconReplyAll width={14} height={14} />} label="全部回复" />
        <ToolButton onClick={forward} icon={<IconForward width={14} height={14} />} label="转发" />
        <div className="w-px h-4 bg-black/10 mx-1" />
        <ToolButton onClick={() => act('flag')} icon={<IconFlag width={14} height={14} />} label={msg.flagged ? '取消旗标' : '旗标'} active={msg.flagged} />
        <ToolButton onClick={() => act('archive')} icon={<IconArchive width={14} height={14} />} label="归档" />
        <ToolButton onClick={() => act('trash')} icon={<IconTrash width={14} height={14} />} label="删除" danger />
        <div className="w-px h-4 bg-black/10 mx-1" />
        <ToolButton onClick={saveToKb} icon={<IconSave width={14} height={14} />} label="存知识库" />
        {connectors.length > 0 && (
          <div className="relative">
            <ToolButton onClick={() => setConnectorMenu(m => !m)} icon={<IconPlug width={14} height={14} />} label="分享" />
            {connectorMenu && (
              <div className="absolute top-8 left-0 z-20 w-52 bg-white rounded-xl shadow-xl border border-black/10 py-1 fade-in">
                {connectors.map(c => (
                  <button
                    key={c.id}
                    onClick={() => shareConnector(c.id, 'forward')}
                    className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5"
                  >
                    分享到 {manifestName(c.manifestId)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex-1" />
        {msg.unread && (
          <ToolButton onClick={() => act('unread')} icon={<IconRefresh width={14} height={14} />} label="标为未读" />
        )}
      </div>

      {/* 头部信息 */}
      <div className="shrink-0 px-6 pb-4 border-b border-black/5">
        <h1 className="selectable text-[19px] font-semibold text-zinc-900 leading-snug">{msg.subject || '（无主题）'}</h1>
        <div className="mt-2.5 flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[14px] font-medium shrink-0"
            style={{ background: `hsl(${(displayName(msg.from).charCodeAt(0) * 7) % 360} 55% 55%)` }}
          >
            {[...displayName(msg.from)][0]?.toUpperCase() ?? '?'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[13.5px] font-medium text-zinc-800 selectable truncate">{displayName(msg.from)}</span>
              <span className="text-[12px] text-zinc-400 selectable truncate">{msg.from?.address}</span>
              <span className="ml-auto text-[12px] text-zinc-400 shrink-0">{fmtFullDate(msg.date)}</span>
            </div>
            <div className="text-[12px] text-zinc-400 selectable truncate">
              收件人：{msg.to.map(displayName).join('，') || '—'}
              {msg.cc.length > 0 && `；抄送：${msg.cc.map(displayName).join('，')}`}
            </div>
          </div>
        </div>
        {canUnsub && (
          <button
            onClick={unsubscribe}
            className="mt-2.5 inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
          >
            <IconUnsub width={12} height={12} /> 这是订阅邮件 · 一键退订
          </button>
        )}
      </div>

      {/* AI 面板 */}
      <div className="shrink-0 px-6 pt-3">
        <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5">
            <span className="w-5 h-5 rounded-full bg-gradient-to-br from-violet-500 to-blue-500 flex items-center justify-center text-white">
              <IconSparkles width={11} height={11} />
            </span>
            <span className="text-[13px] font-medium text-zinc-700">AI 助手</span>
            <div className="flex-1" />
            <AIChip label="摘要" onClick={() => runAI('summary')} active={aiMode === 'summary'} />
            <AIChip label="起草回复" onClick={() => runAI('draft')} active={aiMode === 'draft'} />
            <AIChip label="提取待办" onClick={() => runAI('tasks')} active={aiMode === 'tasks'} />
          </div>
          {(ai.text || ai.streaming || ai.error) && (
            <div className="px-4 pb-3.5">
              <div className="pt-2 border-t border-black/[0.05]">
                <div className="selectable mt-2 text-[13px] leading-relaxed text-zinc-700 whitespace-pre-wrap">
                  {ai.error ? <span className="text-red-500">{ai.error}</span> : ai.text}
                  {ai.streaming && <span className="inline-block w-1.5 h-4 ml-0.5 bg-blue-500 animate-pulse align-middle" />}
                </div>
                {aiMode === 'draft' && !ai.streaming && ai.text && (
                  <div className="mt-2.5 flex gap-2">
                    <button
                      onClick={useAiDraft}
                      className="text-[12.5px] px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                    >
                      用这封回复
                    </button>
                    <button
                      onClick={() => navigator.clipboard.writeText(ai.text)}
                      className="text-[12.5px] px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                    >
                      复制
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 附件 */}
      {atts.length > 0 && (
        <div className="shrink-0 px-6 pt-3 flex flex-wrap gap-2">
          {atts.map(a => (
            <AttachmentCard key={a.id} att={a} />
          ))}
        </div>
      )}

      {/* 正文 */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {remoteCount > 0 && (
          <div className="mb-3 flex items-center gap-2 text-[12.5px] text-zinc-500 bg-amber-50 border border-amber-200/60 rounded-xl px-3.5 py-2.5">
            <span>为保护隐私，已拦截 {remoteCount} 张远程图片（可能包含追踪像素）</span>
            <button onClick={showBlocked} className="ml-auto text-blue-600 hover:underline shrink-0">
              本次显示
            </button>
          </div>
        )}
        <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm px-6 py-5">
          <div ref={bodyRef} className="mail-body-host selectable" />
        </div>
      </div>

      {toast && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-zinc-900/90 text-white text-[13px] shadow-lg fade-in">
          {toast}
        </div>
      )}
    </div>
  )
}

function manifestName(manifestId: string): string {
  const names: Record<string, string> = { 'generic-webhook': '通用 Webhook', clipboard: '系统剪贴板' }
  return names[manifestId] ?? manifestId
}

function AIChip(props: { label: string; onClick(): void; active?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      className={`text-[12px] px-2.5 py-1 rounded-full transition ${
        props.active ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
      }`}
    >
      {props.label}
    </button>
  )
}

function ToolButton(props: { icon: React.ReactNode; label: string; onClick(): void; active?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      className={`flex items-center gap-1.5 text-[12.5px] px-2.5 py-1.5 rounded-lg transition ${
        props.active
          ? 'bg-orange-100 text-orange-600'
          : props.danger
            ? 'text-zinc-500 hover:bg-red-50 hover:text-red-500'
            : 'text-zinc-600 hover:bg-black/5'
      }`}
    >
      {props.icon}
      {props.label}
    </button>
  )
}

function AttachmentCard(props: { att: Attachment }) {
  const a = props.att
  return (
    <button
      onClick={() => void api.saveAttachment(a.id)}
      className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-white border border-black/[0.06] shadow-sm hover:border-blue-300 transition group"
      title="点击保存"
    >
      <span className="w-8 h-8 rounded-lg bg-zinc-100 group-hover:bg-blue-50 flex items-center justify-center text-zinc-400 group-hover:text-blue-500">
        <IconAttach width={14} height={14} />
      </span>
      <span className="text-left">
        <span className="block max-w-[180px] truncate text-[12.5px] text-zinc-700">{a.filename}</span>
        <span className="block text-[11px] text-zinc-400">{fmtSize(a.size)}</span>
      </span>
    </button>
  )
}

function escapeHtmlMinor(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
