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

/** Agent 运行时的消息（含工具调用 / 工具结果；OpenAI 兼容格式） */
export type AIToolMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface AIToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface AIToolCall {
  id: string
  name: string
  arguments: string
}

/** 模型 / 服务商不支持 function calling：调用方回退到 JSON 动作协议 */
export class ToolsUnsupportedError extends Error {
  constructor(detail?: string) {
    super(`当前模型不支持工具调用${detail ? `（${detail}）` : ''}`)
    this.name = 'ToolsUnsupportedError'
  }
}

interface SSEToolPart {
  choices?: {
    delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }
    finish_reason?: string | null
  }[]
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

/** 后台用量闸门（自动任务模块注册）：每次请求前同步调用，后台任务超出每日上限 / 用电池时抛错；前台请求直接放行 */
let requestGuard: (() => void) | null = null

export function setAiRequestGuard(fn: (() => void) | null) {
  requestGuard = fn
}

/** 不经 AIService 自己发请求的模块（如 AI 识字的多模态请求）发请求前调用：同样计入后台用量 */
export function checkAiRequestGuard() {
  requestGuard?.()
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
    requestGuard?.()
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

  /**
   * Agent 运行时：一次「可带工具」的模型调用（OpenAI function calling，流式）。
   * - 文本增量经 onDelta 推出；tool_calls 按 index 累积后一次性返回
   * - 服务商不支持 tools（400 且正文提到 tool / function）时抛 ToolsUnsupportedError，由调用方回退到 JSON 动作协议
   * - 内置本地引擎不支持 tools：同样抛 ToolsUnsupportedError
   * 错误分类与 stream() 一致（AIError 固定句开头），不改 stream() 的行为
   */
  async chatTools(
    requestId: string,
    messages: AIToolMessage[],
    tools: AIToolSpec[] | null,
    onDelta: (delta: string) => void,
    opts: { toolChoice?: 'auto' | 'none' } = {}
  ): Promise<{ content: string; toolCalls: AIToolCall[]; finishReason: string | null }> {
    const s = this.getSettings()
    if (s.baseURL === 'builtin-local') {
      if (!s.enabled) throw new AIError('unconfigured', '在 设置 → AI 中开启')
      throw new ToolsUnsupportedError('内置本地引擎')
    }
    const isLocal = isLocalEndpoint(s.baseURL)
    if (!s.enabled || (!s.apiKey && !isLocal))
      throw new AIError('unconfigured', isLocal ? '在 设置 → AI 中开启' : '在 设置 → AI 中开启并填写 API Key')
    const prompts = (s.customPrompts ?? []).filter(p => p.enabled && p.text.trim()).map(p => p.text.trim()).join('\n\n')
    const msgs: AIToolMessage[] =
      prompts && messages[0]?.role === 'system'
        ? [{ ...messages[0], content: `${messages[0].content ?? ''}\n\n${prompts}` }, ...messages.slice(1)]
        : messages
    const controller = new AbortController()
    this.aborts.set(requestId, controller)
    const idle = isLocal ? IDLE_TIMEOUT_LOCAL : IDLE_TIMEOUT_CLOUD
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, idle)
    }
    const convert = (err: unknown): Error => {
      if (err instanceof AIError || err instanceof ToolsUnsupportedError) return err
      if (timedOut) return new AIError('timeout', `${Math.round(idle / 1000)} 秒没有响应`)
      if (controller.signal.aborted) return new Error('已取消')
      if (err instanceof TypeError || (err as { cause?: unknown })?.cause) return networkError(err, isLocal)
      return err instanceof Error ? err : new Error(String(err))
    }
    let content = ''
    let finishReason: string | null = null
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    try {
      arm()
      const body: Record<string, unknown> = { model: s.model, messages: msgs, stream: true }
      if (tools?.length) {
        body.tools = tools
        body.tool_choice = opts.toolChoice ?? 'auto'
      }
      const res = await fetch(`${s.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
        body: JSON.stringify(body)
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        if (tools?.length && (res.status === 400 || res.status === 422 || res.status === 501) && /tool|function/i.test(text)) {
          throw new ToolsUnsupportedError(text.replace(/\s+/g, ' ').slice(0, 120))
        }
        throw httpError(res.status, text || res.statusText, s.model)
      }
      // 少数服务商对 stream 请求直接回整段 JSON：按非流式解析
      const ctype = res.headers.get('content-type') ?? ''
      if (ctype.includes('application/json')) {
        const json = (await res.json()) as {
          choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]
          error?: { message?: string }
        }
        if (json.error?.message) {
          const kind = aiKindFromHttp(0, json.error.message)
          throw kind === 'unknown' ? new Error(json.error.message) : new AIError(kind, json.error.message.slice(0, 120))
        }
        const c = json.choices?.[0]
        content = c?.message?.content ?? ''
        if (content) onDelta(content)
        finishReason = c?.finish_reason ?? null
        const toolCalls = (c?.message?.tool_calls ?? []).map((t, i) => ({ id: t.id || `call_${i}`, name: t.function?.name ?? '', arguments: t.function?.arguments ?? '' }))
        return { content, toolCalls: toolCalls.filter(t => t.name), finishReason }
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
          let part: SSEToolPart
          try {
            part = JSON.parse(payload) as SSEToolPart
          } catch {
            continue
          }
          if (part.error?.message) {
            const kind = aiKindFromHttp(0, part.error.message)
            throw kind === 'unknown' ? new Error(part.error.message) : new AIError(kind, part.error.message.slice(0, 120))
          }
          const choice = part.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason
          const delta = choice.delta?.content ?? ''
          if (delta) {
            content += delta
            onDelta(delta)
          }
          for (const tc of choice.delta?.tool_calls ?? []) {
            const idx = typeof tc.index === 'number' ? tc.index : calls.size
            const cur = calls.get(idx) ?? { id: '', name: '', arguments: '' }
            if (tc.id) cur.id = tc.id
            if (tc.function?.name) cur.name += tc.function.name
            if (tc.function?.arguments) cur.arguments += tc.function.arguments
            calls.set(idx, cur)
          }
        }
      }
      const toolCalls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments }))
        .filter(c => c.name)
      return { content, toolCalls, finishReason }
    } catch (err) {
      throw convert(err)
    } finally {
      if (timer) clearTimeout(timer)
      this.aborts.delete(requestId)
    }
  }


  async complete(messages: AIChatMessage[], maxTokens = 2000): Promise<string> {
    return this.stream(`c-${randomUUID()}`, messages, () => {})
  }
}
