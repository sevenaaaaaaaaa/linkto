import { api } from './api'
import { AI_ERROR_TEXT, classifyAIError, type AIErrorKind } from '@shared/errors'

/** 全局 toast 的动作按钮 */
export interface ToastAction {
  label: string
  run(): void
}

/** 全局 toast 载荷：`ms:toast` 的 detail 可以是字符串（旧用法），也可以是带动作的对象 */
export interface ToastPayload {
  text: string
  actions?: ToastAction[]
  /** 停留毫秒数；带动作时默认更长 */
  duration?: number
  tone?: 'danger' | 'default'
}

export interface AIErrorView {
  kind: AIErrorKind
  /** 给人看的一句话（已去掉 Electron 的 "Error invoking remote method" 前缀） */
  text: string
  action?: ToastAction
}

/** 去掉 ipcRenderer.invoke 抛错时附带的英文前缀 */
export function cleanErrorText(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : String(raw ?? '')
  return msg.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(Type)?Error:\s*/, '').trim()
}

export const openAISettings = () => void api.openSettings('ai')

/**
 * 把 AI 错误变成「一句人话 + 一个动作」：
 * 未配置 / Key 无效 / 模型错 → 去设置 AI；网络 / 超时 / 服务异常 → 重试（有 retry 时）；额度 → 查看设置
 */
export function describeAIError(raw: unknown, retry?: () => void): AIErrorView {
  const cleaned = cleanErrorText(raw)
  const kind = classifyAIError(cleaned)
  // 旧文案 / 原始英文统一成固定句；主进程已给出的中文细节原样保留
  let text = cleaned
  if (kind !== 'unknown' && !cleaned.includes(AI_ERROR_TEXT[kind])) text = AI_ERROR_TEXT[kind]
  if (!text) text = 'AI 出错了'
  const settings: ToastAction = { label: '去设置 AI', run: openAISettings }
  const retryAction: ToastAction | undefined = retry ? { label: '重试', run: retry } : undefined
  switch (kind) {
    case 'unconfigured':
    case 'auth':
    case 'model':
      return { kind, text, action: settings }
    case 'quota':
      return { kind, text, action: { label: '查看设置', run: openAISettings } }
    case 'network-local':
      return { kind, text, action: retryAction ?? settings }
    case 'network':
    case 'timeout':
    case 'server':
      return { kind, text, action: retryAction }
    default:
      return { kind, text: /[一-鿿]/.test(text) ? text : `AI 出错了：${text.slice(0, 120)}`, action: retryAction }
  }
}

/**
 * 是否为可识别的 AI 错误（全局 toast 据此自动附上动作按钮）。
 * 只认主进程的 AI 固定句 / 既有 AI 文案——不把「上传失败：fetch failed」这类非 AI 的网络错误误判成 AI 错误
 */
export function isAIError(raw: unknown): boolean {
  const text = cleanErrorText(raw)
  if (classifyAIError(text) === 'unknown') return false
  return Object.values(AI_ERROR_TEXT).some(t => text.includes(t)) || /AI 未启用|AI 未开启|AI 未配置|未配置 API Key|AI 还没配置|AI 请求失败/.test(text)
}

export function showToast(payload: string | ToastPayload) {
  window.dispatchEvent(new CustomEvent('ms:toast', { detail: payload }))
}

/** 以全局 toast 呈现 AI 失败（带动作按钮）；suffix 用于补一句兜底说明（如「已先按规则排布」） */
export function toastAIError(raw: unknown, retry?: () => void, opts?: { suffix?: string }) {
  const v = describeAIError(raw, retry)
  showToast({ text: `${v.text}${opts?.suffix ?? ''}`, actions: v.action ? [v.action] : undefined, tone: 'danger' })
}

/**
 * 通用失败提示兜底：主进程已中文化的原样展示；原始英文（ENOENT / EACCES / fetch failed 等）换成中文并保留简短原因
 */
export function friendlyFailure(prefix: string, raw: unknown): string {
  const text = cleanErrorText(raw)
  if (!text) return prefix
  if (/[一-鿿]/.test(text)) return `${prefix}：${text}`
  const hint =
    /ENOSPC/i.test(text) ? '磁盘空间不足'
    : /EACCES|EPERM|permission/i.test(text) ? '没有写入权限，换个位置试试'
    : /ENOENT|not found|no such file/i.test(text) ? '文件或目标不存在（可能已被移动或删除）'
    : /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNRESET|socket|network|offline/i.test(text) ? '网络不可用，联网后再试'
    : /timeout|ETIMEDOUT/i.test(text) ? '连接超时，稍后再试'
    : /auth|login|credentials/i.test(text) ? '账户登录失效，请在 设置 → 账户 中重新登录'
    : '出了点问题，稍后再试'
  return `${prefix}：${hint}`
}
