import { create } from 'zustand'
import { useEffect } from 'react'
import { api } from './api'
import { goView } from './route'
import type { InsightRecord, LifeData } from '@shared/types'

/** 生活档案数据：insights kind='life'（主进程自动收集 + 手动） */
export interface LifeRec extends InsightRecord {
  data: LifeData & Record<string, unknown>
}

export interface LifeScanState {
  done: number
  total: number
  created: number
  merged: number
  finished: boolean
  error?: string
}

interface LifeState {
  records: LifeRec[]
  loaded: boolean
  scan: LifeScanState | null
  load(): Promise<void>
}

export const useLife = create<LifeState>(set => ({
  records: [],
  loaded: false,
  scan: null,
  load: async () => {
    try {
      const list = await api.lifeList()
      set({ records: list as LifeRec[], loaded: true })
    } catch {
      set({ loaded: true })
    }
  }
}))

let subscribed = false
/** 挂一次（侧栏入口常驻）：自动收集 / 回填 / 编辑后刷新；提醒通知点击打开条目 */
export function useLifeEvents() {
  useEffect(() => {
    if (!useLife.getState().loaded) void useLife.getState().load()
    if (subscribed) return
    subscribed = true
    let timer = 0
    const off = api.onEvent(ev => {
      const e = ev as { type: string; id?: string } & Partial<LifeScanState>
      if (e.type === 'life-changed') {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => void useLife.getState().load(), 150)
      }
      if (e.type === 'life-scan') {
        useLife.setState({ scan: { done: e.done ?? 0, total: e.total ?? 0, created: e.created ?? 0, merged: e.merged ?? 0, finished: !!e.finished, error: e.error } })
        if (e.finished) void useLife.getState().load()
      }
      if (e.type === 'open-life') openLife(e.id || null)
    })
    return () => {
      subscribed = false
      void off()
    }
  }, [])
}

/** 打开生活档案并定位到某条 */
export function openLife(id?: string | null, opts?: { category?: string }) {
  goView('life')
  if (id || opts?.category) setTimeout(() => window.dispatchEvent(new CustomEvent('ms:life-open', { detail: { id: id ?? null, category: opts?.category ?? null } })), 200)
}

const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

/** 阅读页「加入生活档案」 */
export async function addMessageToLife(messageId: string) {
  try {
    const res = await api.lifeFromMessage(messageId)
    if (!res.id) return toast('没能加入生活档案')
    await useLife.getState().load()
    toast(res.created ? '已加入生活档案' : '这封邮件已在生活档案里')
  } catch {
    toast('没能加入生活档案')
  }
}

export function fmtDate(t: number | null | undefined, now = Date.now()): string {
  if (!t) return '—'
  const d = new Date(t)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

export function leftLabel(n: number): string {
  if (n === 0) return '今天'
  if (n === 1) return '明天'
  if (n > 0) return n > 60 ? `${Math.round(n / 30)} 个月后` : `${n} 天后`
  return `过期 ${-n} 天`
}
