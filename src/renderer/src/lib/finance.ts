import { create } from 'zustand'
import { useEffect } from 'react'
import { api } from './api'
import { goView } from './route'
import type { FinanceData, InsightRecord } from '@shared/types'

/** 财务中心数据：insights kind='finance'（主进程自动收集 + 手动） */
export interface FinanceRec extends InsightRecord {
  data: FinanceData & Record<string, unknown>
}

export interface ScanState {
  done: number
  total: number
  created: number
  merged: number
  finished: boolean
  error?: string
}

interface FinanceState {
  records: FinanceRec[]
  idle: Set<string>
  loaded: boolean
  scan: ScanState | null
  load(): Promise<void>
}

export const useFinance = create<FinanceState>(set => ({
  records: [],
  idle: new Set(),
  loaded: false,
  scan: null,
  load: async () => {
    try {
      const res = await api.financeList()
      set({ records: res.records as FinanceRec[], idle: new Set(res.idle), loaded: true })
    } catch {
      set({ loaded: true })
    }
  }
}))

let subscribed = false
/** 挂一次：自动收集 / 回填 / 编辑后刷新 */
export function useFinanceEvents() {
  useEffect(() => {
    if (!useFinance.getState().loaded) void useFinance.getState().load()
    if (subscribed) return
    subscribed = true
    let timer = 0
    const off = api.onEvent(ev => {
      const e = ev as { type: string } & Partial<ScanState>
      if (e.type === 'finance-changed') {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => void useFinance.getState().load(), 150)
      }
      if (e.type === 'finance-scan') {
        useFinance.setState({ scan: { done: e.done ?? 0, total: e.total ?? 0, created: e.created ?? 0, merged: e.merged ?? 0, finished: !!e.finished, error: e.error } })
        if (e.finished) void useFinance.getState().load()
      }
    })
    return () => {
      subscribed = false
      void off()
    }
  }, [])
}

/** 「账单」页收哪些：账单 / 发票 / 退款，以及个人消费类的付款（企业往来的付款与回单在「对账」） */
export function isBillish(d: FinanceData): boolean {
  return d.kind === 'bill' || d.kind === 'invoice' || d.kind === 'refund' || (d.kind === 'payment' && d.business === false)
}

// ---------------------------------------------------------------- 格式

const SYMBOL: Record<string, string> = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', HKD: 'HK$', JPY: 'JP¥', SGD: 'S$', AUD: 'A$', CAD: 'C$' }

export function fmtMoney(amount: number | null | undefined, currency = 'CNY', opts: { sign?: boolean; compact?: boolean } = {}): string {
  if (amount == null || !Number.isFinite(amount)) return '—'
  const sym = SYMBOL[currency] ?? `${currency} `
  const abs = Math.abs(amount)
  const num =
    opts.compact && abs >= 100000
      ? `${(abs / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}万`
      : abs.toLocaleString('zh-CN', { minimumFractionDigits: currency === 'JPY' ? 0 : 2, maximumFractionDigits: currency === 'JPY' ? 0 : 2 })
  const sign = amount < 0 ? '−' : opts.sign ? '+' : ''
  return `${sign}${sym}${num}`
}

/** 按币种汇总（不换汇） */
export function sumByCurrency(list: { amount: number | null | undefined; currency: string }[]): [string, number][] {
  const m = new Map<string, number>()
  for (const x of list) if (x.amount != null) m.set(x.currency, Math.round(((m.get(x.currency) ?? 0) + x.amount) * 100) / 100)
  return [...m.entries()].sort((a, b) => (a[0] === 'CNY' ? -1 : b[0] === 'CNY' ? 1 : b[1] - a[1]))
}

const DAY = 864e5
export const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
export const daysUntil = (t: number, now = Date.now()) => Math.round((startOfDay(t) - startOfDay(now)) / DAY)

export function fmtDay(t: number | null | undefined, now = Date.now()): string {
  if (!t) return '—'
  const n = daysUntil(t, now)
  if (n === 0) return '今天'
  if (n === 1) return '明天'
  if (n === -1) return '昨天'
  const d = new Date(t)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

export function relDays(t: number, now = Date.now()): string {
  const n = daysUntil(t, now)
  if (n === 0) return '今天'
  if (n > 0) return `${n} 天后`
  return `${-n} 天前`
}

// ---------------------------------------------------------------- 动作

/** 打开财务页并定位到某笔款项 */
export function openFinance(id?: string | null) {
  goView('finance')
  if (id) setTimeout(() => window.dispatchEvent(new CustomEvent('ms:finance-open', { detail: id })), 200)
}

const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

/** 邮件阅读页「加入财务」 */
export async function addMessageToFinance(messageId: string) {
  try {
    const res = await api.financeFromMessage(messageId)
    if (!res.id) return toast('没能加入财务')
    await useFinance.getState().load()
    toast(res.created ? '已加入财务' : '这封邮件已在财务里')
  } catch {
    toast('没能加入财务')
  }
}
