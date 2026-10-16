import { avatarStyle } from '../lib/avatar'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, useMailEvent, fmtFullDate, displayName, fmtSize } from '../lib/api'
import { useMail } from '../stores/mail'
import { sanitizeEmailHtml, activateRemoteImages } from '../lib/sanitize'
import { detectAuth, type AuthExtract } from '../lib/auth-detect'
import { SnoozeMenu, fmtSnooze } from './SnoozeMenu'
import {
  READING_STYLES, activeReadingStyleId, setActiveReadingStyleId, findReadingStyle, readingStyleCss
} from '../lib/reading-styles'
import {
  IconReply, IconReplyAll, IconForward, IconArchive, IconTrash, IconFlag,
  IconSparkles, IconAttach, IconSave, IconPlug, IconUnsub, IconTask, IconRefresh, IconClose,
  IconPin, IconPalette, IconKey, IconLock, IconCloud, IconClock, IconMore, IconMailDot
} from '../components/icons'
import { MenuButton, type MenuItem } from '../components/Menu'
import type { Attachment, CloudDriveConfig, ConnectorInstance, ConnectorManifest, GeneralSettings, MessageFull } from '@shared/types'

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
  const [drives, setDrives] = useState<CloudDriveConfig[]>([])
  const [driveMenu, setDriveMenu] = useState(false)
  const [connectorMenu, setConnectorMenu] = useState(false)
  const [styleMenu, setStyleMenu] = useState(false)
  const [styleId, setStyleId] = useState(activeReadingStyleId())
  const [toast, setToast] = useState('')
  const [showRemote, setShowRemote] = useState(false)
  const [remoteCount, setRemoteCount] = useState(0)
  const [bodyError, setBodyError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef('')
  const styleRootRef = useRef<HTMLDivElement>(null)
  // 工具栏宽度自适应：不足 600px 时次要按钮只留图标（审计 IA-6 窄屏溢出）
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  // AI 未配置时不展示一排点了才报错的按钮，改为一个「去配置」入口；设置窗改完回到主窗时重新检查
  const [aiReady, setAiReady] = useState<{ ready: boolean; reason?: string } | null>(null)
  useEffect(() => {
    const check = () => void api.aiStatus().then(setAiReady).catch(() => {})
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])
  useEffect(() => {
    const el = toolbarRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => setCompact((entries[0]?.contentRect.width ?? 999) < 600))
    ro.observe(el)
    return () => ro.disconnect()
  })
  // 多选模式（勾选 ≥2 封或勾选非当前打开邮件）：阅读区显示汇总而非上一封邮件（审计 IA-7）
  const multiIds = useMail(st => (st.selectedIds.size > 1 || (st.selectedIds.size === 1 && !st.selectedIds.has(st.selectedId ?? '')) ? st.selectedIds : null))

  // 正文按需下载失败时主进程会广播错误，匹配当前邮件则显示重试提示
  useEffect(() => {
    if (!msg?.id) return
    const off = api.onEvent((raw: unknown) => {
      const ev = raw as { type?: string; messageId?: string; error?: string }
      if (ev.type === 'body-download-error' && ev.messageId === msg.id) setBodyError(ev.error ?? '未知错误')
    })
    return () => { off?.() }
  }, [msg?.id])

  const retryBody = async () => {
    if (!msg || retrying) return
    setRetrying(true)
    setBodyError(null)
    try {
      const full = await api.getMessage(msg.id)
      if (full) setMsg(full)
      if (!full?.text && !full?.html) setBodyError('仍无正文，请稍后重试')
    } catch (err) {
      setBodyError(err instanceof Error ? err.message : String(err))
    } finally {
      setRetrying(false)
    }
  }

  useEffect(() => {
    void api.getGeneralSettings().then(setSettings)
    void api.listConnectorInstances().then(setConnectors)
    void api.listConnectorManifests().then(setManifests)
    void api.listCloudDrives().then(setDrives)
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
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const snoozeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!snoozeOpen) return
    const onDown = (e: MouseEvent) => {
      if (!snoozeRef.current?.contains(e.target as Node)) setSnoozeOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [snoozeOpen])
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
    const source = msg.html ?? (msg.text ? `<p style="white-space:pre-wrap">${escapeHtmlMinor(msg.text)}</p>` : '<p style="color:var(--faint)">（此邮件没有正文内容）</p>')
    const { html, remoteImages } = sanitizeEmailHtml(source, {
      allowRemote,
      resolveCid: cid => cidMap[cid.toLowerCase()] ?? cidMap[`<${cid.toLowerCase()}>`] ?? null
    })
    setRemoteCount(allowRemote ? 0 : remoteImages)
    // 复用已有 shadow root（切风格 / 设置异步到达时 div 仍在挂载，重复 attachShadow 会抛异常）
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    // 默认样式跟随应用主题（CSS 变量穿透 shadow 边界），阅读皮肤激活时由皮肤样式覆盖
    shadow.innerHTML = `<style>
      :host { all: initial; display:block; font-family: var(--font-body); font-size:14px; line-height:22px; color: var(--fg); word-break: break-word; -webkit-font-smoothing: antialiased; }
      * { max-width: 100% !important; }
      img { height:auto; }
      a { color: var(--accent-ink); }
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
    if (action !== 'flag') useMail.getState().select(null)
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

  /** 上传到网盘：eml 原文或全部附件 */
  const uploadToDrive = async (driveId: string, driveName: string, what: 'eml' | 'attachments') => {
    if (!msg) return
    setDriveMenu(false)
    showToast(what === 'eml' ? `正在上传 eml 原文到 ${driveName}…` : `正在上传附件到 ${driveName}…`)
    const res = await api.cloudUpload(msg.id, driveId, what)
    showToast(
      res.ok
        ? `已存入 ${driveName}${res.path ? `：${res.path}` : ''}${res.count ? `（${res.count} 个附件）` : ''}`
        : `上传失败：${res.error ?? '未知错误'}`
    )
  }

  /** 附件卡单件上传 */
  const uploadOneAttachment = async (att: Attachment, drive: CloudDriveConfig) => {
    const res = await api.cloudUpload(att.messageId, drive.id, 'attachment', att.id)
    showToast(res.ok ? `已存入 ${drive.name}：${att.filename}` : `上传失败：${res.error ?? '未知错误'}`)
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

  if (multiIds) {
    const picked = useMail.getState().messages.filter(m => multiIds.has(m.id))
    const senders = [...new Set(picked.map(m => displayName(m.from)))]
    return (
      <div className="flex-1 min-w-0 h-full flex flex-col">
        <div className="drag-region h-[var(--titlebar-h)] shrink-0 border-b border-[var(--border-soft)]" />
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="w-full max-w-[420px] fade-in">
            <div className="text-xl font-semibold tight tnum" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>
              已选 {multiIds.size} 封
            </div>
            <div className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
              来自 {senders.slice(0, 3).join('、')}{senders.length > 3 ? ` 等 ${senders.length} 位发件人` : ''}
            </div>
            <div className="mt-5 rounded-[var(--r-md)] border border-[var(--border-soft)] surface divide-y divide-[var(--border-soft)]">
              {picked.slice(0, 6).map(m => (
                <div key={m.id} className="h-9 px-3 flex items-center gap-2 text-sm">
                  <span className="truncate flex-1" style={{ color: 'var(--fg)' }}>{m.subject || '（无主题）'}</span>
                  <span className="text-xs shrink-0 truncate max-w-[40%]" style={{ color: 'var(--faint)' }}>{displayName(m.from)}</span>
                </div>
              ))}
              {picked.length > 6 && (
                <div className="h-8 px-3 flex items-center text-xs" style={{ color: 'var(--faint)' }}>还有 {picked.length - 6} 封…</div>
              )}
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('ms:list-action', { detail: 'bulk-ask' }))}
                className="btn-liquid h-8 px-3 rounded-[var(--r-sm)] inline-flex items-center gap-1.5 text-sm font-medium"
              >
                <IconSparkles width={14} height={14} /> 基于这些邮件提问
              </button>
              <span className="text-xs" style={{ color: 'var(--faint)' }}>批量操作在列表底部 · Esc 取消选择</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!selectedId) {
    return (
      <div className="flex-1 min-w-0 h-full flex items-center justify-center">
        <div className="text-center px-6 text-balance">
          <div className="text-md font-medium" style={{ color: 'var(--faint)' }}>选择一封邮件开始阅读</div>
          <div className="mt-1.5 text-xs" style={{ color: 'var(--faint)', opacity: 0.75 }}>
            ⌘K 命令面板 · J/K 切换 · R 回复 · ⌘T 明暗
          </div>
        </div>
      </div>
    )
  }

  // 点击后预览骨架屏：正文按需拉取时的加载反馈
  if (!msg) {
    return (
      <div className="flex-1 min-w-0 h-full flex flex-col relative overflow-hidden">
        <div className="drag-region h-[var(--titlebar-h)] shrink-0 border-b border-[var(--border-soft)]" />
        <div className="shrink-0 px-6 pb-4 space-y-3">
          <div className="h-[24px] w-[60%] rounded-lg shimmer" />
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full shimmer" />
            <div className="space-y-1.5 flex-1">
              <div className="h-[12px] w-[30%] rounded-sm shimmer" />
              <div className="h-[10px] w-[45%] rounded-sm shimmer" />
            </div>
          </div>
        </div>
        <div className="shrink-0 px-6 pt-2">
          <div className="h-[52px] rounded-[var(--r-md)] shimmer" />
        </div>
        <div className="flex-1 px-6 pt-4">
          <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] px-6 py-5 space-y-2.5" style={{ background: 'var(--surface-strong)' }}>
            {[92, 100, 78, 96, 64, 88, 40].map((w, i) => (
              <div key={i} className="h-[11px] rounded-sm shimmer" style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
      </div>
    )
  }

  const atts = msg.attachments.filter(a => !a.inline)
  const canUnsub = !!msg.listUnsubscribe
  const moreItems: MenuItem[] = [
    { kind: 'action', label: msg.pinned ? '取消置顶' : '置顶', icon: <IconPin width={13} height={13} />, onSelect: () => void useMail.getState().setPinned([msg.id], !msg.pinned) },
    { kind: 'action', label: msg.flagged ? '取消旗标' : '加旗标', icon: <IconFlag width={13} height={13} />, onSelect: () => void act('flag') },
    { kind: 'action', label: msg.unread ? '标为已读' : '标为未读', icon: <IconMailDot width={13} height={13} />, onSelect: () => void (msg.unread ? api.markRead([msg.id], true).then(() => loadMessages()) : act('unread')) },
    { kind: 'sep' },
    { kind: 'action', label: '存入知识库', icon: <IconSave width={13} height={13} />, onSelect: () => void saveToKb() },
    ...connectors.map(c => ({ kind: 'action' as const, label: `分享到 ${manifests.find(m => m.id === c.manifestId)?.name ?? c.manifestId}`, icon: <IconPlug width={13} height={13} />, onSelect: () => void shareConnector(c.id, 'forward') })),
    ...drives.map(d => ({ kind: 'action' as const, label: `eml 原文 → ${d.name}`, icon: <IconCloud width={13} height={13} />, onSelect: () => void uploadToDrive(d.id, d.name, 'eml') })),
    ...(atts.length ? drives.map(d => ({ kind: 'action' as const, label: `全部附件（${atts.length}）→ ${d.name}`, icon: <IconCloud width={13} height={13} />, onSelect: () => void uploadToDrive(d.id, d.name, 'attachments') })) : []),
    ...(canUnsub ? [{ kind: 'sep' as const }, { kind: 'action' as const, label: '退订此发件人', icon: <IconUnsub width={13} height={13} />, onSelect: () => void unsubscribe() }] : []),
    { kind: 'sep' },
    { kind: 'action', label: '删除', icon: <IconTrash width={13} height={13} />, hint: '⌫', danger: true, onSelect: () => void act('trash') }
  ]

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col relative">
      {/* 顶部工具栏：并入 52px 标题栏，与侧栏「写邮件」、列表搜索同一基线（审计 T-4 / IA-6）
          主动作：回复 · 全部回复 · 转发 | 归档 · 稍后 · 删除；其余进「⋯」；窄宽度自动只留图标 */}
      <div ref={toolbarRef} className="drag-region h-[var(--titlebar-h)] shrink-0 flex items-center gap-0.5 px-4 border-b border-[var(--border-soft)]">
        <button onClick={() => reply(false)} title="回复（R）" className="no-drag btn-liquid h-7 px-2.5 rounded-[var(--r-sm)] inline-flex items-center gap-1.5 text-xs font-semibold mr-1">
          <IconReply width={13} height={13} />
          {!compact && '回复'}
        </button>
        <ToolButton onClick={() => reply(true)} icon={<IconReplyAll width={14} height={14} />} label="全部回复" compact={compact} />
        <ToolButton onClick={forward} icon={<IconForward width={14} height={14} />} label="转发" compact={compact} />
        <span className="w-px h-4 mx-1.5 shrink-0" style={{ background: 'var(--border)' }} />
        <ToolButton onClick={() => act('archive')} icon={<IconArchive width={14} height={14} />} label="归档" hint="A" compact={compact} />
        <div ref={snoozeRef} className="relative no-drag">
          <ToolButton onClick={() => setSnoozeOpen(o => !o)} icon={<IconClock width={14} height={14} />} label="稍后" hint="S" compact={compact} active={snoozeOpen || !!msg.snoozedUntil} />
          {snoozeOpen && (
            <div className="absolute top-full mt-1.5 left-0 z-30">
              <SnoozeMenu
                align="left"
                messageId={msg.id}
                currentlySnoozed={!!msg.snoozedUntil}
                onPick={async at => {
                  await api.snoozeMessages([msg.id], at)
                  setSnoozeOpen(false)
                  showToast(`已稍后处理，${fmtSnooze(at)} 回到收件箱`)
                  useMail.getState().select(null)
                  await loadMessages()
                }}
                onUnsnooze={async () => {
                  await api.snoozeMessages([msg.id], null)
                  setSnoozeOpen(false)
                  await loadMessages()
                }}
                onClose={() => setSnoozeOpen(false)}
              />
            </div>
          )}
        </div>
        <ToolButton onClick={() => act('trash')} icon={<IconTrash width={14} height={14} />} label="删除" hint="⌫" compact danger />
        <div className="flex-1" />
        {/* 阅读风格（上下文锚定的风格选择器） */}
        <div ref={styleRootRef} className="relative no-drag">
          <ToolButton onClick={() => setStyleMenu(m => !m)} icon={<IconPalette width={14} height={14} />} label={skin ? skin[1] : '阅读风格'} compact active={!!skin} />
          {styleMenu && (
            <div className="absolute top-full mt-1.5 right-0 z-30 w-[248px] max-h-[420px] overflow-y-auto liquid-glass rounded-[var(--r-md)] p-1 pop-in">
              <div className="caps px-2 pt-1.5 pb-1" style={{ color: 'var(--faint)' }}>
                阅读风格 · {READING_STYLES.length} 款
              </div>
              <StyleOption label="默认（跟随应用主题）" active={!styleId} onClick={() => applyStyle('')} />
              {READING_STYLES.map(s => (
                <StyleOption key={s[0]} label={s[1]} color={s[4]} bg={s[2]} active={styleId === s[0]} onClick={() => applyStyle(s[0])} />
              ))}
            </div>
          )}
        </div>
        <MenuButton title="更多操作" items={moreItems} width={232}>
          <IconMore width={15} height={15} />
        </MenuButton>
      </div>

      {/* 头部信息 */}
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-[var(--border-soft)]">
        <h1 className="selectable text-lg font-semibold leading-snug" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>{msg.subject || '（无主题）'}</h1>
        <div className="mt-2.5 flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-base font-medium shrink-0"
            style={avatarStyle(displayName(msg.from))}
          >
            {[...displayName(msg.from)][0]?.toUpperCase() ?? '?'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              {/* 窄阅读区（放大显示 / 小窗）只留姓名，地址进 tooltip，避免姓名被挤成单字 */}
              <span className="text-sm font-medium selectable truncate" title={msg.from?.address} style={{ color: 'var(--fg)' }}>{displayName(msg.from)}</span>
              {!compact && <span className="text-xs truncate min-w-0 shrink-[2]" style={{ color: 'var(--faint)' }}>{msg.from?.address}</span>}
              <span className="ml-auto text-xs shrink-0" style={{ color: 'var(--faint)' }}>{fmtFullDate(msg.date)}</span>
            </div>
            <div className="text-xs selectable truncate" style={{ color: 'var(--faint)' }}>
              收件人：{msg.to.map(displayName).join('，') || '—'}
              {msg.cc.length > 0 && `；抄送：${msg.cc.map(displayName).join('，')}`}
            </div>
          </div>
        </div>
        {canUnsub && (
          <button
            onClick={unsubscribe}
            className="mt-2.5 inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full"
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
            <span className="leading-none inline-flex" style={{ color: 'var(--accent)' }}>
              {auth.kind === 'code' ? <IconKey width={20} height={20} /> : <IconLock width={20} height={20} />}
            </span>
            {auth.kind === 'code' ? (
              <>
                <div className="flex-1 min-w-0">
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>检测到验证码，点击即复制</div>
                  <button
                    onClick={copyCode}
                    className="text-lg font-semibold tracking-[.18em] font-[var(--font-mono)] hover:opacity-80"
                    style={{ color: 'var(--accent-strong)' }}
                  >
                    {auth.code}
                  </button>
                </div>
                <button
                  onClick={copyCode}
                  className="no-drag text-xs font-medium px-3.5 py-1.5 rounded-lg shrink-0"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                >
                  复制验证码
                </button>
              </>
            ) : (
              <>
                <div className="flex-1 min-w-0">
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>检测到登录 / 验证链接{auth.provider ? ` · ${auth.provider}` : ''}</div>
                  <div className="text-sm font-medium truncate" style={{ color: 'var(--accent-strong)' }}>一键直达，无需翻找正文</div>
                </div>
                <button
                  onClick={() => auth.url && void api.openExternal(auth.url)}
                  className="no-drag text-xs font-medium px-3.5 py-1.5 rounded-lg shrink-0"
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
        <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] overflow-hidden surface">
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 px-3 py-2">
            <span className="w-5 h-5 mr-1 rounded-full flex items-center justify-center shrink-0" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
              <IconSparkles width={11} height={11} />
            </span>
            <span className="text-sm font-medium whitespace-nowrap" style={{ color: 'var(--fg)' }}>AI 助手</span>
            <div className="flex-1 min-w-2" />
            {aiReady?.ready === false ? (
              <button onClick={() => api.openSettings('ai')} className="h-6 px-2 rounded-[var(--r-sm)] text-xs whitespace-nowrap hover:bg-[var(--hover-strong)]" style={{ color: 'var(--accent-ink)' }}>
                {aiReady.reason} · 去配置
              </button>
            ) : (
            /* 动作作为一组整体换行，窄宽度下不会拆成错位的两截 */
            <div className="flex flex-wrap items-center gap-1">
              <AIChip label="摘要" onClick={() => runAI('summary')} active={aiMode === 'summary'} />
              <AIChip label="起草回复" onClick={() => runAI('draft')} active={aiMode === 'draft'} />
              <AIChip label="提取待办" onClick={() => runAI('tasks')} active={aiMode === 'tasks'} />
              <AIChip label={extracting ? '提炼中…' : '提炼'} onClick={runExtract} active={false} />
              <AIChip label={learning ? '学习中…' : '学习'} onClick={runAgentLearn} active={false} />
            </div>
            )}
          </div>
          {(ai.text || ai.streaming || ai.error) && (
            <div className="px-4 pb-3.5">
              <div className="pt-2 border-t border-[var(--border-soft)]">
                <div className="selectable mt-2 text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--muted)' }}>
                  {ai.error ? <span style={{ color: 'var(--danger)' }}>{ai.error}</span> : ai.text}
                  {ai.streaming && <span className="inline-block w-1.5 h-4 ml-0.5 animate-pulse align-middle" style={{ background: 'var(--accent)' }} />}
                </div>
                {aiMode === 'draft' && !ai.streaming && ai.text && (
                  <div className="mt-2.5 flex gap-2">
                    <button
                      onClick={useAiDraft}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium"
                      style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                    >
                      用这封回复
                    </button>
                    <button
                      onClick={() => navigator.clipboard.writeText(ai.text)}
                      className="text-xs px-3 py-1.5 rounded-lg"
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
            <AttachmentCard key={a.id} att={a} drives={drives} onUpload={uploadOneAttachment} />
          ))}
        </div>
      )}

      {/* 正文 */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {remoteCount > 0 && (
          <div className="mb-3 flex items-center gap-2 text-xs rounded-[var(--r-sm)] px-3.5 py-2.5" style={{ background: 'var(--warn-soft)', color: 'var(--muted)' }}>
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
                  padding: '20px 24px'
                }
          }
        >
          {!msg.text && !msg.html && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, padding: '10px 14px', borderRadius: 'var(--r-md)', background: bodyError ? 'var(--danger-soft)' : 'var(--hover)', fontSize: 13 }}>
              <span style={{ flex: 1, color: 'var(--fg)' }}>
                {bodyError ? `正文加载失败：${bodyError}` : '正文尚未下载（可能仍在同步中）'}
              </span>
              <button
                className="btn-liquid"
                onClick={retryBody}
                disabled={retrying}
                style={{ padding: '6px 14px', fontSize: 12 }}
              >
                {retrying ? '正在拉取…' : '重新加载正文'}
              </button>
            </div>
          )}
          <div
            ref={bodyRef}
            className="mail-body-host selectable"
            style={skin ? { borderRadius: 'var(--r-md)', padding: '20px 24px' } : undefined}
          />
        </div>
      </div>

      {toast && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full liquid-glass text-sm fade-in" style={{ color: 'var(--fg)' }}>
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
      className="w-full flex items-center gap-2 px-2.5 py-[7px] rounded-lg text-xs text-left border"
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
          <i className="w-3 h-3 rounded-xs border border-ink/10" style={{ background: props.bg }} />
          <i className="w-3 h-3 rounded-xs border border-ink/10" style={{ background: props.color }} />
        </span>
      )}
      <span className="flex-1 truncate">{props.label}</span>
      {props.active && <span className="text-2xs" style={{ color: 'var(--accent)' }}>✓</span>}
    </button>
  )
}

function AIChip(props: { label: string; onClick(): void; active?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      className="h-6 px-2 rounded-[var(--r-sm)] text-xs whitespace-nowrap shrink-0 transition-colors hover:bg-[var(--hover-strong)]"
      style={props.active
        ? { background: 'var(--selected)', color: 'var(--accent-ink)', fontWeight: 500 }
        : { color: 'var(--muted)' }}
    >
      {props.label}
    </button>
  )
}

function ToolButton(props: { icon: React.ReactNode; label: string; onClick(): void; active?: boolean; danger?: boolean; compact?: boolean; hint?: string }) {
  return (
    <button
      onClick={props.onClick}
      title={props.hint ? `${props.label}（${props.hint}）` : props.label}
      aria-label={props.label}
      className={`no-drag icon-btn h-7 inline-flex items-center gap-1.5 text-xs whitespace-nowrap shrink-0 ${props.compact ? 'w-7 justify-center' : 'px-2'} ${props.danger ? 'hover:!text-[var(--danger)]' : ''}`}
      style={{
        color: props.active ? 'var(--accent-ink)' : 'var(--muted)',
        background: props.active ? 'var(--selected)' : undefined
      }}
    >
      {props.icon}
      {!props.compact && props.label}
    </button>
  )
}

function AttachmentCard(props: { att: Attachment; drives: CloudDriveConfig[]; onUpload(att: Attachment, drive: CloudDriveConfig): void }) {
  const a = props.att
  const [driveMenu, setDriveMenu] = useState(false)
  const hasDrive = props.drives.length > 0
  return (
    <div className="relative group">
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
          <span className="block max-w-[180px] truncate text-xs" style={{ color: 'var(--fg)' }}>{a.filename}</span>
          <span className="block text-2xs" style={{ color: 'var(--faint)' }}>{fmtSize(a.size)}</span>
        </span>
      </button>
      {hasDrive && (
        <button
          title="上传到网盘"
          onClick={e => {
            e.stopPropagation()
            setDriveMenu(m => !m)
          }}
          className="absolute -top-1.5 -right-1.5 w-[20px] h-[20px] rounded-full liquid-glass items-center justify-center hidden group-hover:flex"
          style={{ color: 'var(--accent)' }}
        >
          <IconCloud width={11} height={11} />
        </button>
      )}
      {driveMenu && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setDriveMenu(false)} />
          <div className="absolute top-5 right-0 z-30 w-44 liquid-glass rounded-[var(--r-sm)] py-1 pop-in">
            {props.drives.map(d => (
              <button
                key={d.id}
                onClick={() => {
                  setDriveMenu(false)
                  props.onUpload(a, d)
                }}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--hover)] truncate"
                style={{ color: 'var(--fg)' }}
              >
                上传到 {d.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function escapeHtmlMinor(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
