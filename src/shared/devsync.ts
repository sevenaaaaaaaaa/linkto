/**
 * 跨设备同步与备份（devsync / backupx）：主进程与设置窗共用的类别目录与状态类型。
 * 协议细节见 src/main/devsync/protocol.ts 顶部注释。
 */

export type DevSyncCategory =
  | 'accounts'
  | 'memory'
  | 'kb'
  | 'skills'
  | 'threads'
  | 'todo'
  | 'finance'
  | 'project'
  | 'life'
  | 'trace'
  | 'followup'
  | 'reading'
  | 'feeds'
  | 'rules'
  | 'templates'
  | 'signatures'
  | 'prefs'
  | 'share'
  | 'shareSecrets'
  | 'ai'
  | 'aiKey'
  | 'jobs'
  | 'attachAccess'

export interface DevSyncCategoryInfo {
  id: DevSyncCategory
  label: string
  desc: string
  /** 默认是否开启 */
  defaultOn: boolean
  /** 含密码 / 令牌 / 密钥（只在加密载荷里出现） */
  secrets?: boolean
  /** 子开关：依附于父类别（父类别关闭时不生效） */
  parent?: DevSyncCategory
  /** 风险说明（开关旁展示） */
  risk?: string
  /** 由已有通道同步（待办 LinkTo-Sync / 留痕 LinkTo-Trace），这里只是总开关 */
  legacyFolder?: string
}

export const DEVSYNC_CATEGORIES: DevSyncCategoryInfo[] = [
  { id: 'accounts', label: '账户与凭据', desc: '服务器、端口、加密方式、颜色、签名关联、文件夹偏好，以及密码 / 授权码 / OAuth 令牌', defaultOn: true, secrets: true },
  { id: 'memory', label: 'Agent 记忆', desc: '偏好、联系人、事实与承诺', defaultOn: true },
  { id: 'kb', label: '知识库', desc: '收藏的邮件与笔记（单条超过 512 KB 的不同步）', defaultOn: true },
  { id: 'skills', label: '自定义技能与技能设置', desc: '自建技能、内置技能的置顶 / 定时 / 自动批准 / 事件触发', defaultOn: true },
  { id: 'threads', label: 'Agent 对话', desc: '与 Agent 的历史对话（体积较大，默认关闭）', defaultOn: false },
  { id: 'todo', label: '待办', desc: '沿用待办同步文件夹 LinkTo-Sync（手机端可读）', defaultOn: true, legacyFolder: 'LinkTo-Sync' },
  { id: 'finance', label: '财务', desc: '账单、订阅、订单、发票与付款状态', defaultOn: true },
  { id: 'project', label: '项目', desc: '项目、成员与关联邮件', defaultOn: true },
  { id: 'life', label: '生活档案', desc: '证件、保险、年检、会员等到期事务', defaultOn: true },
  { id: 'trace', label: '留痕', desc: '沿用留痕同步文件夹 LinkTo-Trace', defaultOn: true, legacyFolder: 'LinkTo-Trace' },
  { id: 'followup', label: '跟进', desc: '发出后在等对方的事', defaultOn: true },
  { id: 'reading', label: '阅读清单', desc: '稍后读', defaultOn: true },
  { id: 'feeds', label: '订阅源与 AI 搜索主题', desc: 'RSS / Atom / JSON Feed 订阅源、AI 搜索订阅与订阅设置（文章本身各设备各自抓取）', defaultOn: true },
  { id: 'rules', label: '规则', desc: '收信规则与自动化配方', defaultOn: true },
  { id: 'templates', label: '模板', desc: '回复模板', defaultOn: true },
  { id: 'signatures', label: '签名', desc: '签名与各账户的默认签名', defaultOn: true },
  { id: 'prefs', label: '个性化设置', desc: '外观主题、列表与阅读偏好、通知、通用设置、智能视图', defaultOn: true },
  { id: 'share', label: '分享目标', desc: '分享到 IM / 笔记 / 网盘的目标与导出设置（不含密钥）', defaultOn: true },
  {
    id: 'shareSecrets',
    label: '包含 Webhook 地址与密钥',
    desc: '分享目标的 Webhook 地址、签名密钥、Token',
    defaultOn: false,
    secrets: true,
    parent: 'share',
    risk: '拿到 Webhook 地址的人可以往你的群里发消息。开启后它们会加密存进同步文件夹；只有知道同步口令的设备能解开。'
  },
  { id: 'ai', label: 'AI 设置', desc: '服务地址、模型、自动化开关与自定义咒语（不含 API Key）', defaultOn: true },
  {
    id: 'aiKey',
    label: '包含 API Key',
    desc: 'AI 服务的 API Key、订阅搜索来源的 Key',
    defaultOn: false,
    secrets: true,
    parent: 'ai',
    risk: 'API Key 可直接产生费用。开启后它会加密存进同步文件夹；只有知道同步口令的设备能解开。'
  },
  { id: 'jobs', label: '自动任务设置', desc: '各后台任务的开关、AI 用量上限', defaultOn: true },
  { id: 'attachAccess', label: '附件内容授权', desc: '是否允许读取附件内容、发给云端 AI、识字引擎', defaultOn: true }
]

export const defaultDevSyncCategories = (): Record<DevSyncCategory, boolean> =>
  Object.fromEntries(DEVSYNC_CATEGORIES.map(c => [c.id, c.defaultOn])) as Record<DevSyncCategory, boolean>

/** 同步过来的账户在本机的问题（设置窗账户页 / 同步页展示） */
export interface DevSyncAccountIssue {
  accountId: string
  email: string
  /** device-local：本机专用凭据未填写；auth：同步来的密码登录失败；oauth：需要重新授权；network：暂时连不上 */
  kind: 'device-local' | 'auth' | 'oauth' | 'network'
  text: string
  /** 有另一台设备同步来的（本机专用）凭据可以试 */
  hasCandidate?: boolean
  /** 候选凭据来自哪台设备 */
  candidateDevice?: string | null
  at: number
}

/** 另一台设备删除了账户：本机删除前先问一次 */
export interface DevSyncPendingDelete {
  key: string
  accountId: string
  email: string
  device: string | null
  at: number
}

export interface DevSyncDevice {
  id: string
  name: string
  platform: string
  appVersion: string
  lastSyncAt: number | null
  self: boolean
}

export interface DevSyncStats {
  pulled: number
  pushed: number
  removed: number
  conflicts: number
  oversize: number
  at: number
}

export interface DevSyncStatus {
  enabled: boolean
  /** 同步邮箱（与待办同步共用） */
  accountId: string | null
  deviceId: string
  deviceName: string
  /** 同步口令（与待办同步共用） */
  hasPassphrase: boolean
  running: boolean
  lastSyncAt: number | null
  lastError: string | null
  lastStats: DevSyncStats | null
  folder: string
  categories: Record<DevSyncCategory, boolean>
  /** 本机各类别条数 */
  counts: Partial<Record<DevSyncCategory, number>>
  devices: DevSyncDevice[]
  pendingDeletes: DevSyncPendingDelete[]
  accountIssues: DevSyncAccountIssue[]
  /** 已有通道的状态（待办 / 留痕） */
  legacy: {
    todo: { enabled: boolean; lastSyncAt: number | null; lastError: string | null }
    trace: { enabled: boolean; lastSyncAt: number | null; lastError: string | null }
  }
}

export interface DevSyncConfigureInput {
  enabled: boolean
  accountId?: string | null
  passphrase?: string
  deviceName?: string
  categories?: Partial<Record<DevSyncCategory, boolean>>
}

// ---------------- 备份（backupx） ----------------

export interface BackupxHeader {
  /** 1 = 旧版（只有账户）；2 = 含各中心数据 */
  version: number
  createdAt: number
  accountCount: number
  hasSecrets: boolean
  /** v2：各类别条数（明文头，恢复前展示；不含内容） */
  categories?: Partial<Record<DevSyncCategory, number>>
}

export interface BackupxAutoSettings {
  enabled: boolean
  targetId: string
  /** targetId = 'pick' 时的目录 */
  dir: string | null
  keep: number
  includeSecrets: boolean
  categories: Partial<Record<DevSyncCategory, boolean>>
  hasPassphrase: boolean
  lastAt: number | null
  lastPath: string | null
  lastError: string | null
}

export interface BackupxRestoreResult {
  ok: boolean
  error?: string
  /** 各类别：新增 / 更新 / 跳过 */
  perCategory: Partial<Record<DevSyncCategory, { added: number; updated: number; skipped: number }>>
  accounts: { added: string[]; updated: string[]; skipped: string[]; failed: string[]; pending: string[] }
}
