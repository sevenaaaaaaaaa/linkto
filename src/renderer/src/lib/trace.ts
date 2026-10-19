import { create } from 'zustand'
import { useEffect } from 'react'
import { api } from './api'
import { goView } from './route'
import type { TraceRecord, TraceStatus } from '@shared/trace'

/** 留痕数据：insights kind='trace'（主进程 src/main/trace） */
interface TraceState {
  records: TraceRecord[]
  loaded: boolean
  load(): Promise<void>
}

export const useTrace = create<TraceState>(set => ({
  records: [],
  loaded: false,
  load: async () => {
    try {
      set({ records: await api.traceList(), loaded: true })
    } catch {
      set({ loaded: true })
    }
  }
}))

let subscribed = false
/** 挂一次（侧栏入口常驻）：增删改 / 书面确认状态变化后刷新；通知点击打开条目；托盘 / 快捷键打开捕获浮层 */
export function useTraceEvents() {
  useEffect(() => {
    if (!useTrace.getState().loaded) void useTrace.getState().load()
    if (subscribed) return
    subscribed = true
    let timer = 0
    const off = api.onEvent(ev => {
      const e = ev as { type: string; id?: string | null }
      if (e.type === 'trace-changed') {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => void useTrace.getState().load(), 150)
      }
      if (e.type === 'open-trace') openTrace(e.id ?? null)
      if (e.type === 'trace-capture') openTraceCapture()
    })
    return () => {
      subscribed = false
      void off()
    }
  }, [])
}

/** 打开留痕页并定位到某条 */
export function openTrace(id?: string | null) {
  goView('trace')
  if (id) setTimeout(() => window.dispatchEvent(new CustomEvent('ms:trace-open', { detail: id })), 200)
}

/** 打开「记一笔留痕」浮层（主窗口内，不另开窗口） */
export function openTraceCapture(prefill?: { text?: string; messageId?: string }) {
  window.dispatchEvent(new CustomEvent('ms:trace-capture', { detail: prefill ?? null }))
}

const toast = (detail: unknown) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

/** 阅读页「记为留痕」：已记过就打开原记录 */
export async function traceFromMessage(messageId: string) {
  try {
    const res = await api.traceFromMessage(messageId)
    if (!res.id) return toast('没能记为留痕')
    await useTrace.getState().load()
    const id = res.id
    toast({ text: res.created ? '已记为留痕：可以让 AI 整理约定并发书面确认' : '这封邮件已经记过留痕', actions: [{ label: '查看', run: () => openTrace(id) }], duration: 5000 })
  } catch {
    toast('没能记为留痕')
  }
}

export const STATUS_TONE: Record<TraceStatus, 'muted' | 'info' | 'warn' | 'ok' | 'danger'> = {
  draft: 'muted',
  organized: 'info',
  sent: 'warn',
  confirmed: 'ok',
  disputed: 'danger'
}

export function fmtDay(t: number | null | undefined, now = Date.now()): string {
  if (!t) return '—'
  const d = new Date(t)
  const same = d.getFullYear() === new Date(now).getFullYear()
  return same ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

export function fmtClock(t: number | null | undefined): string {
  if (!t) return ''
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** <input type="datetime-local"> 的值 */
export function toLocalInput(t: number | null | undefined): string {
  if (!t) return ''
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fromLocalInput(s: string): number | null {
  if (!s) return null
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? t : null
}

/** 读图片为 data URL（粘贴 / 拖入的截图） */
export function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

/** 读文本文件（导出的聊天 txt）；按 UTF-8 读，乱码时再试 GB18030 */
export async function readTextFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const utf8 = new TextDecoder('utf-8').decode(buf)
  if (!utf8.includes('�')) return utf8
  try {
    return new TextDecoder('gb18030').decode(buf)
  } catch {
    return utf8
  }
}

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
