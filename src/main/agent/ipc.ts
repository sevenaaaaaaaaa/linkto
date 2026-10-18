import { ipcMain } from 'electron'
import type { LinkToApi } from '@shared/ipc'
import type { AgentRuntime } from './runtime'
import { setSkillRunner } from './hooks'

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
    agentSaveSkill: skill => rt.saveSkill(skill),
    agentDeleteSkill: id => rt.deleteSkill(String(id))
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
}
