import type { CloudDriveKind } from './types'

/**
 * 附件中心：索引 / 分类 / 本地缓存策略 / 网盘归档 的主-渲染共享模型。
 * 主进程实现见 src/main/attachments/。
 */

export type AttachmentCategory =
  | 'invoice'
  | 'contract'
  | 'quote'
  | 'resume'
  | 'design'
  | 'sheet'
  | 'document'
  | 'slides'
  | 'archive'
  | 'media'
  | 'calendar'
  | 'other'

/** 分类展示顺序与中文名（界面与网盘目录名共用） */
export const ATTACHMENT_CATEGORIES: { id: AttachmentCategory; label: string }[] = [
  { id: 'invoice', label: '发票收据' },
  { id: 'contract', label: '合同协议' },
  { id: 'quote', label: '报价订单' },
  { id: 'resume', label: '简历' },
  { id: 'design', label: '设计图片' },
  { id: 'sheet', label: '表格' },
  { id: 'document', label: '文档' },
  { id: 'slides', label: '演示文稿' },
  { id: 'archive', label: '压缩包' },
  { id: 'media', label: '音视频' },
  { id: 'calendar', label: '日历邀请' },
  { id: 'other', label: '其他' }
]

export function attachmentCategoryLabel(c: AttachmentCategory | string): string {
  return ATTACHMENT_CATEGORIES.find(x => x.id === c)?.label ?? '其他'
}

/** 一份已确认存在的网盘副本 */
export interface AttachmentCloudCopy {
  driveId: string
  driveName: string
  kind: CloudDriveKind
  /** 网盘根目录下的相对路径（以 / 开头） */
  path: string
  /** 本地同步目录类网盘：副本的绝对路径（「在 Finder 中显示」用） */
  localPath?: string
  /** 上传时的内容哈希（sha256） */
  hash?: string | null
  at: number
}

export interface AttachmentItem {
  /** 已下载：attachments.id；仅元数据（尚未下载）：r:<messageId>:<part> */
  id: string
  messageId: string
  accountId: string
  filename: string
  contentType: string
  size: number
  ext: string
  category: AttachmentCategory
  /** rule = 扩展名 / 关键词规则；ai = AI 补充判定；manual = 用户手动改 */
  categorySource: 'rule' | 'ai' | 'manual'
  confidence: number
  /** 对方：公司（域名主体）或个人发件人 */
  counterparty: string
  /** 对方地址（邮箱） */
  counterpartyAddr: string
  /** in = 对方发给我；out = 我发出的 */
  direction: 'in' | 'out'
  subject: string
  date: number
  /** 仅有元数据（邮件正文还没下载过） */
  remoteOnly: boolean
  /** 本地缓存文件存在 */
  cached: boolean
  /** 曾被「释放空间」删除本地缓存的时间 */
  releasedAt: number | null
  hash: string | null
  pinned: boolean
  cloud: AttachmentCloudCopy[]
}

export interface AttachmentQuery {
  category?: AttachmentCategory | null
  accountId?: string | null
  counterparty?: string | null
  year?: number | null
  search?: string | null
  /** local = 本地有缓存；released = 已释放；remote = 只有元数据；archived = 已在网盘；unarchived = 未归档 */
  state?: 'local' | 'released' | 'remote' | 'archived' | 'unarchived' | null
  sort?: 'date' | 'size' | 'name'
  limit?: number
  offset?: number
}

export interface AttachmentBucket {
  key: string
  label: string
  count: number
  bytes: number
  /** 其中本地缓存占用 */
  localBytes: number
}

export interface AttachmentStats {
  total: { count: number; bytes: number }
  local: { count: number; bytes: number }
  released: { count: number; bytes: number }
  remote: { count: number; bytes: number }
  archived: { count: number; bytes: number }
  byCategory: AttachmentBucket[]
  byAccount: AttachmentBucket[]
  byYear: AttachmentBucket[]
  byCounterparty: AttachmentBucket[]
  largest: AttachmentItem[]
  duplicates: { hash: string; size: number; count: number; wasted: number; items: { id: string; filename: string; messageId: string }[] }[]
  /** 本地 eml 原文镜像占用（信息展示，释放空间不动它） */
  emlBytes: number
  /** 缓存目录里没有数据库记录的孤立文件（不可恢复，不自动删除） */
  orphan: { count: number; bytes: number }
  lastScanAt: number | null
}

export interface AttachmentSettings {
  /** 保留最近 N 天的本地缓存（0 = 不按时间） */
  keepDays: number
  /** 本地缓存总量上限（GB，0 = 不限） */
  maxCacheGB: number
  /** 已归档到网盘的可从本地释放 */
  releaseArchived: boolean
  /** 永久保留的分类（不参与释放建议） */
  keepCategories: AttachmentCategory[]
  /** 归档目录模板（相对网盘根目录） */
  pathTemplate: string
  /** 默认归档网盘 */
  defaultDriveId: string | null
  /** 自动规则：这些分类的新附件到达后自动归档到指定网盘 */
  autoRules: { category: AttachmentCategory; driveId: string }[]
  /** 自动规则从这个时间之后到达的附件开始生效 */
  autoSince: number
  /** AI 已配置时，对拿不准的附件做补充分类 */
  aiAssist: boolean
}

export const DEFAULT_ATTACHMENT_PATH_TEMPLATE = '附件/{分类}/{年份}/{对方}/{日期}_{文件名}'

export const DEFAULT_ATTACHMENT_SETTINGS: AttachmentSettings = {
  keepDays: 180,
  maxCacheGB: 0,
  releaseArchived: true,
  keepCategories: ['invoice', 'contract'],
  pathTemplate: DEFAULT_ATTACHMENT_PATH_TEMPLATE,
  defaultDriveId: null,
  autoRules: [],
  autoSince: 0,
  aiAssist: true
}

export type ReleaseReason = 'old' | 'archived' | 'quota' | 'manual'

export interface ReleasePlanItem {
  id: string
  filename: string
  size: number
  date: number
  category: AttachmentCategory
  reason: ReleaseReason
  /** 释放后可从哪里恢复 */
  via: ('eml' | 'imap' | 'cloud')[]
}

export interface ReleasePlan {
  items: ReleasePlanItem[]
  bytes: number
  /** 按策略本该释放、但安全判定不通过 / 被保留的 */
  skipped: { id: string; filename: string; size: number; reason: string }[]
}

export interface ArchiveTarget {
  driveId: string
  name: string
  kind: CloudDriveKind
  /** 网盘根目录显示（本地同步目录为绝对路径） */
  root: string
  isProton: boolean
}

export interface ArchiveSuggestion {
  windowDays: number
  count: number
  bytes: number
  byCategory: { category: AttachmentCategory; count: number }[]
  /** 归档后可释放的本地空间（排除永久保留分类与钉住的） */
  releasableBytes: number
  /** 尚未下载、归档时需先拉取的数量 */
  needDownload: number
  targets: ArchiveTarget[]
  /** 推荐的目标（默认网盘 / Proton 优先） */
  recommended: string | null
  ids: string[]
}

export interface ArchivePreviewItem {
  id: string
  filename: string
  size: number
  category: AttachmentCategory
  /** 网盘根目录下的相对路径 */
  target: string
  action: 'upload' | 'download-upload' | 'skip-archived' | 'skip-duplicate'
}

export interface ArchivePreview {
  driveId: string
  driveName: string
  root: string
  items: ArchivePreviewItem[]
  uploadCount: number
  uploadBytes: number
  skipCount: number
}

export interface ArchiveJobStatus {
  id: string
  driveId: string
  driveName: string
  state: 'running' | 'paused' | 'done' | 'cancelled'
  total: number
  done: number
  uploaded: number
  skipped: number
  bytesDone: number
  current: string | null
  failed: { id: string; filename: string; error: string; driveId?: string }[]
  startedAt: number
  finishedAt: number | null
  /** auto = 自动规则触发 */
  origin: 'manual' | 'auto'
}
