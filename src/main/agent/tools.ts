/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto'
import type { Address, AgentDomain, AgentRef, AgentToolInfo, AgentToolRisk, ComposeDraft, FinanceData, MailInsight, MessageSummary, Rule, TodoData } from '@shared/types'
import { ATTACHMENT_CATEGORIES, attachmentCategoryLabel, type AttachmentCategory } from '@shared/attachments'
import { annualCost, effectiveStatus, FINANCE_CYCLE_LABEL, FINANCE_KIND_LABEL, FINANCE_STATUS_LABEL, itemAt, reconGroups, RECON_ISSUE_LABEL, sameParty, type FinanceItem } from '@shared/finance'
import { isRobotAddr } from '@shared/projects'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import type { AgentService } from '../ai/agent'
import type { UnderstandService } from '../ai/understand'
import type { FinanceService } from '../finance/service'
import type { ProjectService } from '../projects/service'
import type { AttachmentService } from '../attachments/service'
import { attachmentText } from '../attachments/text'
import { allowsAI, getAccess, requestAccessPrompt } from '../attachments/access'
import { slicePages } from '../attachments/text-parse'
import { searchTerms, rankByTerms } from '../search-terms'
import { notifyLocalChange as notifySyncChange } from '../todo-sync'
import { notifyLocalChange as notifyIntegrationChange } from '../todo-integrations'
import { htmlToText, parseMailQuery, parseWhen, resolveDate, textToHtml, ymd, type JsonSchema } from './protocol'
import { registerFollowup } from './hooks'
import { followupService } from '../followups'
import { lifeAgentTools } from '../life/agent-tools'
import { clampWaitDays, FOLLOWUP_KIND_LABEL, FOLLOWUP_STATUS_LABEL, isFollowupKind, waitedDays } from '@shared/followups'
import { ruleSuggestService } from '../rule-suggest'

/**
 * Agent 工具注册表：每个工具 = 名称 / 中文标题 / 说明 / JSON Schema 参数 / 风险 / 领域 / 执行函数。
 * 执行函数直接调用现有服务与数据层（邮件状态类写操作走 ipc.ts 已注册的处理器，与界面操作同一实现）。
 */

export interface ToolDeps {
  store: MailStore
  appStore: AppStore
  agent: AgentService
  understand: UnderstandService
  finance: FinanceService
  projects: ProjectService
  attachments(): AttachmentService | null
  /** 调用 ipc.ts 里已注册的处理器（markRead / moveMessages / updateTodo / sendMail …） */
  call(method: string, args: unknown[]): Promise<unknown>
  event(payload: unknown): void
  openCompose(prefill: Partial<ComposeDraft>): void
}

export interface ToolCtx {
  headless: boolean
  /** 当前邮件（从阅读页 / 右侧栏发起时） */
  messageId?: string | null
}

export interface ToolResult {
  /** 交给模型的结构化结果（会被序列化并截断） */
  data: unknown
  /** 一句话结果，界面显示，如「找到 12 封」 */
  summary: string
  refs?: AgentRef[]
}

export interface AgentTool extends AgentToolInfo {
  params: JsonSchema
  run(args: Record<string, any>, ctx: ToolCtx): Promise<ToolResult> | ToolResult
  /** 写操作确认卡上的「影响对象」 */
  preview?(args: Record<string, any>): string[]
}

/** 工具执行中可预期的错误（参数不对、对象不存在）：原样告诉模型，让它换路 */
export class ToolError extends Error {}

// ---------------------------------------------------------------- 小工具

const DAY = 864e5
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function fmtTime(ms: number | null | undefined): string | null {
  if (!ms) return null
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${sameYear ? '' : `${d.getFullYear()}-`}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${WEEKDAY[d.getDay()]}`
}

const fmtDay = (ms: number | null | undefined) => (ms ? `${ymd(new Date(ms))} ${WEEKDAY[new Date(ms).getDay()]}` : null)
const fmtAddr = (a: Address | null | undefined) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '')
const subj = (s: string | null | undefined) => (s || '').trim() || '（无主题）'
const mailRef = (id: string, subject: string): AgentRef => ({ type: 'mail', id, label: subj(subject) })
const money = (n: number | null | undefined, cur = 'CNY') => (n == null ? '金额未知' : `${cur === 'CNY' ? '¥' : `${cur} `}${Math.round(n * 100) / 100}`)
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : [])

function sumByCur(list: { amount: number | null | undefined; currency: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const x of list) if (x.amount != null) out[x.currency || 'CNY'] = Math.round(((out[x.currency || 'CNY'] ?? 0) + x.amount) * 100) / 100
  return out
}
const fmtSums = (o: Record<string, number>) => Object.entries(o).map(([c, n]) => money(n, c)).join(' + ') || '¥0'

const LIMIT = (def: number, max: number): JsonSchema => ({ type: 'integer', minimum: 1, maximum: max, default: def, description: `最多返回几条（默认 ${def}，最多 ${max}）` })
const IDS = (desc: string): JsonSchema => ({ type: 'array', items: { type: 'string' }, description: desc })
const REASON: JsonSchema = { type: 'string', description: '一句话说明为什么要这样做（会展示给用户确认）' }
/** 起草时一并登记跟进（draft_reply / save_draft 的可选参数） */
const FOLLOWUP_ARG: JsonSchema = {
  type: 'object',
  description: '可选：这封是在等对方做事的邮件（催开票 / 催回复 / 要资料 / 退订…）时带上，发出后 waitDays 天对方没回会提醒用户并起草下一封催促',
  properties: {
    kind: { type: 'string', enum: ['reply', 'invoice', 'payment', 'document', 'unsubscribe', 'general'], description: 'reply 等回复；invoice 等开票；payment 等付款；document 等资料；unsubscribe 等退订确认' },
    ask: { type: 'string', description: '一句话：在等对方做什么（如「对方开 10 月服务费发票」）' },
    waitDays: { type: 'integer', minimum: 1, maximum: 60, default: 3, description: '发出后几天没回算逾期' }
  }
}
const followupLine = (f: any) => (f && typeof f === 'object' ? [`发出后 ${clampWaitDays(f.waitDays)} 天未回会提醒你${f.ask ? `（在等：${String(f.ask).slice(0, 40)}）` : ''}`] : [])

// ---------------------------------------------------------------- 注册表

export function buildTools(deps: ToolDeps): AgentTool[] {
  const { store } = deps

  const myAddrs = () => {
    const set = new Set<string>()
    for (const a of store.listAccounts()) {
      if (a.email) set.add(a.email.toLowerCase())
      if (a.user?.includes('@')) set.add(a.user.toLowerCase())
    }
    return set
  }

  const accountOf = (q: string | undefined) => {
    if (!q) return null
    const v = q.trim().toLowerCase()
    const list = store.listAccounts()
    const acc = list.find(a => a.email.toLowerCase() === v || a.name.toLowerCase() === v) ?? list.find(a => a.email.toLowerCase().includes(v) || a.name.toLowerCase().includes(v))
    if (!acc) throw new ToolError(`找不到账户「${q}」，可用账户：${list.map(a => `${a.name}（${a.email}）`).join('、') || '无'}`)
    return acc
  }

  const insightsOf = (list: string[]): Record<string, MailInsight> => {
    try {
      return list.length ? deps.understand.getInsights(list) : {}
    } catch {
      return store.getMailAi(list)
    }
  }

  const brief = (m: MessageSummary, ins?: MailInsight) => ({
    id: m.id,
    date: fmtTime(m.date),
    from: fmtAddr(m.from),
    to: m.to.slice(0, 3).map(fmtAddr).join(', '),
    subject: subj(m.subject),
    ...(ins?.gist ? { gist: ins.gist } : { snippet: (m.snippet || '').slice(0, 120) }),
    ...(m.unread ? { unread: true } : {}),
    ...(m.flagged ? { flagged: true } : {}),
    ...(m.answered ? { replied: true } : {}),
    ...(m.hasAttachments ? { attachments: true } : {}),
    ...(m.folderPath !== 'INBOX' ? { folder: m.folderPath } : {}),
    ...(ins ? { section: ins.section } : {})
  })

  const requireMessages = (list: string[]) => {
    if (!list.length) throw new ToolError('没有给出邮件 id')
    const rows = list.map(id => ({ id, row: store.getMessageRow(id) }))
    const missing = rows.filter(r => !r.row).map(r => r.id)
    if (missing.length) throw new ToolError(`找不到这些邮件（可能已被移走，或 id 不对）：${missing.slice(0, 5).join('、')}`)
    return rows.map(r => r.row)
  }
  const subjectsOf = (list: string[]) =>
    list.slice(0, 50).map(id => {
      const r = store.getMessageRow(id)
      return r ? `《${subj(r.subject)}》${r.from_name || r.from_addr ? ` · ${r.from_name || r.from_addr}` : ''}` : `（找不到 ${id}）`
    })

  const folderIdsFor = (spec: string | undefined): { folderIds?: string[]; allFolders?: boolean } => {
    const folders = store.listFolders()
    const v = (spec ?? '').trim().toLowerCase()
    if (!v || v === 'all' || v === '全部') return { folderIds: folders.filter(f => f.special !== 'trash' && f.special !== 'junk').map(f => f.id) }
    if (v === 'inbox' || v === '收件箱') return {}
    const special = ({ sent: 'sent', 已发送: 'sent', archive: 'archive', 归档: 'archive', trash: 'trash', 废纸篓: 'trash', drafts: 'drafts', 草稿: 'drafts', junk: 'junk', 垃圾邮件: 'junk' } as Record<string, string>)[v]
    const hit = folders.filter(f => (special ? f.special === special : f.id === spec || f.name.toLowerCase() === v || f.path.toLowerCase() === v))
    if (!hit.length) throw new ToolError(`找不到文件夹「${spec}」；可以先用 list_folders 查看`)
    return { folderIds: hit.map(f => f.id) }
  }

  const todoRows = () => store.listTodosForSync().filter(t => t.status !== 'dismissed')
  const todoBrief = (t: { id: string; title: string; status: string; dueAt: number | null; messageId: string | null; data: Record<string, unknown> }) => {
    const d = t.data as TodoData
    return {
      id: t.id,
      title: t.title,
      status: t.status === 'done' ? 'done' : 'open',
      ...(t.dueAt ? { due: fmtTime(t.dueAt) } : {}),
      ...(d.fixedAt ? { at: fmtTime(d.fixedAt) } : {}),
      ...(d.project ? { project: d.project } : {}),
      ...(d.context ? { context: d.context } : {}),
      ...(d.priority ? { priority: d.priority } : {}),
      ...(d.notes ? { notes: String(d.notes).slice(0, 120) } : {}),
      ...(t.messageId ? { message_id: t.messageId } : {}),
      ...(d.from ? { from: d.from } : {})
    }
  }
  const todosChanged = (id?: string) => {
    deps.event({ type: 'todos-changed' })
    notifySyncChange(id)
    notifyIntegrationChange()
  }

  const financeItems = (): (FinanceItem & { title: string; status: string })[] =>
    deps.finance.rows(false).map(r => ({ id: r.id, title: r.title, status: r.status, dueAt: r.dueAt, createdAt: r.createdAt, accountId: r.accountId, data: r.data }))
  const financeBrief = (r: FinanceItem & { title?: string }, now = Date.now()) => {
    const d = r.data
    const st = effectiveStatus(d, r.dueAt, now)
    return {
      id: r.id,
      title: r.title,
      kind: FINANCE_KIND_LABEL[d.kind] ?? d.kind,
      direction: d.direction === 'in' ? '收入' : '支出',
      counterparty: d.counterparty,
      amount: money(d.amount, d.currency),
      status: FINANCE_STATUS_LABEL[st] ?? st,
      ...(r.dueAt ? { due: fmtDay(r.dueAt) } : {}),
      ...(d.paidAt ? { paid_at: fmtDay(d.paidAt) } : {}),
      ...(d.category ? { category: d.category } : {}),
      ...(d.cycle ? { cycle: FINANCE_CYCLE_LABEL[d.cycle] } : {}),
      ...(d.invoiceNo ? { invoice_no: d.invoiceNo } : {}),
      ...(d.orderNo ? { order_no: d.orderNo } : {}),
      ...(d.tracking ? { tracking: d.tracking } : {}),
      date: fmtDay(itemAt(r)),
      ...(d.messageIds?.[0] ? { message_id: d.messageIds[0] } : {})
    }
  }
  const finRef = (r: { id: string; title?: string; data: FinanceData }): AgentRef => ({ type: 'finance', id: r.id, label: `${r.title || r.data.counterparty} ${money(r.data.amount, r.data.currency)}` })

  const projectByIdOrName = (v: string) => {
    const list = deps.projects.list()
    const key = v.trim().toLowerCase()
    const p = list.find(x => x.id === v) ?? list.find(x => x.data.name.toLowerCase() === key) ?? list.find(x => x.data.name.toLowerCase().includes(key))
    if (!p) throw new ToolError(`找不到项目「${v}」；可以先用 list_projects 查看`)
    return p
  }

  const svc = () => {
    const s = deps.attachments()
    if (!s) throw new ToolError('附件中心尚未就绪')
    return s
  }

  const tools: AgentTool[] = [
    // ======================================================== 邮件 · 只读
    {
      name: 'search_mail',
      title: '搜索邮件',
      domain: 'mail',
      risk: 'read',
      description:
        '搜索用户的邮件（默认搜除废纸篓 / 垃圾邮件外的全部文件夹）。query 支持关键词和本地搜索语法：from: to: subject: has:附件 is:未读 is:旗标 before:2026-10-01 after:上周一；也可以直接用结构化参数。返回 id、时间、发件人、主题、要点。',
      params: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词或搜索语法，如「云桥 合同」「from:billing@ after:2026-09-01」' },
          sender: { type: 'string', description: '发件人名称或地址片段' },
          to: { type: 'string', description: '收件人 / 抄送地址片段' },
          subject: { type: 'string', description: '主题包含' },
          after: { type: 'string', description: '起始日期（YYYY-MM-DD 或「上周一」「3天前」等）' },
          before: { type: 'string', description: '截止日期（含当天）' },
          within_days: { type: 'integer', minimum: 1, maximum: 3650, description: '最近 N 天' },
          unread_only: { type: 'boolean' },
          flagged_only: { type: 'boolean' },
          has_attachment: { type: 'boolean' },
          account: { type: 'string', description: '账户名或邮箱' },
          folder: { type: 'string', description: 'all（默认）/ inbox / sent / archive / 具体文件夹名' },
          category: { type: 'string', enum: ['personal', 'notification', 'newsletter', 'noise'], description: '分类' },
          limit: LIMIT(15, 50)
        }
      },
      run(a) {
        const parsed = parseMailQuery(a.query ?? '')
        const acc = accountOf(a.account)
        let folder = a.folder as string | undefined
        let accountId = acc?.id ?? null
        if (parsed.in && !folder && !accountId) {
          try {
            accountId = accountOf(parsed.in)?.id ?? null
          } catch {
            folder = parsed.in
          }
        }
        const scope = folderIdsFor(folder)
        const q = {
          terms: parsed.terms,
          sender: a.sender ?? parsed.sender,
          to: a.to ?? parsed.to,
          subject: a.subject ?? parsed.subject,
          after: a.after ? resolveDate(a.after) ?? a.after : parsed.after,
          before: a.before ? resolveDate(a.before) ?? a.before : parsed.before,
          withinDays: a.within_days ?? null,
          unreadOnly: a.unread_only ?? parsed.unreadOnly ?? null,
          flaggedOnly: a.flagged_only ?? parsed.flaggedOnly ?? null,
          hasAttachment: a.has_attachment ?? parsed.hasAttachment ?? null,
          category: a.category ?? null,
          accountId,
          ...scope,
          limit: a.limit
        }
        const hasFilter = !!(q.terms.length || q.sender || q.to || q.subject || q.after || q.before || q.withinDays || q.unreadOnly || q.flaggedOnly || q.hasAttachment || q.category || q.accountId)
        if (!hasFilter) throw new ToolError('请给出关键词或至少一个过滤条件；想看最近的邮件请用 list_recent')
        let page = store.runNLQuery(q)
        let note: string | undefined
        // 中文问句整段 AND 检索常为空：拆成检索词按命中数排序再试一次
        if (!page.total && parsed.terms.length) {
          const loose = searchTerms(parsed.terms.join(' '))
          if (loose.length) {
            const hits = store.searchByTerms(loose, 200)
            const { terms: _t, ...rest } = q
            const allowed = new Set(store.runNLQuery({ ...rest, limit: 500 }).items.map(m => m.id))
            const filtered = hits.filter(m => allowed.has(m.id) || !(rest.sender || rest.to || rest.subject || rest.after || rest.before || rest.withinDays || rest.unreadOnly || rest.flaggedOnly || rest.hasAttachment || rest.category || rest.accountId))
            page = { items: filtered.slice(0, a.limit), total: filtered.length }
            note = '整句没有命中，以下按检索词拆分后的模糊匹配'
          }
        }
        const ins = store.getMailAi(page.items.map(m => m.id))
        return {
          data: { total: page.total, count: page.items.length, ...(note ? { note } : {}), messages: page.items.map(m => brief(m, ins[m.id])) },
          summary: page.total ? (page.total > page.items.length ? `找到 ${page.total} 封，看了最新 ${page.items.length} 封` : `找到 ${page.total} 封`) : '没有找到',
          refs: page.items.map(m => mailRef(m.id, m.subject))
        }
      }
    },
    {
      name: 'read_message',
      title: '读邮件',
      domain: 'mail',
      risk: 'read',
      description: '读取一封邮件的完整内容：收发件人、时间、正文（默认截取 4000 字）、附件列表，以及 LinkTo 对它的理解（要点 / 实体 / 建议动作）。',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '邮件 id（来自搜索结果；「这封邮件」用上下文里的当前邮件 id）' },
          max_chars: { type: 'integer', minimum: 500, maximum: 12000, default: 4000 }
        },
        required: ['id']
      },
      async run(a) {
        let m = store.getMessageFull(a.id)
        if (!m) throw new ToolError(`找不到邮件 ${a.id}`)
        if (!m.text && !m.html) m = ((await deps.call('getMessage', [a.id]).catch(() => null)) as typeof m) ?? m
        const body = (m!.text?.trim() || (m!.html ? htmlToText(m!.html) : '') || m!.snippet || '').replace(/\n{3,}/g, '\n\n')
        const ins = insightsOf([a.id])[a.id]
        return {
          data: {
            id: m!.id,
            subject: subj(m!.subject),
            from: fmtAddr(m!.from),
            to: m!.to.map(fmtAddr),
            cc: m!.cc.map(fmtAddr),
            date: fmtTime(m!.date),
            folder: m!.folderPath,
            unread: m!.unread,
            replied: m!.answered,
            attachments: m!.attachments.filter(x => !x.inline).map(x => ({ id: x.id, filename: x.filename, size: x.size })),
            ...(ins ? { understanding: { section: ins.section, gist: ins.gist, entities: ins.entities.map(e => `${e.kind}:${e.label}`), next: ins.next.map(n => n.label) } } : {}),
            body: body.length > a.max_chars ? `${body.slice(0, a.max_chars)}\n…（正文共 ${body.length} 字，已截断）` : body
          },
          summary: `《${subj(m!.subject)}》`,
          refs: [mailRef(m!.id, m!.subject)]
        }
      }
    },
    {
      name: 'read_thread',
      title: '读会话',
      domain: 'mail',
      risk: 'read',
      description: '读取一封邮件所在的整个会话（来回往来，按时间先后，每封正文截取 1500 字），用来弄清一件事的来龙去脉。',
      params: { type: 'object', properties: { id: { type: 'string', description: '会话中任意一封邮件的 id' }, limit: LIMIT(12, 30) }, required: ['id'] },
      run(a) {
        const row = store.getMessageRow(a.id)
        if (!row) throw new ToolError(`找不到邮件 ${a.id}`)
        const rows = store.db
          .prepare(`SELECT id, subject, from_name, from_addr, to_json, date, text, html, snippet, folder_path FROM messages WHERE thread_id = ? AND account_id = ? ORDER BY date ASC`)
          .all(row.thread_id, row.account_id) as any[]
        const mine = myAddrs()
        const list = rows.slice(-a.limit)
        let budget = 9000
        const msgs = list.map(r => {
          const text = String(r.text || (r.html ? htmlToText(r.html) : '') || r.snippet || '').replace(/\n{3,}/g, '\n\n')
          const take = Math.max(200, Math.min(1500, budget))
          budget -= Math.min(text.length, take)
          return {
            id: r.id,
            date: fmtTime(r.date),
            from: r.from_name ? `${r.from_name} <${r.from_addr}>` : r.from_addr,
            by: mine.has(String(r.from_addr ?? '').toLowerCase()) ? '我' : '对方',
            subject: subj(r.subject),
            body: text.length > take ? `${text.slice(0, take)}…` : text
          }
        })
        return {
          data: { count: rows.length, shown: msgs.length, messages: msgs },
          summary: `${rows.length} 封往来`,
          refs: [mailRef(row.id, row.subject)]
        }
      }
    },
    {
      name: 'list_recent',
      title: '最近邮件',
      domain: 'mail',
      risk: 'read',
      description:
        '列出收件箱最近的邮件，可按 LinkTo 的分区过滤：act=需要你处理，wait=等待对方 / 进行中，fyi=知悉即可，bundle=订阅与通知；也可只看未读或某个账户。适合「今天有什么要处理的」「最近有哪些未读」。',
      params: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: ['all', 'act', 'wait', 'fyi', 'bundle'], default: 'all' },
          unread_only: { type: 'boolean' },
          account: { type: 'string', description: '账户名或邮箱' },
          within_days: { type: 'integer', minimum: 1, maximum: 60, default: 7 },
          limit: LIMIT(20, 50)
        }
      },
      run(a) {
        const acc = accountOf(a.account)
        const since = Date.now() - a.within_days * DAY
        const now = Date.now()
        const rows = store.db
          .prepare(
            `SELECT id FROM messages m WHERE m.folder_path = 'INBOX' AND m.date >= ? AND (m.snoozed_until IS NULL OR m.snoozed_until <= ?)
             ${acc ? 'AND m.account_id = ?' : ''} ${a.unread_only ? "AND m.flags NOT LIKE '%\\Seen%'" : ''} ORDER BY m.date DESC LIMIT 400`
          )
          .all(...([since, now, ...(acc ? [acc.id] : [])] as (string | number)[])) as { id: string }[]
        const ins = insightsOf(rows.map(r => r.id))
        let list = rows.map(r => r.id).filter(id => a.section === 'all' || ins[id]?.section === a.section)
        if (a.section === 'act') list = list.sort((x, y) => (ins[y]?.urgency ?? 0) - (ins[x]?.urgency ?? 0))
        const total = list.length
        const items = list.slice(0, a.limit).map(id => store.getMessageFull(id)).filter((m): m is NonNullable<typeof m> => !!m)
        const label = { all: '', act: '「需要你处理」', wait: '「等待中」', fyi: '「知悉即可」', bundle: '「订阅与通知」' }[a.section as string] ?? ''
        return {
          data: { total, count: items.length, messages: items.map(m => ({ ...brief(m, ins[m.id]), ...(ins[m.id]?.urgency ? { urgency: ins[m.id].urgency } : {}) })) },
          summary: `最近 ${a.within_days} 天${label}${a.unread_only ? '未读' : ''} ${total} 封`,
          refs: items.map(m => mailRef(m.id, m.subject))
        }
      }
    },
    {
      name: 'mail_understanding',
      title: '邮件理解',
      domain: 'mail',
      risk: 'read',
      description: '读取 LinkTo 对一批邮件的理解结果：分区、一句话要点、实体（时间 / 截止 / 金额 / 验证码 / 单号）、建议的下一步、快速回复草稿。比逐封读正文快。',
      params: { type: 'object', properties: { ids: IDS('邮件 id 列表（最多 20 个）') }, required: ['ids'] },
      run(a) {
        const list = ids(a.ids).slice(0, 20)
        const ins = insightsOf(list)
        const out = list.map(id => {
          const i = ins[id]
          const row = store.getMessageRow(id)
          if (!row) return { id, error: '找不到这封邮件' }
          if (!i) return { id, subject: subj(row.subject), error: '还没有理解结果' }
          return {
            id,
            subject: subj(row.subject),
            section: i.section,
            ...(i.bundle ? { bundle: i.bundle } : {}),
            gist: i.gist,
            urgency: i.urgency,
            entities: i.entities.map(e => ({ kind: e.kind, label: e.label, value: e.value })),
            next: i.next.map(n => ({ kind: n.kind, label: n.label, ...(n.due ? { due: n.due } : {}), ...(n.until ? { until: n.until } : {}) })),
            ...(i.quickReply ? { quick_reply: i.quickReply.slice(0, 300) } : {}),
            source: i.source
          }
        })
        return { data: out, summary: `${out.length} 封`, refs: list.map(id => mailRef(id, store.getMessageRow(id)?.subject ?? '')).filter(r => store.getMessageRow(r.id)) }
      }
    },
    {
      name: 'find_waiting',
      title: '待跟进',
      domain: 'mail',
      risk: 'read',
      description: '找出需要跟进的往来：direction=them —— 我发出后对方一直没回；direction=me —— 对方在等我回复（需要回复且我还没回）。',
      params: {
        type: 'object',
        properties: { direction: { type: 'string', enum: ['them', 'me'], default: 'them' }, within_days: { type: 'integer', minimum: 1, maximum: 180, default: 30 }, limit: LIMIT(15, 40) }
      },
      run(a) {
        const since = Date.now() - a.within_days * DAY
        if (a.direction === 'them') {
          const page = store.getMessages({ scope: 'followup', limit: 300, offset: 0 })
          const items = page.items.filter(m => m.date >= since)
          return {
            data: { count: items.length, messages: items.slice(0, a.limit).map(m => ({ ...brief(m), waiting_days: Math.floor((Date.now() - m.date) / DAY) })) },
            summary: items.length ? `${items.length} 封发出后没回音` : '没有在等对方回复的邮件',
            refs: items.slice(0, a.limit).map(m => mailRef(m.id, m.subject))
          }
        }
        const mine = [...myAddrs()]
        const rows = store.db
          .prepare(
            `SELECT m.id FROM messages m WHERE m.folder_path = 'INBOX' AND m.date >= ? AND m.flags NOT LIKE '%Answered%'
               AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.thread_id = m.thread_id AND r.account_id = m.account_id AND r.date > m.date
                 AND lower(COALESCE(r.from_addr,'')) IN (${mine.map(() => '?').join(',') || "''"}))
             ORDER BY m.date DESC LIMIT 300`
          )
          .all(since, ...mine) as { id: string }[]
        const ins = insightsOf(rows.map(r => r.id))
        const list = rows
          .map(r => r.id)
          .filter(id => ins[id] && ins[id].section === 'act' && (ins[id].next.some(n => n.kind === 'reply') || !!ins[id].quickReply))
          .sort((x, y) => (ins[y]?.urgency ?? 0) - (ins[x]?.urgency ?? 0))
        const items = list.slice(0, a.limit).map(id => store.getMessageFull(id)).filter((m): m is NonNullable<typeof m> => !!m)
        return {
          data: { count: list.length, messages: items.map(m => ({ ...brief(m, ins[m.id]), waiting_days: Math.floor((Date.now() - m.date) / DAY) })) },
          summary: list.length ? `${list.length} 封在等你回复` : '没有在等你回复的邮件',
          refs: items.map(m => mailRef(m.id, m.subject))
        }
      }
    },
    {
      name: 'list_folders',
      title: '文件夹列表',
      domain: 'mail',
      risk: 'read',
      description: '列出各账户的邮件文件夹（id、名称、类型、未读数），移动邮件前用它确认目标文件夹。',
      params: { type: 'object', properties: { account: { type: 'string', description: '只看这个账户（名称或邮箱）' } } },
      run(a) {
        const acc = accountOf(a.account)
        const accounts = new Map(store.listAccounts().map(x => [x.id, x.email]))
        const list = store.listFolders().filter(f => !f.hidden && (!acc || f.accountId === acc.id))
        return {
          data: list.map(f => ({ id: f.id, account: accounts.get(f.accountId), name: f.name, path: f.path, ...(f.special ? { special: f.special } : {}), unread: f.unread, total: f.total })),
          summary: `${list.length} 个文件夹`
        }
      }
    },

    // ======================================================== 邮件 · 写
    {
      name: 'archive_mail',
      title: '归档邮件',
      domain: 'mail',
      risk: 'write',
      description: '把邮件移到归档（可在归档文件夹找回）。',
      params: { type: 'object', properties: { ids: IDS('邮件 id 列表'), reason: REASON }, required: ['ids'] },
      preview: a => subjectsOf(ids(a.ids)),
      async run(a) {
        const list = ids(a.ids).slice(0, 100)
        const rows = requireMessages(list)
        await deps.call('moveMessages', [list, 'archive'])
        deps.event({ type: 'messages-changed' })
        return { data: { ok: true, archived: list.length }, summary: `已归档 ${list.length} 封`, refs: rows.map(r => mailRef(r.id, r.subject)) }
      }
    },
    {
      name: 'trash_mail',
      title: '删除邮件',
      domain: 'mail',
      risk: 'write',
      description: '把邮件移到废纸篓（可恢复，不会永久删除）。',
      params: { type: 'object', properties: { ids: IDS('邮件 id 列表'), reason: REASON }, required: ['ids'] },
      preview: a => subjectsOf(ids(a.ids)),
      async run(a) {
        const list = ids(a.ids).slice(0, 100)
        requireMessages(list)
        await deps.call('moveMessages', [list, 'trash'])
        deps.event({ type: 'messages-changed' })
        return { data: { ok: true, trashed: list.length }, summary: `已移到废纸篓 ${list.length} 封` }
      }
    },
    {
      name: 'mark_read',
      title: '标为已读',
      domain: 'mail',
      risk: 'write',
      description: '把邮件标为已读。',
      params: { type: 'object', properties: { ids: IDS('邮件 id 列表'), reason: REASON }, required: ['ids'] },
      preview: a => subjectsOf(ids(a.ids)),
      async run(a) {
        const list = ids(a.ids).slice(0, 200)
        requireMessages(list)
        await deps.call('markRead', [list, true])
        deps.event({ type: 'messages-changed' })
        return { data: { ok: true, count: list.length }, summary: `已标为已读 ${list.length} 封` }
      }
    },
    {
      name: 'mark_unread',
      title: '标为未读',
      domain: 'mail',
      risk: 'write',
      description: '把邮件标为未读（留着稍后看）。',
      params: { type: 'object', properties: { ids: IDS('邮件 id 列表'), reason: REASON }, required: ['ids'] },
      preview: a => subjectsOf(ids(a.ids)),
      async run(a) {
        const list = ids(a.ids).slice(0, 200)
        requireMessages(list)
        await deps.call('markRead', [list, false])
        deps.event({ type: 'messages-changed' })
        return { data: { ok: true, count: list.length }, summary: `已标为未读 ${list.length} 封` }
      }
    },
    {
      name: 'flag_mail',
      title: '加旗标',
      domain: 'mail',
      risk: 'write',
      description: '给邮件加旗标（flagged=false 则取消旗标）。',
      params: { type: 'object', properties: { ids: IDS('邮件 id 列表'), flagged: { type: 'boolean', default: true }, reason: REASON }, required: ['ids'] },
      preview: a => subjectsOf(ids(a.ids)),
      async run(a) {
        const list = ids(a.ids).slice(0, 200)
        const rows = requireMessages(list)
        await deps.call('markFlagged', [list, a.flagged !== false])
        deps.event({ type: 'messages-changed' })
        return { data: { ok: true, count: list.length }, summary: a.flagged === false ? `已取消旗标 ${list.length} 封` : `已加旗标 ${list.length} 封`, refs: rows.map(r => mailRef(r.id, r.subject)) }
      }
    },
    {
      name: 'snooze_mail',
      title: '稍后处理',
      domain: 'mail',
      risk: 'write',
      description: '把邮件暂时移出收件箱，到指定时间再回来。until 用「YYYY-MM-DD HH:mm」，也可以写「明天 09:00」「下周一」。',
      params: { type: 'object', properties: { ids: IDS('邮件 id 列表'), until: { type: 'string', description: '回到收件箱的时间' }, reason: REASON }, required: ['ids', 'until'] },
      preview: a => [...subjectsOf(ids(a.ids)), `回来时间：${a.until}`],
      async run(a) {
        const list = ids(a.ids).slice(0, 100)
        requireMessages(list)
        const until = parseWhen(a.until)
        if (!until || until <= Date.now()) throw new ToolError(`时间「${a.until}」无效或已经过去，请给一个将来的时间（YYYY-MM-DD HH:mm）`)
        await deps.call('snoozeMessages', [list, until])
        return { data: { ok: true, count: list.length, until: fmtTime(until) }, summary: `已稍后 ${list.length} 封，${fmtTime(until)} 回来` }
      }
    },
    {
      name: 'move_to_folder',
      title: '移到文件夹',
      domain: 'mail',
      risk: 'write',
      description: '把邮件移到指定文件夹（只能在同一账户内移动）。folder 可以是文件夹 id 或名称。',
      params: { type: 'object', properties: { ids: IDS('邮件 id 列表'), folder: { type: 'string', description: '目标文件夹 id 或名称' }, reason: REASON }, required: ['ids', 'folder'] },
      preview: a => [...subjectsOf(ids(a.ids)), `移到：${a.folder}`],
      async run(a) {
        const list = ids(a.ids).slice(0, 100)
        const rows = requireMessages(list)
        const v = String(a.folder).trim().toLowerCase()
        const accountId = rows[0].account_id
        const folder = store.listFolders().find(f => f.accountId === accountId && (f.id === a.folder || f.name.toLowerCase() === v || f.path.toLowerCase() === v))
        if (!folder) throw new ToolError(`这个账户里没有文件夹「${a.folder}」；先用 list_folders 看看有哪些`)
        const res = (await deps.call('moveToFolder', [list, folder.id])) as { ok: number; failed: number }
        return { data: res, summary: res.failed ? `移动 ${res.ok} 封，失败 ${res.failed} 封` : `已移到「${folder.name}」${res.ok} 封` }
      }
    },
    {
      name: 'create_rule',
      title: '新建规则',
      domain: 'mail',
      risk: 'write',
      description:
        '新建一条收信规则，以后到达的邮件自动处理。conditions 每项 {field: from|to|subject|listId|hasAttachment|isNewsletter, op: contains|equals|startsWith|endsWith|regex|is, value}；actions 每项 {type: markRead|flag|setCategory|archive|moveTrash|markNewsletter|saveToKb|pin|snooze|createTodo|moveFolder, value?}。条件之间是「且」。',
      params: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '规则名' },
          conditions: { type: 'array', items: { type: 'object' }, description: '条件列表' },
          actions: { type: 'array', items: { type: 'object' }, description: '动作列表' },
          reason: REASON
        },
        required: ['name', 'conditions', 'actions']
      },
      preview: a => [
        `规则：${a.name}`,
        ...(a.conditions ?? []).map((c: any) => `当 ${c.field} ${c.op} ${c.value ?? ''}`),
        ...(a.actions ?? []).map((x: any) => `执行 ${x.type}${x.value ? `（${x.value}）` : ''}`)
      ],
      async run(a) {
        const FIELDS = ['from', 'to', 'subject', 'listId', 'hasAttachment', 'isNewsletter']
        const OPS = ['contains', 'equals', 'startsWith', 'endsWith', 'regex', 'is']
        const ACTIONS = ['markRead', 'flag', 'unflag', 'setCategory', 'archive', 'moveTrash', 'markNewsletter', 'saveToKb', 'pin', 'snooze', 'createTodo', 'moveFolder']
        const conditions = (a.conditions as any[]).map(c => ({ field: String(c?.field ?? ''), op: String(c?.op ?? 'contains'), value: String(c?.value ?? '') }))
        const actions = (a.actions as any[]).map(x => ({ type: String(x?.type ?? ''), ...(x?.value != null ? { value: String(x.value) } : {}) }))
        const badC = conditions.find(c => !FIELDS.includes(c.field) || !OPS.includes(c.op))
        if (badC) throw new ToolError(`条件无效：${JSON.stringify(badC)}；field 只能是 ${FIELDS.join('/')}，op 只能是 ${OPS.join('/')}`)
        const badA = actions.find(x => !ACTIONS.includes(x.type))
        if (badA) throw new ToolError(`动作无效：${badA.type}；只能是 ${ACTIONS.join('/')}`)
        if (!conditions.length || !actions.length) throw new ToolError('规则至少要有一个条件和一个动作')
        const order = Math.max(-1, ...store.listRules().map(r => r.order)) + 1
        const rule: Rule = { id: `rule-${randomUUID()}`, name: String(a.name).slice(0, 60), enabled: true, order, conditions: conditions as Rule['conditions'], actions: actions as Rule['actions'] }
        await deps.call('saveRule', [rule])
        return { data: { ok: true, id: rule.id }, summary: `已新建规则「${rule.name}」` }
      }
    },
    {
      name: 'draft_reply',
      title: '起草回复',
      domain: 'mail',
      risk: 'write',
      description: '为一封邮件起草回复：打开撰写窗并填好收件人、主题和正文，由用户检查后自己发送（不会自动发送；后台运行时存为本地草稿）。body 是完整的纯文本正文。',
      params: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: '要回复的邮件 id' },
          body: { type: 'string', description: '回复正文（纯文本，段落之间空一行）' },
          reply_all: { type: 'boolean', default: false },
          followup: FOLLOWUP_ARG,
          reason: REASON
        },
        required: ['message_id', 'body']
      },
      preview: a => [...subjectsOf([a.message_id]).map(s => `回复 ${s}`), String(a.body ?? '').slice(0, 400), ...followupLine(a.followup)],
      run(a, ctx) {
        const m = store.getMessageFull(a.message_id)
        if (!m) throw new ToolError(`找不到邮件 ${a.message_id}`)
        const mine = myAddrs()
        const to = [m.replyTo ?? m.from].filter((x): x is Address => !!x && !mine.has(x.address.toLowerCase()))
        const cc = a.reply_all ? [...m.to, ...m.cc].filter(x => !mine.has(x.address.toLowerCase()) && !to.some(t => t.address === x.address)) : []
        const subject = /^(回复|re)\s*[:：]/i.test(m.subject) ? m.subject : `回复：${m.subject}`
        const html = textToHtml(a.body)
        const draftId = randomUUID()
        const fu = a.followup && typeof a.followup === 'object' ? a.followup : null
        // 起草即登记跟进（drafted）：用户在撰写窗发出后才开始计时
        const followupId = fu
          ? registerFollowup({ kind: isFollowupKind(fu.kind) ? fu.kind : 'reply', ask: String(fu.ask ?? ''), to: to.map(x => x.address), subject, relatedMessageId: m.id, draftId, waitDays: clampWaitDays(fu.waitDays), source: ctx.headless ? 'skill' : 'agent' })
          : null
        const fuNote = followupId ? `；已登记跟进，发出后 ${clampWaitDays(fu.waitDays)} 天未回会提醒` : ''
        const fuRefs: AgentRef[] = followupId ? [{ type: 'followup', id: followupId, label: subj(subject) }] : []
        if (ctx.headless) {
          store.saveDraft({ id: draftId, accountId: m.accountId, to, cc, bcc: [], subject, html, updatedAt: Date.now() })
          deps.event({ type: 'outbox-changed' })
          return { data: { ok: true, draft_id: draftId, ...(followupId ? { followup_id: followupId } : {}), note: `已存为本地草稿，未发送${fuNote}` }, summary: `已存草稿（未发送）${followupId ? ' · 已登记跟进' : ''}`, refs: [mailRef(m.id, m.subject), ...fuRefs] }
        }
        deps.openCompose({
          id: draftId,
          accountId: m.accountId,
          relatedMessageId: m.id,
          inReplyToMessageId: m.messageId ?? undefined,
          to,
          cc,
          subject,
          html,
          ...(followupId ? { followup: { id: followupId, enabled: true, kind: isFollowupKind(fu.kind) ? fu.kind : 'reply', ask: String(fu.ask ?? ''), waitDays: clampWaitDays(fu.waitDays) } } : {})
        })
        return { data: { ok: true, ...(followupId ? { followup_id: followupId } : {}), note: `已打开撰写窗，等待用户检查后发送；没有自动发送${fuNote}` }, summary: `已打开撰写窗（未发送）${followupId ? ' · 已登记跟进' : ''}`, refs: [mailRef(m.id, m.subject), ...fuRefs] }
      }
    },
    {
      name: 'save_draft',
      title: '存草稿',
      domain: 'mail',
      risk: 'write',
      description: '写一封新邮件并存为本地草稿（不会发送，用户在草稿里检查后自己发送）。',
      params: {
        type: 'object',
        properties: {
          to: IDS('收件人，"a@b.com" 或 "名字 <a@b.com>"'),
          cc: IDS('抄送'),
          subject: { type: 'string' },
          body: { type: 'string', description: '纯文本正文' },
          account: { type: 'string', description: '发件账户（名称或邮箱，默认第一个账户）' },
          reply_to_message_id: { type: 'string', description: '若是回复，原邮件 id' },
          followup: FOLLOWUP_ARG,
          reason: REASON
        },
        required: ['to', 'subject', 'body']
      },
      preview: a => [`收件人：${ids(a.to).join('、')}`, `主题：${a.subject}`, String(a.body ?? '').slice(0, 400), ...followupLine(a.followup)],
      run(a, ctx) {
        const parse = (list: string[]) =>
          list.map(raw => {
            const s = raw.trim()
            const m = s.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/)
            if (m) return m[1].replace(/^"|"$/g, '').trim() ? { name: m[1].replace(/^"|"$/g, '').trim(), address: m[2] } : { address: m[2] }
            if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s)) return { address: s }
            throw new ToolError(`收件人地址无效：${raw}`)
          })
        const to = parse(ids(a.to))
        const cc = parse(ids(a.cc))
        const reply = a.reply_to_message_id ? store.getMessageRow(a.reply_to_message_id) : null
        const accounts = store.listAccounts()
        const account = accountOf(a.account) ?? (reply && accounts.find(x => x.id === reply.account_id)) ?? accounts.find(x => x.enabled) ?? accounts[0]
        if (!account) throw new ToolError('还没有添加任何邮件账户')
        const id = randomUUID()
        store.saveDraft({ id, accountId: account.id, to, cc, bcc: [], subject: String(a.subject), html: textToHtml(a.body), updatedAt: Date.now() })
        deps.event({ type: 'outbox-changed' })
        const fu = a.followup && typeof a.followup === 'object' ? a.followup : null
        const followupId = fu
          ? registerFollowup({ kind: isFollowupKind(fu.kind) ? fu.kind : 'reply', ask: String(fu.ask ?? ''), to: to.map(x => x.address), subject: String(a.subject), relatedMessageId: reply?.id ?? null, draftId: id, waitDays: clampWaitDays(fu.waitDays), source: ctx.headless ? 'skill' : 'agent' })
          : null
        return {
          data: { ok: true, draft_id: id, account: account.email, ...(followupId ? { followup_id: followupId } : {}), note: `已存为本地草稿，未发送${followupId ? `；已登记跟进，发出后 ${clampWaitDays(fu.waitDays)} 天未回会提醒（在「等待对方」里打开草稿）` : ''}` },
          summary: `已存草稿《${a.subject}》（未发送）${followupId ? ' · 已登记跟进' : ''}`,
          ...(followupId ? { refs: [{ type: 'followup' as const, id: followupId, label: subj(a.subject) }] } : {})
        }
      }
    },
    {
      name: 'send_mail',
      title: '发送邮件',
      domain: 'mail',
      risk: 'external',
      description: '立即发送一封邮件（对外动作，每次都需要用户确认）。能用草稿就优先用 draft_reply / save_draft，只有用户明确要求「发出去」时才用它。',
      params: {
        type: 'object',
        properties: {
          to: IDS('收件人地址'),
          cc: IDS('抄送'),
          subject: { type: 'string' },
          body: { type: 'string', description: '纯文本正文' },
          account: { type: 'string', description: '发件账户（名称或邮箱）' },
          reply_to_message_id: { type: 'string', description: '若是回复，原邮件 id' },
          reason: REASON
        },
        required: ['to', 'subject', 'body']
      },
      preview: a => [`收件人：${ids(a.to).join('、')}${ids(a.cc).length ? `；抄送：${ids(a.cc).join('、')}` : ''}`, `主题：${a.subject}`, String(a.body ?? '').slice(0, 600)],
      async run(a) {
        const toAddr = (raw: string) => {
          const m = raw.trim().match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/)
          const address = m ? m[2] : raw.trim()
          if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) throw new ToolError(`收件人地址无效：${raw}`)
          return m && m[1].trim() ? { name: m[1].trim(), address } : { address }
        }
        const reply = a.reply_to_message_id ? store.getMessageRow(a.reply_to_message_id) : null
        const accounts = store.listAccounts()
        const account = accountOf(a.account) ?? (reply && accounts.find(x => x.id === reply.account_id)) ?? accounts.find(x => x.enabled) ?? accounts[0]
        if (!account) throw new ToolError('还没有添加任何邮件账户')
        const draft: ComposeDraft = {
          id: randomUUID(),
          accountId: account.id,
          to: ids(a.to).map(toAddr),
          cc: ids(a.cc).map(toAddr),
          bcc: [],
          subject: String(a.subject),
          html: textToHtml(a.body),
          attachmentPaths: [],
          ...(reply ? { relatedMessageId: reply.id, inReplyToMessageId: reply.id } : {})
        }
        const res = (await deps.call('sendMail', [draft])) as { ok: boolean; error?: string }
        if (!res.ok) throw new ToolError(`发送失败：${res.error ?? '未知原因'}`)
        return { data: { ok: true, from: account.email }, summary: `已发送《${a.subject}》` }
      }
    },

    // ======================================================== 跟进闭环
    {
      name: 'followup_list',
      title: '查跟进',
      domain: 'mail',
      risk: 'read',
      description: '列出登记过的跟进（发出后在等对方的事）：状态（待发出 / 等待中 / 已逾期 / 已回复）、在等什么、到期日、催了几次。include_closed=true 连已解决的也列出。',
      params: { type: 'object', properties: { include_closed: { type: 'boolean', default: false }, limit: LIMIT(20, 60) } },
      run(a) {
        const svc = followupService()
        if (!svc) throw new ToolError('跟进模块尚未就绪')
        const now = Date.now()
        const list = svc.list(!!a.include_closed).slice(0, a.limit ?? 20)
        const overdue = list.filter(f => f.data.status === 'overdue').length
        return {
          data: {
            count: list.length,
            followups: list.map(f => ({
              id: f.id,
              status: FOLLOWUP_STATUS_LABEL[f.data.status],
              kind: FOLLOWUP_KIND_LABEL[f.data.kind],
              ask: f.data.ask,
              to: f.data.to.join('、'),
              subject: subj(f.data.subject),
              ...(f.data.sentAt ? { sent: fmtDay(f.data.sentAt), waited_days: waitedDays(f.data.sentAt, now) } : {}),
              ...(f.dueAt ? { due: fmtDay(f.dueAt) } : {}),
              nudges_sent: f.data.nudgesSent ?? 0,
              nudge_drafts: `${f.data.attempts}/${f.data.maxAttempts}`,
              ...(f.data.sentMessageId ? { message_id: f.data.sentMessageId } : {}),
              ...(f.data.repliedMessageId ? { replied_message_id: f.data.repliedMessageId } : {})
            }))
          },
          summary: list.length ? `${list.length} 条跟进${overdue ? `，${overdue} 条已逾期` : ''}` : '没有进行中的跟进',
          refs: list.slice(0, 8).map(f => ({ type: 'followup' as const, id: f.id, label: subj(f.data.subject) }))
        }
      }
    },
    {
      name: 'followup_create',
      title: '登记跟进',
      domain: 'mail',
      risk: 'write',
      description: '为一封已经发出的邮件（message_id）或一封本地草稿（draft_id）登记跟进：对方 wait_days 天没回就提醒用户并起草下一封催促（只起草不发送）。',
      params: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: '已发出的那封邮件 id（与 draft_id 二选一）' },
          draft_id: { type: 'string', description: 'save_draft / draft_reply 返回的草稿 id' },
          kind: { type: 'string', enum: ['reply', 'invoice', 'payment', 'document', 'unsubscribe', 'general'] },
          ask: { type: 'string', description: '一句话：在等对方做什么' },
          wait_days: { type: 'integer', minimum: 1, maximum: 60, default: 3 },
          reason: REASON
        }
      },
      preview: a => [...(a.message_id ? subjectsOf([a.message_id]) : [`草稿 ${a.draft_id ?? ''}`]), `${clampWaitDays(a.wait_days)} 天未回会提醒你${a.ask ? `（在等：${a.ask}）` : ''}`],
      run(a, ctx) {
        const svc = followupService()
        if (!svc) throw new ToolError('跟进模块尚未就绪')
        const kind = isFollowupKind(a.kind) ? a.kind : undefined
        if (a.message_id) {
          const row = store.getMessageRow(a.message_id)
          if (!row) throw new ToolError(`找不到邮件 ${a.message_id}`)
          const id = svc.createFromMessage({ messageId: a.message_id, kind, ask: a.ask, waitDays: a.wait_days })
          return { data: { ok: true, followup_id: id }, summary: `已登记跟进（${clampWaitDays(a.wait_days)} 天未回提醒）`, refs: [{ type: 'followup', id, label: subj(row.subject) }] }
        }
        if (a.draft_id) {
          const d = store.listDrafts().find(x => x.id === a.draft_id)
          if (!d) throw new ToolError(`找不到草稿 ${a.draft_id}`)
          const id = registerFollowup({ kind: kind ?? 'reply', ask: String(a.ask ?? ''), to: (d.to ?? []).map((x: Address) => x.address), subject: d.subject ?? '', draftId: d.id, waitDays: clampWaitDays(a.wait_days), source: ctx.headless ? 'skill' : 'agent' })
          if (!id) throw new ToolError('登记失败')
          return { data: { ok: true, followup_id: id, note: '草稿发出后开始计时' }, summary: '已登记跟进（发出后开始计时）', refs: [{ type: 'followup', id, label: subj(d.subject) }] }
        }
        throw new ToolError('需要 message_id（已发出的邮件）或 draft_id（草稿）')
      }
    },
    {
      name: 'followup_close',
      title: '结束跟进',
      domain: 'mail',
      risk: 'write',
      description: '结束一条跟进：resolved=已解决（对方办完了），cancel=不再跟进。',
      params: { type: 'object', properties: { id: { type: 'string', description: '跟进 id（followup_list 返回）' }, outcome: { type: 'string', enum: ['resolved', 'cancel'], default: 'resolved' }, reason: REASON }, required: ['id'] },
      preview: a => {
        const f = followupService()?.get(String(a.id))
        return [f ? `${subj(f.data.subject)} · ${f.data.ask}` : String(a.id), a.outcome === 'cancel' ? '不再跟进' : '标记为已解决']
      },
      run(a) {
        const svc = followupService()
        if (!svc) throw new ToolError('跟进模块尚未就绪')
        const f = svc.get(String(a.id))
        if (!f) throw new ToolError(`找不到跟进 ${a.id}；先用 followup_list 查看`)
        svc.update(f.id, { status: a.outcome === 'cancel' ? 'cancelled' : 'closed' })
        return { data: { ok: true }, summary: a.outcome === 'cancel' ? '已取消跟进' : '已标记为已解决', refs: [{ type: 'followup', id: f.id, label: subj(f.data.subject) }] }
      }
    },

    // ======================================================== 规则建议（习惯自动化）
    {
      name: 'rule_suggestions',
      title: '查规则建议',
      domain: 'mail',
      risk: 'read',
      description: '列出从用户反复的手动操作里挖掘出的规则建议（如「总把某发件人的促销邮件不读就归档」）：一句话描述、证据（次数 / 天数 / 一致率）、建议的条件与动作、收件箱里现在会命中几封、样本邮件。',
      params: { type: 'object', properties: {} },
      run() {
        const svc = ruleSuggestService()
        if (!svc) throw new ToolError('规则建议模块尚未就绪')
        const list = svc.list()
        return {
          data: {
            count: list.length,
            suggestions: list.map(s => ({
              id: s.id,
              title: s.title,
              evidence: s.evidence,
              rule_name: s.rule.name,
              conditions: s.rule.conditions.map(c => `${c.field} ${c.op} ${c.value}`),
              actions: s.rule.actions.map(x => `${x.type}${x.value ? `(${x.value})` : ''}`),
              inbox_matches: s.matchCount ?? 0,
              samples: (s.samples ?? []).slice(0, 5).map(m => `${subj(m.subject)} · ${m.from}`)
            }))
          },
          summary: list.length ? `${list.length} 条规则建议` : '暂时没有规则建议',
          refs: list.flatMap(s => (s.samples ?? []).slice(0, 2).map(m => mailRef(m.id, m.subject))).slice(0, 8)
        }
      }
    },
    {
      name: 'accept_rule_suggestion',
      title: '按建议建规则',
      domain: 'mail',
      risk: 'write',
      description: '接受一条规则建议：按建议的条件与动作新建并启用规则（之后新到的邮件自动处理）。apply_existing=true 时同时对收件箱里现有命中的邮件执行一次。',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '建议 id（rule_suggestions 返回）' },
          apply_existing: { type: 'boolean', default: false, description: '是否同时处理收件箱里现有命中的邮件' },
          reason: REASON
        },
        required: ['id']
      },
      preview: a => {
        const s = ruleSuggestService()?.get(String(a.id))
        if (!s) return [String(a.id)]
        return [
          s.title,
          ...s.rule.conditions.map(c => `当 ${c.field} ${c.op} ${c.value}`),
          ...s.rule.actions.map(x => `执行 ${x.type}${x.value ? `（${x.value}）` : ''}`),
          a.apply_existing ? `同时处理收件箱里现有 ${s.matchCount ?? 0} 封` : '只作用于之后新到的邮件'
        ]
      },
      async run(a) {
        const svc = ruleSuggestService()
        if (!svc) throw new ToolError('规则建议模块尚未就绪')
        const r = await svc.accept(String(a.id), { applyExisting: !!a.apply_existing })
        if (!r.ok) throw new ToolError(r.error || '创建失败；先用 rule_suggestions 看看建议是否还在')
        return { data: r, summary: `已新建规则${r.applied ? `，并处理了现有 ${r.applied} 封` : ''}` }
      }
    },

    // ======================================================== 待办
    {
      name: 'list_todos',
      title: '查待办',
      domain: 'todo',
      risk: 'read',
      description: '列出待办。filter：open=未完成（默认）、today=今天要做的、overdue=已逾期、upcoming=未来 7 天、done=已完成、all=全部；可按项目 / 情境 / 关键词再筛。',
      params: {
        type: 'object',
        properties: {
          filter: { type: 'string', enum: ['open', 'today', 'overdue', 'upcoming', 'done', 'all'], default: 'open' },
          project: { type: 'string' },
          context: { type: 'string', description: '情境，如 @电脑 @电话' },
          query: { type: 'string', description: '标题 / 备注关键词' },
          limit: LIMIT(30, 80)
        }
      },
      run(a) {
        const now = new Date()
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
        const dayEnd = dayStart + DAY
        const when = (t: { dueAt: number | null; data: Record<string, unknown> }) => (t.data as TodoData).fixedAt ?? t.dueAt
        let list = todoRows().filter(t => {
          const open = t.status !== 'done'
          const w = when(t)
          switch (a.filter) {
            case 'open':
              return open
            case 'today':
              return open && !!w && w < dayEnd
            case 'overdue':
              return open && !!t.dueAt && t.dueAt < dayStart
            case 'upcoming':
              return open && !!w && w >= dayStart && w < dayStart + 7 * DAY
            case 'done':
              return !open
            default:
              return true
          }
        })
        if (a.project) list = list.filter(t => String((t.data as TodoData).project ?? '').includes(a.project))
        if (a.context) list = list.filter(t => String((t.data as TodoData).context ?? '').includes(a.context))
        if (a.query) {
          const q = String(a.query).toLowerCase()
          list = list.filter(t => `${t.title} ${(t.data as TodoData).notes ?? ''}`.toLowerCase().includes(q))
        }
        list.sort((x, y) => (when(x) ?? Infinity) - (when(y) ?? Infinity) || y.createdAt - x.createdAt)
        const overdue = list.filter(t => t.status !== 'done' && t.dueAt && t.dueAt < dayStart).length
        return {
          data: { total: list.length, overdue, todos: list.slice(0, a.limit).map(todoBrief) },
          summary: `${list.length} 条待办${overdue && a.filter !== 'overdue' ? `（逾期 ${overdue}）` : ''}`,
          refs: list.slice(0, a.limit).map(t => ({ type: 'todo' as const, id: t.id, label: t.title }))
        }
      }
    },
    {
      name: 'create_todo',
      title: '新建待办',
      domain: 'todo',
      risk: 'write',
      description: '新建一条待办，可关联邮件、设截止时间（YYYY-MM-DD 或 YYYY-MM-DD HH:mm，也可写「下周三」）、项目、情境、备注、优先级（1 高 2 中 3 低）。',
      params: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '动词开头的具体事项，如「回复云桥报价」' },
          due: { type: 'string' },
          message_id: { type: 'string', description: '来源邮件 id' },
          project: { type: 'string' },
          context: { type: 'string' },
          notes: { type: 'string' },
          priority: { type: 'integer', minimum: 1, maximum: 3 },
          reason: REASON
        },
        required: ['title']
      },
      preview: a => [`「${a.title}」${a.due ? ` · 截止 ${a.due}` : ''}${a.project ? ` · ${a.project}` : ''}`, ...(a.message_id ? subjectsOf([a.message_id]).map(s => `来自 ${s}`) : [])],
      run(a) {
        const row = a.message_id ? store.getMessageRow(a.message_id) : null
        if (a.message_id && !row) throw new ToolError(`找不到邮件 ${a.message_id}`)
        const dueAt = a.due ? parseWhen(a.due, new Date(), '18:00') : null
        if (a.due && !dueAt) throw new ToolError(`截止时间「${a.due}」看不懂，用 YYYY-MM-DD 或 YYYY-MM-DD HH:mm`)
        const id = `todo-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const data: TodoData = {
          from: 'agent',
          updatedAt: Date.now(),
          ...(a.project ? { project: a.project } : {}),
          ...(a.context ? { context: a.context } : {}),
          ...(a.notes ? { notes: a.notes } : {}),
          ...(a.priority ? { priority: a.priority as 1 | 2 | 3 } : {})
        }
        store.insertInsight({ id, kind: 'todo', accountId: row?.account_id ?? null, messageId: row?.id ?? null, title: String(a.title).slice(0, 200), data: data as Record<string, unknown>, dueAt })
        todosChanged(id)
        return { data: { ok: true, id, due: fmtTime(dueAt) }, summary: `已建待办「${a.title}」`, refs: [{ type: 'todo', id, label: String(a.title) }] }
      }
    },
    {
      name: 'update_todo',
      title: '修改待办',
      domain: 'todo',
      risk: 'write',
      description: '修改一条待办的标题、截止时间、项目、情境、备注或优先级（due 传空字符串 "none" 表示清除截止时间）。',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          due: { type: 'string' },
          project: { type: 'string' },
          context: { type: 'string' },
          notes: { type: 'string' },
          priority: { type: 'integer', minimum: 1, maximum: 3 },
          reason: REASON
        },
        required: ['id']
      },
      preview: a => {
        const t = store.getInsight(a.id)
        return [`「${t?.title ?? a.id}」`, ...Object.entries(a).filter(([k]) => !['id', 'reason'].includes(k)).map(([k, v]) => `${k} → ${v}`)]
      },
      async run(a) {
        const t = store.getInsight(a.id)
        if (!t || t.kind !== 'todo') throw new ToolError(`找不到待办 ${a.id}`)
        const patch: { title?: string; dueAt?: number | null; data?: Record<string, unknown> } = {}
        if (a.title) patch.title = String(a.title).slice(0, 200)
        if (a.due !== undefined) {
          if (/^(none|null|清除|无)$/i.test(a.due)) patch.dueAt = null
          else {
            const dueAt = parseWhen(a.due, new Date(), '18:00')
            if (!dueAt) throw new ToolError(`截止时间「${a.due}」看不懂`)
            patch.dueAt = dueAt
          }
        }
        const data: Record<string, unknown> = {}
        for (const k of ['project', 'context', 'notes', 'priority']) if (a[k] !== undefined) data[k] = a[k]
        if (Object.keys(data).length) patch.data = data
        await deps.call('updateTodo', [a.id, patch])
        return { data: { ok: true }, summary: `已修改「${patch.title ?? t.title}」`, refs: [{ type: 'todo', id: a.id, label: patch.title ?? t.title }] }
      }
    },
    {
      name: 'complete_todo',
      title: '完成待办',
      domain: 'todo',
      risk: 'write',
      description: '把一条或多条待办标记为完成。',
      params: { type: 'object', properties: { ids: IDS('待办 id 列表'), reason: REASON }, required: ['ids'] },
      preview: a => ids(a.ids).map(id => `「${store.getInsight(id)?.title ?? id}」`),
      async run(a) {
        const list = ids(a.ids).slice(0, 50)
        const missing = list.filter(id => store.getInsight(id)?.kind !== 'todo')
        if (missing.length) throw new ToolError(`找不到待办：${missing.join('、')}`)
        for (const id of list) await deps.call('updateTodo', [id, { status: 'done', data: { doneAt: Date.now(), doneBy: 'agent' } }])
        return { data: { ok: true, count: list.length }, summary: `已完成 ${list.length} 条` }
      }
    },

    // ======================================================== 财务
    {
      name: 'finance_list',
      title: '查款项',
      domain: 'finance',
      risk: 'read',
      description:
        '列出财务中心里的款项（账单、订阅、订单、发票、付款、回单、退款）。可按类型、状态（pending 待付 / overdue 逾期 / paid 已付 / open 未结清）、方向、对方、分类、日期范围、关键词筛选。',
      params: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['bill', 'subscription', 'order', 'invoice', 'payment', 'receipt', 'refund'] },
          status: { type: 'string', enum: ['pending', 'overdue', 'paid', 'cancelled', 'refunded', 'open'] },
          direction: { type: 'string', enum: ['out', 'in'], description: 'out 支出 / in 收入' },
          counterparty: { type: 'string', description: '商家 / 公司' },
          category: { type: 'string', description: '分类，如 软件订阅 / 云服务 / 差旅' },
          from: { type: 'string', description: '起始日期' },
          to: { type: 'string', description: '截止日期' },
          query: { type: 'string', description: '标题 / 单号关键词' },
          limit: LIMIT(30, 80)
        }
      },
      run(a) {
        const now = Date.now()
        const from = a.from ? parseWhen(a.from, new Date(), '00:00') : null
        const to = a.to ? (parseWhen(a.to, new Date(), '00:00') ?? 0) + DAY - 1 : null
        const list = financeItems().filter(r => {
          const d = r.data
          const st = effectiveStatus(d, r.dueAt, now)
          if (a.kind && d.kind !== a.kind) return false
          if (a.status === 'open' ? !(st === 'pending' || st === 'overdue') : a.status && st !== a.status) return false
          if (a.direction && d.direction !== a.direction) return false
          if (a.counterparty && !sameParty(d.counterparty, a.counterparty) && !String(d.counterparty).toLowerCase().includes(String(a.counterparty).toLowerCase())) return false
          if (a.category && !String(d.category ?? '').includes(a.category)) return false
          const at = itemAt(r)
          if (from && at < from) return false
          if (to && at > to) return false
          if (a.query) {
            const q = String(a.query).toLowerCase()
            if (!`${r.title} ${d.counterparty} ${d.invoiceNo ?? ''} ${d.orderNo ?? ''} ${d.poNo ?? ''} ${d.contractNo ?? ''} ${d.notes ?? ''}`.toLowerCase().includes(q)) return false
          }
          return true
        })
        list.sort((x, y) => itemAt(y) - itemAt(x))
        const sums = sumByCur(list.map(r => ({ amount: r.data.amount, currency: r.data.currency })))
        return {
          data: { total: list.length, sum: sums, items: list.slice(0, a.limit).map(r => financeBrief(r, now)) },
          summary: list.length ? `${list.length} 笔，合计 ${fmtSums(sums)}` : '没有符合条件的款项',
          refs: list.slice(0, a.limit).map(finRef)
        }
      }
    },
    {
      name: 'finance_summary',
      title: '财务概览',
      domain: 'finance',
      risk: 'read',
      description:
        '财务汇总：指定月份的支出 / 收入（按分类）、最近几个月趋势、在用订阅及年化成本（含可能闲置的订阅）、待付与逾期、企业往来对账差异（缺发票 / 缺付款 / 金额不符）。month 用 YYYY-MM，默认本月。',
      params: {
        type: 'object',
        properties: { month: { type: 'string', description: 'YYYY-MM，或 this / last' }, months: { type: 'integer', minimum: 1, maximum: 12, default: 3, description: '趋势看最近几个月' } }
      },
      run(a) {
        const now = new Date()
        let y = now.getFullYear()
        let mo = now.getMonth()
        if (a.month === 'last' || a.month === '上月' || a.month === '上个月') mo -= 1
        else if (a.month && /^\d{4}-\d{1,2}$/.test(a.month)) [y, mo] = [Number(a.month.split('-')[0]), Number(a.month.split('-')[1]) - 1]
        const monthKey = (t: number) => ymd(new Date(t)).slice(0, 7)
        const items = financeItems()
        const nowMs = Date.now()
        const paymentMatch = new Set(items.filter(r => r.data.kind === 'payment' && r.data.matchId).map(r => r.data.matchId!))
        // 计入收支：账单 / 订单 / 订阅扣费 / 付款 / 退款；发票只在没有对应付款时计入（避免重复）
        const counted = items.filter(r => {
          const d = r.data
          if (d.amount == null || d.status === 'cancelled') return false
          if (d.kind === 'receipt') return false
          if (d.kind === 'invoice' && d.matchId && paymentMatch.has(d.matchId)) return false
          return true
        })
        const trend: { month: string; out: Record<string, number>; in: Record<string, number> }[] = []
        for (let i = a.months - 1; i >= 0; i--) {
          const key = ymd(new Date(y, mo - i, 1)).slice(0, 7)
          const inMonth = counted.filter(r => monthKey(itemAt(r)) === key)
          trend.push({
            month: key,
            out: sumByCur(inMonth.filter(r => r.data.direction === 'out' && r.data.kind !== 'refund').map(r => r.data)),
            in: sumByCur(inMonth.filter(r => r.data.direction === 'in' || r.data.kind === 'refund').map(r => r.data))
          })
        }
        const target = ymd(new Date(y, mo, 1)).slice(0, 7)
        const monthOut = counted.filter(r => monthKey(itemAt(r)) === target && r.data.direction === 'out' && r.data.kind !== 'refund')
        const byCat = new Map<string, { amount: number; currency: string }[]>()
        for (const r of monthOut) {
          const k = r.data.category || FINANCE_KIND_LABEL[r.data.kind]
          byCat.set(k, [...(byCat.get(k) ?? []), { amount: r.data.amount!, currency: r.data.currency }])
        }
        const idle = new Set(deps.finance.list().idle)
        const subs = items.filter(r => r.data.kind === 'subscription' && r.data.status !== 'cancelled' && r.data.status !== 'refunded')
        const pending = items.filter(r => effectiveStatus(r.data, r.dueAt, nowMs) === 'pending' && r.data.kind !== 'subscription' && r.data.direction === 'out')
        const overdue = items.filter(r => effectiveStatus(r.data, r.dueAt, nowMs) === 'overdue')
        const recon = reconGroups(items).filter(g => g.issues.some(i => i.type !== 'missing_receipt'))
        const data = {
          month: target,
          spend: { total: sumByCur(monthOut.map(r => r.data)), by_category: [...byCat.entries()].map(([k, v]) => ({ category: k, sum: sumByCur(v), count: v.length })).sort((p, q) => q.count - p.count) },
          trend,
          subscriptions: {
            count: subs.length,
            annual: sumByCur(subs.map(r => ({ amount: annualCost(r.data), currency: r.data.currency }))),
            items: subs.slice(0, 20).map(r => ({ id: r.id, name: r.data.counterparty, amount: money(r.data.amount, r.data.currency), cycle: r.data.cycle ? FINANCE_CYCLE_LABEL[r.data.cycle] : null, annual: money(annualCost(r.data), r.data.currency), next: fmtDay(r.dueAt), ...(idle.has(r.id) ? { maybe_idle: true } : {}) }))
          },
          pending: { count: pending.length, sum: sumByCur(pending.map(r => r.data)), items: pending.sort((p, q) => (p.dueAt ?? Infinity) - (q.dueAt ?? Infinity)).slice(0, 10).map(r => financeBrief(r, nowMs)) },
          overdue: { count: overdue.length, sum: sumByCur(overdue.map(r => r.data)), items: overdue.slice(0, 10).map(r => financeBrief(r, nowMs)) },
          reconciliation: {
            groups_with_issues: recon.length,
            items: recon.slice(0, 8).map(g => ({ counterparty: g.counterparty, issues: g.issues.filter(i => i.type !== 'missing_receipt').map(i => `${RECON_ISSUE_LABEL[i.type]}：${i.detail}`) }))
          }
        }
        return {
          data,
          summary: `${target} 支出 ${fmtSums(data.spend.total)} · 待付 ${pending.length} · 逾期 ${overdue.length}`,
          refs: [...overdue, ...pending].slice(0, 8).map(finRef)
        }
      }
    },
    {
      name: 'finance_mark_paid',
      title: '标记已付',
      domain: 'finance',
      risk: 'write',
      description: '把一笔款项标记为已付（订阅 = 本期已续费，顺延到下一期；paid=false 撤销）。关联的提醒待办会一起完成。',
      params: { type: 'object', properties: { id: { type: 'string', description: '款项 id' }, paid: { type: 'boolean', default: true }, reason: REASON }, required: ['id'] },
      preview: a => {
        const r = financeItems().find(x => x.id === a.id)
        return [r ? `${r.title} · ${money(r.data.amount, r.data.currency)}` : a.id]
      },
      run(a) {
        const r = financeItems().find(x => x.id === a.id)
        if (!r) throw new ToolError(`找不到款项 ${a.id}`)
        deps.finance.markPaid(a.id, a.paid !== false)
        return { data: { ok: true }, summary: a.paid === false ? `已撤销「${r.title}」的已付` : `已标记「${r.title}」已付`, refs: [finRef(r)] }
      }
    },

    // ======================================================== 项目 / 联系人时间线
    {
      name: 'list_projects',
      title: '查项目',
      domain: 'project',
      risk: 'read',
      description: '列出项目（一件事的多封邮件：一次采购、一个合作、一个外包）及其概况：往来封数、未读、最近进展、未完成待办、关联款项。',
      params: { type: 'object', properties: { query: { type: 'string', description: '名称 / 对方关键词' }, include_done: { type: 'boolean', default: false } } },
      run(a) {
        let list = deps.projects.list()
        if (!a.include_done) list = list.filter(p => p.status === 'open')
        if (a.query) {
          const q = String(a.query).toLowerCase()
          list = list.filter(p => `${p.data.name} ${p.data.counterparties.join(' ')} ${p.data.keywords.join(' ')}`.toLowerCase().includes(q))
        }
        return {
          data: list.slice(0, 30).map(p => ({
            id: p.id,
            name: p.data.name,
            status: p.data.status,
            counterparties: p.data.counterparties.slice(0, 4),
            messages: p.stats.messageCount,
            unread: p.stats.unread,
            last: p.stats.lastAt ? `${fmtTime(p.stats.lastAt)} · ${p.stats.lastSubject}` : null,
            ...(p.stats.lastGist ? { gist: p.stats.lastGist } : {}),
            open_todos: p.stats.openTodos,
            ...(p.stats.finance ? { money: p.stats.finance.totals.map(t => `${t.currency} 收 ${t.in} / 付 ${t.out} / 未结 ${t.pending}`) } : {})
          })),
          summary: `${list.length} 个项目`,
          refs: list.slice(0, 10).map(p => ({ type: 'project' as const, id: p.id, label: p.data.name }))
        }
      }
    },
    {
      name: 'project_detail',
      title: '项目详情',
      domain: 'project',
      risk: 'read',
      description: '一个项目的详情：会话列表、未完成待办、款项、附件、当前进展摘要（卡在谁、下一步）。id 也可以写项目名。',
      params: { type: 'object', properties: { id: { type: 'string', description: '项目 id 或名称' } }, required: ['id'] },
      run(a) {
        const p = projectByIdOrName(a.id)
        const d = deps.projects.detail(p.id)
        if (!d) throw new ToolError('项目不存在')
        return {
          data: {
            id: d.id,
            name: d.data.name,
            status: d.data.status,
            counterparties: d.data.counterparties,
            summary: d.data.summary ?? d.ruleSummary,
            conversations: d.conversations.slice(0, 12).map(c => ({ latest_id: c.latestId, subject: c.subject, count: c.count, unread: c.unread, last: fmtTime(c.lastAt), ...(c.gist ? { gist: c.gist } : {}), last_from_me: c.fromMe })),
            todos: d.todos.filter(t => t.status === 'open').slice(0, 10).map(t => ({ id: t.id, title: t.title, due: fmtTime(t.dueAt) })),
            finance: d.finance.slice(0, 10).map(f => financeBrief({ id: f.id, title: f.title, dueAt: f.dueAt, createdAt: f.createdAt, data: f.data as unknown as FinanceData })),
            attachments: d.attachments.slice(0, 12).map(x => ({ id: x.id, filename: x.filename, kind: x.kind, date: fmtDay(x.date), message_id: x.messageId }))
          },
          summary: `「${d.data.name}」${d.stats.messageCount} 封 · 待办 ${d.stats.openTodos}`,
          refs: [{ type: 'project', id: d.id, label: d.data.name }, ...d.conversations.slice(0, 4).map(c => mailRef(c.latestId, c.subject))]
        }
      }
    },
    {
      name: 'project_timeline',
      title: '项目时间线',
      domain: 'project',
      risk: 'read',
      description: '一个项目按时间排列的全部事件：往来邮件、附件（报价 / 合同 / 发票）、待办创建与完成、款项、里程碑。默认取最近 30 条。',
      params: { type: 'object', properties: { id: { type: 'string', description: '项目 id 或名称' }, limit: LIMIT(30, 80) }, required: ['id'] },
      run(a) {
        const p = projectByIdOrName(a.id)
        const events = deps.projects.timeline(p.id)
        const list = events.slice(-a.limit)
        return {
          data: { total: events.length, events: list.map(e => ({ at: fmtTime(e.at), kind: e.kind, title: e.title, ...(e.detail ? { detail: e.detail } : {}), ...(e.direction ? { direction: e.direction } : {}), ...(e.status ? { status: e.status } : {}), ...(e.messageId ? { message_id: e.messageId } : {}) })) },
          summary: `「${p.data.name}」${events.length} 个事件`,
          refs: [{ type: 'project', id: p.id, label: p.data.name }]
        }
      }
    },
    {
      name: 'contact_timeline',
      title: '往来时间线',
      domain: 'contact',
      risk: 'read',
      description: '和某个联系人（邮箱）或某家公司（域名）的全部往来时间线：邮件、附件、待办、款项，以及他们在哪些项目里。',
      params: { type: 'object', properties: { key: { type: 'string', description: '邮箱地址或公司域名，如 lin@cloudbridge.example 或 cloudbridge.example' }, limit: LIMIT(30, 80) }, required: ['key'] },
      run(a) {
        const t = deps.projects.contactTimeline(a.key)
        if (!t) throw new ToolError(`没有找到与「${a.key}」相关的往来`)
        const list = t.events.slice(-a.limit)
        return {
          data: { name: t.name, mode: t.mode, messages: t.messageCount, projects: t.projects.map(p => p.name), events: list.map(e => ({ at: fmtTime(e.at), kind: e.kind, title: e.title, ...(e.detail ? { detail: e.detail } : {}), ...(e.messageId ? { message_id: e.messageId } : {}) })) },
          summary: `${t.name} · ${t.messageCount} 封往来`,
          refs: [{ type: 'contact', id: t.key, label: t.name }, ...t.projects.slice(0, 3).map(p => ({ type: 'project' as const, id: p.id, label: p.name }))]
        }
      }
    },

    // ======================================================== 附件
    {
      name: 'attachment_search',
      title: '找附件',
      domain: 'attachment',
      risk: 'read',
      description: `在附件中心里找附件：按分类（${ATTACHMENT_CATEGORIES.map(c => `${c.id}=${c.label}`).join('、')}）、对方、文件名关键词、年份、最近 N 天、收 / 发方向筛选。`,
      params: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ATTACHMENT_CATEGORIES.map(c => c.id) },
          counterparty: { type: 'string', description: '对方公司或发件人' },
          query: { type: 'string', description: '文件名 / 邮件主题关键词' },
          year: { type: 'integer', minimum: 2000, maximum: 2100 },
          within_days: { type: 'integer', minimum: 1, maximum: 3650 },
          direction: { type: 'string', enum: ['in', 'out'], description: 'in 收到的 / out 我发出的' },
          limit: LIMIT(20, 60)
        }
      },
      run(a) {
        const res = svc().list({ category: (a.category as AttachmentCategory) ?? null, counterparty: a.counterparty ?? null, search: a.query ?? null, year: a.year ?? null, sort: 'date', limit: 500, offset: 0 })
        const since = a.within_days ? Date.now() - a.within_days * DAY : 0
        const list = res.items.filter(x => x.date >= since && (!a.direction || x.direction === a.direction))
        const texts = attachmentText()?.infoMany(list.slice(0, a.limit).map(x => x.id)) ?? new Map()
        return {
          data: {
            total: list.length,
            items: list.slice(0, a.limit).map(x => ({ id: x.id, filename: x.filename, category: attachmentCategoryLabel(x.category), counterparty: x.counterparty, direction: x.direction === 'in' ? '收到' : '发出', date: fmtDay(x.date), size_kb: Math.round(x.size / 1024), subject: x.subject, message_id: x.messageId, cached: x.cached, in_cloud: x.cloud.length > 0, text: attachmentTextLabel(x.ext, texts.get(x.id)) }))
          },
          summary: list.length ? `找到 ${list.length} 个附件` : '没有找到附件',
          refs: list.slice(0, a.limit).map(x => ({ type: 'attachment' as const, id: x.id, label: x.filename }))
        }
      }
    },
    {
      name: 'read_attachment',
      title: '读附件正文',
      domain: 'attachment',
      risk: 'read',
      description: '按附件 id（来自 attachment_search / read_email）读取附件正文：PDF 文本层，或 txt / csv / md / html / eml 等纯文本；扫描件 PDF 与图片在用户允许时做文字识别（OCR）。可按页读（page_from / page_to，从 1 开始）。不能识别时会说明。发票 PDF 会附带抽到的发票号 / 金额 / 开票日期 / 销售方 / 购买方。' +
        'Word / Excel / PowerPoint（docx / xlsx / pptx / odt 等）同样可读：Excel 每个工作表一页（「## 表名」+ 制表符分隔的行，可用 sheet 按表名读），PowerPoint 每张幻灯片一页（page_from / page_to 按幻灯片读）。',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '附件 id' },
          max_chars: { type: 'integer', minimum: 200, maximum: 20000, default: 6000, description: '最多返回多少字（默认 6000）' },
          page_from: { type: 'integer', minimum: 1, description: '从第几页开始（PDF）' },
          page_to: { type: 'integer', minimum: 1, description: '读到第几页（含）' },
          sheet: { type: 'string', description: 'Excel：只读这个工作表（表名）' }
        },
        required: ['id']
      },
      async run(a) {
        const t = attachmentText()
        if (!t) throw new ToolError('附件正文服务尚未就绪')
        const id = String(a.id ?? '').trim()
        if (!id) throw new ToolError('缺少附件 id，先用 attachment_search 找到附件')
        const item = deps.attachments()?.getItem(id)
        // 授权：附件内容要交给（云端）模型，除本机读取授权外还需要「允许发给云端 AI」；被拦时在界面弹出授权说明
        if (getAccess().readContent && !allowsAI()) {
          requestAccessPrompt('cloud', item?.filename ?? null)
          throw new ToolError('用户尚未授权把附件内容发给云端 AI（已在界面上请用户授权；也可在 设置 → 附件与存储 → 附件内容读取 中开启）')
        }
        const res = await t.read(id, 400_000, { ocr: 'auto' })
        if (!res.ok && res.blocked) {
          if (res.blocked !== 'account') requestAccessPrompt(res.blocked === 'cloud' ? 'cloud' : 'pdf', item?.filename ?? null)
          throw new ToolError(res.blocked === 'consent' ? '用户尚未授权读取附件内容（已在界面上请用户授权）' : `用户尚未授权读取这份附件的内容：${res.error ?? ''}`)
        }
        if (!res.ok) throw new ToolError(res.error ?? '读取失败')
        const info = res.info
        const name = item?.filename ?? id
        if (!res.text || info?.method === 'none') {
          return { data: { id, filename: name, has_text: false, pages: info?.pages ?? 0, reason: info?.error ?? '没有可提取的文字' }, summary: `「${name}」没有可读文字`, refs: [{ type: 'attachment', id, label: name }] }
        }
        const max = Math.min(20000, Math.max(200, Number(a.max_chars) || 6000))
        // Excel 按工作表名读：每个工作表是一页，页首是「## 表名」
        const sheetNames = a.sheet ? res.text.split('\n\f\n').map(p => p.split('\n')[0].replace(/^##\s*/, '').replace(/（隐藏）$/, '').trim()) : []
        const sheetNo = a.sheet ? sheetNames.indexOf(String(a.sheet).trim()) + 1 : 0
        if (a.sheet && !sheetNo) throw new ToolError(`没有名为「${a.sheet}」的工作表${sheetNames.length > 1 ? `（有：${sheetNames.slice(0, 20).join('、')}）` : ''}`)
        const part = sheetNo ? slicePages(res.text, sheetNo, sheetNo) : slicePages(res.text, a.page_from ?? null, a.page_to ?? null)
        const body = part.text.replace(/\n\f\n/g, '\n\n[分页]\n\n')
        const inv = info?.invoice
        return {
          data: {
            id,
            filename: name,
            method: info?.method,
            pages: info?.pages ?? part.total,
            ...(part.total > 1 ? { page_range: `${part.from}-${part.to}` } : {}),
            chars: body.length,
            truncated: body.length > max || !!info?.truncated,
            text: body.slice(0, max),
            ...(inv ? { invoice: { invoice_no: inv.invoiceNo ?? null, issue_date: inv.issueDate ?? null, total: inv.total ?? null, currency: inv.currency ?? null, seller: inv.seller ?? null, buyer: inv.buyer ?? null } } : {})
          },
          summary: `读了「${name}」${info?.pages ? `${part.total > 1 ? ` 第 ${part.from}-${part.to} 页` : ''}（共 ${info.pages} 页）` : ''} · ${Math.min(body.length, max)} 字`,
          refs: [{ type: 'attachment', id, label: name }]
        }
      }
    },
    {
      name: 'attachment_stats',
      title: '附件统计',
      domain: 'attachment',
      risk: 'read',
      description: '附件中心总览：总数与占用空间、按分类 / 对方统计、最大的文件、重复文件、已归档到网盘的情况。',
      params: { type: 'object', properties: {} },
      run() {
        const s = svc().stats()
        const mb = (b: number) => `${Math.round(b / 1048576)} MB`
        return {
          data: {
            total: `${s.total.count} 个 / ${mb(s.total.bytes)}`,
            local: `${s.local.count} 个 / ${mb(s.local.bytes)}`,
            archived: `${s.archived.count} 个 / ${mb(s.archived.bytes)}`,
            by_category: s.byCategory.map(b => `${b.label} ${b.count}`),
            top_counterparties: s.byCounterparty.slice(0, 8).map(b => `${b.label} ${b.count}`),
            largest: s.largest.slice(0, 5).map(x => `${x.filename}（${mb(x.size)}）`),
            duplicates: s.duplicates.length
          },
          summary: `${s.total.count} 个附件 · ${mb(s.total.bytes)}`
        }
      }
    },
    {
      name: 'archive_attachments_to_drive',
      title: '归档附件到网盘',
      domain: 'attachment',
      risk: 'external',
      description: '把附件上传归档到用户配置的网盘（对外动作，需确认）。drive 可省略（用第一个网盘）。',
      params: { type: 'object', properties: { ids: IDS('附件 id 列表（来自 attachment_search）'), drive: { type: 'string', description: '网盘 id 或名称' }, reason: REASON }, required: ['ids'] },
      preview: a => {
        const s = deps.attachments()
        return [...ids(a.ids).slice(0, 30).map(id => s?.getItem(id)?.filename ?? id), `目标：${a.drive ?? s?.targets()[0]?.name ?? '（未配置网盘）'}`]
      },
      run(a) {
        const s = svc()
        const targets = s.targets()
        if (!targets.length) throw new ToolError('还没有配置网盘（设置 → 集成 → 网盘）')
        const t = a.drive ? targets.find(x => x.driveId === a.drive || x.name.toLowerCase().includes(String(a.drive).toLowerCase())) : targets[0]
        if (!t) throw new ToolError(`找不到网盘「${a.drive}」，可用：${targets.map(x => x.name).join('、')}`)
        const job = s.startArchive(t.driveId, ids(a.ids))
        if (!job) throw new ToolError('已有归档任务在进行，稍后再试')
        return { data: { ok: true, drive: t.name, queued: ids(a.ids).length }, summary: `已开始归档 ${ids(a.ids).length} 个到「${t.name}」` }
      }
    },

    // ======================================================== 知识库 / 记忆
    {
      name: 'kb_search',
      title: '查知识库',
      domain: 'kb',
      risk: 'read',
      description: '检索用户的知识库（收藏的邮件、笔记、摘要），返回最相关的条目内容。',
      params: { type: 'object', properties: { query: { type: 'string' }, limit: LIMIT(6, 20) }, required: ['query'] },
      run(a) {
        const terms = searchTerms(a.query)
        const all = store.listKbItems()
        const ranked = terms.length ? rankByTerms(all, terms, i => ({ title: i.title, body: `${i.content} ${i.tags.join(' ')}` })).map(x => x.item) : all
        const list = ranked.slice(0, a.limit)
        return {
          data: list.map(i => ({ id: i.id, title: i.title, tags: i.tags, source: i.sourceLabel, created: fmtDay(i.createdAt), content: i.content.slice(0, 1200) })),
          summary: list.length ? `${list.length} 条相关` : '知识库里没有相关内容',
          refs: list.map(i => ({ type: 'kb' as const, id: i.id, label: i.title }))
        }
      }
    },
    {
      name: 'kb_save',
      title: '存知识库',
      domain: 'kb',
      risk: 'write',
      description: '把一段内容（或一封邮件的要点）存进知识库，便于以后检索。',
      params: {
        type: 'object',
        properties: { title: { type: 'string' }, content: { type: 'string' }, tags: IDS('标签'), message_id: { type: 'string', description: '来源邮件 id（可选）' }, reason: REASON },
        required: ['title', 'content']
      },
      preview: a => [`「${a.title}」`, String(a.content ?? '').slice(0, 300)],
      async run(a) {
        if (a.message_id && !store.getMessageRow(a.message_id)) throw new ToolError(`找不到邮件 ${a.message_id}`)
        const item = (await deps.call('saveToKb', [{ messageId: a.message_id, kind: a.message_id ? 'message' : 'note', title: a.title, content: a.content, tags: ids(a.tags) }])) as { id: string; title: string }
        deps.event({ type: 'kb-changed' })
        return { data: { ok: true, id: item.id }, summary: `已存入知识库「${a.title}」`, refs: [{ type: 'kb', id: item.id, label: item.title }] }
      }
    },
    {
      name: 'memory_search',
      title: '查记忆',
      domain: 'memory',
      risk: 'read',
      description: '检索 Agent 对用户的长期记忆（事实、偏好、人物关系、承诺、惯例）。系统提示里已带了最相关的几条，需要更多时再用。',
      params: { type: 'object', properties: { query: { type: 'string' }, scope: { type: 'string', enum: ['fact', 'preference', 'person', 'commitment', 'routine'] }, limit: LIMIT(10, 30) } },
      run(a) {
        let list = store.listMemories((a.scope as never) ?? 'all').filter(m => m.status === 'active')
        if (a.query) {
          const terms = searchTerms(a.query)
          if (terms.length) list = rankByTerms(list, terms, m => ({ title: m.title, body: `${m.content} ${m.entity}` })).map(x => x.item)
        }
        const out = list.slice(0, a.limit)
        return {
          data: out.map(m => ({ id: m.id, scope: m.scope, title: m.title, content: m.content, ...(m.entity ? { entity: m.entity } : {}), updated: fmtDay(m.updatedAt) })),
          summary: out.length ? `${out.length} 条记忆` : '没有相关记忆',
          refs: out.slice(0, 6).map(m => ({ type: 'memory' as const, id: m.id, label: m.title }))
        }
      }
    },
    {
      name: 'memory_save',
      title: '记住',
      domain: 'memory',
      risk: 'write',
      description: '把一条长期有价值的信息记进 Agent 记忆（scope：fact 事实 / preference 偏好 / person 人物关系 / commitment 承诺 / routine 惯例），以后起草、问答都会参考。',
      params: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['fact', 'preference', 'person', 'commitment', 'routine'], default: 'fact' },
          title: { type: 'string', description: '≤18 字标题' },
          content: { type: 'string', description: '一句话内容' },
          entity: { type: 'string', description: '关联的邮箱 / 域名（可选）' },
          reason: REASON
        },
        required: ['title', 'content']
      },
      preview: a => [`「${a.title}」${a.content}`],
      run(a) {
        const m = store.upsertMemory({ scope: a.scope, title: String(a.title).slice(0, 60), content: String(a.content).slice(0, 500), entity: (a.entity ?? '').toLowerCase(), source: 'manual', confidence: 1 })
        deps.event({ type: 'agent-changed' })
        return { data: { ok: true, id: m.id }, summary: `已记住「${m.title}」`, refs: [{ type: 'memory', id: m.id, label: m.title }] }
      }
    },

    // ======================================================== 联系人
    {
      name: 'contact_profile',
      title: '联系人画像',
      domain: 'contact',
      risk: 'read',
      description: '某个联系人（邮箱）或公司（域名）的画像：往来封数、我发给 TA 的封数、最近往来主题、Agent 记得的事。deep=true 时让 AI 生成关系总结（较慢）。',
      params: { type: 'object', properties: { addr: { type: 'string', description: '邮箱或域名' }, deep: { type: 'boolean', default: false } }, required: ['addr'] },
      async run(a) {
        const key = String(a.addr).trim().toLowerCase()
        const like = key.includes('@') ? key : `@${key}`
        const rows = store.db
          .prepare(`SELECT id, subject, from_name, from_addr, date FROM messages WHERE lower(from_addr) LIKE ? OR lower(to_json) LIKE ? ORDER BY date DESC LIMIT 200`)
          .all(`%${like}`, `%${like}%`) as any[]
        if (!rows.length) throw new ToolError(`没有找到与 ${key} 相关的邮件`)
        const mine = myAddrs()
        const sent = rows.filter(r => mine.has(String(r.from_addr ?? '').toLowerCase())).length
        const name = rows.find(r => r.from_name && !mine.has(String(r.from_addr).toLowerCase()))?.from_name ?? key
        const memories = store.listMemories('all').filter(m => m.status === 'active' && m.entity && (m.entity.includes(key.replace(/^@/, '')) || key.includes(m.entity)))
        const data: Record<string, unknown> = {
          name,
          key,
          mails: rows.length,
          sent_by_me: sent,
          first: fmtDay(rows[rows.length - 1].date),
          last: fmtDay(rows[0].date),
          recent: rows.slice(0, 10).map(r => `${fmtDay(r.date)} · ${subj(r.subject)}`),
          memories: memories.slice(0, 8).map(m => `${m.title}：${m.content}`)
        }
        if (a.deep) {
          const p = await deps.agent.profile(key)
          if (p.ok && p.profile) Object.assign(data, { summary: p.profile.summary, topics: p.profile.topTopics, key_facts: p.profile.keyFacts, reply_rate: p.profile.myReplyRate })
          else data.profile_error = p.error
        }
        return { data, summary: `${name} · ${rows.length} 封往来`, refs: [{ type: 'contact', id: key, label: String(name) }] }
      }
    },
    {
      name: 'top_contacts',
      title: '常联系的人',
      domain: 'contact',
      risk: 'read',
      description: '最近一段时间往来最多的联系人（排除系统 / 通知类地址），含我发给 TA 的封数。',
      params: { type: 'object', properties: { within_days: { type: 'integer', minimum: 1, maximum: 3650, default: 90 }, limit: LIMIT(10, 30) } },
      run(a) {
        const since = Date.now() - a.within_days * DAY
        const mine = myAddrs()
        const list = store
          .contactStats()
          .filter(c => c.lastAt >= since && !mine.has(c.address) && !isRobotAddr(c.address))
          .sort((x, y) => y.total + y.sentByMe * 2 - (x.total + x.sentByMe * 2))
          .slice(0, a.limit)
        return {
          data: list.map(c => ({ name: c.name || c.address, address: c.address, mails: c.total, sent_by_me: c.sentByMe, last: fmtDay(c.lastAt) })),
          summary: `${list.length} 位`,
          refs: list.slice(0, 6).map(c => ({ type: 'contact' as const, id: c.address, label: c.name || c.address }))
        }
      }
    },

    // ======================================================== 日历 / 时间
    {
      name: 'calendar_busy',
      title: '查日程',
      domain: 'calendar',
      risk: 'read',
      description: '查询已连接的外部日历（Apple / Google / Outlook）在一段时间内的忙碌时段，用来安排会议或回复时间。没有连接日历时返回空。',
      params: { type: 'object', properties: { from: { type: 'string', description: '开始日期，默认今天' }, to: { type: 'string', description: '结束日期（含），默认 7 天后' } } },
      async run(a) {
        const from = a.from ? parseWhen(a.from, new Date(), '00:00') : new Date(new Date().setHours(0, 0, 0, 0)).getTime()
        const toDay = a.to ? parseWhen(a.to, new Date(), '00:00') : (from ?? Date.now()) + 7 * DAY
        if (!from || !toDay) throw new ToolError('日期看不懂，用 YYYY-MM-DD')
        const blocks = ((await deps.call('calendarBusyBlocks', [from, toDay + DAY - 1]).catch(() => [])) as { start: number; end: number; title: string; provider: string }[]) ?? []
        return {
          data: { from: fmtDay(from), to: fmtDay(toDay), busy: blocks.slice(0, 60).map(b => ({ start: fmtTime(b.start), end: fmtTime(b.end), title: b.title, calendar: b.provider })), ...(blocks.length ? {} : { note: '这段时间没有忙碌时段（也可能还没连接日历）' }) },
          summary: blocks.length ? `${blocks.length} 个忙碌时段` : '没有忙碌时段'
        }
      }
    },
    {
      name: 'now',
      title: '当前时间',
      domain: 'system',
      risk: 'read',
      description: '当前日期时间、星期、时区，以及用户的邮件账户列表。',
      params: { type: 'object', properties: {} },
      run() {
        const d = new Date()
        return {
          data: { now: fmtTime(d.getTime()), date: ymd(d), weekday: WEEKDAY[d.getDay()], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, accounts: store.listAccounts().map(x => `${x.name} <${x.email}>`) },
          summary: `${ymd(d)} ${WEEKDAY[d.getDay()]}`
        }
      }
    },
    {
      name: 'resolve_date',
      title: '换算日期',
      domain: 'system',
      risk: 'read',
      description: '把相对日期换算成具体日期：今天 / 明天 / 后天 / 下周三 / 3天后 / 月底 / 10月20日 等。',
      params: { type: 'object', properties: { expr: { type: 'string', description: '相对日期说法' } }, required: ['expr'] },
      run(a) {
        const r = resolveDate(a.expr)
        if (!r) throw new ToolError(`「${a.expr}」换算不了，换个说法（如「下周三」「3天后」「2026-10-20」）`)
        const [y, m, dd] = r.split('-').map(Number)
        const wd = WEEKDAY[new Date(y, m - 1, dd).getDay()]
        return { data: { expr: a.expr, date: r, weekday: wd }, summary: `${a.expr} = ${r} ${wd}` }
      }
    },

    // ======================================================== 生活档案（life_list / life_create / life_update）
    ...lifeAgentTools({ store, fail: m => new ToolError(m) })
  ]

  // 写操作统一要求 reason（说明理由），没声明的补上
  for (const t of tools) {
    if (t.risk !== 'read' && t.params.properties && !t.params.properties.reason) t.params.properties.reason = REASON
  }
  return tools
}

/** attachment_search 结果里的正文状态：已提取 → 「有正文 · 3 页」；能提取但还没提取 → 「可读取」 */
function attachmentTextLabel(ext: string, info: { method: string; pages: number; chars: number } | undefined): string | null {
  if (info) return info.method === 'none' ? '无文字（扫描件等）' : `有正文 · ${info.pages > 1 ? `${info.pages} 页 · ` : ''}${info.chars} 字`
  return /^(pdf|txt|csv|tsv|md|markdown|html?|eml|json|xml|log|docx?|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp)$/i.test(ext || '') ? '可用 read_attachment 读取' : null
}

export function toolInfo(t: AgentTool): AgentToolInfo {
  return { name: t.name, title: t.title, description: t.description, risk: t.risk as AgentToolRisk, domain: t.domain as AgentDomain }
}

/** 回退协议里的工具清单（一行一个：名称：说明；参数） */
export function toolListText(tools: AgentTool[]): string {
  return tools
    .map(t => {
      const props = Object.entries(t.params.properties ?? {})
        .map(([k, s]) => `${k}${t.params.required?.includes(k) ? '*' : ''}${s.enum ? `(${s.enum.join('|')})` : s.type ? `:${s.type}` : ''}`)
        .join(', ')
      return `- ${t.name}：${t.title}。${t.description.split('。')[0]}；参数：${props || '无'}${t.risk === 'read' ? '' : t.risk === 'external' ? '【对外，需确认】' : '【写操作，需确认】'}`
    })
    .join('\n')
}
