import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { api } from '../../lib/api'
import { useMail } from '../../stores/mail'
import { IconClose, IconSend, IconLink, IconFileText, IconSave, IconSettings, IconCloud, IconChat, IconBook, IconCheck } from '../../components/icons'
import type { MenuItem } from '../../components/Menu'
import { CONTENT_FORMATS, SHARE_FORMATS, SHARE_GROUP_LABEL, formatLabel, type ShareContent, type ShareFormat, type ShareGroup, type SharePreview, type ShareSettings, type ShareTargetInfo } from '@shared/share'

/**
 * 导出与分享中心（渲染端）：
 * - ShareHost：主窗口全局挂一个，监听 'ms:share-open' 打开分享面板（左格式 · 中预览 · 右目标 · 底部发送 / 导出）；
 *   也接管订阅阅读区等派发的可取消事件 'ms:share-request'（detail：kind:'link', title, url, text, source, feedItemId?）→ 分享通用内容
 * - shareMenuItems：阅读页「分享 / 导出」菜单；shareCommands：⌘K 命令
 * 所有对外发送在面板底部二次确认（批量时一次确认）后才调用 shareSend(confirmed)。
 */

const OPEN_EVENT = 'ms:share-open'
const REQUEST_EVENT = 'ms:share-request'

/** 分享通用内容（订阅文章 / 网页）：打开分享面板 */
export function openShareContent(content: ShareContent, opts: { format?: ShareFormat; targetId?: string } = {}) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { ids: [], content, ...opts } }))
}

export function openShare(ids: string[], opts: { format?: ShareFormat; targetId?: string } = {}) {
  if (!ids.length) return toast('先选中一封邮件')
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { ids, ...opts } }))
}

const toast = (text: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail: text }))

/** 当前要分享的邮件：多选优先，否则当前打开的 */
export function currentShareIds(): string[] {
  const st = useMail.getState()
  if (st.selectedIds.size > 1) return [...st.selectedIds]
  return st.selectedId ? [st.selectedId] : [...st.selectedIds]
}

// ---------------------------------------------------------------- 目标缓存（阅读页菜单「最近使用」也用）

interface ShareState {
  targets: ShareTargetInfo[]
  settings: ShareSettings | null
  load(): Promise<void>
}

export const useShareTargets = create<ShareState>(set => ({
  targets: [],
  settings: null,
  async load() {
    const [targets, settings] = await Promise.all([api.shareTargets(), api.shareSettings()])
    set({ targets, settings })
  }
}))

let subscribed = false
function ensureLoaded() {
  if (!subscribed) {
    subscribed = true
    api.onEvent(raw => {
      const t = (raw as { type?: string }).type
      if (t === 'share-targets-changed' || t === 'cloud-drives-changed') void useShareTargets.getState().load()
    })
    window.addEventListener('focus', () => void useShareTargets.getState().load())
  }
  void useShareTargets.getState().load()
}

export function recentTargets(state: ShareState, n = 3): ShareTargetInfo[] {
  const rec = state.settings?.recent ?? []
  return rec.map(id => state.targets.find(t => t.id === id)).filter((t): t is ShareTargetInfo => !!t).slice(0, n)
}

// ---------------------------------------------------------------- 快捷动作

export async function quickExport(ids: string[], format: ShareFormat) {
  if (!ids.length) return toast('先选中一封邮件')
  toast(`正在导出 ${formatLabel(format)}…`)
  const r = await api.shareExport({ messageIds: ids, targetId: 'sys:export', format, includeAttachments: format === 'md' })
  if (r.canceled) return
  toast(r.ok ? r.message ?? '已导出' : r.error ?? '导出失败')
  void useShareTargets.getState().load()
}

export async function quickCopy(ids: string[], kind: 'text' | 'rich' | 'link' | 'png') {
  if (!ids.length) return toast('先选中一封邮件')
  if (kind === 'png') toast('正在生成长图…')
  const r = await api.shareCopy(ids, kind)
  toast(r.ok ? r.message ?? '已复制' : r.error ?? '复制失败')
}

/** 阅读页「分享 / 导出」菜单：最近使用的目标置顶；extra = 连接器 / 网盘等既有分享项 */
export function shareMenuItems(ids: string[], extra: MenuItem[] = []): MenuItem[] {
  const st = useShareTargets.getState()
  if (!st.settings) ensureLoaded()
  const recent = recentTargets(st)
  const ic = (el: React.ReactNode) => el
  return [
    ...(recent.length
      ? [
          { kind: 'label' as const, label: '最近使用' },
          ...recent.map(t => ({ kind: 'action' as const, label: t.name, icon: ic(groupIcon(t.group)), onSelect: () => openShare(ids, { targetId: t.id }) })),
          { kind: 'sep' as const }
        ]
      : []),
    { kind: 'action', label: '分享面板…', icon: <IconSend width={13} height={13} />, hint: '⌘⇧E', onSelect: () => openShare(ids) },
    { kind: 'sep' },
    { kind: 'action', label: '导出为 PDF', icon: <IconFileText width={13} height={13} />, onSelect: () => void quickExport(ids, 'pdf') },
    { kind: 'action', label: '导出为长图', icon: <IconFileText width={13} height={13} />, onSelect: () => void quickExport(ids, 'png') },
    { kind: 'action', label: '导出 EML 原文', icon: <IconSave width={13} height={13} />, onSelect: () => void quickExport(ids, 'eml') },
    { kind: 'action', label: '导出 Markdown（含附件）', icon: <IconSave width={13} height={13} />, onSelect: () => void quickExport(ids, 'md') },
    { kind: 'sep' },
    { kind: 'action', label: '复制富文本', icon: <IconFileText width={13} height={13} />, onSelect: () => void quickCopy(ids, 'rich') },
    { kind: 'action', label: '复制邮件链接', icon: <IconLink width={13} height={13} />, onSelect: () => void quickCopy(ids, 'link') },
    { kind: 'action', label: '复制长图并打开微信', icon: <IconChat width={13} height={13} />, onSelect: () => openShare(ids, { targetId: 'sys:wechat', format: 'png' }) },
    { kind: 'action', label: '系统分享…', icon: <IconSend width={13} height={13} />, onSelect: () => openShare(ids, { targetId: 'sys:share', format: 'pdf' }) },
    ...(extra.length ? [{ kind: 'sep' as const }, ...extra] : [])
  ]
}

/** ⌘K 命令 */
export function shareCommands(onClose: () => void) {
  const run = (fn: (ids: string[]) => void) => () => {
    onClose()
    fn(currentShareIds())
  }
  return [
    { id: 'share-open', group: '操作', label: '分享到…', hint: '⌘⇧E', icon: <IconSend width={14} height={14} />, keywords: 'share export 分享 导出 IM 微信 企业微信 钉钉 飞书 slack teams telegram notion flomo 备忘录', run: run(ids => openShare(ids)) },
    { id: 'share-pdf', group: '操作', label: '导出为 PDF', icon: <IconFileText width={14} height={14} />, keywords: 'export pdf 导出 打印', run: run(ids => void quickExport(ids, 'pdf')) },
    { id: 'share-png', group: '操作', label: '导出为长图', keywords: 'export png image 长图 截图 微信', searchOnly: true, run: run(ids => void quickExport(ids, 'png')) },
    { id: 'share-eml', group: '操作', label: '导出 EML 原文', keywords: 'export eml 原文 导出', searchOnly: true, run: run(ids => void quickExport(ids, 'eml')) },
    { id: 'share-md', group: '操作', label: '导出 Markdown', keywords: 'export markdown md 笔记 导出', searchOnly: true, run: run(ids => void quickExport(ids, 'md')) },
    { id: 'share-link', group: '操作', label: '复制邮件链接', keywords: 'copy link 链接 linkto', searchOnly: true, run: run(ids => void quickCopy(ids, 'link')) }
  ]
}

function groupIcon(g: ShareGroup) {
  const p = { width: 13, height: 13 }
  if (g === 'notes') return <IconBook {...p} />
  if (g === 'drive') return <IconCloud {...p} />
  if (g === 'local') return <IconSave {...p} />
  if (g === 'im' || g === 'work-im') return <IconChat {...p} />
  return <IconSend {...p} />
}

const GROUP_ORDER: ShareGroup[] = ['work-im', 'im', 'notes', 'local', 'drive', 'system']

// ---------------------------------------------------------------- 面板

interface OpenReq {
  ids: string[]
  /** 通用内容（非邮件）：给出时 ids 为空 */
  content?: ShareContent
  format?: ShareFormat
  targetId?: string
}

export function ShareHost() {
  const [req, setReq] = useState<OpenReq | null>(null)
  useEffect(() => {
    ensureLoaded()
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<OpenReq>).detail
      if (d?.ids?.length || d?.content) setReq({ ...d, ids: d.ids ?? [] })
    }
    // 订阅阅读区「分享」：可取消事件，接管后对方不再退回复制链接
    const onRequest = (e: Event) => {
      const d = (e as CustomEvent<Partial<ShareContent> | null>).detail
      if (!d || d.kind !== 'link' || !(d.title || d.url)) return
      e.preventDefault()
      setReq({
        ids: [],
        content: {
          kind: 'link',
          title: String(d.title ?? ''),
          url: d.url ?? null,
          text: d.text ?? null,
          source: d.source ?? null,
          date: typeof d.date === 'number' ? d.date : null,
          feedItemId: d.feedItemId ?? null
        }
      })
    }
    window.addEventListener(OPEN_EVENT, onOpen)
    window.addEventListener(REQUEST_EVENT, onRequest)
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen)
      window.removeEventListener(REQUEST_EVENT, onRequest)
    }
  }, [])
  if (!req) return null
  return <SharePanel key={req.ids.join('|') + (req.content ? `c:${req.content.feedItemId ?? req.content.url ?? req.content.title}` : '') + (req.targetId ?? '') + (req.format ?? '')} req={req} onClose={() => setReq(null)} />
}

function SharePanel(props: { req: OpenReq; onClose(): void }) {
  const ids = props.req.ids
  const content = props.req.content ?? null
  const { targets: allTargets, settings } = useShareTargets()
  // 通用内容：只保留文本类 + PDF / 长图（没有 EML），并去掉一个格式都不支持的目标
  const formatsOf = (t: ShareTargetInfo) => (content ? t.formats.filter(f => CONTENT_FORMATS.includes(f)) : t.formats)
  const targets = useMemo(() => (content ? allTargets.map(t => ({ ...t, formats: formatsOf(t) })).filter(t => t.formats.length) : allTargets), [allTargets, content])
  const [format, setFormat] = useState<ShareFormat>(props.req.format ?? 'text')
  const [targetId, setTargetId] = useState<string>(props.req.targetId ?? '')
  const [includeAtt, setIncludeAtt] = useState(false)
  const [merge, setMerge] = useState(true)
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState<SharePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const messages = useMail(st => st.messages)
  const subjects = content ? [content.title || content.url || ''] : ids.map(id => messages.find(m => m.id === id)?.subject || '').filter(Boolean)
  const formatList = content ? SHARE_FORMATS.filter(f => CONTENT_FORMATS.includes(f.id)) : SHARE_FORMATS

  const target = targets.find(t => t.id === targetId) ?? null
  const recent = recentTargets({ targets, settings, load: async () => {} }, 4)

  // 默认目标：指定的 > 最近使用里支持当前格式的 > 导出到本地
  useEffect(() => {
    if (!targets.length) return
    if (targetId && targets.some(t => t.id === targetId)) {
      const t = targets.find(x => x.id === targetId)!
      if (!t.formats.includes(format)) setFormat(t.formats[0])
      return
    }
    const pick = recent.find(t => t.formats.includes(format)) ?? targets.find(t => t.id === 'sys:export')!
    setTargetId(pick.id)
    if (!pick.formats.includes(format)) setFormat(pick.formats[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.length])

  const pickFormat = (f: ShareFormat) => {
    setFormat(f)
    setConfirming(false)
    setResult(null)
    if (target && !target.formats.includes(f)) {
      const alt = recent.find(t => t.formats.includes(f)) ?? targets.find(t => t.id === 'sys:export' && t.formats.includes(f)) ?? targets.find(t => t.formats.includes(f))
      if (alt) setTargetId(alt.id)
    }
  }
  const pickTarget = (t: ShareTargetInfo) => {
    setTargetId(t.id)
    setConfirming(false)
    setResult(null)
    if (!t.formats.includes(format)) setFormat(t.formats[0])
  }

  // 预览（停顿 250ms 再取，附言输入时不频繁生成）
  useEffect(() => {
    if (!targetId) return
    let alive = true
    setLoading(true)
    const timer = setTimeout(() => {
      void api
        .sharePreview({ messageIds: ids, content, targetId, format, includeAttachments: includeAtt, merge, note })
        .then(p => alive && setPreview(p))
        .catch(err => alive && setPreview({ ok: false, error: String(err), target: '', external: false, title: '', body: '', files: [], warnings: [] }))
        .finally(() => alive && setLoading(false))
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, format, includeAtt, merge, note, ids.join('|'), content])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (confirming) setConfirming(false)
        else props.onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [confirming, props])

  const external = !!target?.external
  const isExport = targetId === 'sys:export' || target?.kind === 'local-folder' || target?.group === 'drive' || target?.kind === 'md-folder'
  const actionLabel = targetId === 'sys:clipboard' ? '复制' : targetId === 'sys:share' ? '打开系统分享' : isExport ? '导出' : target?.group === 'notes' ? '保存' : '发送'

  const go = async () => {
    if (!target || busy) return
    if (preview && !preview.ok) return
    if (external && !confirming) {
      setConfirming(true)
      return
    }
    setBusy(true)
    setResult(null)
    try {
      const r = await api.shareSend({ messageIds: ids, content, targetId, format, includeAttachments: includeAtt, merge, note: note.trim() || undefined, confirmed: external ? true : undefined })
      if (r.canceled) return
      setResult({ ok: r.ok, text: r.ok ? r.message ?? '完成' : r.error ?? '失败' })
      if (r.ok) {
        toast(r.message ?? '完成')
        void useShareTargets.getState().load()
        setTimeout(props.onClose, 900)
      }
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const grouped = useMemo(() => {
    const m = new Map<ShareGroup, ShareTargetInfo[]>()
    for (const g of GROUP_ORDER) m.set(g, [])
    for (const t of targets) m.get(t.group)?.push(t)
    return m
  }, [targets])

  const hasAtt = useMemo(() => !content && ids.some(id => messages.find(m => m.id === id)?.hasAttachments), [ids, messages, content])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[7vh] px-4 fade-in" style={{ background: 'var(--scrim)' }} onMouseDown={props.onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        className="w-[920px] max-w-full h-[min(620px,84vh)] flex flex-col rounded-[var(--r-lg)] border pop-in overflow-hidden"
        style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-float)' }}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="h-12 shrink-0 px-4 flex items-center gap-3 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <span className="w-7 h-7 rounded-full inline-flex items-center justify-center shrink-0" style={{ background: 'var(--accent-soft)', color: 'var(--accent-ink)' }}>
            <IconSend width={14} height={14} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="share-title" className="text-md font-semibold leading-tight" style={{ color: 'var(--fg)' }}>
              分享 / 导出{content ? ` · ${content.source ? `订阅 · ${content.source}` : '网页内容'}` : ids.length > 1 ? ` · ${ids.length} 封` : ''}
            </h2>
            <div className="text-2xs truncate" style={{ color: 'var(--faint)' }}>
              {subjects.slice(0, 2).join('、') || (content ? content.url : '当前邮件')}
              {subjects.length > 2 ? ` 等 ${subjects.length} 封` : ''}
            </div>
          </div>
          <button onClick={() => void api.openSettings('share')} className="icon-btn h-7 px-2 inline-flex items-center gap-1 text-xs" style={{ color: 'var(--muted)' }} title="管理分享目标与导出设置">
            <IconSettings width={13} height={13} /> 管理目标
          </button>
          <button onClick={props.onClose} className="icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--muted)' }} aria-label="关闭">
            <IconClose width={14} height={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* 左：格式 */}
          <div className="w-[148px] shrink-0 border-r p-2 overflow-y-auto" style={{ borderColor: 'var(--border-soft)' }} role="radiogroup" aria-label="格式">
            <div className="caps px-2 pt-1 pb-1.5" style={{ color: 'var(--faint)' }}>格式</div>
            {formatList.map(f => {
              const on = f.id === format
              const ok = !target || target.formats.includes(f.id)
              return (
                <button
                  key={f.id}
                  role="radio"
                  aria-checked={on}
                  onClick={() => pickFormat(f.id)}
                  title={f.desc + (ok ? '' : `（「${target?.name}」不支持，会换一个目标）`)}
                  className="w-full text-left px-2.5 py-1.5 mb-0.5 rounded-[var(--r-sm)] text-sm transition-colors hover:bg-[var(--hover)]"
                  style={on ? { background: 'var(--selected)', color: 'var(--accent-ink)', fontWeight: 600 } : { color: ok ? 'var(--fg)' : 'var(--faint)' }}
                >
                  {f.label}
                </button>
              )
            })}
          </div>

          {/* 中：预览 */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="px-4 pt-3 pb-2 flex items-center gap-2">
              <span className="text-xs font-medium" style={{ color: 'var(--fg)' }}>预览</span>
              <span className="text-2xs" style={{ color: 'var(--faint)' }}>
                {formatLabel(format)} → {target?.name ?? '…'}
                {external ? ' · 对外发送' : ''}
              </span>
              {loading && <span className="text-2xs" style={{ color: 'var(--faint)' }}>生成中…</span>}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-3">
              {preview?.ok === false ? (
                <div className="rounded-[var(--r-sm)] px-3 py-2.5 text-sm" style={{ background: 'var(--danger-soft)', color: 'var(--danger-ink)' }}>
                  {preview.error}
                </div>
              ) : preview ? (
                <>
                  {preview.warnings.map(w => (
                    <div key={w} className="mb-1.5 rounded-[var(--r-sm)] px-2.5 py-1.5 text-2xs leading-relaxed" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
                      {w}
                    </div>
                  ))}
                  {preview.files.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {preview.files.slice(0, 12).map(f => (
                        <span key={f} className="inline-flex items-center gap-1 h-6 px-2 rounded-[var(--r-xs)] text-2xs border max-w-full" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }} title={f}>
                          <IconFileText width={11} height={11} />
                          <span className="truncate">{f.split('/').pop()}</span>
                        </span>
                      ))}
                      {preview.files.length > 12 && <span className="text-2xs" style={{ color: 'var(--faint)' }}>等 {preview.files.length} 个</span>}
                    </div>
                  )}
                  <pre
                    className="selectable whitespace-pre-wrap break-words rounded-[var(--r-sm)] border px-3 py-2.5 text-xs leading-relaxed"
                    style={{ background: 'var(--bg-soft)', borderColor: 'var(--border-soft)', color: 'var(--fg)', fontFamily: 'var(--font-body)' }}
                  >
                    {preview.body || '（无内容）'}
                  </pre>
                </>
              ) : (
                <div className="h-24 rounded-[var(--r-sm)] shimmer" />
              )}
            </div>
            {/* 选项 */}
            <div className="px-4 py-2 border-t flex flex-wrap items-center gap-x-4 gap-y-1.5" style={{ borderColor: 'var(--border-soft)' }}>
              {hasAtt && (
                <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--muted)' }}>
                  <input type="checkbox" checked={includeAtt} onChange={e => setIncludeAtt(e.target.checked)} style={{ accentColor: 'var(--accent)' }} /> 连同附件
                </label>
              )}
              {ids.length > 1 && (
                <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: 'var(--muted)' }}>
                  <input type="checkbox" checked={merge} onChange={e => setMerge(e.target.checked)} style={{ accentColor: 'var(--accent)' }} /> 合并为{format === 'pdf' || format === 'png' ? '一个文件' : '一条'}
                </label>
              )}
              {external || target?.group === 'notes' ? (
                <input
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder={content ? '附言（可选），如「这篇值得一读」' : '附言（可选），如「@产品组 请看这封客户反馈」'}
                  className="flex-1 min-w-[200px] h-7 px-2 rounded-[var(--r-sm)] text-xs outline-none border"
                  style={{ background: 'var(--bg-soft)', borderColor: 'var(--border)', color: 'var(--fg)' }}
                />
              ) : null}
            </div>
          </div>

          {/* 右：目标 */}
          <div className="w-[248px] shrink-0 border-l overflow-y-auto p-2" style={{ borderColor: 'var(--border-soft)' }} aria-label="目标">
            {recent.length > 0 && (
              <TargetGroup title="最近使用" list={recent} format={format} active={targetId} onPick={pickTarget} />
            )}
            {GROUP_ORDER.map(g => {
              const list = grouped.get(g) ?? []
              if (!list.length && g !== 'work-im') return null
              return (
                <div key={g}>
                  <TargetGroup title={SHARE_GROUP_LABEL[g]} list={list} format={format} active={targetId} onPick={pickTarget} />
                  {!list.length && (
                    <button onClick={() => void api.openSettings('share')} className="w-full text-left px-2.5 pb-2 text-2xs hover:underline" style={{ color: 'var(--accent-ink)' }}>
                      ＋ 添加企业微信 / 钉钉 / 飞书 / Slack / Teams 群机器人
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* 底部：确认 / 发送 */}
        <div className="shrink-0 px-4 py-2.5 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-soft)', background: confirming ? 'var(--accent-soft)' : undefined }}>
          <span className="flex-1 min-w-0 text-xs truncate" role={result && !result.ok ? 'alert' : 'status'} style={{ color: result ? (result.ok ? 'var(--ok-ink)' : 'var(--danger-ink)') : confirming ? 'var(--fg)' : 'var(--faint)' }}>
            {result ? (
              <>
                {result.ok && <IconCheck width={12} height={12} className="inline -mt-px mr-1" />}
                {result.text}
              </>
            ) : confirming ? (
              content
                ? `确认把「${(content.title || content.url || '').slice(0, 30)}」的${formatLabel(format)}发到「${target?.name}」？发出后无法撤回。`
                : `确认把 ${ids.length} 封邮件的${formatLabel(format)}发到「${target?.name}」？发出后无法撤回。`
            ) : external ? (
              '对外发送：点「发送」后会再确认一次'
            ) : (
              '⌘⇧E 随时打开 · Esc 关闭'
            )}
          </span>
          <button
            onClick={() => (confirming ? setConfirming(false) : props.onClose())}
            className="h-8 px-3 rounded-[var(--r-sm)] text-sm border transition-colors hover:bg-[var(--hover)]"
            style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
          >
            {confirming ? '返回' : '取消'}
          </button>
          <button
            onClick={() => void go()}
            disabled={busy || !target || !preview?.ok}
            autoFocus
            className="h-8 px-3.5 rounded-[var(--r-sm)] text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1.5"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          >
            {busy ? '处理中…' : confirming ? `确认${actionLabel}` : actionLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function TargetGroup(props: { title: string; list: ShareTargetInfo[]; format: ShareFormat; active: string; onPick(t: ShareTargetInfo): void }) {
  return (
    <div className="mb-1.5">
      <div className="caps px-2 pt-1 pb-1" style={{ color: 'var(--faint)' }}>{props.title}</div>
      {props.list.map(t => {
        const on = t.id === props.active
        const ok = t.formats.includes(props.format)
        return (
          <button
            key={props.title + t.id}
            onClick={() => props.onPick(t)}
            title={`${t.hint ?? ''}${ok ? '' : `\n不支持${formatLabel(props.format)}，选中后会换成${formatLabel(t.formats[0])}`}`}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--r-sm)] text-left transition-colors hover:bg-[var(--hover)]"
            style={on ? { background: 'var(--selected)' } : undefined}
          >
            <span className="w-4 shrink-0 inline-flex justify-center" style={{ color: on ? 'var(--accent-ink)' : 'var(--muted)' }}>
              {groupIcon(t.group)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm truncate" style={{ color: ok ? (on ? 'var(--accent-ink)' : 'var(--fg)') : 'var(--faint)', fontWeight: on ? 600 : 400 }}>
                {t.name}
              </span>
              {t.hint && (
                <span className="block text-2xs truncate" style={{ color: 'var(--faint)' }}>
                  {t.hint}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
