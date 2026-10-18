import { useMemo, useState } from 'react'
import { ledger, reconGroups, RECON_ISSUE_LABEL, sameParty, type ReconGroup, type FinanceItem } from '@shared/finance'
import { api } from '../../lib/api'
import type { FinanceRec } from '../../lib/finance'
import { Chip, Money, Seg, SectionTitle, btn, btnStyle, btnPrimary, btnPrimaryStyle, miniBtn, field, fieldStyle } from './ui'
import { Empty } from './Lists'
import type { RowActions } from './RecRow'

type Mode = 'todo' | 'pairs' | 'ledger'
type Period = 'all' | 'month' | 'last' | 'quarter' | 'year'

const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

function periodRange(p: Period, now: number): [number, number] | null {
  const d = new Date(now)
  if (p === 'month') return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()]
  if (p === 'last') return [new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), new Date(d.getFullYear(), d.getMonth(), 1).getTime()]
  if (p === 'quarter') {
    const q = Math.floor(d.getMonth() / 3) * 3
    return [new Date(d.getFullYear(), q, 1).getTime(), new Date(d.getFullYear(), q + 3, 1).getTime()]
  }
  if (p === 'year') return [new Date(d.getFullYear(), 0, 1).getTime(), new Date(d.getFullYear() + 1, 0, 1).getTime()]
  return null
}

const bag = (b: Record<string, number>) =>
  Object.keys(b).length ? (
    Object.entries(b).map(([c, n]) => (
      <div key={c}>
        <Money amount={n} currency={c} size="sm" />
      </div>
    ))
  ) : (
    <span style={{ color: 'var(--faint)' }}>—</span>
  )

/** 企业对账：待对账清单 · 发票 / 付款 / 回单三列配对 · 按对方的往来台账；手动配对 / 拆开；导出 CSV */
export function ReconView(props: { recs: FinanceRec[]; now: number; actions: RowActions; activeId: string | null }) {
  const [mode, setMode] = useState<Mode>('todo')
  const [party, setParty] = useState('')
  const [period, setPeriod] = useState<Period>('all')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const range = periodRange(period, props.now)

  const items: FinanceItem[] = useMemo(() => props.recs.map(r => ({ id: r.id, dueAt: r.dueAt, createdAt: r.createdAt, data: r.data, title: r.title, accountId: r.accountId })), [props.recs])
  const allGroups = useMemo(() => reconGroups(items), [items])
  const groups = allGroups.filter(g => (!party || sameParty(g.counterparty, party)) && (!range || (g.at >= range[0] && g.at < range[1])))
  const led = useMemo(() => ledger(items, groups), [items, groups])
  const issues = groups.filter(g => g.issues.some(i => i.type !== 'missing_receipt'))
  const parties = useMemo(() => [...new Set(allGroups.map(g => g.counterparty))].sort(), [allGroups])

  const toggle = (id: string) =>
    setPicked(s => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const pair = async () => {
    if (picked.size < 2) return
    await api.financePair([...picked])
    setPicked(new Set())
    toast('已手动配对')
  }
  const unpair = async (g: ReconGroup) => {
    await api.financeUnpair([...g.invoices, ...g.payments, ...g.receipts].map(i => i.id))
    toast('已拆开，自动对账不再改动这几条')
  }
  const exportCsv = async () => {
    const ids = groups.flatMap(g => [...g.invoices, ...g.payments, ...g.receipts].map(i => i.id))
    const res = await api.financeExportCsv({ ids, name: `对账-${party || '全部'}` })
    if (res.ok) toast(`已导出 ${res.count} 条到 ${res.path}`)
    else if (!res.canceled) toast(res.error ?? '导出失败')
  }

  return (
    <div className="px-6 pb-10">
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Seg
          size="sm"
          value={mode}
          onChange={v => setMode(v as Mode)}
          options={[
            { value: 'todo', label: '待对账', count: issues.length },
            { value: 'pairs', label: '配对' },
            { value: 'ledger', label: '往来台账' }
          ]}
        />
        <select value={party} onChange={e => setParty(e.target.value)} className={`${field} max-w-[180px]`} style={fieldStyle} aria-label="对方公司">
          <option value="">全部对方</option>
          {parties.map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select value={period} onChange={e => setPeriod(e.target.value as Period)} className={field} style={fieldStyle} aria-label="期间">
          <option value="all">全部期间</option>
          <option value="month">本月</option>
          <option value="last">上月</option>
          <option value="quarter">本季度</option>
          <option value="year">今年</option>
        </select>
        <span className="flex-1" />
        {picked.size > 0 && (
          <>
            <span className="text-2xs" style={{ color: 'var(--muted)' }}>已选 {picked.size} 条</span>
            <button className={btnPrimary} style={btnPrimaryStyle} disabled={picked.size < 2} onClick={() => void pair()}>
              配对所选
            </button>
            <button className={btn} style={btnStyle} onClick={() => setPicked(new Set())}>取消选择</button>
          </>
        )}
        <button className={btn} style={btnStyle} onClick={() => void exportCsv()} disabled={!groups.length} title="按当前对方 / 期间导出 CSV">
          导出 CSV
        </button>
      </div>

      {mode === 'ledger' && (
        <div className="mt-3 rounded-[var(--r-md)] border border-[var(--border)] overflow-x-auto" style={{ background: 'var(--surface-strong)' }}>
          <table className="w-full text-xs min-w-[640px]">
            <thead>
              <tr className="text-left" style={{ color: 'var(--faint)' }}>
                {['对方', '应付（发票）', '已付', '应收（发票）', '已收', '待对账', ''].map(h => (
                  <th key={h} className="caps font-normal px-3 py-2 border-b border-[var(--border)]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {led.map(l => (
                <tr key={l.counterparty} className="align-top hover:bg-[var(--hover)]">
                  <td className="px-3 py-2 border-b border-[var(--border-soft)]" style={{ color: 'var(--fg)' }}>
                    <div className="font-medium">{l.counterparty}</div>
                    <div className="text-2xs" style={{ color: 'var(--faint)' }}>{l.count} 条</div>
                  </td>
                  <td className="px-3 py-2 border-b border-[var(--border-soft)]">{bag(l.payable)}</td>
                  <td className="px-3 py-2 border-b border-[var(--border-soft)]">{bag(l.paid)}</td>
                  <td className="px-3 py-2 border-b border-[var(--border-soft)]">{bag(l.receivable)}</td>
                  <td className="px-3 py-2 border-b border-[var(--border-soft)]">{bag(l.received)}</td>
                  <td className="px-3 py-2 border-b border-[var(--border-soft)]">{l.issues ? <Chip tone="warn">{l.issues} 处</Chip> : <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                  <td className="px-3 py-2 border-b border-[var(--border-soft)] text-right whitespace-nowrap">
                    <button
                      className={miniBtn}
                      style={{ color: 'var(--fg)' }}
                      onClick={() => {
                        setParty(l.counterparty)
                        setMode('pairs')
                      }}
                    >
                      看明细
                    </button>{' '}
                    <button
                      className={miniBtn}
                      style={{ color: 'var(--muted)' }}
                      onClick={() =>
                        void api
                          .financeExportCsv({ counterparty: null, ids: allGroups.filter(g => sameParty(g.counterparty, l.counterparty) && (!range || (g.at >= range[0] && g.at < range[1]))).flatMap(g => [...g.invoices, ...g.payments, ...g.receipts].map(i => i.id)), name: `对账-${l.counterparty}` })
                          .then(res => (res.ok ? toast(`已导出 ${res.count} 条`) : !res.canceled && toast(res.error ?? '导出失败')))
                      }
                    >
                      导出
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!led.length && <Empty text="还没有企业往来的发票 / 付款 / 回单。" />}
        </div>
      )}

      {mode !== 'ledger' && (
        <>
          <div className="mt-3 hidden md:grid grid-cols-3 gap-2 px-3 caps" style={{ color: 'var(--faint)' }}>
            <span>发票</span>
            <span>付款通知</span>
            <span>银行回单</span>
          </div>
          <div className="mt-1 flex flex-col gap-2">
            {(mode === 'todo' ? issues : groups).map(g => (
              <GroupRow key={g.key} g={g} picked={picked} onPick={toggle} onUnpair={() => void unpair(g)} actions={props.actions} activeId={props.activeId} />
            ))}
          </div>
          {mode === 'todo' && !issues.length && <Empty text={groups.length ? '全部对上了：每笔都有发票、付款和一致的金额。' : '还没有企业往来的发票 / 付款 / 回单。'} />}
          {mode === 'pairs' && !groups.length && <Empty text="没有符合筛选的往来记录。" />}
          {mode === 'todo' && issues.length > 0 && (
            <p className="mt-3 text-2xs" style={{ color: 'var(--faint)' }}>
              勾选几条后点「配对所选」可手动配对；配错了用「拆开」。手动操作过的记录，自动对账不再改动。
            </p>
          )}
        </>
      )}
    </div>
  )
}

function GroupRow(props: { g: ReconGroup; picked: Set<string>; onPick(id: string): void; onUnpair(): void; actions: RowActions; activeId: string | null }) {
  const { g } = props
  const col = (list: FinanceItem[], empty: string, missing: boolean) => (
    <div className="flex flex-col gap-1 min-w-0">
      {list.map(it => (
        <div
          key={it.id}
          onClick={() => props.actions.onOpen(it.id)}
          className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--r-sm)] border cursor-default hover:border-[var(--border-strong)] min-w-0"
          style={{ borderColor: props.activeId === it.id ? 'var(--fg)' : 'var(--border)', background: 'var(--bg-soft)' }}
        >
          <input
            type="checkbox"
            checked={props.picked.has(it.id)}
            onClick={e => e.stopPropagation()}
            onChange={() => props.onPick(it.id)}
            aria-label="选中以手动配对"
          />
          <div className="flex-1 min-w-0">
            <Money amount={it.data.amount} currency={it.data.currency} size="sm" />
            <div className="text-2xs truncate" style={{ color: 'var(--faint)' }}>
              {new Date(it.data.events?.[0]?.at ?? it.createdAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
              {it.data.invoiceNo ? ` · ${it.data.invoiceNo}` : it.data.contractNo ? ` · ${it.data.contractNo}` : it.data.poNo ? ` · ${it.data.poNo}` : ''}
            </div>
          </div>
        </div>
      ))}
      {!list.length && (
        <div className="h-[42px] flex items-center justify-center rounded-[var(--r-sm)] border border-dashed text-2xs" style={{ borderColor: missing ? 'var(--warn)' : 'var(--border)', color: missing ? 'var(--warn-ink)' : 'var(--faint)' }}>
          {empty}
        </div>
      )}
    </div>
  )
  const types = new Set(g.issues.map(i => i.type))
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border)] px-3 py-2.5" style={{ background: 'var(--surface-strong)' }}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-sm font-medium truncate" style={{ color: 'var(--fg)' }}>{g.counterparty}</span>
        <Chip tone={g.direction === 'in' ? 'ok' : undefined}>{g.direction === 'in' ? '应收' : '应付'}</Chip>
        {g.issues
          .filter(i => i.type !== 'missing_receipt')
          .map(i => (
            <Chip key={i.type} tone={i.type === 'amount_mismatch' ? 'danger' : 'warn'} title={i.detail}>
              {RECON_ISSUE_LABEL[i.type]}
              {i.type === 'amount_mismatch' ? ` · ${i.detail.split(' · ').pop()}` : ''}
            </Chip>
          ))}
        {!g.issues.some(i => i.type !== 'missing_receipt') && <Chip tone="ok">已对上</Chip>}
        <span className="flex-1" />
        {g.matchId && (
          <button className={miniBtn} style={{ color: 'var(--muted)' }} onClick={props.onUnpair}>
            拆开
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {col(g.invoices, types.has('missing_invoice') ? '缺发票' : '—', types.has('missing_invoice'))}
        {col(g.payments, types.has('missing_payment') ? '缺付款' : '—', types.has('missing_payment'))}
        {col(g.receipts, g.payments.length ? '未见回单' : '—', false)}
      </div>
    </div>
  )
}

