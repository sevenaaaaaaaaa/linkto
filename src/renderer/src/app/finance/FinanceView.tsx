import { useEffect, useMemo, useState } from 'react'
import { effectiveStatus, isReconKind, FINANCE_STATUS_LABEL } from '@shared/finance'
import type { FinanceStatus } from '@shared/types'
import { api } from '../../lib/api'
import { useMail } from '../../stores/mail'
import { isBillish, useFinance, useFinanceEvents, type FinanceRec } from '../../lib/finance'
import { IconPlus, IconSearch, IconRefresh } from '../../components/icons'
import { Overview, type Tab } from './Overview'
import { BillsView, SubsView, OrdersView } from './Lists'
import { ReconView } from './Recon'
import { CalendarView } from './CalendarView'
import { FinanceDetail } from './Detail'
import type { RowActions } from './RecRow'
import { Seg, btn, btnStyle, btnPrimary, btnPrimaryStyle, field, fieldStyle } from './ui'

/* ================================================================
 * 财务：账单 · 订阅 · 电商订单 · 企业对账
 * - 收：邮件理解完成后自动识别（启发式优先，拿不准时 AI 补充）；同一笔钱的多封邮件归并为一条
 * - 视图：概览 · 账单 · 订阅 · 订单 · 对账 · 日历
 * - 联动：每条款项可跳回全部关联邮件；一键标记已付 / 生成提醒待办；阅读页显示「款项」关联条
 * ================================================================ */

const TAB_KEY = 'ms_fin_tab'
const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

interface Filters {
  account: string
  category: string
  currency: string
  direction: '' | 'out' | 'in'
  status: '' | FinanceStatus
}
const NO_FILTERS: Filters = { account: '', category: '', currency: '', direction: '', status: '' }

export function FinanceView() {
  useFinanceEvents()
  const { records, idle, loaded, scan } = useFinance()
  const accounts = useMail(st => st.accounts)
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem(TAB_KEY) as Tab) || 'overview'
    } catch {
      return 'overview'
    }
  })
  const [q, setQ] = useState('')
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [selected, setSelected] = useState<string | 'new' | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  // 提醒通知 / 阅读页关联条：打开指定款项
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      if (!id) return
      setSelected(id)
      const r = useFinance.getState().records.find(x => x.id === id)
      if (r) setTab(r.data.kind === 'subscription' ? 'subs' : r.data.kind === 'order' ? 'orders' : isReconKind(r.data) && (r.data.kind !== 'invoice' || r.data.matchId) ? 'recon' : tab === 'calendar' ? 'calendar' : 'bills')
    }
    window.addEventListener('ms:finance-open', onOpen)
    return () => window.removeEventListener('ms:finance-open', onOpen)
  }, [tab])

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

  const categories = useMemo(() => [...new Set(records.map(r => r.data.category).filter((x): x is string => !!x))].sort(), [records])
  const currencies = useMemo(() => [...new Set(records.map(r => r.data.currency))].sort(), [records])
  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase()
    return records.filter(r => {
      const d = r.data
      if (filters.account && r.accountId !== filters.account) return false
      if (filters.category && d.category !== filters.category) return false
      if (filters.currency && d.currency !== filters.currency) return false
      if (filters.direction && d.direction !== filters.direction) return false
      if (filters.status && effectiveStatus(d, r.dueAt, now) !== filters.status) return false
      if (!k) return true
      const hay = [r.title, d.counterparty, d.category, d.orderNo, d.invoiceNo, d.poNo, d.contractNo, d.tracking, d.notes, d.shop, d.amount != null ? String(d.amount) : '', ...(d.items ?? []).map(i => i.name)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(k)
    })
  }, [records, filters, q, now])

  const actions: RowActions = {
    onOpen: id => setSelected(s => (s === id ? null : id)),
    onPaid: (id, paid) => void api.financeMarkPaid(id, paid).then(() => toast(paid ? '已标记为已付' : '已撤销')),
    onTodo: id => void api.financeMakeTodo(id).then(t => toast(t ? '已生成提醒待办（侧栏「待办」查看）' : '没能生成待办'))
  }

  const runScan = async (days = 90) => {
    const res = await api.financeScan(days)
    if (!res.ok) toast(res.error ?? '扫描失败')
    else toast(res.created || res.merged ? `扫描了 ${res.scanned} 封：新增 ${res.created} 笔，归并 ${res.merged} 封` : `扫描了 ${res.scanned} 封，没有发现新的款项`)
  }
  const scanning = scan && !scan.finished

  const counts = useMemo(() => {
    const open = (r: FinanceRec) => ['pending', 'overdue'].includes(effectiveStatus(r.data, r.dueAt, now))
    return {
      bills: filtered.filter(r => isBillish(r.data) && open(r)).length,
      subs: filtered.filter(r => r.data.kind === 'subscription' && r.data.status !== 'cancelled').length,
      orders: filtered.filter(r => r.data.kind === 'order' && r.data.logistics !== 'delivered' && r.data.status !== 'refunded').length,
      overdue: filtered.filter(r => effectiveStatus(r.data, r.dueAt, now) === 'overdue' && r.data.direction === 'out').length
    }
  }, [filtered, now])

  const anyFilter = q || Object.values(filters).some(Boolean)
  const sel = selected && selected !== 'new' ? records.find(r => r.id === selected) ?? null : null
  const empty = loaded && !records.length

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <header className="drag-region shrink-0 px-6 pt-4 pb-3 flex flex-wrap items-end gap-3 border-b border-[var(--border)]">
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--fg)', letterSpacing: '-0.01em' }}>财务</h1>
          <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            {empty ? '账单 · 订阅 · 订单 · 对账，从邮件里自动整理' : (
              <>
                {counts.bills} 笔待付 · {counts.subs} 个订阅 · {counts.orders} 个订单在路上
                {counts.overdue > 0 && <span style={{ color: 'var(--danger-ink)' }}> · {counts.overdue} 笔逾期</span>}
              </>
            )}
          </div>
        </div>
        {!empty && (
          <Seg
            value={tab}
            onChange={switchTab}
            options={[
              { value: 'overview', label: '概览' },
              { value: 'bills', label: '账单' },
              { value: 'subs', label: '订阅' },
              { value: 'orders', label: '订单' },
              { value: 'recon', label: '对账' },
              { value: 'calendar', label: '日历' }
            ]}
          />
        )}
        {!empty && (
          <>
            <button className={btn} style={btnStyle} disabled={!!scanning} onClick={() => void runScan(90)} title="把最近 90 天的邮件过一遍，补收账单 / 订阅 / 订单 / 往来款项">
              <IconRefresh width={13} height={13} className={scanning ? 'spinning' : ''} />
              {scanning ? `扫描中 ${scan!.done}/${scan!.total}` : '扫描邮件'}
            </button>
            <button className={btnPrimary} style={btnPrimaryStyle} onClick={() => setSelected('new')}>
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

      {!empty && (
        <div className="shrink-0 px-6 pt-3 pb-2 flex flex-wrap items-center gap-2">
          <label className="h-8 px-2.5 flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border)] focus-within:border-[var(--border-strong)] min-w-[200px] flex-1 max-w-[320px]" style={{ background: 'var(--surface-strong)' }}>
            <IconSearch width={13} height={13} style={{ color: 'var(--faint)' }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索商家、订单号、发票号、金额…" className="flex-1 min-w-0 bg-transparent outline-none text-xs" style={{ color: 'var(--fg)' }} />
          </label>
          {accounts.length > 1 && (
            <select value={filters.account} onChange={e => setFilters({ ...filters, account: e.target.value })} className={field} style={fieldStyle} aria-label="账户">
              <option value="">全部账户</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          )}
          <select value={filters.category} onChange={e => setFilters({ ...filters, category: e.target.value })} className={field} style={fieldStyle} aria-label="分类">
            <option value="">全部分类</option>
            {categories.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          {currencies.length > 1 && (
            <select value={filters.currency} onChange={e => setFilters({ ...filters, currency: e.target.value })} className={field} style={fieldStyle} aria-label="币种">
              <option value="">全部币种</option>
              {currencies.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}
          <select value={filters.direction} onChange={e => setFilters({ ...filters, direction: e.target.value as Filters['direction'] })} className={field} style={fieldStyle} aria-label="方向">
            <option value="">收支</option>
            <option value="out">支出 / 应付</option>
            <option value="in">收入 / 应收</option>
          </select>
          <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value as Filters['status'] })} className={field} style={fieldStyle} aria-label="状态">
            <option value="">全部状态</option>
            {Object.entries(FINANCE_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          {anyFilter && (
            <button
              onClick={() => {
                setQ('')
                setFilters(NO_FILTERS)
              }}
              className="text-xs underline underline-offset-2"
              style={{ color: 'var(--faint)' }}
            >
              清除筛选
            </button>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-y-auto">
          {!loaded && <div className="mt-16 text-center text-sm" style={{ color: 'var(--faint)' }}>加载中…</div>}
          {empty && <EmptyState scanning={!!scanning} onScan={() => void runScan(90)} onAdd={() => setSelected('new')} />}
          {loaded && !empty && (
            <>
              {tab === 'overview' && <Overview recs={filtered} idle={idle} now={now} actions={actions} activeId={sel?.id ?? null} onTab={switchTab} />}
              {tab === 'bills' && <BillsView recs={filtered} now={now} actions={actions} activeId={sel?.id ?? null} />}
              {tab === 'subs' && <SubsView recs={filtered} idle={idle} now={now} actions={actions} activeId={sel?.id ?? null} />}
              {tab === 'orders' && <OrdersView recs={filtered} now={now} actions={actions} activeId={sel?.id ?? null} />}
              {tab === 'recon' && <ReconView recs={filtered} now={now} actions={actions} activeId={sel?.id ?? null} />}
              {tab === 'calendar' && <CalendarView recs={filtered} now={now} actions={actions} activeId={sel?.id ?? null} />}
            </>
          )}
        </div>
        {(sel || selected === 'new') && (
          <FinanceDetail
            key={sel?.id ?? 'new'}
            rec={sel}
            now={now}
            categories={categories}
            onClose={() => setSelected(null)}
            onCreated={id => setSelected(id)}
          />
        )}
      </div>
    </div>
  )
}

/** 空状态：说明能自动识别什么 + 一键回填 */
function EmptyState(props: { scanning: boolean; onScan(): void; onAdd(): void }) {
  const items: [string, string][] = [
    ['账单', '信用卡、水电、通讯、云服务账单；催缴、付款成功、发票自动归到同一笔'],
    ['订阅', '续费 / 自动扣款 / 试用即将结束 / 调价；推断周期、下次续费日与年化成本，找出管理 / 取消入口'],
    ['订单', '下单 → 发货 → 派送 → 签收，店铺、商品、金额与运单号'],
    ['对账', '企业邮箱里的发票、付款通知、银行回单按对方公司建台账，自动配对并列出缺发票 / 缺付款 / 金额不符']
  ]
  return (
    <div className="max-w-[560px] mx-auto mt-14 px-6">
      <div className="text-base font-semibold" style={{ color: 'var(--fg)' }}>还没有款项</div>
      <p className="mt-1.5 text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
        新邮件读懂后会自动收进来。也可以先把最近 90 天的邮件过一遍——只在本机识别，AI 已配置时才用它补充拿不准的那几封。
      </p>
      <dl className="mt-5 flex flex-col gap-3">
        {items.map(([k, v]) => (
          <div key={k} className="flex gap-3">
            <dt className="caps w-10 shrink-0 pt-0.5" style={{ color: 'var(--faint)' }}>{k}</dt>
            <dd className="text-sm leading-relaxed" style={{ color: 'var(--fg)' }}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-6 flex gap-2">
        <button className={btnPrimary} style={btnPrimaryStyle} disabled={props.scanning} onClick={props.onScan}>
          <IconRefresh width={13} height={13} className={props.scanning ? 'spinning' : ''} />
          {props.scanning ? '正在扫描…' : '扫描最近 90 天邮件'}
        </button>
        <button className={btn} style={btnStyle} onClick={props.onAdd}>手动新增</button>
      </div>
    </div>
  )
}
