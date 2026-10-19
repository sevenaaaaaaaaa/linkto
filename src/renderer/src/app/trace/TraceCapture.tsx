import { useEffect, useMemo, useRef, useState } from 'react'
import { parseChat, TRACE_CHANNELS, TRACE_CHANNEL_LABEL, type TraceChannel, type TraceParty } from '@shared/trace'
import { api } from '../../lib/api'
import { fromLocalInput, openTrace, toLocalInput, useTrace, useTraceEvents } from '../../lib/trace'
import { IconClose, IconSparkles } from '../../components/icons'
import { ChannelIcon, IconTrace } from './icons'
import { draftMaterials, MaterialComposer, PartyInput, type Shot } from './inputs'

/**
 * 「记一笔留痕」浮层（主窗口内，不另开窗口）：全局快捷键 ⌥⇧⌘L、Dock / 托盘菜单、⌘K、留痕页「新建」都打开它。
 * 粘贴文字 / 拖入截图 / 写几句 → AI 整理（已配置时）或按模板整理 → 存为留痕。
 */
export function TraceCaptureHost() {
  useTraceEvents()
  const [open, setOpen] = useState(false)
  const [seed, setSeed] = useState<{ text?: string } | null>(null)
  useEffect(() => {
    const on = (e: Event) => {
      setSeed(((e as CustomEvent).detail as { text?: string } | null) ?? null)
      setOpen(true)
    }
    window.addEventListener('ms:trace-capture', on)
    return () => window.removeEventListener('ms:trace-capture', on)
  }, [])
  if (!open) return null
  return <Capture seed={seed} onClose={() => setOpen(false)} />
}

const toast = (detail: unknown) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

function Capture(props: { seed: { text?: string } | null; onClose(): void }) {
  const [title, setTitle] = useState('')
  const [channel, setChannel] = useState<TraceChannel>('wechat')
  const [when, setWhen] = useState(() => toLocalInput(Date.now()))
  const [whenTouched, setWhenTouched] = useState(false)
  const [parties, setParties] = useState<TraceParty[]>([])
  const [text, setText] = useState(props.seed?.text ?? '')
  const [shots, setShots] = useState<Shot[]>([])
  const [busy, setBusy] = useState<null | 'ai' | 'template' | 'draft'>(null)
  const [caps, setCaps] = useState<{ ai: boolean; aiReason?: string | null } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api.traceCapabilities().then(setCaps).catch(() => setCaps({ ai: false }))
  }, [])

  const shotText = shots.filter(s => s.status === 'done').map(s => s.text ?? '').join('\n')
  // 聊天文字与截图识字一起解析：认出发言人（参与人联想）与最后一条消息的时间
  const parsed = useMemo(() => parseChat([text, shotText].filter(Boolean).join('\n')), [text, shotText])
  // 聊天记录里认出时间：没手动改过发生时间时，用最后一条消息的时间
  useEffect(() => {
    if (!whenTouched && parsed.lastAt) setWhen(toLocalInput(parsed.lastAt))
  }, [parsed.lastAt, whenTouched])

  const ocring = shots.some(s => s.status === 'ocr')
  const mats = draftMaterials(text, shots, { note: channel === 'phone' || channel === 'meeting' || channel === 'in-person' })
  const canSave = mats.length > 0 && !ocring && !busy

  const save = async (mode: 'ai' | 'template' | 'draft') => {
    if (!canSave) return
    setBusy(mode)
    try {
      const res = await api.traceCreate(
        { title: title.trim() || '记一笔', channel, occurredAt: fromLocalInput(when), parties, materials: mats, source: 'capture' },
        { organize: mode === 'draft' ? null : mode }
      )
      await useTrace.getState().load()
      props.onClose()
      const o = res.organized
      const warn = o?.warnings?.length ? `（${o.warnings.length} 处已改为待确认）` : ''
      toast({
        text: o && !o.ok ? `已保存，但整理失败：${o.error ?? ''}` : mode === 'draft' ? '已记一笔留痕（草稿）' : `已记一笔留痕，${o?.by === 'ai' ? 'AI 已整理' : '已按模板整理'}${warn}`,
        actions: [{ label: '查看', run: () => openTrace(res.id) }],
        duration: 5000
      })
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void save(caps?.ai ? 'ai' : 'template')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const lab = 'text-2xs font-medium mb-1 block'
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[7vh] px-4 fade-in" style={{ background: 'var(--scrim)' }} onMouseDown={props.onClose}>
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trace-capture-title"
        className="w-[600px] max-w-full max-h-[86vh] flex flex-col rounded-[var(--r-lg)] border pop-in"
        style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-float)' }}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-3 flex items-center gap-2.5 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <span className="w-8 h-8 rounded-full inline-flex items-center justify-center shrink-0" style={{ background: 'var(--accent-soft)', color: 'var(--accent-ink)' }}>
            <IconTrace width={16} height={16} />
          </span>
          <div className="flex-1 min-w-0">
            <h2 id="trace-capture-title" className="text-md font-semibold" style={{ color: 'var(--fg)' }}>记一笔留痕</h2>
            <div className="text-2xs" style={{ color: 'var(--faint)' }}>口头说定的事，留下原话、整理约定，需要时一键发书面确认</div>
          </div>
          <button onClick={props.onClose} className="icon-btn w-7 h-7 inline-flex items-center justify-center" aria-label="关闭" style={{ color: 'var(--faint)' }}>
            <IconClose width={13} height={13} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-3.5">
          <div>
            <span className={lab} style={{ color: 'var(--faint)' }}>场景</span>
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="场景">
              {TRACE_CHANNELS.map(c => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={channel === c}
                  onClick={() => setChannel(c)}
                  className="h-7 px-2.5 rounded-[var(--r-sm)] text-xs border inline-flex items-center gap-1.5 transition-colors"
                  style={channel === c ? { background: 'var(--accent)', color: 'var(--on-accent)', borderColor: 'var(--accent)' } : { borderColor: 'var(--border)', color: 'var(--muted)' }}
                >
                  <ChannelIcon channel={c} width={12} height={12} />
                  {TRACE_CHANNEL_LABEL[c]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className={lab} style={{ color: 'var(--faint)' }}>原始材料</span>
            <MaterialComposer text={text} onText={setText} shots={shots} onShots={setShots} autoFocus />
          </div>

          <div className="grid grid-cols-[1fr_200px] gap-3 max-[560px]:grid-cols-1">
            <label className="min-w-0">
              <span className={lab} style={{ color: 'var(--faint)' }}>标题（可留空，整理时自动起）</span>
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="如：客厅吊顶改石膏线" className="w-full h-8 px-2.5 rounded-[var(--r-sm)] border outline-none text-sm focus:border-[var(--border-strong)]" style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)', color: 'var(--fg)' }} />
            </label>
            <label className="min-w-0">
              <span className={lab} style={{ color: 'var(--faint)' }}>发生时间</span>
              <input
                type="datetime-local"
                value={when}
                onChange={e => {
                  setWhen(e.target.value)
                  setWhenTouched(true)
                }}
                className="w-full h-8 px-2 rounded-[var(--r-sm)] border outline-none text-xs focus:border-[var(--border-strong)]"
                style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)', color: 'var(--fg)' }}
              />
            </label>
          </div>

          <div>
            <span className={lab} style={{ color: 'var(--faint)' }}>参与人</span>
            <PartyInput value={parties} onChange={setParties} hints={parsed.speakers} />
          </div>
        </div>

        <div className="px-5 py-3 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-soft)' }}>
          <span className="flex-1 min-w-0 text-2xs leading-relaxed" style={{ color: 'var(--faint)' }}>
            {ocring ? '截图识字中…' : caps && !caps.ai ? '没有配置 AI：按模板摘录原话，保存后可逐条修改' : 'AI 只依据材料整理：金额、日期必须是原话，找不到的标为待确认'}
          </span>
          <button onClick={() => void save('draft')} disabled={!canSave} className="h-8 px-3 rounded-[var(--r-sm)] text-sm border transition-colors hover:bg-[var(--hover)] disabled:opacity-40" style={{ borderColor: 'var(--border)', color: 'var(--fg)' }} title="只保存原始材料，稍后再整理">
            {busy === 'draft' ? '保存中…' : '存草稿'}
          </button>
          {caps?.ai ? (
            <>
              <button onClick={() => void save('template')} disabled={!canSave} className="h-8 px-3 rounded-[var(--r-sm)] text-sm border transition-colors hover:bg-[var(--hover)] disabled:opacity-40" style={{ borderColor: 'var(--border)', color: 'var(--fg)' }} title="不用 AI：按模板摘录像约定的原话">
                {busy === 'template' ? '整理中…' : '按模板'}
              </button>
              <button onClick={() => void save('ai')} disabled={!canSave} className="h-8 px-3.5 rounded-[var(--r-sm)] text-sm font-medium inline-flex items-center gap-1.5 transition-opacity hover:opacity-90 disabled:opacity-40" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }} title="⌘↩">
                <IconSparkles width={13} height={13} />
                {busy === 'ai' ? 'AI 整理中…' : 'AI 整理并保存'}
              </button>
            </>
          ) : (
            <button onClick={() => void save('template')} disabled={!canSave} className="h-8 px-3.5 rounded-[var(--r-sm)] text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-40" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }} title="⌘↩">
              {busy === 'template' ? '整理中…' : '整理并保存'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
