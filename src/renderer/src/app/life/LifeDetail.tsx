import { useEffect, useState } from 'react'
import type { LifeCategory, LifeData } from '@shared/types'
import type { FinanceMessageRef } from '@shared/ipc'
import { actionFromOf, defaultRepeat, lifeUrgency, normRemindDays, LIFE_CATEGORIES, LIFE_CATEGORY_LABEL, DEFAULT_REMIND_DAYS } from '@shared/life'
import { api, fmtTime } from '../../lib/api'
import { useLife, type LifeRec } from '../../lib/life'
import { openFinance, fmtMoney } from '../../lib/finance'
import { goView } from '../../lib/route'
import { IconClose } from '../../components/icons'
import { openMail } from '../finance/RecRow'
import { Chip, btn, btnStyle, btnPrimary, btnPrimaryStyle, field, fieldStyle } from '../finance/ui'
import { CatBadge, URGENCY_LABEL, urgencyTone, useLinkedAmount } from './LifeRow'

const CURRENCIES = ['CNY', 'USD', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'AUD', 'CAD']
const toDate = (ts: number | null | undefined) => {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const fromDate = (s: string) => (s ? new Date(`${s}T23:59:00`).getTime() : null)
const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))
const reload = () => useLife.getState().load()

type RepeatKey = 'none' | 'y1' | 'y2' | 'y3' | 'y5' | 'y10' | 'm1' | 'm3' | 'm6'
const REPEATS: { v: RepeatKey; l: string }[] = [
  { v: 'none', l: '不循环' },
  { v: 'y1', l: '每年' },
  { v: 'y2', l: '每 2 年' },
  { v: 'y3', l: '每 3 年' },
  { v: 'y5', l: '每 5 年' },
  { v: 'y10', l: '每 10 年' },
  { v: 'm1', l: '每月' },
  { v: 'm3', l: '每 3 个月' },
  { v: 'm6', l: '每 6 个月' }
]
const repeatKey = (r: LifeData['repeat']): RepeatKey => (!r ? 'none' : (`${r.every === 'year' ? 'y' : 'm'}${r.interval || 1}` as RepeatKey))
const repeatOf = (k: RepeatKey): LifeData['repeat'] => (k === 'none' ? null : { every: k[0] === 'y' ? 'year' : 'month', interval: Number(k.slice(1)) })

function blank(category: LifeCategory): LifeData {
  return { category, subject: '', provider: null, expiresAt: null, actionFrom: null, repeat: defaultRepeat(category), remindDays: [...DEFAULT_REMIND_DAYS[category]], reference: null, amount: null, currency: 'CNY', messageIds: [], source: 'manual', notes: null }
}

/**
 * 生活事务详情 / 编辑器（右侧抽屉）：覆盖 LifeData 各字段（类别、对象、机构、到期日、建议办理日、循环、提醒天数、编号、费用、备注）；
 * 已办妥（循环事务滚到下一期）、生成待办（经待办外部同步进入提醒事项 / 日历）、导出 .ics、删除；全部关联邮件。rec 为 null 时是新建。
 */
export function LifeDetail(props: { rec: LifeRec | null; now: number; preset?: LifeCategory | null; onClose(): void; onCreated(id: string): void }) {
  const r = props.rec
  const [draft, setDraft] = useState<LifeData>(() => (r ? r.data : blank(props.preset ?? 'id-document')))
  const [title, setTitle] = useState(r?.title ?? '')
  const [mails, setMails] = useState<FinanceMessageRef[]>([])
  const [busy, setBusy] = useState(false)
  const [remindText, setRemindText] = useState((r?.data.remindDays ?? DEFAULT_REMIND_DAYS[props.preset ?? 'id-document']).join(', '))

  useEffect(() => {
    setDraft(r ? r.data : blank(props.preset ?? 'id-document'))
    setTitle(r?.title ?? '')
    setRemindText((r?.data.remindDays ?? DEFAULT_REMIND_DAYS[props.preset ?? 'id-document']).join(', '))
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
  const set = <K extends keyof LifeData>(k: K, v: LifeData[K]) => {
    setDraft(x => ({ ...x, [k]: v }))
    if (r) void api.lifeUpdate(r.id, { data: { [k]: v } as Partial<LifeData> }).then(reload)
  }
  const saveDue = (v: number | null) => {
    setDraft(x => ({ ...x, expiresAt: v, actionFrom: actionFromOf(v, x.category, x.subject) }))
    if (r) void api.lifeUpdate(r.id, { dueAt: v }).then(reload)
  }
  const saveTitle = () => {
    if (r && title.trim() && title !== r.title) void api.lifeUpdate(r.id, { title: title.trim() }).then(reload)
  }
  const saveRemind = () => {
    const list = normRemindDays(remindText, d.category)
    setRemindText(list.join(', '))
    if (list.join(',') !== (d.remindDays ?? []).join(',')) set('remindDays', list)
  }
  const create = async () => {
    if (!d.subject.trim()) return toast('先填对象（如「护照」「车险」「example.com」）')
    setBusy(true)
    const id = await api.lifeCreate({ title: title.trim() || d.subject.trim(), dueAt: d.expiresAt ?? null, data: { ...d, subject: d.subject.trim(), remindDays: normRemindDays(remindText, d.category) } })
    setBusy(false)
    await reload()
    props.onCreated(id)
  }

  const u = r ? lifeUrgency(r, props.now) : null
  const money = useLinkedAmount(r ?? ({ data: d } as LifeRec))
  const label = 'flex flex-col gap-1 text-2xs min-w-0'
  const lc = { color: 'var(--faint)' }
  const input = `${field} w-full`
  const due = r ? r.dueAt : d.expiresAt

  return (
    <aside className="w-[380px] max-w-[46%] shrink-0 h-full border-l border-[var(--border)] flex flex-col fade-in" style={{ background: 'var(--bg)' }} aria-label="生活事务详情">
      <div className="shrink-0 px-4 pt-3 pb-2.5 flex items-start gap-2.5 border-b border-[var(--border)]">
        <CatBadge category={d.category} urgency={u ?? undefined} size={34} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="caps" style={{ color: 'var(--faint)' }}>{r ? LIFE_CATEGORY_LABEL[d.category] : '新增生活事务'}</span>
            {u && URGENCY_LABEL[u] && <Chip tone={urgencyTone(u)}>{URGENCY_LABEL[u]}</Chip>}
            {r?.data.source === 'ai' && <Chip tone="ai">AI 识别</Chip>}
            {r?.data.source === 'heuristic' && <Chip title="由邮件内容规则自动识别">自动识别</Chip>}
          </div>
          <input value={title} onChange={e => setTitle(e.target.value)} onBlur={saveTitle} placeholder={r ? '' : '标题（可留空，用对象名）'} className="mt-1 w-full bg-transparent outline-none text-base font-semibold" style={{ color: 'var(--fg)' }} />
          {r && due && (
            <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
              {toDate(due)} {r.status === 'done' ? '· 已办妥' : ''}
              {money.amount != null && <span className="ml-2 tnum" style={{ fontFamily: 'var(--font-mono)' }}>{fmtMoney(money.amount, money.currency)}</span>}
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
            {r.status !== 'done' ? (
              <button
                className={btnPrimary}
                style={btnPrimaryStyle}
                onClick={() => void api.lifeUpdate(r.id, { status: 'done' }).then(reload).then(() => toast(d.repeat ? '已办妥，已滚到下一期' : '已标记办妥'))}
                title={d.repeat ? '本期已办妥：按循环滚到下一期，继续提醒' : '标记已办妥，不再提醒'}
              >
                {d.repeat ? '本期已办妥' : '已办妥'}
              </button>
            ) : (
              <button className={btn} style={btnStyle} onClick={() => void api.lifeUpdate(r.id, { status: 'open' }).then(reload)}>
                重新打开
              </button>
            )}
            <button
              className={btn}
              style={btnStyle}
              onClick={() =>
                void api.lifeMakeTodo(r.id).then(id => {
                  if (!id) return toast('没能生成待办')
                  void reload()
                  if (!d.todoId) return toast('已生成待办（会同步到已连接的提醒事项 / 日历）')
                  goView('todo')
                  setTimeout(() => window.dispatchEvent(new CustomEvent('ms:todo-open', { detail: id })), 250)
                })
              }
              title="生成一条待办：截止 = 建议开始办理日（还没到时）或到期日"
            >
              {d.todoId ? '查看待办' : '生成待办'}
            </button>
            {due && (
              <button className={btn} style={btnStyle} onClick={() => void api.lifeExportIcs([r.id]).then(res => res.ok && toast(`已导出到 ${res.path}`))} title="导出这一条为 .ics（全天事件 + 提前提醒）">
                导出 .ics
              </button>
            )}
            {d.financeId && (
              <button className={btn} style={btnStyle} onClick={() => openFinance(d.financeId!)} title="这件事在财务里也有一笔（续费 / 账单）">
                财务记录 ↗
              </button>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <label className={label}>
            <span style={lc}>类别</span>
            <select
              value={d.category}
              onChange={e => {
                const c = e.target.value as LifeCategory
                if (!r) {
                  setDraft(x => ({ ...x, category: c, repeat: defaultRepeat(c), remindDays: [...DEFAULT_REMIND_DAYS[c]] }))
                  setRemindText(DEFAULT_REMIND_DAYS[c].join(', '))
                } else set('category', c)
              }}
              className={input}
              style={fieldStyle}
            >
              {LIFE_CATEGORIES.map(c => (
                <option key={c} value={c}>{LIFE_CATEGORY_LABEL[c]}</option>
              ))}
            </select>
          </label>
          <label className={label}>
            <span style={lc}>循环</span>
            <select value={repeatKey(d.repeat ?? null)} onChange={e => set('repeat', repeatOf(e.target.value as RepeatKey))} className={input} style={fieldStyle}>
              {REPEATS.map(x => (
                <option key={x.v} value={x.v}>{x.l}</option>
              ))}
            </select>
          </label>
          <label className={`${label} col-span-2`}>
            <span style={lc}>对象</span>
            <input
              defaultValue={d.subject}
              key={`sj-${r?.id}`}
              placeholder="护照 / 车险 · 苏A·12345 / example.com / 健身年卡"
              onChange={e => !r && setDraft(x => ({ ...x, subject: e.target.value }))}
              onBlur={e => r && e.target.value.trim() && e.target.value.trim() !== d.subject && set('subject', e.target.value.trim())}
              className={input}
              style={fieldStyle}
            />
          </label>
          <label className={`${label} col-span-2`}>
            <span style={lc}>机构 / 商家</span>
            <input defaultValue={d.provider ?? ''} key={`pv-${r?.id}`} onChange={e => !r && setDraft(x => ({ ...x, provider: e.target.value || null }))} onBlur={e => r && (e.target.value.trim() || null) !== (d.provider ?? null) && set('provider', e.target.value.trim() || null)} className={input} style={fieldStyle} />
          </label>
          <label className={label}>
            <span style={lc}>{d.category === 'health' ? '预约日期' : '到期日'}</span>
            <input type="date" value={toDate(due)} onChange={e => saveDue(fromDate(e.target.value))} className={input} style={fieldStyle} />
          </label>
          <label className={label}>
            <span style={lc}>建议开始办理</span>
            <input type="date" value={toDate(d.actionFrom)} onChange={e => set('actionFrom', fromDate(e.target.value))} className={input} style={fieldStyle} />
          </label>
          <label className={`${label} col-span-2`}>
            <span style={lc}>提前几天提醒（逗号分隔）</span>
            <input value={remindText} onChange={e => setRemindText(e.target.value)} onBlur={saveRemind} placeholder="30, 7, 1" className={`${input} tnum`} style={{ ...fieldStyle, fontFamily: 'var(--font-mono)' }} />
          </label>
          <label className={`${label} col-span-2`}>
            <span style={lc}>编号（只保存尾号，如保单号 / 证件尾号）</span>
            <input defaultValue={d.reference ?? ''} key={`rf-${r?.id}-${d.reference}`} onChange={e => !r && setDraft(x => ({ ...x, reference: e.target.value || null }))} onBlur={e => r && (e.target.value.trim() || null) !== (d.reference ?? null) && set('reference', e.target.value.trim() || null)} className={`${input} tnum`} style={fieldStyle} />
          </label>
          <label className={label}>
            <span style={lc}>预计费用</span>
            <input
              type="number"
              step="0.01"
              key={`amt-${r?.id}-${d.amount}`}
              defaultValue={d.amount ?? ''}
              placeholder={money.amount != null && d.amount == null ? String(money.amount) : ''}
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
            <select value={d.currency ?? 'CNY'} onChange={e => set('currency', e.target.value)} className={input} style={fieldStyle}>
              {[...new Set([d.currency ?? 'CNY', ...CURRENCIES])].map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className={`${label} col-span-2`}>
            <span style={lc}>备注 / 准备清单</span>
            <textarea
              defaultValue={d.notes ?? ''}
              key={`nt-${r?.id}`}
              rows={3}
              placeholder={d.category === 'id-document' ? '如：近期证件照、旧证件、户口本；提前在线预约' : ''}
              onChange={e => !r && setDraft(x => ({ ...x, notes: e.target.value || null }))}
              onBlur={e => r && (e.target.value || null) !== (d.notes ?? null) && set('notes', e.target.value || null)}
              className="px-2 py-1.5 rounded-[var(--r-xs)] border border-[var(--border)] text-xs outline-none resize-y"
              style={fieldStyle}
            />
          </label>
        </div>

        {!r && (
          <div className="flex gap-2">
            <button className={btnPrimary} style={btnPrimaryStyle} disabled={busy} onClick={() => void create()}>保存</button>
            <button className={btn} style={btnStyle} onClick={props.onClose}>取消</button>
          </div>
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
              {!mails.length && <div className="text-2xs" style={{ color: 'var(--faint)' }}>没有关联邮件（手动添加的事务）。</div>}
            </div>
            {!!d.attachmentIds?.length && (
              <button onClick={() => goView('attachments')} className="mt-2 text-2xs underline underline-offset-2" style={{ color: 'var(--muted)' }}>
                {d.attachmentIds.length} 个相关附件（保单 / 合同）在附件中心 ↗
              </button>
            )}
          </section>
        )}

        {r && (
          <div className="flex items-center gap-2 pt-1 pb-2">
            <span className="text-2xs" style={{ color: 'var(--faint)' }}>
              {d.confidence != null ? `识别把握 ${Math.round(d.confidence * 100)}% · ` : ''}
              {d.reminded?.length ? `已提醒 ${d.reminded.length} 次 · ` : ''}
              {d.updatedAt ? `更新于 ${fmtTime(d.updatedAt)}` : ''}
            </span>
            <span className="flex-1" />
            <button
              onClick={async () => {
                await api.lifeDelete(r.id)
                await reload()
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
