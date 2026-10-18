import { useEffect, useRef, useState } from 'react'
import type { FollowupStatus, MessageSummary } from '@shared/types'
import { FOLLOWUP_KIND_LABEL, FOLLOWUP_STATUS_LABEL, overdueDays, waitedDays } from '@shared/followups'
import { MenuButton, type MenuItem } from '../../components/Menu'
import { IconCheck, IconClock, IconReplyAll, IconSend } from '../../components/icons'
import { useMail } from '../../stores/mail'
import { openFinance } from '../../lib/finance'
import { closeFollowup, fmtMd, followMessage, nudgeFollowup, snoozeFollowup, useFollowupEvents, useFollowups, type FollowupRec } from '../../lib/followups'
import { api } from '../../lib/api'

/* 「等待对方」视图顶部的跟进清单 + 列表行上的「跟进」快捷按钮 + 状态胶囊（阅读页关联条共用） */

const PILL: Record<FollowupStatus, { bg: string; fg: string }> = {
  overdue: { bg: 'var(--danger-soft)', fg: 'var(--danger-ink)' },
  waiting: { bg: 'var(--info-soft)', fg: 'var(--info-ink)' },
  replied: { bg: 'var(--ok-soft)', fg: 'var(--ok-ink)' },
  drafted: { bg: 'var(--bg-soft)', fg: 'var(--muted)' },
  closed: { bg: 'var(--bg-soft)', fg: 'var(--faint)' },
  cancelled: { bg: 'var(--bg-soft)', fg: 'var(--faint)' }
}

export function StatusPill(props: { status: FollowupStatus; compact?: boolean }) {
  const c = PILL[props.status]
  return (
    <span className="shrink-0 inline-flex items-center h-[18px] px-1.5 rounded-full text-2xs font-semibold" style={{ background: c.bg, color: c.fg }}>
      {FOLLOWUP_STATUS_LABEL[props.status]}
    </span>
  )
}

/** 一句话时间：等待中「已等 2 天 · 10/22 到期」；逾期「逾期 1 天（已等 4 天）」；已回复「10/21 已回复」 */
export function timeLine(f: FollowupRec, now = Date.now()): string {
  const d = f.data
  if (d.status === 'drafted') return `草稿 · 发出后 ${d.waitDays} 天没回提醒`
  if (d.status === 'replied') return `${fmtMd(d.repliedAt)} 已回复 · 等了 ${waitedDays(d.sentAt, d.repliedAt ?? now)} 天`
  if (d.status === 'overdue') return `逾期 ${overdueDays(f.dueAt, now)} 天 · 已等 ${waitedDays(d.sentAt, now)} 天`
  if (d.status === 'waiting') return `已等 ${waitedDays(d.sentAt, now)} 天 · ${fmtMd(f.dueAt)} 到期`
  return d.closedAt ? `${fmtMd(d.closedAt)} ${FOLLOWUP_STATUS_LABEL[d.status]}` : FOLLOWUP_STATUS_LABEL[d.status]
}

const SNOOZE = [1, 3, 5, 7]

function snoozeItems(id: string): MenuItem[] {
  return [{ kind: 'label', label: '延后提醒' }, ...SNOOZE.map(n => ({ kind: 'action' as const, label: `${n} 天后`, onSelect: () => void snoozeFollowup(id, n) }))]
}

/** 跟进卡片上的按钮组（清单与阅读页关联条共用） */
export function FollowupActions(props: { f: FollowupRec; size?: 'sm' | 'xs' }) {
  const { f } = props
  const d = f.data
  const h = props.size === 'xs' ? 'h-6' : 'h-7'
  const btn = `${h} px-2 inline-flex items-center gap-1 rounded-[var(--r-sm)] text-xs border border-[var(--border)] hover:bg-[var(--hover)] hover:border-[var(--border-strong)] transition-colors`
  return (
    <div className="flex items-center gap-1 shrink-0">
      {d.status === 'drafted' && (
        <button className={btn} style={{ color: 'var(--fg)' }} onClick={() => void nudgeFollowup(f.id)} title="打开草稿，检查后自己发送">
          <IconSend width={12} height={12} /> 打开草稿
        </button>
      )}
      {(d.status === 'waiting' || d.status === 'overdue') && (
        <button
          className={btn}
          style={d.status === 'overdue' ? { color: 'var(--on-accent)', background: 'var(--accent)', borderColor: 'transparent' } : { color: 'var(--fg)' }}
          onClick={() => void nudgeFollowup(f.id)}
          title={d.nudgeDraftId ? '已经起草好一封催促：打开检查后自己发送' : '起草一封更礼貌 / 更明确的催促（不会自动发送）'}
        >
          <IconSend width={12} height={12} /> {d.nudgeDraftId ? '发催促' : '再催一封'}
        </button>
      )}
      {d.status === 'replied' && d.repliedMessageId && (
        <button className={btn} style={{ color: 'var(--fg)' }} onClick={() => useMail.getState().select(d.repliedMessageId!)} title="查看对方的回信">
          <IconReplyAll width={12} height={12} /> 看回信
        </button>
      )}
      {d.status === 'replied' && d.invoiceHint && (
        <button className={btn} style={{ color: 'var(--fg)' }} onClick={() => openFinance(d.financeId ?? null)} title="回信像是发票：到财务中心关联到对应款项">
          关联财务
        </button>
      )}
      {d.status !== 'drafted' && d.status !== 'closed' && d.status !== 'cancelled' && (
        <MenuButton items={snoozeItems(f.id)} title="延后 N 天再提醒" width={140} className={`${btn} min-w-0`}>
          <IconClock width={12} height={12} /> 延后
        </MenuButton>
      )}
      {d.status !== 'closed' && d.status !== 'cancelled' && (
        <button
          className={`${h} w-7 inline-flex items-center justify-center rounded-[var(--r-sm)] hover:bg-[var(--hover)]`}
          style={{ color: d.status === 'replied' ? 'var(--ok-ink)' : 'var(--muted)' }}
          onClick={() => void (d.status === 'drafted' ? api.followupUpdate(f.id, { status: 'cancelled' }).then(() => useFollowups.getState().load()) : closeFollowup(f.id))}
          title={d.status === 'drafted' ? '不跟进了' : '已解决：结束这条跟进'}
          aria-label={d.status === 'drafted' ? '取消跟进' : '已解决'}
        >
          <IconCheck width={14} height={14} />
        </button>
      )}
    </div>
  )
}

function FollowupCard(props: { f: FollowupRec; focused: boolean }) {
  const { f } = props
  const d = f.data
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (props.focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [props.focused])
  const openMail = () => {
    const id = d.status === 'replied' ? d.repliedMessageId : d.sentMessageId ?? d.relatedMessageId
    if (id) useMail.getState().select(id)
  }
  return (
    <div
      ref={ref}
      className="group px-3 py-2 rounded-[var(--r-md)] border transition-colors"
      style={{
        background: 'var(--surface-strong)',
        borderColor: props.focused ? 'var(--accent)' : d.status === 'overdue' ? 'var(--danger-soft)' : 'var(--border-soft)',
        boxShadow: props.focused ? '0 0 0 2px var(--accent-soft)' : undefined
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusPill status={d.status} />
        <button onClick={openMail} className="flex-1 min-w-0 truncate text-left text-sm font-medium hover:underline underline-offset-2" style={{ color: 'var(--fg)' }} title={d.subject}>
          {d.subject || '（无主题）'}
        </button>
        <span className="shrink-0 text-2xs tnum" style={{ color: d.status === 'overdue' ? 'var(--danger-ink)' : 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
          {timeLine(f)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 min-w-0">
        <div className="flex-1 min-w-0 text-xs truncate" style={{ color: 'var(--muted)' }}>
          <span style={{ color: 'var(--faint)' }}>{FOLLOWUP_KIND_LABEL[d.kind]} · </span>
          {d.ask || '对方回复'}
          {d.to.length > 0 && <span style={{ color: 'var(--faint)' }}> · {d.to.slice(0, 2).join('、')}{d.to.length > 2 ? ` 等 ${d.to.length} 人` : ''}</span>}
          {(d.nudgesSent ?? 0) > 0 && <span style={{ color: 'var(--faint)' }}> · 催了 {d.nudgesSent} 次</span>}
          {d.nudgeDraftId && <span style={{ color: 'var(--accent-ink)' }}> · 已起草催促</span>}
        </div>
        <FollowupActions f={f} size="xs" />
      </div>
    </div>
  )
}

/** 「等待对方」顶部：登记过的跟进；下面原有的「已发送未回」列表照旧 */
export function FollowupBoard(props: { passiveCount: number }) {
  useFollowupEvents()
  const items = useFollowups(st => st.items)
  const focusId = useFollowups(st => st.focusId)
  const [all, setAll] = useState(false)
  useEffect(() => {
    if (!focusId) return
    setAll(true)
    const t = setTimeout(() => useFollowups.setState({ focusId: null }), 2400)
    return () => clearTimeout(t)
  }, [focusId])
  const overdue = items.filter(f => f.data.status === 'overdue').length
  const shown = all ? items : items.slice(0, 5)
  return (
    <section className="px-3 pt-3 pb-1 fade-in" aria-label="跟进清单">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-2xs font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
          跟进 {items.length}
          {overdue > 0 && <span style={{ color: 'var(--danger-ink)' }}> · {overdue} 已逾期</span>}
        </div>
        <div className="flex-1" />
        {items.length > 5 && (
          <button onClick={() => setAll(v => !v)} className="text-2xs" style={{ color: 'var(--muted)' }}>
            {all ? '收起' : `全部 ${items.length} 条`}
          </button>
        )}
      </div>
      {items.length ? (
        <div className="space-y-1.5">
          {shown.map(f => (
            <FollowupCard key={f.id} f={f} focused={focusId === f.id} />
          ))}
        </div>
      ) : (
        <div className="text-xs leading-relaxed px-1 py-1" style={{ color: 'var(--faint)' }}>
          还没有登记的跟进。写邮件时打开底部的「发出后跟进」，或在下面悬停一封点「跟进」，对方到期没回会提醒你并起草下一封催促。
        </div>
      )}
      <div className="mt-3 mb-0.5 text-2xs font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
        已发送未回 {props.passiveCount}
      </div>
    </section>
  )
}

/** 「等待对方」列表行悬停时的「跟进它」：已登记的显示状态，没登记的一键登记（3 天） */
export function FollowQuickBtn(props: { msg: MessageSummary }) {
  const items = useFollowups(st => st.items)
  const tracked = items.find(f => f.data.sentMessageId === props.msg.id)
  if (tracked) return <StatusPill status={tracked.data.status} />
  return (
    <button
      title="跟进它：3 天后对方还没回就提醒我"
      onClick={e => {
        e.stopPropagation()
        void followMessage(props.msg.id, { waitDays: 3 })
      }}
      className="h-6 px-1.5 inline-flex items-center gap-1 rounded-[var(--r-xs)] text-2xs font-medium transition-colors hover:bg-[var(--hover-strong)]"
      style={{ color: 'var(--accent-ink)' }}
    >
      <IconClock width={12} height={12} /> 跟进
    </button>
  )
}
