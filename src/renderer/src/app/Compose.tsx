import { useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import Image from '@tiptap/extension-image'
import { api, useAsync, displayName } from '../lib/api'
import { parseComposePrefill } from '../preload/parse'
import { sanitizeEmailHtml } from '../lib/sanitize'
import { IconSend, IconAttach, IconClose, IconSave, IconLink, IconQuote, IconList, IconListOrdered } from '../components/icons'
import type { Address, MailTemplate, MessageFull } from '@shared/types'

export function ComposeWindow({ prefill }: { prefill?: Partial<import('@shared/types').ComposeDraft> }) {
  const { data: accounts } = useAsync(() => api.listAccounts(), [])
  const { data: templates } = useAsync(() => api.listTemplates(), [])
  const [accountId, setAccountId] = useState(prefill?.accountId ?? '')
  const [to, setTo] = useState(prefill?.to?.map(displayAddress).join(', ') ?? '')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState(prefill?.subject ?? '')
  const [attachments, setAttachments] = useState<{ path: string; name: string; size: number }[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [quote, setQuote] = useState<MessageFull | null>(null)
  const [signature, setSignature] = useState('')
  const editorRef = useRef<{ getHTML(): string } | null>(null)

  const draftId = useMemo(() => `draft-${Date.now()}`, [])

  useEffect(() => {
    if (!accountId && accounts?.length) setAccountId(accounts[0].id)
  }, [accounts, accountId])

  // 回复/转发引用
  useEffect(() => {
    const related = prefill?.relatedMessageId
    if (!related) return
    void api.getMessage(related).then(setQuote)
  }, [prefill?.relatedMessageId])

  // 默认签名
  useEffect(() => {
    if (!accountId) return
    void (async () => {
      const sigs = await api.listSignatures()
      const acc = accounts?.find(a => a.id === accountId)
      const chosen =
        (acc?.signatureId ? sigs.find(s => s.id === acc.signatureId) : undefined) ??
        sigs.find(s => s.defaults.includes('all') || s.defaults.includes(accountId))
      if (chosen) setSignature(chosen.html)
    })()
  }, [accountId, accounts])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false }),
      Image,
      Placeholder.configure({ placeholder: '正文…' })
    ],
    content: prefill?.html ?? '',
    editorProps: { attributes: { class: 'compose-editor' } },
    onUpdate: ({ editor }) => {
      editorRef.current = editor as unknown as { getHTML(): string }
    },
    onCreate: ({ editor }) => {
      editorRef.current = editor as unknown as { getHTML(): string }
    }
  })

  // AI 起草内容注入（openCompose 后收到的事件）
  useEffect(() => {
    if (prefill?.html && editor) editor.commands.setContent(prefill.html)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  const insertSignature = () => {
    if (!editor || !signature) return
    editor.commands.focus('end')
    editor.commands.insertContent(`<div>${signature}</div>`)
  }

  const insertTemplate = (t: MailTemplate) => {
    if (!editor) return
    if (t.subject && !subject) setSubject(t.subject)
    editor.commands.insertContent(t.html)
  }

  const parseAddrs = (s: string): Address[] =>
    s
      .split(/[,，;；\s]+/)
      .map(x => x.trim())
      .filter(Boolean)
      .map(address => ({ address }))

  const buildDraft = (html: string) => ({
    id: draftId,
    accountId,
    to: parseAddrs(to),
    cc: parseAddrs(cc),
    bcc: parseAddrs(bcc),
    subject,
    html,
    inReplyToMessageId: prefill?.inReplyToMessageId,
    relatedMessageId: prefill?.relatedMessageId,
    attachmentPaths: attachments.map(a => a.path)
  })

  const send = async () => {
    if (!editor || sending) return
    const html = buildFullHtml(editor.getHTML(), quote, signature)
    setSending(true)
    setError('')
    const result = await api.sendMail(buildDraft(html))
    setSending(false)
    if (result.ok) {
      if (prefill?.relatedMessageId) void api.markAnswered(prefill.relatedMessageId)
      window.close()
    } else {
      setError(result.error ?? '发送失败')
    }
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

  const schedule = async (delayMs?: number) => {
    if (!editor) return
    let at = Date.now() + (delayMs ?? 0)
    if (delayMs === undefined) {
      if (!schedTime) return
      at = Date.parse(schedTime)
    }
    const html = buildFullHtml(editor.getHTML(), quote, signature)
    const res = await api.scheduleSend(buildDraft(html), at)
    setSendMenu(false)
    if (res.ok) {
      window.close()
    } else {
      setError(res.error ?? '定时失败')
    }
  }

  const MenuRow = (props: { label: string; hint?: string; onClick(): void }) => (
    <button
      onClick={props.onClick}
      className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] text-left hover:bg-[var(--hover)]"
      style={{ color: 'var(--fg)' }}
    >
      <span className="flex-1">{props.label}</span>
      {props.hint && <span className="text-[11px]" style={{ color: 'var(--faint)' }}>{props.hint}</span>}
    </button>
  )

  const saveDraft = async () => {
    if (!editor) return
    await api.saveDraft({
      id: draftId,
      accountId,
      to: parseAddrs(to),
      cc: parseAddrs(cc),
      bcc: parseAddrs(bcc),
      subject,
      html: editor.getHTML(),
      attachmentPaths: []
    })
    window.close()
  }

  const pick = async () => {
    const files = await api.pickFiles()
    setAttachments(prev => [...prev, ...files])
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="drag-region h-[44px] shrink-0 flex items-center pl-5">
        <span className="text-[13px] font-medium text-zinc-400">
          {prefill?.relatedMessageId ? '回复' : '新邮件'}
        </span>
      </div>

      {/* 账户选择 */}
      <div className="shrink-0 px-5 py-2 border-b border-black/[0.05] flex items-center gap-2">
        <span className="text-[12px] text-zinc-400 shrink-0">发件账户</span>
        <select
          value={accountId}
          onChange={e => setAccountId(e.target.value)}
          className="no-drag text-[13px] bg-zinc-50 rounded-lg px-2 py-1.5 outline-none border border-black/[0.05]"
        >
          {(accounts ?? []).map(a => (
            <option key={a.id} value={a.id}>
              {a.name} &lt;{a.email}&gt;
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <button onClick={insertSignature} className="text-[12px] px-2 py-1 rounded-lg text-zinc-500 hover:bg-black/5">
          插入签名
        </button>
      </div>

      {/* 收件人 */}
      <div className="shrink-0 px-5 py-2 border-b border-black/[0.05] space-y-1.5">
        <AddrRow label="收件人" value={to} onChange={setTo} onMore={() => setShowCc(true)} required />
        {showCc && <AddrRow label="抄送" value={cc} onChange={setCc} />}
        {showCc && <AddrRow label="密送" value={bcc} onChange={setBcc} />}
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-zinc-400 w-14 shrink-0">主题</span>
          <input
            value={subject}
            onChange={e => setSubject(e.target.value)}
            placeholder="主题"
            className="flex-1 text-[14px] font-medium outline-none"
          />
          {(templates?.length ?? 0) > 0 && (
            <select
              onChange={e => {
                const t = templates!.find(x => x.id === e.target.value)
                if (t) insertTemplate(t)
                e.target.value = ''
              }}
              defaultValue=""
              className="text-[12px] text-zinc-500 bg-zinc-50 rounded-lg px-2 py-1 outline-none border border-black/[0.05]"
            >
              <option value="">插入模板…</option>
              {templates!.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* 编辑器 */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <EditorToolbar editor={editor} />
        <EditorContent editor={editor} className="mt-2" />
        {quote && (
          <div className="mt-6 border-t border-black/[0.06] pt-3">
            <div className="text-[12px] text-zinc-400 mb-2">
              {prefill?.subject?.startsWith('转发') ? '转发' : '引用'}：{displayName(quote.from)} · {fmtSimple(quote.date)}
            </div>
            <QuoteBlock quote={quote} />
          </div>
        )}
      </div>

      {/* 附件 / 错误 / 发送 */}
      {attachments.length > 0 && (
        <div className="shrink-0 px-5 py-2 flex flex-wrap gap-2 border-t border-black/[0.05]">
          {attachments.map((a, i) => (
            <span key={i} className="flex items-center gap-1.5 text-[12px] bg-zinc-100 rounded-lg px-2.5 py-1">
              <IconAttach width={12} height={12} className="text-zinc-400" />
              {a.name}
              <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} className="text-zinc-400 hover:text-zinc-600">
                <IconClose width={11} height={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <div className="shrink-0 px-5 py-1.5 text-[12.5px] text-red-500">{error}</div>}
      <div className="shrink-0 px-5 py-3 border-t border-black/[0.05] flex items-center gap-2 relative">
        <button onClick={pick} className="p-2 rounded-lg text-zinc-500 hover:bg-black/5" title="添加附件">
          <IconAttach width={15} height={15} />
        </button>
        <div className="flex-1" />
        <button onClick={saveDraft} className="text-[13px] px-3 py-2 rounded-xl text-zinc-500 hover:bg-black/5 flex items-center gap-1.5">
          <IconSave width={14} height={14} /> 存草稿
        </button>
        <div className="flex items-stretch" ref={menuRef}>
          <button
            onClick={send}
            disabled={sending || !accountId}
            className="btn-liquid flex items-center gap-1.5 text-[13px] font-medium px-4 py-2 rounded-l-xl disabled:opacity-40"
          >
            <IconSend width={14} height={14} />
            {sending ? '发送中…' : '发送'}
          </button>
          <button
            onClick={() => setSendMenu(m => !m)}
            disabled={!accountId}
            title="延迟 / 定时发送"
            className="btn-liquid px-2 rounded-r-xl border-l border-white/25 disabled:opacity-40 text-[10px]"
            style={{ borderRadius: '0 12px 12px 0' }}
          >
            ▾
          </button>
          {sendMenu && (
            <div className="absolute bottom-14 right-5 z-30 w-[290px] liquid-glass rounded-[var(--r-md)] p-1.5 pop-in">
              <div className="px-2 pt-1 pb-1.5 text-[10.5px] font-semibold tracking-[.08em] uppercase" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                延迟 / 定时发送
              </div>
              <MenuRow label="30 秒后发送" hint="可撤销" onClick={() => void schedule(30_000)} />
              <MenuRow label="1 分钟后发送" hint="可撤销" onClick={() => void schedule(60_000)} />
              <MenuRow label="10 分钟后发送" onClick={() => void schedule(600_000)} />
              <MenuRow label="1 小时后发送" onClick={() => void schedule(3_600_000)} />
              <div className="px-3 pt-2 pb-1 text-[11.5px]" style={{ color: 'var(--muted)' }}>定时发送（到点自动发出）</div>
              <div className="px-2 pb-1 flex gap-1.5">
                <input
                  type="datetime-local"
                  value={schedTime}
                  onChange={e => setSchedTime(e.target.value)}
                  className="flex-1 text-[12px] rounded-lg px-2 py-1.5 outline-none border border-[var(--border-soft)]"
                  style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
                />
                <button
                  onClick={() => void schedule()}
                  disabled={!schedTime}
                  className="text-[12px] px-2.5 py-1.5 rounded-lg font-medium disabled:opacity-40"
                  style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                >
                  确定
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function AddrRow(props: { label: string; value: string; onChange(v: string): void; onMore?(): void; required?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-zinc-400 w-14 shrink-0">{props.label}</span>
      <input
        value={props.value}
        onChange={e => props.onChange(e.target.value)}
        className="flex-1 text-[13.5px] outline-none selectable"
        placeholder="多个地址用逗号分隔"
      />
      {props.onMore && !props.value.includes('@') === false && null}
      {props.onMore && (
        <button onClick={props.onMore} className="text-[12px] text-zinc-400 hover:text-zinc-600 shrink-0">
          抄送/密送
        </button>
      )}
    </div>
  )
}

function EditorToolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  if (!editor) return null
  const btn = (label: React.ReactNode, active: boolean, onClick: () => void, textCls = 'text-[13px]') => (
    <button
      type="button"
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      className={`w-7 h-7 rounded-md inline-flex items-center justify-center ${textCls} ${active ? 'bg-blue-600/10 text-blue-600' : 'text-zinc-500 hover:bg-black/5'}`}
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-0.5 pb-1.5 border-b border-black/[0.05]">
      {btn('B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), 'text-[13px] font-semibold')}
      {btn('I', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), 'text-[13px] italic')}
      {btn('S', editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run(), 'text-[13px] line-through')}
      {btn(<IconList width={14} height={14} />, editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), '')}
      {btn(<IconListOrdered width={14} height={14} />, editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), '')}
      {btn(<IconQuote width={13} height={13} />, editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), '')}
      {btn(<IconLink width={13} height={13} />, editor.isActive('link'), () => {
        const url = window.prompt('链接地址')
        if (url) editor.chain().focus().setLink({ href: url }).run()
        else editor.chain().focus().unsetLink().run()
      }, '')}
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
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<style>:host{all:initial;display:block;font-size:13px;line-height:1.6;color:#52525b}</style><div style="border-left:3px solid #e4e4e7;padding-left:12px">${html}</div>`
  }, [quote])
  return <div ref={hostRef} className="selectable max-h-56 overflow-y-auto" />
}

function buildFullHtml(body: string, quote: MessageFull | null, signature: string): string {
  const sig = signature ? `<div style="margin-top:16px">${signature}</div>` : ''
  const quoteHtml = quote
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

function displayAddress(a: Address): string {
  return a.name ? `${a.name} <${a.address}>` : a.address
}

function fmtSimple(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
