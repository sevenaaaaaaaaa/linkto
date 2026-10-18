import { useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { api, useMailEvent } from '../../lib/api'
import type { ComposeAssistInput, ComposeRewriteStyle } from '@shared/ipc'

type PMNode = Editor['state']['doc']

export const REWRITE_STYLES: { id: ComposeRewriteStyle; label: string; hint: string }[] = [
  { id: 'polish', label: '润色', hint: '改错字病句，更通顺' },
  { id: 'formal', label: '更正式', hint: '商务、礼貌' },
  { id: 'concise', label: '更简洁', hint: '删冗余，留要点' },
  { id: 'friendly', label: '更友好', hint: '温和亲切' },
  { id: 'en', label: '翻译成英文', hint: 'English' },
  { id: 'zh', label: '翻译成中文', hint: '简体中文' }
]

/** 主进程 / 模型的原始错误 → 面向用户的中文说明（不出现英文原文） */
export function friendlyAiError(raw: string): string {
  const s = raw || ''
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.*key/i.test(s)) return 'AI 服务拒绝了请求：API Key 可能无效或没有权限，请到设置里检查。'
  if (/未启用|未配置/.test(s)) return 'AI 还没接入：在设置里配置云端 API 或本地模型后即可使用。'
  if (/\b429\b|rate.?limit|quota|insufficient/i.test(s)) return 'AI 服务繁忙或额度不足，请稍后再试。'
  if (/\b404\b|model.*not.*found|不存在的模型/i.test(s)) return '找不到所选模型，请在设置里检查模型名称。'
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|socket|连接/i.test(s)) return '连不上 AI 服务，请检查网络或服务地址。'
  if (/本地引擎/.test(s)) return '本地 AI 引擎没能启动，请在设置里重新选择模型。'
  if (/abort/i.test(s)) return '已停止生成。'
  return 'AI 暂时不可用，请稍后重试。'
}

/** 清理模型输出：去掉代码块围栏、首尾引号 */
export function cleanAiText(s: string): string {
  return s
    .replace(/^\s*```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

/** 主题输出只取一行，去掉「主题：」前缀与引号 */
export function cleanSubject(s: string): string {
  const line = cleanAiText(s).split('\n').map(l => l.trim()).find(Boolean) ?? ''
  return line.replace(/^(主题|subject)\s*[:：]\s*/i, '').replace(/^["“「『]|["”」』。.]$/g, '').trim()
}

function blockText(node: PMNode): string {
  const inner = (n: PMNode) => n.textBetween(0, n.content.size, '\n', '\n')
  if (node.type.name === 'bulletList' || node.type.name === 'orderedList') {
    const lines: string[] = []
    node.forEach((item, _o, i) => lines.push(`${node.type.name === 'orderedList' ? `${i + 1}.` : '-'} ${inner(item).replace(/\n+/g, ' ')}`))
    return lines.join('\n')
  }
  if (node.type.name === 'blockquote') return inner(node).split('\n').map(l => `> ${l}`).join('\n')
  return inner(node)
}

/** 正文 → 轻 Markdown（保留段落与列表，供 AI 改写 / 发送前检查） */
export function editorPlainText(editor: Editor | null): string {
  if (!editor) return ''
  const parts: string[] = []
  editor.state.doc.forEach(n => parts.push(blockText(n)))
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

export interface AiJob {
  kind: ComposeAssistInput['task']
  style?: ComposeRewriteStyle
  label: string
  /** 改写的原文（对比预览用） */
  source: string
  /** 改写选区（null = 全文） */
  range: { from: number; to: number } | null
  input: ComposeAssistInput
  text: string
  streaming: boolean
  error?: string
}

/** 撰写窗 AI 流：只认自己的 requestId；重新开始会取消上一个 */
export function useComposeAi() {
  const [job, setJob] = useState<AiJob | null>(null)
  const reqRef = useRef('')

  useMailEvent(ev => {
    if (ev.type !== 'ai-stream' || !reqRef.current || ev.requestId !== reqRef.current) return
    if (ev.done) reqRef.current = ''
    setJob(j =>
      j
        ? {
            ...j,
            text: j.text + (ev.delta ?? ''),
            streaming: !ev.done,
            error: ev.error ? friendlyAiError(ev.error) : j.error
          }
        : j
    )
  })

  const start = (meta: Omit<AiJob, 'text' | 'streaming' | 'error'>) => {
    if (reqRef.current) void api.aiCancel(reqRef.current)
    const id = `compose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    reqRef.current = id
    setJob({ ...meta, text: '', streaming: true })
    api.aiComposeAssist(id, meta.input).catch(err => {
      if (reqRef.current !== id) return
      reqRef.current = ''
      setJob(j => (j ? { ...j, streaming: false, error: friendlyAiError(String(err)) } : j))
    })
  }

  const stop = () => {
    if (reqRef.current) void api.aiCancel(reqRef.current)
    reqRef.current = ''
    setJob(j => (j ? { ...j, streaming: false } : j))
  }

  const discard = () => {
    if (reqRef.current) void api.aiCancel(reqRef.current)
    reqRef.current = ''
    setJob(null)
  }

  return { job, start, stop, discard, retry: () => job && start(job) }
}
