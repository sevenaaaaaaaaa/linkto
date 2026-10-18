import { AgentChat } from '../AgentView'

/**
 * Agent 对话面板（左侧 Agent「对话」页与右侧上下文栏共用）。
 * 占位实现：运行时接入后替换为工具调用式对话（步骤流、确认卡、来源胶囊、会话列表）。
 */
export function AgentChatPanel(props: {
  threadId?: string | null
  panel?: boolean
  onClose?(): void
  /** 打开即发起：普通提问或按技能运行 */
  initial?: { text?: string; skillId?: string | null; params?: Record<string, string | number> } | null
  onThreadChange?(id: string): void
}) {
  return <AgentChat panel={props.panel} onClose={() => props.onClose?.()} />
}
