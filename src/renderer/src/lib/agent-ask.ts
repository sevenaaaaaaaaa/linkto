import { useMail } from '../stores/mail'
import { goView } from './route'

let pending: string | null = null

/** 切到邮件视图、打开右侧 Agent 栏，并把问题交给 Agent（会前准备 / 会后跟进等） */
export function askAgent(question: string) {
  pending = question
  goView('mail')
  if (useMail.getState().rail !== 'agent') useMail.getState().toggleRail('agent')
  // Agent 栏已挂载时直接投递；未挂载时由 AgentChatPanel 挂载后领取
  window.dispatchEvent(new CustomEvent('ms:agent-ask'))
}

/** AgentChatPanel 领取待问的问题（只领一次） */
export function takePendingAsk(): string | null {
  const q = pending
  pending = null
  return q
}
