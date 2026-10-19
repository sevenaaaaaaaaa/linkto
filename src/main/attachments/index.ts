import { ipcMain } from 'electron'
import { initAttachmentAccess } from './access'
import type { LinkToApi } from '@shared/ipc'
import { AttachmentService, type AttachmentDeps } from './service'
import { initAttachmentText } from './text'

export { AttachmentService }
export { attachmentText } from './text'

/** 进程内单例：ipc.ts 的附件读取 / 保存在缓存被释放后借它自动重新下载 */
let current: AttachmentService | null = null

export function attachmentService(): AttachmentService | null {
  return current
}

type Handler<K extends keyof LinkToApi> = (...args: Parameters<LinkToApi[K]>) => Awaited<ReturnType<LinkToApi[K]>> | ReturnType<LinkToApi[K]>

/** 附件中心：创建服务并注册 api:attach* 处理器（与 ipc.ts 同一通道命名与错误日志约定） */
export function initAttachments(deps: AttachmentDeps): AttachmentService {
  const svc = new AttachmentService(deps)
  current = svc
  const handlers: { [K in keyof LinkToApi as K extends `attach${string}` ? K : never]: Handler<K> } = {
    attachList: q => svc.list(q ?? {}),
    attachStats: () => svc.stats(),
    attachRescan: async () => {
      await svc.scan()
      return svc.stats()
    },
    attachStatus: ids => svc.status(Array.isArray(ids) ? ids : []),
    attachGetSettings: () => svc.getSettings(),
    attachSetSettings: patch => svc.setSettings(patch ?? {}),
    attachSetCategory: (ids, category) => svc.setCategory(ids ?? [], category),
    attachPin: (ids, pinned) => svc.setPinned(ids ?? [], !!pinned),
    attachReleasePlan: ids => svc.releasePlan(ids ?? null),
    attachRelease: ids => svc.release(ids ?? []),
    attachEnsureLocal: id => svc.ensureLocal(id),
    attachSuggest: days => svc.suggest(days ?? 90),
    attachArchivePreview: (driveId, ids, template) => svc.preview(driveId, ids ?? [], template),
    attachArchiveStart: (driveId, ids) => svc.startArchive(driveId, ids ?? []),
    attachArchiveControl: action => svc.control(action),
    attachArchiveStatus: () => svc.jobStatus(),
    attachReveal: (id, driveId) => svc.reveal(id, driveId),
    attachOpen: id => svc.open(id),
    attachSaveMany: ids => svc.saveMany(ids ?? []),
    attachThumbs: ids => svc.thumbs(ids ?? []),
    attachAddProton: () => svc.addProton()
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
  svc.start()
  // 附件内容读取授权（同意前不读任何附件内容）：api:contentAccess*
  initAttachmentAccess({ appStore: deps.appStore, getAISettings: deps.getAISettings, event: deps.event })
  // 附件正文（PDF 文本层 / 纯文本）：api:readAttachmentText + hooks 读取器
  initAttachmentText({ db: deps.db, store: deps.store, attachments: svc, finance: deps.finance, event: deps.event })
  return svc
}
