import { ipcMain } from 'electron'
import type { LinkToApi } from '@shared/ipc'
import type { AgentRuntime } from './runtime'
import { notifySkillsChanged, setSkillLister, setSkillRunner } from './hooks'

type AgentMethods =
  | 'agentRun' | 'agentApprove' | 'agentCancel' | 'agentTools' | 'agentThreads' | 'agentThread' | 'agentDeleteThread'
  | 'agentSkills' | 'agentSaveSkill' | 'agentDeleteSkill'

type Handler<K extends AgentMethods> = (...args: Parameters<LinkToApi[K]>) => Awaited<ReturnType<LinkToApi[K]>> | ReturnType<LinkToApi[K]>

/** Agent 运行时 IPC（api:agent*，独立注册，不改动主 ipc.ts 的处理器表）；同时把无界面技能运行交给自动任务 */
export function registerAgentIpc(rt: AgentRuntime) {
  const handlers: { [K in AgentMethods]: Handler<K> } = {
    agentRun: input => rt.start(input),
    agentApprove: (runId, callId, approve, remember) => rt.approve(String(runId), String(callId), !!approve, !!remember),
    agentCancel: runId => rt.cancel(String(runId)),
    agentTools: () => rt.toolInfos(),
    agentThreads: () => rt.threads(),
    agentThread: id => rt.thread(String(id)),
    agentDeleteThread: id => rt.deleteThread(String(id)),
    agentSkills: () => rt.skills(),
    agentSaveSkill: skill => {
      const saved = rt.saveSkill(skill)
      // 定时设置可能变了：让调度器重排技能任务
      notifySkillsChanged()
      return saved
    },
    agentDeleteSkill: id => {
      rt.deleteSkill(String(id))
      notifySkillsChanged()
    }
  }
  for (const [method, handler] of Object.entries(handlers)) {
    ipcMain.handle(`api:${method}`, async (_event, ...args) => {
      try {
        return await (handler as (...a: unknown[]) => unknown)(...args)
      } catch (err) {
        console.error(`[ipc:${method}]`, err)
        throw err
      }
    })
  }
  setSkillRunner((skillId, params) => rt.runSkillHeadless(skillId, params))
  // 调度器按技能的 schedule 建定时任务：内置（含用户覆盖）+ 自定义技能
  setSkillLister(() => rt.skills())
  notifySkillsChanged()
}
