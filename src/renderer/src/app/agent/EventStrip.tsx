import { useEffect, useState } from 'react'
import type { AgentEventHit, AgentEventKind, AgentSkill } from '@shared/types'
import { EVENT_LABEL } from '@shared/agent-events'
import { api } from '../../lib/api'
import { launchSkill, useSkills, useSkillsLoader } from '../../lib/agent-skills'
import { IconZap } from '../../components/icons'
import { openActivityLog } from './AutomationPanel'

type Run = { skillId: string; at: number; activityId?: string | null; status?: string; event?: AgentEventKind; note?: string | null }

/** 触发线（与主进程 events.ts 的 TRIGGER_MIN 一致）：以下的只在有运行记录时显示 */
const SHOW = 0.6

/** 能处理这类事件的技能：开着触发的优先，其次声明过该事件的 */
function skillFor(skills: AgentSkill[], event: AgentEventKind): AgentSkill | null {
  const has = (s: AgentSkill) => s.triggers?.some(t => t.event === event)
  return skills.find(s => s.triggers?.some(t => t.event === event && t.enabled)) ?? skills.find(has) ?? null
}

const chip = 'h-6 px-2 rounded-[var(--r-xs)] inline-flex items-center gap-1.5'

/**
 * 阅读页「事件」条（参照「关联待办」「款项」）：已识别的事件 + 自动运行的技能 → 查看结果；没运行的给「运行：xx」。
 * 克制：只显示达到触发线的事件，最多两条。
 */
export function EventStrip(props: { messageId: string }) {
  useSkillsLoader()
  const skills = useSkills(st => st.skills)
  const [data, setData] = useState<{ hits: AgentEventHit[]; runs: Run[] } | null>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      void api
        .agentEventsFor(props.messageId)
        .then(d => alive && setData(d as { hits: AgentEventHit[]; runs: Run[] }))
        .catch(() => alive && setData(null))
    setData(null)
    load()
    const off = api.onEvent(ev => {
      const e = ev as { type?: string; messageId?: string }
      if (e.type === 'agent-events' && e.messageId === props.messageId) load()
    })
    return () => {
      alive = false
      off()
    }
  }, [props.messageId])

  if (!data) return null
  const ran = new Set(data.runs.map(r => r.event))
  const hits = data.hits.filter(h => h.confidence >= SHOW || ran.has(h.event)).slice(0, 2)
  if (!hits.length) return null

  return (
    <div className="shrink-0 px-6 pt-3 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="inline-flex items-center gap-1" style={{ color: 'var(--faint)' }}>
        <IconZap width={11} height={11} /> 已识别
      </span>
      {hits.map(h => {
        const run = data.runs.find(r => r.event === h.event)
        const runSkill = run ? skills.find(s => s.id === run.skillId) : null
        const skill = runSkill ?? skillFor(skills, h.event)
        const name = runSkill?.name ?? skill?.name ?? ''
        return (
          <span key={h.event} className="inline-flex items-center gap-1.5" title={`${h.reason}（置信度 ${Math.round(h.confidence * 100)}%）`}>
            <span className={`${chip} border border-[var(--border)]`} style={{ color: 'var(--fg)', background: 'var(--surface-strong)' }}>
              {EVENT_LABEL[h.event]}
            </span>
            {run?.status === 'done' ? (
              <button onClick={() => openActivityLog()} className={`${chip} hover:bg-[var(--hover)]`} style={{ color: 'var(--muted)' }} title="在 Agent → 自动任务 → 活动记录里查看">
                已自动运行『{name}』<span style={{ color: 'var(--fg)' }}>→ 查看结果</span>
              </button>
            ) : run && (run.status === 'running' || run.status === 'queued') ? (
              <span className={chip} style={{ color: 'var(--muted)' }}>
                正在运行『{name}』…
              </span>
            ) : skill ? (
              <button
                onClick={() => launchSkill(skill.id, {}, props.messageId)}
                className={`${chip} border border-dashed border-[var(--border-strong)] hover:bg-[var(--hover)]`}
                style={{ color: 'var(--muted)' }}
                title={run?.note ? `没有自动运行：${run.note}` : '以这封邮件为上下文，在 Agent 对话里运行'}
              >
                {run?.status === 'error' ? '运行失败，重试' : '可运行'}：{skill.name}
              </button>
            ) : null}
          </span>
        )
      })}
    </div>
  )
}
