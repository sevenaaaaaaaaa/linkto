import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { IconCheck, IconShield } from '../../components/icons'
import type { AttachmentAccessSettings, AttachmentContentKind, OcrAvailability, OcrEngine } from '@shared/types'

/**
 * 附件内容读取授权：
 *  - ContentAccessHost（主窗口全局挂一个）：主进程第一次需要读附件内容（'content-access-needed'）、
 *    或用户在「查看文字」/ Agent 读附件时被拦（openContentAccess / interactive 事件）时，弹出授权说明。
 *  - 共享的小部件（类型开关、识字方式）给设置页「附件内容读取」一节复用。
 */

const OPEN_EVENT = 'linkto:content-access'

/** 打开授权说明（阅读页 / 附件中心的「去授权」） */
export function openContentAccess(reason?: string | null) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { reason: reason ?? null } }))
}

export const KIND_OPTIONS: { id: AttachmentContentKind; label: string; desc: string }[] = [
  { id: 'pdf', label: 'PDF', desc: '读取 PDF 的文字层' },
  { id: 'office', label: 'Word / Excel / PPT', desc: '读取 Office 文档里的文字与表格' },
  { id: 'text', label: '文本', desc: 'txt / csv / md / html / eml 等' },
  { id: 'ocr', label: '扫描件与图片识字', desc: '没有文字层的扫描件 PDF 与图片，做文字识别（OCR）' }
]

export const ENGINE_OPTIONS: { id: Exclude<OcrEngine, 'off'>; label: string; desc: string; needsLocal?: boolean; usesAI?: boolean }[] = [
  { id: 'local', label: '本机识别', desc: '电脑自带的文字识别（macOS / Windows 系统识字，Linux 用 tesseract），完全在本机完成，免费', needsLocal: true },
  { id: 'ai', label: 'AI 识字', desc: '页面图片发给视觉模型识别，复杂表格与手写更准；每页约一次视觉请求，按你的 AI 服务计费', usesAI: true },
  { id: 'local+ai', label: '本机识别 + AI 校对', desc: '先本机识别，再让 AI 对照图片改错字、还原表格；AI 不可用时用本机结果', needsLocal: true, usesAI: true }
]

/** 类型开关（小胶囊按钮） */
export function KindChips(props: { kinds: Record<AttachmentContentKind, boolean>; onChange(k: AttachmentContentKind, v: boolean): void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {KIND_OPTIONS.map(k => {
        const on = props.kinds[k.id]
        return (
          <button
            key={k.id}
            type="button"
            disabled={props.disabled}
            onClick={() => props.onChange(k.id, !on)}
            aria-pressed={on}
            title={k.desc}
            className="no-drag h-7 px-2.5 rounded-[var(--r-sm)] text-xs border transition-colors inline-flex items-center gap-1 disabled:opacity-40"
            style={on ? { background: 'var(--selected)', borderColor: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 600 } : { borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            {on && <IconCheck width={11} height={11} />}
            {k.label}
          </button>
        )
      })}
    </div>
  )
}

/** 识字方式（单选卡片）；本机识字不可用（如 Windows 没装识字语言、Linux 没装 tesseract）时不显示本机相关选项 */
export function EngineChoice(props: { value: OcrEngine; onChange(v: Exclude<OcrEngine, 'off'>): void; status: OcrAvailability | null; disabled?: boolean; name: string }) {
  const opts = ENGINE_OPTIONS.filter(o => !o.needsLocal || props.status?.local !== false)
  return (
    <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="扫描件识字方式">
      {opts.map(o => {
        const on = props.value === o.id
        return (
          <label
            key={o.id}
            className={`flex items-start gap-2.5 px-3 py-2 rounded-[var(--r-sm)] border cursor-pointer transition-colors ${props.disabled ? 'opacity-40 pointer-events-none' : 'hover:bg-[var(--hover)]'}`}
            style={{ borderColor: on ? 'var(--accent)' : 'var(--border)', background: on ? 'var(--selected)' : 'transparent' }}
          >
            <input type="radio" name={props.name} className="mt-[3px]" checked={on} onChange={() => props.onChange(o.id)} style={{ accentColor: 'var(--accent)' }} />
            <span className="min-w-0">
              <span className="block text-sm" style={{ color: 'var(--fg)' }}>{o.label}</span>
              <span className="block text-2xs leading-relaxed mt-0.5" style={{ color: 'var(--faint)' }}>{o.desc}</span>
            </span>
          </label>
        )
      })}
      {props.status?.localReason && (
        <div className="text-2xs leading-relaxed" style={{ color: 'var(--faint)' }}>
          {props.status.local ? '本机识别：' : '本机识别暂不可用：'}
          {props.status.localReason}
        </div>
      )}
    </div>
  )
}

/** 主窗口全局：授权说明浮层 */
export function ContentAccessHost() {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<string | null>(null)
  const [cur, setCur] = useState<AttachmentAccessSettings | null>(null)
  const [status, setStatus] = useState<OcrAvailability | null>(null)
  const [kinds, setKinds] = useState<Record<AttachmentContentKind, boolean>>({ pdf: true, office: true, text: true, ocr: true })
  const [cloud, setCloud] = useState(false)
  const [engine, setEngine] = useState<OcrEngine>('local')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const show = async (why: string | null, interactive: boolean) => {
      const [a, st] = await Promise.all([api.contentAccessGet(), api.ocrStatus().catch(() => null)])
      // 后台第一次需要读取时才主动问；之后（暂不 / 已授权）只在用户主动操作时再问
      if (!interactive && a.asked) return
      setCur(a)
      setStatus(st)
      setKinds({ ...a.kinds })
      setCloud(a.sendToCloudAI)
      setEngine(a.ocrEngine === 'off' ? (st?.local === false ? 'ai' : 'local') : st?.local === false && a.ocrEngine !== 'ai' ? 'ai' : a.ocrEngine)
      setReason(why)
      setOpen(true)
    }
    const off = api.onEvent(ev => {
      const e = ev as { type?: string; reason?: string | null; interactive?: boolean }
      if (e.type === 'content-access-needed') void show(e.reason ?? null, !!e.interactive)
    })
    const onOpen = (e: Event) => void show((e as CustomEvent<{ reason?: string | null }>).detail?.reason ?? null, true)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      void off()
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!open || !cur) return null
  const aiLocal = !!status?.aiLocal
  const engineUsesAI = engine === 'ai' || engine === 'local+ai'

  const allow = async () => {
    setBusy(true)
    try {
      await api.contentAccessSet({ readContent: true, kinds, sendToCloudAI: cloud, ocrEngine: kinds.ocr ? engine : cur.ocrEngine })
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }
  const later = async () => {
    // 已授权时「暂不」只是关掉；没授权时记下「问过了」，之后只在用户主动操作时再问
    if (!cur.readContent) await api.contentAccessSet({ readContent: false })
    setOpen(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[9vh] px-4 fade-in" style={{ background: 'var(--scrim)' }} onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="content-access-title"
        className="w-[480px] max-w-full max-h-[82vh] overflow-y-auto rounded-[var(--r-lg)] border pop-in"
        style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-float)' }}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-full inline-flex items-center justify-center shrink-0" style={{ background: 'var(--accent-soft)', color: 'var(--accent-ink)' }}>
              <IconShield width={16} height={16} />
            </span>
            <div className="min-w-0">
              <h2 id="content-access-title" className="text-md font-semibold" style={{ color: 'var(--fg)' }}>
                {cur.readContent ? '附件内容读取' : '允许 LinkTo 读取附件内容？'}
              </h2>
              {reason && <div className="text-2xs truncate" style={{ color: 'var(--faint)' }}>「{reason}」需要读取内容</div>}
            </div>
          </div>
          <p className="mt-3 text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
            读取在这台电脑上完成，用来：查看附件文字、按内容归类、核对发票与账单、整理进知识库、回答你对附件的提问。附件不会上传到 LinkTo 的服务器。
          </p>

          <div className="mt-4 text-xs font-medium" style={{ color: 'var(--fg)' }}>读取哪些附件</div>
          <div className="mt-1.5">
            <KindChips kinds={kinds} onChange={(k, v) => setKinds(p => ({ ...p, [k]: v }))} />
          </div>

          {kinds.ocr && (
            <>
              <div className="mt-4 text-xs font-medium" style={{ color: 'var(--fg)' }}>扫描件识字方式</div>
              <div className="mt-1.5">
                <EngineChoice name="access-engine" value={engine} onChange={setEngine} status={status} />
              </div>
            </>
          )}

          <div className="mt-4 rounded-[var(--r-sm)] border px-3 py-2.5" style={{ borderColor: 'var(--border)', background: 'var(--bg-soft)' }}>
            {aiLocal ? (
              <div className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
                <span style={{ color: 'var(--fg)' }}>当前 AI 是本地模型</span>：附件内容交给它也不出本机，不需要单独授权。
              </div>
            ) : (
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" className="mt-[3px]" checked={cloud} onChange={e => setCloud(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
                <span className="min-w-0">
                  <span className="block text-sm" style={{ color: 'var(--fg)' }}>允许把附件内容发给云端 AI</span>
                  <span className="block text-2xs leading-relaxed mt-0.5" style={{ color: 'var(--faint)' }}>
                    Agent 问答、知识库提炼、生活档案、自动技能和 AI 识字会把附件节选（或扫描页图片）发给你在「设置 → AI」里配置的服务。不勾选时，这些功能只用文件名与邮件正文。
                  </span>
                </span>
              </label>
            )}
            {!aiLocal && !cloud && kinds.ocr && engineUsesAI && (
              <div className="mt-2 text-2xs leading-relaxed" style={{ color: 'var(--warn-ink)' }}>
                AI 识字需要勾选上面这一项；不勾选时{engine === 'local+ai' ? '只用本机识别结果' : '无法用 AI 识字'}。
              </div>
            )}
          </div>
        </div>
        <div className="px-5 py-3 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-soft)' }}>
          <span className="flex-1 text-2xs" style={{ color: 'var(--faint)' }}>随时可在 设置 → 附件与存储 修改</span>
          <button
            onClick={() => void later()}
            className="h-8 px-3 rounded-[var(--r-sm)] text-sm border transition-colors hover:bg-[var(--hover)]"
            style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
          >
            {cur.readContent ? '取消' : '暂不'}
          </button>
          <button
            onClick={() => void allow()}
            disabled={busy}
            autoFocus
            className="h-8 px-3.5 rounded-[var(--r-sm)] text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          >
            {cur.readContent ? '保存' : '允许'}
          </button>
        </div>
      </div>
    </div>
  )
}
