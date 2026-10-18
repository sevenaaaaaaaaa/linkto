import { ipcMain, Notification } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentActivity, AgentSkill } from '@shared/types'
import { DEFAULT_NOTIFICATIONS } from '../store'
import { setAiRequestGuard } from '../ai/service'
import { inQuietHours } from '../notify-policy'
import { setActivityLogger, runSkillHeadless, listSkillsForSchedule, onSkillsChanged } from '../agent/hooks'
import { ActivityStore } from './activity'
import { AiBudget, onBattery } from './budget'
import { JobScheduler, type JobDef } from './scheduler'
import { OnboardingScan } from './onboarding'
import { dayKey, DAY_MS, HOUR_MS, skillCadence, slotOfDay, sweepWindow } from './schedule'
import {
  aiBlockedReason, financeBreakdown, fmtBytes, kbRefs, learnKnowledge, organizeAttachments, organizeFinance, organizeProjects, projectLabel, sweepTodos,
  type WorkDeps
} from './tasks'

export interface JobsDeps extends Omit<WorkDeps, 'activity'> {
  db: DatabaseSync
  /** 跑一轮「定期整理」（已读旧订阅 / 通知归档） */
  cleanup(): Promise<{ moved: number; enabled: boolean }>
  /** 点击系统通知：显示主窗口并打开 Agent 活动记录 */
  showActivity(): void
}

/**
 * 后台自动任务 · 活动记录 · 首次整理：一处初始化，注册 IPC（agentJobs / agentJobSet / agentJobRunNow / agentActivity /
 * agentJobSettings / agentJobSetSettings / onboardingScan*），接管 hooks 的活动记录写入。
 */
export function initJobs(input: JobsDeps) {
  const activity = new ActivityStore(input.db)
  const deps: JobsDeps & WorkDeps = { ...input, activity }
  const budget = deps.budget
  setAiRequestGuard(budget.guard)

  const log = (a: Omit<AgentActivity, 'id' | 'at'>) => {
    const row = activity.add(a)
    deps.event({ type: 'agent-activity', activity: row })
    return row
  }
  setActivityLogger(a => void log(a))

  let changedTimer: NodeJS.Timeout | null = null
  const scheduler: JobScheduler = new JobScheduler({
    appStore: deps.appStore,
    aiBlocked: (online, def) => {
      const why = aiBlockedReason(deps)
      if (why) return why
      if (!online) return '离线'
      if (def.aiNeedsPower && onBattery()) return '正在用电池，等接通电源再学习'
      return null
    },
    log,
    changed: () => {
      // 合并短时间内的多次变化
      if (changedTimer) return
      changedTimer = setTimeout(() => {
        changedTimer = null
        deps.event({ type: 'agent-jobs' })
      }, 120)
    },
    tickMs: Number(process.env.LINKTO_JOBS_TICK_MS) || undefined
  })

  for (const def of builtinJobs(deps, activity)) scheduler.register(def)

  // ---------------- 定时技能 ----------------

  const notifySkill = (title: string, body: string) => {
    if (!budget.settings().notifySkills) return
    const s = deps.appStore.get('notifications', DEFAULT_NOTIFICATIONS)
    if (!s.enabled || inQuietHours(s.quietHours, new Date()) || !Notification.isSupported()) return
    const n = new Notification({ title, body: body.slice(0, 180), silent: !s.sound })
    n.on('click', () => deps.showActivity())
    n.show()
  }

  const skillJob = (s: AgentSkill): JobDef | null => {
    const cadence = skillCadence(s.schedule)
    if (!cadence) return null
    const params: Record<string, string | number> = {}
    for (const p of s.params ?? []) if (p.default !== undefined) params[p.key] = p.default
    return {
      id: `skill:${s.id}`,
      name: s.name,
      description: s.description || '定时运行技能，结果写进活动记录',
      category: 'skill',
      ai: 'required',
      cadence,
      defaultEnabled: true,
      needsNetwork: true,
      skillId: s.id,
      run: async () => {
        const r = await runSkillHeadless(s.id, params)
        if (!r.ok) throw new Error(r.error || '技能运行失败')
        const text = String(r.text ?? '').trim()
        const first = text.split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '已完成'
        notifySkill(`技能「${s.name}」已运行`, first)
        return {
          summary: first.slice(0, 80),
          activity: { source: 'skill', title: s.name, detail: text.slice(0, 1500) || null, refs: r.refs ?? [], stats: { skills: 1 } }
        }
      }
    }
  }

  let refreshing = false
  const refreshSkillJobs = async () => {
    if (refreshing) return
    refreshing = true
    try {
      const skills = await listSkillsForSchedule()
      const want = new Map<string, JobDef>()
      for (const s of skills) {
        const def = skillJob(s)
        if (def) want.set(def.id, def)
      }
      for (const id of scheduler.ids()) if (id.startsWith('skill:') && !want.has(id)) scheduler.unregister(id)
      for (const def of want.values()) scheduler.register(def)
      deps.event({ type: 'agent-jobs' })
      scheduler.kick()
    } catch (err) {
      console.error('[jobs] skill list failed:', err)
    } finally {
      refreshing = false
    }
  }
  onSkillsChanged(() => void refreshSkillJobs())
  void refreshSkillJobs()

  // ---------------- 首次整理 ----------------

  const onboarding = new OnboardingScan({ ...deps, log })
  onboarding.init()

  // ---------------- IPC ----------------

  const handlers: Record<string, (...args: any[]) => unknown> = {
    agentJobs: () => scheduler.list(),
    agentJobSet: (id: string, patch: { enabled?: boolean }) => {
      if (typeof patch?.enabled === 'boolean') scheduler.setEnabled(String(id), patch.enabled)
      return scheduler.list()
    },
    agentJobRunNow: (id: string) => scheduler.runNow(String(id)),
    agentActivity: (limit?: number) => activity.list(limit ?? 100),
    agentJobSettings: () => budget.withUsage(),
    agentJobSetSettings: (patch: Record<string, unknown>) => {
      const res = budget.setSettings(patch ?? {})
      deps.event({ type: 'agent-jobs' })
      return res
    },
    onboardingScanStatus: () => onboarding.status(),
    onboardingScanStart: (opts: { days: number; accountIds?: string[] | null; steps: ('todo' | 'finance' | 'attachments' | 'kb' | 'projects')[] }) => onboarding.start(opts ?? { days: 30, steps: [] }),
    onboardingScanDismiss: () => onboarding.dismiss(),
    onboardingScanLater: () => onboarding.later()
  }
  for (const [method, handler] of Object.entries(handlers)) {
    ipcMain.handle(`api:${method}`, async (_event, ...args) => {
      try {
        return await handler(...args)
      } catch (err) {
        console.error(`[ipc:${method}]`, err)
        throw err
      }
    })
  }

  const fast = Number(process.env.LINKTO_JOBS_START_MS)
  scheduler.start(Number.isFinite(fast) && fast > 0 ? fast : 45_000)

  return {
    scheduler,
    activity,
    onboarding,
    onAccountStatus: (accountId: string, status: string) => onboarding.onAccountStatus(accountId, status),
    stop: () => scheduler.stop()
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** 内置任务 */
function builtinJobs(deps: JobsDeps & WorkDeps, activity: ActivityStore): JobDef[] {
  return [
    {
      id: 'todo-sweep',
      name: '待办补扫',
      description: '扫描最近到达、还没被理解或收集的邮件（含 AI 失败、离线错过的），收集待办与会议',
      category: 'collect',
      ai: 'optional',
      cadence: { kind: 'every', ms: HOUR_MS },
      defaultEnabled: true,
      run: async ctx => {
        const r = await sweepTodos(deps, { since: ctx.now - sweepWindow(ctx.lastRunAt, ctx.now), ai: ctx.aiAllowed, maxAi: 20 })
        const n = r.todos.length
        return {
          summary: `检查 ${r.checked} 封${r.ai ? `（AI 理解 ${r.ai} 封）` : ''}，${n ? `新收集 ${n} 条待办` : '没有新待办'}${r.stopped ? `；${r.stopped}` : ''}`,
          activity: n
            ? {
                source: 'job',
                title: `待办补扫：新收集 ${n} 条待办`,
                detail: r.todos.slice(0, 3).map(t => t.title).join('；'),
                refs: r.todos.slice(0, 8).map(t => ({ type: 'todo', id: t.id, label: t.title })),
                stats: { todos: n }
              }
            : null
        }
      }
    },
    {
      id: 'finance',
      name: '财务整理',
      description: '回填最近 2 天的账单 / 订阅 / 订单，重算对账，推断订阅下次续费日',
      category: 'collect',
      ai: 'optional',
      cadence: { kind: 'daily', at: '08:00' },
      defaultEnabled: true,
      preferIdle: { minIdleSec: 60, maxDelayMs: 90 * 60_000 },
      run: async () => {
        const r = await organizeFinance(deps, 2)
        if (!r.ok) {
          if (r.error === '正在扫描') return { summary: '你正在手动扫描，本轮跳过' }
          throw new Error(r.error || '财务扫描失败')
        }
        const n = r.created.length
        const o = r.overdue.length
        const parts = [n ? `新增 ${n} 笔（${financeBreakdown(r.created)}）` : '没有新款项']
        if (r.merged) parts.push(`归并 ${r.merged} 封`)
        if (o) parts.push(`${o} 笔逾期`)
        if (r.rolled) parts.push(`顺延 ${r.rolled} 个订阅续费日`)
        return {
          summary: `扫描 ${r.scanned} 封：${parts.join('，')}`,
          activity:
            n || r.rolled
              ? {
                  source: 'job',
                  title: `财务：${n ? `新增 ${n} 笔` : `顺延 ${r.rolled} 个订阅续费日`}${o ? `、${o} 笔逾期` : ''}`,
                  detail: parts.join('，'),
                  refs: [...r.created.map(c => ({ type: 'finance' as const, id: c.id, label: c.title })), ...r.overdue.map(c => ({ type: 'finance' as const, id: c.id, label: `逾期 · ${c.title}` }))].slice(0, 10),
                  stats: { finance: n, overdue: o }
                }
              : null
        }
      }
    },
    {
      id: 'attachments',
      name: '附件整理',
      description: '增量索引与分类、执行已开启的自动归档规则，更新「整理建议」（不会自动释放空间）',
      category: 'collect',
      ai: 'optional',
      cadence: { kind: 'daily', at: '09:00' },
      defaultEnabled: true,
      preferIdle: { minIdleSec: 60, maxDelayMs: 2 * HOUR_MS },
      run: async () => {
        const r = await organizeAttachments(deps, { since: Date.now() - 2 * DAY_MS })
        if (!r.ok) throw new Error(r.error || '附件索引失败')
        const n = r.fresh.length
        const tail = r.releasable > 0 ? `；近 2 天的附件可释放 ${fmtBytes(r.releasable)}（在附件中心确认）` : ''
        return {
          summary: `${n ? `新增 ${n} 个附件（${fmtBytes(r.freshBytes)}）` : '没有新附件'}${tail}`,
          activity: n
            ? {
                source: 'job',
                title: `附件：新增 ${n} 个（${fmtBytes(r.freshBytes)}）`,
                detail: `已分类入索引${tail}`,
                refs: r.fresh.slice(0, 6).map(f => ({ type: 'attachment' as const, id: f.id, label: f.filename })),
                stats: { attachments: n }
              }
            : null
        }
      }
    },
    {
      id: 'projects',
      name: '项目归并',
      description: '对允许自动归入的项目回扫最近 2 天邮件，补上漏归的往来、刷新「建议归入」',
      category: 'collect',
      ai: 'none',
      cadence: { kind: 'daily', at: '08:30' },
      defaultEnabled: true,
      preferIdle: { minIdleSec: 60, maxDelayMs: 2 * HOUR_MS },
      run: async () => {
        const r = organizeProjects(deps, { days: 2 })
        if (!r.ok) throw new Error(r.error || '项目整理失败')
        const parts: string[] = []
        if (r.added) parts.push(`自动归入 ${r.added} 封`)
        if (r.suggested) parts.push(`${r.suggested} 封待确认`)
        return {
          summary: parts.length ? parts.join('，') : '没有需要归并的新邮件',
          activity: parts.length
            ? {
                source: 'job',
                title: `项目：${parts.join('，')}`,
                refs: r.projectIds.slice(0, 6).map(id => ({ type: 'project' as const, id, label: projectLabel(deps, id) })),
                stats: { projects: r.added }
              }
            : null
        }
      }
    },
    {
      id: 'kb-learn',
      name: '知识库自主学习',
      description: '空闲且接通电源时，从决定、方案、数据、流程、教程、Newsletter 精华与 PDF 资料里提炼知识条目，去重后存入知识库并沉淀长期记忆',
      category: 'learn',
      ai: 'required',
      cadence: { kind: 'every', ms: 2 * HOUR_MS },
      defaultEnabled: true,
      needsNetwork: true,
      aiNeedsPower: true,
      preferIdle: { minIdleSec: 120, maxDelayMs: 4 * HOUR_MS },
      run: async ctx => {
        const limit = deps.budget.settings().kbDailyLimit
        const today = slotOfDay(ctx.now, '00:00')
        const left = Math.max(0, limit - activity.learnedSince(today))
        if (!left) return { summary: `今日学习额度已用完（${limit} 封）` }
        const r = await learnKnowledge(deps, { since: ctx.now - 30 * DAY_MS, limit: Math.min(left, ctx.manual ? 6 : 4), memoryMax: 3 })
        const n = r.learned.length
        const m = r.merged.length
        const parts: string[] = []
        if (n) parts.push(`学到 ${n} 条`)
        if (m) parts.push(`合并 ${m} 条`)
        if (r.skipped) parts.push(`跳过重复 ${r.skipped} 条`)
        if (r.memories) parts.push(`沉淀 ${r.memories} 条记忆`)
        const summary = parts.length ? parts.join('，') : r.picked ? '挑出的邮件没有值得长期保存的内容' : '没有找到值得学习的新邮件'
        if (r.stopped && !n && !m) throw new Error(r.stopped)
        return {
          summary: r.stopped ? `${summary}；${r.stopped}` : summary,
          activity:
            n || m
              ? {
                  source: 'job',
                  title: `知识库：学到 ${n} 条${m ? `，合并 ${m} 条` : ''}`,
                  detail: [...r.learned, ...r.merged].map(k => k.title).slice(0, 4).join('；') + (r.memories ? `\n另沉淀 ${r.memories} 条长期记忆` : ''),
                  refs: kbRefs(r),
                  stats: { kb: n, kbMerged: m, memories: r.memories }
                }
              : null
        }
      }
    },
    {
      id: 'daily-brief',
      name: '每日简报',
      description: '每天 08:00 后整理当日重点、主题摘要与清理建议（与 设置 → 自动化「每日简报」同一开关）',
      category: 'learn',
      ai: 'required',
      cadence: { kind: 'daily', at: '08:00' },
      defaultEnabled: false,
      needsNetwork: true,
      getEnabled: () => !!deps.appStore.getAI().autoDigest,
      setEnabled: v => deps.appStore.setAI({ ...deps.appStore.getAI(), autoDigest: v }),
      run: async () => {
        if (deps.store.latestInsight('daily', dayKey(Date.now()))) return { summary: '今天的简报已生成' }
        const r = await deps.insights.generateDaily()
        if (!r.ok) throw new Error(r.error || '生成失败')
        const d = r.digest as Any
        return {
          summary: `已生成：${(d?.highlights ?? []).length} 条重点`,
          activity: { source: 'job', title: '每日简报已生成', detail: (d?.highlights ?? []).slice(0, 3).join('；') || d?.memo || null, refs: [], stats: { brief: 1 } }
        }
      }
    },
    {
      id: 'cleanup',
      name: '定期整理',
      description: '把超过设定天数的已读订阅 / 通知邮件归档（天数在 设置 → 自动化 → 定期整理）',
      category: 'collect',
      ai: 'none',
      cadence: { kind: 'every', ms: HOUR_MS },
      defaultEnabled: true,
      run: async () => {
        const r = await deps.cleanup()
        if (!r.enabled) return { summary: '未设置归档天数，跳过' }
        return {
          summary: r.moved ? `归档 ${r.moved} 封` : '没有需要归档的邮件',
          activity: r.moved ? { source: 'job', title: `定期整理：归档 ${r.moved} 封已读订阅 / 通知`, refs: [], stats: { archived: r.moved } } : null
        }
      }
    }
  ]
}
