import { useState } from 'react'
import { useMail } from '../../stores/mail'
import { useSkills, useSkillsLoader, sortSkills, requestSkillRun, type SkillParams } from '../../lib/agent-skills'
import { IconClose } from '../../components/icons'
import type { AgentSkill } from '@shared/types'
import { AgentChatPanel } from './AgentChatPanel'
import { SkillIcon } from './skill-ui'

/** 右栏最多列出的技能数 */
const MAX = 4

/** 与当前邮件相关的技能：先「针对邮件」的，再补带联系人参数的（预填发件人），钉住的优先 */
function railSkills(skills: AgentSkill[]): AgentSkill[] {
  const sorted = sortSkills(skills)
  const byPin = (a: AgentSkill, b: AgentSkill) => Number(!!b.pinned) - Number(!!a.pinned)
  const msgSkills = sorted.filter(s => s.contextKind === 'message').sort(byPin)
  const contactSkills = sorted.filter(s => s.contextKind !== 'message' && (s.params ?? []).some(p => p.kind === 'contact' && p.required)).sort(byPin)
  return [...msgSkills, ...contactSkills].slice(0, MAX)
}

/**
 * 右侧上下文栏 Agent tab 的外壳：顶部「用技能处理这封邮件」快捷入口；
 * 点技能后在右栏以 initial.skillId 运行（替换为一个新的 AgentChatPanel，会话与左侧对话页共享）。
 * children = 默认的对话面板（ContextRail 原样传入）。
 */
export function RailAgentHost(props: { onClose(): void; children: React.ReactNode }) {
  useSkillsLoader()
  const skills = useSkills(st => st.skills)
  const selectedId = useMail(st => st.selectedId)
  const msg = useMail(st => st.messages.find(m => m.id === st.selectedId))
  const multi = useMail(st => st.selectedIds.size > 1)
  const [run, setRun] = useState<{ key: number; skillId: string; params: SkillParams; messageId: string | null } | null>(null)
  const list = railSkills(skills)
  const sender = msg?.from?.address ?? ''

  const start = (s: AgentSkill) => {
    const contactParam = (s.params ?? []).find(p => p.kind === 'contact')
    requestSkillRun({
      skill: s,
      messageId: selectedId,
      prefill: contactParam && sender ? { [contactParam.key]: sender } : undefined,
      onRun: (params, messageId) => setRun({ key: Date.now(), skillId: s.id, params, messageId: messageId ?? selectedId ?? null })
    })
  }

  type Initial = NonNullable<Parameters<typeof AgentChatPanel>[0]['initial']>
  const initial: (Initial & { context?: { messageId?: string | null } }) | null = run
    ? { skillId: run.skillId, params: run.messageId ? { ...run.params, messageId: run.messageId } : run.params, context: run.messageId ? { messageId: run.messageId } : undefined }
    : null

  return (
    <div className="h-full flex flex-col min-h-0">
      {selectedId && !multi && list.length > 0 && (
        <div className="shrink-0 px-3 pt-2.5 pb-2 border-b border-[var(--border-soft)]">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-2xs font-semibold" style={{ color: 'var(--faint)', letterSpacing: '0.04em' }}>用技能处理这封邮件</span>
            <span className="flex-1" />
            {run && (
              <button
                onClick={() => setRun(null)}
                className="h-5 px-1.5 rounded-[var(--r-xs)] text-2xs inline-flex items-center gap-1 hover:bg-[var(--hover)]"
                style={{ color: 'var(--muted)' }}
                title="回到普通对话"
              >
                <IconClose width={9} height={9} /> 结束技能
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {list.map(s => (
              <button
                key={s.id}
                onClick={() => start(s)}
                title={s.description}
                className="h-7 px-2 rounded-[var(--r-sm)] text-xs inline-flex items-center gap-1.5 border border-[var(--border)] hover:border-[var(--border-strong)] transition-colors"
                style={run?.skillId === s.id ? { background: 'var(--selected)', color: 'var(--accent-ink)' } : { background: 'var(--surface-strong)', color: 'var(--fg)' }}
              >
                <SkillIcon name={s.icon} width={12} height={12} />
                {s.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {run && initial ? <AgentChatPanel key={run.key} panel initial={initial} onClose={props.onClose} /> : props.children}
      </div>
    </div>
  )
}
