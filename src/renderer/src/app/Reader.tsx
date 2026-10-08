import { useEffect, useMemo, useRef, useState } from 'react'
import { api, useMailEvent, fmtFullDate, displayName, fmtSize } from '../lib/api'
import { useMail } from '../stores/mail'
import { sanitizeEmailHtml, activateRemoteImages } from '../lib/sanitize'
import { detectAuth, type AuthExtract } from '../lib/auth-detect'
import {
  READING_STYLES, activeReadingStyleId, setActiveReadingStyleId, findReadingStyle, readingStyleCss
} from '../lib/reading-styles'
import {
  IconReply, IconReplyAll, IconForward, IconArchive, IconTrash, IconFlag,
  IconSparkles, IconAttach, IconSave, IconPlug, IconUnsub, IconTask, IconRefresh, IconClose
} from '../components/icons'
import type { Attachment, ConnectorInstance, ConnectorManifest, GeneralSettings, MessageFull } from '@shared/types'

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
  const [manifests, setManifests] = useState<ConnectorManifest[]>([])
  const [connectorMenu, setConnectorMenu] = useState(false)
  const [styleMenu, setStyleMenu] = useState(false)
  const [styleId, setStyleId] = useState(activeReadingStyleId())
  const [toast, setToast] = useState('')
  const [showRemote, setShowRemote] = useState(false)
  const [remoteCount, setRemoteCount] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef('')
  const styleRootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api.getGeneralSettings().then(setSettings)
    void api.listConnectorInstances().then(setConnectors)
    void api.listConnectorManifests().then(setManifests)
  }, [])

  // 命令面板 / 快捷键唤起风格切换浮层
  useEffect(() => {
    const toggle = () => setStyleMenu(o => !o)
    window.addEventListener('ms:toggle-style-menu', toggle)
    return () => window.removeEventListener('ms:toggle-style-menu', toggle)
  }, [])

  useEffect(() => {
    if (!styleMenu) return
    const onDown = (e: MouseEvent) => {
      if (!styleRootRef.current?.contains(e.target as Node)) setStyleMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [styleMenu])

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

  // 验证码 / 登录链接检测（本地正则，零成本）
  const auth = useMemo<AuthExtract | null>(() => {
    if (!msg) return null
    return detectAuth(msg.subject, msg.text ?? '', msg.html, msg.from?.address)
  }, [msg])
  const [authDismissed, setAuthDismissed] = useState(false)
  useEffect(() => setAuthDismissed(false), [selectedId])

  // 「提炼」状态
  const [extracting, setExtracting] = useState(false)
  // 「Agent 学习」状态
  const [learning, setLearning] = useState(false)

  const runExtract = async () => {
    if (!msg || extracting) return
    setExtracting(true)
    try {
      const res = await api.insightExtract(msg.id)
      showToast(res.ok ? (res.created.length ? `已加入${res.created.join('、')}` : '这封邮件没有可提炼的待办/文章') : res.error ?? '提炼失败')
    } finally {
      setExtracting(false)
    }
  }

  const runAgentLearn = async () => {
    if (!msg || learning) return
    setLearning(true)
    try {
      const res = await api.agentLearn(msg.id)
      showToast(res.ok ? (res.learned.length ? `Agent 记住了 ${res.learned.length} 条` : '没有值得沉淀的长期信息') : res.error ?? '学习失败')
    } finally {
      setLearning(false)
    }
  }

  const copyCode = () => {
    if (auth?.code) {
      void navigator.clipboard.writeText(auth.code)
      showToast(`验证码 ${auth.code} 已复制`)
    }
  }

  const skin = useMemo(() => findReadingStyle(styleId), [styleId])

  // 渲染正文（Shadow DOM 隔离样式 + 可选阅读皮肤）
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
    // 复用已有 shadow root（切风格 / 设置异步到达时 div 仍在挂载，重复 attachShadow 会抛异常）
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    // 默认样式跟随应用主题（CSS 变量穿透 shadow 边界），阅读皮肤激活时由皮肤样式覆盖
    shadow.innerHTML = `<style>
      :host { all: initial; display:block; font-size:14px; line-height:1.75; color: var(--fg, #27272a); word-break: break-word; }
      * { max-width: 100% !important; }
      img { height:auto; }
      a { color: var(--accent, #2563eb); }
      table { border-collapse: collapse; }
      p { margin: 0.5em 0; }
    </style><div id="ms-body">${html}</div>`
    // 阅读皮肤：编译元组注入 Shadow DOM（只影响邮件内容，不动应用外壳）
    if (skin) {
      const styleEl = document.createElement('style')
      styleEl.setAttribute('data-reading-style', skin[0])
      styleEl.textContent = readingStyleCss(skin)
      shadow.appendChild(styleEl)
    }
    const root = shadow.getElementById('ms-body')!
    // 链接走系统浏览器
    root.addEventListener('click', e => {
      const target = (e.target as HTMLElement).closest('a')
      if (target) {
        e.preventDefault()
        void api.openExternal(target.href)
      }
    })
  }, [msg, settings, showRemote, cidMap, skin])

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

  const applyStyle = (id: string) => {
    const next = styleId === id ? '' : id
    setActiveReadingStyleId(next)
    setStyleId(next)
    setStyleMenu(false)
    showToast(next ? `阅读风格：${findReadingStyle(next)?.[1]}` : '已恢复默认风格')
  }

  const showToast = (t: string) => {
    setToast(t)
    setTimeout(() => setToast(''), 2500)
  }

  if (!selectedId) {
    return (
      <div className="flex-1 h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-[15px] font-medium" style={{ color: 'var(--faint)' }}>选择一封邮件开始阅读</div>
          <div className="mt-1.5 text-[12.5px]" style={{ color: 'var(--faint)', opacity: 0.75 }}>
            ⌘K 命令面板 · J/K 切换 · R 回复 · ⌘T 明暗
          </div>
        </div>
      </div>
    )
  }

  // 点击后预览骨架屏：正文按需拉取时的加载反馈
  if (!msg) {
    return (
      <div className="flex-1 h-full flex flex-col relative overflow-hidden">
        <div className="drag-region h-[52px] shrink-0" />
        <div className="shrink-0 px-6 pb-4 space-y-3">
          <div className="h-[24px] w-[60%] rounded-lg shimmer" />
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full shimmer" />
            <div className="space-y-1.5 flex-1">
              <div className="h-[12px] w-[30%] rounded shimmer" />
              <div className="h-[10px] w-[45%] rounded shimmer" />
            </div>
          </div>
        </div>
        <div className="shrink-0 px-6 pt-2">
          <div className="h-[52px] rounded-[var(--r-md)] shimmer" />
        </div>
        <div className="flex-1 px-6 pt-4">
          <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] px-6 py-5 space-y-2.5" style={{ background: 'var(--surface-strong)' }}>
            {[92, 100, 78, 96, 64, 88, 40].map((w, i) => (
              <div key={i} className="h-[11px] rounded shimmer" style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
      </div>
    )
  }

  const atts = msg.attachments.filter(a => !a.inline)
  const canUnsub = !!msg.listUnsubscribe

  return (
    <div className="flex-1 h-full flex flex-col relative">
      {/* 顶部工具栏 */}
      <div className="drag-region h-[52px] shrink-0" />
      <div className="shrink-0 px-6 pb-3 flex items-center gap-1.5">
        <ToolButton onClick={() => reply(false)} icon={<IconReply width={14} height={14} />} label="回复" />
        <ToolButton onClick={() => reply(true)} icon={<IconReplyAll width={14} height={14} />} label="全部回复" />
        <ToolButton onClick={forward} icon={<IconForward width={14} height={14} />} label="转发" />
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        <ToolButton
          onClick={() => void useMail.getState().setPinned([msg.id], !msg.pinned)}
          icon={<span className="text-[12px] leading-none">📌</span>}
          label={msg.pinned ? '取消置顶' : '置顶'}
          active={msg.pinned}
        />
        <ToolButton onClick={() => act('flag')} icon={<IconFlag width={14} height={14} />} label={msg.flagged ? '取消旗标' : '旗标'} active={msg.flagged} />
        <ToolButton onClick={() => act('archive')} icon={<IconArchive width={14} height={14} />} label="归档" />
        <ToolButton onClick={() => act('trash')} icon={<IconTrash width={14} height={14} />} label="删除" danger />
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        <ToolButton onClick={saveToKb} icon={<IconSave width={14} height={14} />} label="存知识库" />
        {connectors.length > 0 && (
          <div className="relative">
            <ToolButton onClick={() => setConnectorMenu(m => !m)} icon={<IconPlug width={14} height={14} />} label="分享" />
            {connectorMenu && (
              <div className="absolute top-8 left-0 z-20 w-52 glass-strong rounded-[var(--r-sm)] shadow-[var(--shadow)] border border-[var(--glass-border)] py-1 fade-in">
                {connectors.map(c => (
                  <button
                    key={c.id}
                    onClick={() => shareConnector(c.id, 'forward')}
                    className="w-full text-left px-3 py-2 text-[13px] hover:bg-[var(--hover)]"
                    style={{ color: 'var(--fg)' }}
                  >
                    分享到 {manifests.find(m => m.id === c.manifestId)?.name ?? c.manifestId}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex-1" />
        {/* 阅读风格快速切换（ThirdC 交互：上下文锚定的风格选择器） */}
        <div ref={styleRootRef} className="relative">
          <ToolButton
            onClick={() => setStyleMenu(m => !m)}
            icon={<span className="text-[13px] leading-none">🎨</span>}
            label={skin ? skin[1] : '风格'}
            active={!!skin}
          />
          {styleMenu && (
            <div className="absolute top-8 right-0 z-20 w-[248px] max-h-[420px] overflow-y-auto glass-strong rounded-[var(--r-md)] shadow-[var(--shadow)] border border-[var(--glass-border)] p-1.5 pop-in">
              <div className="px-2 pt-1 pb-1.5 text-[10.5px] font-semibold tracking-[.08em] uppercase" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                阅读风格 · {READING_STYLES.length} 款
              </div>
              <StyleOption label="默认（跟随应用主题）" active={!styleId} onClick={() => applyStyle('')} />
              {READING_STYLES.map(s => (
                <StyleOption key={s[0]} label={s[1]} color={s[4]} bg={s[2]} active={styleId === s[0]} onClick={() => applyStyle(s[0])} />
              ))}
            </div>
          )}
        </div>
        {msg.unread && (
          <ToolButton onClick={() => act('unread')} icon={<IconRefresh width={14} height={14} />} label="标为未读" />
        )}
      </div>

      {/* 头部信息 */}
      <div className="shrink-0 px-6 pb-4 border-b border-[var(--border-soft)]">
        <h1 className="selectable text-[19px] font-semibold leading-snug" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>{msg.subject || '（无主题）'}</h1>
        <div className="mt-2.5 flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[14px] font-medium shrink-0"
            style={{ background: `hsl(${(displayName(msg.from).charCodeAt(0) * 7) % 360} 55% 55%)` }}
          >
            {[...displayName(msg.from)][0]?.toUpperCase() ?? '?'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-[13.5px] font-medium selectable truncate" style={{ color: 'var(--fg)' }}>{displayName(msg.from)}</span>
              <span className="text-[12px] truncate" style={{ color: 'var(--faint)' }}>{msg.from?.address}</span>
              <span className="ml-auto text-[12px] shrink-0" style={{ color: 'var(--faint)' }}>{fmtFullDate(msg.date)}</span>
            </div>
            <div className="text-[12px] selectable truncate" style={{ color: 'var(--faint)' }}>
              收件人：{msg.to.map(displayName).join('，') || '—'}
              {msg.cc.length > 0 && `；抄送：${msg.cc.map(displayName).join('，')}`}
            </div>
          </div>
        </div>
        {canUnsub && (
          <button
            onClick={unsubscribe}
            className="mt-2.5 inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-full"
            style={{ background: 'var(--bg-soft)', color: 'var(--muted)' }}
          >
            <IconUnsub width={12} height={12} /> 这是订阅邮件 · 一键退订
          </button>
        )}
      </div>

      {/* 验证码 / 登录链接直达气泡 */}
      {auth && !authDismissed && (
        <div className="shrink-0 px-6 pt-3">
          <div
            className="flex items-center gap-3 rounded-[var(--r-md)] px-4 py-3 border shadow-[var(--shadow-sm)] pop-in"
            style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)' }}
          >
            <span className="text-[20px] leading-none">{auth.kind === 'code' ? '🔑' : '🔐'}</span>
            {auth.kind === 'code' ? (
              <>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px]" style={{ color: 'var(--muted)' }}>检测到验证码，点击即复制</div>
                  <button
                    onClick={copyCode}
                    className="text-[22px] font-bold tracking-[.18em] font-[var(--font-mono)] hover:opacity-80"
                    style={{ color: 'var(--accent-strong)' }}
                  >
                    {auth.code}
                  </button>
                </div>
                <button
                  onClick={copyCode}
                  className="no-drag text-[12.5px] font-medium px-3.5 py-1.5 rounded-lg shrink-0"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                >
                  复制验证码
                </button>
              </>
            ) : (
              <>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px]" style={{ color: 'var(--muted)' }}>检测到登录 / 验证链接{auth.provider ? ` · ${auth.provider}` : ''}</div>
                  <div className="text-[13px] font-medium truncate" style={{ color: 'var(--accent-strong)' }}>一键直达，无需翻找正文</div>
                </div>
                <button
                  onClick={() => auth.url && void api.openExternal(auth.url)}
                  className="no-drag text-[12.5px] font-medium px-3.5 py-1.5 rounded-lg shrink-0"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                >
                  一键登录 →
                </button>
              </>
            )}
            <button onClick={() => setAuthDismissed(true)} className="shrink-0 p-1 rounded-lg hover:bg-[var(--hover)]" style={{ color: 'var(--faint)' }} title="关闭">
              <IconClose width={13} height={13} />
            </button>
          </div>
        </div>
      )}

      {/* AI 面板 */}
      <div className="shrink-0 px-6 pt-3">
        <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] overflow-hidden glass shadow-[var(--shadow-sm)]">
          <div className="flex items-center gap-2 px-4 py-2.5">
            <span className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: 'linear-gradient(135deg, var(--accent), oklch(58% .16 285))', color: 'var(--on-accent)' }}>
              <IconSparkles width={11} height={11} />
            </span>
            <span className="text-[13px] font-medium" style={{ color: 'var(--fg)' }}>AI 助手</span>
            <div className="flex-1" />
            <AIChip label="摘要" onClick={() => runAI('summary')} active={aiMode === 'summary'} />
            <AIChip label="起草回复" onClick={() => runAI('draft')} active={aiMode === 'draft'} />
            <AIChip label="提取待办" onClick={() => runAI('tasks')} active={aiMode === 'tasks'} />
            <AIChip label={extracting ? '提炼中…' : '提炼'} onClick={runExtract} active={false} />
            <AIChip label={learning ? '学习中…' : '学习'} onClick={runAgentLearn} active={false} />
          </div>
          {(ai.text || ai.streaming || ai.error) && (
            <div className="px-4 pb-3.5">
              <div className="pt-2 border-t border-[var(--border-soft)]">
                <div className="selectable mt-2 text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--muted)' }}>
                  {ai.error ? <span style={{ color: 'var(--danger)' }}>{ai.error}</span> : ai.text}
                  {ai.streaming && <span className="inline-block w-1.5 h-4 ml-0.5 animate-pulse align-middle" style={{ background: 'var(--accent)' }} />}
                </div>
                {aiMode === 'draft' && !ai.streaming && ai.text && (
                  <div className="mt-2.5 flex gap-2">
                    <button
                      onClick={useAiDraft}
                      className="text-[12.5px] px-3 py-1.5 rounded-lg font-medium"
                      style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                    >
                      用这封回复
                    </button>
                    <button
                      onClick={() => navigator.clipboard.writeText(ai.text)}
                      className="text-[12.5px] px-3 py-1.5 rounded-lg"
                      style={{ background: 'var(--bg-soft)', color: 'var(--muted)' }}
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
          <div className="mb-3 flex items-center gap-2 text-[12.5px] rounded-[var(--r-sm)] px-3.5 py-2.5" style={{ background: 'var(--warn-soft)', color: 'var(--muted)' }}>
            <span>为保护隐私，已拦截 {remoteCount} 张远程图片（可能包含追踪像素）</span>
            <button onClick={showBlocked} className="ml-auto hover:underline shrink-0" style={{ color: 'var(--accent)' }}>
              本次显示
            </button>
          </div>
        )}
        <div
          className="overflow-hidden"
          style={
            skin
              ? { borderRadius: 'var(--r-md)' }
              : {
                  borderRadius: 'var(--r-md)',
                  background: 'var(--surface-strong)',
                  border: '1px solid var(--border-soft)',
                  boxShadow: 'var(--shadow-sm)',
                  backdropFilter: 'blur(10px)',
                  padding: '20px 24px'
                }
          }
        >
          <div
            ref={bodyRef}
            className="mail-body-host selectable"
            style={skin ? { borderRadius: 'var(--r-md)', padding: '20px 24px' } : undefined}
          />
        </div>
      </div>

      {toast && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full glass-strong border border-[var(--glass-border)] text-[13px] shadow-[var(--shadow-sm)] fade-in" style={{ color: 'var(--fg)' }}>
          {toast}
        </div>
      )}
    </div>
  )
}

function StyleOption(props: { label: string; active: boolean; onClick(): void; color?: string; bg?: string }) {
  return (
    <button
      onClick={props.onClick}
      className="w-full flex items-center gap-2 px-2.5 py-[7px] rounded-[10px] text-[12.5px] text-left border"
      style={{
        borderColor: props.active ? 'var(--accent)' : 'transparent',
        background: props.active ? 'var(--accent-soft)' : 'transparent',
        color: 'var(--fg)'
      }}
      onMouseEnter={e => {
        if (!props.active) e.currentTarget.style.background = 'var(--hover)'
      }}
      onMouseLeave={e => {
        if (!props.active) e.currentTarget.style.background = 'transparent'
      }}
    >
      {props.color && (
        <span className="flex gap-1 shrink-0">
          <i className="w-3 h-3 rounded-[4px] border border-black/10" style={{ background: props.bg }} />
          <i className="w-3 h-3 rounded-[4px] border border-black/10" style={{ background: props.color }} />
        </span>
      )}
      <span className="flex-1 truncate">{props.label}</span>
      {props.active && <span className="text-[10px]" style={{ color: 'var(--accent)' }}>✓</span>}
    </button>
  )
}

function AIChip(props: { label: string; onClick(): void; active?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      className="text-[12px] px-2.5 py-1 rounded-full transition"
      style={props.active
        ? { background: 'var(--accent)', color: 'var(--on-accent)' }
        : { background: 'var(--bg-soft)', color: 'var(--muted)' }}
    >
      {props.label}
    </button>
  )
}

function ToolButton(props: { icon: React.ReactNode; label: string; onClick(): void; active?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      className="flex items-center gap-1.5 text-[12.5px] px-2 py-1.5 rounded-lg transition-colors hover:bg-[var(--hover)] whitespace-nowrap shrink-0"
      style={{
        color: props.active ? 'var(--warn)' : props.danger ? 'var(--muted)' : 'var(--muted)',
        background: props.active ? 'var(--warn-soft)' : undefined
      }}
      onMouseEnter={e => {
        if (props.danger) e.currentTarget.style.color = 'var(--danger)'
      }}
      onMouseLeave={e => {
        if (props.danger) e.currentTarget.style.color = 'var(--muted)'
      }}
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
      className="flex items-center gap-2.5 px-3 py-2 rounded-[var(--r-sm)] border transition-colors group"
      style={{ background: 'var(--surface-strong)', borderColor: 'var(--border-soft)' }}
      title="点击保存"
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = 'var(--accent)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--border-soft)'
      }}
    >
      <span className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-soft)', color: 'var(--faint)' }}>
        <IconAttach width={14} height={14} />
      </span>
      <span className="text-left">
        <span className="block max-w-[180px] truncate text-[12.5px]" style={{ color: 'var(--fg)' }}>{a.filename}</span>
        <span className="block text-[11px]" style={{ color: 'var(--faint)' }}>{fmtSize(a.size)}</span>
      </span>
    </button>
  )
}

function escapeHtmlMinor(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
