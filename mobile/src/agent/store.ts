import { create } from 'zustand'
import { useMail, type MobileMessage } from '../store/mail'
import { useWorkbench } from '../workbench/store'
import { aiWorkbench, getAIConfig } from '../ai/client'
import { linkToCore } from '../native/LinkToCore'
import { parseAgentResponse } from './plan'

export type Recipe = 'plan' | 'brief' | 'archive' | 'schedule'
interface Receipt { title: string; detail: string; undo?: () => Promise<void>; configureAI?: boolean }
interface AgentState {
  input: MobileMessage[] | null
  busy: boolean
  progress: string
  receipt: Receipt | null
  setInput(messages: MobileMessage[] | null): boolean
  run(recipe: Recipe): Promise<void>
  cancel(): void
  clear(): void
}
let controller: AbortController | null = null
export const useAgent = create<AgentState>((set, get) => ({
  input: null, busy: false, progress: '', receipt: null,
  setInput: input => { if (get().busy) return false; set({ input, receipt: null }); return true },
  cancel: () => { controller?.abort(); if (get().busy) set({ progress: '已请求停止，正在结束当前步骤…' }) },
  clear: () => { controller?.abort(); controller = null; set({ input: null, busy: false, progress: '', receipt: null }) },
  run: async recipe => {
    if (get().busy) return
    const run = new AbortController(); controller = run
    const check = () => { if (run.signal.aborted || useMail.getState().guard !== 'ready') throw new Error('已停止') }
    const source = [...(get().input ?? useMail.getState().messages)]
    const messages = (recipe === 'archive' ? source.filter(m => m.flags.includes('\\Seen')) : get().input ? source : source.filter(m => !m.flags.includes('\\Seen'))).slice(0, recipe === 'archive' ? 20 : 8)
    const undos: Array<() => Promise<void>> = []
    let completed = 0
    let configureAI = false
    set({ busy: true, progress: '准备工作流…', receipt: null })
    try {
      check()
      if (recipe === 'schedule') {
        const overflow = await useWorkbench.getState().schedule()
        if (controller !== run || useMail.getState().guard !== 'ready') return
        set({ receipt: { title: '今日安排已整理', detail: overflow ? `${overflow} 件排不下，保留待安排。固定时间保持不变。` : '待办已按可用时段安排，固定时间与休息保持不变。', undo: useWorkbench.getState().snapshotUndo() } })
      } else if (!messages.length) throw new Error(recipe === 'archive' ? '当前范围没有已读邮件' : '当前范围没有可处理的邮件，请在邮件列表选择后交给 Agent')
      else if (recipe === 'archive') {
        for (const message of messages) {
          check(); set({ progress: `归档 ${completed + 1} / ${messages.length}…` })
          const result = await useMail.getState().moveMessage(message, 'archive')
          if (result.undo) undos.push(result.undo)
          completed++
          if (controller === run && get().input) set({ input: get().input!.filter(m => !(m.accountId === message.accountId && m.mailbox === message.mailbox && m.uid === message.uid)) })
        }
        check()
        set({ input: null, receipt: { title: `已归档 ${completed} 封已读邮件`, detail: `来自当前加载范围；${undos.length} 封支持撤销。未发送任何邮件。`, undo: undos.length ? async () => { for (const undo of [...undos].reverse()) await undo() } : undefined } })
      } else {
        const config = await getAIConfig()
        check()
        if (!config.hasKey) { configureAI = true; throw new Error('请先配置 AI 接口与 Key；尚未读取邮件正文') }
        const payload = []
        for (const [index, message] of messages.entries()) {
          check(); set({ progress: `读取邮件 ${index + 1} / ${messages.length}…` })
          const body = await useMail.getState().fetchBody(message)
          check()
          payload.push({ index, subject: message.subject.slice(0, 240), from: message.from.slice(0, 240), text: (body.text || body.html?.replace(/<[^>]*>/g, ' ') || '').slice(0, 4000) })
        }
        set({ progress: '提炼摘要与行动项…' })
        const entries = parseAgentResponse(await aiWorkbench(payload, run.signal), messages.length)
        check()
        const detail = entries.map(e => `${messages[e.index].subject || '无主题'}\n${e.summary}`).join('\n\n') || '没有提取到需要处理的内容。'
        if (recipe === 'brief') set({ receipt: { title: `已整理 ${entries.length} 封邮件摘要`, detail } })
        else {
          const tasks = []
          for (const entry of entries) for (const task of entry.tasks) {
            const m = messages[entry.index]
            const source = { accountEmail: m.accountEmail, mailbox: m.mailbox, uid: m.uid, messageId: m.messageId, subject: m.subject, from: m.from, date: m.date }
            const id = 'agent-task-' + await linkToCore.sha256Hex(JSON.stringify([m.accountEmail.toLowerCase(), m.messageId || m.mailbox + ':' + m.uid, task.title.toLowerCase().replace(/\s+/g, ' ').trim()]))
            tasks.push({ id, title: task.title, content: task.detail, minutes: task.minutes, source, at: null })
          }
          check(); set({ progress: '保存待办并安排今日…' })
          const result = await useWorkbench.getState().importTasks(tasks)
          if (controller !== run || useMail.getState().guard !== 'ready') return
          set({ receipt: { title: `新增 ${result.added} 件待办`, detail: `跳过 ${result.skipped} 件已有记录；${result.overflow} 件待安排。新待办已排入今日，保留邮件来源。\n\n${detail}`, undo: result.added ? useWorkbench.getState().snapshotUndo() : undefined } })
        }
      }
    } catch (e) {
      if (controller === run && useMail.getState().guard === 'ready') set({ receipt: { title: run.signal.aborted ? '工作流已停止' : configureAI ? '先配置 AI' : '工作流未完成', configureAI, detail: `${completed ? `已归档 ${completed} 封，未完成部分没有自动重试。\n` : ''}${e instanceof Error ? e.message : String(e)}`, undo: undos.length ? async () => { for (const undo of [...undos].reverse()) await undo() } : undefined } })
    } finally { if (controller === run) { controller = null; set({ busy: false, progress: '' }) } }
  }
}))
