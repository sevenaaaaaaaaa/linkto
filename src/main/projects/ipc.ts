import { ipcMain } from 'electron'
import type { LinkToApi } from '@shared/ipc'
import type { ProjectService } from './service'

type ProjectMethods =
  | 'listProjects' | 'getProject' | 'saveProject' | 'deleteProject' | 'projectFromMessage' | 'projectAddMessages'
  | 'projectRemoveMessages' | 'projectResolveSuggestion' | 'projectRescan' | 'projectTimeline' | 'contactTimeline'
  | 'projectSummarize' | 'discoverProjects'

type Handler<K extends ProjectMethods> = (...args: Parameters<LinkToApi[K]>) => Awaited<ReturnType<LinkToApi[K]>> | ReturnType<LinkToApi[K]>

/** 项目 / 时间线 IPC（独立注册，不改动主 ipc.ts 的处理器表） */
export function registerProjectIpc(projects: ProjectService) {
  const handlers: { [K in ProjectMethods]: Handler<K> } = {
    listProjects: () => projects.list(),
    getProject: id => projects.detail(String(id)),
    saveProject: input => projects.save(input ?? { data: {} }),
    deleteProject: id => projects.remove(String(id)),
    projectFromMessage: messageId => projects.fromMessage(String(messageId)),
    projectAddMessages: (projectId, ids) => projects.addMessages(String(projectId), Array.isArray(ids) ? ids : []),
    projectRemoveMessages: (projectId, ids) => projects.removeMessages(String(projectId), Array.isArray(ids) ? ids : []),
    projectResolveSuggestion: (projectId, threadId, accept) => projects.resolveSuggestion(String(projectId), String(threadId), !!accept),
    projectRescan: projectId => projects.rescan(String(projectId)),
    projectTimeline: projectId => projects.timeline(String(projectId)),
    contactTimeline: key => projects.contactTimeline(String(key ?? '')),
    projectSummarize: projectId => projects.summarize(String(projectId)),
    discoverProjects: days => projects.discover(Number(days) || 60)
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
}
