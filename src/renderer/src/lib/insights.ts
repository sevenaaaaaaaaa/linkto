import { create } from 'zustand'
import { useEffect } from 'react'
import { api } from './api'
import type { MailEntity, MailInsight } from '@shared/types'

/**
 * 邮件理解结果的渲染层缓存：列表 / 阅读页 / 逐封处理共用。
 * 主进程缺失时先回启发式结果，AI 结果到达后发 'mail-insights' 事件，这里按 id 刷新。
 */
interface InsightState {
  byId: Record<string, MailInsight>
  load(ids: string[], force?: boolean): Promise<void>
  understand(id: string, force?: boolean): Promise<MailInsight | null>
}

export const useInsights = create<InsightState>((set, get) => ({
  byId: {},
  load: async (ids, force) => {
    const need = force ? ids : ids.filter(id => !get().byId[id])
    if (!need.length) return
    try {
      const res = await api.getMailInsights(need.slice(0, 400))
      set({ byId: { ...get().byId, ...res } })
    } catch {
      /* 主进程未就绪：保留旧值，列表退回摘要片段 */
    }
  },
  understand: async (id, force) => {
    try {
      const res = await api.understandMessage(id, force)
      if (res) set({ byId: { ...get().byId, [id]: res } })
      return res
    } catch {
      return null
    }
  }
}))

let subscribed = false
/** 订阅主进程的 AI 理解结果推送（全局只挂一次） */
export function useInsightEvents() {
  useEffect(() => {
    if (subscribed) return
    subscribed = true
    const off = api.onEvent(ev => {
      const e = ev as { type: string; ids?: string[] }
      if (e.type === 'mail-insights' && e.ids?.length) {
        const known = useInsights.getState().byId
        // 只刷新当前已加载过的（列表里可见的），其余等用到时再取
        const ids = e.ids.filter(id => known[id])
        if (ids.length) void useInsights.getState().load(ids, true)
      }
    })
    return () => {
      subscribed = false
      void off()
    }
  }, [])
}

/** 把文本里的关键短语切出来，供荧光标记 */
export function splitKey(text: string, key: string | null | undefined): [string, string, string] {
  if (!key) return [text, '', '']
  const i = text.indexOf(key)
  if (i < 0) return [text, '', '']
  return [text.slice(0, i), key, text.slice(i + key.length)]
}

/**
 * 实体去重：同一金额在主题 / 正文各识别一次（¥12,800 与 ¥12,800.00），
 * 或较短的时间被较长的包含（「周三」与「周三 15:00」）时只留信息更全的那个。
 */
export function dedupeEntities(list: MailEntity[]): MailEntity[] {
  const norm = (e: MailEntity) => (e.kind === 'money' ? String(Number(String(e.value).replace(/[^\d.]/g, '')) || e.label) : e.label.trim())
  const out: MailEntity[] = []
  for (const e of list) {
    const n = norm(e)
    if (out.some(o => norm(o) === n)) continue
    if (list.some(o => o !== e && o.label.length > e.label.length && o.label.includes(e.label))) continue
    out.push(e)
  }
  return out
}
