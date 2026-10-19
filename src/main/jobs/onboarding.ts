import type { AgentActivity, AgentRef, OnboardingScanStatus } from '@shared/types'
import { aiReady } from '../ai/service'
import { runAsBackground } from './budget'
import { DAY_MS } from './schedule'
import { lifeService } from '../life'
import {
  aiBlockedReason, financeBreakdown, fmtBytes, kbRefs, learnKnowledge, organizeAttachments, organizeFinance, organizeProjects, projectLabel, sweepTodos,
  type WorkDeps
} from './tasks'

type StepKey = OnboardingScanStatus['steps'][number]['key']

const STEPS: { key: StepKey; label: string }[] = [
  { key: 'todo', label: '待办' },
  { key: 'finance', label: '财务' },
  { key: 'attachments', label: '附件' },
  { key: 'kb', label: '知识库' },
  { key: 'projects', label: '项目' },
  { key: 'life', label: '生活档案' }
]

interface Persist {
  v: 1
  /** 见过的账户（首次完成同步时登记；新登记的进 pending） */
  known: string[]
  pending: string[]
  /** 整理过 / 不再提醒的账户 */
  done: string[]
  /** 连续点「稍后」的次数（第二次之后不再打扰） */
  later: number
  /** 老用户升级后的一次性提示 */
  legacy?: boolean
}

const KEY = 'onboardingScan'

const idleSteps = (): OnboardingScanStatus['steps'] => STEPS.map(s => ({ key: s.key, label: s.label, status: 'idle' as const }))

/**
 * 首次整理引导：账户首次完成初始同步后进待整理队列，主窗口引导用户让 Agent 先整理一遍
 * （待办 / 财务 / 附件 / 知识库 / 项目），进度经 'onboarding-scan' 事件推送。
 * 老用户升级：已有账户（有邮件的）算一次待整理，只提示一次，可忽略。
 */
export class OnboardingScan {
  private run: { running: boolean; steps: OnboardingScanStatus['steps']; startedAt: number | null; finishedAt: number | null; days: number | null; accounts: string[] } = {
    running: false,
    steps: idleSteps(),
    startedAt: null,
    finishedAt: null,
    days: null,
    accounts: []
  }
  private hidden = false

  constructor(private deps: WorkDeps & { log(a: Omit<AgentActivity, 'id' | 'at'>): void }) {}

  private load(): Persist | null {
    const st = this.deps.appStore.getRaw<Persist | null>(KEY, null)
    if (!st || st.v !== 1) return null
    return { v: 1, known: st.known ?? [], pending: st.pending ?? [], done: st.done ?? [], later: st.later ?? 0, legacy: !!st.legacy }
  }

  private save(st: Persist) {
    this.deps.appStore.set(KEY, st)
  }

  private hasMail(accountId: string): boolean {
    return !!this.deps.store.db.prepare('SELECT 1 FROM messages WHERE account_id = ? LIMIT 1').get(accountId)
  }

  init() {
    const accounts = this.deps.store.listAccounts()
    let st = this.load()
    if (!st) {
      // 第一次带着这个功能启动：已有且有邮件的账户算一次待整理（老用户升级）；全新安装时为空
      const withMail = accounts.filter(a => a.enabled && this.hasMail(a.id)).map(a => a.id)
      st = { v: 1, known: accounts.map(a => a.id), pending: withMail, done: [], later: 0, legacy: withMail.length > 0 }
      this.save(st)
    } else if (st.later >= 2 && st.pending.length) {
      // 「稍后」过两次：不再打扰
      st = { ...st, done: [...new Set([...st.done, ...st.pending])], pending: [], later: 0 }
      this.save(st)
    }
  }

  private emit() {
    this.deps.event({ type: 'onboarding-scan', status: this.status() })
  }

  /** 同步引擎账户状态：首次「已连接」= 初始同步完成 */
  onAccountStatus(accountId: string, status: string) {
    if (status !== 'connected') return
    const st = this.load()
    if (!st || st.known.includes(accountId)) return
    st.known.push(accountId)
    if (!st.done.includes(accountId) && !st.pending.includes(accountId)) st.pending.push(accountId)
    st.legacy = false
    st.later = 0
    this.hidden = false
    this.save(st)
    this.emit()
  }

  status(): OnboardingScanStatus {
    const st = this.load()
    const accounts = this.deps.store.listAccounts()
    const byId = new Map(accounts.map(a => [a.id, a]))
    const pending = (st?.pending ?? []).filter(id => byId.has(id))
    return {
      running: this.run.running,
      pendingAccounts: pending,
      steps: this.run.steps,
      startedAt: this.run.startedAt,
      finishedAt: this.run.finishedAt,
      accounts: pending.map(id => {
        const a = byId.get(id)!
        return { id, email: a.email, name: a.name || a.email, color: a.color ?? null }
      }),
      aiReady: aiReady(this.deps.appStore.getAI(), false),
      days: this.run.days,
      scannedAccounts: this.run.accounts,
      hidden: this.hidden,
      legacy: !!st?.legacy
    }
  }

  dismiss() {
    const st = this.load()
    if (st) this.save({ ...st, done: [...new Set([...st.done, ...st.pending])], pending: [], later: 0, legacy: false })
    if (!this.run.running) this.run = { running: false, steps: idleSteps(), startedAt: null, finishedAt: null, days: null, accounts: [] }
    this.emit()
  }

  later() {
    this.hidden = true
    const st = this.load()
    if (st) this.save({ ...st, later: st.later + 1 })
    this.emit()
  }

  start(opts: { days: number; accountIds?: string[] | null; steps: StepKey[] }) {
    if (this.run.running) return
    const days = Math.max(1, Math.min(365, Math.round(Number(opts.days) || 30)))
    const st = this.load()
    const existing = new Set(this.deps.store.listAccounts().map(a => a.id))
    const fromOpts = (opts.accountIds ?? []).filter(id => existing.has(id))
    const pending = (st?.pending ?? []).filter(id => existing.has(id))
    // 指定账户 > 待整理账户；老用户升级的一次性整理 = 全部账户
    const accountIds = fromOpts.length ? fromOpts : st?.legacy || !pending.length ? null : pending
    const want = new Set((opts.steps ?? []).filter(k => STEPS.some(s => s.key === k)))
    this.run = {
      running: true,
      steps: STEPS.map(s =>
        want.has(s.key)
          ? { key: s.key, label: s.label, status: 'idle' as const }
          : { key: s.key, label: s.label, status: 'skipped' as const, result: s.key === 'kb' && !aiReady(this.deps.appStore.getAI(), false) ? '需要先配置 AI，已跳过' : '未选择' }
      ),
      startedAt: Date.now(),
      finishedAt: null,
      days,
      accounts: accountIds ?? [...existing]
    }
    this.hidden = false
    this.emit()
    void runAsBackground('onboarding', () => this.execute(days, accountIds, want)).catch(err => console.error('[onboarding] failed:', err))
  }

  private setStep(key: StepKey, patch: Partial<OnboardingScanStatus['steps'][number]>) {
    this.run.steps = this.run.steps.map(s => (s.key === key ? { ...s, ...patch } : s))
    this.emit()
  }

  private async execute(days: number, accountIds: string[] | null, want: Set<StepKey>) {
    const deps = this.deps
    const since = Date.now() - days * DAY_MS
    const refs: AgentRef[] = []
    const stats: Record<string, number> = {}
    const lines: string[] = []
    for (const { key, label } of STEPS) {
      if (!want.has(key)) continue
      this.setStep(key, { status: 'running', result: undefined })
      const aiWhy = aiBlockedReason(deps)
      try {
        if (key === 'todo') {
          const r = await sweepTodos(deps, { since, accountIds, ai: !aiWhy, maxAi: 30, limit: 3000 })
          stats.todos = r.todos.length
          const all = [...r.todos, ...r.linked.filter(l => !r.todos.some(t => t.id === l.id))]
          refs.push(...all.slice(0, 5).map(t => ({ type: 'todo' as const, id: t.id, label: t.title })))
          const text = all.length ? `找到 ${all.length} 条待办${r.todos.length && r.todos.length < all.length ? `（新收集 ${r.todos.length} 条）` : ''}` : '没有发现需要处理的待办'
          if (all.length) lines.push(text)
          this.setStep(key, { status: 'done', result: `${text}${aiWhy ? '（规则识别）' : r.ai ? `（AI 细读 ${r.ai} 封）` : ''}` })
        } else if (key === 'finance') {
          const r = await organizeFinance(deps, days)
          if (!r.ok) throw new Error(r.error || '财务扫描失败')
          stats.finance = r.created.length
          stats.overdue = r.overdue.length
          refs.push(...r.created.slice(0, 5).map(c => ({ type: 'finance' as const, id: c.id, label: c.title })))
          const text = r.created.length ? `找到 ${financeBreakdown(r.created)}` : '没有发现新的款项'
          if (r.created.length) lines.push(text)
          this.setStep(key, { status: 'done', result: `${text}${r.overdue.length ? `，${r.overdue.length} 笔逾期` : ''}` })
        } else if (key === 'attachments') {
          const r = await organizeAttachments(deps, { since, accountIds })
          if (!r.ok) throw new Error(r.error || '附件索引失败')
          stats.attachments = r.count
          const text = r.count ? `${r.count} 个附件（${fmtBytes(r.bytes)}）` : '没有附件'
          if (r.count) lines.push(text)
          this.setStep(key, { status: 'done', result: `${text}${r.releasable > 0 ? `，可释放 ${fmtBytes(r.releasable)}` : ''}` })
        } else if (key === 'kb') {
          if (aiWhy) {
            this.setStep(key, { status: 'skipped', result: `需要 AI（${aiWhy}）` })
            continue
          }
          const r = await learnKnowledge(deps, { since, limit: Math.min(10, deps.budget.settings().kbDailyLimit || 10), accountIds, memoryMax: 3 })
          stats.kb = r.learned.length
          stats.kbMerged = r.merged.length
          stats.memories = r.memories
          refs.push(...kbRefs(r).slice(0, 5))
          const text = r.learned.length || r.merged.length ? `学到 ${r.learned.length} 条知识${r.merged.length ? `，合并 ${r.merged.length} 条` : ''}` : r.stopped ? `暂停：${r.stopped}` : '没有找到值得沉淀的邮件'
          if (r.learned.length || r.merged.length) lines.push(text)
          this.setStep(key, { status: 'done', result: text })
        } else if (key === 'projects') {
          const r = organizeProjects(deps, { days, accountIds, discoverDays: Math.max(14, days) })
          if (!r.ok) throw new Error(r.error || '项目整理失败')
          stats.projectHints = r.candidates
          refs.push(...r.projectIds.slice(0, 3).map(id => ({ type: 'project' as const, id, label: projectLabel(deps, id) })))
          const parts: string[] = []
          if (r.candidates) parts.push(`发现 ${r.candidates} 个可能的项目`)
          if (r.added) parts.push(`归入已有项目 ${r.added} 封`)
          if (r.suggested) parts.push(`${r.suggested} 封待确认`)
          const text = parts.length ? parts.join('，') : '没有发现新的项目线索'
          if (parts.length) lines.push(text)
          this.setStep(key, { status: 'done', result: text })
        } else if (key === 'life') {
          // 生活事务周期长：至少回看 1 年（限速由服务控制：分批让出事件循环，PDF / AI 有上限）
          const r = await lifeService()?.scan(Math.max(365, days), { maxAi: aiWhy ? 0 : 20, maxPdf: 30 })
          if (!r) throw new Error('生活档案模块尚未就绪')
          if (r.ok === false) throw new Error(r.error || '生活档案扫描失败')
          stats.life = r.created
          refs.push(...(r.createdIds ?? []).slice(0, 5).map(id => ({ type: 'life' as const, id, label: lifeService()?.get(id)?.title ?? '生活事务' })))
          const total = lifeService()?.rows(false).length ?? 0
          const text = r.created ? `找到 ${r.created} 件到期 / 续期事务` : total ? `没有新的到期事务（已在档 ${total} 件）` : '没有发现证件 / 保险 / 年检等到期事务'
          if (r.created) lines.push(text)
          this.setStep(key, { status: 'done', result: text })
        }
      } catch (err) {
        console.error(`[onboarding] ${key} failed:`, err)
        this.setStep(key, { status: 'error', result: `${label}整理失败：${err instanceof Error ? err.message.slice(0, 80) : String(err)}` })
      }
    }
    this.run.running = false
    this.run.finishedAt = Date.now()
    // 整理过的账户不再提醒
    const st = this.load()
    if (st) {
      const scanned = new Set(accountIds ?? st.pending)
      this.save({ ...st, done: [...new Set([...st.done, ...scanned])], pending: st.pending.filter(id => !scanned.has(id)), later: 0, legacy: false })
    }
    this.emit()
    try {
      deps.log({
        source: 'onboarding',
        title: `首次整理（近 ${days} 天）：${lines.length ? lines.join('，') : '没有发现需要整理的内容'}`,
        detail: this.run.steps.filter(s => s.status !== 'skipped' || s.result !== '未选择').map(s => `${s.label}：${s.result ?? '—'}`).join('\n'),
        refs: refs.slice(0, 16),
        stats
      })
    } catch (err) {
      console.error('[onboarding] log failed:', err)
    }
  }
}
