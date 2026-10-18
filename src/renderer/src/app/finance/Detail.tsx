import { useEffect, useState } from 'react'
import type { FinanceData, FinanceKind, FinanceStatus, FinanceCycle, FinanceLogistics } from '@shared/types'
import type { FinanceMessageRef } from '@shared/ipc'
import { annualCost, effectiveStatus, FINANCE_CYCLE_LABEL, FINANCE_KIND_LABEL, FINANCE_STATUS_LABEL } from '@shared/finance'
import { api, fmtTime } from '../../lib/api'
import { fmtMoney, useFinance, type FinanceRec } from '../../lib/finance'
import { IconClose } from '../../components/icons'
import { openMail } from './RecRow'
import { PdfCheckLine } from './PdfCheck'
import { goView } from '../../lib/route'
import { Chip, Money, StatusChip, btn, btnStyle, btnPrimary, btnPrimaryStyle, field, fieldStyle } from './ui'

const CURRENCIES = ['CNY', 'USD', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'AUD', 'CAD']
const LOGI: { v: FinanceLogistics; l: string }[] = [
  { v: 'ordered', l: '已下单' },
  { v: 'shipped', l: '已发货' },
  { v: 'in_transit', l: '派送中' },
  { v: 'delivered', l: '已签收' }
]

const toDate = (ts: number | null | undefined) => {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const fromDate = (s: string) => (s ? new Date(`${s}T23:59:00`).getTime() : null)
const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

/** 新建时的空白款项 */
export function blankFinance(): FinanceData {
  return { kind: 'bill', direction: 'out', counterparty: '', amount: null, currency: 'CNY', status: 'pending', messageIds: [], source: 'manual' }
}

/**
 * 款项详情 / 编辑器（右侧抽屉）：覆盖 FinanceData 各维度；经过时间线；全部关联邮件；
 * 标记已付、生成提醒待办、管理订阅、删除。rec 为 null 时是新建。
 */
export function FinanceDetail(props: { rec: FinanceRec | null; now: number; categories: string[]; onClose(): void; onCreated(id: string): void }) {
  const r = props.rec
  const [draft, setDraft] = useState<FinanceData>(() => (r ? r.data : blankFinance()))
  const [title, setTitle] = useState(r?.title ?? '')
  const [dueAt, setDueAt] = useState<number | null>(r?.dueAt ?? null)
  const [mails, setMails] = useState<FinanceMessageRef[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft(r ? r.data : blankFinance())
    setTitle(r?.title ?? '')
    setDueAt(r?.dueAt ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r?.id, r?.data.updatedAt])

  const ids = r?.data.messageIds ?? []
  useEffect(() => {
    if (!ids.length) return setMails([])
    let alive = true
    void api.financeMessages(ids).then(m => alive && setMails(m))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')])

  const d = draft
  /** 已有记录：改一项立即保存；新建：只改草稿 */
  const set = <K extends keyof FinanceData>(k: K, v: FinanceData[K]) => {
    setDraft(x => ({ ...x, [k]: v }))
    if (r) void api.financeUpdate(r.id, { data: { [k]: v } as Partial<FinanceData> }).then(() => useFinance.getState().load())
  }
  const saveDue = (v: number | null) => {
    setDueAt(v)
    if (r) void api.financeUpdate(r.id, { dueAt: v }).then(() => useFinance.getState().load())
  }
  const saveTitle = () => {
    if (r && title.trim() && title !== r.title) void api.financeUpdate(r.id, { title: title.trim() }).then(() => useFinance.getState().load())
  }
  const create = async () => {
    if (!d.counterparty.trim()) return toast('先填对方 / 商家')
    setBusy(true)
    const id = await api.financeCreate({ title: title.trim() || d.counterparty, dueAt, data: { ...d, dueAt } })
    setBusy(false)
    await useFinance.getState().load()
    props.onCreated(id)
  }

  const st = r ? effectiveStatus(r.data, r.dueAt, props.now) : d.status
  const open = st === 'pending' || st === 'overdue'
  const label = 'flex flex-col gap-1 text-2xs min-w-0'
  const lc = { color: 'var(--faint)' }
  const input = `${field} w-full`
  const isSub = d.kind === 'subscription'
  const isOrder = d.kind === 'order' || d.kind === 'refund'
  const isCorp = d.kind === 'invoice' || d.kind === 'payment' || d.kind === 'receipt'

  return (
    <aside className="w-[380px] max-w-[46%] shrink-0 h-full border-l border-[var(--border)] flex flex-col fade-in" style={{ background: 'var(--bg)' }} aria-label="款项详情">
      <div className="shrink-0 px-4 pt-3 pb-2.5 flex items-start gap-2 border-b border-[var(--border)]">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="caps" style={{ color: 'var(--faint)' }}>{r ? FINANCE_KIND_LABEL[d.kind] : '新增款项'}</span>
            {r && <StatusChip status={st} kind={d.kind} />}
            {r?.data.source === 'ai' && <Chip tone="ai">AI 识别</Chip>}
            {r?.data.source === 'heuristic' && <Chip title="由邮件内容规则自动识别">自动识别</Chip>}
          </div>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            onBlur={saveTitle}
            placeholder={r ? '' : '标题（可留空，用对方名）'}
            className="mt-1 w-full bg-transparent outline-none text-base font-semibold"
            style={{ color: 'var(--fg)' }}
          />
          {r && (
            <div className="mt-0.5">
              <Money amount={d.amount} currency={d.currency} direction={d.direction} size="xl" />
              {isSub && annualCost(d) != null && (
                <span className="ml-2 text-2xs tnum" style={{ color: 'var(--faint)' }}>年化 {fmtMoney(annualCost(d), d.currency)}</span>
              )}
            </div>
          )}
        </div>
        <button onClick={props.onClose} className="icon-btn w-7 h-7 inline-flex items-center justify-center" aria-label="关闭" style={{ color: 'var(--faint)' }}>
          <IconClose width={13} height={13} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-4">
        {r && (
          <div className="flex flex-wrap gap-1.5">
            {d.kind !== 'subscription' && (
              <button className={open ? btnPrimary : btn} style={open ? btnPrimaryStyle : btnStyle} onClick={() => void api.financeMarkPaid(r.id, open).then(() => toast(open ? '已标记为已付' : '已撤销'))}>
                {open ? (d.direction === 'in' ? '标记已收' : '标记已付') : '撤销已付'}
              </button>
            )}
            {isSub && d.status !== 'cancelled' && (
              <button className={btn} style={btnStyle} onClick={() => void api.financeMarkPaid(r.id, true).then(() => toast('本期已续费，下次续费日已顺延'))} title="本期已续费：顺延到下一期">
                本期已续费
              </button>
            )}
            {(open || isSub) && (
              <button
                className={btn}
                style={btnStyle}
                onClick={() =>
                  void api.financeMakeTodo(r.id).then(id => {
                    if (!id) return toast('没能生成待办')
                    if (!d.todoId) return toast('已生成提醒待办（侧栏「待办」查看）')
                    goView('todo')
                    setTimeout(() => window.dispatchEvent(new CustomEvent('ms:todo-open', { detail: id })), 250)
                  })
                }
              >
                {d.todoId ? '查看提醒待办' : '提醒待办'}
              </button>
            )}
            {d.manageUrl && (
              <button className={btn} style={btnStyle} onClick={() => void api.openExternal(d.manageUrl!)} title={d.manageUrl}>
                管理 / 取消 ↗
              </button>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <label className={label}>
            <span style={lc}>类型</span>
            <select value={d.kind} onChange={e => set('kind', e.target.value as FinanceKind)} className={input} style={fieldStyle}>
              {Object.entries(FINANCE_KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label className={label}>
            <span style={lc}>方向</span>
            <select value={d.direction} onChange={e => set('direction', e.target.value as 'out' | 'in')} className={input} style={fieldStyle}>
              <option value="out">支出 / 应付</option>
              <option value="in">收入 / 应收</option>
            </select>
          </label>
          <label className={`${label} col-span-2`}>
            <span style={lc}>对方 / 商家</span>
            <input defaultValue={d.counterparty} key={`cp-${r?.id}`} onBlur={e => e.target.value.trim() !== d.counterparty && set('counterparty', e.target.value.trim())} onChange={e => !r && setDraft(x => ({ ...x, counterparty: e.target.value }))} className={input} style={fieldStyle} />
          </label>
          <label className={label}>
            <span style={lc}>金额</span>
            <input
              type="number"
              step="0.01"
              key={`amt-${r?.id}-${d.amount}`}
              defaultValue={d.amount ?? ''}
              onBlur={e => {
                const v = e.target.value === '' ? null : Number(e.target.value)
                if (v !== d.amount && (v == null || Number.isFinite(v))) set('amount', v)
              }}
              className={`${input} tnum`}
              style={{ ...fieldStyle, fontFamily: 'var(--font-mono)' }}
            />
          </label>
          <label className={label}>
            <span style={lc}>币种</span>
            <select value={d.currency} onChange={e => set('currency', e.target.value)} className={input} style={fieldStyle}>
              {[...new Set([d.currency, ...CURRENCIES])].map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className={label}>
            <span style={lc}>状态</span>
            <select value={d.status} onChange={e => set('status', e.target.value as FinanceStatus)} className={input} style={fieldStyle}>
              {Object.entries(FINANCE_STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{isSub && k === 'cancelled' ? '不再续费' : v}</option>
              ))}
            </select>
          </label>
          <label className={label}>
            <span style={lc}>分类</span>
            <input list="fin-categories" defaultValue={d.category ?? ''} key={`cat-${r?.id}`} onBlur={e => (e.target.value.trim() || null) !== (d.category ?? null) && set('category', e.target.value.trim() || null)} className={input} style={fieldStyle} />
            <datalist id="fin-categories">
              {props.categories.map(c => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className={label}>
            <span style={lc}>{isSub ? '下次续费' : '应付日'}</span>
            <input type="date" value={toDate(dueAt)} onChange={e => saveDue(fromDate(e.target.value))} className={input} style={fieldStyle} />
          </label>
          <label className={label}>
            <span style={lc}>付款日</span>
            <input type="date" value={toDate(d.paidAt)} onChange={e => set('paidAt', fromDate(e.target.value))} className={input} style={fieldStyle} />
          </label>
          <label className={label}>
            <span style={lc}>账期起</span>
            <input type="date" value={toDate(d.periodStart)} onChange={e => set('periodStart', fromDate(e.target.value))} className={input} style={fieldStyle} />
          </label>
          <label className={label}>
            <span style={lc}>账期止</span>
            <input type="date" value={toDate(d.periodEnd)} onChange={e => set('periodEnd', fromDate(e.target.value))} className={input} style={fieldStyle} />
          </label>

          {isSub && (
            <>
              <label className={label}>
                <span style={lc}>周期</span>
                <select value={d.cycle ?? ''} onChange={e => set('cycle', (e.target.value || null) as FinanceCycle | null)} className={input} style={fieldStyle}>
                  <option value="">未知</option>
                  {Object.entries(FINANCE_CYCLE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
              <label className={label}>
                <span style={lc}>试用结束</span>
                <input type="date" value={toDate(d.trialEndsAt)} onChange={e => set('trialEndsAt', fromDate(e.target.value))} className={input} style={fieldStyle} />
              </label>
              <label className={`${label} col-span-2`}>
                <span style={lc}>管理 / 取消订阅链接</span>
                <input defaultValue={d.manageUrl ?? ''} key={`mu-${r?.id}`} onBlur={e => (e.target.value.trim() || null) !== (d.manageUrl ?? null) && set('manageUrl', e.target.value.trim() || null)} placeholder="https://" className={input} style={fieldStyle} />
              </label>
            </>
          )}
          {isOrder && (
            <>
              <label className={label}>
                <span style={lc}>店铺</span>
                <input defaultValue={d.shop ?? ''} key={`shop-${r?.id}`} onBlur={e => (e.target.value.trim() || null) !== (d.shop ?? null) && set('shop', e.target.value.trim() || null)} className={input} style={fieldStyle} />
              </label>
              <label className={label}>
                <span style={lc}>物流</span>
                <select value={d.logistics ?? ''} onChange={e => set('logistics', (e.target.value || null) as FinanceLogistics | null)} className={input} style={fieldStyle}>
                  <option value="">—</option>
                  {LOGI.map(x => (
                    <option key={x.v} value={x.v}>{x.l}</option>
                  ))}
                </select>
              </label>
              <label className={label}>
                <span style={lc}>订单号</span>
                <input defaultValue={d.orderNo ?? ''} key={`on-${r?.id}`} onBlur={e => (e.target.value.trim() || null) !== (d.orderNo ?? null) && set('orderNo', e.target.value.trim() || null)} className={`${input} tnum`} style={fieldStyle} />
              </label>
              <label className={label}>
                <span style={lc}>运单号</span>
                <input defaultValue={d.tracking ?? ''} key={`tk-${r?.id}`} onBlur={e => (e.target.value.trim() || null) !== (d.tracking ?? null) && set('tracking', e.target.value.trim() || null)} className={`${input} tnum`} style={fieldStyle} />
              </label>
              {!!d.items?.length && (
                <div className="col-span-2 text-2xs" style={{ color: 'var(--muted)' }}>
                  <span style={lc}>商品</span>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {d.items.map((it, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="flex-1 truncate" style={{ color: 'var(--fg)' }}>{it.name}</span>
                        {it.qty ? <span className="tnum">×{it.qty}</span> : null}
                        {it.price != null ? <span className="tnum">{fmtMoney(it.price, d.currency)}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          {(isCorp || d.kind === 'bill') && (
            <>
              <label className={label}>
                <span style={lc}>发票号</span>
                <input defaultValue={d.invoiceNo ?? ''} key={`inv-${r?.id}`} onBlur={e => (e.target.value.trim() || null) !== (d.invoiceNo ?? null) && set('invoiceNo', e.target.value.trim() || null)} className={`${input} tnum`} style={fieldStyle} />
              </label>
              <label className={label}>
                <span style={lc}>PO 号</span>
                <input defaultValue={d.poNo ?? ''} key={`po-${r?.id}`} onBlur={e => (e.target.value.trim() || null) !== (d.poNo ?? null) && set('poNo', e.target.value.trim() || null)} className={`${input} tnum`} style={fieldStyle} />
              </label>
              <label className={`${label} col-span-2`}>
                <span style={lc}>合同号</span>
                <input defaultValue={d.contractNo ?? ''} key={`ct-${r?.id}`} onBlur={e => (e.target.value.trim() || null) !== (d.contractNo ?? null) && set('contractNo', e.target.value.trim() || null)} className={`${input} tnum`} style={fieldStyle} />
              </label>
            </>
          )}
          <label className={`${label} col-span-2`}>
            <span style={lc}>备注</span>
            <textarea
              defaultValue={d.notes ?? ''}
              key={`nt-${r?.id}`}
              rows={2}
              onBlur={e => (e.target.value || null) !== (d.notes ?? null) && set('notes', e.target.value || null)}
              className="px-2 py-1.5 rounded-[var(--r-xs)] border border-[var(--border)] text-xs outline-none resize-y"
              style={fieldStyle}
            />
          </label>
        </div>

        {!r && (
          <div className="flex gap-2">
            <button className={btnPrimary} style={btnPrimaryStyle} disabled={busy} onClick={() => void create()}>
              保存
            </button>
            <button className={btn} style={btnStyle} onClick={props.onClose}>取消</button>
          </div>
        )}

        {r && d.pdfCheck && <PdfCheckLine check={d.pdfCheck} amount={d.amount} currency={d.currency} invoiceNo={d.invoiceNo} />}

        {r && !!d.events?.length && (
          <section>
            <div className="caps mb-1.5" style={{ color: 'var(--faint)' }}>经过</div>
            <ol className="relative flex flex-col gap-2 pl-4">
              <span className="absolute left-[4px] top-1.5 bottom-1.5 w-px" style={{ background: 'var(--border-strong)' }} />
              {d.events.map((e, i) => (
                <li key={i} className="relative flex items-baseline gap-2 text-xs">
                  <span className="absolute -left-4 top-[5px] w-[9px] h-[9px] rounded-full border" style={{ background: i === d.events!.length - 1 ? 'var(--fg)' : 'var(--surface-strong)', borderColor: 'var(--fg)' }} />
                  <span className="tnum shrink-0 w-[74px]" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{fmtTime(e.at)}</span>
                  <span className="flex-1 min-w-0" style={{ color: 'var(--fg)' }}>{e.label ?? e.kind}</span>
                  {e.amount != null && <Money amount={e.amount} currency={d.currency} size="sm" muted />}
                  {e.messageId && (
                    <button onClick={() => openMail(e.messageId!)} className="text-2xs underline underline-offset-2 shrink-0" style={{ color: 'var(--muted)' }}>
                      邮件
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        {r && (
          <section>
            <div className="caps mb-1.5" style={{ color: 'var(--faint)' }}>关联邮件 · {mails.length}</div>
            <div className="flex flex-col gap-1">
              {mails.map(m => (
                <button key={m.id} onClick={() => openMail(m.id)} className="w-full text-left px-2.5 py-1.5 rounded-[var(--r-sm)] border border-[var(--border)] hover:bg-[var(--hover)]" style={{ background: 'var(--surface-strong)' }}>
                  <div className="text-xs truncate" style={{ color: 'var(--fg)', fontWeight: m.seen ? 400 : 600 }}>{m.subject || '（无主题）'}</div>
                  <div className="text-2xs truncate" style={{ color: 'var(--faint)' }}>{m.from} · {fmtTime(m.date)}</div>
                </button>
              ))}
              {!mails.length && <div className="text-2xs" style={{ color: 'var(--faint)' }}>没有关联邮件（手动添加的款项）。</div>}
            </div>
          </section>
        )}

        {r && (
          <div className="flex items-center gap-2 pt-1 pb-2">
            <span className="text-2xs" style={{ color: 'var(--faint)' }}>
              {d.matchId ? '已配对 · ' : ''}
              {d.confidence != null ? `识别把握 ${Math.round(d.confidence * 100)}% · ` : ''}
              {d.updatedAt ? `更新于 ${fmtTime(d.updatedAt)}` : ''}
            </span>
            <span className="flex-1" />
            <button
              onClick={async () => {
                await api.financeDelete(r.id)
                await useFinance.getState().load()
                props.onClose()
                toast('已删除；关联邮件不会再被自动收集')
              }}
              className="inline-flex items-center gap-1 h-7 px-2 rounded-[var(--r-xs)] text-xs hover:bg-[var(--danger-soft)]"
              style={{ color: 'var(--danger-ink)' }}
            >
              <IconClose width={11} height={11} /> 删除
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}
