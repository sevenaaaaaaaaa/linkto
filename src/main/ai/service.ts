import { randomUUID } from 'node:crypto'
import type { AISettings, AIChatMessage } from '@shared/types'

export interface AIStreamHandle {
  abort(): void
}

interface SSEPart {
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[]
  error?: { message?: string }
}

/** OpenAI 兼容接口客户端（GLM / OpenAI / DeepSeek / 其他均可） */
export class AIService {
  private aborts = new Map<string, AbortController>()

  constructor(private getSettings: () => AISettings) {}

  async stream(requestId: string, messages: AIChatMessage[], onDelta: (delta: string) => void): Promise<string> {
    const s = this.getSettings()
    if (!s.enabled || !s.apiKey) throw new Error('AI 未启用或未配置 API Key（请在 设置 → AI 中配置）')
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
        body: JSON.stringify({ model: s.model, messages, stream: true })
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
