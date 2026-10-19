import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, EditorContent, Extension } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Image from '@tiptap/extension-image'
import { api, useAsync, displayName } from '../lib/api'
import { sanitizeEmailHtml } from '../lib/sanitize'
import { buildAutoVars, fillPlaceholders, sortTemplateCategories, UNCATEGORIZED } from '../lib/template-presets'
import { markdownToHtml } from '../components/Markdown'
import { IconSend, IconAttach, IconSave, IconLink, IconQuote, IconList, IconListOrdered, IconSparkles } from '../components/icons'
import type { Address, ComposeDraft, ComposeFollowup, FollowupData, MailTemplate, MessageFull, Signature } from '@shared/types'
import { RecipientField, type RecipientFieldHandle } from './compose/RecipientField'
import { collectSendIssues, type SendIssue } from './compose/send-check'
import { cleanAiText, cleanSubject, editorPlainText, REWRITE_STYLES, useComposeAi } from './compose/ai'
import { AiMenu, AiResult, AiUnavailable, AttachmentChips, ClosePrompt, PointsPanel, SendCheckDialog, ShortcutHelp, Toast } from './compose/parts'
import type { ComposeRewriteStyle } from '@shared/ipc'
import { FollowupToggle } from './compose/FollowupToggle'
import './compose/compose.css'

type Prefill = Partial<ComposeDraft> & { cc?: Address[]; forwardOf?: string; quoteMessageId?: string }
type Attach = { path: string; name: string; size: number }
type SendMode = { kind: 'now' } | { kind: 'schedule'; at: number; label: string }

/** 附件总大小提醒阈值：多数服务商 25MB 上限，Base64 编码后约膨胀 1/3 */
const ATTACH_WARN_BYTES = 20 * 1024 * 1024
/** 自动保存防抖 */
const AUTOSAVE_MS = 1500

export function ComposeWindow({ prefill: rawPrefill }: { prefill?: Partial<ComposeDraft> }) {
  const prefill = rawPrefill as Prefill | undefined
  const { data: accounts } = useAsync(() => api.listAccounts(), [])
  const { data: templates } = useAsync(() => api.listTemplates(), [])
  const { data: signatures } = useAsync(() => api.listSignatures(), [])

  const [accountId, setAccountId] = useState(prefill?.accountId ?? '')
  const [to, setTo] = useState<Address[]>(prefill?.to ?? [])
  const [cc, setCc] = useState<Address[]>(prefill?.cc ?? [])
  const [bcc, setBcc] = useState<Address[]>(prefill?.bcc ?? [])
  const [showCc, setShowCc] = useState((prefill?.cc?.length ?? 0) > 0)
  const [showBcc, setShowBcc] = useState((prefill?.bcc?.length ?? 0) > 0)
  const [subject, setSubject] = useState(prefill?.subject ?? '')
  const [subjectAi, setSubjectAi] = useState(false)
  const [attachments, setAttachments] = useState<Attach[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [quote, setQuote] = useState<MessageFull | null>(null)
  const [bodyEmpty, setBodyEmpty] = useState(!prefill?.html)
  const [toast, setToast] = useState<{ text: string; action?: { label: string; run(): void } } | null>(null)
  const [check, setCheck] = useState<{ issues: SendIssue[]; mode: SendMode } | null>(null)
  const [closePrompt, setClosePrompt] = useState(false)
  const [help, setHelp] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [save, setSave] = useState<{ state: 'idle' | 'saving' | 'saved' | 'error'; at: number }>({ state: 'idle', at: 0 })
  const [, setClock] = useState(0)

  const toRef = useRef<RecipientFieldHandle>(null)
  const ccRef = useRef<RecipientFieldHandle>(null)
  const bccRef = useRef<RecipientFieldHandle>(null)
  const subjectRef = useRef<HTMLInputElement>(null)

  const draftId = useMemo(() => prefill?.id ?? `draft-${Date.now()}`, [prefill?.id])

  // ---------- 发出后跟进：Agent / 技能起草时带 followup 默认开；打开已登记跟进的草稿时也预填 ----------
  const [followup, setFollowup] = useState<ComposeFollowup>(() =>
    prefill?.followup ? { ...prefill.followup, enabled: prefill.followup.enabled !== false } : { enabled: false, waitDays: 3 }
  )
  useEffect(() => {
    if (prefill?.followup || !prefill?.id) return
    void api
      .followupList()
      .then(list => {
        const hit = list.find(r => {
          const d = r.data as unknown as FollowupData
          return d.draftId === prefill.id || d.nudgeDraftId === prefill.id
        })
        if (!hit) return
        const d = hit.data as unknown as FollowupData
        setFollowup({ id: hit.id, enabled: true, kind: d.kind, ask: d.ask, waitDays: d.waitDays })
      })
      .catch(() => undefined)
  }, [prefill?.id, prefill?.followup])
  const isForward = !!prefill?.forwardOf || /^(转发|fwd?)[:：]/i.test(prefill?.subject ?? '')
  const isReply = !!prefill?.relatedMessageId && !isForward
  const account = accounts?.find(a => a.id === accountId)
  const myAddrs = useMemo(() => (accounts ?? []).map(a => a.email), [accounts])

  // ---------- 发件账户：回复默认用收到原邮件的账户 ----------
  useEffect(() => {
    if (!accounts?.length) return
    if (accountId && accounts.some(a => a.id === accountId)) return
    // 回复 / 转发且没指定账户：等原邮件加载后用它的账户
    if (prefill?.relatedMessageId && !quote) return
    const fromQuote = quote && accounts.find(a => a.id === quote.accountId)
    setAccountId((fromQuote ?? accounts[0]).id)
  }, [accounts, accountId, quote, prefill?.relatedMessageId])

  // 回复/转发引用
  useEffect(() => {
    const related = prefill?.relatedMessageId
    if (!related) return
    void api
      .getMessage(related)
      .then(setQuote)
      .catch(() => setQuote(null))
  }, [prefill?.relatedMessageId])

  // ---------- 自动保存（同一 draftId upsert，不会产生多条草稿） ----------
  const versionRef = useRef(0)
  const savedVersionRef = useRef(0)
  const savedOnceRef = useRef(!!prefill?.id)
  const finalizingRef = useRef(false)
  const allowCloseRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inflight = useRef<Promise<unknown> | null>(null)
  const saveNowRef = useRef<(lists?: { to: Address[]; cc: Address[]; bcc: Address[] }) => Promise<boolean>>(async () => false)

  const touch = useCallback(() => {
    versionRef.current++
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void saveNowRef.current(), AUTOSAVE_MS)
  }, [])

  // ---------- 编辑器 ----------
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false }),
      Link.configure({ openOnClick: false }),
      Image,
      Placeholder.configure({ placeholder: '正文…' }),
      ComposeKeys
    ],
    content: prefill?.html ?? '',
    editorProps: { attributes: { class: 'compose-editor', 'aria-label': '正文' } },
    onUpdate: ({ editor }) => {
      setBodyEmpty(editor.isEmpty)
      touch()
    }
  })

  // AI 起草内容注入（openCompose 预填的正文；不算用户修改）
  useEffect(() => {
    if (prefill?.html && editor) {
      editor.commands.setContent(prefill.html, { emitUpdate: false })
      setBodyEmpty(editor.isEmpty)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  // ---------- 签名：切换账户自动换成该账户默认签名（手改过就不覆盖，可撤销） ----------
  const [sigId, setSigId] = useState<string | null>(null)
  const sigEditedRef = useRef(false)
  const sigAccountRef = useRef<string | null>(null)
  const sigEditor = useEditor({
    extensions: [StarterKit.configure({ heading: false, link: false }), Link.configure({ openOnClick: false }), Image],
    content: '',
    editorProps: { attributes: { class: 'compose-sig', 'aria-label': '签名' } },
    onUpdate: () => {
      sigEditedRef.current = true
      touch()
    }
  })

  const defaultSigFor = useCallback(
    (accId: string): Signature | undefined => {
      const sigs = signatures ?? []
      const acc = accounts?.find(a => a.id === accId)
      return (
        (acc?.signatureId ? sigs.find(s => s.id === acc.signatureId) : undefined) ??
        sigs.find(s => s.defaults.includes(accId)) ??
        sigs.find(s => s.defaults.includes('all'))
      )
    },
    [signatures, accounts]
  )

  const setSignatureContent = useCallback(
    (id: string | null, html: string) => {
      setSigId(id)
      sigEditor?.commands.setContent(html, { emitUpdate: false })
    },
    [sigEditor]
  )

  // 初始 / 非用户触发的账户变化：静默套用默认签名
  useEffect(() => {
    if (!accountId || !signatures || !accounts || !sigEditor) return
    if (sigAccountRef.current === accountId) return
    sigAccountRef.current = accountId
    if (sigEditedRef.current) return
    const sig = defaultSigFor(accountId)
    setSignatureContent(sig?.id ?? null, sig?.html ?? '')
  }, [accountId, signatures, accounts, sigEditor, defaultSigFor, setSignatureContent])

  const changeAccount = (id: string) => {
    if (id === accountId) return
    sigAccountRef.current = id
    setAccountId(id)
    touch()
    const sig = defaultSigFor(id)
    const nextHtml = sig?.html ?? ''
    const prevHtml = sigEditor && !sigEditor.isEmpty ? sigEditor.getHTML() : ''
    const prevId = sigId
    const acc = accounts?.find(a => a.id === id)
    if (sigEditedRef.current) {
      if (sig && nextHtml !== prevHtml) {
        setToast({
          text: '签名改过，没有自动替换',
          action: {
            label: `换成「${sig.name}」`,
            run: () => {
              sigEditedRef.current = false
              setSignatureContent(sig.id, nextHtml)
              touch()
            }
          }
        })
      }
      return
    }
    if (prevId === (sig?.id ?? null)) return
    setSignatureContent(sig?.id ?? null, nextHtml)
    setToast({
      text: sig ? `已换成签名「${sig.name}」` : `${acc?.name ?? '该账户'}没有默认签名，已移除签名`,
      action: {
        label: '撤销',
        run: () => {
          setSignatureContent(prevId, prevHtml)
          touch()
        }
      }
    })
  }

  const pickSignature = (id: string) => {
    const sig = signatures?.find(s => s.id === id)
    sigEditedRef.current = true
    setSignatureContent(sig?.id ?? null, sig?.html ?? '')
    touch()
  }

  // ---------- 草稿 ----------
  const flushRecipients = () => ({
    to: toRef.current?.flush() ?? to,
    cc: ccRef.current?.flush() ?? cc,
    bcc: bccRef.current?.flush() ?? bcc
  })

  const signatureHtml = () => (sigEditor && !sigEditor.isEmpty ? sigEditor.getHTML() : '')

  const buildDraft = (html: string, lists = { to, cc, bcc }): ComposeDraft => ({
    id: draftId,
    accountId,
    to: lists.to,
    cc: lists.cc,
    bcc: lists.bcc,
    subject,
    html,
    inReplyToMessageId: prefill?.inReplyToMessageId,
    relatedMessageId: prefill?.relatedMessageId,
    attachmentPaths: attachments.map(a => a.path),
    // 开着，或关掉了一条已登记的（主进程据此取消）；真正发出后由主进程登记为「等待对方」
    ...(followup.enabled || followup.id ? { followup } : {})
  })

  const isBlank = (lists = { to, cc, bcc }) =>
    !lists.to.length && !lists.cc.length && !lists.bcc.length && !subject.trim() && (editor?.isEmpty ?? true) && !attachments.length

  const saveNow = async (lists = { to, cc, bcc }): Promise<boolean> => {
    if (finalizingRef.current || !editor || !accountId) return false
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const v = versionRef.current
    if (isBlank(lists)) {
      if (savedOnceRef.current) {
        await api.deleteDraft(draftId).catch(() => undefined)
        savedOnceRef.current = false
      }
      savedVersionRef.current = v
      setSave({ state: 'idle', at: 0 })
      return true
    }
    setSave(s => ({ ...s, state: 'saving' }))
    const p = api.saveDraft(buildDraft(editor.getHTML(), lists))
    inflight.current = p
    try {
      await p
      savedOnceRef.current = true
      savedVersionRef.current = v
      setSave({ state: 'saved', at: Date.now() })
      return true
    } catch {
      setSave(s => ({ ...s, state: 'error' }))
      return false
    } finally {
      if (inflight.current === p) inflight.current = null
    }
  }
  saveNowRef.current = saveNow

  // 字段变化（用户操作）→ 标记修改
  const firstFields = useRef(true)
  useEffect(() => {
    if (firstFields.current) {
      firstFields.current = false
      return
    }
    touch()
  }, [to, cc, bcc, subject, attachments, touch])

  // 「已自动保存 · 刚刚」相对时间刷新
  useEffect(() => {
    const t = setInterval(() => setClock(c => c + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const closeWindow = () => {
    allowCloseRef.current = true
    window.close()
  }

  // 关闭窗口：有未保存的修改时先问
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (allowCloseRef.current) return
      if (versionRef.current === savedVersionRef.current || isBlank()) return
      e.preventDefault()
      e.returnValue = false
      setClosePrompt(true)
    }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  })

  const saveAndClose = async () => {
    const ok = await saveNowRef.current(flushRecipients())
    if (ok) closeWindow()
  }

  // ---------- 发送 ----------
  const doSend = async (mode: SendMode, lists = { to, cc, bcc }) => {
    if (!editor || sending) return
    finalizingRef.current = true
    if (saveTimer.current) clearTimeout(saveTimer.current)
    // 等在途的自动保存落盘，避免它晚到把定时发送的 send_at 覆盖掉
    if (inflight.current) await inflight.current.catch(() => undefined)
    const html = buildFullHtml(editor.getHTML(), quote, signatureHtml())
    const draft = buildDraft(html, lists)
    setError('')
    if (mode.kind === 'now') {
      setSending(true)
      const result = await api.sendMail(draft).catch(err => ({ ok: false, error: String(err) }))
      setSending(false)
      if (result.ok) {
        if (savedOnceRef.current) void api.deleteDraft(draftId)
        if (prefill?.relatedMessageId) void api.markAnswered(prefill.relatedMessageId)
        closeWindow()
      } else {
        finalizingRef.current = false
        setError(result.error ?? '发送失败')
      }
    } else {
      const res = await api.scheduleSend(draft, mode.at).catch(err => ({ ok: false, error: String(err) }))
      if (res.ok) {
        closeWindow()
      } else {
        finalizingRef.current = false
        setError(res.error ?? '定时失败')
      }
    }
  }

  /** 发送入口（按钮 / ⌘↩ / 延迟与定时）：先过发送前检查 */
  const requestSend = (mode: SendMode) => {
    if (!editor || sending || !accountId) return
    setSendMenu(false)
    const lists = flushRecipients()
    const issues = collectSendIssues({
      ...lists,
      subject,
      bodyText: editorPlainText(editor),
      attachmentCount: attachments.length,
      isReply,
      myAddrs
    })
    if (issues.length) {
      setCheck({ issues, mode })
      return
    }
    void doSend(mode, lists)
  }

  // ---------- 延迟 / 定时发送 ----------
  const [sendMenu, setSendMenu] = useState(false)
  const [schedTime, setSchedTime] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sendMenu) return
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setSendMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [sendMenu])

  const schedule = (delayMs?: number, label?: string) => {
    if (delayMs === undefined) {
      if (!schedTime) return
      const at = Date.parse(schedTime)
      if (!Number.isFinite(at)) return
      requestSend({ kind: 'schedule', at, label: '定时发送' })
      return
    }
    requestSend({ kind: 'schedule', at: Date.now() + delayMs, label: label ?? '延迟发送' })
  }

  const MenuRow = (props: { label: string; hint?: string; onClick(): void }) => (
    <button type="button" onClick={props.onClick} className="cmp-menu-row">
      <span className="flex-1">{props.label}</span>
      {props.hint && <span className="cmp-menu-hint">{props.hint}</span>}
    </button>
  )

  // ---------- 附件（选择 / 拖入） ----------
  const addFiles = (files: Attach[]) => {
    if (!files.length) return
    setAttachments(prev => {
      const seen = new Set(prev.map(a => a.path))
      return [...prev, ...files.filter(f => f.path && !seen.has(f.path) && seen.add(f.path))]
    })
  }

  const pick = async () => {
    const files = await api.pickFiles()
    addFiles(files)
  }

  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      depth++
      setDragging(true)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // 拦住编辑器的插入光标（dropcursor），文件只作为附件
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return
      // 捕获阶段拦截：不让编辑器把文件当图片 / 链接插入，也不让窗口导航到文件
      e.preventDefault()
      e.stopPropagation()
      depth = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      const out: Attach[] = []
      for (const f of files) {
        const path = api.pathForFile(f)
        if (!path) continue
        // 文件夹读不出内容：跳过
        const readable = await f.slice(0, 1).arrayBuffer().then(() => true, () => false)
        if (!readable) continue
        out.push({ path, name: f.name, size: f.size })
      }
      if (out.length) addFiles(out)
      if (out.length < files.length) setToast({ text: '文件夹不能直接作为附件，请先压缩' })
    }
    window.addEventListener('dragenter', onEnter, true)
    window.addEventListener('dragover', onOver, true)
    window.addEventListener('dragleave', onLeave, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragenter', onEnter, true)
      window.removeEventListener('dragover', onOver, true)
      window.removeEventListener('dragleave', onLeave, true)
      window.removeEventListener('drop', onDrop, true)
    }
  }, [])

  // ---------- 模板 ----------
  const insertTemplate = (t: MailTemplate) => {
    if (!editor) return
    const first = to[0]
    const vars = buildAutoVars({ recipient: first?.name || undefined, me: account?.name })
    if (t.subject && !subject) setSubject(fillPlaceholders(t.subject, vars))
    editor.commands.insertContent(fillPlaceholders(t.html, vars, true))
  }

  const templateGroups = useMemo(() => {
    const groups = new Map<string, MailTemplate[]>()
    for (const t of templates ?? []) {
      const c = t.category?.trim() || UNCATEGORIZED
      groups.set(c, [...(groups.get(c) ?? []), t])
    }
    return sortTemplateCategories(groups.keys()).map(c => [c, groups.get(c)!] as const)
  }, [templates])

  // ---------- AI ----------
  const [aiStatus, setAiStatus] = useState<{ ready: boolean; reason?: string }>({ ready: true })
  const [aiMenu, setAiMenu] = useState<{ selectionChars: number } | null>(null)
  const [points, setPoints] = useState<string | null>(null)
  const bodyAi = useComposeAi()
  const subjectAiJob = useComposeAi()

  useEffect(() => {
    const load = () => void api.aiStatus().then(setAiStatus).catch(() => setAiStatus({ ready: false }))
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])

  const recipientNames = () => [...to, ...cc].map(a => a.name || a.address)

  const openAiMenu = () => {
    if (!editor) return
    const { from, to: end } = editor.state.selection
    const sel = end > from ? editor.state.doc.textBetween(from, end, ' ').trim() : ''
    setAiMenu(m => (m ? null : { selectionChars: sel.length }))
  }

  const startRewrite = (style: ComposeRewriteStyle) => {
    if (!editor) return
    setAiMenu(null)
    const { from, to: end } = editor.state.selection
    const sel = end > from ? editor.state.doc.textBetween(from, end, '\n\n', '\n') : ''
    const source = sel.trim() ? sel : editorPlainText(editor)
    if (!source.trim()) return
    const label = REWRITE_STYLES.find(s => s.id === style)?.label ?? '改写'
    bodyAi.start({
      kind: 'rewrite',
      style,
      label,
      source,
      range: sel.trim() ? { from, to: end } : null,
      input: { task: 'rewrite', style, text: source }
    })
  }

  const startPoints = () => {
    const text = (points ?? '').trim()
    if (!text) return
    setPoints(null)
    bodyAi.start({
      kind: 'points',
      label: '用要点写',
      source: text,
      range: null,
      input: {
        task: 'points',
        text,
        subject,
        recipients: recipientNames(),
        relatedMessageId: prefill?.relatedMessageId
      }
    })
  }

  const startSubject = () => {
    if (!editor) return
    setAiMenu(null)
    const text = editorPlainText(editor)
    if (!text.trim()) return
    subjectAiJob.start({ kind: 'subject', label: 'AI 起主题', source: '', range: null, input: { task: 'subject', text, recipients: recipientNames() } })
  }

  // 主题生成完成 → 填入（带 AI 标记，用户一改就去掉）
  useEffect(() => {
    const j = subjectAiJob.job
    if (!j || j.streaming) return
    if (j.error && !j.text) {
      setToast({ text: j.error, action: /设置|接入|API Key|模型/.test(j.error) ? { label: '去设置 AI', run: () => void api.openSettings('ai') } : undefined })
    } else {
      const s = cleanSubject(j.text)
      if (s) {
        setSubject(s)
        setSubjectAi(true)
      }
    }
    subjectAiJob.discard()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectAiJob.job])

  const aiOutput = bodyAi.job ? cleanAiText(bodyAi.job.text) : ''

  const applyAi = (mode: 'replace' | 'below') => {
    const j = bodyAi.job
    if (!j || !editor || !aiOutput) return
    const doc = editor.state.doc
    const size = doc.content.size
    const html = markdownToHtml(aiOutput)
    const chain = editor.chain().focus()
    // 选区在生成期间被改动过：不再按原位置替换，退为插到末尾
    const rangeOk = !!j.range && j.range.to <= size && doc.textBetween(j.range.from, j.range.to, '\n\n', '\n') === j.source
    if (mode === 'replace') {
      if (j.kind === 'rewrite' && j.range && rangeOk) {
        const inline = !/\n/.test(aiOutput)
        chain.insertContentAt(j.range, inline ? { type: 'text', text: aiOutput } : html).run()
      } else if (j.kind === 'rewrite' && j.range) {
        chain.insertContentAt(size, html).run()
      } else {
        chain.insertContentAt({ from: 0, to: size }, html).run()
      }
    } else {
      let pos = size
      if (j.range && rangeOk) {
        try {
          pos = doc.resolve(j.range.to).after(1)
        } catch {
          pos = size
        }
      }
      chain.insertContentAt(pos, html).run()
    }
    bodyAi.discard()
  }

  // ---------- 键盘 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      // 浮层自己处理键盘
      if (check || closePrompt || help) return
      if (mod && e.key === 'Enter') {
        if (points !== null) return
        e.preventDefault()
        requestSend({ kind: 'now' })
      } else if (mod && e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        void pick()
      } else if (mod && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault()
        setShowCc(v => {
          if (!v) requestAnimationFrame(() => ccRef.current?.focus())
          return !v || cc.length > 0
        })
      } else if (mod && e.shiftKey && (e.key === 'b' || e.key === 'B')) {
        // ⌘⇧B = 显示密送（与 Gmail 一致）；TipTap 默认的 ⌘⇧B 引用块改到 ⌘⇧9（见 ComposeKeys）
        e.preventDefault()
        e.stopPropagation()
        setShowBcc(v => {
          if (!v) requestAnimationFrame(() => bccRef.current?.focus())
          return !v || bcc.length > 0
        })
      } else if (mod && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        void saveNowRef.current(flushRecipients())
      } else if (mod && !e.shiftKey && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault()
        openAiMenu()
      } else if (mod && e.key === '/') {
        e.preventDefault()
        setHelp(true)
      } else if (e.key === 'Escape') {
        if (aiMenu) setAiMenu(null)
        else if (sendMenu) setSendMenu(false)
        else if (toast) setToast(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // ---------- 渲染 ----------
  const title = subject.trim() || (isReply ? '回复' : isForward ? '转发' : '新邮件')
  useEffect(() => {
    document.title = title
  }, [title])

  const saveText =
    save.state === 'saving'
      ? '正在保存…'
      : save.state === 'error'
        ? '自动保存失败'
        : save.state === 'saved'
          ? `已自动保存 · ${relTime(save.at)}`
          : ''

  const canSubjectAi = !subject.trim() && !bodyEmpty
  const subjectStreaming = subjectAiJob.job?.streaming
  const pointsContext = [
    recipientNames().length ? `收件人 ${recipientNames().slice(0, 2).join('、')}${recipientNames().length > 2 ? ' 等' : ''}` : '',
    subject.trim() ? '主题' : '',
    prefill?.relatedMessageId ? '原邮件' : '',
    'Agent 记忆'
  ].filter(Boolean)

  return (
    <div className="cmp-root h-full flex flex-col">
      <div className="drag-region cmp-titlebar shrink-0">
        <span className="cmp-title truncate" title={title}>{title}</span>
      </div>

      {/* 字段 */}
      <div className="cmp-fields shrink-0">
        <div className="cmp-row">
          <label className="cmp-label" htmlFor="cmp-from">发件人</label>
          <select id="cmp-from" value={accountId} onChange={e => changeAccount(e.target.value)} className="cmp-select no-drag">
            {(accounts ?? []).map(a => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.email}
              </option>
            ))}
          </select>
        </div>
        <RecipientField
          ref={toRef}
          label="收件人"
          value={to}
          onChange={setTo}
          autoFocus={!to.length}
          trailing={
            (!showCc || !showBcc) && (
              <span className="cmp-row-tail">
                {!showCc && (
                  <button type="button" className="cmp-link" title="抄送 ⌘⇧C" onClick={() => { setShowCc(true); requestAnimationFrame(() => ccRef.current?.focus()) }}>
                    抄送
                  </button>
                )}
                {!showBcc && (
                  <button type="button" className="cmp-link" title="密送 ⌘⇧B" onClick={() => { setShowBcc(true); requestAnimationFrame(() => bccRef.current?.focus()) }}>
                    密送
                  </button>
                )}
              </span>
            )
          }
        />
        {showCc && <RecipientField ref={ccRef} label="抄送" value={cc} onChange={setCc} />}
        {showBcc && <RecipientField ref={bccRef} label="密送" value={bcc} onChange={setBcc} />}
        <div className="cmp-row">
          <label className="cmp-label" htmlFor="cmp-subject">主题</label>
          <input
            id="cmp-subject"
            ref={subjectRef}
            value={subjectStreaming ? cleanSubject(subjectAiJob.job?.text ?? '') : subject}
            readOnly={!!subjectStreaming}
            data-ai={subjectAi || subjectStreaming ? '' : undefined}
            onChange={e => {
              setSubject(e.target.value)
              setSubjectAi(false)
            }}
            placeholder={subjectStreaming ? 'AI 正在起主题…' : '主题'}
            className="cmp-input cmp-subject flex-1 selectable"
          />
          {(subjectAi || subjectStreaming) && <span className="ai-tag">AI</span>}
          {canSubjectAi && !subjectStreaming && aiStatus.ready && (
            <button type="button" className="cmp-link cmp-link-ai" onClick={startSubject} title="根据正文起一个主题">
              <IconSparkles width={12} height={12} /> AI 起主题
            </button>
          )}
        </div>
      </div>

      {/* 工具栏 */}
      <div className="cmp-toolbar shrink-0">
        <EditorToolbar editor={editor} />
        <div className="flex-1" />
        {(templates?.length ?? 0) > 0 && (
          <select
            onChange={e => {
              const t = templates!.find(x => x.id === e.target.value)
              if (t) insertTemplate(t)
              e.target.value = ''
            }}
            defaultValue=""
            className="cmp-select cmp-select-sm"
            aria-label="插入模板"
          >
            <option value="">插入模板…</option>
            {templateGroups.length > 1
              ? templateGroups.map(([cat, list]) => (
                  <optgroup key={cat} label={cat}>
                    {list.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </optgroup>
                ))
              : templates!.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
          </select>
        )}
        <div className="relative">
          <button
            type="button"
            data-ai-trigger
            className="cmp-ai-btn"
            data-open={aiMenu ? '' : undefined}
            onMouseDown={e => e.preventDefault()}
            onClick={openAiMenu}
            title="AI 写作 ⌘J"
          >
            <IconSparkles width={13} height={13} /> AI 写作
          </button>
          {aiMenu && (
            <AiMenu
              ready={aiStatus.ready}
              reason={aiStatus.reason}
              bodyEmpty={bodyEmpty}
              selectionChars={aiMenu.selectionChars}
              canSubject={canSubjectAi}
              onRewrite={startRewrite}
              onPoints={() => {
                setAiMenu(null)
                setPoints('')
              }}
              onSubject={startSubject}
              onClose={() => setAiMenu(null)}
            />
          )}
        </div>
      </div>

      {/* 正文 */}
      <div className="cmp-body flex-1 overflow-y-auto">
        {points !== null && (
          <PointsPanel value={points} onChange={setPoints} onSubmit={startPoints} onCancel={() => setPoints(null)} context={pointsContext} />
        )}
        {bodyAi.job && (
          <AiResult
            job={bodyAi.job}
            output={aiOutput}
            bodyEmpty={bodyEmpty}
            onReplace={() => applyAi('replace')}
            onBelow={() => applyAi('below')}
            onDiscard={bodyAi.discard}
            onStop={bodyAi.stop}
            onRetry={bodyAi.retry}
          />
        )}
        {bodyEmpty && points === null && !bodyAi.job && (
          aiStatus.ready ? (
            <button type="button" className="ai-hint" onClick={() => setPoints('')}>
              <IconSparkles width={13} height={13} />
              <span className="ai-hint-main">用要点写</span>
              <span className="ai-hint-sub">写几句要点，AI 写成完整邮件</span>
              <kbd className="cmp-kbd">⌘J</kbd>
            </button>
          ) : (
            <div className="ai-hint ai-hint-off">
              <AiUnavailable reason={aiStatus.reason} compact />
            </div>
          )
        )}
        <EditorContent editor={editor} className="cmp-editor" />

        {/* 签名 */}
        <div className="cmp-sig">
          <div className="cmp-sig-head">
            <span className="cmp-sig-label">签名</span>
            <select
              value={sigId ?? ''}
              onChange={e => pickSignature(e.target.value)}
              className="cmp-select cmp-select-sm"
              aria-label="选择签名"
            >
              <option value="">{sigId === null && sigEditor && !sigEditor.isEmpty ? '自定义' : '无签名'}</option>
              {(signatures ?? []).map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <EditorContent editor={sigEditor} />
        </div>

        {quote && (
          <div className="cmp-quote">
            <div className="cmp-quote-head">
              {isForward ? '转发' : '引用'}：{displayName(quote.from)} · {fmtSimple(quote.date)}
            </div>
            <QuoteBlock quote={quote} />
          </div>
        )}
      </div>

      {attachments.length > 0 && (
        <AttachmentChips items={attachments} onRemove={i => setAttachments(prev => prev.filter((_, j) => j !== i))} limit={ATTACH_WARN_BYTES} />
      )}
      {error && <div className="cmp-error">{error}</div>}

      {/* 底栏 */}
      <div className="cmp-footer shrink-0">
        <button type="button" onClick={() => void pick()} className="cmp-icon-btn" title="添加附件 ⌘⇧A" aria-label="添加附件">
          <IconAttach width={15} height={15} />
        </button>
        <FollowupToggle value={followup} onChange={setFollowup} />
        <span className="cmp-status" data-state={save.state}>{saveText}</span>
        <div className="flex-1" />
        <button type="button" className="cmp-kbd-btn" onClick={() => setHelp(true)} title="快捷键 ⌘/">
          <kbd className="cmp-kbd">⌘/</kbd>
        </button>
        <button
          type="button"
          onClick={() => void saveAndClose()}
          className="cmp-btn cmp-btn-ghost"
          title="存草稿并关闭（⌘S 只保存）"
        >
          <IconSave width={14} height={14} /> 存草稿
        </button>
        <div className="flex items-stretch relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => requestSend({ kind: 'now' })}
            disabled={sending || !accountId}
            className="btn-liquid cmp-send"
            title="发送 ⌘↩"
          >
            <IconSend width={14} height={14} />
            {sending ? '发送中…' : '发送'}
          </button>
          <button
            type="button"
            onClick={() => setSendMenu(m => !m)}
            disabled={!accountId}
            title="延迟 / 定时发送"
            aria-label="延迟 / 定时发送"
            className="btn-liquid cmp-send-more"
          >
            ▾
          </button>
          {sendMenu && (
            <div className="cmp-pop cmp-send-menu pop-in">
              <div className="cmp-menu-caption">延迟 / 定时发送</div>
              <MenuRow label="30 秒后发送" hint="可撤销" onClick={() => schedule(30_000, '30 秒后发送')} />
              <MenuRow label="1 分钟后发送" hint="可撤销" onClick={() => schedule(60_000, '1 分钟后发送')} />
              <MenuRow label="10 分钟后发送" onClick={() => schedule(600_000, '10 分钟后发送')} />
              <MenuRow label="1 小时后发送" onClick={() => schedule(3_600_000, '1 小时后发送')} />
              <div className="cmp-menu-sub">定时发送（到点自动发出）</div>
              <div className="flex gap-1.5 px-2 pb-1">
                <input
                  type="datetime-local"
                  value={schedTime}
                  onChange={e => setSchedTime(e.target.value)}
                  className="cmp-datetime flex-1"
                />
                <button type="button" onClick={() => schedule()} disabled={!schedTime} className="cmp-btn cmp-btn-primary cmp-btn-sm">
                  确定
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {dragging && (
        <div className="cmp-drop" aria-hidden>
          <div className="cmp-drop-card">
            <IconAttach width={20} height={20} />
            <span>松手添加为附件</span>
          </div>
        </div>
      )}
      {toast && <Toast text={toast.text} action={toast.action} onClose={() => setToast(null)} />}
      {check && (
        <SendCheckDialog
          issues={check.issues}
          scheduleLabel={check.mode.kind === 'schedule' ? check.mode.label : undefined}
          onBack={() => {
            const first = check.issues[0]?.key
            setCheck(null)
            requestAnimationFrame(() => {
              if (first === 'no-recipient' || first === 'bad-address') toRef.current?.focus()
              else if (first === 'no-subject') subjectRef.current?.focus()
              else editor?.commands.focus()
            })
          }}
          onSendAnyway={() => {
            const mode = check.mode
            setCheck(null)
            void doSend(mode)
          }}
          fixes={{
            'missing-attachment': {
              label: '添加附件',
              run: () => {
                setCheck(null)
                void pick()
              }
            },
            'no-subject': aiStatus.ready && !bodyEmpty
              ? {
                  label: 'AI 起主题',
                  run: () => {
                    setCheck(null)
                    startSubject()
                  }
                }
              : undefined,
            'self-in-reply': {
              label: '移除自己',
              run: () => {
                const mine = new Set(myAddrs.map(a => a.toLowerCase()))
                const keep = (l: Address[]) => l.filter(a => !mine.has(a.address.toLowerCase()))
                setTo(keep)
                setCc(keep)
                setBcc(keep)
                setCheck(c => (c ? { ...c, issues: c.issues.filter(i => i.key !== 'self-in-reply') } : c))
              }
            }
          }}
        />
      )}
      {closePrompt && (
        <ClosePrompt
          onSave={() => void saveAndClose()}
          onDiscard={closeWindow}
          onCancel={() => setClosePrompt(false)}
        />
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
    </div>
  )
}

/**
 * 撰写窗编辑器快捷键：⌘⇧B 让给「显示密送」，引用块改为 ⌘⇧9（Gmail 同款；TipTap 默认键位里 ⌘⇧9 只有任务列表在用，本编辑器没装）。
 * 优先级高于 StarterKit，确保 ⌘⇧B 不会再落到引用块上。
 */
const ComposeKeys = Extension.create({
  name: 'composeKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-9': () => this.editor.commands.toggleBlockquote(),
      'Mod-Shift-b': () => true
    }
  }
})

function EditorToolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  if (!editor) return null
  const btn = (label: React.ReactNode, title: string, active: boolean, onClick: () => void, textCls = '') => (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      className={`cmp-tool ${textCls}`}
      data-active={active ? '' : undefined}
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-0.5">
      {btn('B', '粗体 ⌘B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), 'font-semibold')}
      {btn('I', '斜体 ⌘I', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), 'italic')}
      {btn('S', '删除线 ⌘⇧S', editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run(), 'line-through')}
      <span className="cmp-tool-sep" />
      {btn(<IconList width={14} height={14} />, '无序列表', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
      {btn(<IconListOrdered width={14} height={14} />, '有序列表', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
      {btn(<IconQuote width={13} height={13} />, '引用块 ⌘⇧9', editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run())}
      {btn(<IconLink width={13} height={13} />, '链接', editor.isActive('link'), () => {
        const url = window.prompt('链接地址')
        if (url) editor.chain().focus().setLink({ href: url }).run()
        else editor.chain().focus().unsetLink().run()
      })}
    </div>
  )
}

function QuoteBlock({ quote }: { quote: MessageFull }) {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.innerHTML = ''
    const source = quote.html ?? `<p style="white-space:pre-wrap">${quote.text}</p>`
    const { html } = sanitizeEmailHtml(source, { allowRemote: false, resolveCid: () => null })
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<style>:host{all:initial;display:block;font-family:var(--font-body);font-size:13px;line-height:20px;color:var(--muted)}</style><div style="border-left:2px solid var(--border);padding-left:12px">${html}</div>`
  }, [quote])
  return <div ref={hostRef} className="selectable max-h-56 overflow-y-auto" />
}

function buildFullHtml(body: string, quote: MessageFull | null, signature: string): string {
  const sig = signature ? `<div style="margin-top:16px">${signature}</div>` : ''
  const quoteHtml = quote
    // 外发邮件正文：收件方客户端不识别 CSS 变量，此处必须使用字面色（token 规则豁免）
    ? `<div style="margin-top:20px;padding-top:12px;border-top:1px solid #eee;color:#555;font-size:13px">
        <p>在 ${new Date(quote.date).toLocaleString('zh-CN')}，${escapeAttr(displayName(quote.from))} 写道：</p>
        <blockquote style="border-left:3px solid #ddd;padding-left:12px;margin-left:0">${
          quote.html ?? `<p style="white-space:pre-wrap">${quote.text}</p>`
        }</blockquote>
      </div>`
    : ''
  return `<div style="font-family:-apple-system,'PingFang SC',sans-serif;font-size:14px;line-height:1.65">${body}${sig}${quoteHtml}</div>`
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

function fmtSimple(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 45) return '刚刚'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟前`
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
