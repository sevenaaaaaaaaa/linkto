import type { AgentRef } from '@shared/types'
import { goView } from './route'
import { openFinance } from './finance'
import { openContactTimeline, openProject } from './projects'
import { useMail } from '../stores/mail'
import { openFollowups } from './followups'
import { openLife } from './life'
import { openTrace } from './trace'

const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

/** 打开活动记录 / 首次整理结果里引用的对象 */
export function openAgentRef(ref: AgentRef) {
  switch (ref.type) {
    case 'mail':
    case 'thread': {
      goView('mail')
      useMail.getState().setScope({ kind: 'unified', title: '统一收件箱' })
      setTimeout(() => useMail.getState().select(ref.id), 80)
      return
    }
    case 'todo':
      goView('todo')
      setTimeout(() => window.dispatchEvent(new CustomEvent('ms:todo-open', { detail: ref.id })), 250)
      return
    case 'finance':
      openFinance(ref.id)
      return
    case 'project':
      openProject(ref.id)
      return
    case 'kb':
      goView('kb')
      setTimeout(() => window.dispatchEvent(new CustomEvent('ms:kb-open', { detail: ref.id })), 250)
      return
    case 'attachment':
      goView('attachments')
      return
    case 'contact':
      openContactTimeline(ref.id)
      return
    case 'memory':
      goView('agent')
      return
    case 'followup':
      openFollowups(ref.id)
      return
    case 'life':
      openLife(ref.id)
      return
    case 'trace':
      openTrace(ref.id)
      return
    default:
      toast('暂时打不开这个对象')
  }
}

