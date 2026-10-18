/**
 * Agent 运行时的纯逻辑（无 IO，只允许 import type，便于独立打包做单测）：
 *  - 工具参数校验与宽松纠正（JSON Schema 子集）
 *  - 步骤预算 / 结果截断 / 上下文压缩
 *  - 回退协议（不支持 function calling 的模型）：每步输出 {"tool":..,"args":..} 或 {"final":..}
 *  - 相对日期换算、本地搜索语法解析、技能模板填充、来源引用排序
 */
import type { AgentRef, AgentSkill, AgentToolRisk } from '@shared/types'

// ---------------------------------------------------------------- JSON Schema 子集

export interface JsonSchema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: (string | number)[]
  minimum?: number
  maximum?: number
  default?: unknown
}

export type ValidateResult = { ok: true; args: Record<string, unknown> } | { ok: false; error: string }

function coerce(key: string, v: unknown, s: JsonSchema): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (s.type) {
    case 'string': {
      if (typeof v === 'number' || typeof v === 'boolean') v = String(v)
      if (typeof v !== 'string') return { ok: false, error: `参数 ${key} 应为字符串` }
      const t = v.trim()
      if (s.enum && !s.enum.includes(t)) return { ok: false, error: `参数 ${key} 只能是 ${s.enum.join(' / ')}` }
      return { ok: true, value: t }
    }
    case 'integer':
    case 'number': {
      let n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
      if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, error: `参数 ${key} 应为数字` }
      if (s.type === 'integer') n = Math.round(n)
      // 范围越界直接夹紧（limit 之类的参数模型常给大数，不值得报错重来）
      if (s.minimum !== undefined && (n as number) < s.minimum) n = s.minimum
      if (s.maximum !== undefined && (n as number) > s.maximum) n = s.maximum
      if (s.enum && !s.enum.includes(n as number)) return { ok: false, error: `参数 ${key} 只能是 ${s.enum.join(' / ')}` }
      return { ok: true, value: n }
    }
    case 'boolean': {
      if (typeof v === 'boolean') return { ok: true, value: v }
      if (v === 'true' || v === 1 || v === '1' || v === '是') return { ok: true, value: true }
      if (v === 'false' || v === 0 || v === '0' || v === '否') return { ok: true, value: false }
      return { ok: false, error: `参数 ${key} 应为 true / false` }
    }
    case 'array': {
      let arr = v
      if (typeof arr === 'string') {
        const t = arr.trim()
        if (t.startsWith('[')) {
          try {
            arr = JSON.parse(t)
          } catch {
            arr = [t]
          }
        } else arr = t.includes(',') || t.includes('，') ? t.split(/[,，]/).map(x => x.trim()).filter(Boolean) : [t]
      }
      if (!Array.isArray(arr)) arr = [arr]
      const out: unknown[] = []
      for (const [i, item] of (arr as unknown[]).entries()) {
        if (!s.items) {
          out.push(item)
          continue
        }
        const r = coerce(`${key}[${i}]`, item, s.items)
        if (!r.ok) return r
        out.push(r.value)
      }
      return { ok: true, value: out }
    }
    case 'object': {
      if (typeof v === 'string') {
        try {
          v = JSON.parse(v)
        } catch {
          return { ok: false, error: `参数 ${key} 应为对象` }
        }
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: `参数 ${key} 应为对象` }
      if (!s.properties) return { ok: true, value: v }
      const r = validateArgs(s, v)
      return r.ok ? { ok: true, value: r.args } : r
    }
    default:
      return { ok: true, value: v }
  }
}

/** 按 schema 校验并纠正参数：类型宽松转换、范围夹紧、缺省值、必填检查；未声明的参数丢弃 */
export function validateArgs(schema: JsonSchema, raw: unknown): ValidateResult {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const props = schema.properties ?? {}
  const args: Record<string, unknown> = {}
  for (const [key, s] of Object.entries(props)) {
    const v = input[key]
    if (v === undefined || v === null || (v === '' && s.type !== 'string')) {
      if (s.default !== undefined) args[key] = s.default
      continue
    }
    if (v === '' && s.type === 'string') continue
    const r = coerce(key, v, s)
    if (!r.ok) return r
    args[key] = r.value
  }
  const missing = (schema.required ?? []).filter(k => {
    const v = args[k]
    return v === undefined || v === '' || (Array.isArray(v) && !v.length)
  })
  if (missing.length) return { ok: false, error: `缺少必填参数：${missing.join('、')}` }
  return { ok: true, args }
}

/** 模型给的 arguments 字符串 → 对象（容忍代码块包裹、尾逗号、空串） */
export function parseToolArguments(raw: string | null | undefined): Record<string, unknown> | null {
  const t = String(raw ?? '').trim()
  if (!t) return {}
  const obj = extractJsonObject(t)
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null
}

// ---------------------------------------------------------------- JSON 抽取

/** 从任意文本中取出第一个配平的 JSON 对象（字符串内的括号不计），解析失败再尝试去掉尾逗号 */
export function extractJsonObject(text: string): unknown {
  const src = text.replace(/```(?:json)?/gi, '')
  for (let start = src.indexOf('{'); start !== -1; start = src.indexOf('{', start + 1)) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < src.length; i++) {
      const c = src[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          const body = src.slice(start, i + 1)
          try {
            return JSON.parse(body)
          } catch {
            try {
              return JSON.parse(body.replace(/,\s*([}\]])/g, '$1'))
            } catch {
              break
            }
          }
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------- 回退协议

export type ProtocolAction =
  | { kind: 'tool'; tool: string; args: Record<string, unknown>; plan?: string }
  | { kind: 'final'; text: string }
  | { kind: 'invalid'; error: string }

/**
 * 解析回退协议的一步输出：
 *   {"plan":"…","tool":"search_mail","args":{…}}  → 调工具
 *   {"final":"…"}                                 → 最终回答
 *   不是 JSON 的纯文本                              → 视为最终回答（小模型常忘了包 JSON）
 */
export function parseProtocolStep(text: string): ProtocolAction {
  const t = String(text ?? '').trim()
  if (!t) return { kind: 'invalid', error: '模型没有输出内容' }
  const obj = extractJsonObject(t) as Record<string, unknown> | null
  if (obj && typeof obj === 'object') {
    const tool = typeof obj.tool === 'string' ? obj.tool.trim() : typeof obj.action === 'string' ? (obj.action as string).trim() : ''
    if (tool && tool !== 'final') {
      const rawArgs = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input ?? {}
      const args =
        typeof rawArgs === 'string' ? parseToolArguments(rawArgs) ?? {} : rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {}
      const plan = typeof obj.plan === 'string' ? obj.plan.trim() : typeof obj.thought === 'string' ? (obj.thought as string).trim() : undefined
      return { kind: 'tool', tool, args, plan: plan || undefined }
    }
    const fin = obj.final ?? obj.answer ?? obj.response
    if (typeof fin === 'string' && fin.trim()) return { kind: 'final', text: fin.trim() }
    if (tool === 'final' && typeof obj.args === 'object' && obj.args && typeof (obj.args as { text?: unknown }).text === 'string')
      return { kind: 'final', text: String((obj.args as { text: string }).text) }
    // JSON 但两者都没有：如果 JSON 前后还有大段文字，把文字当回答
    const outside = t.replace(/```(?:json)?[\s\S]*?```/gi, '').replace(/\{[\s\S]*\}/, '').trim()
    if (outside.length > 20) return { kind: 'final', text: outside }
    return { kind: 'invalid', error: '输出的 JSON 里既没有 tool 也没有 final' }
  }
  if (/^\s*\{/.test(t)) return { kind: 'invalid', error: 'JSON 不完整或格式错误' }
  return { kind: 'final', text: t }
}

// ---------------------------------------------------------------- 预算与截断

export const AGENT_LIMITS = {
  /** 一次运行最多调用工具的次数 */
  maxToolCalls: 12,
  /** 一次运行最多请求模型的轮数（含最终回答） */
  maxRounds: 14,
  /** 单个工具结果交给模型的最大字符数 */
  maxResultChars: 6000,
  /** 全部消息的软上限（字符）：超过后压缩较早的工具结果 */
  maxContextChars: 48_000,
  /** 压缩后每条旧工具结果保留的字符数 */
  compactResultChars: 600
}

export function truncate(text: string, max: number): string {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n…（已截断，原文共 ${s.length} 字）`
}

export class StepBudget {
  calls = 0
  rounds = 0
  constructor(public maxCalls = AGENT_LIMITS.maxToolCalls, public maxRounds = AGENT_LIMITS.maxRounds) {}
  /** 进入新一轮模型请求；返回 false 表示轮数用尽 */
  round(): boolean {
    this.rounds++
    return this.rounds <= this.maxRounds
  }
  /** 是否还能再调用 n 个工具 */
  canCall(n = 1): boolean {
    return this.calls + n <= this.maxCalls
  }
  use(n = 1) {
    this.calls += n
  }
  get exhausted(): boolean {
    return this.calls >= this.maxCalls || this.rounds >= this.maxRounds
  }
  get left(): number {
    return Math.max(0, this.maxCalls - this.calls)
  }
}

/** 上下文压缩：总长超过上限时，从最早的工具结果开始截到 keep 字符（最近两条保持原样） */
export function compactMessages<T extends { role: string; content?: string | null }>(messages: T[], maxChars = AGENT_LIMITS.maxContextChars, keep = AGENT_LIMITS.compactResultChars): T[] {
  const size = () => messages.reduce((s, m) => s + (m.content?.length ?? 0), 0)
  if (size() <= maxChars) return messages
  const toolIdx = messages.map((m, i) => (m.role === 'tool' || (m.role === 'user' && m.content?.startsWith('【工具结果】')) ? i : -1)).filter(i => i >= 0)
  const out = [...messages]
  for (const i of toolIdx.slice(0, -2)) {
    const c = out[i].content ?? ''
    if (c.length > keep) out[i] = { ...out[i], content: `${c.slice(0, keep)}\n…（较早的结果已压缩）` }
    if (out.reduce((s, m) => s + (m.content?.length ?? 0), 0) <= maxChars) break
  }
  return out
}

// ---------------------------------------------------------------- 确认策略

export type ApprovalDecision = 'auto' | 'ask' | 'headless-skip'

/**
 * 是否需要用户确认：
 *  read → 自动；external → 永远询问（无界面时不执行）；
 *  write → 技能预授权 / 本对话「都允许」时自动，否则询问（无界面时不执行，只列为建议）
 */
export function approvalFor(risk: AgentToolRisk, tool: string, opts: { autoApprove?: string[] | null; remembered?: Iterable<string> | null; headless?: boolean }): ApprovalDecision {
  if (risk === 'read') return 'auto'
  if (risk === 'external') return opts.headless ? 'headless-skip' : 'ask'
  if (opts.autoApprove?.includes(tool)) return 'auto'
  if (opts.remembered && [...opts.remembered].includes(tool)) return 'auto'
  return opts.headless ? 'headless-skip' : 'ask'
}

/** 技能允许的工具：未指定时 = 全部工具（写操作仍需确认） */
export function allowedTools<T extends { name: string }>(all: T[], skill?: Pick<AgentSkill, 'tools'> | null): T[] {
  if (!skill?.tools?.length) return all
  const set = new Set(skill.tools)
  return all.filter(t => set.has(t.name))
}

// ---------------------------------------------------------------- 技能模板

/** {{param}} 占位替换：参数值 → 默认值 → 「（未指定）」 */
export function renderTemplate(tpl: string, params: Record<string, string | number> | undefined, defs?: { key: string; default?: string | number }[]): string {
  return String(tpl ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k: string) => {
    const v = params?.[k]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v)
    const d = defs?.find(x => x.key === k)?.default
    if (d !== undefined && d !== null && String(d).trim() !== '') return String(d)
    return '（未指定）'
  })
}

// ---------------------------------------------------------------- 日期

const pad = (n: number) => String(n).padStart(2, '0')
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const WEEK: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
const CN_NUM: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : CN_NUM[s] ?? NaN)

/**
 * 相对日期 → YYYY-MM-DD（本地时区）。支持：
 * 今天 / 明天 / 后天 / 大后天 / 昨天 / 前天、N 天后 / 前、N 周后、周X / 本周X / 这周X / 下周X / 下下周X / 上周X、
 * 月底 / 月初 / 下个月初 / 下月底、YYYY-MM-DD / YYYY/M/D / M月D日 / M-D、today / tomorrow / yesterday
 */
export function resolveDate(expr: string, now = new Date()): string | null {
  const e = String(expr ?? '').trim().toLowerCase().replace(/\s+/g, '')
  if (!e) return null
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const add = (days: number) => {
    const d = new Date(base)
    d.setDate(d.getDate() + days)
    return ymd(d)
  }
  const fixed: Record<string, number> = { 今天: 0, 今日: 0, today: 0, 明天: 1, 明日: 1, tomorrow: 1, 后天: 2, 大后天: 3, 昨天: -1, yesterday: -1, 前天: -2 }
  if (e in fixed) return add(fixed[e])
  let m = e.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/)
  if (m) return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`
  m = e.match(/^(\d{1,2})[-/.月](\d{1,2})[日号]?$/)
  if (m) return `${base.getFullYear()}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`
  m = e.match(/^(\d+|[一两二三四五六七八九十])(天|日|周|星期|个?月)(后|以后|之后|前|以前|之前)$/)
  if (m) {
    const n = num(m[1])
    const sign = m[3].includes('前') ? -1 : 1
    if (m[2] === '天' || m[2] === '日') return add(sign * n)
    if (m[2] === '周' || m[2] === '星期') return add(sign * n * 7)
    const d = new Date(base)
    d.setMonth(d.getMonth() + sign * n)
    return ymd(d)
  }
  m = e.match(/^(下下|下|上|本|这)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天])$/)
  if (m) {
    const target = WEEK[m[2]]
    // 周一为一周开始：周日记为 7
    const t = target === 0 ? 7 : target
    const today = base.getDay() === 0 ? 7 : base.getDay()
    const weekShift = m[1] === '下' ? 7 : m[1] === '下下' ? 14 : m[1] === '上' ? -7 : 0
    let diff = t - today + weekShift
    // 只说「周三」且已过：指下一个
    if (!m[1] && diff < 0) diff += 7
    return add(diff)
  }
  if (e === '月底' || e === '本月底' || e === '这个月底') return ymd(new Date(base.getFullYear(), base.getMonth() + 1, 0))
  if (e === '月初' || e === '本月初') return ymd(new Date(base.getFullYear(), base.getMonth(), 1))
  if (e === '下个月初' || e === '下月初') return ymd(new Date(base.getFullYear(), base.getMonth() + 1, 1))
  if (e === '下个月底' || e === '下月底') return ymd(new Date(base.getFullYear(), base.getMonth() + 2, 0))
  if (e === '上个月初' || e === '上月初') return ymd(new Date(base.getFullYear(), base.getMonth() - 1, 1))
  if (e === '上个月底' || e === '上月底') return ymd(new Date(base.getFullYear(), base.getMonth(), 0))
  if (e === '年底' || e === '今年底') return `${base.getFullYear()}-12-31`
  return null
}

/** 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:mm' → 本地时间戳；相对说法先经 resolveDate；失败返回 null */
export function parseWhen(s: string | null | undefined, now = new Date(), defaultTime = '09:00'): number | null {
  const t = String(s ?? '').trim()
  if (!t) return null
  const m = t.match(/^(.+?)(?:[ T](\d{1,2}):(\d{2}))?$/)
  const datePart = m?.[1] ?? t
  const day = /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : resolveDate(datePart, now)
  if (!day) {
    const p = Date.parse(t)
    return Number.isFinite(p) ? p : null
  }
  const [hh, mm] = m?.[2] ? [m[2], m[3]] : defaultTime.split(':')
  const [y, mo, d] = day.split('-').map(Number)
  return new Date(y, mo - 1, d, Number(hh), Number(mm)).getTime()
}

// ---------------------------------------------------------------- 搜索语法

export interface ParsedMailQuery {
  terms: string[]
  sender?: string
  to?: string
  subject?: string
  hasAttachment?: boolean
  unreadOnly?: boolean
  flaggedOnly?: boolean
  after?: string
  before?: string
  /** in: 的原始值（账户名 / 邮箱 / 文件夹名），由调用方解析 */
  in?: string
}

const SYNTAX_KEY: Record<string, keyof ParsedMailQuery> = {
  from: 'sender', 发件人: 'sender', 来自: 'sender', 发件: 'sender',
  to: 'to', 收件人: 'to', 发给: 'to', cc: 'to',
  subject: 'subject', 主题: 'subject', 标题: 'subject',
  has: 'hasAttachment', 有: 'hasAttachment',
  is: 'unreadOnly', 状态: 'unreadOnly',
  before: 'before', 早于: 'before', 之前: 'before',
  after: 'after', since: 'after', 晚于: 'after', 之后: 'after',
  in: 'in', 在: 'in', 账户: 'in', 文件夹: 'in'
}

/** 本地搜索语法（与搜索框一致：from: to: subject: has: is: before: after: in:，中文别名同样认） */
export function parseMailQuery(input: string, now = new Date()): ParsedMailQuery {
  const src = String(input ?? '').replace(/：/g, ':').replace(/[“”]/g, '"')
  const out: ParsedMailQuery = { terms: [] }
  const re = /([^\s:"]+):("[^"]*"|\S*)|"[^"]*"|\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const key = m[1] ? SYNTAX_KEY[m[1].toLowerCase()] : undefined
    const val = m[1] ? (m[2] ?? '').replace(/^"|"$/g, '').trim() : ''
    if (key && !val) continue
    if (key) {
      const v = val.toLowerCase()
      if (key === 'hasAttachment') {
        if (/^(attachments?|attach|附件|file)$/.test(v)) out.hasAttachment = true
        continue
      }
      if (key === 'unreadOnly') {
        if (/^(unread|未读)$/.test(v)) out.unreadOnly = true
        else if (/^(flagged|starred|旗标|已加旗标|星标)$/.test(v)) out.flaggedOnly = true
        continue
      }
      if (key === 'before' || key === 'after') {
        const d = resolveDate(val, now)
        if (d) out[key] = d
        continue
      }
      ;(out as unknown as Record<string, string>)[key] = val
      continue
    }
    const term = m[0].replace(/^"|"$/g, '').trim()
    if (term) out.terms.push(term)
  }
  return out
}

// ---------------------------------------------------------------- 来源引用

/**
 * 回答的来源胶囊：去重 → 回答里提到的（id 或标签命中）排前 → 截断。
 * 都没命中时保留工具产出的前几个（「查过的东西」也是有用的来源）
 */
export function rankRefs(refs: AgentRef[], answer: string, cap = 8): AgentRef[] {
  const seen = new Set<string>()
  const uniq: AgentRef[] = []
  for (const r of refs) {
    const k = `${r.type}:${r.id}`
    if (!r.id || seen.has(k)) continue
    seen.add(k)
    uniq.push(r)
  }
  const text = String(answer ?? '')
  const hit = (r: AgentRef) => {
    if (text.includes(r.id)) return true
    const label = r.label.replace(/^(回复|转发|re|fwd?)\s*[:：]\s*/i, '').trim()
    if (label.length >= 4 && text.includes(label.slice(0, Math.min(label.length, 14)))) return true
    return false
  }
  const mentioned = uniq.filter(hit)
  if (mentioned.length) return mentioned.slice(0, cap)
  return uniq.slice(0, Math.min(cap, 6))
}

// ---------------------------------------------------------------- 文本

export function htmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 纯文本 → 最小 HTML：空行分段，段内换行转 <br> */
export function textToHtml(text: string): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** 会话标题：取首问的第一行，去掉技能前缀与标点，≤ 24 字 */
export function threadTitle(text: string): string {
  const line = String(text ?? '').split('\n').map(s => s.trim()).find(Boolean) ?? ''
  const t = line.replace(/^[/／]\S+\s*/, '').replace(/[。？?！!，,；;：:\s]+$/, '')
  const chars = [...t]
  return chars.length > 24 ? `${chars.slice(0, 24).join('')}…` : t || '新对话'
}
