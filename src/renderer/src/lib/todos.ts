import { create } from 'zustand'
import { useEffect } from 'react'
import { api } from './api'
import type { InsightRecord } from '@shared/types'

/** 待办（GTD）数据：主进程 insights 表里 kind='todo' 的记录 */
interface TodoState {
  todos: InsightRecord[]
  loaded: boolean
  load(): Promise<void>
}

export const useTodos = create<TodoState>(set => ({
  todos: [],
  loaded: false,
  load: async () => {
    try {
      const list = await api.listInsights('todo')
      set({ todos: list.filter(t => (t.status as string) !== 'dismissed'), loaded: true })
    } catch {
      set({ loaded: true })
    }
  }
}))

let subscribed = false
/** 挂一次：自动收集 / Agent / 规则 / MCP 新增待办时刷新 */
export function useTodoEvents() {
  useEffect(() => {
    void useTodos.getState().load()
    if (subscribed) return
    subscribed = true
    const off = api.onEvent(ev => {
      const t = (ev as { type: string }).type
      if (t === 'todos-changed' || t === 'insights-changed') void useTodos.getState().load()
    })
    return () => {
      subscribed = false
      void off()
    }
  }, [])
}

/** 今天要做的（逾期 + 今天截止 + 无截止的高优先级）数量，供侧栏角标 */
export function todayCount(todos: InsightRecord[], now = Date.now()) {
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  return todos.filter(t => t.status === 'open' && t.dueAt && t.dueAt <= end.getTime()).length
}
