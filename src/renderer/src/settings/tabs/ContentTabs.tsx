import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { IconPlus, IconMinus } from '../../components/icons'
import { SectionTitle } from './GeneralTab'
import type { MailTemplate, Signature } from '@shared/types'

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
    <div className="rounded-xl border border-black/[0.08] bg-white overflow-hidden">
      <Toolbar target={ref} />
      <div
        ref={ref}
        contentEditable
        onInput={() => props.onChange(ref.current?.innerHTML ?? '')}
        className="px-3.5 py-3 text-[13.5px] leading-relaxed outline-none selectable overflow-y-auto"
        style={{ minHeight: props.minHeight ?? 160 }}
        data-placeholder="输入内容…"
      />
    </div>
  )
}

function Toolbar(props: { target: React.RefObject<HTMLDivElement | null> }) {
  const exec = (cmd: string, value?: string) => {
    props.target.current?.focus()
    document.execCommand(cmd, false, value)
  }
  const btn = (label: string, cmd: string, value?: string, style?: string) => (
    <button
      type="button"
      onMouseDown={e => e.preventDefault()}
      onClick={() => exec(cmd, value)}
      className={`w-7 h-7 rounded-md text-[13px] text-zinc-600 hover:bg-black/5 ${style ?? ''}`}
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-black/[0.06] bg-zinc-50/60">
      {btn('B', 'bold', undefined, 'font-bold')}
      {btn('I', 'italic', undefined, 'italic')}
      {btn('U', 'underline', undefined, 'underline')}
      {btn('S', 'strikeThrough')}
      <div className="w-px h-4 bg-black/10 mx-1" />
      {btn('•', 'insertUnorderedList')}
      {btn('1.', 'insertOrderedList')}
      <div className="w-px h-4 bg-black/10 mx-1" />
      {btn('🔗', 'createLink', window.prompt('链接地址') ?? undefined)}
      {btn('✕', 'unlink')}
      <div className="flex-1" />
      {btn('HTML', 'formatBlock', 'pre', 'font-mono text-[11px]')}
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
        <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm flex-1 overflow-y-auto">
          {sigs.map(s => (
            <button
              key={s.id}
              onClick={() => setCurrent(s)}
              className={`w-full px-3.5 py-3 text-left text-[13px] border-b border-black/[0.04] last:border-0 ${
                current?.id === s.id ? 'bg-blue-600 text-white font-medium' : 'hover:bg-black/[0.03]'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex gap-1">
          <button onClick={add} className="p-2 rounded-lg text-zinc-500 hover:bg-black/5"><IconPlus width={16} height={16} /></button>
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
              className="w-full text-[15px] font-semibold outline-none bg-transparent"
            />
            <HtmlEditor html={current.html} onChange={html => setCurrent({ ...current, html })} minHeight={140} />
            <div>
              <SectionTitle>作为默认签名</SectionTitle>
              <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm px-4 py-1">
                <label className="flex items-center gap-3 py-2.5 border-b border-black/[0.04]">
                  <Check checked={current.defaults.includes('all')} onChange={v => setCurrent({ ...current, defaults: v ? ['all'] : [] })} />
                  <span className="text-[13.5px]">所有账户</span>
                </label>
                {accounts.map(a => (
                  <label key={a.id} className="flex items-center gap-3 py-2.5 border-b border-black/[0.04] last:border-0">
                    <Check
                      checked={!current.defaults.includes('all') && current.defaults.includes(a.id)}
                      onChange={v =>
                        setCurrent({
                          ...current,
                          defaults: v ? [...current.defaults.filter(d => d !== 'all'), a.id] : current.defaults.filter(d => d !== a.id)
                        })
                      }
                    />
                    <span className="text-[13.5px]">{a.name}</span>
                  </label>
                ))}
                {!accounts.length && <div className="py-2.5 text-[13px] text-zinc-400">暂无账户</div>}
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => save(current)}
                className="text-[13px] font-medium px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700"
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

// ================= 模板 =================

export function TemplatesTab() {
  const [templates, setTemplates] = useState<MailTemplate[]>([])
  const [current, setCurrent] = useState<MailTemplate | null>(null)

  const reload = async () => {
    const t = await api.listTemplates()
    setTemplates(t)
  }
  useEffect(() => void reload(), [])

  return (
    <div className="flex gap-5 h-full">
      <div className="w-[210px] shrink-0 flex flex-col">
        <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm flex-1 overflow-y-auto">
          {templates.map(t => (
            <button
              key={t.id}
              onClick={() => setCurrent(t)}
              className={`w-full px-3.5 py-3 text-left text-[13px] border-b border-black/[0.04] last:border-0 ${
                current?.id === t.id ? 'bg-blue-600 text-white font-medium' : 'hover:bg-black/[0.03]'
              }`}
            >
              <span className="block truncate">{t.name}</span>
              {t.subject && <span className={`block text-[11.5px] truncate ${current?.id === t.id ? 'text-white/70' : 'text-zinc-400'}`}>{t.subject}</span>}
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex gap-1">
          <button
            onClick={async () => {
              const t: MailTemplate = { id: `tpl-${Date.now()}`, name: '新模板', to: '', subject: '', html: '<p>Hi,</p>', updatedAt: Date.now() }
              await api.saveTemplate(t)
              await reload()
              setCurrent(t)
            }}
            className="p-2 rounded-lg text-zinc-500 hover:bg-black/5"
          >
            <IconPlus width={16} height={16} />
          </button>
          <button
            onClick={async () => {
              if (current) {
                await api.deleteTemplate(current.id)
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
              className="w-full text-[15px] font-semibold outline-none bg-transparent"
              placeholder="模板名称"
            />
            <input
              value={current.to}
              onChange={e => setCurrent({ ...current, to: e.target.value })}
              className="w-full text-[13px] rounded-xl bg-white border border-black/[0.08] px-3.5 py-2.5 outline-none"
              placeholder="收件人（可选）"
            />
            <input
              value={current.subject}
              onChange={e => setCurrent({ ...current, subject: e.target.value })}
              className="w-full text-[13px] rounded-xl bg-white border border-black/[0.08] px-3.5 py-2.5 outline-none"
              placeholder="主题"
            />
            <HtmlEditor html={current.html} onChange={html => setCurrent({ ...current, html })} minHeight={200} />
            <div className="flex justify-end">
              <button
                onClick={async () => {
                  await api.saveTemplate({ ...current, updatedAt: Date.now() })
                  await reload()
                }}
                className="text-[13px] font-medium px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700"
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <Empty text="模板用于快速插入常用邮件内容（写在撰写窗口右上角）" />
        )}
      </div>
    </div>
  )
}

function Empty(props: { text: string }) {
  return <div className="text-[13.5px] text-zinc-400 mt-16 text-center">{props.text}</div>
}

function Check(props: { checked: boolean; onChange(v: boolean): void }) {
  return (
    <button
      onClick={() => props.onChange(!props.checked)}
      className={`w-[16px] h-[16px] rounded-[5px] border flex items-center justify-center transition ${
        props.checked ? 'bg-blue-600 border-blue-600' : 'border-zinc-300 bg-white'
      }`}
    >
      {props.checked && (
        <svg viewBox="0 0 24 24" className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3.5}>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </button>
  )
}
