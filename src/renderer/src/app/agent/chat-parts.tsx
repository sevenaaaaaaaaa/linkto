import { useState, type ReactNode, type SVGProps } from 'react'
import type { AgentRef, AgentStep, AgentToolRisk } from '@shared/types'
import { useMail } from '../../stores/mail'
import { goView, viewFromHash } from '../../lib/route'
import { openFinance } from '../../lib/finance'
import { openContactTimeline, openProject } from '../../lib/projects'
import { openFollowups } from '../../lib/followups'
import { IconAttach, IconBook, IconBrain, IconCheck, IconCheckSquare, IconChevronRight, IconClock, IconClose, IconFileText, IconFolder, IconSearch, IconSparkles, IconUser } from '../../components/icons'

/**
 * Agent 对话的展示件：步骤行、确认卡、来源胶囊、领域图标。
 * 「荧光签」：墨黑（--accent）只给主操作，荧光（--ai）只给 AI 产出的标记；颜色一律走 token。
 */

export type ToolStep = Extract<AgentStep, { kind: 'tool' }>

// ---------------------------------------------------------------- 图标（本地小图标，避免改公共图标表）

type P = SVGProps<SVGSVGElement>
const svg = (p: P, children: ReactNode) => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...p}>
    {children}
  </svg>
)
export const IconWallet = (p: P) =>
  svg(p, (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h13v4" />
      <path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z" />
      <circle cx="16" cy="14.5" r="1.2" />
    </>
  ))
export const IconCalendar = (p: P) =>
  svg(p, (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </>
  ))
export const IconMail = (p: P) =>
  svg(p, (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ))
export const IconStop = (p: P) => svg(p, <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />)
export const IconArrowUp = (p: P) => svg(p, <path d="M12 19V5M5 12l7-7 7 7" />)
export const IconSlash = (p: P) => svg(p, <path d="M15 4 9 20" />)
export const IconTrashSm = (p: P) => svg(p, <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />)

const DOMAIN_ICON: Record<string, (p: P) => ReactNode> = {
  mail: IconMail,
  todo: IconCheckSquare,
  finance: IconWallet,
  project: IconFolder,
  attachment: IconAttach,
  kb: IconBook,
  memory: IconBrain,
  contact: IconUser,
  calendar: IconCalendar,
  system: IconClock
}

/** 工具名 → 领域（界面只拿到工具名时用；与主进程注册表一致即可） */
export function domainOfTool(tool: string): string {
  if (/^(search_mail|read_message|read_thread|list_recent|mail_understanding|find_waiting|list_folders|archive_mail|trash_mail|mark_read|mark_unread|flag_mail|snooze_mail|move_to_folder|create_rule|draft_reply|save_draft|send_mail)$/.test(tool)) return 'mail'
  if (/^followup_/.test(tool)) return 'mail'
  if (/todo/.test(tool)) return 'todo'
  if (/^finance/.test(tool)) return 'finance'
  if (/project/.test(tool)) return 'project'
  if (/attachment/.test(tool)) return 'attachment'
  if (/^kb_/.test(tool)) return 'kb'
  if (/^memory_/.test(tool)) return 'memory'
  if (/contact/.test(tool)) return 'contact'
  if (/calendar/.test(tool)) return 'calendar'
  return 'system'
}

export function ToolIcon(props: { tool: string; className?: string }) {
  const Icon = DOMAIN_ICON[domainOfTool(props.tool)] ?? IconSearch
  return <>{Icon({ width: 13, height: 13, className: props.className })}</>
}

const REF_ICON: Record<AgentRef['type'], (p: P) => ReactNode> = {
  mail: IconMail,
  thread: IconMail,
  todo: IconCheckSquare,
  finance: IconWallet,
  project: IconFolder,
  attachment: IconAttach,
  kb: IconBook,
  memory: IconBrain,
  contact: IconUser,
  followup: IconClock
}

// ---------------------------------------------------------------- 参数要点

const ARG_ORDER = ['query', 'title', 'expr', 'key', 'addr', 'month', 'filter', 'section', 'direction', 'kind', 'status', 'category', 'counterparty', 'sender', 'subject', 'name', 'folder', 'until', 'due', 'id', 'message_id']

/** 一行里显示的参数要点：关键词 / 标题优先，id 列表显示个数 */
export function argGist(step: ToolStep): string {
  const a = step.args ?? {}
  const parts: string[] = []
  for (const k of ARG_ORDER) {
    const v = a[k]
    if (v === undefined || v === null || v === '' || v === 'all') continue
    if ((k === 'id' || k === 'message_id') && parts.length) continue
    if (k === 'id' || k === 'message_id') {
      parts.push('1 项')
      continue
    }
    parts.push(String(v))
    if (parts.length >= 2) break
  }
  const list = Array.isArray(a.ids) ? a.ids : Array.isArray(a.to) ? a.to : null
  if (list) parts.push(Array.isArray(a.to) ? `→ ${list.slice(0, 2).join('、')}` : `${list.length} 项`)
  if (a.within_days) parts.push(`近 ${a.within_days} 天`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------- 步骤行

/** 一个工具调用：图标 + 中文标题 + 参数要点 + 结果摘要；有详情时可展开 */
export function StepRow(props: { step: ToolStep }) {
  const s = props.step
  const [open, setOpen] = useState(false)
  const gist = argGist(s)
  const running = s.status === 'running'
  const failed = s.status === 'error'
  const denied = s.status === 'denied'
  const canOpen = !!s.detail || (s.targets?.length ?? 0) > 0
  return (
    <div className="fade-in">
      <button
        type="button"
        onClick={() => canOpen && setOpen(o => !o)}
        aria-expanded={canOpen ? open : undefined}
        className={`w-full min-w-0 flex items-center gap-2 h-7 px-1.5 -mx-1.5 rounded-[var(--r-xs)] text-left ${canOpen ? 'hover:bg-[var(--hover)]' : 'cursor-default'}`}
      >
        <span className="relative w-4 h-4 shrink-0 inline-flex items-center justify-center" style={{ color: failed ? 'var(--danger)' : 'var(--faint)' }}>
          <ToolIcon tool={s.tool} />
        </span>
        <span className="shrink-0 text-xs font-medium" style={{ color: denied ? 'var(--faint)' : 'var(--fg)', textDecoration: denied ? 'line-through' : undefined }}>
          {s.title}
        </span>
        {gist && (
          <span className="min-w-0 truncate text-xs" style={{ color: 'var(--faint)' }}>
            {gist}
          </span>
        )}
        <span className="flex-1" />
        {running ? (
          <span className="shrink-0 inline-flex items-center gap-1.5 text-2xs" style={{ color: 'var(--faint)' }}>
            <span className="w-1.5 h-1.5 rounded-full animate-pulse motion-reduce:animate-none" style={{ background: 'var(--ai-line)' }} />
            查询中
          </span>
        ) : (
          s.summary && (
            <span className="shrink min-w-0 max-w-[55%] truncate text-2xs text-right" style={{ color: failed ? 'var(--danger-ink)' : 'var(--muted)' }} title={s.summary}>
              {s.summary}
            </span>
          )
        )}
        {canOpen && !running && (
          <IconChevronRight width={11} height={11} className="shrink-0 transition-transform" style={{ color: 'var(--faint)', transform: open ? 'rotate(90deg)' : undefined }} />
        )}
      </button>
      {open && (
        <div className="ml-6 mt-1 mb-2 fade-in">
          {s.targets?.length ? (
            <ul className="text-2xs leading-5 mb-1" style={{ color: 'var(--muted)' }}>
              {s.targets.map((t, i) => (
                <li key={i} className="truncate">
                  {t}
                </li>
              ))}
            </ul>
          ) : null}
          {s.detail && (
            <pre
              className="selectable text-2xs leading-4 max-h-56 overflow-auto rounded-[var(--r-xs)] px-2.5 py-2 whitespace-pre-wrap break-all"
              style={{ background: 'var(--bg-soft)', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}
            >
              {s.detail}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/** 已执行 / 被拒绝 / 未执行的写操作：完成后始终可见（动作比查询重要） */
export function ActionRow(props: { step: ToolStep }) {
  const s = props.step
  const ok = s.status === 'done'
  const tone = ok ? 'var(--ok)' : s.status === 'error' ? 'var(--danger)' : 'var(--faint)'
  // 摘要里已经点名了对象（如「已建待办「X」」）就不再重复列出
  const quoted = s.targets?.[0]?.match(/「([^」]+)」|《([^》]+)》/)
  const showTargets = !!s.targets?.length && !(ok && quoted && (s.summary ?? '').includes(quoted[1] ?? quoted[2]))
  return (
    <div className="flex items-start gap-2 text-xs leading-5 fade-in" style={{ color: 'var(--muted)' }}>
      <span className="w-4 h-5 shrink-0 inline-flex items-center justify-center" style={{ color: tone }}>
        {ok ? <IconCheck width={12} height={12} /> : s.status === 'error' ? <span className="w-1.5 h-1.5 rounded-full" style={{ background: tone }} /> : <IconClose width={11} height={11} />}
      </span>
      <span className="min-w-0">
        <span style={{ color: ok ? 'var(--fg)' : 'var(--muted)' }}>{ok ? s.summary || s.title : `${s.title}：${s.summary ?? '未执行'}`}</span>
        {showTargets && s.targets ? <span style={{ color: 'var(--faint)' }}>{` · ${s.targets.slice(0, 2).join('；')}${s.targets.length > 2 ? ` 等 ${s.targets.length} 项` : ''}`}</span> : null}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------- 确认卡

const RISK_LABEL: Record<AgentToolRisk, string> = { read: '查询', write: '需要你确认', external: '对外动作 · 需要你确认' }

export function ConfirmCard(props: { step: ToolStep; busy?: boolean; onDecide(approve: boolean, remember?: boolean): void }) {
  const s = props.step
  const [all, setAll] = useState(false)
  const targets = s.targets ?? []
  const shown = all ? targets : targets.slice(0, 5)
  const external = s.risk === 'external'
  return (
    <div
      role="group"
      aria-label={`确认：${s.title}`}
      className="pop-in rounded-[var(--r-md)] border px-3.5 py-3"
      style={{ borderColor: external ? 'var(--warn)' : 'var(--border-strong)', background: 'var(--surface-strong)', boxShadow: 'var(--shadow-sm)' }}
    >
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 shrink-0 rounded-[var(--r-xs)] inline-flex items-center justify-center" style={{ background: external ? 'var(--warn-soft)' : 'var(--accent-soft)', color: external ? 'var(--warn-ink)' : 'var(--fg)' }}>
          <ToolIcon tool={s.tool} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate" style={{ color: 'var(--fg)' }}>
            {s.title}
          </div>
          <div className="text-2xs" style={{ color: external ? 'var(--warn-ink)' : 'var(--faint)' }}>
            {RISK_LABEL[s.risk]}
          </div>
        </div>
      </div>
      {s.reason && (
        <p className="mt-2 text-xs leading-5" style={{ color: 'var(--muted)' }}>
          {s.reason}
        </p>
      )}
      {targets.length > 0 && (
        <ul className="mt-2 rounded-[var(--r-sm)] px-2.5 py-1.5 text-xs leading-5 selectable" style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}>
          {shown.map((t, i) => (
            <li key={i} className={i === shown.length - 1 && t.length > 60 ? 'whitespace-pre-wrap' : 'truncate'} title={t}>
              {t}
            </li>
          ))}
          {targets.length > 5 && (
            <li>
              <button type="button" onClick={() => setAll(v => !v)} className="text-2xs underline underline-offset-2" style={{ color: 'var(--faint)' }}>
                {all ? '收起' : `展开全部 ${targets.length} 项`}
              </button>
            </li>
          )}
        </ul>
      )}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          disabled={props.busy}
          onClick={() => props.onDecide(true)}
          className="h-7 px-3 rounded-[var(--r-sm)] text-xs font-semibold inline-flex items-center gap-1.5 transition-transform active:scale-[.98] disabled:opacity-50"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
        >
          <IconCheck width={12} height={12} />
          {external ? '确认发出' : '确认'}
        </button>
        <button
          type="button"
          disabled={props.busy}
          onClick={() => props.onDecide(false)}
          className="h-7 px-3 rounded-[var(--r-sm)] text-xs font-medium border border-[var(--border)] hover:bg-[var(--hover)] disabled:opacity-50"
          style={{ color: 'var(--fg)' }}
        >
          拒绝
        </button>
        {s.risk === 'write' && (
          <button type="button" disabled={props.busy} onClick={() => props.onDecide(true, true)} className="h-7 px-1.5 text-2xs hover:underline underline-offset-2 disabled:opacity-50" style={{ color: 'var(--muted)' }}>
            本次对话都允许「{s.title}」
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 来源胶囊

/** 点击来源：邮件 → 打开邮件；待办 → 待办页定位；款项 → 财务；项目 → 项目页；附件 → 附件中心；知识 → 知识库 */
export function openRef(r: AgentRef) {
  switch (r.type) {
    case 'mail':
    case 'thread':
      if (viewFromHash() !== 'mail') goView('mail')
      setTimeout(() => useMail.getState().select(r.id), 60)
      return
    case 'todo':
      goView('todo')
      setTimeout(() => window.dispatchEvent(new CustomEvent('ms:todo-open', { detail: r.id })), 250)
      return
    case 'finance':
      openFinance(r.id)
      return
    case 'project':
      openProject(r.id)
      return
    case 'attachment':
      goView('attachments')
      return
    case 'kb':
      goView('kb')
      return
    case 'memory':
      goView('agent')
      return
    case 'contact':
      openContactTimeline(r.id)
      return
    case 'followup':
      openFollowups(r.id)
      return
  }
}

export function RefChips(props: { refs: AgentRef[] }) {
  if (!props.refs.length) return null
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="来源">
      {props.refs.map(r => {
        const Icon = REF_ICON[r.type] ?? IconFileText
        return (
          <button
            key={`${r.type}:${r.id}`}
            type="button"
            onClick={() => openRef(r)}
            title={r.label}
            className="no-drag h-6 max-w-[220px] px-2 rounded-full border border-[var(--border)] inline-flex items-center gap-1 text-2xs hover:bg-[var(--hover)] hover:border-[var(--border-strong)] transition-colors"
            style={{ color: 'var(--muted)', background: 'var(--surface-strong)' }}
          >
            <span className="shrink-0 inline-flex">{Icon({ width: 11, height: 11 })}</span>
            <span className="truncate">{r.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/** 荧光小签：只标 AI 产出（如「Agent」署名） */
export function AiBadge() {
  return (
    <span className="ai-chip inline-flex items-center gap-1 h-5 px-1.5 rounded-[var(--r-xs)] text-2xs font-semibold">
      <IconSparkles width={10} height={10} />
      Agent
    </span>
  )
}
