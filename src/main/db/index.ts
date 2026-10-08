import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  AccountConfig,
  AccountWithStatus,
  Address,
  Attachment,
  Folder,
  KbItem,
  MailTemplate,
  MessageCategory,
  MessageFull,
  MessagePage,
  MessageQuery,
  MessageSummary,
  Rule,
  Signature,
  AgentMemory,
  MemoryScope
} from '@shared/types'

export interface AccountRow extends AccountConfig {
  /* 同 AccountConfig */
}

function j<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

const C = String.fromCharCode(0)

function addrString(a: Address | null | undefined): string {
  if (!a) return ''
  return a.name ? `${a.name} <${a.address}>` : a.address
}

export interface MessageInsert {
  id: string
  accountId: string
  folderId: string
  folderPath: string
  uid: number
  threadId: string
  messageId: string | null
  inReplyTo: string | null
  references: string[]
  from: Address | null
  to: Address[]
  cc: Address[]
  replyTo: Address | null
  subject: string
  normSubject: string
  snippet: string
  text: string
  html: string | null
  date: number
  size: number
  flags: string[]
  hasAttachments: boolean
  category: MessageCategory
  isNewsletter: boolean
  listUnsubscribe: string | null
  listId: string | null
}

/** SQLite 数据层：账户 / 文件夹 / 邮件（含 FTS5）/ 规则 / 签名 / 模板 / 知识库 */
export class MailStore {
  constructor(public db: DatabaseSync) {}

  // ================= 账户 =================

  listAccounts(): AccountConfig[] {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as any[]
    return rows.map(r => ({
      id: r.id,
      provider: r.provider,
      name: r.name,
      email: r.email,
      color: r.color,
      enabled: !!r.enabled,
      signatureId: r.signature_id ?? null,
      imap: { host: r.imap_host, port: r.imap_port, secure: !!r.imap_secure },
      smtp: { host: r.smtp_host, port: r.smtp_port, secure: !!r.smtp_secure },
      user: r.user,
      createdAt: r.created_at
    }))
  }

  upsertAccount(a: AccountConfig) {
    this.db
      .prepare(
        `INSERT INTO accounts (id, provider, name, email, color, enabled, signature_id,
          imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, user, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, name=excluded.name, email=excluded.email,
           color=excluded.color, enabled=excluded.enabled, signature_id=excluded.signature_id,
           imap_host=excluded.imap_host, imap_port=excluded.imap_port, imap_secure=excluded.imap_secure,
           smtp_host=excluded.smtp_host, smtp_port=excluded.smtp_port, smtp_secure=excluded.smtp_secure, user=excluded.user`
      )
      .run(
        a.id, a.provider, a.name, a.email, a.color, a.enabled ? 1 : 0, a.signatureId,
        a.imap.host, a.imap.port, a.imap.secure ? 1 : 0,
        a.smtp.host, a.smtp.port, a.smtp.secure ? 1 : 0,
        a.user, a.createdAt
      )
  }

  deleteAccount(id: string) {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM folders WHERE account_id = ?').run(id)
    const msgs = this.db.prepare('SELECT id FROM messages WHERE account_id = ?').all(id) as any[]
    for (const m of msgs) this.deleteMessageCascade(m.id)
    this.db.prepare('DELETE FROM newsletter_senders WHERE account_id = ?').run(id)
  }

  deleteMessageCascade(id: string) {
    this.db.prepare('DELETE FROM attachments WHERE message_id = ?').run(id)
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM thread_map WHERE message_id = ?').run(id)
  }

  // ================= 文件夹 =================

  listFolders(): Folder[] {
    const rows = this.db.prepare('SELECT * FROM folders ORDER BY account_id, sort_order').all() as any[]
    return rows.map(r => ({
      id: r.id,
      accountId: r.account_id,
      path: r.path,
      name: r.name,
      special: (r.special ?? null) as Folder['special'],
      total: r.total,
      unread: r.unread,
      hidden: !!r.hidden
    }))
  }

  upsertFolder(f: {
    id: string; accountId: string; path: string; name: string
    special: Folder['special']; sortOrder: number; hidden: boolean
    uidValidity: number; lastSyncUid?: number; total?: number; unread?: number
  }) {
    this.db
      .prepare(
        `INSERT INTO folders (id, account_id, path, name, special, sort_order, hidden, uid_validity, last_sync_uid, total, unread)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, special=excluded.special, sort_order=excluded.sort_order,
           hidden=excluded.hidden, uid_validity=excluded.uid_validity,
           last_sync_uid=CASE WHEN excluded.uid_validity != folders.uid_validity THEN 0 ELSE folders.last_sync_uid END`
      )
      .run(f.id, f.accountId, f.path, f.name, f.special, f.sortOrder, f.hidden ? 1 : 0, f.uidValidity, f.lastSyncUid ?? 0, f.total ?? 0, f.unread ?? 0)
  }

  updateFolderCounters(folderId: string, total: number, unread: number) {
    this.db.prepare('UPDATE folders SET total = ?, unread = ? WHERE id = ?').run(total, unread, folderId)
  }

  getFolderLastSync(folderId: string): { lastSyncUid: number; uidValidity: number } {
    const r = this.db.prepare('SELECT last_sync_uid, uid_validity FROM folders WHERE id = ?').get(folderId) as any
    return { lastSyncUid: r?.last_sync_uid ?? 0, uidValidity: r?.uid_validity ?? 0 }
  }

  setFolderLastSync(folderId: string, uid: number) {
    this.db.prepare('UPDATE folders SET last_sync_uid = ? WHERE id = ?').run(uid, folderId)
  }

  // ================= 邮件 =================

  /** 已知的 message_id → thread_id 映射，用于会话归并 */
  resolveThreadId(accountId: string, normSubject: string, references: string[], inReplyTo: string | null, newId: string): string {
    const stmt = this.db.prepare('SELECT thread_id FROM thread_map WHERE message_id = ?')
    for (const ref of [...references, inReplyTo].filter(Boolean) as string[]) {
      const row = stmt.get(ref) as any
      if (row) return row.thread_id
    }
    const bySubject = this.db
      .prepare('SELECT thread_id FROM messages WHERE account_id = ? AND norm_subject = ? LIMIT 1')
      .get(accountId, normSubject) as any
    if (bySubject) return bySubject.thread_id
    return newId
  }

  insertMessage(m: MessageInsert): boolean {
    const existing = this.db.prepare('SELECT id FROM messages WHERE id = ?').get(m.id)
    if (existing) return false
    this.db
      .prepare(
        `INSERT INTO messages (id, account_id, folder_id, folder_path, uid, thread_id, message_id, in_reply_to,
          references_txt, from_name, from_addr, to_json, cc_json, reply_to_json, subject, norm_subject, snippet, text, html,
          date, size, flags, has_attachments, category, is_newsletter, list_unsubscribe, list_id, body_fetched, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        m.id, m.accountId, m.folderId, m.folderPath, m.uid, m.threadId, m.messageId, m.inReplyTo,
        JSON.stringify(m.references), m.from?.name ?? null, m.from?.address ?? null,
        JSON.stringify(m.to), JSON.stringify(m.cc), m.replyTo ? JSON.stringify(m.replyTo) : null,
        m.subject, m.normSubject, m.snippet, m.text, m.html,
        m.date, m.size, m.flags.join(' '), m.hasAttachments ? 1 : 0, m.category, m.isNewsletter ? 1 : 0,
        m.listUnsubscribe, m.listId, m.html != null || m.text ? 1 : 0, Date.now()
      )
    if (m.messageId) {
      this.db
        .prepare('INSERT OR REPLACE INTO thread_map (message_id, thread_id) VALUES (?, ?)')
        .run(m.messageId, m.threadId)
    }
    return true
  }

  updateMessageFlags(id: string, flags: string[]) {
    this.db.prepare('UPDATE messages SET flags = ? WHERE id = ?').run(flags.join(' '), id)
  }

  updateMessageBody(id: string, opts: { html: string | null; text: string; snippet: string }) {
    this.db
      .prepare('UPDATE messages SET html = ?, text = ?, snippet = ?, body_fetched = 1 WHERE id = ?')
      .run(opts.html, opts.text, opts.snippet, id)
  }

  private rowToSummary(r: any): MessageSummary {
    return {
      id: r.id,
      accountId: r.account_id,
      folderId: r.folder_id,
      folderPath: r.folder_path,
      uid: r.uid,
      threadId: r.thread_id,
      messageId: r.message_id,
      inReplyTo: r.in_reply_to,
      from: r.from_addr ? { name: r.from_name ?? undefined, address: r.from_addr } : null,
      to: j<Address[]>(r.to_json, []),
      cc: j<Address[]>(r.cc_json, []),
      replyTo: r.reply_to_json ? j<Address>(r.reply_to_json, null as never) : null,
      subject: r.subject ?? '',
      snippet: r.snippet ?? '',
      date: r.date ?? 0,
      size: r.size ?? 0,
      unread: !(r.flags ?? '').includes('\\Seen'),
      flagged: (r.flags ?? '').includes('\\Flagged'),
      answered: (r.flags ?? '').includes('\\Answered'),
      forwarded: (r.flags ?? '').includes('$Forwarded') || (r.flags ?? '').includes('\\Forwarded'),
      hasAttachments: !!r.has_attachments,
      hasDraft: false,
      category: (r.category ?? 'personal') as MessageCategory,
      isNewsletter: !!r.is_newsletter,
      listUnsubscribe: r.list_unsubscribe ?? null,
      savedToKb: !!r.saved_kb,
      aiSummarized: !!r.ai_summarized,
      pinned: !!r.pinned
    }
  }

  // ================= 置顶（pin） =================

  setPinned(ids: string[], pinned: boolean) {
    const clear = this.db.prepare('UPDATE messages SET pinned = 0, pinned_order = NULL WHERE id = ?')
    const pin = this.db.prepare('UPDATE messages SET pinned = 1, pinned_order = ? WHERE id = ?')
    let next = (this.db.prepare('SELECT COALESCE(MAX(pinned_order), 0) AS m FROM messages WHERE pinned = 1').get() as any).m as number
    for (const id of ids) {
      if (pinned) {
        next += 1
        pin.run(next, id)
      } else {
        clear.run(id)
      }
    }
  }

  /** 魔法排序：按给定顺序重写 pin 顺序 */
  setPinnedOrder(ids: string[]) {
    const stmt = this.db.prepare('UPDATE messages SET pinned = 1, pinned_order = ? WHERE id = ?')
    ids.forEach((id, i) => stmt.run(i + 1, id))
  }

  getMessageRow(id: string): any | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any
  }

  getMessageFull(id: string): MessageFull | null {
    const r = this.getMessageRow(id)
    if (!r) return null
    const atts = this.db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY id').all(id) as any[]
    return {
      ...this.rowToSummary(r),
      html: r.html ?? null,
      text: r.text ?? null,
      references: j<string[]>(r.references_txt, []),
      listId: r.list_id ?? null,
      attachments: atts.map(a => ({
        id: a.id,
        messageId: a.message_id,
        filename: a.filename ?? '附件',
        contentType: a.content_type ?? 'application/octet-stream',
        size: a.size ?? 0,
        inline: !!a.inline,
        contentId: a.content_id ?? undefined
      }))
    }
  }

  getMessages(query: MessageQuery): MessagePage {
    const where: string[] = []
    const params: string[] = []
    if (query.scope === 'unified') {
      where.push("m.folder_path = 'INBOX'")
    } else if (query.scope === 'folder' && query.folderId) {
      where.push('m.folder_id = ?')
      params.push(query.folderId)
    } else if (query.scope === 'account' && query.accountId) {
      where.push('m.account_id = ?')
      params.push(query.accountId)
      where.push("m.folder_path = 'INBOX'")
    } else if (query.scope === 'flagged') {
      where.push("m.flags LIKE '%\\Flagged%'")
    } else if (query.scope === 'unread') {
      where.push("m.flags NOT LIKE '%\\Seen%'")
      where.push("m.folder_path = 'INBOX'")
    } else if (query.scope === 'newsletter') {
      where.push('m.is_newsletter = 1')
    } else if (query.scope === 'category' && query.category) {
      where.push('m.category = ?')
      params.push(query.category)
      where.push("m.folder_path = 'INBOX'")
    } else if (query.scope === 'pinned') {
      where.push('m.pinned = 1')
    }
    let whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const baseParams = [...params]
    if (query.scope === 'search') {
      if (!query.search?.trim()) return { items: [], total: 0 }
      const results = this.searchIds(query.search, 2000)
      if (results.length === 0) return { items: [], total: 0 }
      whereSql = `WHERE m.id IN (${results.map(() => '?').join(',')})`
      baseParams.push(...results)
    }
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM messages m ${whereSql}`).get(...baseParams) as any
    ).c as number
    // 置顶视图：按 pin 顺序（魔法排序写入）排列，未排序的按时间
    const orderSql =
      query.scope === 'pinned'
        ? 'ORDER BY (m.pinned_order IS NULL) ASC, m.pinned_order ASC, m.date DESC'
        : 'ORDER BY m.date DESC'
    const rows = this.db
      .prepare(`SELECT * FROM messages m ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
      .all(...baseParams, query.limit, query.offset) as any[]
    return { items: rows.map(r => this.rowToSummary(r)), total }
  }
  searchIds(q: string, limit: number): string[] {
    const trimmed = q.trim()
    if (!trimmed) return []
    const charCount = [...trimmed].length
    if (charCount >= 3) {
      try {
        const ftsQuery = [...trimmed]
          .map(c => (/[a-zA-Z0-9]/.test(c) ? `"${c}"*` : `"${c}"`))
          .join(' ')
        const rows = this.db
          .prepare(
            `SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? ORDER BY m.date DESC LIMIT ?`
          )
          .all(ftsQuery, limit) as any[]
        if (rows.length) return rows.map(r => r.id)
      } catch {
        /* FTS 语法错误时回退 LIKE */
      }
    }
    const like = `%${trimmed.replace(/[%_]/g, '')}%`
    const rows = this.db
      .prepare(
        `SELECT id FROM messages WHERE subject LIKE ? OR from_name LIKE ? OR from_addr LIKE ? OR snippet LIKE ? OR text LIKE ? ORDER BY date DESC LIMIT ?`
      )
      .all(like, like, like, like, like, limit) as any[]
    return rows.map(r => r.id)
  }

  setCategory(ids: string[], category: MessageCategory) {
    const stmt = this.db.prepare('UPDATE messages SET category = ? WHERE id = ?')
    for (const id of ids) stmt.run(category, id)
  }

  setNewsletterFlag(id: string, is: boolean) {
    this.db.prepare('UPDATE messages SET is_newsletter = ? WHERE id = ?').run(is ? 1 : 0, id)
  }

  setSavedKb(id: string, saved: boolean) {
    this.db.prepare('UPDATE messages SET saved_kb = ? WHERE id = ?').run(saved ? 1 : 0, id)
  }

  setAiSummarized(id: string) {
    this.db.prepare('UPDATE messages SET ai_summarized = 1 WHERE id = ?').run(id)
  }

  /** 需要分类的最近邮件（未分类或全部） */
  getRecentForClassify(limit: number): MessageSummary[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE folder_path = 'INBOX' ORDER BY date DESC LIMIT ?`
      )
      .all(limit) as any[]
    return rows.map(r => this.rowToSummary(r))
  }

  unreadCounts(): { accountId: string; unread: number }[] {
    const rows = this.db
      .prepare(
        `SELECT account_id, COUNT(*) AS unread FROM messages
         WHERE folder_path = 'INBOX' AND flags NOT LIKE '%\\Seen%' GROUP BY account_id`
      )
      .all() as any[]
    return rows.map(r => ({ accountId: r.account_id, unread: r.unread }))
  }

  // ================= 附件 =================

  addAttachment(a: Attachment & { path: string }) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO attachments (id, message_id, filename, content_type, size, inline, content_id, path)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(a.id, a.messageId, a.filename, a.contentType, a.size, a.inline ? 1 : 0, a.contentId ?? null, a.path)
  }

  getAttachment(id: string): (Attachment & { path: string }) | null {
    const a = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as any
    if (!a) return null
    return {
      id: a.id,
      messageId: a.message_id,
      filename: a.filename ?? 'attachment',
      contentType: a.content_type ?? 'application/octet-stream',
      size: a.size ?? 0,
      inline: !!a.inline,
      contentId: a.content_id ?? undefined,
      path: a.path
    }
  }

  // ================= 签名 / 模板 / 规则 =================

  listSignatures(): Signature[] {
    const rows = this.db.prepare('SELECT * FROM signatures ORDER BY name').all() as any[]
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      html: r.html,
      defaults: j<string[]>(r.defaults, []),
      updatedAt: r.updated_at
    }))
  }

  saveSignature(s: Signature) {
    this.db
      .prepare(
        `INSERT INTO signatures (id, name, html, defaults, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, html=excluded.html, defaults=excluded.defaults, updated_at=excluded.updated_at`
      )
      .run(s.id, s.name, s.html, JSON.stringify(s.defaults), s.updatedAt)
  }

  deleteSignature(id: string) {
    this.db.prepare('DELETE FROM signatures WHERE id = ?').run(id)
  }

  listTemplates(): MailTemplate[] {
    const rows = this.db.prepare('SELECT * FROM templates ORDER BY updated_at DESC').all() as any[]
    return rows.map(r => ({ id: r.id, name: r.name, to: r.to_addr ?? '', subject: r.subject ?? '', html: r.html ?? '', updatedAt: r.updated_at }))
  }

  saveTemplate(t: MailTemplate) {
    this.db
      .prepare(
        `INSERT INTO templates (id, name, to_addr, subject, html, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, to_addr=excluded.to_addr, subject=excluded.subject, html=excluded.html, updated_at=excluded.updated_at`
      )
      .run(t.id, t.name, t.to, t.subject, t.html, t.updatedAt)
  }

  deleteTemplate(id: string) {
    this.db.prepare('DELETE FROM templates WHERE id = ?').run(id)
  }

  listRules(): Rule[] {
    const rows = this.db.prepare('SELECT * FROM rules ORDER BY sort_order').all() as any[]
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      enabled: !!r.enabled,
      order: r.sort_order,
      conditions: j<Rule['conditions']>(r.conditions, []),
      actions: j<Rule['actions']>(r.actions, [])
    }))
  }

  saveRule(r: Rule) {
    this.db
      .prepare(
        `INSERT INTO rules (id, name, enabled, sort_order, conditions, actions) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, sort_order=excluded.sort_order,
           conditions=excluded.conditions, actions=excluded.actions`
      )
      .run(r.id, r.name, r.enabled ? 1 : 0, r.order, JSON.stringify(r.conditions), JSON.stringify(r.actions))
  }

  deleteRule(id: string) {
    this.db.prepare('DELETE FROM rules WHERE id = ?').run(id)
  }

  // ================= 草稿 =================

  saveDraft(d: { id: string; accountId: string; to: Address[]; cc: Address[]; bcc: Address[]; subject: string; html: string; updatedAt: number; sendAt?: number | null }) {
    this.db
      .prepare(
        `INSERT INTO drafts (id, account_id, to_json, cc_json, bcc_json, subject, html, updated_at, send_at) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET to_json=excluded.to_json, cc_json=excluded.cc_json, bcc_json=excluded.bcc_json,
           subject=excluded.subject, html=excluded.html, updated_at=excluded.updated_at, send_at=excluded.send_at`
      )
      .run(d.id, d.accountId, JSON.stringify(d.to), JSON.stringify(d.cc), JSON.stringify(d.bcc), d.subject, d.html, d.updatedAt, d.sendAt ?? null)
  }

  listDrafts(): any[] {
    const rows = this.db.prepare('SELECT * FROM drafts ORDER BY updated_at DESC').all() as any[]
    return rows.map(r => ({
      id: r.id,
      accountId: r.account_id,
      to: j<Address[]>(r.to_json, []),
      cc: j<Address[]>(r.cc_json, []),
      bcc: j<Address[]>(r.bcc_json, []),
      subject: r.subject,
      html: r.html,
      updatedAt: r.updated_at,
      sendAt: r.send_at ?? null
    }))
  }

  deleteDraft(id: string) {
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
  }

  // ================= 发件队列（延迟 / 定时发送） =================

  private draftRowToScheduled(r: any): { id: string; accountId: string; to: Address[]; cc: Address[]; bcc: Address[]; subject: string; html: string; sendAt: number } {
    return {
      id: r.id,
      accountId: r.account_id,
      to: j<Address[]>(r.to_json, []),
      cc: j<Address[]>(r.cc_json, []),
      bcc: j<Address[]>(r.bcc_json, []),
      subject: r.subject,
      html: r.html,
      sendAt: r.send_at
    }
  }

  listScheduled(): { id: string; accountId: string; to: Address[]; cc: Address[]; bcc: Address[]; subject: string; html: string; sendAt: number }[] {
    const rows = this.db.prepare('SELECT * FROM drafts WHERE send_at IS NOT NULL ORDER BY send_at').all() as any[]
    return rows.map(r => this.draftRowToScheduled(r))
  }

  dueScheduled(now: number): { id: string; accountId: string; to: Address[]; cc: Address[]; bcc: Address[]; subject: string; html: string; sendAt: number }[] {
    const rows = this.db.prepare('SELECT * FROM drafts WHERE send_at IS NOT NULL AND send_at <= ? ORDER BY send_at').all(now) as any[]
    return rows.map(r => this.draftRowToScheduled(r))
  }

  // ================= 智能洞察 =================

  insertInsight(i: { id: string; kind: string; accountId?: string | null; messageId?: string | null; title: string; data: Record<string, unknown>; dueAt?: number | null; period?: string | null }) {
    this.db
      .prepare(
        `INSERT INTO insights (id, kind, account_id, message_id, title, data_json, status, due_at, period, created_at)
         VALUES (?,?,?,?,?,?, 'open', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, data_json=excluded.data_json, due_at=excluded.due_at, period=excluded.period`
      )
      .run(i.id, i.kind, i.accountId ?? null, i.messageId ?? null, i.title, JSON.stringify(i.data), i.dueAt ?? null, i.period ?? null, Date.now())
  }

  listInsights(kind: string): any[] {
    const rows =
      kind === 'all'
        ? (this.db.prepare('SELECT * FROM insights ORDER BY created_at DESC LIMIT 500').all() as any[])
        : (this.db.prepare('SELECT * FROM insights WHERE kind = ? ORDER BY created_at DESC LIMIT 500').all(kind) as any[])
    return rows.map(r => ({
      id: r.id,
      kind: r.kind,
      messageId: r.message_id,
      accountId: r.account_id,
      title: r.title,
      status: r.status,
      dueAt: r.due_at,
      period: r.period,
      createdAt: r.created_at,
      data: j<Record<string, unknown>>(r.data_json, {})
    }))
  }

  setInsightStatus(id: string, status: string) {
    this.db.prepare('UPDATE insights SET status = ? WHERE id = ?').run(status, id)
  }

  deleteInsight(id: string) {
    this.db.prepare('DELETE FROM insights WHERE id = ?').run(id)
  }

  latestInsight(kind: string, period: string): any | undefined {
    const r = this.db
      .prepare('SELECT * FROM insights WHERE kind = ? AND period = ? ORDER BY created_at DESC LIMIT 1')
      .get(kind, period) as any
    if (!r) return undefined
    return { id: r.id, kind: r.kind, messageId: r.message_id, accountId: r.account_id, title: r.title, status: r.status, dueAt: r.due_at, period: r.period, createdAt: r.created_at, data: j<Record<string, unknown>>(r.data_json, {}) }
  }

  /** 发件人域名榜：公司洞察选择器数据源 */
  listCompanyDomains(): { domain: string; name: string; count: number }[] {
    const rows = this.db
      .prepare(
        `SELECT from_addr AS addr, MAX(from_name) AS name, COUNT(*) AS count
         FROM messages WHERE from_addr IS NOT NULL AND from_addr LIKE '%@%'
         GROUP BY from_addr ORDER BY count DESC LIMIT 400`
      )
      .all() as { addr: string; name: string; count: number }[]
    const byDomain = new Map<string, { domain: string; name: string; count: number }>()
    for (const r of rows) {
      const domain = r.addr.split('@').pop()!.toLowerCase()
      if (/^(gmail|qq|163|126|outlook|hotmail|icloud|yahoo|foxmail|sina|139)\./.test(domain)) continue
      const cur = byDomain.get(domain)
      if (cur) {
        cur.count += r.count
        if (!cur.name && r.name) cur.name = r.name
      } else {
        byDomain.set(domain, { domain, name: r.name ?? '', count: r.count })
      }
    }
    return [...byDomain.values()].sort((a, b) => b.count - a.count)
  }

  // ================= Newsletter 发件人 =================

  upsertNewsletterSender(accountId: string, sender: string) {
    this.db
      .prepare(
        `INSERT INTO newsletter_senders (account_id, sender, subscribed, count, latest_at) VALUES (?, ?, 1, 1, ?)
         ON CONFLICT(account_id, sender) DO UPDATE SET count = count + 1, latest_at = excluded.latest_at`
      )
      .run(accountId, sender, Date.now())
  }

  listNewsletterSenders(): { sender: string; subscribed: boolean; count: number; latestAt: number }[] {
    const rows = this.db
      .prepare('SELECT sender, subscribed, SUM(count) AS count, MAX(latest_at) AS latest_at FROM newsletter_senders GROUP BY sender ORDER BY latest_at DESC')
      .all() as any[]
    return rows.map(r => ({ sender: r.sender, subscribed: !!r.subscribed, count: r.count, latestAt: r.latest_at }))
  }

  setNewsletterSubscribed(sender: string, subscribed: boolean) {
    this.db.prepare('UPDATE newsletter_senders SET subscribed = ? WHERE sender = ?').run(subscribed ? 1 : 0, sender)
  }

  // ================= 知识库 =================

  saveKbItem(k: KbItem) {
    this.db
      .prepare(
        `INSERT INTO kb_items (id, kind, title, content, source_message_id, source_label, tags, created_at) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, tags=excluded.tags`
      )
      .run(k.id, k.kind, k.title, k.content, k.sourceMessageId, k.sourceLabel, JSON.stringify(k.tags), k.createdAt)
  }

  listKbItems(): KbItem[] {
    const rows = this.db.prepare('SELECT * FROM kb_items ORDER BY created_at DESC').all() as any[]
    return rows.map(r => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      content: r.content,
      sourceMessageId: r.source_message_id,
      sourceLabel: r.source_label,
      tags: j<string[]>(r.tags, []),
      createdAt: r.created_at
    }))
  }

  deleteKbItem(id: string) {
    this.db.prepare('DELETE FROM kb_items WHERE id = ?').run(id)
  }

  updateKbItem(id: string, patch: Partial<Pick<KbItem, 'title' | 'content' | 'tags'>>) {
    const item = this.listKbItems().find(i => i.id === id)
    if (!item) return
    this.db
      .prepare('UPDATE kb_items SET title = ?, content = ?, tags = ? WHERE id = ?')
      .run(patch.title ?? item.title, patch.content ?? item.content, JSON.stringify(patch.tags ?? item.tags), id)
  }

  // ================= Agent 记忆 =================

  private memoryRow(r: any): AgentMemory {
    return {
      id: r.id,
      scope: r.scope,
      entity: r.entity ?? '',
      title: r.title,
      content: r.content ?? '',
      source: r.source ?? 'auto',
      sourceMessageId: r.source_message_id ?? null,
      confidence: Number(r.confidence ?? 0.8),
      useCount: Number(r.use_count ?? 0),
      lastUsedAt: r.last_used_at ?? null,
      status: r.status ?? 'active',
      createdAt: r.created_at ?? 0,
      updatedAt: r.updated_at ?? 0
    }
  }

  listMemories(scope?: MemoryScope | 'all'): AgentMemory[] {
    const rows = (
      scope && scope !== 'all'
        ? this.db.prepare('SELECT * FROM agent_memory WHERE scope = ? ORDER BY updated_at DESC').all(scope)
        : this.db.prepare('SELECT * FROM agent_memory ORDER BY updated_at DESC').all()
    ) as any[]
    return rows.map(r => this.memoryRow(r))
  }

  getMemory(id: string): AgentMemory | undefined {
    const r = this.db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(id) as any
    return r ? this.memoryRow(r) : undefined
  }

  /** 新增或更新记忆：同 scope+entity+title 视为同一条，更新内容并提升置信度 */
  upsertMemory(m: {
    id?: string
    scope: MemoryScope
    entity?: string
    title: string
    content: string
    source?: 'auto' | 'manual'
    sourceMessageId?: string | null
    confidence?: number
  }): AgentMemory {
    const now = Date.now()
    const existing = this.db
      .prepare('SELECT id FROM agent_memory WHERE scope = ? AND entity = ? AND title = ?')
      .get(m.scope, m.entity ?? '', m.title) as { id: string } | undefined
    if (existing) {
      this.db
        .prepare(
          `UPDATE agent_memory SET content = ?, confidence = ?, source_message_id = coalesce(?, source_message_id), updated_at = ? WHERE id = ?`
        )
        .run(m.content, Math.min(0.99, (this.getMemory(existing.id)?.confidence ?? 0.5) + 0.1), m.sourceMessageId ?? null, now, existing.id)
      return this.getMemory(existing.id)!
    }
    const id = m.id ?? `mem-${randomUUID()}`
    this.db
      .prepare(
        `INSERT INTO agent_memory (id, scope, entity, title, content, source, source_message_id, confidence, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,'active',?,?)`
      )
      .run(id, m.scope, m.entity ?? '', m.title, m.content, m.source ?? 'auto', m.sourceMessageId ?? null, m.confidence ?? 0.8, now, now)
    return this.getMemory(id)!
  }

  updateMemory(id: string, patch: Partial<Pick<AgentMemory, 'title' | 'content' | 'scope' | 'status'>>) {
    const cur = this.getMemory(id)
    if (!cur) return
    this.db
      .prepare('UPDATE agent_memory SET title = ?, content = ?, scope = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(patch.title ?? cur.title, patch.content ?? cur.content, patch.scope ?? cur.scope, patch.status ?? cur.status, Date.now(), id)
  }

  deleteMemory(id: string) {
    this.db.prepare('DELETE FROM agent_memory WHERE id = ?').run(id)
  }

  /** 记忆被 AI 上下文引用时调用：提升使用次数并刷新时间 */
  touchMemories(ids: string[]) {
    const now = Date.now()
    const stmt = this.db.prepare('UPDATE agent_memory SET use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?')
    for (const id of ids) stmt.run(now, now, id)
  }

  /** 记忆统计 */
  memoryStats(): { total: number; byScope: Record<string, number>; weekNew: number; topUsed: AgentMemory[] } {
    const total = (this.db.prepare('SELECT COUNT(*) c FROM agent_memory WHERE status = \'active\'').get() as any).c
    const byScopeRows = this.db
      .prepare('SELECT scope, COUNT(*) c FROM agent_memory WHERE status = \'active\' GROUP BY scope')
      .all() as { scope: string; c: number }[]
    const weekNew = (this.db.prepare('SELECT COUNT(*) c FROM agent_memory WHERE created_at > ?').get(Date.now() - 7 * 864e5) as any).c
    const topUsed = (this.db
      .prepare('SELECT * FROM agent_memory WHERE status = \'active\' ORDER BY use_count DESC, updated_at DESC LIMIT 5')
      .all() as any[]).map(r => this.memoryRow(r))
    return { total, byScope: Object.fromEntries(byScopeRows.map(r => [r.scope, r.c])), weekNew, topUsed }
  }

  // ================= 连接器 =================

  listConnectorInstances(): { id: string; manifestId: string; enabled: boolean; config: Record<string, string> }[] {
    const rows = this.db.prepare('SELECT * FROM connectors').all() as any[]
    return rows.map(r => ({ id: r.id, manifestId: r.manifest_id, enabled: !!r.enabled, config: j(r.config, {}) }))
  }

  saveConnectorInstance(i: { id: string; manifestId: string; enabled: boolean; config: Record<string, string> }) {
    this.db
      .prepare(
        `INSERT INTO connectors (id, manifest_id, enabled, config) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET manifest_id=excluded.manifest_id, enabled=excluded.enabled, config=excluded.config`
      )
      .run(i.id, i.manifestId, i.enabled ? 1 : 0, JSON.stringify(i.config))
  }

  deleteConnectorInstance(id: string) {
    this.db.prepare('DELETE FROM connectors WHERE id = ?').run(id)
  }

  // ================= 统计 =================

  counts(): { messages: number; accounts: number; kb: number } {
    const m = (this.db.prepare('SELECT COUNT(*) c FROM messages').get() as any).c
    const a = (this.db.prepare('SELECT COUNT(*) c FROM accounts').get() as any).c
    const k = (this.db.prepare('SELECT COUNT(*) c FROM kb_items').get() as any).c
    return { messages: m, accounts: a, kb: k }
  }

  static SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#3b82f6',
    enabled INTEGER NOT NULL DEFAULT 1,
    signature_id TEXT,
    imap_host TEXT NOT NULL,
    imap_port INTEGER NOT NULL,
    imap_secure INTEGER NOT NULL DEFAULT 1,
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL,
    smtp_secure INTEGER NOT NULL DEFAULT 1,
    user TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    special TEXT,
    sort_order INTEGER DEFAULT 0,
    hidden INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    unread INTEGER DEFAULT 0,
    last_sync_uid INTEGER DEFAULT 0,
    uid_validity INTEGER DEFAULT 0,
    UNIQUE(account_id, path)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    folder_path TEXT NOT NULL,
    uid INTEGER NOT NULL,
    thread_id TEXT,
    message_id TEXT,
    in_reply_to TEXT,
    references_txt TEXT,
    from_name TEXT,
    from_addr TEXT,
    to_json TEXT,
    cc_json TEXT,
    reply_to_json TEXT,
    subject TEXT DEFAULT '',
    norm_subject TEXT DEFAULT '',
    snippet TEXT DEFAULT '',
    text TEXT DEFAULT '',
    html TEXT,
    date INTEGER DEFAULT 0,
    size INTEGER DEFAULT 0,
    flags TEXT DEFAULT '',
    has_attachments INTEGER DEFAULT 0,
    category TEXT DEFAULT 'personal',
    is_newsletter INTEGER DEFAULT 0,
    list_unsubscribe TEXT,
    list_id TEXT,
    saved_kb INTEGER DEFAULT 0,
    ai_summarized INTEGER DEFAULT 0,
    body_fetched INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder_id, date DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id);
  CREATE INDEX IF NOT EXISTS idx_messages_normsub ON messages(account_id, norm_subject);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    subject, from_text, text, content='messages', content_rowid='rowid', tokenize='trigram'
  );
  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, subject, from_text, text)
    VALUES (new.rowid, new.subject, coalesce(new.from_name,'') || ' ' || coalesce(new.from_addr,''), coalesce(new.text,''));
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, from_text, text)
    VALUES ('delete', old.rowid, old.subject, coalesce(old.from_name,'') || ' ' || coalesce(old.from_addr,''), coalesce(old.text,''));
  END;
  CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF subject, from_name, from_addr, text, snippet ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, from_text, text)
    VALUES ('delete', old.rowid, old.subject, coalesce(old.from_name,'') || ' ' || coalesce(old.from_addr,''), coalesce(old.text,''));
    INSERT INTO messages_fts(rowid, subject, from_text, text)
    VALUES (new.rowid, new.subject, coalesce(new.from_name,'') || ' ' || coalesce(new.from_addr,''), coalesce(new.text,''));
  END;

  CREATE TABLE IF NOT EXISTS thread_map (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_threadmap_thread ON thread_map(thread_id);

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    filename TEXT,
    content_type TEXT,
    size INTEGER DEFAULT 0,
    inline INTEGER DEFAULT 0,
    content_id TEXT,
    path TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id);

  CREATE TABLE IF NOT EXISTS signatures (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    html TEXT DEFAULT '',
    defaults TEXT DEFAULT '[]',
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    to_addr TEXT DEFAULT '',
    subject TEXT DEFAULT '',
    html TEXT DEFAULT '',
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    conditions TEXT DEFAULT '[]',
    actions TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    to_json TEXT DEFAULT '[]',
    cc_json TEXT DEFAULT '[]',
    bcc_json TEXT DEFAULT '[]',
    subject TEXT DEFAULT '',
    html TEXT DEFAULT '',
    updated_at INTEGER,
    send_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS insights (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    account_id TEXT,
    message_id TEXT,
    title TEXT NOT NULL,
    data_json TEXT DEFAULT '{}',
    status TEXT DEFAULT 'open',
    due_at INTEGER,
    period TEXT,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_insights_kind ON insights(kind, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_insights_period ON insights(period);

  CREATE TABLE IF NOT EXISTS newsletter_senders (
    account_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    subscribed INTEGER DEFAULT 1,
    count INTEGER DEFAULT 0,
    latest_at INTEGER DEFAULT 0,
    PRIMARY KEY (account_id, sender)
  );

  CREATE TABLE IF NOT EXISTS kb_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    source_message_id TEXT,
    source_label TEXT,
    tags TEXT DEFAULT '[]',
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS connectors (
    id TEXT PRIMARY KEY,
    manifest_id TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    config TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS ai_runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_id TEXT,
    ok INTEGER DEFAULT 1,
    error TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS agent_memory (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    entity TEXT DEFAULT '',
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    source TEXT DEFAULT 'auto',
    source_message_id TEXT,
    confidence REAL DEFAULT 0.8,
    use_count INTEGER DEFAULT 0,
    last_used_at INTEGER,
    status TEXT DEFAULT 'active',
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory(scope, status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_agent_memory_entity ON agent_memory(entity);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_dedupe ON agent_memory(scope, entity, title);
  `
}
