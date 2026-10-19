import { useEffect, useMemo, useRef, useState } from 'react'
import { parseChat, type TraceMaterial, type TraceParty } from '@shared/trace'
import type { RecipientSuggestion } from '@shared/ipc'
import { api } from '../../lib/api'
import { MAX_IMAGE_BYTES, readImage, readTextFile } from '../../lib/trace'
import { IconClose, IconPlus } from '../../components/icons'
import { IconImage } from './icons'

/* ================================================================
 * 留痕的输入件：原始材料（粘贴文字 / 拖入截图识字 / 导入聊天 txt）与参与人（联系人联想）
 * 捕获浮层与详情页「补充材料」共用
 * ================================================================ */

export interface Shot {
  key: string
  name: string
  url: string
  status: 'ocr' | 'done' | 'error'
  text?: string
  error?: string
  note?: string | null
  method?: string
}

/** 待保存的材料 → 新建 / 追加用的入参 */
export function draftMaterials(text: string, shots: Shot[], opts: { note?: boolean } = {}): Omit<TraceMaterial, 'id' | 'addedAt'>[] {
  const out: Omit<TraceMaterial, 'id' | 'addedAt'>[] = []
  const t = text.trim()
  if (t) out.push({ kind: parseChat(t).lines.length >= 2 ? 'chat' : opts.note ? 'note' : 'text', text: t })
  for (const s of shots) if (s.status === 'done' && s.text?.trim()) out.push({ kind: 'ocr', text: s.text.trim(), fileName: s.name, ocrMethod: s.method ?? null })
  return out
}

const OCR_METHOD_LABEL: Record<string, string> = { 'ocr-local': '本机识字', 'ocr-ai': 'AI 识字', 'ocr-local+ai': '本机识字 + AI 校对' }

export function MaterialComposer(props: {
  text: string
  onText(v: string): void
  shots: Shot[]
  onShots(update: (prev: Shot[]) => Shot[]): void
  autoFocus?: boolean
  rows?: number
  placeholder?: string
}) {
  const [drag, setDrag] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const parsed = useMemo(() => parseChat(props.text), [props.text])

  const addImage = async (file: File) => {
    if (file.size > MAX_IMAGE_BYTES) {
      window.dispatchEvent(new CustomEvent('ms:toast', { detail: `「${file.name || '截图'}」太大（超过 20 MB）` }))
      return
    }
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const url = await readImage(file)
    const name = file.name && file.name !== 'image.png' ? file.name : `截图 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}.png`
    props.onShots(prev => [...prev, { key, name, url, status: 'ocr' }])
    try {
      const res = await api.traceOcrImage({ dataUrl: url, name })
      props.onShots(prev => prev.map(s => (s.key === key ? (res.ok ? { ...s, status: 'done', text: res.text, note: res.note, method: res.method } : { ...s, status: 'error', error: res.error ?? '识字失败' }) : s)))
    } catch (err) {
      props.onShots(prev => prev.map(s => (s.key === key ? { ...s, status: 'error', error: err instanceof Error ? err.message : String(err) } : s)))
    }
  }

  const addFiles = async (files: File[]) => {
    for (const f of files) {
      if (/^image\//.test(f.type)) await addImage(f)
      else if (/^text\//.test(f.type) || /\.(txt|csv|log|md)$/i.test(f.name)) {
        const t = (await readTextFile(f)).slice(0, 60_000)
        props.onText(props.text ? `${props.text}\n\n${t}` : t)
      }
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = [...e.clipboardData.files].filter(f => /^image\//.test(f.type))
    if (!imgs.length) return
    e.preventDefault()
    void addFiles(imgs)
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className="relative rounded-[var(--r-md)] border transition-colors"
        style={{ borderColor: drag ? 'var(--accent)' : 'var(--border)', background: 'var(--surface-strong)' }}
        onDragOver={e => {
          if ([...e.dataTransfer.items].some(i => i.kind === 'file')) {
            e.preventDefault()
            setDrag(true)
          }
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => {
          const files = [...e.dataTransfer.files]
          setDrag(false)
          if (!files.length) return
          e.preventDefault()
          void addFiles(files)
        }}
      >
        <textarea
          value={props.text}
          onChange={e => props.onText(e.target.value)}
          onPaste={onPaste}
          autoFocus={props.autoFocus}
          rows={props.rows ?? 7}
          placeholder={props.placeholder ?? '粘贴聊天记录（微信 / 企业微信 / 钉钉 / 飞书 / Slack 复制的文字都行），或者写几句：刚才电话里说定了什么、谁答应做什么、什么时候、多少钱。\n截图直接粘贴或拖进来，会在本机识字。'}
          className="w-full bg-transparent outline-none resize-y text-sm leading-relaxed px-3 py-2.5 block"
          style={{ color: 'var(--fg)', minHeight: 96 }}
        />
        <div className="flex items-center gap-2 px-2.5 pb-2 text-2xs" style={{ color: 'var(--faint)' }}>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="h-6 px-2 rounded-[var(--r-xs)] border border-dashed border-[var(--border-strong)] hover:bg-[var(--hover)] inline-flex items-center gap-1"
            style={{ color: 'var(--muted)' }}
            title="导入截图（本机识字）或导出的聊天记录 .txt"
          >
            <IconImage width={12} height={12} /> 截图 / 聊天 txt
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,.txt,.csv,.log,.md,text/plain"
            className="hidden"
            onChange={e => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              void addFiles(files)
            }}
          />
          <span className="flex-1 min-w-0 truncate">
            {parsed.lines.length >= 2
              ? `识别为聊天记录：${parsed.lines.length} 条 · ${parsed.speakers.slice(0, 4).join('、')}${parsed.speakers.length > 4 ? ' 等' : ''}（${parsed.pattern}）`
              : props.text.trim()
                ? '按普通文字 / 备注保存'
                : drag
                  ? '松开导入'
                  : ''}
          </span>
        </div>
      </div>
      {props.shots.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {props.shots.map(s => (
            <div key={s.key} className="flex items-start gap-2.5 rounded-[var(--r-sm)] border px-2 py-1.5" style={{ borderColor: 'var(--border)', background: 'var(--bg-soft)' }}>
              <img src={s.url} alt="" className="w-12 h-12 object-cover rounded-[var(--r-xs)] shrink-0 border" style={{ borderColor: 'var(--border)' }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="truncate" style={{ color: 'var(--fg)' }}>{s.name}</span>
                  <span className="shrink-0 text-2xs" style={{ color: s.status === 'error' ? 'var(--danger-ink)' : s.status === 'ocr' ? 'var(--faint)' : 'var(--ok-ink)' }}>
                    {s.status === 'ocr' ? '识字中…' : s.status === 'error' ? '没能识字' : `${OCR_METHOD_LABEL[s.method ?? ''] ?? '已识字'} · ${s.text?.length ?? 0} 字`}
                  </span>
                </div>
                <div className="text-2xs mt-0.5 leading-relaxed line-clamp-2 whitespace-pre-wrap" style={{ color: s.status === 'error' ? 'var(--danger-ink)' : 'var(--muted)' }}>
                  {s.status === 'error' ? s.error : s.status === 'done' ? s.text?.slice(0, 200) : ''}
                </div>
                {s.note && <div className="text-2xs mt-0.5" style={{ color: 'var(--warn-ink)' }}>{s.note}</div>}
              </div>
              <button type="button" onClick={() => props.onShots(prev => prev.filter(x => x.key !== s.key))} className="icon-btn w-6 h-6 inline-flex items-center justify-center shrink-0" aria-label="移除" style={{ color: 'var(--faint)' }}>
                <IconClose width={11} height={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 参与人：已选的胶囊 + 输入联想（往来过的联系人）+ 聊天里认出的发言人一键加入 */
export function PartyInput(props: { value: TraceParty[]; onChange(v: TraceParty[]): void; hints?: string[] }) {
  const [q, setQ] = useState('')
  const [sugs, setSugs] = useState<RecipientSuggestion[]>([])
  const [focus, setFocus] = useState(false)
  useEffect(() => {
    const k = q.trim()
    if (!k) return setSugs([])
    let alive = true
    const t = window.setTimeout(() => {
      void api
        .suggestRecipients(k, 6)
        .then(list => alive && setSugs(list))
        .catch(() => alive && setSugs([]))
    }, 120)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [q])
  const has = (name: string, email?: string | null) => props.value.some(p => (email && p.email?.toLowerCase() === email.toLowerCase()) || p.name === name)
  const add = (p: TraceParty) => {
    if (!p.name.trim() || has(p.name, p.email)) return
    props.onChange([...props.value, p])
    setQ('')
    setSugs([])
  }
  const commit = () => {
    const k = q.trim()
    if (!k) return
    const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(k)
    if (m) add({ name: m[1].trim() || m[2].split('@')[0], email: m[2].toLowerCase() })
    else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k)) add({ name: k.split('@')[0], email: k.toLowerCase() })
    else add({ name: k.slice(0, 40) })
  }
  const hints = (props.hints ?? []).filter(h => h && h !== '我' && !has(h))
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative flex flex-wrap items-center gap-1 min-h-8 px-1.5 py-1 rounded-[var(--r-sm)] border focus-within:border-[var(--border-strong)]" style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)' }}>
        {props.value.map((p, i) => (
          <span key={`${p.name}-${p.email ?? i}`} className="h-6 pl-2 pr-1 rounded-[var(--r-xs)] inline-flex items-center gap-1 text-xs" style={{ background: p.me ? 'var(--accent-soft)' : 'var(--hover)', color: 'var(--fg)' }} title={p.email ?? '没有邮箱：起草书面确认时需要在撰写窗里填收件人'}>
            {p.name}
            {p.me && <span className="text-2xs" style={{ color: 'var(--faint)' }}>（我）</span>}
            {p.email && <span className="text-2xs" style={{ color: 'var(--faint)' }}>{p.email}</span>}
            <button type="button" onClick={() => props.onChange(props.value.filter((_, j) => j !== i))} className="w-4 h-4 inline-flex items-center justify-center rounded hover:bg-[var(--hover-strong)]" aria-label={`移除 ${p.name}`} style={{ color: 'var(--faint)' }}>
              <IconClose width={9} height={9} />
            </button>
          </span>
        ))}
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => window.setTimeout(() => setFocus(false), 150)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
              e.preventDefault()
              if (sugs[0] && focus) add({ name: sugs[0].name || sugs[0].address.split('@')[0], email: sugs[0].address.toLowerCase() })
              else commit()
            } else if (e.key === 'Backspace' && !q && props.value.length) props.onChange(props.value.slice(0, -1))
          }}
          placeholder={props.value.length ? '' : '对方姓名或邮箱（会从联系人里联想）'}
          className="flex-1 min-w-[140px] h-6 bg-transparent outline-none text-xs px-1"
          style={{ color: 'var(--fg)' }}
        />
        {focus && sugs.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 z-20 liquid-glass rounded-[var(--r-md)] p-1 pop-in">
            {sugs.map(s => (
              <button
                key={s.address}
                type="button"
                onMouseDown={e => {
                  e.preventDefault()
                  add({ name: s.name || s.address.split('@')[0], email: s.address.toLowerCase() })
                }}
                className="w-full h-7 px-2 rounded-[var(--r-sm)] text-left text-xs flex items-center gap-2 hover:bg-[var(--hover-strong)]"
                style={{ color: 'var(--fg)' }}
              >
                <span className="truncate">{s.name || s.address}</span>
                <span className="truncate text-2xs" style={{ color: 'var(--faint)' }}>{s.address}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {hints.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-2xs" style={{ color: 'var(--faint)' }}>
          聊天里的人：
          {hints.slice(0, 8).map(h => (
            <button key={h} type="button" onClick={() => add({ name: h })} className="h-5 px-1.5 rounded-[var(--r-xs)] border border-dashed border-[var(--border-strong)] hover:bg-[var(--hover)] inline-flex items-center gap-0.5" style={{ color: 'var(--muted)' }}>
              <IconPlus width={9} height={9} />
              {h}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
