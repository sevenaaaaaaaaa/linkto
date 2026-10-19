import { useEffect, useRef, useState } from 'react'
import type { AgentActivity, AgentJobInfo, AgentJobSettings, AgentRef } from '@shared/types'
import { api } from './api'

/* 自动任务 / 活动记录 / 首次整理：渲染端数据与跳转 */

/** 自动任务列表（随 agent-jobs 事件刷新；有任务在跑时每 2 秒轮询一次补齐时间） */
export function useAgentJobs() {
  const [jobs, setJobs] = useState<AgentJobInfo[] | null>(null)
  const [settings, setSettings] = useState<AgentJobSettings | null>(null)
  const load = () => {
    void api.agentJobs().then(setJobs).catch(() => setJobs([]))
    void api.agentJobSettings().then(setSettings).catch(() => {})
  }
  useEffect(() => {
    load()
    const off = api.onEvent(ev => {
      const t = (ev as { type?: string })?.type
      if (t === 'agent-jobs' || t === 'agent-activity') load()
    })
    return () => void off()
  }, [])
  const running = jobs?.some(j => j.running)
  useEffect(() => {
    if (!running) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [running])
  return {
    jobs,
    settings,
    reload: load,
    setEnabled: async (id: string, enabled: boolean) => {
      setJobs(list => list?.map(j => (j.id === id ? { ...j, enabled } : j)) ?? list)
      setJobs(await api.agentJobSet(id, { enabled }))
    },
    runNow: async (id: string) => {
      setJobs(list => list?.map(j => (j.id === id ? { ...j, running: true } : j)) ?? list)
      const r = await api.agentJobRunNow(id)
      load()
      return r
    },
    saveSettings: async (patch: Partial<AgentJobSettings>) => {
      setSettings(s => (s ? { ...s, ...patch } : s))
      setSettings(await api.agentJobSetSettings(patch))
    }
  }
}

/** 活动记录（新记录经 agent-activity 事件推送，直接插到最前） */
export function useAgentActivity(limit = 200) {
  const [items, setItems] = useState<AgentActivity[] | null>(null)
  const fresh = useRef(new Set<string>())
  useEffect(() => {
    void api.agentActivity(limit).then(setItems).catch(() => setItems([]))
    const off = api.onEvent(ev => {
      const e = ev as { type?: string; activity?: AgentActivity }
      if (e.type !== 'agent-activity' || !e.activity) return
      fresh.current.add(e.activity.id)
      setItems(list => [e.activity!, ...(list ?? []).filter(x => x.id !== e.activity!.id)].slice(0, limit))
    })
    return () => void off()
  }, [limit])
  return { items, fresh: fresh.current }
}

export const REF_LABEL: Record<AgentRef['type'], string> = {
  mail: '邮件',
  thread: '会话',
  todo: '待办',
  finance: '款项',
  project: '项目',
  attachment: '附件',
  kb: '知识',
  memory: '记忆',
  contact: '联系人',
  followup: '跟进',
  life: '生活档案',
  trace: '留痕'
}

const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 「今天 Agent 替你：收集 5 条待办、整理 2 笔账单、学到 4 条知识」；今天还没做什么时返回 null */
export function todaySummary(items: AgentActivity[], now = Date.now()): string | null {
  const today = startOfDay(now)
  const sum: Record<string, number> = {}
  for (const a of items) {
    if (a.at < today) continue
    for (const [k, v] of Object.entries(a.stats ?? {})) sum[k] = (sum[k] ?? 0) + (Number(v) || 0)
  }
  const parts: string[] = []
  if (sum.todos) parts.push(`收集 ${sum.todos} 条待办`)
  if (sum.finance) parts.push(`整理 ${sum.finance} 笔款项`)
  if (sum.kb) parts.push(`学到 ${sum.kb} 条知识`)
  if (sum.kbMerged) parts.push(`补充 ${sum.kbMerged} 条旧知识`)
  if (sum.memories) parts.push(`记住 ${sum.memories} 件事`)
  if (sum.attachments) parts.push(`归类 ${sum.attachments} 个附件`)
  if (sum.projects) parts.push(`归并 ${sum.projects} 封项目邮件`)
  if (sum.projectHints) parts.push(`发现 ${sum.projectHints} 个项目线索`)
  if (sum.archived) parts.push(`归档 ${sum.archived} 封旧邮件`)
  if (sum.skills) parts.push(`跑了 ${sum.skills} 次技能`)
  if (sum.events) parts.push(`处理 ${sum.events} 封事件邮件`)
  if (sum.brief) parts.push('生成每日简报')
  return parts.length ? parts.join('、') : null
}

/** 按天分组：今天 / 昨天 / 10月16日 周五 */
export function groupByDay(items: AgentActivity[], now = Date.now()): { key: string; label: string; items: AgentActivity[] }[] {
  const today = startOfDay(now)
  const out: { key: string; label: string; items: AgentActivity[] }[] = []
  for (const a of items) {
    const d = startOfDay(a.at)
    const key = String(d)
    let g = out[out.length - 1]
    if (!g || g.key !== key) {
      const label =
        d === today
          ? '今天'
          : d === today - 86_400_000
            ? '昨天'
            : new Date(d).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
      g = { key, label, items: [] }
      out.push(g)
    }
    g.items.push(a)
  }
  return out
}

export function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 上次运行：「3 分钟前」「今天 08:02」「10月16日 08:02」 */
export function fmtWhen(t: number | null, now = Date.now()): string {
  if (!t) return '从未运行'
  const diff = now - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (startOfDay(t) === startOfDay(now)) return `今天 ${fmtTime(t)}`
  if (startOfDay(t) === startOfDay(now) - 86_400_000) return `昨天 ${fmtTime(t)}`
  return new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 下次运行：「约 40 分钟后」「明天 08:00」 */
export function fmtNext(t: number | null, now = Date.now()): string {
  if (!t) return '—'
  const diff = t - now
  if (diff <= 60_000) return '即将'
  if (diff < 3600_000) return `约 ${Math.round(diff / 60_000)} 分钟后`
  if (startOfDay(t) === startOfDay(now)) return `今天 ${fmtTime(t)}`
  if (startOfDay(t) === startOfDay(now) + 86_400_000) return `明天 ${fmtTime(t)}`
  return new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
