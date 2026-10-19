import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { askAgent } from '../../lib/agent-ask'
import { IconCheck, IconFileText, IconRobot, IconShield, IconSparkles } from '../../components/icons'
import type { AttachmentAccessBlock, AttachmentAccessSettings, AttachmentOcrProgress, AttachmentTextInfo, OcrAvailability, OcrEngine } from '@shared/types'
import { openContentAccess } from './ContentAccess'

/**
 * 附件正文：阅读页附件卡上的「查看文字」小按钮（悬停出现）与附件中心详情里的「正文」区块。
 * 展开正文前 N 字（可选中 / 复制）、发票抽取字段，以及「问 Agent」（带附件 id 让 Agent 调 read_attachment）。
 */

const TEXT_EXT = /\.(pdf|txt|text|csv|tsv|md|markdown|log|json|xml|ya?ml|ini|html?|xhtml|eml|ics|vcf|srt|rtf)$/i
/** Word / Excel / PowerPoint / OpenDocument（与主进程 text-parse 的 OFFICE_EXTS 一致） */
const OFFICE_EXT = /\.(docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|pptx|pptm|potx|potm|ppsx|ppsm|odt|ott|ods|ots|odp|otp|doc|dot|xls|xlt|ppt|pps)$/i
const OFFICE_CT = /^application\/(vnd\.openxmlformats-officedocument\.|vnd\.ms-(word|excel|powerpoint)|msword|vnd\.oasis\.opendocument\.(text|spreadsheet|presentation))/i
const PREVIEW_CHARS = 6000

/** 能做文字识别（OCR）的图片 */
const IMAGE_EXT = /\.(png|jpe?g|heic|heif|tiff?|webp|bmp|gif)$/i

/** 能读文字的附件（PDF / 纯文本类 / Word / Excel / PowerPoint / 可识字的图片） */
export function canReadText(filename: string, contentType?: string | null): boolean {
  const ct = (contentType || '').toLowerCase()
  return (
    TEXT_EXT.test(filename || '') ||
    OFFICE_EXT.test(filename || '') ||
    IMAGE_EXT.test(filename || '') ||
    OFFICE_CT.test(ct) ||
    ct === 'application/pdf' ||
    ct.startsWith('text/') ||
    ct === 'message/rfc822' ||
    /^image\/(png|jpe?g|heic|heif|tiff|webp|bmp|gif)$/.test(ct)
  )
}

/** Office 文件的「页」：Excel 是工作表、PowerPoint 是幻灯片、Word 是页 */
function officeKind(filename: string): 'sheet' | 'slide' | 'doc' {
  if (/\.(xls[xmt]?|xlt[xm]?|ods|ots)$/i.test(filename)) return 'sheet'
  if (/\.(pp[st][xm]?|pot[xm]|odp|otp)$/i.test(filename)) return 'slide'
  return 'doc'
}

/** 「3 页」/「3 个工作表」/「12 页幻灯片」；单页的普通文档不显示 */
function pagesLabel(info: AttachmentTextInfo, filename: string): string | null {
  if (info.method === 'office') {
    const k = officeKind(filename)
    if (k === 'sheet') return `${info.pages} 个工作表`
    if (k === 'slide') return `${info.pages} 页幻灯片`
  }
  return info.pages > 1 ? `${info.pages} 页` : null
}

function methodLabel(info: AttachmentTextInfo, filename: string): string | null {
  if (info.method === 'office') return { sheet: 'Excel 表格', slide: '演示文稿', doc: 'Word 文档' }[officeKind(filename)]
  return METHOD_LABEL[info.method] ?? null
}

type Loaded = { ok: boolean; text?: string; info?: AttachmentTextInfo; error?: string; blocked?: AttachmentAccessBlock }

const METHOD_LABEL: Record<string, string> = { pdfjs: 'PDF 文本层', plain: '纯文本', 'ocr-local': '本机识字', 'ocr-ai': 'AI 识字', 'ocr-local+ai': '本机识字 + AI 校对' }
const STAGE_LABEL: Record<AttachmentOcrProgress['stage'], string> = { local: '本机识别', render: '准备页面', ai: 'AI 识字' }

function fmtNum(n: number) {
  return n.toLocaleString('zh-CN')
}

function money(n: number, cur?: string | null) {
  const v = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return !cur || cur === 'CNY' ? `¥${v}` : `${cur} ${v}`
}

/** 正文里的分页符 → 可读的分页标记（Office 的工作表 / 幻灯片自带「## 表名 / 第 N 页」标题，只空行分隔） */
function withPageMarks(text: string, office = false): string {
  if (office) return text.replace(/\n\f\n/g, '\n\n')
  let n = 1
  return text.replace(/\n\f\n/g, () => `\n\n—— 第 ${++n} 页 ——\n\n`)
}

function askAbout(id: string, filename: string, q: string) {
  const question = q.trim() || '总结这份附件的要点（关键数字、日期、需要我做的事）'
  askAgent(`${question}\n\n（附件「${filename}」，附件 id：${id}。请先用 read_attachment 读取它的正文再回答。）`)
}

/** 正文面板主体：加载 → 状态行（授权 / 识字）→ 发票字段 → 正文 → 复制 / 问 Agent */
export function AttachmentTextBody(props: { id: string; filename: string; compact?: boolean }) {
  const [res, setRes] = useState<Loaded | null>(null)
  const [copied, setCopied] = useState(false)
  const [q, setQ] = useState('')
  const [reload, setReload] = useState(0)
  const [ocr, setOcr] = useState<{ engine: Exclude<OcrEngine, 'off'>; progress: AttachmentOcrProgress | null } | null>(null)
  const [ocrErr, setOcrErr] = useState<{ text: string; blocked?: AttachmentAccessBlock } | null>(null)
  const [status, setStatus] = useState<OcrAvailability | null>(null)
  const [access, setAccess] = useState<AttachmentAccessSettings | null>(null)
  const autoTried = useRef<string | null>(null)

  const runOcr = (engine: Exclude<OcrEngine, 'off'>) => {
    setOcr({ engine, progress: null })
    setOcrErr(null)
    api
      .ocrAttachment(props.id, engine, PREVIEW_CHARS)
      .then(r => {
        if (r.ok) setRes(r)
        else setOcrErr({ text: r.error || '文字识别失败', blocked: r.blocked })
      })
      .catch(err => setOcrErr({ text: err instanceof Error ? err.message : String(err) }))
      .finally(() => setOcr(null))
  }

  useEffect(() => {
    let alive = true
    setRes(null)
    setOcrErr(null)
    Promise.all([api.readAttachmentText(props.id, PREVIEW_CHARS) as Promise<Loaded>, api.ocrStatus().catch(() => null), api.contentAccessGet().catch(() => null)])
      .then(([r, st, a]) => {
        if (!alive) return
        setRes(r)
        setStatus(st)
        setAccess(a)
        // 扫描件 / 图片：按设置的识字方式立即识别（每个附件只自动试一次；AI 方式不可用时退到本机）
        if (r.ok && r.info?.needsOcr && a?.readContent && a.kinds.ocr && a.ocrEngine !== 'off' && st && autoTried.current !== props.id) {
          autoTried.current = props.id
          const e = a.ocrEngine
          const usable = e === 'local' ? st.local : e === 'ai' ? st.ai : st.local || st.ai
          if (usable) runOcr(e)
        }
      })
      .catch(err => alive && setRes({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.id, reload])

  // 识字进度；授权变化后重新加载
  useEffect(() => {
    const off = api.onEvent(ev => {
      const e = ev as { type?: string } & Partial<AttachmentOcrProgress>
      if (e.type === 'attachment-ocr-progress' && (e.id === props.id || e.id === res?.info?.attachmentId)) setOcr(o => (o ? { ...o, progress: e as AttachmentOcrProgress } : o))
      if (e.type === 'content-access-changed') setReload(n => n + 1)
    })
    return () => void off()
  }, [props.id, res?.info?.attachmentId])

  const info = res?.info
  const text = res?.text ?? ''
  const hasText = !!res?.ok && !!text.trim() && info?.method !== 'none'
  const inv = info?.invoice
  const isOcr = !!info?.method?.startsWith('ocr-')
  const meta = info
    ? [methodLabel(info, props.filename), pagesLabel(info, props.filename), info.chars ? `${fmtNum(info.chars)} 字` : null, info.encoding && info.encoding !== 'utf-8' && info.encoding !== 'mime' ? `编码 ${info.encoding.toUpperCase()}` : null]
        .filter(Boolean)
        .join(' · ')
    : ''
  const ocrAllowed = !!access?.readContent && !!access.kinds.ocr
  // 「用 AI 识字」：设置为本机 + AI 校对且本机可用时走校对，否则纯 AI
  const aiEngine: 'ai' | 'local+ai' = access?.ocrEngine === 'local+ai' && status?.local ? 'local+ai' : 'ai'

  const copy = () => {
    void navigator.clipboard.writeText(text.replace(/\n\f\n/g, '\n\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="flex flex-col gap-2 text-xs" style={{ color: 'var(--fg)' }}>
      {!res && (
        <div className="py-3 text-center" style={{ color: 'var(--faint)' }}>
          正在提取文字…
        </div>
      )}
      {res && !res.ok && (res.blocked ? <BlockedNote blocked={res.blocked} error={res.error} filename={props.filename} /> : (
        <div className="px-2.5 py-2 rounded-[var(--r-xs)]" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
          {res.error || '读取失败'}
        </div>
      ))}
      {res?.ok && !hasText && !ocr && (
        <div className="px-2.5 py-2 rounded-[var(--r-xs)]" style={{ background: 'var(--bg-soft)', color: 'var(--muted)' }}>
          {info?.needsOcr ? (info.error && /^图片/.test(info.error) ? '图片里的文字需要识别后才能读取' : '扫描件没有文字层，需要识别后才能读取') : `没有可读取的文字${info?.error ? `：${info.error}` : ''}`}
          {info?.needsOcr && !ocrAllowed && (
            <span className="block mt-0.5 text-2xs" style={{ color: 'var(--faint)' }}>
              {access?.readContent ? '已关闭扫描件识字，' : '还没有授权读取附件内容，'}
              <button onClick={() => openContentAccess(props.filename)} className="underline underline-offset-2" style={{ color: 'var(--accent-ink)' }}>去授权</button>
            </span>
          )}
        </div>
      )}
      {ocr && <OcrProgressBar engine={ocr.engine} progress={ocr.progress} />}
      {ocrErr && !ocr && (ocrErr.blocked ? <BlockedNote blocked={ocrErr.blocked} error={ocrErr.text} filename={props.filename} /> : (
        <div className="px-2.5 py-2 rounded-[var(--r-xs)]" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
          {ocrErr.text}
          {/不支持识图|视觉/.test(ocrErr.text) && (
            <button onClick={() => void api.openSettings('attachments')} className="block mt-0.5 text-2xs underline underline-offset-2" style={{ color: 'var(--accent-ink)' }}>去设置视觉模型</button>
          )}
        </div>
      ))}
      {res?.ok && ocrAllowed && !ocr && info?.needsOcr && status && <OcrButtons status={status} rerun={false} aiEngine={aiEngine} onRun={runOcr} />}
      {hasText && (
        <>
          {meta && <div className="text-2xs tnum" style={{ color: 'var(--faint)' }}>{meta}{info?.truncated ? ' · 只提取了前一部分' : ''}</div>}
          {info?.ocrNote && <div className="text-2xs" style={{ color: 'var(--warn-ink)' }}>{info.ocrNote}</div>}
          {inv && (inv.total != null || inv.invoiceNo) && (
            <div className="flex flex-wrap gap-1">
              {inv.invoiceNo && <Chip k="发票号" v={inv.invoiceNo} />}
              {inv.issueDate && <Chip k="开票" v={inv.issueDate} />}
              {inv.total != null && <Chip k="价税合计" v={money(inv.total, inv.currency)} />}
              {inv.seller && <Chip k="销售方" v={inv.seller} />}
              {inv.buyer && <Chip k="购买方" v={inv.buyer} />}
            </div>
          )}
          <div
            className={`${props.compact ? 'max-h-[220px]' : 'max-h-[280px]'} overflow-y-auto px-2.5 py-2 rounded-[var(--r-xs)] border whitespace-pre-wrap break-words leading-relaxed select-text`}
            style={{ background: 'var(--bg-soft)', borderColor: 'var(--border-soft)', color: 'var(--fg)' }}
            aria-label="附件正文"
            tabIndex={0}
          >
            {withPageMarks(text, info?.method === 'office')}
            {info && info.chars > text.length && (
              <span className="block mt-2 text-2xs" style={{ color: 'var(--faint)' }}>
                …… 仅显示前 {fmtNum(text.length)} 字（共 {fmtNum(info.chars)} 字）
              </span>
            )}
          </div>
          {ocrAllowed && !ocr && isOcr && status && <OcrButtons status={status} rerun aiEngine={aiEngine} onRun={runOcr} />}
        </>
      )}
      {res && (
        <div className="flex items-center gap-1.5">
          {hasText && (
            <button onClick={copy} className="h-7 px-2.5 rounded-[var(--r-sm)] border text-xs inline-flex items-center gap-1 hover:bg-[var(--hover)] shrink-0" style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}>
              {copied ? <IconCheck width={12} height={12} /> : null}
              {copied ? '已复制' : '复制'}
            </button>
          )}
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                askAbout(props.id, props.filename, q)
              }
            }}
            placeholder="问这份附件…（回车）"
            aria-label="向 Agent 提问这份附件"
            className="flex-1 min-w-0 h-7 px-2 rounded-[var(--r-sm)] border text-xs outline-none focus:border-[var(--accent)]"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)', color: 'var(--fg)' }}
          />
          <button
            onClick={() => askAbout(props.id, props.filename, q)}
            className="h-7 px-2.5 rounded-[var(--r-sm)] text-xs inline-flex items-center gap-1 shrink-0 hover:opacity-90"
            style={{ background: 'var(--ai)', color: 'var(--ai-ink)' }}
            title="以这份附件为上下文问 Agent（空着直接点 = 总结要点）"
          >
            <IconRobot width={12} height={12} /> 问 Agent
          </button>
        </div>
      )}
    </div>
  )
}

/** 被授权拦下：说明原因 + 去授权 / 去设置 */
function BlockedNote(props: { blocked: AttachmentAccessBlock; error?: string; filename: string }) {
  const consent = props.blocked === 'consent' || props.blocked === 'cloud'
  return (
    <div className="px-2.5 py-2 rounded-[var(--r-xs)] flex items-start gap-2" style={{ background: 'var(--bg-soft)', color: 'var(--muted)' }}>
      <span className="mt-[1px] shrink-0" style={{ color: 'var(--accent-ink)' }}><IconShield width={13} height={13} /></span>
      <span className="flex-1 min-w-0 leading-relaxed">
        {props.blocked === 'consent' ? '读取附件内容需要你的授权。读取在本机完成，用于查看文字、分类、发票核对和 Agent 问答。' : props.error || '这份附件的内容被设置为不读取'}
      </span>
      <button
        onClick={() => (consent ? openContentAccess(props.filename) : void api.openSettings('attachments'))}
        className="shrink-0 h-6 px-2 rounded-[var(--r-sm)] text-2xs font-medium hover:opacity-90"
        style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
      >
        {consent ? '去授权' : '去设置'}
      </button>
    </div>
  )
}

/** 识字进度：阶段 + 第几页 + 细进度条 */
function OcrProgressBar(props: { engine: Exclude<OcrEngine, 'off'>; progress: AttachmentOcrProgress | null }) {
  const p = props.progress
  const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0
  const label = p ? `${STAGE_LABEL[p.stage]}${p.total > 1 ? ` · 第 ${Math.min(p.total, p.done + (p.stage === 'ai' ? 1 : 0))} / ${p.total} 页` : ''}` : props.engine === 'local' ? '本机识别中…（首次可能要几十秒）' : '正在准备…'
  return (
    <div className="px-2.5 py-2 rounded-[var(--r-xs)]" style={{ background: 'var(--bg-soft)' }} role="status" aria-live="polite">
      <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
        <span className="spinning inline-flex" style={{ color: 'var(--accent-ink)' }}><IconSparkles width={12} height={12} /></span>
        正在识字 · {label}
      </div>
      <div className="mt-1.5 h-[3px] rounded-full overflow-hidden" style={{ background: 'var(--border-soft)' }}>
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${p ? Math.max(6, pct) : 6}%`, background: 'var(--accent)' }} />
      </div>
    </div>
  )
}

/** 「用本机识字 / 用 AI 识字」（按平台与 AI 设置可用性）；已识别过的显示为「重新识别」 */
function OcrButtons(props: { status: OcrAvailability; rerun: boolean; aiEngine: 'ai' | 'local+ai'; onRun(e: Exclude<OcrEngine, 'off'>): void }) {
  const st = props.status
  const btn = 'h-7 px-2.5 rounded-[var(--r-sm)] border text-xs inline-flex items-center gap-1 hover:bg-[var(--hover)] disabled:opacity-40 disabled:hover:bg-transparent'
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {props.rerun && <span className="text-2xs" style={{ color: 'var(--faint)' }}>重新识别：</span>}
      {st.local && (
        <button onClick={() => props.onRun('local')} className={btn} style={{ borderColor: 'var(--border)', color: 'var(--fg)' }} title={`${st.localEngine ?? '系统文字识别'}，不出本机${st.localReason ? `\n${st.localReason}` : ''}`}>
          <IconFileText width={12} height={12} /> 用本机识字
        </button>
      )}
      <button
        onClick={() => props.onRun(props.aiEngine)}
        disabled={!st.ai}
        className={btn}
        style={{ borderColor: 'var(--ai-line)', background: 'var(--ai-soft)', color: 'var(--fg)' }}
        title={st.ai ? `${props.aiEngine === 'local+ai' ? '本机识别后由' : '由'} ${st.model ?? 'AI'} 识字${st.aiLocal ? '（本地模型）' : ''}；每页约一次视觉请求，最多 ${st.aiMaxPages} 页` : st.aiReason ?? 'AI 识字不可用'}
      >
        <IconSparkles width={12} height={12} /> 用 AI 识字
      </button>
      {!st.ai && st.aiReason && <span className="text-2xs" style={{ color: 'var(--faint)' }}>{st.aiReason}</span>}
      {!st.local && st.localReason && st.platform !== 'darwin' && (
        <span className="text-2xs" style={{ color: 'var(--faint)' }} title={st.localReason}>
          本机识字不可用：{st.localReason.split(/[：；]/)[0]}
        </span>
      )}
      {st.ai && <span className="text-2xs" style={{ color: 'var(--faint)' }}>AI 每页约一次视觉请求{st.aiLocal ? '' : '，按你的 AI 服务计费'}</span>}
    </div>
  )
}

function Chip(props: { k: string; v: string }) {
  return (
    <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded-[var(--r-xs)] text-2xs max-w-full" style={{ background: 'var(--info-soft)', color: 'var(--info-ink)' }}>
      <span style={{ opacity: 0.75 }}>{props.k}</span>
      <span className="truncate tnum">{props.v}</span>
    </span>
  )
}

/** 已提取过的正文信息（只读缓存、不触发提取）；正文提取完成时刷新 */
function useCachedTextInfo(id: string): AttachmentTextInfo | null {
  const [info, setInfo] = useState<AttachmentTextInfo | null>(null)
  useEffect(() => {
    let alive = true
    setInfo(null)
    if (!id) return
    const load = () =>
      void api
        .readAttachmentTextInfo([id])
        .then(r => alive && setInfo(r[id] ?? null))
        .catch(() => {})
    load()
    const off = api.onEvent(ev => {
      const e = ev as { type: string; id?: string }
      if (e.type === 'attachment-text' && (!e.id || e.id === id)) load()
    })
    return () => {
      alive = false
      off()
    }
  }, [id])
  return info
}

/** 附件卡 / 附件中心上的一行「有正文 · 3 个工作表」（还没提取过、或没有文字时不渲染） */
export function AttachmentTextMeta(props: { id: string; filename: string; contentType?: string | null; className?: string }) {
  const readable = canReadText(props.filename, props.contentType)
  const info = useCachedTextInfo(readable ? props.id : '')
  if (!readable || !info || info.method === 'none' || !info.chars) return null
  const label = ['有正文', pagesLabel(info, props.filename)].filter(Boolean).join(' · ')
  return (
    <span className={props.className ?? 'mt-0.5 block text-2xs tnum'} style={{ color: 'var(--faint)' }} title={`已提取 ${fmtNum(info.chars)} 字，可「查看文字」或问 Agent`}>
      {label}
    </span>
  )
}

/** 阅读页附件卡：悬停出现的「查看文字」按钮 + 弹出面板（不支持的格式不渲染） */
export function AttachmentTextButton(props: { id: string; filename: string; contentType?: string | null }) {
  const [open, setOpen] = useState(false)
  if (!canReadText(props.filename, props.contentType)) return null
  return (
    <>
      <button
        title="查看文字"
        aria-label="查看附件文字"
        onClick={e => {
          e.stopPropagation()
          setOpen(o => !o)
        }}
        className={`absolute -top-1.5 -left-1.5 w-[20px] h-[20px] rounded-full liquid-glass items-center justify-center ${open ? 'flex' : 'hidden group-hover:flex focus-visible:flex'}`}
        style={{ color: 'var(--accent)' }}
      >
        <IconFileText width={11} height={11} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            className="absolute top-full left-0 mt-1.5 z-30 w-[400px] max-w-[80vw] rounded-[var(--r-sm)] border p-3 pop-in"
            style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-float)' }}
            role="dialog"
            aria-label={`「${props.filename}」的文字`}
          >
            <div className="flex items-center gap-1.5 mb-2 text-xs font-medium" style={{ color: 'var(--fg)' }}>
              <IconFileText width={13} height={13} />
              <span className="truncate">{props.filename}</span>
            </div>
            <AttachmentTextBody id={props.id} filename={props.filename} compact />
          </div>
        </>
      )}
    </>
  )
}

/** 附件中心详情：「正文」区块（点了才提取） */
export function AttachmentTextSection(props: { id: string; filename: string; contentType?: string | null }) {
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [props.id])
  if (!canReadText(props.filename, props.contentType)) return null
  return (
    <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border-soft)' }}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="caps" style={{ color: 'var(--faint)' }}>正文</span>
        <button onClick={() => setOpen(o => !o)} className="text-2xs hover:underline inline-flex items-center gap-1" style={{ color: 'var(--accent-ink)' }}>
          <IconFileText width={11} height={11} /> {open ? '收起' : '查看文字'}
        </button>
      </div>
      {open ? (
        <AttachmentTextBody id={props.id} filename={props.filename} />
      ) : (
        <div className="text-2xs" style={{ color: 'var(--faint)' }}>
          <AttachmentTextMeta id={props.id} filename={props.filename} contentType={props.contentType} className="block mb-0.5 tnum" />
          读取 PDF / Word / Excel / PowerPoint / 文本附件里的文字（扫描件与图片可识字），可复制或交给 Agent 提问。
        </div>
      )}
    </div>
  )
}
