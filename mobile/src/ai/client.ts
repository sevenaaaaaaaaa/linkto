import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Keychain from 'react-native-keychain'

const BASE_KEY = 'linkto.ai.base'
const MODEL_KEY = 'linkto.ai.model'
const KEY_SERVICE = 'linkto.ai.key'
const DEFAULT_BASE = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-4o-mini'

export interface AIConfig {
  baseUrl: string
  model: string
  hasKey: boolean
}

export async function getAIConfig(): Promise<AIConfig> {
  const [base, model, creds] = await Promise.all([
    AsyncStorage.getItem(BASE_KEY),
    AsyncStorage.getItem(MODEL_KEY),
    Keychain.getGenericPassword({ service: KEY_SERVICE }).catch(() => false as const)
  ])
  return {
    baseUrl: (base || DEFAULT_BASE).replace(/\/+$/, ''),
    model: model || DEFAULT_MODEL,
    hasKey: !!creds && !!creds.password
  }
}

export async function saveAIConfig(input: { baseUrl: string; model: string; key?: string }): Promise<void> {
  const base = input.baseUrl.trim().replace(/\/+$/, '')
  const model = input.model.trim()
  if (base) await AsyncStorage.setItem(BASE_KEY, base)
  else await AsyncStorage.removeItem(BASE_KEY)
  if (model) await AsyncStorage.setItem(MODEL_KEY, model)
  else await AsyncStorage.removeItem(MODEL_KEY)
  if (typeof input.key === 'string') {
    if (input.key.trim()) await Keychain.setGenericPassword('ai', input.key.trim(), { service: KEY_SERVICE })
    else await Keychain.resetGenericPassword({ service: KEY_SERVICE }).catch(() => undefined)
  }
}

async function chat(config: AIConfig, key: string, system: string, user: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45_000)
  try {
    const res = await fetch(config.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user.slice(0, 12000) }
        ]
      }),
      signal: controller.signal
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error('AI 请求失败：HTTP ' + res.status + (detail ? ' · ' + detail.slice(0, 120) : ''))
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('AI 返回了空内容')
    return content.trim()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/abort/i.test(msg)) throw new Error('AI 请求超时')
    throw new Error(msg)
  } finally {
    clearTimeout(timer)
  }
}

async function ready(): Promise<{ config: AIConfig; key: string }> {
  const config = await getAIConfig()
  if (!config.hasKey) throw new Error('还没有配置 AI Key：设置 → AI 助手')
  const creds = await Keychain.getGenericPassword({ service: KEY_SERVICE })
  if (!creds || !creds.password) throw new Error('AI Key 不可用，请在设置里重新保存')
  return { config, key: creds.password }
}

export async function aiSummarize(input: { subject: string; from: string; text: string }): Promise<string> {
  const { config, key } = await ready()
  return chat(
    config,
    key,
    '你是邮件助理。用邮件本身的语言输出；中文邮件用中文，英文邮件用英文。只输出摘要，不要寒暄。',
    '请用 3-6 条短句总结这封邮件：谁、要什么、关键日期/金额/决定、需要我做什么。不要编造。\n\n主题：' +
      input.subject + '\n发件人：' + input.from + '\n\n正文：\n' + input.text
  )
}

export async function aiDraftReply(input: { subject: string; from: string; text: string }): Promise<string> {
  const { config, key } = await ready()
  return chat(
    config,
    key,
    '你是用户的邮件助理。用原邮件的语言起草回复；语气自然、简短、可执行。只输出正文，不要主题、称呼占位符或署名。',
    '请起草一封回复，回给 ' + input.from + '。\n主题：' + input.subject + '\n\n原邮件：\n' + input.text
  )
}
