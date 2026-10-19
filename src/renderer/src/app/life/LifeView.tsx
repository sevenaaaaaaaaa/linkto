import { useEffect, useMemo, useState } from 'react'
import type { LifeCategory } from '@shared/types'
import { daysUntil, lifeUrgency, LIFE_CATEGORY_LABEL } from '@shared/life'
import { api } from '../../lib/api'
import { useLife, useLifeEvents } from '../../lib/life'
import { IconPlus, IconRefresh, IconSearch, IconCalendar } from '../../components/icons'
import { Seg, btn, btnStyle, btnPrimary, btnPrimaryStyle } from '../finance/ui'
import { Timeline, CategoryBoard } from './LifeLists'
import { LifeCalendar } from './LifeCalendar'
import { LifeDetail } from './LifeDetail'
import { CategoryIcon } from './icons'

/* ================================================================
 * 生活档案：证件 / 保险 / 车辆 / 会员 / 域名 / 保修 / 合同 / 住房 / 税务 / 健康 / 教育 / 银行卡
 * - 收：邮件理解完成后自动识别（启发式优先，PDF 保单 / 合同读正文，拿不准时 AI 补充）；同一对象的多封邮件归并为一条
 * - 视图：时间线（默认，未来 12 个月按月）· 日历（可叠加财务）· 按类别
 * - 联动：提前提醒（系统通知）、生成待办（经待办外部同步进入提醒事项 / 日历）、导出 .ics、阅读页关联条
 * ================================================================ */

type Tab = 'timeline' | 'calendar' | 'category'
const TAB_KEY = 'ms_life_tab'
const SCAN_DAYS = 730
const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

export function LifeView() {
  useLifeEvents()
  const { records, loaded, scan } = useLife()
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem(TAB_KEY) as Tab) || 'timeline'
    } catch {
      return 'timeline'
    }
  })
  const [q, setQ] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [selected, setSelected] = useState<string | 'new' | null>(null)
  const [preset, setPreset] = useState<LifeCategory | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  // 提醒通知 / 阅读页关联条 / Agent 引用：打开指定条目
  useEffect(() => {
    const onOpen = (e: Event) => {
      const det = (e as CustomEvent<{ id: string | null; category: string | null }>).detail
      if (det?.id) setSelected(det.id)
      else if (det?.category) {
        setPreset(det.category as LifeCategory)
        setSelected('new')
      }
    }
    window.addEventListener('ms:life-open', onOpen)
    return () => window.removeEventListener('ms:life-open', onOpen)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const switchTab = (t: Tab) => {
    setTab(t)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      /* 本次生效 */
    }
  }

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase()
    if (!k) return records
    return records.filter(r => [r.title, r.data.subject, r.data.provider, r.data.reference, r.data.notes, LIFE_CATEGORY_LABEL[r.data.category]].filter(Boolean).join(' ').toLowerCase().includes(k))
  }, [records, q])

  const counts = useMemo(() => {
    const open = records.filter(r => r.status !== 'done')
    return {
      open: open.length,
      overdue: open.filter(r => lifeUrgency(r, now) === 'overdue').length,
      soon: open.filter(r => r.dueAt && daysUntil(r.dueAt, now) >= 0 && daysUntil(r.dueAt, now) <= 30).length,
      done: records.length - open.length
    }
  }, [records, now])

  const runScan = async () => {
    const res = await api.lifeScan(SCAN_DAYS)
    const r = res as typeof res & { ok?: boolean; error?: string }
    if (r.ok === false) toast(r.error ?? '扫描失败')
    else toast(res.created || res.merged ? `扫描了 ${res.scanned} 封：新增 ${res.created} 件，归并 ${res.merged} 封` : `扫描了 ${res.scanned} 封，没有发现新的到期事务`)
  }
  const exportIcs = async () => {
    const res = await api.lifeExportIcs(null)
    if (res.ok) toast(`已导出 ${res.count} 件到 ${res.path}（导入日历后到期前会按提醒天数提醒）`)
    else if (!res.canceled) toast(res.error ?? '导出失败')
  }
  const scanning = scan && !scan.finished
  const sel = selected && selected !== 'new' ? records.find(r => r.id === selected) ?? null : null
  const empty = loaded && !records.length
  const openNew = (c: LifeCategory | null) => {
    setPreset(c)
    setSelected('new')
  }

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <header className="drag-region shrink-0 px-6 pt-4 pb-3 flex flex-wrap items-end gap-3 border-b border-[var(--border)]">
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--fg)', letterSpacing: '-0.01em' }}>生活档案</h1>
          <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            {empty ? '证件、保险、年检、域名、会员、保修……到期前提醒你，不再错过' : (
              <>
                {counts.open} 件在档
                {counts.soon > 0 && <span style={{ color: 'var(--warn-ink)' }}> · {counts.soon} 件 30 天内到期</span>}
                {counts.overdue > 0 && <span style={{ color: 'var(--danger-ink)' }}> · {counts.overdue} 件已过期</span>}
              </>
            )}
          </div>
        </div>
        {!empty && (
          <Seg
            value={tab}
            onChange={switchTab}
            options={[
              { value: 'timeline', label: '时间线' },
              { value: 'calendar', label: '日历' },
              { value: 'category', label: '按类别' }
            ]}
          />
        )}
        {!empty && (
          <>
            <button className={btn} style={btnStyle} disabled={!!scanning} onClick={() => void runScan()} title="把最近 2 年的邮件过一遍，补收证件 / 保险 / 年检 / 域名 / 会员 / 保修等到期事务">
              <IconRefresh width={13} height={13} className={scanning ? 'spinning' : ''} />
              {scanning ? `扫描中 ${scan!.done}/${scan!.total}` : '扫描邮件'}
            </button>
            <button className={btn} style={btnStyle} onClick={() => void exportIcs()} title="导出 .ics：每件一个全天事件 + 提前提醒，可导入任何日历">
              <IconCalendar width={13} height={13} /> 导出 .ics
            </button>
            <button className={btnPrimary} style={btnPrimaryStyle} onClick={() => openNew(null)}>
              <IconPlus width={13} height={13} /> 新增
            </button>
          </>
        )}
      </header>

      {scanning && (
        <div className="shrink-0 h-0.5 w-full" style={{ background: 'var(--hover)' }} aria-hidden="true">
          <div className="h-full transition-[width]" style={{ width: `${scan!.total ? Math.round((scan!.done / scan!.total) * 100) : 0}%`, background: 'var(--fg)', transitionDuration: 'var(--dur-2)' }} />
        </div>
      )}

      {!empty && tab !== 'calendar' && (
        <div className="shrink-0 px-6 pt-3 pb-2 flex flex-wrap items-center gap-3">
          <label className="h-8 px-2.5 flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border)] focus-within:border-[var(--border-strong)] min-w-[200px] flex-1 max-w-[320px]" style={{ background: 'var(--surface-strong)' }}>
            <IconSearch width={13} height={13} style={{ color: 'var(--faint)' }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索对象、机构、编号尾号、备注…" className="flex-1 min-w-0 bg-transparent outline-none text-xs" style={{ color: 'var(--fg)' }} />
          </label>
          {tab === 'timeline' && counts.done > 0 && (
            <label className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
              <input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} />
              显示已办妥（{counts.done}）
            </label>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-y-auto">
          {!loaded && <div className="mt-16 text-center text-sm" style={{ color: 'var(--faint)' }}>加载中…</div>}
          {empty && <EmptyState scanning={!!scanning} progress={scanning ? `${scan!.done}/${scan!.total}` : ''} onScan={() => void runScan()} onAdd={() => openNew(null)} />}
          {loaded && !empty && (
            <>
              {tab === 'timeline' && <Timeline recs={filtered} now={now} activeId={sel?.id ?? null} showDone={showDone || !!q} onOpen={id => setSelected(s => (s === id ? null : id))} />}
              {tab === 'calendar' && <LifeCalendar recs={records} now={now} activeId={sel?.id ?? null} onOpen={id => setSelected(id)} />}
              {tab === 'category' && <CategoryBoard recs={filtered} filtered={!!q.trim()} now={now} activeId={sel?.id ?? null} onOpen={id => setSelected(s => (s === id ? null : id))} onAdd={c => openNew(c)} />}
            </>
          )}
        </div>
        {(sel || selected === 'new') && (
          <LifeDetail key={sel?.id ?? `new-${preset ?? ''}`} rec={sel} now={now} preset={preset} onClose={() => setSelected(null)} onCreated={id => setSelected(id)} />
        )}
      </div>
    </div>
  )
}

/** 空状态：说明能识别什么 + 一键回看 2 年 */
function EmptyState(props: { scanning: boolean; progress: string; onScan(): void; onAdd(): void }) {
  const items: [LifeCategory, string, string][] = [
    ['id-document', '证件', '护照、身份证、驾驶证、签证的有效期——护照提前半年提醒'],
    ['insurance', '保险', '车险、医疗险、意外险、家财险的续保日（含保单 PDF 里的保险期间）'],
    ['vehicle', '车辆', '机动车年检、检验有效期、保养提醒'],
    ['domain', '域名', '域名、SSL 证书、云主机的到期续费'],
    ['membership', '会员 · 保修', '健身房、年卡、会籍的到期与年费；保修卡、延保的截止'],
    ['housing', '住房 · 更多', '租房合同、物业费、个税汇算、体检预约、学费、信用卡年费']
  ]
  return (
    <div className="max-w-[580px] mx-auto mt-14 px-6">
      <div className="text-base font-semibold" style={{ color: 'var(--fg)' }}>还没有生活事务</div>
      <p className="mt-1.5 text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
        邮件里散落着各种「到期 / 续期 / 定期要办」的事。新邮件读懂后会自动收进来；这类事一年一次，建议先把最近 2 年的邮件过一遍——只在本机识别，AI 已配置时才用它补充拿不准的那几封。营销邮件里的「会员日」「优惠券有效期」不会收。
      </p>
      <dl className="mt-5 flex flex-col gap-3">
        {items.map(([k, label, v]) => (
          <div key={k} className="flex gap-3 items-start">
            <dt className="shrink-0 w-[84px] pt-0.5 inline-flex items-center gap-1.5 text-xs whitespace-nowrap" style={{ color: 'var(--faint)' }}>
              <CategoryIcon category={k} width={13} height={13} />
              {label}
            </dt>
            <dd className="text-sm leading-relaxed" style={{ color: 'var(--fg)' }}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-6 flex gap-2">
        <button className={btnPrimary} style={btnPrimaryStyle} disabled={props.scanning} onClick={props.onScan}>
          <IconRefresh width={13} height={13} className={props.scanning ? 'spinning' : ''} />
          {props.scanning ? `正在扫描 ${props.progress}` : '扫描最近 2 年邮件'}
        </button>
        <button className={btn} style={btnStyle} onClick={props.onAdd}>手动添加</button>
      </div>
    </div>
  )
}
