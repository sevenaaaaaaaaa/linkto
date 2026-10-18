import { useState } from 'react'
import { useView, useAgentRoute, goAgent, type AgentTab } from '../../lib/route'
import { useSkills, useSkillsLoader, sortSkills, requestSkillRun } from '../../lib/agent-skills'
import { IconBrain, IconChat, IconChevronDown, IconGrid, IconRobot, IconZap, IconMore } from '../../components/icons'
import { SkillIcon } from './skill-ui'

/** 侧栏最多直接显示的钉住技能数，超出折叠进「更多技能…」 */
const MAX_PINNED = 6

const SUBS: { tab: AgentTab; label: string; icon: React.ReactNode }[] = [
  { tab: 'chat', label: '对话', icon: <IconChat width={13} height={13} /> },
  { tab: 'skills', label: '技能', icon: <IconGrid width={13} height={13} /> },
  { tab: 'auto', label: '自动任务', icon: <IconZap width={13} height={13} /> },
  { tab: 'memory', label: '记忆', icon: <IconBrain width={13} height={13} /> }
]

function useAgentOpen(): [boolean, (v?: boolean) => void] {
  const key = 'ms_side_agent'
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== '0'
    } catch {
      return true
    }
  })
  return [
    open,
    (v?: boolean) =>
      setOpen(o => {
        const next = v ?? !o
        try {
          localStorage.setItem(key, next ? '1' : '0')
        } catch {
          /* 存储不可用时仅本次生效 */
        }
        return next
      })
  ]
}

/** 子项：缩进、字号小一级、行高略低于一级行 */
function SubRow(props: { icon: React.ReactNode; label: string; active?: boolean; onClick(): void; title?: string; muted?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
      aria-current={props.active ? 'page' : undefined}
      className={`w-full h-6 flex items-center gap-2 pl-[30px] pr-2 rounded-[var(--r-sm)] text-xs transition-colors ${props.active ? 'font-medium' : 'hover:bg-[var(--hover)]'}`}
      style={{ background: props.active ? 'var(--selected)' : undefined, color: props.active ? 'var(--accent-ink)' : props.muted ? 'var(--muted)' : 'var(--fg)' }}
    >
      <span className="w-3.5 shrink-0 inline-flex justify-center" style={{ color: props.active ? 'var(--accent)' : 'var(--faint)' }}>
        {props.icon}
      </span>
      <span className="flex-1 text-left truncate">{props.label}</span>
    </button>
  )
}

type RowComp = (props: {
  icon?: React.ReactNode
  label: string
  active?: boolean
  onClick(): void
  trailing?: React.ReactNode
}) => React.ReactElement

/**
 * 侧栏「智能」分组里的 Agent：一级行可展开（记住展开状态），
 * 子项：对话 · 技能 · 自动任务 · 记忆，再列出钉住的技能（点一下直接运行）。
 */
export function AgentNavSection(props: { Row: RowComp; ico: { width: number; height: number } }) {
  useSkillsLoader()
  const view = useView()
  const route = useAgentRoute()
  const [open, setOpen] = useAgentOpen()
  const [more, setMore] = useState(false)
  const skills = useSkills(st => st.skills)
  const pinned = sortSkills(skills.filter(s => s.pinned))
  const shown = more ? pinned : pinned.slice(0, MAX_PINNED)
  const inAgent = view === 'agent'
  const { Row } = props

  return (
    <>
      <Row
        icon={<IconRobot {...props.ico} />}
        label="Agent"
        active={inAgent && !open}
        onClick={() => {
          goAgent('chat')
          if (!open) setOpen(true)
        }}
        trailing={
          <span className="flex items-center gap-1">
            <kbd className="text-2xs" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>⌘J</kbd>
            <span
              role="button"
              tabIndex={0}
              aria-label={open ? '收起 Agent 子项' : '展开 Agent 子项'}
              aria-expanded={open}
              onClick={e => {
                e.stopPropagation()
                setOpen()
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  setOpen()
                }
              }}
              className="w-4 h-4 -mr-0.5 inline-flex items-center justify-center rounded-[var(--r-xs)] hover:bg-[var(--hover-strong)]"
              style={{ color: 'var(--faint)' }}
            >
              <span className="inline-flex transition-transform" style={{ transform: open ? 'none' : 'rotate(-90deg)', transitionDuration: 'var(--dur-2)' }}>
                <IconChevronDown width={11} height={11} />
              </span>
            </span>
          </span>
        }
      />
      {open && (
        <div className="flex flex-col gap-px pb-1" role="group" aria-label="Agent">
          {SUBS.map(s => (
            <SubRow key={s.tab} icon={s.icon} label={s.label} active={inAgent && route.tab === s.tab} onClick={() => goAgent(s.tab)} />
          ))}
          {pinned.length > 0 && <div className="mx-[30px] my-1 h-px" style={{ background: 'var(--border-soft)' }} />}
          {shown.map(s => (
            <SubRow
              key={s.id}
              icon={<SkillIcon name={s.icon} width={12} height={12} />}
              label={s.name}
              title={`运行技能：${s.description}`}
              onClick={() => requestSkillRun({ skill: s })}
            />
          ))}
          {pinned.length > MAX_PINNED && (
            <SubRow
              icon={<IconMore width={12} height={12} />}
              label={more ? '收起' : `更多技能… ${pinned.length - MAX_PINNED}`}
              muted
              onClick={() => setMore(m => !m)}
            />
          )}
        </div>
      )}
    </>
  )
}

/** ⌘K：Agent 各子页的跳转（常驻）+「运行技能：xxx」（searchOnly：输入文字后才出现，避免淹没默认列表） */
export function agentCommands(close: () => void): { id: string; group: string; label: string; keywords?: string; icon?: React.ReactNode; searchOnly?: boolean; run(): void }[] {
  const go = (tab: AgentTab) => () => {
    goAgent(tab)
    close()
  }
  const nav = [
    { id: 'nav-agent', group: '前往', label: 'Agent · 对话', keywords: 'agent chat 对话 提问', icon: <IconRobot width={14} height={14} />, run: go('chat') },
    { id: 'nav-agent-skills', group: '前往', label: 'Agent · 技能库', keywords: 'agent skills 技能 新建技能', icon: <IconGrid width={14} height={14} />, run: go('skills') },
    { id: 'nav-agent-auto', group: '前往', label: 'Agent · 自动任务与活动记录', keywords: 'agent jobs automation 自动 定时 活动', icon: <IconZap width={14} height={14} />, run: go('auto') },
    { id: 'nav-agent-memory', group: '前往', label: 'Agent · 记忆与发件人画像', keywords: 'agent memory 记忆 画像 profile', icon: <IconBrain width={14} height={14} />, run: go('memory') }
  ]
  const skills = sortSkills(useSkills.getState().skills).map(s => ({
    id: `skill-${s.id}`,
    group: 'Agent 技能',
    label: `运行技能：${s.name}`,
    keywords: `skill 技能 ${s.category} ${s.description}`,
    icon: <SkillIcon name={s.icon} width={14} height={14} />,
    searchOnly: true,
    run: () => {
      close()
      requestSkillRun({ skill: s })
    }
  }))
  return [...nav, ...skills]
}
