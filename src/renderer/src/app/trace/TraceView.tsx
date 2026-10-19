import { useEffect, useMemo, useState } from 'react'
import { agreementLine, materialsText, TRACE_STATUS_LABEL, type TraceRecord, type TraceStatus, type TraceSyncStatus } from '@shared/trace'
import { api, fmtTime } from '../../lib/api'
import { fmtClock, fmtDay, openTraceCapture, STATUS_TONE, useTrace, useTraceEvents } from '../../lib/trace'
import { IconPlus, IconSearch, IconRefresh } from '../../components/icons'
import { MenuButton } from '../../components/Menu'
import { Seg, Chip, btn, btnStyle, btnPrimary, btnPrimaryStyle } from '../finance/ui'
import { TraceDetail } from './TraceDetail'
import { ChannelIcon, IconTrace } from './icons'

/* ================================================================
 * 留痕：电话 / 微信 / 会议 / 当面 / 其他 IM 里口头说定的事 → 可追溯的书面记录
 * - 时间线（按发生日期分组）· 按状态 / 参与人 / 时间筛选 · 搜索
 * - 详情：整理结果、书面确认进度、原始材料、关联、版本历史与内容哈希
 * ================================================================ */

type StatusFilter = 'all' | TraceStatus
type RangeFilter = 'all' | '7' | '30' | '90'
const DAY = 864e5

export function TraceView() {
  useTraceEvents()
  const { records, loaded } = useTrace()
  const [selected, setSelected] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [party, setParty] = useState('')
  const [range, setRange] = useState<RangeFilter>('all')
  const [sync, setSync] = useState<TraceSyncStatus | null>(null)

  useEffect(() => {
    const onOpen = (e: Event) => setSelected((e as CustomEvent<string>).detail)
    window.addEventListener('ms:trace-open', onOpen)
    void api.traceSyncStatus().then(setSync).catch(() => {})
    const off = api.onEvent(ev => {
      const e = ev as { type: string; status?: TraceSyncStatus }
      if (e.type === 'trace-sync-status' && e.status) setSync(e.status)
    })
    // 打开页面时顺手对一次书面确认（发出 / 回信）
    void api.traceCheckReplies().catch(() => {})
    return () => {
      window.removeEventListener('ms:trace-open', onOpen)
      void off()
    }
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

  const parties = useMemo(() => {
    const c = new Map<string, number>()
    for (const r of records) for (const p of r.data.parties) if (!p.me) c.set(p.name, (c.get(p.name) ?? 0) + 1)
    return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n)
  }, [records])

  const counts = useMemo(() => {
    const by: Record<string, number> = {}
    for (const r of records) by[r.data.status] = (by[r.data.status] ?? 0) + 1
    return by
  }, [records])

  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase()
    const since = range === 'all' ? null : Date.now() - Number(range) * DAY
    return records.filter(r => {
      if (status !== 'all' && r.data.status !== status) return false
      if (party && !r.data.parties.some(p => p.name === party)) return false
      if (since && (r.data.occurredAt ?? r.createdAt) < since) return false
      if (k) {
        const hay = `${r.title} ${r.data.parties.map(p => `${p.name} ${p.email ?? ''}`).join(' ')} ${r.data.summary?.conclusion ?? ''} ${(r.data.summary?.agreements ?? []).map(agreementLine).join(' ')} ${materialsText(r.data.materials)}`.toLowerCase()
        if (!hay.includes(k)) return false
      }
      return true
    })
  }, [records, q, status, party, range])

  const groups = useMemo(() => {
    const out: { day: string; items: TraceRecord[] }[] = []
    for (const r of filtered) {
      const day = fmtDay(r.data.occurredAt ?? r.createdAt)
      const last = out[out.length - 1]
      if (last && last.day === day) last.items.push(r)
      else out.push({ day, items: [r] })
    }
    return out
  }, [filtered])

  const sel = selected ? records.find(r => r.id === selected) ?? null : null
  const empty = loaded && !records.length
  const waiting = (counts.sent ?? 0) + (counts.organized ?? 0)

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <header className="drag-region shrink-0 px-6 pt-4 pb-3 flex flex-wrap items-end gap-3 border-b border-[var(--border)]">
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--fg)', letterSpacing: '-0.01em' }}>留痕</h1>
          <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            {empty ? '电话、微信、会议里口头说定的事，留下原话、整理约定、发书面确认' : (
              <>
                {records.length} 条记录
                {waiting > 0 && <span> · {waiting} 条还没拿到对方确认</span>}
                {(counts.disputed ?? 0) > 0 && <span style={{ color: 'var(--danger-ink)' }}> · {counts.disputed} 条有异议</span>}
              </>
            )}
          </div>
        </div>
        <MenuButton
          title="跨设备同步"
          width={280}
          className={btn}
          items={[
            { kind: 'label', label: sync?.ready ? `同步到你自己的邮箱（隐藏文件夹 ${sync.folder}${sync.encrypt ? '，口令加密' : ''}）` : sync?.readyReason ?? '跨设备同步' },
            {
              kind: 'check',
              label: '在我的设备之间同步留痕',
              checked: !!sync?.enabled,
              onSelect: () =>
                void api.traceSyncConfigure({ enabled: !sync?.enabled }).then(res => {
                  setSync(res.status)
                  window.dispatchEvent(new CustomEvent('ms:toast', { detail: res.ok ? (res.status.enabled ? '已开启留痕同步' : '已关闭留痕同步') : res.error }))
                })
            },
            ...(sync?.enabled ? [{ kind: 'action' as const, label: sync.running ? '同步中…' : `立即同步${sync.lastSyncAt ? `（上次 ${fmtTime(sync.lastSyncAt)}）` : ''}`, onSelect: () => void api.traceSyncNow().then(setSync) }] : []),
            ...(sync?.lastError ? [{ kind: 'label' as const, label: sync.lastError }] : [])
          ]}
        >
          <IconRefresh width={13} height={13} className={sync?.running ? 'spinning' : ''} />
          {sync?.enabled ? '同步已开' : '同步'}
        </MenuButton>
        <button className={btnPrimary} style={btnPrimaryStyle} onClick={() => openTraceCapture()} title="⌥⇧⌘L">
          <IconPlus width={13} height={13} /> 记一笔
        </button>
      </header>

      {!empty && (
        <div className="shrink-0 px-6 pt-3 pb-2 flex flex-wrap items-center gap-2.5">
          <label className="h-8 px-2.5 flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border)] focus-within:border-[var(--border-strong)] min-w-[180px] flex-1 max-w-[300px]" style={{ background: 'var(--surface-strong)' }}>
            <IconSearch width={13} height={13} style={{ color: 'var(--faint)' }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索标题、约定、原话、参与人…" className="flex-1 min-w-0 bg-transparent outline-none text-xs" style={{ color: 'var(--fg)' }} />
          </label>
          <Seg<StatusFilter>
            size="sm"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all' as StatusFilter, label: '全部' },
              ...(['draft', 'organized', 'sent', 'confirmed', 'disputed'] as TraceStatus[]).map(s => ({ value: s, label: TRACE_STATUS_LABEL[s], count: counts[s] ?? 0 }))
            ]}
          />
          <select value={party} onChange={e => setParty(e.target.value)} className="h-7 px-2 rounded-[var(--r-sm)] border border-[var(--border)] text-xs outline-none" style={{ background: 'var(--surface-strong)', color: 'var(--fg)' }} aria-label="参与人">
            <option value="">所有参与人</option>
            {parties.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select value={range} onChange={e => setRange(e.target.value as RangeFilter)} className="h-7 px-2 rounded-[var(--r-sm)] border border-[var(--border)] text-xs outline-none" style={{ background: 'var(--surface-strong)', color: 'var(--fg)' }} aria-label="时间">
            <option value="all">全部时间</option>
            <option value="7">最近 7 天</option>
            <option value="30">最近 30 天</option>
            <option value="90">最近 90 天</option>
          </select>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-y-auto">
          {!loaded && <div className="mt-16 text-center text-sm" style={{ color: 'var(--faint)' }}>加载中…</div>}
          {empty && <EmptyState />}
          {loaded && !empty && !filtered.length && <div className="mt-16 text-center text-sm" style={{ color: 'var(--faint)' }}>没有符合条件的留痕</div>}
          {loaded && !empty && (
            <div className="px-6 pb-8">
              {groups.map(g => (
                <div key={g.day} className="mt-3">
                  <div className="caps py-1.5" style={{ color: 'var(--faint)' }}>{g.day}</div>
                  <div className="flex flex-col gap-1.5">
                    {g.items.map(r => (
                      <TraceRow key={r.id} r={r} active={sel?.id === r.id} onOpen={() => setSelected(s => (s === r.id ? null : r.id))} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {sel && <TraceDetail key={sel.id} rec={sel} onClose={() => setSelected(null)} />}
      </div>
    </div>
  )
}

function TraceRow(props: { r: TraceRecord; active: boolean; onOpen(): void }) {
  const { r } = props
  const d = r.data
  const others = d.parties.filter(p => !p.me).map(p => p.name)
  const n = d.summary?.agreements.length ?? 0
  return (
    <button
      onClick={props.onOpen}
      className="w-full text-left rounded-[var(--r-md)] border px-3 py-2.5 flex items-start gap-3 transition-colors hover:border-[var(--border-strong)]"
      style={{ background: 'var(--surface-strong)', borderColor: props.active ? 'var(--fg)' : 'var(--border)' }}
    >
      <span className="w-8 h-8 rounded-full inline-flex items-center justify-center shrink-0" style={{ background: 'var(--hover)', color: 'var(--muted)' }}>
        <ChannelIcon channel={d.channel} width={15} height={15} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate" style={{ color: 'var(--fg)' }}>{r.title}</span>
        </div>
        <div className="text-2xs mt-0.5 truncate" style={{ color: 'var(--faint)' }}>
          {[
            d.occurredAt ? fmtClock(d.occurredAt) : '',
            others.length ? `${others.slice(0, 3).join('、')}${others.length > 3 ? ' 等' : ''}` : '',
            n ? `${n} 条约定` : '未整理',
            d.summary?.pending.length ? `${d.summary.pending.length} 处待确认` : ''
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
        {d.summary?.conclusion && d.summary.by !== 'template' && <div className="text-xs mt-1 line-clamp-1" style={{ color: 'var(--muted)' }}>{d.summary.conclusion}</div>}
      </div>
      <Chip tone={STATUS_TONE[d.status]}>{TRACE_STATUS_LABEL[d.status]}</Chip>
    </button>
  )
}

function EmptyState() {
  const items: [string, string][] = [
    ['随手记', '⌥⇧⌘L、Dock 或菜单栏「记一笔留痕…」：粘贴聊天、拖入截图、写几句电话里说定的事'],
    ['整理', 'AI 只依据原话整理结论、约定（谁 / 做什么 / 何时 / 金额）、待确认点和风险；没配 AI 时按模板摘录'],
    ['书面确认', '一键起草确认邮件（不会自动发送），对方回信后自动标「对方已确认」或「有异议」'],
    ['可追溯', '保留原始材料，每次修改留历史版本和内容哈希；可导出 PDF / Markdown，或发给自己存档']
  ]
  return (
    <div className="max-w-[580px] mx-auto mt-14 px-6">
      <div className="flex items-center gap-2 text-base font-semibold" style={{ color: 'var(--fg)' }}>
        <IconTrace width={18} height={18} /> 还没有留痕
      </div>
      <p className="mt-1.5 text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
        报价、交期、改需求、借款、租房约定、装修变更、领导口头交代……微信和电话里说定的事，过几周就说不清了。记一笔，需要时请对方书面确认。
      </p>
      <dl className="mt-5 flex flex-col gap-3">
        {items.map(([k, v]) => (
          <div key={k} className="flex gap-3 items-start">
            <dt className="shrink-0 w-[64px] pt-0.5 text-xs" style={{ color: 'var(--faint)' }}>{k}</dt>
            <dd className="text-sm leading-relaxed" style={{ color: 'var(--fg)' }}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-6 flex gap-2">
        <button className={btnPrimary} style={btnPrimaryStyle} onClick={() => openTraceCapture()}>
          <IconPlus width={13} height={13} /> 记一笔
        </button>
        <button className={btn} style={btnStyle} onClick={() => openTraceCapture({ text: SAMPLE })}>用示例试试</button>
      </div>
    </div>
  )
}

/** 示例（虚构人物与公司） */
const SAMPLE = `张伟 2026/10/18 14:32
客厅吊顶那块改成石膏线，增项 2400 元，材料费含在里面
我 2026/10/18 14:35
好的，没问题。那工期还是月底前完工吗？
张伟 2026/10/18 14:36
对，10月31日前完工。灯具颜色你再看看`
