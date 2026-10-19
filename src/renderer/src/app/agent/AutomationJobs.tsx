import type { AgentJobInfo, AgentJobSettings } from '@shared/types'
import { fmtNext, fmtWhen, useAgentJobs } from '../../lib/automation'
import { IconArchive, IconAttach, IconBrain, IconCheckSquare, IconLayers, IconRefresh, IconSparkles, IconSunrise } from '../../components/icons'
import { IconWallet } from '../finance/FinanceNav'
import { IconLife } from '../life/icons'

/* 自动任务列表与全局设置：Agent → 自动任务页与 设置 → 自动化 共用（不依赖邮件 store，设置窗可直接引用） */

const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

export const ico = { width: 15, height: 15 }

function jobIcon(j: AgentJobInfo) {
  if (j.category === 'skill') return <IconSparkles {...ico} />
  switch (j.id) {
    case 'todo-sweep':
      return <IconCheckSquare {...ico} />
    case 'finance':
      return <IconWallet {...ico} />
    case 'attachments':
      return <IconAttach {...ico} />
    case 'projects':
      return <IconLayers {...ico} />
    case 'kb-learn':
      return <IconBrain {...ico} />
    case 'daily-brief':
      return <IconSunrise {...ico} />
    case 'cleanup':
      return <IconArchive {...ico} />
    case 'life':
      return <IconLife {...ico} />
    default:
      return <IconRefresh {...ico} />
  }
}

export function Switch(props: { checked: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className="no-drag relative shrink-0 w-[34px] h-[20px] rounded-full transition-colors disabled:opacity-40"
      style={{ background: props.checked ? 'var(--accent)' : 'var(--border-strong)', transitionDuration: 'var(--dur-3, 200ms)' }}
    >
      <span
        className="absolute top-[2px] w-[16px] h-[16px] rounded-full transition-all"
        style={{ left: props.checked ? 16 : 2, background: props.checked ? 'var(--on-accent)' : 'var(--surface-strong)', boxShadow: 'var(--shadow-sm)', transitionTimingFunction: 'var(--ease-spring)' }}
      />
    </button>
  )
}

function AiBadge(props: { ai?: AgentJobInfo['ai'] }) {
  if (props.ai === 'required')
    return (
      <span className="text-2xs font-bold px-1.5 h-[18px] inline-flex items-center rounded-[var(--r-xs)] ai-chip" title="需要 AI">
        AI
      </span>
    )
  if (props.ai === 'optional')
    return (
      <span className="text-2xs px-1.5 h-[18px] inline-flex items-center rounded-[var(--r-xs)] border border-[var(--border)]" style={{ color: 'var(--faint)' }} title="规则即可运行，AI 可用时更准">
        规则 + AI
      </span>
    )
  return (
    <span className="text-2xs px-1.5 h-[18px] inline-flex items-center rounded-[var(--r-xs)] border border-[var(--border)]" style={{ color: 'var(--faint)' }} title="纯规则，不用 AI">
      规则
    </span>
  )
}

/** 单个任务行（Agent 页完整版；设置窗用 compact） */
function JobRow(props: { job: AgentJobInfo; onToggle(v: boolean): void; onRun(): void; compact?: boolean }) {
  const j = props.job
  const now = Date.now()
  return (
    <div className={`group flex items-start gap-3 ${props.compact ? 'py-2.5' : 'py-3.5'} border-b border-[var(--border-soft)] last:border-b-0`}>
      <div
        className="mt-0.5 w-8 h-8 shrink-0 rounded-[var(--r-sm)] grid place-items-center"
        style={{ background: j.enabled ? 'var(--hover-strong)' : 'var(--hover)', color: j.enabled ? 'var(--fg)' : 'var(--faint)' }}
        aria-hidden
      >
        <span className={j.running ? 'spinning inline-flex' : 'inline-flex'}>{j.running ? <IconRefresh {...ico} /> : jobIcon(j)}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold" style={{ color: j.enabled ? 'var(--fg)' : 'var(--muted)' }}>
            {j.name}
          </span>
          <span className="text-2xs tnum" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
            {j.cadence}
          </span>
          <AiBadge ai={j.ai} />
        </div>
        {!props.compact && (
          <div className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--muted)' }}>
            {j.description}
          </div>
        )}
        <div className="text-xs mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5" style={{ color: 'var(--faint)' }}>
          {j.running ? (
            <span style={{ color: 'var(--fg)' }}>正在运行…</span>
          ) : (
            <span className="min-w-0">
              上次 {fmtWhen(j.lastRunAt, now)}
              {j.lastError ? (
                <span style={{ color: 'var(--danger-ink)' }}> · {j.lastError}</span>
              ) : j.lastResult ? (
                <span style={{ color: 'var(--muted)' }}> · {j.lastResult}</span>
              ) : null}
            </span>
          )}
          {j.enabled && !j.running && <span>下次 {fmtNext(j.nextRunAt, now)}</span>}
          {j.enabled && j.blockedReason && !j.lastError && <span style={{ color: 'var(--warn-ink)' }}>{j.blockedReason}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 mt-0.5">
        <button
          onClick={props.onRun}
          disabled={j.running}
          className="h-7 px-2.5 rounded-[var(--r-sm)] text-xs border border-[var(--border)] hover:bg-[var(--hover)] disabled:opacity-50 opacity-80 group-hover:opacity-100 focus-visible:opacity-100"
          style={{ color: 'var(--fg)' }}
        >
          {j.running ? '运行中' : '立即运行'}
        </button>
        <Switch checked={j.enabled} onChange={props.onToggle} label={`${j.name}：${j.enabled ? '已开启' : '已关闭'}`} />
      </div>
    </div>
  )
}

const LIMITS = [50, 100, 200, 500, 1000]
const KB_LIMITS = [0, 6, 12, 24, 48]

/** 全局：后台 AI 用量上限 / 只在接通电源时 / 知识库每日上限 / 技能通知（Agent 页与设置窗共用） */
export function JobSettingsBlock(props: { settings: AgentJobSettings | null; onChange(p: Partial<AgentJobSettings>): void }) {
  const s = props.settings
  if (!s) return null
  const used = s.aiUsedToday ?? 0
  const pct = Math.min(100, Math.round((used / Math.max(1, s.aiDailyLimit)) * 100))
  const sel = 'no-drag text-xs h-7 px-2 rounded-[var(--r-sm)] border border-[var(--border)] outline-none'
  const selStyle = { background: 'var(--surface-strong)', color: 'var(--fg)' }
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-4 py-3 border-b border-[var(--border-soft)]">
        <div className="flex-1 min-w-0">
          <div className="text-sm" style={{ color: 'var(--fg)' }}>后台 AI 用量上限</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--faint)' }}>
            自动任务与首次整理每天最多发起的 AI 请求。今天已用 <span className="tnum" style={{ fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}>{used}</span> 次
          </div>
          <div className="mt-1.5 h-1 rounded-full overflow-hidden max-w-[240px]" style={{ background: 'var(--hover-strong)' }} aria-hidden>
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct >= 90 ? 'var(--warn)' : 'var(--accent)' }} />
          </div>
        </div>
        <select aria-label="每天请求数" value={s.aiDailyLimit} onChange={e => props.onChange({ aiDailyLimit: Number(e.target.value) })} className={sel} style={selStyle}>
          {[...new Set([...LIMITS, s.aiDailyLimit])].sort((a, b) => a - b).map(n => (
            <option key={n} value={n}>
              每天 {n} 次
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-4 py-3 border-b border-[var(--border-soft)]">
        <div className="flex-1 min-w-0">
          <div className="text-sm" style={{ color: 'var(--fg)' }}>只在接通电源时运行 AI 后台任务</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--faint)' }}>用电池时只跑规则部分（待办、财务、附件照常收集）；知识库学习总是等接通电源</div>
        </div>
        <Switch checked={s.aiOnlyOnPower} onChange={v => props.onChange({ aiOnlyOnPower: v })} label="只在接通电源时运行 AI 后台任务" />
      </div>
      <div className="flex items-center gap-4 py-3 border-b border-[var(--border-soft)]">
        <div className="flex-1 min-w-0">
          <div className="text-sm" style={{ color: 'var(--fg)' }}>知识库每天最多学习</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--faint)' }}>每封约 1 次 AI 请求；相似的条目会合并，不会重复存</div>
        </div>
        <select aria-label="知识库每日学习上限" value={s.kbDailyLimit} onChange={e => props.onChange({ kbDailyLimit: Number(e.target.value) })} className={sel} style={selStyle}>
          {[...new Set([...KB_LIMITS, s.kbDailyLimit])].sort((a, b) => a - b).map(n => (
            <option key={n} value={n}>
              {n ? `${n} 封` : '不学习'}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm" style={{ color: 'var(--fg)' }}>定时技能完成后通知我</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--faint)' }}>跟随通知总开关与免打扰时段</div>
        </div>
        <Switch checked={s.notifySkills} onChange={v => props.onChange({ notifySkills: v })} label="定时技能完成后通知我" />
      </div>
    </div>
  )
}

/** 任务列表（分组：收集 / 学习 / 定时技能） */
export function JobList(props: { compact?: boolean }) {
  const { jobs, setEnabled, runNow } = useAgentJobs()
  if (!jobs) return <div className="h-24 rounded-[var(--r-md)] shimmer" />
  const groups: { key: AgentJobInfo['category']; label: string; empty?: string }[] = [
    { key: 'collect', label: '收集与整理' },
    { key: 'learn', label: '学习' },
    { key: 'skill', label: '定时技能', empty: '在 Agent → 技能里给技能设置「定时运行」，就会出现在这里' }
  ]
  const run = async (j: AgentJobInfo) => {
    const r = await runNow(j.id)
    toast(r.ok ? `${j.name}：${r.result ?? '完成'}` : `${j.name}：${r.error ?? '没有运行'}`)
  }
  return (
    <div className="flex flex-col gap-5">
      {groups.map(g => {
        const list = jobs.filter(j => j.category === g.key)
        if (!list.length && !g.empty) return null
        return (
          <section key={g.key}>
            <div className="text-2xs font-semibold mb-1" style={{ color: 'var(--faint)', letterSpacing: 'var(--tracking-caps)', fontFamily: 'var(--font-mono)' }}>
              {g.label}
            </div>
            {list.length ? (
              <div className="rounded-[var(--r-md)] border border-[var(--border)] px-3.5" style={{ background: 'var(--surface-strong)' }}>
                {list.map(j => (
                  <JobRow key={j.id} job={j} compact={props.compact} onToggle={v => void setEnabled(j.id, v)} onRun={() => void run(j)} />
                ))}
              </div>
            ) : (
              <div className="text-xs py-3 px-3.5 rounded-[var(--r-md)] border border-dashed border-[var(--border)]" style={{ color: 'var(--faint)' }}>
                {g.empty}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

