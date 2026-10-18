import { create } from 'zustand'
import { useEffect } from 'react'
import { api } from './api'
import { goView } from './route'
import { useMail } from '../stores/mail'
import type { FollowupData, FollowupKind, InsightRecord } from '@shared/types'

/** 跟进闭环（insights kind='followup'）：发出后在等对方的事 */
export interface FollowupRec extends Omit<InsightRecord, 'data'> {
  data: FollowupData
}

interface FollowupState {
  items: FollowupRec[]
  loaded: boolean
  /** 刚从通知 / 活动记录点进来要定位的那条 */
  focusId: string | null
  load(): Promise<void>
}

export const useFollowups = create<FollowupState>(set => ({
  items: [],
  loaded: false,
  focusId: null,
  load: async () => {
    try {
      const list = (await api.followupList()) as unknown as FollowupRec[]
      set({ items: list, loaded: true })
    } catch {
      set({ loaded: true })
    }
  }
}))

const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

/** 打开「等待对方」（跟进清单在顶部）；带 id 时定位那一条 */
export function openFollowups(id?: string | null) {
  goView('mail')
  useMail.getState().setScope({ kind: 'followup', title: '等待对方回复' })
  if (id) useFollowups.setState({ focusId: id })
}

let subscribed = false
/** 挂一次（侧栏角标常驻）：跟进变化 / 新邮件 / 发信后刷新；通知点击打开「等待对方」 */
export function useFollowupEvents() {
  useEffect(() => {
    if (!useFollowups.getState().loaded) void useFollowups.getState().load()
    if (subscribed) return
    subscribed = true
    let timer = 0
    const reload = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void useFollowups.getState().load(), 200)
    }
    const off = api.onEvent(ev => {
      const e = ev as { type: string; id?: string }
      if (e.type === 'followups-changed' || e.type === 'mail-sent' || e.type === 'new-mail') reload()
      if (e.type === 'open-followups') openFollowups(e.id)
    })
    // 到期是按时间变化的：每 10 分钟重新取一次（主进程顺带对账）
    const tick = window.setInterval(reload, 10 * 60_000)
    return () => {
      subscribed = false
      window.clearInterval(tick)
      void off()
    }
  }, [])
}

/** 侧栏「等待对方」角标：已逾期的条数 */
export function useOverdueCount(): number {
  useFollowupEvents()
  return useFollowups(st => st.items.filter(f => f.data.status === 'overdue').length)
}

export async function nudgeFollowup(id: string) {
  const r = await api.followupNudge(id).catch(err => ({ ok: false, error: String(err) }))
  if (!r.ok) toast(r.error || '没能起草催促')
}

export async function snoozeFollowup(id: string, days: number) {
  await api.followupUpdate(id, { snoozeDays: days })
  toast(`已延后 ${days} 天`)
  void useFollowups.getState().load()
}

export async function closeFollowup(id: string) {
  await api.followupUpdate(id, { status: 'closed' })
  toast('已标记为已解决')
  void useFollowups.getState().load()
}

/** 对一封已发邮件「N 天后没回提醒我」 */
export async function followMessage(messageId: string, opts: { waitDays?: number; kind?: FollowupKind; ask?: string } = {}) {
  try {
    await api.followupCreate({ messageId, waitDays: opts.waitDays ?? 3, kind: opts.kind, ask: opts.ask })
    toast(`已开始跟进：${opts.waitDays ?? 3} 天后没回会提醒你`)
    void useFollowups.getState().load()
  } catch (err) {
    toast(`登记失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 一封邮件 / 会话相关的跟进（阅读页关联条） */
export function followupsFor(items: FollowupRec[], msg: { id: string; threadId?: string | null }): FollowupRec[] {
  return items.filter(
    f =>
      f.data.sentMessageId === msg.id ||
      f.data.repliedMessageId === msg.id ||
      f.data.relatedMessageId === msg.id ||
      (!!msg.threadId && !!f.data.threadId && f.data.threadId === msg.threadId)
  )
}

export function fmtMd(t: number | null | undefined): string {
  if (!t) return ''
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
