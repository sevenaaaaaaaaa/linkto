import { useEffect, useRef, useState } from 'react'
import type { ComposeFollowup, FollowupKind } from '@shared/types'
import { FOLLOWUP_KIND_LABEL } from '@shared/followups'
import { IconClock } from '../../components/icons'

/**
 * 撰写窗底栏「发出后跟进」：默认关；Agent / 技能起草（带 followup）时默认开并预填。
 * 开启后真正发出（含延迟 / 定时到点发出）才登记为「等待对方」，N 天没回提醒并起草下一封催促。
 */
const DAY_CHOICES = [1, 3, 5, 7]
const KINDS: FollowupKind[] = ['reply', 'invoice', 'payment', 'document', 'unsubscribe', 'general']

export function FollowupToggle(props: { value: ComposeFollowup; onChange(v: ComposeFollowup): void }) {
  const v = props.value
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const days = v.waitDays ?? 3

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const set = (patch: Partial<ComposeFollowup>) => props.onChange({ ...v, ...patch })

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="cmp-fu-btn"
        data-on={v.enabled ? 'true' : 'false'}
        title={v.enabled ? `发出后 ${days} 天对方没回会提醒你（点击修改）` : '发出后跟进：对方 N 天没回提醒我，并起草下一封催促'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <IconClock width={13} height={13} />
        {v.enabled ? `${days} 天没回提醒` : '跟进'}
      </button>
      {open && (
        <div className="cmp-pop cmp-fu-pop pop-in" role="dialog" aria-label="发出后跟进">
          <label className="cmp-fu-row">
            <span className="flex-1">
              <span className="cmp-fu-title">发出后跟进</span>
              <span className="cmp-fu-desc">对方到期没回会提醒你，并起草一封催促（不会自动发送）</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={v.enabled}
              aria-label="发出后跟进"
              onClick={() => set({ enabled: !v.enabled })}
              className="cmp-fu-switch"
              data-on={v.enabled ? 'true' : 'false'}
            >
              <span />
            </button>
          </label>
          <div className="cmp-fu-sub" aria-disabled={!v.enabled}>
            <div className="cmp-menu-caption">几天没回算逾期</div>
            <div className="flex flex-wrap items-center gap-1 px-2 pb-1">
              {DAY_CHOICES.map(n => (
                <button key={n} type="button" className="cmp-fu-chip" data-on={days === n && !custom ? 'true' : 'false'} onClick={() => { setCustom(''); set({ enabled: true, waitDays: n }) }}>
                  {n} 天
                </button>
              ))}
              <input
                type="number"
                min={1}
                max={60}
                value={custom || (DAY_CHOICES.includes(days) ? '' : String(days))}
                onChange={e => {
                  setCustom(e.target.value)
                  const n = Math.round(Number(e.target.value))
                  if (n >= 1 && n <= 60) set({ enabled: true, waitDays: n })
                }}
                placeholder="自定义"
                className="cmp-fu-input w-[64px]"
                aria-label="自定义天数"
              />
            </div>
            <div className="cmp-menu-caption">在等对方做什么</div>
            <div className="flex items-center gap-1 px-2 pb-1">
              <select value={v.kind ?? ''} onChange={e => set({ enabled: true, kind: (e.target.value || undefined) as FollowupKind | undefined })} className="cmp-fu-input" aria-label="类型">
                <option value="">自动判断</option>
                {KINDS.map(k => (
                  <option key={k} value={k}>
                    {FOLLOWUP_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <input
                value={v.ask ?? ''}
                onChange={e => set({ enabled: true, ask: e.target.value })}
                placeholder="一句话，留空从正文推断"
                maxLength={80}
                className="cmp-fu-input flex-1 min-w-0"
                aria-label="在等对方做什么"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
