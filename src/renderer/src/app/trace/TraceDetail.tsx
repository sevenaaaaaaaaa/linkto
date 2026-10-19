import { useEffect, useState } from 'react'
import {
  agreementLine, TRACE_CHANNELS, TRACE_CHANNEL_LABEL, TRACE_MATERIAL_LABEL, TRACE_STATUS_LABEL,
  type TraceAgreement, type TraceRecord, type TraceStatus, type TraceSummary, type TraceVersion
} from '@shared/trace'
import type { FinanceMessageRef } from '@shared/ipc'
import type { InsightRecord } from '@shared/types'
import { api, fmtTime } from '../../lib/api'
import { fmtClock, fmtDay, fromLocalInput, STATUS_TONE, toLocalInput, useTrace } from '../../lib/trace'
import { openFollowups } from '../../lib/followups'
import { openProject } from '../../lib/projects'
import { openFinance } from '../../lib/finance'
import { goView } from '../../lib/route'
import { IconClose, IconSparkles, IconMore, IconPlus } from '../../components/icons'
import { MenuButton, type MenuItem } from '../../components/Menu'
import { openMail } from '../finance/RecRow'
import { Chip, btn, btnStyle, btnPrimary, btnPrimaryStyle, miniBtn, field, fieldStyle } from '../finance/ui'
import { ChannelIcon, IconSeal } from './icons'
import { draftMaterials, MaterialComposer, PartyInput, type Shot } from './inputs'

const toast = (detail: unknown) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))
const reload = () => useTrace.getState().load()

function Section(props: { title: string; count?: number; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="caps" style={{ color: 'var(--faint)' }}>
          {props.title}
          {props.count != null ? ` · ${props.count}` : ''}
        </span>
        <span className="flex-1" />
        {props.right}
      </div>
      {props.children}
    </section>
  )
}

/**
 * 留痕详情（右侧抽屉）：整理结果（结论 / 约定 / 待确认 / 风险）、书面确认进度、参与人、原始材料、关联、版本历史与内容哈希。
 * 内容改动都会留历史版本；已确认的内容被改动后需要重新确认。
 */
export function TraceDetail(props: { rec: TraceRecord; onClose(): void }) {
  const r = props.rec
  const d = r.data
  const [busy, setBusy] = useState<string | null>(null)
  const [title, setTitle] = useState(r.title)
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [verify, setVerify] = useState<{ ok: boolean; versions: boolean[] } | null>(null)
  const [mails, setMails] = useState<FinanceMessageRef[]>([])
  const [caps, setCaps] = useState<{ ai: boolean } | null>(null)

  useEffect(() => setTitle(r.title), [r.id, r.title])
  useEffect(() => {
    void api.traceCapabilities().then(setCaps).catch(() => setCaps({ ai: false }))
  }, [])
  useEffect(() => {
    let alive = true
    void api.traceVerify(r.id).then(v => alive && setVerify(v))
    return () => {
      alive = false
    }
  }, [r.id, d.hash])
  const mailIds = d.links.messageIds.join(',')
  useEffect(() => {
    if (!d.links.messageIds.length) return setMails([])
    let alive = true
    void api.financeMessages(d.links.messageIds).then(m => alive && setMails(m))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailIds])

  const update = async (patch: Parameters<typeof api.traceUpdate>[1], reason: string) => {
    const res = await api.traceUpdate(r.id, patch, reason)
    if (!res.ok) toast(res.error ?? '保存失败')
    await reload()
  }
  const organize = async (mode: 'ai' | 'template') => {
    if (d.status === 'confirmed' && !window.confirm('对方已经确认过这份记录。重新整理会让它回到「已整理」，需要重新确认。继续？')) return
    setBusy(mode)
    const res = await api.traceOrganize(r.id, mode)
    setBusy(null)
    await reload()
    if (!res.ok) return toast(res.error ?? '整理失败')
    toast(res.warnings?.length ? `已整理；${res.warnings.length} 处金额 / 时间在原始材料里找不到，已改为待确认` : res.by === 'ai' ? 'AI 已整理' : '已按模板整理，请逐条核对')
  }
  const confirmDraft = async () => {
    setBusy('confirm')
    const res = await api.traceConfirmDraft(r.id, {})
    setBusy(null)
    await reload()
    if (!res.ok) return toast(res.error ?? '没能起草')
    toast(res.reopened ? '已打开之前起草的确认邮件（还没发出）' : '已打开撰写窗：检查后自己发送；发出后对方 3 天没回会提醒你')
  }
  const exportAs = async (format: 'md' | 'pdf') => {
    const res = await api.traceExport(r.id, format)
    if (res.ok) toast(`已导出到 ${res.path}`)
    else if (!res.canceled) toast(res.error ?? '导出失败')
  }

  const setStatus = (s: TraceStatus) => void update({ status: s }, `手动标为${TRACE_STATUS_LABEL[s]}`)
  const more: MenuItem[] = [
    { kind: 'action', label: '整条生成待办', onSelect: () => void api.traceMakeTodo(r.id, null).then(id => (id ? toast('已生成待办') : toast('没能生成待办'))).then(reload) },
    { kind: 'sep' },
    { kind: 'action', label: '导出 Markdown 存档', onSelect: () => void exportAs('md') },
    { kind: 'action', label: '导出 PDF 存档', onSelect: () => void exportAs('pdf') },
    { kind: 'action', label: '发给自己一封存档邮件…', onSelect: () => void api.traceArchiveMail(r.id).then(res => toast(res.ok ? '已打开撰写窗（收件人是你自己），检查后发送' : res.error ?? '没能打开')) },
    { kind: 'sep' },
    { kind: 'label', label: '手动标记' },
    ...(['organized', 'sent', 'confirmed', 'disputed'] as TraceStatus[]).filter(s => s !== d.status).map(s => ({ kind: 'action' as const, label: `标为「${TRACE_STATUS_LABEL[s]}」`, onSelect: () => setStatus(s) })),
    { kind: 'sep' },
    {
      kind: 'action',
      label: '删除',
      danger: true,
      onSelect: () => {
        if (!window.confirm('删除这条留痕？（跨设备同步时会一并删除）')) return
        void api.traceDelete(r.id).then(reload).then(props.onClose)
      }
    }
  ]

  const s = d.summary
  return (
    <aside className="w-[440px] max-w-[52%] shrink-0 h-full border-l border-[var(--border)] flex flex-col fade-in" style={{ background: 'var(--bg)' }} aria-label="留痕详情">
      <div className="shrink-0 px-4 pt-3 pb-2.5 flex items-start gap-2.5 border-b border-[var(--border)]">
        <span className="w-[34px] h-[34px] rounded-full inline-flex items-center justify-center shrink-0" style={{ background: 'var(--hover)', color: 'var(--muted)' }}>
          <ChannelIcon channel={d.channel} width={16} height={16} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <select
              value={d.channel}
              onChange={e => void update({ channel: e.target.value as TraceRecord['data']['channel'] }, '改场景')}
              className="caps bg-transparent outline-none"
              style={{ color: 'var(--faint)' }}
              aria-label="场景"
            >
              {TRACE_CHANNELS.map(c => (
                <option key={c} value={c}>{TRACE_CHANNEL_LABEL[c]}</option>
              ))}
            </select>
            <Chip tone={STATUS_TONE[d.status]}>{TRACE_STATUS_LABEL[d.status]}</Chip>
            {s?.by === 'ai' && <Chip tone="ai">AI 整理</Chip>}
            {s?.by === 'template' && <Chip>模板整理</Chip>}
          </div>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== r.title && void update({ title: title.trim() }, '改标题')}
            className="mt-1 w-full bg-transparent outline-none text-base font-semibold"
            style={{ color: 'var(--fg)' }}
            aria-label="标题"
          />
          <input
            type="datetime-local"
            value={toLocalInput(d.occurredAt)}
            onChange={e => void update({ occurredAt: fromLocalInput(e.target.value) }, '改发生时间')}
            className="mt-0.5 bg-transparent outline-none text-xs"
            style={{ color: 'var(--muted)' }}
            aria-label="发生时间"
          />
        </div>
        <button onClick={props.onClose} className="icon-btn w-7 h-7 inline-flex items-center justify-center" aria-label="关闭" style={{ color: 'var(--faint)' }}>
          <IconClose width={13} height={13} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-4">
        <div className="flex flex-wrap gap-1.5">
          {s ? (
            <button className={btnPrimary} style={btnPrimaryStyle} disabled={!!busy} onClick={() => void confirmDraft()} title="起草一封书面确认邮件给对方（不会自动发送），并登记跟进等对方回复">
              {busy === 'confirm' ? '起草中…' : d.confirm && !d.confirm.sentAt ? '打开确认草稿' : d.confirm ? '重新发书面确认' : '起草书面确认'}
            </button>
          ) : null}
          {caps?.ai && (
            <button className={s ? btn : btnPrimary} style={s ? btnStyle : btnPrimaryStyle} disabled={!!busy || !d.materials.length} onClick={() => void organize('ai')}>
              <IconSparkles width={12} height={12} />
              {busy === 'ai' ? 'AI 整理中…' : s ? '重新 AI 整理' : 'AI 整理'}
            </button>
          )}
          <button className={!s && !caps?.ai ? btnPrimary : btn} style={!s && !caps?.ai ? btnPrimaryStyle : btnStyle} disabled={!!busy || !d.materials.length} onClick={() => void organize('template')} title="不用 AI：摘录像约定的原话，金额 / 时间逐字照抄">
            {busy === 'template' ? '整理中…' : '按模板整理'}
          </button>
          <MenuButton title="更多" items={more} width={220} className={`${btn} px-2`}>
            <IconMore width={13} height={13} />
          </MenuButton>
        </div>

        {d.confirm && <ConfirmCard rec={r} />}

        {s && !editing && <SummaryView rec={r} onEdit={() => setEditing(true)} />}
        {s && editing && (
          <SummaryEditor
            summary={s}
            onCancel={() => setEditing(false)}
            onSave={async next => {
              if ((d.status === 'confirmed' || d.status === 'disputed') && !window.confirm('改动后需要重新发书面确认（旧内容会留在版本历史里）。继续？')) return
              await update({ summary: { ...next, by: 'manual', at: Date.now() } }, '手动修改整理结果')
              setEditing(false)
            }}
          />
        )}
        {!s && (
          <div className="rounded-[var(--r-md)] border border-dashed px-3 py-2.5 text-xs leading-relaxed" style={{ borderColor: 'var(--border-strong)', color: 'var(--muted)' }}>
            还没整理。{caps?.ai ? '「AI 整理」会只依据下面的原始材料，整理出结论、约定事项（谁 / 做什么 / 何时 / 金额）、待确认点和风险提示。' : '没有配置 AI 时可以「按模板整理」：摘录像约定的原话，再逐条修改。'}
          </div>
        )}

        <Section title="参与人" count={d.parties.length}>
          <PartyInput value={d.parties} onChange={v => void update({ parties: v }, '修改参与人')} hints={d.materials.flatMap(m => m.lines?.map(l => l.speaker) ?? []).filter((x, i, a) => a.indexOf(x) === i)} />
        </Section>

        <Section
          title="原始材料"
          count={d.materials.length}
          right={
            <button className={miniBtn} style={{ color: 'var(--muted)' }} onClick={() => setAdding(a => !a)}>
              <IconPlus width={10} height={10} /> 补充
            </button>
          }
        >
          {adding && <AddMaterial id={r.id} onDone={() => setAdding(false)} />}
          <div className="flex flex-col gap-2">
            {d.materials.map(m => (
              <MaterialCard key={m.id} m={m} />
            ))}
            {!d.materials.length && <div className="text-2xs" style={{ color: 'var(--faint)' }}>没有原始材料。</div>}
          </div>
        </Section>

        <Links rec={r} mails={mails} onLink={(patch, reason) => void update(patch, reason)} />

        <Integrity rec={r} verify={verify} />
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------- 书面确认进度

function ConfirmCard(props: { rec: TraceRecord }) {
  const d = props.rec.data
  const c = d.confirm!
  const step = (done: boolean, label: string, sub?: React.ReactNode, tone?: 'danger' | 'ok') => (
    <div className="flex items-start gap-2">
      <span className="mt-1 w-2 h-2 rounded-full shrink-0" style={{ background: done ? (tone === 'danger' ? 'var(--danger)' : tone === 'ok' ? 'var(--ok)' : 'var(--fg)') : 'var(--border-strong)' }} />
      <div className="min-w-0 text-xs">
        <div style={{ color: done ? 'var(--fg)' : 'var(--faint)' }}>{label}</div>
        {sub && <div className="text-2xs mt-0.5" style={{ color: 'var(--faint)' }}>{sub}</div>}
      </div>
    </div>
  )
  return (
    <div className="rounded-[var(--r-md)] border px-3 py-2.5 flex flex-col gap-1.5" style={{ borderColor: c.verdict === 'disputed' ? 'var(--danger)' : 'var(--border)', background: c.verdict === 'disputed' ? 'var(--danger-soft)' : 'var(--surface-strong)' }}>
      <div className="flex items-center gap-1.5">
        <span className="caps" style={{ color: 'var(--faint)' }}>书面确认</span>
        <span className="flex-1" />
        {c.followupId && (
          <button className="text-2xs underline underline-offset-2" style={{ color: 'var(--muted)' }} onClick={() => openFollowups(c.followupId)}>
            在「等待对方」里看
          </button>
        )}
      </div>
      {step(true, `已起草 · ${fmtTime(c.draftedAt)}`, `${c.to.join('、') || '收件人待填'} · ${c.subject}`)}
      {step(!!c.sentAt, c.sentAt ? `已发出 · ${fmtTime(c.sentAt)}` : '等你在撰写窗里检查后发送', c.sentAt ? '对方回信后自动判断确认 / 异议' : undefined)}
      {step(
        !!c.replyAt,
        c.replyAt ? `${c.verdict === 'disputed' ? '对方有异议' : '对方已确认'} · ${fmtTime(c.replyAt)}` : '等对方回复',
        c.replyAt ? (
          <>
            {c.evidence?.length ? `回信里写了：${c.evidence.join('、')} · ` : ''}
            {c.replyMessageId && (
              <button className="underline underline-offset-2" onClick={() => openMail(c.replyMessageId!)}>
                查看回信
              </button>
            )}
            {c.verdict === 'disputed' && <div className="mt-1" style={{ color: 'var(--danger-ink)' }}>看完回信后修改整理结果，再「重新发书面确认」；旧版本会留在历史里。</div>}
          </>
        ) : undefined,
        c.verdict === 'disputed' ? 'danger' : 'ok'
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 整理结果

function SummaryView(props: { rec: TraceRecord; onEdit(): void }) {
  const r = props.rec
  const s = r.data.summary!
  const memory = (i: number) =>
    void api.traceRemember(r.id, i).then(res => {
      toast(res.ok ? '已记进 Agent 记忆（承诺），起草与问答会参考' : res.error ?? '没能记住')
      void reload()
    })
  const todo = (i: number) => void api.traceMakeTodo(r.id, i).then(id => toast(id ? '已生成待办' : '没能生成待办')).then(reload)
  return (
    <Section
      title="整理结果"
      right={
        <button className={miniBtn} style={{ color: 'var(--muted)' }} onClick={props.onEdit}>
          编辑
        </button>
      }
    >
      {!!s.warnings?.length && (
        <div className="mb-2 rounded-[var(--r-sm)] px-2.5 py-2 text-2xs leading-relaxed" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
          {s.warnings.map((w, i) => (
            <div key={i}>· {w}</div>
          ))}
        </div>
      )}
      {s.conclusion && <p className="text-sm leading-relaxed" style={{ color: 'var(--fg)' }}>{s.conclusion}</p>}
      {s.agreements.length > 0 && (
        <ol className="mt-2 flex flex-col gap-1.5">
          {s.agreements.map((a, i) => (
            <li key={i} className="group rounded-[var(--r-sm)] border px-2.5 py-2" style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)' }}>
              <div className="flex items-start gap-2">
                <span className="tnum text-2xs mt-0.5 shrink-0" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm leading-snug" style={{ color: 'var(--fg)' }}>
                    {a.who && <span className="font-semibold">{a.who}：</span>}
                    {a.what}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {a.when && <Chip tone="info">时间 · {a.when}</Chip>}
                    {a.amount && <Chip tone="strong">金额 · {a.amount}</Chip>}
                    {a.flags?.includes('amount-unverified') && <Chip tone="warn">金额待确认</Chip>}
                    {a.flags?.includes('when-unverified') && <Chip tone="warn">时间待确认</Chip>}
                    {a.flags?.includes('what-number') && <Chip tone="warn">数字需核对</Chip>}
                  </div>
                  {a.quote && <div className="text-2xs mt-1 leading-relaxed" style={{ color: 'var(--faint)' }}>原文：{a.quote}</div>}
                </div>
                <div className="flex flex-col gap-1 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                  <button className={miniBtn} style={{ color: 'var(--muted)' }} onClick={() => todo(i)} title="生成一条待办（写明时间的按那天截止）">
                    转待办
                  </button>
                  <button className={miniBtn} style={{ color: 'var(--muted)' }} onClick={() => memory(i)} title="作为「承诺」记进 Agent 记忆（你确认后才写入）">
                    记为承诺
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {s.pending.length > 0 && (
        <div className="mt-2.5">
          <div className="text-2xs font-semibold mb-1" style={{ color: 'var(--warn-ink)' }}>待确认</div>
          <ul className="flex flex-col gap-0.5">
            {s.pending.map((p, i) => (
              <li key={i} className="text-xs leading-relaxed" style={{ color: 'var(--fg)' }}>· {p}</li>
            ))}
          </ul>
        </div>
      )}
      {s.risks.length > 0 && (
        <div className="mt-2.5">
          <div className="text-2xs font-semibold mb-1" style={{ color: 'var(--danger-ink)' }}>风险提示</div>
          <ul className="flex flex-col gap-0.5">
            {s.risks.map((p, i) => (
              <li key={i} className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>· {p}</li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  )
}

function SummaryEditor(props: { summary: TraceSummary; onSave(s: TraceSummary): void; onCancel(): void }) {
  const [conclusion, setConclusion] = useState(props.summary.conclusion)
  const [items, setItems] = useState<TraceAgreement[]>(props.summary.agreements.map(a => ({ ...a })))
  const [pending, setPending] = useState(props.summary.pending.join('\n'))
  const [risks, setRisks] = useState(props.summary.risks.join('\n'))
  const set = (i: number, k: keyof TraceAgreement, v: string) => setItems(list => list.map((a, j) => (j === i ? { ...a, [k]: v || null, flags: undefined } : a)))
  const ta = 'w-full px-2 py-1.5 rounded-[var(--r-xs)] border border-[var(--border)] text-xs outline-none resize-y focus:border-[var(--border-strong)]'
  return (
    <Section title="编辑整理结果">
      <div className="flex flex-col gap-2">
        <textarea value={conclusion} onChange={e => setConclusion(e.target.value)} rows={2} placeholder="结论" className={ta} style={fieldStyle} />
        {items.map((a, i) => (
          <div key={i} className="rounded-[var(--r-sm)] border p-2 grid grid-cols-[64px_1fr] gap-1.5" style={{ borderColor: 'var(--border)' }}>
            <input value={a.who ?? ''} onChange={e => set(i, 'who', e.target.value)} placeholder="谁" className={field} style={fieldStyle} />
            <input value={a.what} onChange={e => set(i, 'what', e.target.value)} placeholder="做什么 / 约定内容" className={field} style={fieldStyle} />
            <span />
            <div className="flex gap-1.5">
              <input value={a.when ?? ''} onChange={e => set(i, 'when', e.target.value)} placeholder="时间" className={`${field} flex-1 min-w-0`} style={fieldStyle} />
              <input value={a.amount ?? ''} onChange={e => set(i, 'amount', e.target.value)} placeholder="金额" className={`${field} flex-1 min-w-0`} style={fieldStyle} />
              <button className={miniBtn} style={{ color: 'var(--danger-ink)' }} onClick={() => setItems(list => list.filter((_, j) => j !== i))}>
                删
              </button>
            </div>
          </div>
        ))}
        <button className={`${miniBtn} self-start`} style={{ color: 'var(--muted)' }} onClick={() => setItems(list => [...list, { who: '', what: '' }])}>
          <IconPlus width={10} height={10} /> 加一条约定
        </button>
        <textarea value={pending} onChange={e => setPending(e.target.value)} rows={2} placeholder="待确认点（一行一条）" className={ta} style={fieldStyle} />
        <textarea value={risks} onChange={e => setRisks(e.target.value)} rows={2} placeholder="风险提示（一行一条）" className={ta} style={fieldStyle} />
        <div className="flex gap-2">
          <button
            className={btnPrimary}
            style={btnPrimaryStyle}
            onClick={() =>
              props.onSave({
                ...props.summary,
                conclusion: conclusion.trim(),
                agreements: items.filter(a => a.what?.trim()),
                pending: pending.split('\n').map(x => x.trim()).filter(Boolean),
                risks: risks.split('\n').map(x => x.trim()).filter(Boolean),
                warnings: []
              })
            }
          >
            保存（留历史版本）
          </button>
          <button className={btn} style={btnStyle} onClick={props.onCancel}>取消</button>
        </div>
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------- 原始材料

function MaterialCard(props: { m: TraceRecord['data']['materials'][number] }) {
  const m = props.m
  const [open, setOpen] = useState(false)
  const lines = m.lines ?? []
  const long = lines.length > 6 || m.text.length > 400
  return (
    <div className="rounded-[var(--r-sm)] border px-2.5 py-2" style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)' }}>
      <div className="flex items-center gap-1.5 text-2xs" style={{ color: 'var(--faint)' }}>
        <span className="font-semibold" style={{ color: 'var(--muted)' }}>{TRACE_MATERIAL_LABEL[m.kind]}</span>
        {m.label && <span className="truncate">· {m.label}</span>}
        {m.fileName && <span className="truncate">· {m.fileName}</span>}
        {lines.length > 0 && <span>· {lines.length} 条消息</span>}
        <span className="flex-1" />
        <span>{fmtTime(m.addedAt)} 加入</span>
      </div>
      {lines.length > 0 ? (
        <div className="mt-1.5 flex flex-col gap-1">
          {(open ? lines : lines.slice(0, 6)).map((l, i) => (
            <div key={i} className="text-xs leading-relaxed">
              <span className="font-semibold" style={{ color: 'var(--fg)' }}>{l.speaker}</span>
              {l.time && <span className="ml-1.5 text-2xs tnum" style={{ color: 'var(--faint)' }}>{l.at ? `${fmtDay(l.at)} ${fmtClock(l.at)}` : l.time}</span>}
              <div className="whitespace-pre-wrap break-words" style={{ color: 'var(--muted)' }}>{l.text}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-1.5 text-xs leading-relaxed whitespace-pre-wrap break-words" style={{ color: 'var(--muted)' }}>{open ? m.text : m.text.slice(0, 400)}</div>
      )}
      {long && (
        <button className="mt-1 text-2xs underline underline-offset-2" style={{ color: 'var(--faint)' }} onClick={() => setOpen(o => !o)}>
          {open ? '收起' : '展开全部'}
        </button>
      )}
      {m.messageId && (
        <button className="mt-1 ml-2 text-2xs underline underline-offset-2" style={{ color: 'var(--faint)' }} onClick={() => openMail(m.messageId!)}>
          打开邮件
        </button>
      )}
    </div>
  )
}

function AddMaterial(props: { id: string; onDone(): void }) {
  const [text, setText] = useState('')
  const [shots, setShots] = useState<Shot[]>([])
  const mats = draftMaterials(text, shots, { note: true })
  return (
    <div className="mb-2 flex flex-col gap-2">
      <MaterialComposer text={text} onText={setText} shots={shots} onShots={setShots} autoFocus rows={4} placeholder="补充聊天记录、截图或备注（会留在原始材料里，旧内容进版本历史）" />
      <div className="flex gap-2">
        <button
          className={btnPrimary}
          style={btnPrimaryStyle}
          disabled={!mats.length || shots.some(s => s.status === 'ocr')}
          onClick={() =>
            void api.traceUpdate(props.id, { addMaterials: mats }, '补充原始材料').then(async () => {
              await reload()
              props.onDone()
            })
          }
        >
          添加
        </button>
        <button className={btn} style={btnStyle} onClick={props.onDone}>取消</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 关联

function Links(props: { rec: TraceRecord; mails: FinanceMessageRef[]; onLink(patch: Parameters<typeof api.traceUpdate>[1], reason: string): void }) {
  const d = props.rec.data
  const [projects, setProjects] = useState<{ id: string; title: string }[]>([])
  const [finance, setFinance] = useState<InsightRecord[]>([])
  useEffect(() => {
    void api.listProjects().then(list => setProjects(list.map(p => ({ id: p.id, title: p.title })))).catch(() => {})
    void api.financeList().then(r => setFinance(r.records)).catch(() => {})
  }, [])
  const pj = projects.filter(p => d.links.projectIds.includes(p.id))
  const fi = finance.filter(f => d.links.financeIds.includes(f.id))
  const chip = (key: string, label: string, onOpen: () => void, onRemove?: () => void) => (
    <span key={key} className="h-6 pl-2 pr-1 rounded-[var(--r-xs)] border inline-flex items-center gap-1 text-xs max-w-full" style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}>
      <button className="truncate hover:underline underline-offset-2" onClick={onOpen}>{label}</button>
      {onRemove && (
        <button onClick={onRemove} className="w-4 h-4 inline-flex items-center justify-center rounded hover:bg-[var(--hover-strong)]" aria-label="取消关联" style={{ color: 'var(--faint)' }}>
          <IconClose width={9} height={9} />
        </button>
      )}
    </span>
  )
  const total = d.links.messageIds.length + d.links.followupIds.length + d.links.todoIds.length + d.links.projectIds.length + d.links.financeIds.length
  return (
    <Section
      title="关联"
      count={total}
      right={
        <MenuButton
          title="关联项目 / 款项"
          width={240}
          className={miniBtn}
          items={[
            { kind: 'label', label: '项目' },
            ...projects.filter(p => !d.links.projectIds.includes(p.id)).slice(0, 12).map(p => ({ kind: 'action' as const, label: p.title, onSelect: () => props.onLink({ link: { projectIds: [p.id] } }, '关联项目') })),
            { kind: 'label', label: '款项' },
            ...finance.filter(f => !d.links.financeIds.includes(f.id)).slice(0, 12).map(f => ({ kind: 'action' as const, label: f.title, onSelect: () => props.onLink({ link: { financeIds: [f.id] } }, '关联款项') }))
          ]}
        >
          <IconPlus width={10} height={10} /> 关联
        </MenuButton>
      }
    >
      <div className="flex flex-wrap gap-1">
        {props.mails.map(m => chip(m.id, `邮件 · ${m.subject || '（无主题）'}`, () => openMail(m.id)))}
        {d.links.followupIds.map(id => chip(id, '跟进 · 等对方确认', () => openFollowups(id)))}
        {d.links.todoIds.map(id => chip(id, '待办', () => {
          goView('todo')
          setTimeout(() => window.dispatchEvent(new CustomEvent('ms:todo-open', { detail: id })), 250)
        }))}
        {pj.map(p => chip(p.id, `项目 · ${p.title}`, () => openProject(p.id), () => props.onLink({ unlink: { projectIds: [p.id] } }, '取消关联项目')))}
        {fi.map(f => chip(f.id, `款项 · ${f.title}`, () => openFinance(f.id), () => props.onLink({ unlink: { financeIds: [f.id] } }, '取消关联款项')))}
        {!total && <span className="text-2xs" style={{ color: 'var(--faint)' }}>还没有关联。书面确认、转待办会自动关联；也可以手动关联项目或款项。</span>}
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------- 完整性与版本

function Integrity(props: { rec: TraceRecord; verify: { ok: boolean; versions: boolean[] } | null }) {
  const d = props.rec.data
  const [open, setOpen] = useState<number | null>(null)
  const versions = [...d.versions].map((v, i) => ({ v, i })).reverse()
  return (
    <Section title="完整性与版本历史" count={d.versions.length}>
      <div className="rounded-[var(--r-sm)] border px-2.5 py-2 text-2xs leading-relaxed" style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)', color: 'var(--muted)' }}>
        <div className="flex items-center gap-1.5">
          <IconSeal width={13} height={13} style={{ color: props.verify?.ok === false ? 'var(--danger)' : 'var(--ok)' }} />
          <span style={{ color: props.verify?.ok === false ? 'var(--danger-ink)' : 'var(--fg)' }}>
            {props.verify == null ? '校验中…' : props.verify.ok ? '当前内容与记录的哈希一致' : '当前内容与记录的哈希不一致（可能被绕过界面改动）'}
          </span>
        </div>
        <div className="mt-1 break-all tnum" style={{ fontFamily: 'var(--font-mono)' }}>SHA-256 {d.hash}</div>
        <div className="mt-0.5">
          首次记录 {fmtTime(d.createdAt)}
          {d.firstHash !== d.hash ? ` · 首版哈希 ${d.firstHash.slice(0, 12)}…` : ' · 未修改过'}
        </div>
        <div className="mt-0.5" style={{ color: 'var(--faint)' }}>任何内容改动都会把旧版本连同当时的哈希留在下面；需要第三方可见的凭据时，发书面确认或存档邮件。</div>
      </div>
      {versions.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {versions.map(({ v, i }) => (
            <div key={i} className="rounded-[var(--r-sm)] border px-2.5 py-1.5" style={{ borderColor: 'var(--border)' }}>
              <button className="w-full flex items-center gap-2 text-left text-xs" onClick={() => setOpen(o => (o === i ? null : i))}>
                <span style={{ color: 'var(--fg)' }}>{v.reason}</span>
                <span className="flex-1" />
                <span className="text-2xs tnum" style={{ color: 'var(--faint)' }}>{fmtTime(v.at)}</span>
                <span className="text-2xs tnum" style={{ color: props.verify?.versions[i] === false ? 'var(--danger-ink)' : 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{v.hash.slice(0, 8)}</span>
              </button>
              {open === i && <VersionView v={v} />}
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function VersionView(props: { v: TraceVersion }) {
  const c = props.v.content
  return (
    <div className="mt-1.5 pt-1.5 border-t text-2xs leading-relaxed flex flex-col gap-0.5" style={{ borderColor: 'var(--border-soft)', color: 'var(--muted)' }}>
      <div>修改前的标题：{c.title}</div>
      <div>场景：{TRACE_CHANNEL_LABEL[c.channel]} · 发生：{c.occurredAt ? `${fmtDay(c.occurredAt)} ${fmtClock(c.occurredAt)}` : '—'} · 参与人：{c.parties.map(p => p.name).join('、') || '—'}</div>
      <div>原始材料：{c.materials.length} 份</div>
      {c.summary ? (
        <>
          {c.summary.conclusion && <div>结论：{c.summary.conclusion}</div>}
          {c.summary.agreements.map((a, j) => (
            <div key={j}>
              {j + 1}. {agreementLine(a)}
            </div>
          ))}
          {c.summary.pending.length > 0 && <div>待确认：{c.summary.pending.join('；')}</div>}
        </>
      ) : (
        <div>（当时还没整理）</div>
      )}
      <div className="break-all" style={{ fontFamily: 'var(--font-mono)', color: 'var(--faint)' }}>当时的哈希 {props.v.hash}</div>
    </div>
  )
}
