import { randomUUID } from 'node:crypto'
import type { AISettings, AIChatMessage } from '@shared/types'
import { AI_ERROR_TEXT, aiKindFromHttp, type AIErrorKind } from '@shared/errors'

export interface AIStreamHandle {
  abort(): void
}

interface SSEPart {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
  error?: { message?: string }
}

/** 本地推理端点（Ollama / LM Studio / llama.cpp）：无需 API Key */
export function isLocalEndpoint(baseURL: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(baseURL)
}

/**
 * AI 是否可用的唯一判断（各功能共用，避免「对话能用、洞察/Agent 却报未启用」）。
 * allowBuiltin=false：内置小模型不承担该任务（按模型策略，结构化重任务走 API / 本地部署）
 */
export function aiReady(s: AISettings, allowBuiltin = true): boolean {
  if (!s.enabled) return false
  if (s.baseURL === 'builtin-local') return allowBuiltin
  return !!s.apiKey || isLocalEndpoint(s.baseURL)
}

/** 带类别的 AI 错误：message 以 AI_ERROR_TEXT 固定句开头（渲染端据此识别类别），code 供主进程内部判断 */
export class AIError extends Error {
  constructor(public readonly kind: Exclude<AIErrorKind, 'unknown'>, detail?: string) {
    super(detail ? `${AI_ERROR_TEXT[kind]}（${detail}）` : AI_ERROR_TEXT[kind])
    this.name = 'AIError'
  }
  get code() {
    return `ai:${this.kind}`
  }
}

/** 无响应超时：云端 90s、本地 180s（本地首次加载模型较慢）；每收到一段数据重新计时 */
const IDLE_TIMEOUT_CLOUD = 90_000
const IDLE_TIMEOUT_LOCAL = 180_000

/** fetch 抛出的网络层错误 → 中文分类错误（undici 把真实原因放在 cause.code） */
function networkError(err: unknown, isLocal: boolean): AIError {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause
  const code = cause?.code ?? (err as { code?: string })?.code ?? ''
  const text = `${code} ${cause?.message ?? ''} ${err instanceof Error ? err.message : String(err)}`
  if (/UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|ETIMEDOUT/i.test(text)) return new AIError('timeout', code || undefined)
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|certificate/i.test(text)) return new AIError('network', '证书校验失败')
  return new AIError(isLocal ? 'network-local' : 'network', code || undefined)
}

/** HTTP 非 2xx → 中文分类错误；无法归类的保留原状态码与片段 */
function httpError(status: number, body: string, model: string): Error {
  const snippet = body.replace(/\s+/g, ' ').slice(0, 160)
  const kind = aiKindFromHttp(status, body)
  if (kind === 'model') return new AIError('model', status === 404 && !/model/i.test(body) ? `「${model}」，也可能是接口地址填错了` : `「${model}」，在 设置 → AI 中换一个可用的模型`)
  if (kind === 'auth') return new AIError('auth', `HTTP ${status}`)
  if (kind === 'quota') return new AIError('quota', status === 429 ? '429，稍后再试或检查账户余额' : `HTTP ${status}，检查账户余额`)
  if (kind === 'server') return new AIError('server', `HTTP ${status}`)
  return new Error(`AI 请求失败 (${status})：${snippet}`)
}

/** OpenAI 兼容接口客户端（GLM / OpenAI / DeepSeek / 其他均可）；baseURL=builtin-local 时走内置本地引擎 */
export class AIService {
  private aborts = new Map<string, AbortController>()
  private local: { stream(modelId: string, messages: AIChatMessage[], onDelta: (d: string) => void): Promise<string> } | null = null

  constructor(private getSettings: () => AISettings) {}

  /** 注入内置本地推理引擎（LocalEngine），在 bootstrap 时调用 */
  attachLocalEngine(engine: NonNullable<AIService['local']>) {
    this.local = engine
  }

  async stream(requestId: string, messages: AIChatMessage[], onDelta: (delta: string) => void): Promise<string> {
    const s = this.getSettings()
    // 内置本地引擎：模型推理完全在本机，无需 Key、断网可用
    if (s.baseURL === 'builtin-local') {
      if (!s.enabled) throw new AIError('unconfigured', '在 设置 → AI 中开启')
      if (!this.local) throw new Error('本地引擎初始化失败')
      return this.local.stream(s.model, messages, onDelta)
    }
    // 本地推理端点（Ollama / LM Studio / llama.cpp）无需 API Key
    const isLocal = isLocalEndpoint(s.baseURL)
    if (!s.enabled || (!s.apiKey && !isLocal))
      throw new AIError('unconfigured', isLocal ? '在 设置 → AI 中开启' : '在 设置 → AI 中开启并填写 API Key')
    // 用户自定义咒语：统一追加到首条系统消息（无系统消息则注入一条）
    const prompts = (s.customPrompts ?? []).filter(p => p.enabled && p.text.trim()).map(p => p.text.trim()).join('\n\n')
    const msgs: AIChatMessage[] = prompts
      ? messages[0]?.role === 'system'
        ? [{ ...messages[0], content: `${messages[0].content}\n\n${prompts}` }, ...messages.slice(1)]
        : [{ role: 'system', content: prompts }, ...messages]
      : messages
    const controller = new AbortController()
    this.aborts.set(requestId, controller)
    // 无响应超时：长时间没有任何数据就主动中断，避免按钮一直转圈
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, isLocal ? IDLE_TIMEOUT_LOCAL : IDLE_TIMEOUT_CLOUD)
    }
    /** 统一转换：已分类的错误原样抛出，其余按超时 / 取消 / 网络归类 */
    const convert = (err: unknown): Error => {
      if (err instanceof AIError) return err
      if (timedOut) return new AIError('timeout', `${Math.round((isLocal ? IDLE_TIMEOUT_LOCAL : IDLE_TIMEOUT_CLOUD) / 1000)} 秒没有响应`)
      if (controller.signal.aborted) return new Error('已取消')
      if (err instanceof TypeError || (err as { cause?: unknown })?.cause) return networkError(err, isLocal)
      return err instanceof Error ? err : new Error(String(err))
    }
    let full = ''
    try {
      arm()
      const res = await fetch(`${s.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${s.apiKey}`
        },
        body: JSON.stringify({ model: s.model, messages: msgs, stream: true })
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        throw httpError(res.status, text || res.statusText, s.model)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        arm()
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const part = JSON.parse(payload) as SSEPart
            if (part.error?.message) {
              // 流内错误（部分服务商以 200 + error 帧返回额度 / 模型错误）：能归类就归类
              const kind = aiKindFromHttp(0, part.error.message)
              throw kind === 'unknown' ? new Error(part.error.message) : new AIError(kind, part.error.message.slice(0, 120))
            }
            const delta = part.choices?.[0]?.delta?.content ?? ''
            if (delta) {
              full += delta
              onDelta(delta)
            }
          } catch (e) {
            if (e instanceof Error && !/JSON/i.test(e.message)) throw e
          }
        }
      }
      return full
    } catch (err) {
      throw convert(err)
    } finally {
      if (timer) clearTimeout(timer)
      this.aborts.delete(requestId)
    }
  }

  cancel(requestId: string) {
    this.aborts.get(requestId)?.abort()
  }

  async complete(messages: AIChatMessage[], maxTokens = 2000): Promise<string> {
    return this.stream(`c-${randomUUID()}`, messages, () => {})
  }
}
