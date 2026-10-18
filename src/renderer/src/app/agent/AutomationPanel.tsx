import { useEffect, useMemo, useState } from 'react'
import type { AgentActivity, OnboardingScanStatus } from '@shared/types'
import { api } from '../../lib/api'
import { goView } from '../../lib/route'
import { openFinance } from '../../lib/finance'
import { openProjects } from '../../lib/projects'
import { fmtTime, groupByDay, REF_LABEL, todaySummary, useAgentActivity, useAgentJobs } from '../../lib/automation'
import { openAgentRef } from '../../lib/automation-refs'
import { IconAttach, IconBook, IconCheck, IconCheckSquare, IconClose, IconLayers, IconMinus, IconRefresh } from '../../components/icons'
import { IconWallet } from '../finance/FinanceNav'
import { ico, JobList, JobSettingsBlock } from './AutomationJobs'

/* ================================================================
 * 自动任务（Agent → 自动任务）：后台任务列表 + 活动记录时间线
 * 首次整理（OnboardingScanHost）：添加账户后引导 Agent 先整理一遍
 * 设计：墨黑主操作 --accent；荧光 --ai 只标 AI 产出（AI 任务角标、AI 学到的条目）
 * ================================================================ */

const AI_STATS = ['kb', 'kbMerged', 'memories', 'skills', 'brief']
const isAiOutput = (a: AgentActivity) => a.source === 'skill' || a.source === 'chat' || AI_STATS.some(k => (a.stats?.[k] ?? 0) > 0)
const SOURCE_LABEL: Record<AgentActivity['source'], string> = { job: '自动任务', skill: '技能', chat: '对话', onboarding: '首次整理' }

function ActivityItem(props: { a: AgentActivity; fresh: boolean }) {
  const a = props.a
  const [open, setOpen] = useState(false)
  const ai = isAiOutput(a)
  const long = (a.detail ?? '').length > 120 || (a.detail ?? '').includes('\n')
  return (
    <li className={`relative pl-6 pb-4 ${props.fresh ? 'fade-in' : ''}`}>
      <span
        className="absolute left-[3px] top-[6px] w-[9px] h-[9px] rounded-full"
        style={ai ? { background: 'var(--ai)', boxShadow: '0 0 0 2px var(--ai-soft)' } : { background: 'var(--surface-strong)', border: '1.5px solid var(--border-strong)' }}
        aria-hidden
      />
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-2xs tnum shrink-0" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
          {fmtTime(a.at)}
        </span>
        <span className="text-sm font-medium min-w-0" style={{ color: 'var(--fg)' }}>
          {a.title}
        </span>
        <span className="text-2xs" style={{ color: 'var(--faint)' }}>
          {SOURCE_LABEL[a.source] ?? a.source}
        </span>
      </div>
      {a.detail && (
        <div
          className={`text-xs mt-0.5 leading-relaxed whitespace-pre-line ${!open && long ? 'line-clamp-2' : ''}`}
          style={{ color: 'var(--muted)' }}
          onClick={() => long && setOpen(o => !o)}
          role={long ? 'button' : undefined}
          title={long && !open ? '展开' : undefined}
        >
          {a.detail}
        </div>
      )}
      {!!a.refs?.length && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {a.refs.map((r, i) => (
            <button
              key={`${r.type}:${r.id}:${i}`}
              onClick={() => openAgentRef(r)}
              className="max-w-[260px] h-6 px-2 inline-flex items-center gap-1.5 rounded-[var(--r-sm)] text-xs border border-[var(--border)] hover:bg-[var(--hover)] hover:border-[var(--border-strong)]"
              style={{ color: 'var(--fg)', background: r.type === 'kb' ? 'var(--ai-soft)' : 'var(--surface-strong)' }}
              title={`打开${REF_LABEL[r.type] ?? ''}：${r.label}`}
            >
              <span className="text-2xs shrink-0" style={{ color: 'var(--faint)' }}>
                {REF_LABEL[r.type] ?? r.type}
              </span>
              <span className="truncate">{r.label}</span>
            </button>
          ))}
        </div>
      )}
    </li>
  )
}

/** 活动记录时间线（按天分组） */
export function ActivityTimeline(props: { items: AgentActivity[] | null; fresh: Set<string> }) {
  const [limit, setLimit] = useState(60)
  const groups = useMemo(() => groupByDay((props.items ?? []).slice(0, limit)), [props.items, limit])
  if (!props.items) return <div className="h-32 rounded-[var(--r-md)] shimmer" />
  if (!props.items.length)
    return (
      <div className="text-sm py-10 text-center rounded-[var(--r-md)] border border-dashed border-[var(--border)]" style={{ color: 'var(--faint)' }}>
        还没有活动。Agent 每次在后台替你做了事，都会记在这里。
      </div>
    )
  return (
    <div className="flex flex-col gap-4">
      {groups.map(g => (
        <section key={g.key}>
          <div className="sticky top-0 z-[1] py-1 text-xs font-semibold" style={{ color: 'var(--fg)', background: 'var(--bg)' }}>
            {g.label}
            <span className="ml-2 font-normal tnum" style={{ color: 'var(--faint)' }}>
              {g.items.length}
            </span>
          </div>
          <ol className="relative mt-1.5 before:content-[''] before:absolute before:left-[7px] before:top-1 before:bottom-3 before:w-px before:bg-[var(--border-strong)]">
            {g.items.map(a => (
              <ActivityItem key={a.id} a={a} fresh={props.fresh.has(a.id)} />
            ))}
          </ol>
        </section>
      ))}
      {props.items.length > limit && (
        <button onClick={() => setLimit(l => l + 100)} className="self-start text-xs h-7 px-3 rounded-[var(--r-sm)] hover:bg-[var(--hover)]" style={{ color: 'var(--muted)' }}>
          更早的记录
        </button>
      )}
    </div>
  )
}

/** 自动任务与活动记录（左侧 Agent「自动任务」页） */
/** embedded：挂在 Agent 外壳里时不再重复「自动任务」大标题，只留今日汇总与切换 */
export function AutomationPanel(props: { embedded?: boolean } = {}) {
  const { settings, saveSettings } = useAgentJobs()
  const { items, fresh } = useAgentActivity(300)
  const [tab, setTab] = useState<'jobs' | 'activity'>('jobs')
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const summary = items ? todaySummary(items, now) : null
  return (
    <div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <header className={`shrink-0 px-6 border-b border-[var(--border)] ${props.embedded ? 'py-2.5' : 'pt-4 pb-3'}`}>
        <div className={`flex gap-3 flex-wrap ${props.embedded ? 'items-center' : 'items-end'}`}>
          <div className="flex-1 min-w-[220px]">
            {!props.embedded && (
              <h1 className="text-lg font-semibold" style={{ color: 'var(--fg)', letterSpacing: 'var(--tracking-tight)' }}>
                自动任务
              </h1>
            )}
            <p className={`text-xs leading-relaxed ${props.embedded ? '' : 'mt-0.5'}`} style={{ color: 'var(--muted)' }}>
              {summary ? (
                <>
                  今天 Agent 替你：<span style={{ color: 'var(--fg)' }}>{summary}</span>
                </>
              ) : (
                '今天还没有新的产出 · 后台会按下面的节奏自动整理，不打扰你'
              )}
            </p>
          </div>
          <div className="no-drag inline-flex p-0.5 rounded-[var(--r-sm)]" style={{ background: 'var(--hover)' }} role="tablist">
            {(
              [
                ['jobs', '任务'],
                ['activity', '活动记录']
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className="h-7 px-3 rounded-[var(--r-xs)] text-xs"
                style={tab === k ? { background: 'var(--surface-strong)', color: 'var(--fg)', fontWeight: 600, boxShadow: 'var(--shadow-sm)' } : { color: 'var(--muted)' }}
              >
                {label}
                {k === 'activity' && !!items?.length && (
                  <span className="ml-1 tnum text-2xs" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                    {items.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[860px] px-6 py-5">
          {tab === 'jobs' ? (
            <>
              <JobList />
              <section className="mt-6">
                <div className="text-2xs font-semibold mb-1" style={{ color: 'var(--faint)', letterSpacing: 'var(--tracking-caps)', fontFamily: 'var(--font-mono)' }}>
                  后台 AI
                </div>
                <div className="rounded-[var(--r-md)] border border-[var(--border)] px-3.5" style={{ background: 'var(--surface-strong)' }}>
                  <JobSettingsBlock settings={settings} onChange={p => void saveSettings(p)} />
                </div>
              </section>
            </>
          ) : (
            <ActivityTimeline items={items} fresh={fresh} />
          )}
        </div>
      </div>
    </div>
  )
}

// ================================================================
// 首次整理引导
// ================================================================

type StepKey = OnboardingScanStatus['steps'][number]['key']

const STEP_META: Record<StepKey, { label: string; desc: string; ai: boolean; icon: React.ReactNode; open(): void; openLabel: string }> = {
  todo: { label: '待办', desc: '需要你处理、有截止的邮件和会议', ai: false, icon: <IconCheckSquare {...ico} />, open: () => goView('todo'), openLabel: '去待办' },
  finance: { label: '财务', desc: '账单、订阅、订单与企业往来款项', ai: false, icon: <IconWallet {...ico} />, open: () => openFinance(), openLabel: '去财务' },
  attachments: { label: '附件', desc: '索引分类，算出可释放的空间', ai: false, icon: <IconAttach {...ico} />, open: () => goView('attachments'), openLabel: '去附件' },
  kb: { label: '知识库', desc: '把决定、方案、资料沉淀成知识条目', ai: true, icon: <IconBook {...ico} />, open: () => goView('kb'), openLabel: '去知识库' },
  projects: { label: '项目', desc: '找出同一件事的往来（只给建议）', ai: false, icon: <IconLayers {...ico} />, open: () => openProjects(), openLabel: '去项目' }
}
const ORDER: StepKey[] = ['todo', 'finance', 'attachments', 'kb', 'projects']
const RANGES = [30, 90, 180]

function StepState(props: { status: OnboardingScanStatus['steps'][number]['status'] }) {
  const s = props.status
  if (s === 'running')
    return (
      <span className="spinning inline-flex" style={{ color: 'var(--fg)' }} aria-label="进行中">
        <IconRefresh width={13} height={13} />
      </span>
    )
  if (s === 'done')
    return (
      <span className="inline-flex w-4 h-4 rounded-full items-center justify-center" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }} aria-label="完成">
        <IconCheck width={10} height={10} strokeWidth={3} />
      </span>
    )
  if (s === 'error')
    return (
      <span className="inline-flex w-4 h-4 rounded-full items-center justify-center" style={{ background: 'var(--danger-soft)', color: 'var(--danger-ink)' }} aria-label="出错">
        <IconClose width={10} height={10} strokeWidth={3} />
      </span>
    )
  if (s === 'skipped')
    return (
      <span className="inline-flex w-4 h-4 items-center justify-center" style={{ color: 'var(--faint)' }} aria-label="跳过">
        <IconMinus width={12} height={12} />
      </span>
    )
  return <span className="inline-block w-4 h-4 rounded-full border" style={{ borderColor: 'var(--border-strong)' }} aria-label="等待" />
}

/** 首次整理引导（添加账户后的扫描向导），挂在主窗口里 */
export function OnboardingScanHost() {
  const [st, setSt] = useState<OnboardingScanStatus | null>(null)
  const [days, setDays] = useState(90)
  const [picked, setPicked] = useState<Set<StepKey>>(new Set(ORDER))
  const [closedRun, setClosedRun] = useState<number | null>(null)
  const [mini, setMini] = useState(false)

  useEffect(() => {
    void api.onboardingScanStatus().then(setSt).catch(() => {})
    const off = api.onEvent(ev => {
      const e = ev as { type?: string; status?: OnboardingScanStatus }
      if (e.type === 'onboarding-scan' && e.status) setSt(e.status)
      // 定时技能通知点击：打开 Agent（活动记录在「自动任务」页）
      if (e.type === 'open-agent-activity') goView('agent')
    })
    return () => void off()
  }, [])

  const aiReady = !!st?.aiReady
  // 没配 AI：知识库步骤不可选
  useEffect(() => {
    if (st && !st.aiReady) setPicked(p => new Set([...p].filter(k => k !== 'kb')))
  }, [st?.aiReady])

  if (!st) return null
  const finishedRun = !st.running && st.finishedAt && st.startedAt && closedRun !== st.startedAt
  const intro = !st.running && !finishedRun && st.pendingAccounts.length > 0 && !st.hidden
  if (!st.running && !finishedRun && !intro) return null

  const names = (st.accounts ?? []).map(a => a.email)
  const who = st.legacy ? '你的邮箱' : names.length === 1 ? names[0] : names.length ? `${names[0]} 等 ${names.length} 个邮箱` : '新邮箱'
  const active = st.steps.filter(s => !(s.status === 'skipped' && s.result === '未选择'))
  const doneCount = active.filter(s => s.status === 'done' || s.status === 'error' || s.status === 'skipped').length
  const pct = active.length ? Math.round((doneCount / active.length) * 100) : 0

  const start = () => {
    setMini(false)
    void api.onboardingScanStart({ days, accountIds: st.legacy ? null : st.pendingAccounts, steps: ORDER.filter(k => picked.has(k)) })
  }
  const toggle = (k: StepKey) =>
    setPicked(p => {
      const n = new Set(p)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  // 运行中可收起成小胶囊
  if (st.running && mini)
    return (
      <button
        onClick={() => setMini(false)}
        className="fixed bottom-6 right-6 z-40 h-9 pl-3 pr-3.5 rounded-full inline-flex items-center gap-2 text-xs liquid-glass pop-in"
        style={{ color: 'var(--fg)' }}
        aria-label="展开首次整理进度"
      >
        <span className="spinning inline-flex">
          <IconRefresh width={13} height={13} />
        </span>
        正在整理 · {doneCount}/{active.length}
      </button>
    )

  return (
    <div
      role="dialog"
      aria-label="首次整理"
      className="fixed bottom-6 right-6 z-40 w-[400px] max-w-[calc(100vw-48px)] rounded-[var(--r-lg)] border border-[var(--border)] pop-in"
      style={{ background: 'var(--surface-strong)', boxShadow: 'var(--shadow-float)' }}
    >
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-2">
          <span className="text-2xs font-semibold" style={{ color: 'var(--faint)', letterSpacing: 'var(--tracking-caps)', fontFamily: 'var(--font-mono)' }}>
            首次整理
          </span>
          {st.running && (
            <span className="text-2xs tnum" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
              {doneCount}/{active.length}
            </span>
          )}
          <span className="flex-1" />
          {st.running ? (
            <button onClick={() => setMini(true)} className="w-6 h-6 grid place-items-center rounded-[var(--r-xs)] hover:bg-[var(--hover)]" style={{ color: 'var(--faint)' }} aria-label="收起">
              <IconMinus width={13} height={13} />
            </button>
          ) : finishedRun ? (
            <button onClick={() => setClosedRun(st.startedAt)} className="w-6 h-6 grid place-items-center rounded-[var(--r-xs)] hover:bg-[var(--hover)]" style={{ color: 'var(--faint)' }} aria-label="关闭">
              <IconClose width={13} height={13} />
            </button>
          ) : (
            <button onClick={() => void api.onboardingScanLater()} className="w-6 h-6 grid place-items-center rounded-[var(--r-xs)] hover:bg-[var(--hover)]" style={{ color: 'var(--faint)' }} aria-label="稍后再说">
              <IconClose width={13} height={13} />
            </button>
          )}
        </div>

        {intro && (
          <>
            <div className="mt-1.5 text-[15px] font-semibold leading-snug" style={{ color: 'var(--fg)' }}>
              {st.legacy ? '让 Agent 先把已有邮件整理一遍？' : `刚添加了 ${who}，让 Agent 先帮你整理一遍？`}
            </div>
            <div className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--muted)' }}>
              {st.legacy ? `会扫描${who}最近的邮件，` : '会扫描这个邮箱最近的邮件，'}收集待办、账单与订阅、附件，并找出值得沉淀的知识和项目线索。整理在后台进行，可以继续用。
            </div>

            <div className="mt-3 flex items-center gap-2">
              <span className="text-xs" style={{ color: 'var(--muted)' }}>范围</span>
              <div className="inline-flex p-0.5 rounded-[var(--r-sm)]" style={{ background: 'var(--hover)' }} role="radiogroup" aria-label="扫描范围">
                {RANGES.map(d => (
                  <button
                    key={d}
                    role="radio"
                    aria-checked={days === d}
                    onClick={() => setDays(d)}
                    className="h-6 px-2.5 rounded-[var(--r-xs)] text-xs tnum"
                    style={days === d ? { background: 'var(--surface-strong)', color: 'var(--fg)', fontWeight: 600, boxShadow: 'var(--shadow-sm)' } : { color: 'var(--muted)' }}
                  >
                    {d} 天
                  </button>
                ))}
              </div>
            </div>

            <ul className="mt-3 flex flex-col">
              {ORDER.map(k => {
                const m = STEP_META[k]
                const disabled = m.ai && !aiReady
                const on = picked.has(k) && !disabled
                return (
                  <li key={k}>
                    <label className={`flex items-center gap-2.5 py-1.5 px-1.5 -mx-1.5 rounded-[var(--r-sm)] ${disabled ? 'opacity-60' : 'cursor-pointer hover:bg-[var(--hover)]'}`}>
                      <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggle(k)} className="accent-[var(--accent)] w-3.5 h-3.5" />
                      <span className="inline-flex shrink-0" style={{ color: 'var(--muted)' }}>
                        {m.icon}
                      </span>
                      <span className="text-sm shrink-0" style={{ color: 'var(--fg)' }}>
                        {m.label}
                      </span>
                      <span className="text-xs truncate flex-1" style={{ color: 'var(--faint)' }}>
                        {disabled ? '需要先配置 AI' : m.desc}
                      </span>
                      {m.ai && aiReady && (
                        <span className="text-2xs font-bold px-1 rounded-[var(--r-xs)] ai-chip" title="会用到 AI">
                          AI
                        </span>
                      )}
                    </label>
                  </li>
                )
              })}
            </ul>
            {!aiReady && (
              <div className="mt-2 text-xs leading-relaxed rounded-[var(--r-sm)] px-2.5 py-2" style={{ background: 'var(--hover)', color: 'var(--muted)' }}>
                还没配置 AI：待办、财务、附件、项目用本地规则识别，知识库需要 AI，先跳过。配置后后台会自动补上。
              </div>
            )}
            <div className="mt-3.5 flex items-center gap-2">
              <button
                onClick={start}
                disabled={!ORDER.some(k => picked.has(k) && !(STEP_META[k].ai && !aiReady))}
                className="h-8 px-3.5 rounded-[var(--r-sm)] text-sm font-semibold disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                开始整理
              </button>
              <button onClick={() => void api.onboardingScanLater()} className="h-8 px-3 rounded-[var(--r-sm)] text-sm hover:bg-[var(--hover)]" style={{ color: 'var(--fg)' }}>
                稍后
              </button>
              <span className="flex-1" />
              <button onClick={() => void api.onboardingScanDismiss()} className="text-xs hover:underline" style={{ color: 'var(--faint)' }}>
                不再提醒
              </button>
            </div>
          </>
        )}

        {(st.running || finishedRun) && (
          <>
            <div className="mt-1.5 text-[15px] font-semibold leading-snug" style={{ color: 'var(--fg)' }}>
              {st.running ? `正在整理近 ${st.days ?? days} 天的邮件…` : '整理完成'}
            </div>
            {st.running && (
              <div className="mt-2 h-1 rounded-full overflow-hidden" style={{ background: 'var(--hover-strong)' }} aria-hidden>
                <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(6, pct)}%`, background: 'var(--accent)', transitionDuration: 'var(--dur-4, 300ms)' }} />
              </div>
            )}
            <ul className="mt-2.5 flex flex-col">
              {st.steps.map(s => {
                const m = STEP_META[s.key]
                const unselected = s.status === 'skipped' && s.result === '未选择'
                if (unselected) return null
                return (
                  <li key={s.key} className="flex items-start gap-2.5 py-1.5">
                    <span className="mt-[2px] shrink-0 w-4 flex justify-center">
                      <StepState status={s.status} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm" style={{ color: s.status === 'idle' ? 'var(--muted)' : 'var(--fg)' }}>
                        {m.label}
                      </div>
                      {s.result && (
                        <div className="text-xs leading-relaxed" style={{ color: s.status === 'error' ? 'var(--danger-ink)' : 'var(--muted)' }}>
                          {s.result}
                        </div>
                      )}
                    </div>
                    {!st.running && s.status === 'done' && !/^没有/.test(s.result ?? '') && (
                      <button onClick={m.open} className="shrink-0 h-6 px-2 rounded-[var(--r-xs)] text-xs border border-[var(--border)] hover:bg-[var(--hover)]" style={{ color: 'var(--fg)' }}>
                        {m.openLabel} →
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
            <div className="mt-2.5 flex items-center gap-2">
              {st.running ? (
                <span className="text-xs" style={{ color: 'var(--faint)' }}>
                  可以继续用，整理在后台进行
                </span>
              ) : (
                <>
                  <button
                    onClick={() => setClosedRun(st.startedAt)}
                    className="h-8 px-3.5 rounded-[var(--r-sm)] text-sm font-semibold"
                    style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
                  >
                    完成
                  </button>
                  <span className="text-xs" style={{ color: 'var(--faint)' }}>
                    之后 Agent 会每小时补扫、每天整理一次
                  </span>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
