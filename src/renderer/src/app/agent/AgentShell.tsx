import { useEffect, useState } from 'react'
import { api, useAsync } from '../../lib/api'
import { useAgentRoute, goAgent, goView, agentHash, type AgentTab } from '../../lib/route'
import { useSkillsLoader, peekPendingLaunch, clearPendingLaunch, type SkillLaunch } from '../../lib/agent-skills'
import { IconBrain } from '../../components/icons'
import { Seg } from '../finance/ui'
import { AgentChatPanel } from './AgentChatPanel'
import { AutomationPanel } from './AutomationPanel'
import { SkillsPage } from './SkillsPage'
import { MemoryPage } from './MemoryPage'

type ChatInitial = NonNullable<Parameters<typeof AgentChatPanel>[0]['initial']>

/**
 * Agent 页外壳：#/agent（默认对话）· #/agent/skills · #/agent/auto · #/agent/memory
 * 顶部一行：标题 + 子页切换 + 记忆统计
 */
export function AgentShell() {
  useSkillsLoader()
  const route = useAgentRoute()
  const { data: stats, reload: reloadStats } = useAsync(() => api.memoryStats().catch(() => null), [route.tab])

  useEffect(() => {
    return api.onEvent(ev => {
      if ((ev as { type: string }).type === 'agent-changed') reloadStats()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <header className="drag-region shrink-0 px-6 pt-4 pb-3 flex flex-wrap items-end gap-3 border-b border-[var(--border)]">
        <div className="flex-1 min-w-[180px]">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--fg)', letterSpacing: '-0.01em' }}>Agent</h1>
          <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            替你读邮件、查待办与账目、整理资料；改动和发信都先问你
          </div>
        </div>
        <Seg<AgentTab>
          value={route.tab}
          onChange={t => goAgent(t)}
          options={[
            { value: 'chat', label: '对话' },
            { value: 'skills', label: '技能' },
            { value: 'auto', label: '自动任务' },
            { value: 'memory', label: '记忆' }
          ]}
        />
        <button
          onClick={() => goAgent('memory')}
          title="Agent 从邮件里日积月累记住的事"
          className="no-drag h-8 px-2.5 inline-flex items-center gap-1.5 rounded-[var(--r-sm)] text-xs hover:bg-[var(--hover)]"
          style={{ color: 'var(--muted)' }}
        >
          <IconBrain width={13} height={13} />
          {stats ? (
            <span className="tnum">
              {stats.total} 条记忆{stats.weekNew ? <span style={{ color: 'var(--faint)' }}> · 本周 +{stats.weekNew}</span> : null}
            </span>
          ) : (
            '记忆'
          )}
        </button>
      </header>

      {route.tab === 'chat' ? (
        <ChatPage threadId={route.threadId} />
      ) : route.tab === 'skills' ? (
        <SkillsPage />
      ) : route.tab === 'auto' ? (
        <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
          <AutomationPanel />
        </div>
      ) : (
        <MemoryPage onStatsChange={reloadStats} />
      )}
    </div>
  )
}

/**
 * 对话页：全宽挂载 AgentChatPanel。
 * - #/agent/chat/<threadId> 打开指定会话
 * - launchSkill() 投递的技能运行：以新的 key 重新挂载，带 initial.skillId / params
 * 会话 id 变化时用 replaceState 写回地址（不触发 hashchange，避免面板重挂载打断运行）
 */
function ChatPage(props: { threadId: string | null }) {
  const [state, setState] = useState<{ key: string; threadId: string | null; initial: ChatInitial | null; nonce?: number }>(() => {
    const launch = peekPendingLaunch()
    return launch ? fromLaunch(launch) : { key: `t-${props.threadId ?? 'new'}`, threadId: props.threadId, initial: null }
  })

  useEffect(() => {
    if (state.nonce) clearPendingLaunch(state.nonce)
  }, [state.nonce])

  useEffect(() => {
    const take = () => {
      const launch = peekPendingLaunch()
      if (launch) {
        clearPendingLaunch(launch.nonce)
        setState(fromLaunch(launch))
      }
    }
    window.addEventListener('ms:agent-launch', take)
    return () => window.removeEventListener('ms:agent-launch', take)
  }, [])

  // 地址里的会话被外部改变（侧栏 / 后退）时切换会话
  useEffect(() => {
    setState(cur => (props.threadId && props.threadId !== cur.threadId ? { key: `t-${props.threadId}`, threadId: props.threadId, initial: null } : cur))
  }, [props.threadId])

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <AgentChatPanel
        key={state.key}
        threadId={state.threadId}
        initial={state.initial}
        onClose={() => goView('mail')}
        onThreadChange={id => {
          setState(cur => ({ ...cur, threadId: id }))
          const target = agentHash('chat', id)
          if (location.hash !== target) history.replaceState(null, '', target)
        }}
      />
    </div>
  )
}

function fromLaunch(l: SkillLaunch): { key: string; threadId: string | null; initial: ChatInitial; nonce: number } {
  // messageId 同时放进 params 与 context：运行时按 context.messageId 取邮件上下文（AgentChatPanel 透传 initial 时可用）
  const initial: ChatInitial & { context?: { messageId?: string | null } } = {
    skillId: l.skillId,
    params: l.messageId ? { ...l.params, messageId: l.messageId } : l.params,
    context: l.messageId ? { messageId: l.messageId } : undefined
  }
  return { key: `run-${l.nonce}`, threadId: null, initial, nonce: l.nonce }
}
