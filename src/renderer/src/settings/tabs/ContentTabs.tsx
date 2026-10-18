import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { IconPlus, IconMinus, IconLink, IconClose, IconList, IconListOrdered } from '../../components/icons'
import { SectionTitle } from './GeneralTab'
import type { Signature } from '@shared/types'

/** 富文本简易编辑器（contentEditable + 执行命令） */
export function HtmlEditor(props: { html: string; onChange(html: string): void; minHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== props.html) {
      ref.current.innerHTML = props.html
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="rounded-xl border border-ink/[0.08] bg-white overflow-hidden">
      <Toolbar target={ref} />
      <div
        ref={ref}
        contentEditable
        onInput={() => props.onChange(ref.current?.innerHTML ?? '')}
        className="px-3.5 py-3 text-sm leading-relaxed outline-none selectable overflow-y-auto"
        style={{ minHeight: props.minHeight ?? 160 }}
        data-placeholder="输入内容…"
      />
    </div>
  )
}

function Toolbar(props: { target: React.RefObject<HTMLDivElement | null> }) {
  // 插入链接：Electron 不支持 window.prompt（渲染时调用会直接抛错白屏），改为工具栏内联输入框
  const [linkUrl, setLinkUrl] = useState<string | null>(null)
  const savedRange = useRef<Range | null>(null)
  const exec = (cmd: string, value?: string) => {
    props.target.current?.focus()
    document.execCommand(cmd, false, value)
  }
  const openLink = () => {
    const sel = window.getSelection()
    savedRange.current = sel && sel.rangeCount && props.target.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null
    setLinkUrl('https://')
  }
  const applyLink = () => {
    const url = linkUrl?.trim()
    setLinkUrl(null)
    if (!url || url === 'https://') return
    props.target.current?.focus()
    const sel = window.getSelection()
    if (savedRange.current && sel) {
      sel.removeAllRanges()
      sel.addRange(savedRange.current)
    }
    // 未选中文字时直接插入链接文本
    if (!sel || sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${url.replace(/"/g, '&quot;')}">${url.replace(/</g, '&lt;')}</a>`)
    else document.execCommand('createLink', false, url)
  }
  if (linkUrl !== null) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-ink/[0.06] bg-zinc-50/60">
        <IconLink width={13} height={13} className="text-zinc-500 shrink-0" />
        <input
          autoFocus
          value={linkUrl}
          onChange={e => setLinkUrl(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') applyLink()
            else if (e.key === 'Escape') setLinkUrl(null)
          }}
          placeholder="链接地址，回车确认"
          className="flex-1 min-w-0 text-xs font-mono bg-white rounded-md px-2 py-1 outline-none border border-ink/[0.08]"
        />
        <button type="button" onClick={applyLink} className="text-xs px-2 py-1 rounded-md bg-blue-600 text-on-accent">
          插入
        </button>
        <button type="button" onClick={() => setLinkUrl(null)} className="text-xs px-2 py-1 rounded-md text-zinc-500 hover:bg-ink/5">
          取消
        </button>
      </div>
    )
  }
  const btn = (label: React.ReactNode, cmd: string, value?: string, style?: string) => (
    <button
      type="button"
      onMouseDown={e => e.preventDefault()}
      onClick={() => exec(cmd, value)}
      className={`w-7 h-7 rounded-md text-sm text-zinc-600 hover:bg-ink/5 inline-flex items-center justify-center ${style ?? ''}`}
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-ink/[0.06] bg-zinc-50/60">
      {btn('B', 'bold', undefined, 'font-semibold')}
      {btn('I', 'italic', undefined, 'italic')}
      {btn('U', 'underline', undefined, 'underline')}
      {btn('S', 'strikeThrough', undefined, 'line-through')}
      <div className="w-px h-4 bg-ink/10 mx-1" />
      {btn(<IconList width={14} height={14} />, 'insertUnorderedList')}
      {btn(<IconListOrdered width={14} height={14} />, 'insertOrderedList')}
      <div className="w-px h-4 bg-ink/10 mx-1" />
      <button
        type="button"
        title="插入链接"
        onMouseDown={e => e.preventDefault()}
        onClick={openLink}
        className="w-7 h-7 rounded-md text-sm text-zinc-600 hover:bg-ink/5 inline-flex items-center justify-center"
      >
        <IconLink width={13} height={13} />
      </button>
      {btn(<IconClose width={13} height={13} />, 'unlink')}
      <div className="flex-1" />
      {btn('HTML', 'formatBlock', 'pre', 'font-mono text-2xs')}
    </div>
  )
}

// ================= 签名 =================

export function SignaturesTab() {
  const [sigs, setSigs] = useState<Signature[]>([])
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([])
  const [current, setCurrent] = useState<Signature | null>(null)

  const reload = async () => {
    const [s, as] = await Promise.all([api.listSignatures(), api.listAccounts()])
    setSigs(s)
    setAccounts(as.map(a => ({ id: a.id, name: a.name })))
  }
  useEffect(() => void reload(), [])

  const save = async (s: Signature) => {
    await api.saveSignature({ ...s, updatedAt: Date.now() })
    await reload()
  }

  const add = async () => {
    const s: Signature = { id: `sig-${Date.now()}`, name: '新签名', html: '<p>此致敬礼</p>', defaults: [], updatedAt: Date.now() }
    await api.saveSignature(s)
    await reload()
    setCurrent(s)
  }

  return (
    <div className="flex gap-5 h-full">
      <div className="w-[210px] shrink-0 flex flex-col">
        <div className="rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] flex-1 overflow-y-auto">
          {sigs.map(s => (
            <button
              key={s.id}
              onClick={() => setCurrent(s)}
              className={`w-full px-3.5 py-3 text-left text-sm border-b border-ink/[0.04] last:border-0 ${
                current?.id === s.id ? 'bg-selected text-accent-ink font-medium' : 'hover:bg-ink/[0.03]'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex gap-1">
          <button onClick={add} className="p-2 rounded-lg text-zinc-500 hover:bg-ink/5"><IconPlus width={16} height={16} /></button>
          <button
            onClick={async () => {
              if (current) {
                await api.deleteSignature(current.id)
                setCurrent(null)
                await reload()
              }
            }}
            className="p-2 rounded-lg text-zinc-500 hover:bg-red-50 hover:text-red-500"
          >
            <IconMinus width={16} height={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-w-0">
        {current ? (
          <div className="max-w-[560px] space-y-3">
            <input
              value={current.name}
              onChange={e => setCurrent({ ...current, name: e.target.value })}
              className="w-full text-md font-semibold outline-none bg-transparent"
            />
            <HtmlEditor html={current.html} onChange={html => setCurrent({ ...current, html })} minHeight={140} />
            <div>
              <SectionTitle>作为默认签名</SectionTitle>
              <div className="rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] px-4 py-1">
                <label className="flex items-center gap-3 py-2.5 border-b border-ink/[0.04]">
                  <Check checked={current.defaults.includes('all')} onChange={v => setCurrent({ ...current, defaults: v ? ['all'] : [] })} />
                  <span className="text-sm">所有账户</span>
                </label>
                {accounts.map(a => (
                  <label key={a.id} className="flex items-center gap-3 py-2.5 border-b border-ink/[0.04] last:border-0">
                    <Check
                      checked={!current.defaults.includes('all') && current.defaults.includes(a.id)}
                      onChange={v =>
                        setCurrent({
                          ...current,
                          defaults: v ? [...current.defaults.filter(d => d !== 'all'), a.id] : current.defaults.filter(d => d !== a.id)
                        })
                      }
                    />
                    <span className="text-sm">{a.name}</span>
                  </label>
                ))}
                {!accounts.length && <div className="py-2.5 text-sm text-zinc-400">暂无账户</div>}
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => save(current)}
                className="text-sm font-medium px-4 py-2 rounded-xl bg-blue-600 text-on-accent hover:bg-blue-700"
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <Empty text="创建签名后，撰写邮件时可一键插入" />
        )}
      </div>
    </div>
  )
}

// ================= 模板（实现见 TemplatesTab.tsx） =================

export { TemplatesTab } from './TemplatesTab'

function Empty(props: { text: string }) {
  return <div className="text-sm text-zinc-400 mt-16 text-center">{props.text}</div>
}

function Check(props: { checked: boolean; onChange(v: boolean): void }) {
  return (
    <button
      onClick={() => props.onChange(!props.checked)}
      className={`w-[16px] h-[16px] rounded-xs border flex items-center justify-center transition ${
        props.checked ? 'bg-blue-600 border-blue-600' : 'border-zinc-300 bg-white'
      }`}
    >
      {props.checked && (
        <svg viewBox="0 0 24 24" className="w-3 h-3 text-on-accent" fill="none" stroke="currentColor" strokeWidth={3.5}>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </button>
  )
}
