import { contextBridge, ipcRenderer } from 'electron'
import type { LinkToApi } from '@shared/ipc'
import type { ComposeDraft } from '@shared/types'

const listeners = new Set<(ev: unknown) => void>()
ipcRenderer.on('event', (_e, payload) => {
  for (const cb of listeners) cb(payload)
})

// sandbox 模式下 contextBridge 只接受可序列化结构/普通函数，
// 因此用显式方法表（而非 Proxy）构建 API。
const METHOD_NAMES = [
  'listAccounts', 'addAccount', 'verifyAccount', 'updateAccount', 'setAccountEnabled',
  'deleteAccount', 'syncAccountNow',
  'getOAuthClientConfig', 'setOAuthClientConfig', 'oauthAuthorize',
  'listBackupTargets', 'createBackup', 'restoreBackupPick', 'restoreBackupApply',
  'listFolders', 'getMessages', 'getMessage', 'markRead', 'markFlagged', 'markAnswered',
  'moveMessages', 'moveToFolder', 'deleteMessages', 'searchMessages', 'getAttachment', 'getInlineImage', 'saveAttachment',
  'sendMail', 'scheduleSend', 'cancelScheduledSend', 'listScheduledSends',
  'saveDraft', 'listDrafts', 'deleteDraft', 'pickFiles', 'openExternal',
  'getGeneralSettings', 'setGeneralSettings', 'getNotificationSettings', 'setNotificationSettings', 'notifyTest', 'getAISettings', 'setAISettings', 'aiProbeLocal', 'aiListModels', 'aiLocalStatus', 'aiLocalDownload', 'aiLocalCancelDownload', 'aiLocalRemove',
  'listSignatures', 'saveSignature', 'deleteSignature',
  'listTemplates', 'saveTemplate', 'deleteTemplate',
  'listRules', 'saveRule', 'deleteRule', 'reorderRules',
  'aiStream', 'aiCancel', 'aiClassify', 'aiSummarize', 'aiDraftReply', 'aiExtractTasks',
  'aiAskKnowledgeBase', 'aiTagKbItem',
  'saveToKb', 'listKbItems', 'deleteKbItem', 'updateKbItem',
  'insightExtract', 'generateDaily', 'companyInsight', 'listCompanyDomains',
  'listInsights', 'setInsightStatus', 'deleteInsight', 'saveMemo',
  'pinMessages', 'aiRankMessages', 'aiAskBulk', 'saveTodoSet',
  'listConnectorManifests', 'listConnectorInstances', 'connectConnector', 'disconnectConnector', 'runConnectorAction', 'installUserConnector', 'listUserConnectors', 'removeUserConnector', 'getUserConnectorTemplate',
  'listMemories', 'saveMemory', 'updateMemory', 'deleteMemory', 'memoryStats', 'agentLearn', 'agentProfile', 'agentChat',
  'unsubscribe', 'setNewsletterSender', 'listNewsletterSenders',
  'openSettings', 'openCompose', 'getVersions', 'quit'
] as const

const api = {} as LinkToApi
for (const method of METHOD_NAMES) {
  ;(api as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => ipcRenderer.invoke(`api:${method}`, ...args)
}
;(api as unknown as { onEvent: (cb: (ev: unknown) => void) => () => void }).onEvent = (cb: (ev: unknown) => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** 撰写窗口从 URL hash 中解析预填内容 */
export function parseComposePrefill(): Partial<ComposeDraft> | undefined {
  const m = location.hash.match(/#\/compose\?prefill=([^&]+)/)
  if (!m) return undefined
  try {
    return JSON.parse(decodeURIComponent(m[1])) as Partial<ComposeDraft>
  } catch {
    return undefined
  }
}

contextBridge.exposeInMainWorld('api', api)
