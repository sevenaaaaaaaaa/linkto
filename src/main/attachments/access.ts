import { ipcMain } from 'electron'
import type { AppStore } from '../store'
import type { AISettings, AttachmentAccessBlock, AttachmentAccessSettings, AttachmentContentKind } from '@shared/types'
import { isLocalEndpoint } from '../ai/service'

/**
 * 附件内容读取授权：用户同意前不读取任何附件的内容。
 * 所有「读附件内容」的入口（正文提取、OCR、Office、Agent 工具、知识库学习、财务核对）先过 allows()；
 * 要把内容发给 AI 的地方再过 allowsAI()（云端 AI 需要单独授权，本地模型不受限）。
 */

const KEY = 'attachmentAccess'

export const DEFAULT_ACCESS: AttachmentAccessSettings = {
  readContent: false,
  kinds: { pdf: true, office: true, text: true, ocr: true },
  sendToCloudAI: false,
  ocrEngine: 'local',
  visionModel: null,
  excludedAccounts: [],
  asked: false
}

export interface AccessDeps {
  appStore: AppStore
  getAISettings(): AISettings
  event(payload: unknown): void
}

let deps: AccessDeps | null = null
let lastAskAt = 0

export function getAccess(): AttachmentAccessSettings {
  const saved = deps?.appStore.get<Partial<AttachmentAccessSettings>>(KEY, {}) ?? {}
  return { ...DEFAULT_ACCESS, ...saved, kinds: { ...DEFAULT_ACCESS.kinds, ...(saved.kinds ?? {}) } }
}

export function setAccess(patch: Partial<AttachmentAccessSettings>): AttachmentAccessSettings {
  const next: AttachmentAccessSettings = {
    ...getAccess(),
    ...patch,
    kinds: { ...getAccess().kinds, ...(patch.kinds ?? {}) },
    asked: true,
    updatedAt: Date.now()
  }
  deps?.appStore.set(KEY, next)
  deps?.event({ type: 'content-access-changed', settings: next })
  return next
}

/** 本机读取某类附件内容是否被允许；没授权时（每 10 分钟最多一次）广播 'content-access-needed' 让界面弹出授权说明 */
export function allows(kind: AttachmentContentKind, opts: { accountId?: string | null; reason?: string; silent?: boolean } = {}): { ok: true } | { ok: false; block: AttachmentAccessBlock; error: string } {
  const a = getAccess()
  if (!a.readContent) {
    if (!opts.silent && Date.now() - lastAskAt > 10 * 60_000) {
      lastAskAt = Date.now()
      deps?.event({ type: 'content-access-needed', kind, reason: opts.reason ?? null })
    }
    return { ok: false, block: 'consent', error: '还没有授权 LinkTo 读取附件内容（设置 → 附件与存储 → 附件内容读取）' }
  }
  if (!a.kinds[kind]) return { ok: false, block: 'kind', error: `已关闭读取${KIND_LABEL[kind]}的内容` }
  if (opts.accountId && a.excludedAccounts.includes(opts.accountId)) return { ok: false, block: 'account', error: '这个账户的附件已设为不读取内容' }
  return { ok: true }
}

/** 用户主动操作（如问 Agent 读附件）被拦时：立即请界面弹出授权说明（不受 10 分钟节流、也不管是否问过） */
export function requestAccessPrompt(kind: AttachmentContentKind | 'cloud', reason?: string | null) {
  deps?.event({ type: 'content-access-needed', kind, reason: reason ?? null, interactive: true })
}

/** 附件内容能否交给当前配置的 AI：本地端点 / 内置引擎总是可以；云端需要 sendToCloudAI */
export function allowsAI(baseURL?: string): boolean {
  const url = baseURL ?? deps?.getAISettings().baseURL ?? ''
  if (url === 'builtin-local' || isLocalEndpoint(url)) return true
  return getAccess().sendToCloudAI
}

export const KIND_LABEL: Record<AttachmentContentKind, string> = {
  pdf: ' PDF ',
  office: ' Word / Excel / PowerPoint ',
  text: '文本类附件',
  ocr: '扫描件（OCR）'
}

export function initAttachmentAccess(d: AccessDeps) {
  deps = d
  ipcMain.handle('api:contentAccessGet', () => getAccess())
  ipcMain.handle('api:contentAccessSet', (_e, patch: unknown) => setAccess((patch ?? {}) as Partial<AttachmentAccessSettings>))
}
