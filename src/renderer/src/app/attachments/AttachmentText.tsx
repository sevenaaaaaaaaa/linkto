import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { askAgent } from '../../lib/agent-ask'
import { IconCheck, IconFileText, IconRobot } from '../../components/icons'
import type { AttachmentTextInfo } from '@shared/types'

/**
 * 附件正文：阅读页附件卡上的「查看文字」小按钮（悬停出现）与附件中心详情里的「正文」区块。
 * 展开正文前 N 字（可选中 / 复制）、发票抽取字段，以及「问 Agent」（带附件 id 让 Agent 调 read_attachment）。
 */

const TEXT_EXT = /\.(pdf|txt|text|csv|tsv|md|markdown|log|json|xml|ya?ml|ini|html?|xhtml|eml|ics|vcf|srt|rtf)$/i
const PREVIEW_CHARS = 6000

/** 能读文字的附件（PDF / 纯文本类） */
export function canReadText(filename: string, contentType?: string | null): boolean {
  const ct = (contentType || '').toLowerCase()
  return TEXT_EXT.test(filename || '') || ct === 'application/pdf' || ct.startsWith('text/') || ct === 'message/rfc822'
}

type Loaded = { ok: boolean; text?: string; info?: AttachmentTextInfo; error?: string }

function fmtNum(n: number) {
  return n.toLocaleString('zh-CN')
}

function money(n: number, cur?: string | null) {
  const v = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return !cur || cur === 'CNY' ? `¥${v}` : `${cur} ${v}`
}

/** 正文里的分页符 → 可读的分页标记 */
function withPageMarks(text: string): string {
  let n = 1
  return text.replace(/\n\f\n/g, () => `\n\n—— 第 ${++n} 页 ——\n\n`)
}

function askAbout(id: string, filename: string, q: string) {
  const question = q.trim() || '总结这份附件的要点（关键数字、日期、需要我做的事）'
  askAgent(`${question}\n\n（附件「${filename}」，附件 id：${id}。请先用 read_attachment 读取它的正文再回答。）`)
}

/** 正文面板主体：加载 → 状态行 → 发票字段 → 正文 → 复制 / 问 Agent */
export function AttachmentTextBody(props: { id: string; filename: string; compact?: boolean }) {
  const [res, setRes] = useState<Loaded | null>(null)
  const [copied, setCopied] = useState(false)
  const [q, setQ] = useState('')
  useEffect(() => {
    let alive = true
    setRes(null)
    api
      .readAttachmentText(props.id, PREVIEW_CHARS)
      .then(r => alive && setRes(r))
      .catch(err => alive && setRes({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    return () => {
      alive = false
    }
  }, [props.id])

  const info = res?.info
  const text = res?.text ?? ''
  const hasText = !!res?.ok && !!text.trim() && info?.method !== 'none'
  const inv = info?.invoice
  const meta = info
    ? [info.method === 'pdfjs' ? 'PDF 文本层' : info.method === 'plain' ? '纯文本' : null, info.pages > 1 ? `${info.pages} 页` : null, info.chars ? `${fmtNum(info.chars)} 字` : null, info.encoding && info.encoding !== 'utf-8' && info.encoding !== 'mime' ? `编码 ${info.encoding.toUpperCase()}` : null]
        .filter(Boolean)
        .join(' · ')
    : ''

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
      {res && !res.ok && (
        <div className="px-2.5 py-2 rounded-[var(--r-xs)]" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
          {res.error || '读取失败'}
        </div>
      )}
      {res?.ok && !hasText && (
        <div className="px-2.5 py-2 rounded-[var(--r-xs)]" style={{ background: 'var(--bg-soft)', color: 'var(--muted)' }}>
          没有可读取的文字{info?.error ? `：${info.error}` : ''}
          {info?.error && /扫描|图片/.test(info.error) && <span className="block mt-0.5 text-2xs" style={{ color: 'var(--faint)' }}>扫描件需要文字识别（OCR），暂不支持；可以「打开」后用预览的文本识别。</span>}
        </div>
      )}
      {hasText && (
        <>
          {meta && <div className="text-2xs tnum" style={{ color: 'var(--faint)' }}>{meta}{info?.truncated ? ' · 只提取了前一部分' : ''}</div>}
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
            {withPageMarks(text)}
            {info && info.chars > text.length && (
              <span className="block mt-2 text-2xs" style={{ color: 'var(--faint)' }}>
                …… 仅显示前 {fmtNum(text.length)} 字（共 {fmtNum(info.chars)} 字）
              </span>
            )}
          </div>
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

function Chip(props: { k: string; v: string }) {
  return (
    <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded-[var(--r-xs)] text-2xs max-w-full" style={{ background: 'var(--info-soft)', color: 'var(--info-ink)' }}>
      <span style={{ opacity: 0.75 }}>{props.k}</span>
      <span className="truncate tnum">{props.v}</span>
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
      {open ? <AttachmentTextBody id={props.id} filename={props.filename} /> : <div className="text-2xs" style={{ color: 'var(--faint)' }}>读取 PDF / 文本附件里的文字，可复制或交给 Agent 提问。</div>}
    </div>
  )
}
