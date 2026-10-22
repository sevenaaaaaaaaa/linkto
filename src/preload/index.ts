import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
  'suggestRecipients', 'aiComposeAssist',
  'getGeneralSettings', 'setGeneralSettings', 'setNativeAppearance', 'systemSymbols', 'macShellSetTitle', 'macShellSetSearch', 'macShellFocusSearch', 'getNotificationSettings', 'setNotificationSettings', 'notifyTest', 'notifyTestResult', 'getAISettings', 'setAISettings', 'aiProbeLocal', 'aiListModels', 'aiLocalStatus', 'aiLocalDownload', 'aiLocalCancelDownload', 'aiLocalRemove',
  'listSignatures', 'saveSignature', 'deleteSignature',
  'listTemplates', 'saveTemplate', 'deleteTemplate',
  'listRules', 'saveRule', 'deleteRule', 'reorderRules',
  'aiStream', 'aiCancel', 'aiClassify', 'aiSummarize', 'aiDraftReply', 'aiExtractTasks',
  'aiAskKnowledgeBase', 'aiTagKbItem',
  'saveToKb', 'listKbItems', 'deleteKbItem', 'updateKbItem',
  'insightExtract', 'generateDaily', 'companyInsight', 'listCompanyDomains',
  'listInsights', 'setInsightStatus', 'deleteInsight', 'saveMemo',
  'pinMessages', 'aiRankMessages', 'aiAskBulk', 'saveTodoSet',
  'snoozeMessages', 'setSenderStatus', 'screenerPendingCount', 'aiScreenSuggest', 'getSplitSignals',
  'listSmartViews', 'saveSmartView', 'deleteSmartView',
  'aiComposeQuery', 'aiSnoozeSuggest', 'aiJudgeFollowups', 'aiFollowupDraft', 'aiScreenBatch', 'nlSearch',
  'listConnectorManifests', 'listConnectorInstances', 'connectConnector', 'disconnectConnector', 'runConnectorAction', 'installUserConnector', 'listUserConnectors', 'removeUserConnector', 'getUserConnectorTemplate',
  'listCloudDrives', 'saveCloudDrive', 'removeCloudDrive', 'testCloudDrive', 'cloudUpload', 'cloudSyncEml', 'pickDirectory', 'detectProtonDrive',
  'attachList', 'attachStats', 'attachRescan', 'attachStatus', 'attachGetSettings', 'attachSetSettings', 'attachSetCategory', 'attachPin',
  'attachReleasePlan', 'attachRelease', 'attachEnsureLocal', 'attachSuggest', 'attachArchivePreview', 'attachArchiveStart',
  'attachArchiveControl', 'attachArchiveStatus', 'attachReveal', 'attachOpen', 'attachSaveMany', 'attachThumbs', 'attachAddProton',
  'listMemories', 'saveMemory', 'updateMemory', 'deleteMemory', 'memoryStats', 'agentLearn', 'agentProfile', 'agentChat', 'agentExecuteActions', 'aiStatus', 'createTodo', 'updateTodo', 'aiPlanTodos', 'todoFromMessage',
  'unsubscribe', 'setNewsletterSender', 'listNewsletterSenders',
  'ghostIdentity', 'ghostList', 'ghostReceiveScan', 'ghostSend', 'ghostOpen', 'ghostBurn', 'openGhost', 'openGhostReader',
  'getMcpStatus', 'setMcpEnabled', 'regenerateMcpToken',
  'todoSyncStatus', 'todoSyncConfigure', 'todoSyncNow',
  'todoIntegrationsStatus', 'todoIntegrationListTargets', 'todoIntegrationConnect', 'todoIntegrationUpdate',
  'todoIntegrationSyncNow', 'todoIntegrationDisconnect', 'calendarBusyBlocks',
  'contentAccessGet', 'contentAccessSet',
  'ocrStatus', 'ocrAttachment', 'clearAttachmentTextCache',
  'ruleSuggestions', 'ruleSuggestionAccept', 'ruleSuggestionDismiss', 'ruleSuggestReadSignal',
  'lifeList', 'lifeCreate', 'lifeUpdate', 'lifeDelete', 'lifeScan', 'lifeExportIcs', 'lifeMakeTodo', 'lifeFromMessage',
  'agentEventsFor', 'followupList', 'followupCreate', 'followupUpdate', 'followupNudge', 'readAttachmentText',
  'readAttachmentTextInfo',
  'agentRun', 'agentApprove', 'agentCancel', 'agentTools', 'agentThreads', 'agentThread', 'agentDeleteThread',
  'agentSkills', 'agentSaveSkill', 'agentDeleteSkill', 'agentJobs', 'agentJobSet', 'agentJobRunNow', 'agentActivity',
  'onboardingScanStatus', 'onboardingScanStart', 'onboardingScanDismiss',
  'agentJobSettings', 'agentJobSetSettings', 'onboardingScanLater',
  'financeList', 'financeCreate', 'financeUpdate', 'financeDelete', 'financeMarkPaid', 'financeMakeTodo', 'financeFromMessage',
  'financeMessages', 'financePair', 'financeUnpair', 'financeScan', 'financeExportCsv',
  'getMailInsights', 'understandMessage', 'todayBrief', 'getFolderPrefs', 'setFolderPref', 'suggestMoveTarget', 'senderContext',
  'openSettings', 'openCompose', 'getVersions', 'quit', 'connectivity',
  // 项目 / 时间线
  'listProjects', 'getProject', 'saveProject', 'deleteProject', 'projectFromMessage', 'projectAddMessages', 'projectRemoveMessages',
  'projectResolveSuggestion', 'projectRescan', 'projectTimeline', 'contactTimeline', 'projectSummarize', 'discoverProjects',
  // 导出与分享中心
  'shareTargets', 'shareSaveTarget', 'shareRemoveTarget', 'shareTestTarget', 'shareSettings', 'shareSetSettings',
  'sharePreview', 'shareSend', 'shareExport', 'shareCopy', 'shareLinks', 'shareOpenLink',
  // 订阅 / AI 搜索订阅
  'feedSources', 'feedDiscover', 'feedAddSource', 'feedUpdateSource', 'feedDeleteSource', 'feedRenameGroup', 'feedRefresh', 'feedItems', 'feedItem',
  'feedMarkRead', 'feedMarkAllRead', 'feedStar', 'feedFullText', 'feedSummarize', 'feedToReading', 'feedUnreadTotal', 'feedAddTopic', 'feedRunTopic',
  'feedGetSettings', 'feedSetSettings', 'feedSearchKeys', 'feedSetSearchKey', 'feedImportOpml', 'feedImportOpmlText', 'feedExportOpml', 'feedDigest', 'feedGenerateDigest',
  // 留痕
  'traceList', 'traceCreate', 'traceUpdate', 'traceDelete', 'traceOrganize', 'traceOcrImage', 'traceConfirmDraft', 'traceCheckReplies',
  'traceFromMessage', 'traceMakeTodo', 'traceRemember', 'traceVerify', 'traceExport', 'traceArchiveMail', 'traceOpenCapture', 'traceCapabilities',
  'traceSyncStatus', 'traceSyncConfigure', 'traceSyncNow',
  // 升级向导 / 侧栏
  'upgradeState', 'upgradeSetSeen', 'upgradeLater', 'sidebarUsage',
  // 跨设备同步与备份
  'devsyncStatus', 'devsyncConfigure', 'devsyncNow', 'devsyncCreatePairing', 'devsyncImportPairing', 'devsyncResolveDelete', 'devsyncUseCandidate', 'devsyncPushUiPrefs', 'devsyncUiPrefs',
  'backupxExport', 'backupxPick', 'backupxInspect', 'backupxRestore', 'backupxAutoGet', 'backupxAutoSet', 'backupxAutoRun',
  // 搜索索引 / 拼音
  'searchIndexStatus', 'pinyinKeys'
] as const

const api = {} as LinkToApi
for (const method of METHOD_NAMES) {
  ;(api as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => ipcRenderer.invoke(`api:${method}`, ...args)
}
;(api as unknown as { onEvent: (cb: (ev: unknown) => void) => () => void }).onEvent = (cb: (ev: unknown) => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
// 拖入撰写窗的文件 → 本地路径（沙箱下 File.path 已移除，需经 webUtils）
;(api as unknown as { pathForFile: (file: File) => string }).pathForFile = (file: File) => {
  try {
    return webUtils.getPathForFile(file)
  } catch {
    return ''
  }
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
