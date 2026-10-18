/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentRef, AgentSkill, AgentStep, AgentThread, AgentThreadSummary, AgentToolInfo, AgentTurn, AISettings } from '@shared/types'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import type { AgentService } from '../ai/agent'
import { aiReady, ToolsUnsupportedError, type AIService, type AIToolMessage, type AIToolSpec } from '../ai/service'
import { AGENT_HEADLESS, AGENT_JSON_PROTOCOL, AGENT_OUTPUT_MODE, AGENT_RUNTIME, AGENT_WRAP_UP } from '../ai/prompts'
import { BUILTIN_SKILLS } from './skills-catalog'
import { logActivity } from './hooks'
import { buildTools, fmtTime, toolInfo, toolListText, ToolError, type AgentTool, type ToolDeps } from './tools'
import {
  AGENT_LIMITS,
  allowedTools,
  approvalFor,
  compactMessages,
  parseProtocolStep,
  parseToolArguments,
  rankRefs,
  renderTemplate,
  StepBudget,
  threadTitle,
  truncate,
  validateArgs
} from './protocol'

/**
 * Agent 运行时：工具调用式的多步循环。
 *  - 优先 OpenAI function calling；模型 / 服务商不支持时回退到 JSON 动作协议（内置本地引擎同样走回退）
 *  - 每步经 { type: 'agent-step', runId, threadId, step } 广播给所有窗口，界面按 runId 认领
 *  - 写操作 / 对外动作等用户确认（agentApprove），技能可预授权写操作；无界面运行时不执行、只列为建议
 *  - 会话持久化在 mail.db 的 agent_threads 表；技能 = 内置目录 + 用户自定义（AppStore KV）
 */

export interface RuntimeDeps extends ToolDeps {
  ai: AIService
  getAISettings(): AISettings
}

export interface RunInput {
  runId: string
  threadId?: string | null
  text: string
  skillId?: string | null
  params?: Record<string, string | number>
  context?: { messageId?: string | null; projectId?: string | null }
}

interface Run {
  id: string
  threadId: string
  headless: boolean
  cancelled: boolean
  requestIds: Set<string>
  pending: Map<string, (d: { approve: boolean; remember: boolean }) => void>
  steps: AgentStep[]
  refs: AgentRef[]
  /** 无界面运行时没执行的写操作 */
  suggestions: string[]
  emit(step: AgentStep): void
}

const SKILLS_KEY = 'agentSkills'
const MAX_THREADS = 300
const MAX_TURNS = 80
const HISTORY_TURNS = 10

interface SkillStoreData {
  custom: AgentSkill[]
  overrides: Record<string, Pick<AgentSkill, 'pinned' | 'schedule' | 'autoApprove'>>
}

export class AgentRuntime {
  readonly tools: AgentTool[]
  private runs = new Map<string, Run>()
  /** threadId → 本对话里「都允许」的写工具 */
  private allow = new Map<string, Set<string>>()
  /** 已确认不支持 tools 的 baseURL|model（本次启动内记住，避免每次先撞 400） */
  private noTools = new Set<string>()
  private db: DatabaseSync

  constructor(private deps: RuntimeDeps & { store: MailStore; appStore: AppStore; agent: AgentService }) {
    this.tools = buildTools(deps)
    this.db = deps.store.db
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      skill_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      turns INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    )`)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_agent_threads_updated ON agent_threads(updated_at)')
  }

  // ================================================================ 工具 / 技能

  toolInfos(): AgentToolInfo[] {
    return this.tools.map(toolInfo)
  }

  /** 对外（MCP）暴露的只读工具 */
  readTools(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
    return this.tools.filter(t => t.risk === 'read').map(t => ({ name: t.name, description: `${t.title}：${t.description}`, inputSchema: t.params as Record<string, unknown> }))
  }

  /** MCP 调用只读工具：同样做参数校验；写工具一律拒绝 */
  async runReadTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.find(t => t.name === name && t.risk === 'read')
    if (!tool) throw new Error(`没有只读工具 ${name}`)
    const v = validateArgs(tool.params, args)
    if (!v.ok) throw new Error(v.error)
    const res = await tool.run(v.args, { headless: true, messageId: null })
    return { summary: res.summary, ...((res.data && typeof res.data === 'object' && !Array.isArray(res.data) ? res.data : { result: res.data }) as object) }
  }

  private skillData(): SkillStoreData {
    const raw = this.deps.appStore.getRaw<Partial<SkillStoreData>>(SKILLS_KEY, {})
    return { custom: Array.isArray(raw.custom) ? raw.custom : [], overrides: raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {} }
  }

  skills(): AgentSkill[] {
    const { custom, overrides } = this.skillData()
    const builtin = BUILTIN_SKILLS.map(s => ({ ...s, builtin: true, ...(overrides[s.id] ?? {}) }))
    const ids = new Set(builtin.map(s => s.id))
    return [...builtin, ...custom.filter(s => !ids.has(s.id)).map(s => ({ ...s, builtin: false }))]
  }

  skill(id: string | null | undefined): AgentSkill | null {
    if (!id) return null
    return this.skills().find(s => s.id === id) ?? null
  }

  /** 内置技能只保存 pinned / schedule / autoApprove 覆盖；其余为自定义技能的新建 / 更新 */
  saveSkill(input: AgentSkill): AgentSkill {
    const data = this.skillData()
    const known = new Set(this.tools.map(t => t.name))
    const clean = (list?: string[]) => (Array.isArray(list) ? [...new Set(list.map(String).filter(n => known.has(n)))] : undefined)
    const builtin = BUILTIN_SKILLS.find(s => s.id === input.id)
    if (builtin) {
      data.overrides[builtin.id] = {
        pinned: !!input.pinned,
        schedule: input.schedule ?? null,
        autoApprove: clean(input.autoApprove)?.filter(n => this.tools.find(t => t.name === n)?.risk === 'write')
      }
      this.deps.appStore.set(SKILLS_KEY, data)
      this.changed()
      return this.skill(builtin.id)!
    }
    const id = input.id && !input.id.startsWith('builtin') ? input.id : `skill-${randomUUID().slice(0, 8)}`
    const skill: AgentSkill = {
      ...input,
      id,
      name: String(input.name || '未命名技能').slice(0, 40),
      category: input.category || '自定义',
      description: String(input.description ?? '').slice(0, 200),
      instructions: String(input.instructions ?? '').slice(0, 8000),
      tools: clean(input.tools),
      autoApprove: clean(input.autoApprove)?.filter(n => this.tools.find(t => t.name === n)?.risk === 'write'),
      builtin: false,
      updatedAt: Date.now()
    }
    const i = data.custom.findIndex(s => s.id === id)
    if (i >= 0) data.custom[i] = skill
    else data.custom.push(skill)
    this.deps.appStore.set(SKILLS_KEY, data)
    this.changed()
    return skill
  }

  deleteSkill(id: string) {
    const data = this.skillData()
    if (BUILTIN_SKILLS.some(s => s.id === id)) delete data.overrides[id]
    else data.custom = data.custom.filter(s => s.id !== id)
    this.deps.appStore.set(SKILLS_KEY, data)
    this.changed()
  }

  private changed() {
    this.deps.event({ type: 'agent-skills-changed' })
  }

  // ================================================================ 会话持久化

  threads(): AgentThreadSummary[] {
    const rows = this.db.prepare('SELECT id, title, skill_id, created_at, updated_at, turns FROM agent_threads ORDER BY updated_at DESC LIMIT ?').all(MAX_THREADS) as any[]
    return rows.map(r => ({ id: r.id, title: r.title, skillId: r.skill_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at, turns: r.turns }))
  }

  thread(id: string): AgentThread | null {
    const r = this.db.prepare('SELECT * FROM agent_threads WHERE id = ?').get(id) as any
    if (!r) return null
    let messages: AgentTurn[] = []
    try {
      messages = JSON.parse(r.data)
    } catch {
      messages = []
    }
    return { id: r.id, title: r.title, skillId: r.skill_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at, turns: r.turns, messages }
  }

  deleteThread(id: string) {
    for (const run of this.runs.values()) if (run.threadId === id) this.cancel(run.id)
    this.db.prepare('DELETE FROM agent_threads WHERE id = ?').run(id)
    this.allow.delete(id)
    this.deps.event({ type: 'agent-threads-changed' })
  }

  private saveThread(t: AgentThread) {
    const messages = t.messages.slice(-MAX_TURNS).map(compactTurn)
    this.db
      .prepare(
        `INSERT INTO agent_threads (id, title, skill_id, created_at, updated_at, turns, data) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, skill_id=excluded.skill_id, updated_at=excluded.updated_at, turns=excluded.turns, data=excluded.data`
      )
      .run(t.id, t.title, t.skillId ?? null, t.createdAt, t.updatedAt, messages.length, JSON.stringify(messages))
    const n = (this.db.prepare('SELECT COUNT(*) c FROM agent_threads').get() as { c: number }).c
    if (n > MAX_THREADS) this.db.prepare('DELETE FROM agent_threads WHERE id IN (SELECT id FROM agent_threads ORDER BY updated_at ASC LIMIT ?)').run(n - MAX_THREADS)
    this.deps.event({ type: 'agent-threads-changed' })
  }

  // ================================================================ 运行

  approve(runId: string, callId: string, approve: boolean, remember?: boolean) {
    this.runs.get(runId)?.pending.get(callId)?.({ approve, remember: !!remember })
  }

  cancel(runId: string) {
    const run = this.runs.get(runId)
    if (!run) return
    run.cancelled = true
    for (const id of run.requestIds) this.deps.ai.cancel(id)
    for (const resolve of run.pending.values()) resolve({ approve: false, remember: false })
  }

  /** 界面发起：立即返回 threadId，步骤经事件推送 */
  start(input: RunInput): { ok: boolean; threadId: string; error?: string } {
    const text = String(input.text ?? '').trim()
    const skill = this.skill(input.skillId)
    if (!text && !skill) return { ok: false, threadId: input.threadId ?? '', error: '请输入问题' }
    if (input.skillId && !skill) return { ok: false, threadId: input.threadId ?? '', error: '找不到这个技能' }
    if ([...this.runs.values()].some(r => r.threadId === input.threadId && input.threadId)) return { ok: false, threadId: input.threadId!, error: '这个对话正在运行，等它结束或先停止' }
    const now = Date.now()
    let thread = input.threadId ? this.thread(input.threadId) : null
    const userText = text || `运行技能「${skill!.name}」`
    if (!thread) {
      thread = { id: input.threadId || `th-${now.toString(36)}-${randomUUID().slice(0, 6)}`, title: threadTitle(skill && !text ? skill.name : userText), skillId: skill?.id ?? null, createdAt: now, updatedAt: now, turns: 0, messages: [] }
    }
    // 针对单封邮件的技能（contextKind='message'）：外壳把邮件 id 放在 params.messageId，兜底成上下文
    const pm = input.params?.messageId
    if (pm && !input.context?.messageId) input = { ...input, context: { ...(input.context ?? {}), messageId: String(pm) } }
    const history = thread.messages.slice()
    thread.messages.push({ role: 'user', text: userText, at: now, skillId: skill?.id ?? null })
    thread.updatedAt = now
    this.saveThread(thread)
    const t = thread
    void this.execute({ input: { ...input, text: userText }, thread: t, history, skill, headless: false }).catch(err => console.error('[agent] run failed:', err))
    return { ok: true, threadId: t.id }
  }

  /** 无界面运行技能（自动任务）：写操作不在 autoApprove 内则不执行，列为建议 */
  async runSkillHeadless(skillId: string, params?: Record<string, string | number>): Promise<{ ok: boolean; text: string; refs: AgentRef[]; error?: string }> {
    const skill = this.skill(skillId)
    if (!skill) return { ok: false, text: '', refs: [], error: '找不到这个技能' }
    const now = Date.now()
    const thread: AgentThread = { id: `headless-${now.toString(36)}`, title: skill.name, skillId, createdAt: now, updatedAt: now, turns: 0, messages: [] }
    const res = await this.execute({ input: { runId: `bg-${randomUUID()}`, text: `运行技能「${skill.name}」`, skillId, params, context: params?.messageId ? { messageId: String(params.messageId) } : undefined }, thread, history: [], skill, headless: true })
    return res
  }

  private aiMode(): 'tools' | 'protocol' {
    const s = this.deps.getAISettings()
    if (s.baseURL === 'builtin-local') return 'protocol'
    return this.noTools.has(`${s.baseURL}|${s.model}`) ? 'protocol' : 'tools'
  }

  private systemPrompt(opts: { question: string; skill: AgentSkill | null; params?: Record<string, string | number>; context?: RunInput['context']; headless: boolean; mode: 'tools' | 'protocol'; tools: AgentTool[] }): string {
    const { store, agent } = this.deps
    const now = new Date()
    const accounts = store.listAccounts().map(a => `${a.name} <${a.email}>`)
    const parts = [AGENT_RUNTIME, `当前时间：${fmtTime(now.getTime())}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）。用户的邮件账户：${accounts.join('、') || '（还没有账户）'}。`]
    if (opts.context?.messageId) {
      const row = store.getMessageRow(opts.context.messageId)
      if (row) {
        const gist = store.getMailAi([row.id])[row.id]?.gist
        parts.push(
          `【当前邮件】用户正在看这封邮件，说「这封」「这个人」「它」时指它：id=${row.id}；主题《${row.subject || '（无主题）'}》；发件人 ${row.from_name ? `${row.from_name} <${row.from_addr}>` : row.from_addr}；时间 ${fmtTime(row.date)}${gist ? `；要点：${gist}` : ''}。需要正文时用 read_message 读取。`
        )
      }
    }
    if (opts.context?.projectId) {
      const p = this.deps.projects.list().find(x => x.id === opts.context!.projectId)
      if (p) parts.push(`【当前项目】用户正在看项目「${p.data.name}」（id=${p.id}，对方：${p.data.counterparties.join('、') || '未知'}），说「这个项目」时指它。`)
    }
    const mem = agent.memoryPrompt(opts.question, 8).block
    if (mem) parts.push(mem.trim())
    if (opts.skill) {
      parts.push(`【本次任务：技能「${opts.skill.name}」】\n${renderTemplate(opts.skill.instructions, opts.params, opts.skill.params)}`)
      if (opts.skill.params?.length) {
        const vals = opts.skill.params.map(p => `${p.label}=${opts.params?.[p.key] ?? p.default ?? '（未指定）'}`).join('；')
        parts.push(`技能参数：${vals}`)
      }
      if (opts.skill.output) parts.push(AGENT_OUTPUT_MODE[opts.skill.output])
    }
    if (opts.headless) parts.push(AGENT_HEADLESS)
    if (opts.mode === 'protocol') parts.push(AGENT_JSON_PROTOCOL(toolListText(opts.tools)))
    return parts.join('\n\n')
  }

  private historyMessages(history: AgentTurn[]): AIToolMessage[] {
    return history.slice(-HISTORY_TURNS).map(t => {
      if (t.role === 'user') return { role: 'user' as const, content: truncate(t.text, 2000) }
      const refs = (t.refs ?? []).slice(0, 8).map(r => `${r.type}:${r.id}「${r.label}」`).join('；')
      const body = t.text || (t.steps?.find(s => s.kind === 'error') as { message?: string } | undefined)?.message || '（没有回答）'
      return { role: 'assistant' as const, content: `${truncate(body, 2000)}${refs ? `\n（本轮涉及：${refs}）` : ''}` }
    })
  }

  private async execute(o: { input: RunInput; thread: AgentThread; history: AgentTurn[]; skill: AgentSkill | null; headless: boolean }): Promise<{ ok: boolean; text: string; refs: AgentRef[]; error?: string }> {
    const { input, thread, skill, headless } = o
    const run: Run = {
      id: input.runId,
      threadId: thread.id,
      headless,
      cancelled: false,
      requestIds: new Set(),
      pending: new Map(),
      steps: [],
      refs: [],
      suggestions: [],
      emit: step => {
        // 持久化用的步骤：文本增量合并成段；工具步骤按 callId 覆盖
        if (step.kind === 'text') {
          const last = run.steps[run.steps.length - 1]
          if (last?.kind === 'text') run.steps[run.steps.length - 1] = { kind: 'text', delta: last.delta + step.delta }
          else run.steps.push({ ...step })
        } else if (step.kind === 'plan') {
          // 计划 = 刚才流出的那段文字：替换掉末尾的文本段
          if (run.steps[run.steps.length - 1]?.kind === 'text') run.steps.pop()
          run.steps.push(step)
        } else if (step.kind === 'tool') {
          const i = run.steps.findIndex(s => s.kind === 'tool' && s.callId === step.callId)
          if (i >= 0) run.steps[i] = step
          else run.steps.push(step)
        } else if (step.kind === 'error') run.steps.push(step)
        if (!headless) this.deps.event({ type: 'agent-step', runId: run.id, threadId: thread.id, step })
      }
    }
    this.runs.set(run.id, run)
    let finalText = ''
    let error: string | undefined
    try {
      const settings = this.deps.getAISettings()
      if (!aiReady(settings, true)) throw new Error(settings.enabled ? '还没有配置 AI（在 设置 → AI 中填写 API Key）' : '还没有配置 AI（在 设置 → AI 中开启）')
      const tools = allowedTools(this.tools, skill)
      let mode = this.aiMode()
      const sys = (m: 'tools' | 'protocol') => this.systemPrompt({ question: input.text, skill, params: input.params, context: input.context, headless, mode: m, tools })
      const base = (m: 'tools' | 'protocol'): AIToolMessage[] => [{ role: 'system', content: sys(m) }, ...this.historyMessages(o.history), { role: 'user', content: input.text }]
      if (mode === 'tools') {
        try {
          finalText = await this.loopTools(run, base('tools'), tools, skill)
        } catch (err) {
          if (!(err instanceof ToolsUnsupportedError)) throw err
          this.noTools.add(`${settings.baseURL}|${settings.model}`)
          mode = 'protocol'
          // 回退前已流出的文字作废
          if (run.steps[run.steps.length - 1]?.kind === 'text') run.steps.pop()
          finalText = await this.loopProtocol(run, base('protocol'), tools, skill)
        }
      } else finalText = await this.loopProtocol(run, base('protocol'), tools, skill)
    } catch (err) {
      if (!run.cancelled) {
        error = err instanceof Error ? err.message : String(err)
        run.emit({ kind: 'error', message: error })
      }
    } finally {
      this.runs.delete(run.id)
    }
    // 中途停止：保留已经流出的那段回答
    if (run.cancelled && !finalText.trim()) {
      const tail: string[] = []
      for (let i = run.steps.length - 1; i >= 0 && run.steps[i].kind === 'text'; i--) tail.unshift((run.steps[i] as { delta: string }).delta)
      finalText = tail.join('')
    }
    if (headless && run.suggestions.length) finalText = `${finalText.trim()}\n\n**建议的操作**（需要你确认后才会执行）：\n${run.suggestions.map(s => `- ${s}`).join('\n')}`
    const refs = run.cancelled && !finalText.trim() ? [] : rankRefs(run.refs, finalText)
    if (!error) {
      if (refs.length) run.emit({ kind: 'refs', refs })
      run.emit({ kind: 'done', text: finalText, refs, ...(run.cancelled ? { cancelled: true } : {}) })
    }
    // 持久化：末尾的文本段就是最终回答，不再重复存
    const steps = run.steps.slice()
    if (steps[steps.length - 1]?.kind === 'text') steps.pop()
    const turn: AgentTurn = { role: 'assistant', text: finalText, at: Date.now(), skillId: skill?.id ?? null, steps, refs }
    if (!headless) {
      thread.messages.push(turn)
      thread.updatedAt = Date.now()
      this.saveThread(thread)
    }
    if (skill && !error && !run.cancelled && !headless) logActivity({ source: 'skill', title: `运行技能「${skill.name}」`, detail: truncate(finalText, 300), refs: refs.slice(0, 6) })
    return error ? { ok: false, text: finalText, refs, error } : { ok: true, text: finalText, refs }
  }

  /** function calling 循环 */
  private async loopTools(run: Run, messages: AIToolMessage[], tools: AgentTool[], skill: AgentSkill | null): Promise<string> {
    const specs: AIToolSpec[] = tools.map(t => ({ type: 'function', function: { name: t.name, description: `${t.title}：${t.description}`, parameters: t.params as Record<string, unknown> } }))
    const budget = new StepBudget()
    let wrapUp = false
    while (!run.cancelled) {
      if (!budget.round()) wrapUp = true
      const reqId = `agent-${run.id}-${budget.rounds}`
      run.requestIds.add(reqId)
      let streamed = ''
      const res = await this.deps.ai
        .chatTools(reqId, compactMessages(messages), specs, d => {
          streamed += d
          run.emit({ kind: 'text', delta: d })
        }, wrapUp ? { toolChoice: 'none' } : {})
        .finally(() => run.requestIds.delete(reqId))
      if (run.cancelled) return streamed
      if (!res.toolCalls.length || wrapUp) {
        if (res.toolCalls.length && !res.content.trim()) {
          // 收尾轮仍坚持调工具：不再执行，给出兜底
          const text = '这次需要查的东西比较多，已经用完了本轮的工具步数。上面是已经查到的内容，你可以让我继续，或把问题拆小一点。'
          run.emit({ kind: 'text', delta: text })
          return text
        }
        return res.content
      }
      if (res.content.trim()) run.emit({ kind: 'plan', text: res.content.trim() })
      messages.push({ role: 'assistant', content: res.content || null, tool_calls: res.toolCalls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments || '{}' } })) })
      for (const call of res.toolCalls) {
        if (run.cancelled) break
        let content: string
        if (!budget.canCall()) {
          content = '已达到本次工具调用上限，这个调用没有执行。'
          wrapUp = true
        } else {
          budget.use()
          content = await this.execTool(run, call.id, call.name, parseToolArguments(call.arguments), tools, skill)
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content })
      }
      if (budget.exhausted) {
        wrapUp = true
        messages.push({ role: 'user', content: AGENT_WRAP_UP })
      }
    }
    return ''
  }

  /** 回退协议循环：每步一个 JSON（{"tool"} 或 {"final"}） */
  private async loopProtocol(run: Run, messages: AIToolMessage[], tools: AgentTool[], skill: AgentSkill | null): Promise<string> {
    const budget = new StepBudget()
    let invalid = 0
    let wrapUp = false
    while (!run.cancelled) {
      if (!budget.round()) wrapUp = true
      const reqId = `agent-${run.id}-p${budget.rounds}`
      run.requestIds.add(reqId)
      const plain = compactMessages(messages).map(m => ({ role: m.role === 'tool' ? ('user' as const) : (m.role as 'system' | 'user' | 'assistant'), content: String((m as { content?: string | null }).content ?? '') }))
      const raw = await this.deps.ai.stream(reqId, plain, () => {}).finally(() => run.requestIds.delete(reqId))
      if (run.cancelled) return ''
      const step = parseProtocolStep(raw)
      if (step.kind === 'final' || (wrapUp && step.kind !== 'invalid') || (step.kind === 'invalid' && invalid >= 1)) {
        const text = step.kind === 'final' ? step.text : step.kind === 'invalid' ? raw.trim() : '这次需要查的东西比较多，已经用完了本轮的工具步数。你可以让我继续，或把问题拆小一点。'
        await emitChunks(run, text)
        return text
      }
      messages.push({ role: 'assistant', content: raw })
      if (step.kind === 'invalid') {
        invalid++
        messages.push({ role: 'user', content: `你的输出不符合协议（${step.error}）。请只输出一个 JSON 对象：{"tool":..,"args":{..}} 或 {"final":".."}。` })
        continue
      }
      invalid = 0
      if (step.plan) run.emit({ kind: 'plan', text: step.plan })
      budget.use()
      const callId = `p${budget.calls}-${randomUUID().slice(0, 6)}`
      const content = await this.execTool(run, callId, step.tool, step.args, tools, skill)
      messages.push({ role: 'user', content: `【工具结果】${step.tool}：${content}${budget.exhausted ? `\n\n${AGENT_WRAP_UP}` : '\n\n继续：需要的话再调用一个工具，否则输出 {"final":"…"}。'}` })
      if (budget.exhausted) wrapUp = true
    }
    return ''
  }

  /** 执行一个工具调用：校验 → 确认 → 执行 → 推送步骤；返回给模型的结果文本 */
  private async execTool(run: Run, callId: string, name: string, rawArgs: Record<string, unknown> | null, tools: AgentTool[], skill: AgentSkill | null): Promise<string> {
    const tool = tools.find(t => t.name === name)
    const args0 = rawArgs ?? {}
    if (!tool) {
      run.emit({ kind: 'tool', callId, tool: name, title: name, args: args0, risk: 'read', status: 'error', summary: '没有这个工具' })
      const known = this.tools.find(t => t.name === name)
      return known ? `工具 ${name} 不在本次任务允许的范围内，请用其他工具。` : `没有名为 ${name} 的工具。可用的工具：${tools.map(t => t.name).join(', ')}`
    }
    if (!rawArgs) {
      run.emit({ kind: 'tool', callId, tool: name, title: tool.title, args: {}, risk: tool.risk, status: 'error', summary: '参数格式错误' })
      return '参数不是合法的 JSON 对象，请重新调用。'
    }
    const v = validateArgs(tool.params, rawArgs)
    if (!v.ok) {
      run.emit({ kind: 'tool', callId, tool: name, title: tool.title, args: rawArgs, risk: tool.risk, status: 'error', summary: v.error })
      return `参数有误：${v.error}。请修正后重新调用。`
    }
    const args = v.args
    const reason = typeof args.reason === 'string' ? args.reason : undefined
    const decision = approvalFor(tool.risk, tool.name, { autoApprove: skill?.autoApprove, remembered: this.allow.get(run.threadId), headless: run.headless })
    let targets: string[] | undefined
    if (tool.risk !== 'read') {
      try {
        targets = tool.preview?.(args)
      } catch {
        targets = undefined
      }
    }
    const shown = displayArgs(args)
    const base = { kind: 'tool' as const, callId, tool: name, title: tool.title, args: shown, risk: tool.risk, ...(reason ? { reason } : {}), ...(targets?.length ? { targets: targets.slice(0, 30) } : {}) }
    if (decision === 'headless-skip') {
      run.emit({ ...base, status: 'denied', summary: '需要确认，未执行（已列为建议）' })
      run.suggestions.push(`${tool.title}${targets?.length ? `：${targets.slice(0, 5).join('；')}${targets.length > 5 ? ` 等 ${targets.length} 项` : ''}` : ''}${reason ? `（${reason}）` : ''}`)
      return '后台运行：这个操作需要用户确认，没有执行，已记录为建议。继续完成其余部分。'
    }
    if (decision === 'ask') {
      run.emit({ ...base, status: 'awaiting', summary: tool.risk === 'external' ? '对外动作，等你确认' : '等你确认' })
      const d = await new Promise<{ approve: boolean; remember: boolean }>(resolve => run.pending.set(callId, resolve))
      run.pending.delete(callId)
      if (run.cancelled) {
        run.emit({ ...base, status: 'denied', summary: '已停止' })
        return '用户停止了运行。'
      }
      if (!d.approve) {
        run.emit({ ...base, status: 'denied', summary: '你拒绝了这个操作' })
        return '用户拒绝了这个操作，没有执行。不要再尝试同样的操作，在回答里说明即可。'
      }
      if (d.remember && tool.risk === 'write') {
        const set = this.allow.get(run.threadId) ?? new Set<string>()
        set.add(tool.name)
        this.allow.set(run.threadId, set)
      }
    }
    run.emit({ ...base, status: 'running' })
    try {
      const res = await tool.run(args, { headless: run.headless, messageId: null })
      if (res.refs?.length) run.refs.push(...res.refs)
      const json = JSON.stringify(res.data)
      run.emit({ ...base, status: 'done', summary: res.summary, detail: truncate(prettyDetail(res.data), 1500) })
      if (tool.risk !== 'read') logActivity({ source: skill ? 'skill' : 'chat', title: `${tool.title} · ${res.summary}`, detail: reason ?? null, refs: (res.refs ?? []).slice(0, 6) })
      return truncate(json, AGENT_LIMITS.maxResultChars)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      run.emit({ ...base, status: 'error', summary: truncate(msg, 120) })
      return err instanceof ToolError ? `工具返回错误：${msg}。请根据错误换个参数或换个工具。` : `工具执行失败：${msg}。可以换个方式继续，或如实告诉用户。`
    }
  }
}

// ---------------------------------------------------------------- 辅助

/** 回退协议的最终回答按小段推出（与流式体验一致） */
async function emitChunks(run: Run, text: string) {
  const chars = [...text]
  for (let i = 0; i < chars.length && !run.cancelled; i += 24) {
    run.emit({ kind: 'text', delta: chars.slice(i, i + 24).join('') })
    if (i % 240 === 0) await new Promise(r => setTimeout(r, 0))
  }
}

/** 界面展示用的参数：去掉 reason，长文本截短 */
function displayArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (k === 'reason') continue
    if (typeof v === 'string') out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v
    else if (Array.isArray(v)) out[k] = v.length > 12 ? [...v.slice(0, 12), `…共 ${v.length} 项`] : v
    else out[k] = v
  }
  return out
}

/** 结果详情：结构化数据转成好读的缩进文本 */
function prettyDetail(data: unknown): string {
  try {
    return JSON.stringify(data, null, 1)
  } catch {
    return String(data)
  }
}

/** 持久化前压缩一轮：步骤详情截短、参数截短 */
function compactTurn(t: AgentTurn): AgentTurn {
  if (!t.steps?.length) return t
  return {
    ...t,
    steps: t.steps.slice(0, 40).map(s => {
      if (s.kind === 'tool') return { ...s, args: displayArgs(s.args), ...(s.detail ? { detail: s.detail.slice(0, 1200) } : {}), ...(s.targets ? { targets: s.targets.slice(0, 12) } : {}) }
      if (s.kind === 'text') return { kind: 'text', delta: s.delta.slice(0, 4000) }
      return s
    })
  }
}
