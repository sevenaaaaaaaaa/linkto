import { app } from 'electron'
import { searchTerms, rankByTerms } from '../search-terms'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Address, MessageSummary } from '@shared/types'
import type { MailStore } from '../db'
import type { AppStore } from '../store'

/**
 * 本地 MCP 服务（Model Context Protocol · Streamable HTTP）：
 * 让 Claude Code / Claude Desktop / Cursor 等外部 Agent 读取邮件、管理待办、保存草稿。
 *  - 仅监听 127.0.0.1，Bearer token 鉴权，Origin 校验防 DNS rebinding
 *  - 只读邮件 + 写本地待办 / 本地草稿，绝不发信
 *  - 手写 JSON-RPC 2.0，无第三方依赖
 */

export interface McpSettings {
  enabled: boolean
  port: number
}

export const DEFAULT_MCP: McpSettings = { enabled: false, port: 39217 }

export interface McpStatus {
  enabled: boolean
  port: number
  running: boolean
  url: string
  token: string
  error?: string
}

export interface McpDeps {
  store: MailStore
  appStore: AppStore
  /** 广播事件给渲染进程（待办 / 草稿变更后刷新界面） */
  event(payload: unknown): void
}

const SETTINGS_KEY = 'mcp'
const TOKEN_ID = 'mcp:token'
const MAX_BODY = 1024 * 1024
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26']
const LATEST_VERSION = '2025-06-18'
const BODY_LIMIT_CHARS = 20_000

// ---------- JSON-RPC ----------

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

class ToolInputError extends Error {}

const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: '2.0' as const, id, error: { code, message } })
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0' as const, id, result })

// ---------- 参数校验 ----------

function str(args: Record<string, unknown>, key: string, required: true): string
function str(args: Record<string, unknown>, key: string, required?: false): string | undefined
function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolInputError(`缺少参数 ${key}（missing required argument "${key}"）`)
    return undefined
  }
  if (typeof v !== 'string') throw new ToolInputError(`参数 ${key} 必须是字符串（"${key}" must be a string）`)
  return v
}

function int(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const v = args[key]
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new ToolInputError(`参数 ${key} 必须是正整数（"${key}" must be a positive integer）`)
  return Math.min(v, max)
}

function bool(args: Record<string, unknown>, key: string): boolean {
  const v = args[key]
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') throw new ToolInputError(`参数 ${key} 必须是布尔值（"${key}" must be a boolean）`)
  return v
}

// ---------- 文本工具 ----------

const fmtAddr = (a: Address | null | undefined) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '')

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null)

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** 纯文本 → 最小 HTML：空行分段，段内换行转 <br> */
function textToHtml(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** 解析 "Name <a@b.c>" 或 "a@b.c" */
function parseAddress(raw: string): Address | null {
  const s = raw.trim()
  const m = s.match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/)
  if (m) {
    const name = m[1].replace(/^"|"$/g, '').trim()
    return name ? { name, address: m[2] } : { address: m[2] }
  }
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s) ? { address: s } : null
}

// ---------- 工具定义 ----------

const TOOLS = [
  {
    name: 'search_mail',
    description: '全文搜索本地邮件（主题、发件人、正文）。Full-text search over the user\'s local mail (subject, sender, body). Returns id, date, from, subject, snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词 / keywords' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      },
      required: ['query']
    }
  },
  {
    name: 'list_recent',
    description: '列出收件箱最新邮件（统一收件箱或指定账户）。List the newest inbox messages, optionally unread only or for one account.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        unread_only: { type: 'boolean', default: false },
        account_email: { type: 'string', description: '只看该账户 / only this account (email address)' }
      }
    }
  },
  {
    name: 'read_message',
    description: '读取一封邮件的完整内容（正文最多 20000 字）。Read a full message by id: headers, plain-text body (truncated to 20k chars), attachment names.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '邮件 id（来自 search_mail / list_recent）/ message id' } },
      required: ['id']
    }
  },
  {
    name: 'list_todos',
    description: '列出未完成的待办事项。List open to-do items tracked in LinkTo.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_todo',
    description: '新建一条待办，可关联邮件和截止日期。Create a to-do item, optionally with a due date and a related message.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        due: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '截止日期 / due date, YYYY-MM-DD' },
        message_id: { type: 'string', description: '关联邮件 id / related message id' }
      },
      required: ['title']
    }
  },
  {
    name: 'save_draft',
    description:
      '保存一封本地草稿（不会发送，用户需在 LinkTo 中检查后手动发送）。Save a LOCAL draft only — never sends mail; the user reviews and sends it from LinkTo.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: '收件人 / recipients, "a@b.com" or "Name <a@b.com>"' },
        subject: { type: 'string' },
        body: { type: 'string', description: '纯文本正文 / plain-text body' },
        reply_to_message_id: { type: 'string', description: '回复的邮件 id / message id being replied to' },
        account_email: { type: 'string', description: '发件账户 / sending account email' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'search_knowledge',
    description: '检索 LinkTo 知识库（收藏的邮件、笔记），返回最相关的 8 条。Search the LinkTo knowledge base; returns the top 8 items.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  }
]

// ---------- 服务 ----------

export class McpService {
  private server: Server | null = null
  private boundPort = 0
  private lastError = ''

  constructor(private deps: McpDeps) {}

  settings(): McpSettings {
    return this.deps.appStore.get(SETTINGS_KEY, DEFAULT_MCP)
  }

  private token(): string {
    let t = this.deps.appStore.loadSecret(TOKEN_ID)
    if (!t) {
      t = randomBytes(24).toString('base64url')
      this.deps.appStore.saveSecret(TOKEN_ID, t)
    }
    return t
  }

  status(): McpStatus {
    const s = this.settings()
    const port = this.server ? this.boundPort : s.port
    return {
      enabled: s.enabled,
      port: s.port,
      running: !!this.server,
      url: `http://127.0.0.1:${port}/mcp`,
      token: s.enabled ? this.token() : this.deps.appStore.loadSecret(TOKEN_ID),
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  /** 按当前设置启动或停止 */
  async apply(): Promise<void> {
    const s = this.settings()
    if (!s.enabled) {
      await this.stop()
      return
    }
    if (this.server && this.boundPort === s.port) return
    await this.stop()
    await this.start(s.port)
  }

  async setEnabled(enabled: boolean, port?: number): Promise<McpStatus> {
    const cur = this.settings()
    const next: McpSettings = { enabled, port: cur.port }
    if (port !== undefined) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口需在 1024–65535 之间')
      next.port = port
    }
    this.deps.appStore.set(SETTINGS_KEY, next)
    if (enabled) this.token()
    await this.apply()
    return this.status()
  }

  regenerateToken(): McpStatus {
    this.deps.appStore.saveSecret(TOKEN_ID, randomBytes(24).toString('base64url'))
    return this.status()
  }

  private start(port: number): Promise<void> {
    this.lastError = ''
    return new Promise(resolve => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch(err => {
          console.error('[mcp] request failed:', err)
          if (!res.headersSent) this.json(res, 500, rpcError(null, -32603, 'Internal error'))
          else res.end()
        })
      })
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.lastError = err.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : err.message
        console.error('[mcp] listen failed:', err)
        this.server = null
        resolve()
      })
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        this.boundPort = port
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.boundPort = 0
    if (!server) return Promise.resolve()
    return new Promise(resolve => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  // ---------- HTTP ----------

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  /** Origin 为空 / "null" / 本机 才放行（DNS rebinding 防护） */
  private originAllowed(origin: string | undefined): boolean {
    if (origin === undefined || origin === 'null') return true
    try {
      const host = new URL(origin).hostname
      return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
    } catch {
      return false
    }
  }

  private authorized(header: string | undefined): boolean {
    const m = header?.match(/^Bearer\s+(.+)$/i)
    if (!m) return false
    const expected = Buffer.from(this.token())
    const given = Buffer.from(m[1].trim())
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let tooLarge = false
      req.on('data', (c: Buffer) => {
        if (tooLarge) return
        size += c.length
        if (size > MAX_BODY) {
          tooLarge = true
          chunks.length = 0
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? '').split('?')[0]
    if (!this.originAllowed(req.headers.origin)) {
      this.json(res, 403, rpcError(null, -32000, 'Forbidden origin'))
      return
    }
    if (path !== '/mcp') {
      this.json(res, 404, rpcError(null, -32000, 'Not found'))
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      this.json(res, 405, rpcError(null, -32000, 'Method not allowed'))
      return
    }
    if (!this.authorized(req.headers.authorization)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      this.json(res, 401, rpcError(null, -32001, 'Unauthorized'))
      return
    }
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > MAX_BODY) {
      this.json(res, 413, rpcError(null, -32600, 'Request body too large'))
      req.resume()
      return
    }
    const raw = await this.readBody(req)
    if (raw === null) {
      this.json(res, 413, rpcError(null, -32600, 'Request body too large'))
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      this.json(res, 400, rpcError(null, -32700, 'Parse error'))
      return
    }
    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        this.json(res, 400, rpcError(null, -32600, 'Invalid Request'))
        return
      }
      const out = (await Promise.all(payload.map(p => this.dispatch(p)))).filter(Boolean)
      if (out.length) this.json(res, 200, out)
      else {
        res.writeHead(202)
        res.end()
      }
      return
    }
    const out = await this.dispatch(payload)
    if (out) this.json(res, 200, out)
    else {
      res.writeHead(202)
      res.end()
    }
  }

  /** 处理单条 JSON-RPC 消息；通知 / 响应返回 null */
  private async dispatch(msg: unknown): Promise<object | null> {
    if (!msg || typeof msg !== 'object') return rpcError(null, -32600, 'Invalid Request')
    const m = msg as Partial<JsonRpcRequest> & { result?: unknown; error?: unknown }
    const hasId = 'id' in m && m.id !== undefined
    const id: JsonRpcId = hasId ? (m.id as JsonRpcId) : null
    if (m.jsonrpc !== '2.0') return rpcError(id, -32600, 'Invalid Request')
    // 客户端发来的响应（本服务不发请求，直接忽略）
    if (typeof m.method !== 'string') return hasId && ('result' in m || 'error' in m) ? null : rpcError(id, -32600, 'Invalid Request')
    if (!hasId) return null // 通知：notifications/initialized、notifications/cancelled 等
    const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>
    switch (m.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        return rpcResult(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'linkto', version: app.getVersion() },
          instructions: 'LinkTo 本地邮件：可搜索/读取邮件、管理待办、保存本地草稿（不会发信）。LinkTo local mail: search/read mail, manage todos, save local drafts (never sends).'
        })
      }
      case 'ping':
        return rpcResult(id, {})
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS })
      case 'tools/call': {
        const name = params.name
        if (typeof name !== 'string') return rpcError(id, -32602, 'Invalid params: missing tool name')
        if (!TOOLS.some(t => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`)
        const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>
        return rpcResult(id, this.callTool(name, args))
      }
      default:
        return rpcError(id, -32601, `Method not found: ${m.method}`)
    }
  }

  private callTool(name: string, args: Record<string, unknown>): ToolResult {
    try {
      const data = this.runTool(name, args)
      return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
    } catch (err) {
      const text = err instanceof ToolInputError ? err.message : `执行失败（tool failed）：${err instanceof Error ? err.message : String(err)}`
      return { content: [{ type: 'text', text }], isError: true }
    }
  }

  // ---------- 工具实现 ----------

  private brief(m: MessageSummary) {
    return {
      id: m.id,
      date: iso(m.date),
      from: fmtAddr(m.from),
      subject: m.subject,
      snippet: m.snippet,
      unread: m.unread
    }
  }

  private accountByEmail(email: string) {
    const e = email.trim().toLowerCase()
    const acct = this.deps.store.listAccounts().find(a => a.email.toLowerCase() === e || a.user.toLowerCase() === e)
    if (!acct) throw new ToolInputError(`找不到账户 ${email}（no account with this email）`)
    return acct
  }

  private runTool(name: string, args: Record<string, unknown>): unknown {
    const { store } = this.deps
    switch (name) {
      case 'search_mail': {
        const query = str(args, 'query', true)
        const limit = int(args, 'limit', 20, 100)
        // 关键词先走全文检索；自然语言问句（中文无空格）整句搜不到时，按检索词逐个匹配排序
        let ids = store.searchIds(query, limit)
        if (!ids.length) ids = store.searchByTerms(searchTerms(query), limit).map(m => m.id)
        const results = ids
          .map(id => store.getMessageFull(id))
          .filter((m): m is NonNullable<typeof m> => !!m)
          .map(m => this.brief(m))
        return { count: results.length, results }
      }
      case 'list_recent': {
        const limit = int(args, 'limit', 20, 100)
        const unreadOnly = bool(args, 'unread_only')
        const email = str(args, 'account_email')
        const accountId = email ? this.accountByEmail(email).id : undefined
        // 指定账户 + 仅未读：取账户收件箱的较大窗口再过滤
        const page = accountId
          ? store.getMessages({ scope: 'account', accountId, limit: unreadOnly ? Math.min(limit * 10, 1000) : limit, offset: 0 })
          : store.getMessages({ scope: unreadOnly ? 'unread' : 'unified', limit, offset: 0 })
        const items = page.items.filter(m => !unreadOnly || m.unread).slice(0, limit)
        return { count: items.length, messages: items.map(m => this.brief(m)) }
      }
      case 'read_message': {
        const id = str(args, 'id', true)
        const m = store.getMessageFull(id)
        if (!m) throw new ToolInputError(`找不到邮件 ${id}（message not found）`)
        let body = m.text?.trim() || (m.html ? htmlToText(m.html) : '')
        const truncated = body.length > BODY_LIMIT_CHARS
        if (truncated) body = body.slice(0, BODY_LIMIT_CHARS)
        return {
          id: m.id,
          subject: m.subject,
          from: fmtAddr(m.from),
          to: m.to.map(fmtAddr),
          cc: m.cc.map(fmtAddr),
          date: iso(m.date),
          folder: m.folderPath,
          unread: m.unread,
          attachments: m.attachments.filter(a => !a.inline).map(a => a.filename),
          body,
          ...(truncated ? { truncated: true } : {})
        }
      }
      case 'list_todos': {
        const todos = store
          .listInsights('todo')
          .filter(t => t.status === 'open')
          .map(t => ({
            id: t.id,
            title: t.title,
            due: t.dueAt ? new Date(t.dueAt).toISOString().slice(0, 10) : null,
            message_id: t.messageId ?? null,
            created: iso(t.createdAt)
          }))
        return { count: todos.length, todos }
      }
      case 'create_todo': {
        const title = str(args, 'title', true).trim()
        if (!title) throw new ToolInputError('title 不能为空（title must not be empty）')
        const due = str(args, 'due')
        let dueAt: number | null = null
        if (due) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due))) throw new ToolInputError('due 需为 YYYY-MM-DD（due must be YYYY-MM-DD）')
          // 与 saveTodoSet 一致：Date.parse('YYYY-MM-DD')（UTC 零点）
          dueAt = Date.parse(due)
        }
        const messageId = str(args, 'message_id')
        let accountId: string | null = null
        if (messageId) {
          const row = store.getMessageRow(messageId)
          if (!row) throw new ToolInputError(`找不到邮件 ${messageId}（message not found）`)
          accountId = row.account_id
        }
        const id = `todo-mcp-${Date.now()}-${randomBytes(3).toString('hex')}`
        store.insertInsight({ id, kind: 'todo', accountId, messageId: messageId ?? null, title: title.slice(0, 500), data: { from: 'MCP' }, dueAt })
        this.deps.event({ type: 'insights-changed' })
        return { ok: true, id, title, due: due ?? null }
      }
      case 'save_draft': {
        const toRaw = args.to
        if (!Array.isArray(toRaw) || toRaw.length === 0 || toRaw.some(t => typeof t !== 'string'))
          throw new ToolInputError('to 必须是非空字符串数组（"to" must be a non-empty array of strings）')
        const to: Address[] = []
        for (const t of toRaw as string[]) {
          const a = parseAddress(t)
          if (!a) throw new ToolInputError(`收件人地址无效：${t}（invalid recipient）`)
          to.push(a)
        }
        let subject = typeof args.subject === 'string' ? args.subject : ''
        if (args.subject !== undefined && typeof args.subject !== 'string') throw new ToolInputError('subject 必须是字符串')
        const body = typeof args.body === 'string' ? args.body : ''
        if (args.body === undefined || typeof args.body !== 'string') throw new ToolInputError('缺少参数 body（missing "body"）')
        const replyId = str(args, 'reply_to_message_id')
        const replyRow = replyId ? store.getMessageRow(replyId) : undefined
        if (replyId && !replyRow) throw new ToolInputError(`找不到邮件 ${replyId}（message not found）`)
        const email = str(args, 'account_email')
        const accounts = store.listAccounts()
        const account = email
          ? this.accountByEmail(email)
          : (replyRow && accounts.find(a => a.id === replyRow.account_id)) || accounts.find(a => a.enabled) || accounts[0]
        if (!account) throw new ToolInputError('尚未添加任何邮件账户（no mail account configured）')
        if (!subject.trim() && replyRow?.subject) subject = `回复：${replyRow.subject}`
        const id = randomUUID()
        store.saveDraft({ id, accountId: account.id, to, cc: [], bcc: [], subject, html: textToHtml(body), updatedAt: Date.now() })
        this.deps.event({ type: 'outbox-changed' })
        return { ok: true, draft_id: id, account: account.email, note: '已保存为本地草稿，未发送；请在 LinkTo 草稿中检查后手动发送。Saved as a local draft only — not sent.' }
      }
      case 'search_knowledge': {
        const query = str(args, 'query', true)
        const terms = searchTerms(query)
        if (!terms.length) return { count: 0, items: [] }
        const items = rankByTerms(store.listKbItems(), terms, i => ({ title: i.title, body: `${i.content} ${i.tags.join(' ')}` }))
          .slice(0, 8)
          .map(({ item }) => ({ id: item.id, title: item.title, tags: item.tags, source: item.sourceLabel, content: item.content.slice(0, 1500) }))
        return { count: items.length, items }
      }
    }
    throw new ToolInputError(`未知工具 ${name}`)
  }
}
