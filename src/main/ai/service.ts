import { randomUUID } from 'node:crypto'
import type { AISettings, AIChatMessage } from '@shared/types'

export interface AIStreamHandle {
  abort(): void
}

interface SSEPart {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
  error?: { message?: string }
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
      if (!s.enabled) throw new Error('AI 未启用（请在 设置 → AI 中开启）')
      if (!this.local) throw new Error('本地引擎初始化失败')
      return this.local.stream(s.model, messages, onDelta)
    }
    // 本地推理端点（Ollama / LM Studio / llama.cpp）无需 API Key
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(s.baseURL)
    if (!s.enabled || (!s.apiKey && !isLocal))
      throw new Error(isLocal ? 'AI 未启用（请在 设置 → AI 中开启）' : 'AI 未启用或未配置 API Key（请在 设置 → AI 中配置）')
    // 用户自定义咒语：统一追加到首条系统消息（无系统消息则注入一条）
    const prompts = (s.customPrompts ?? []).filter(p => p.enabled && p.text.trim()).map(p => p.text.trim()).join('\n\n')
    const msgs: AIChatMessage[] = prompts
      ? messages[0]?.role === 'system'
        ? [{ ...messages[0], content: `${messages[0].content}\n\n${prompts}` }, ...messages.slice(1)]
        : [{ role: 'system', content: prompts }, ...messages]
      : messages
    const controller = new AbortController()
    this.aborts.set(requestId, controller)
    let full = ''
    try {
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
        throw new Error(`AI 请求失败 (${res.status})：${text.slice(0, 200) || res.statusText}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
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
            if (part.error?.message) throw new Error(part.error.message)
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
    } finally {
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
