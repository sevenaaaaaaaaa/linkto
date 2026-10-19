import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { hostOf, subjectPattern, type MineEvent } from './mine'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 操作记录保留 90 天、最多 2 万条 */
export const LOG_KEEP_DAYS = 90
export const LOG_MAX_ROWS = 20_000

/**
 * 新表（只新增，不改已有表）：
 *  - user_action_log：用户在界面上的手动操作（只记元数据：发件人 / 主题 / List-Id / 分类 / 未读与否，不存正文）
 *  - rule_suggestions：挖掘出的规则建议与用户的处理结果（接受 / 忽略 30 天 / 永不建议）
 */
export function ensureRuleSuggestTables(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_action_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      action TEXT NOT NULL,
      message_id TEXT NOT NULL,
      account_id TEXT,
      from_addr TEXT,
      from_domain TEXT,
      subject TEXT,
      subject_pattern TEXT,
      list_id TEXT,
      category TEXT,
      is_newsletter INTEGER DEFAULT 0,
      section TEXT,
      value TEXT,
      age_ms INTEGER,
      was_unread INTEGER DEFAULT 0,
      batch_id TEXT,
      batch_size INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_user_action_log_at ON user_action_log(at);
    CREATE TABLE IF NOT EXISTS rule_suggestions (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      domain TEXT,
      action_types TEXT DEFAULT '[]',
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      until INTEGER,
      rule_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rule_suggestions_fp ON rule_suggestions(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_rule_suggestions_status ON rule_suggestions(status);
  `)
}

const ready = new WeakSet<DatabaseSync>()
function ensure(db: DatabaseSync) {
  if (ready.has(db)) return
  ensureRuleSuggestTables(db)
  ready.add(db)
}

let inserts = 0

export function insertEvents(db: DatabaseSync, events: MineEvent[]) {
  if (!events.length) return
  ensure(db)
  const stmt = db.prepare(
    `INSERT INTO user_action_log (at, action, message_id, account_id, from_addr, from_domain, subject, subject_pattern, list_id, category, is_newsletter, section, value, age_ms, was_unread, batch_id, batch_size)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  for (const e of events) {
    stmt.run(
      e.at, e.action, e.messageId, e.accountId ?? null, e.fromAddr ?? '', e.fromDomain ?? '', (e.subject ?? '').slice(0, 300), e.subjectPattern ?? '',
      e.listId ?? null, e.category ?? null, e.isNewsletter ? 1 : 0, e.section ?? null, e.value ?? null, e.ageMs ?? null, e.wasUnread ? 1 : 0,
      e.batchId ?? null, e.batchSize ?? 1
    )
  }
  inserts += events.length
  if (inserts >= 200) {
    inserts = 0
    pruneLog(db, Date.now())
  }
}

export function pruneLog(db: DatabaseSync, now: number) {
  ensure(db)
  db.prepare('DELETE FROM user_action_log WHERE at < ?').run(now - LOG_KEEP_DAYS * 86_400_000)
  db.prepare(`DELETE FROM user_action_log WHERE id <= (SELECT id FROM user_action_log ORDER BY id DESC LIMIT 1 OFFSET ${LOG_MAX_ROWS})`).run()
}

export function loadEvents(db: DatabaseSync, since: number): MineEvent[] {
  ensure(db)
  const rows = db.prepare('SELECT * FROM user_action_log WHERE at >= ? ORDER BY at').all(since) as any[]
  return rows.map(r => ({
    at: r.at,
    action: r.action,
    messageId: r.message_id,
    accountId: r.account_id ?? '',
    fromAddr: r.from_addr ?? '',
    fromDomain: r.from_domain ?? '',
    subject: r.subject ?? '',
    subjectPattern: r.subject_pattern ?? '',
    listId: r.list_id ?? null,
    category: r.category ?? null,
    isNewsletter: !!r.is_newsletter,
    section: r.section ?? null,
    value: r.value ?? null,
    ageMs: r.age_ms ?? null,
    wasUnread: !!r.was_unread,
    batchId: r.batch_id ?? null,
    batchSize: r.batch_size ?? 1
  }))
}

// ---------------------------------------------------------------- 钩子

/**
 * 界面上的手动操作 → 要记录的动作。只记收件箱里的邮件（规则只作用于新到收件箱的邮件）。
 * markRead 不记：打开邮件就会自动标已读，分不出「习惯」。Agent / 规则 / MCP 走内部调用，不经过这里。
 */
function actionOf(method: string, args: any[], now: number): { ids: string[]; action: string; value: string | null } | null {
  const ids = Array.isArray(args[0]) ? (args[0] as unknown[]).map(String) : typeof args[0] === 'string' ? [args[0]] : []
  if (!ids.length) return null
  switch (method) {
    case 'moveMessages':
      return { ids, action: args[1] === 'archive' ? 'archive' : 'trash', value: null }
    case 'deleteMessages':
      return { ids, action: 'trash', value: null }
    case 'moveToFolder':
      return args[1] ? { ids, action: 'moveFolder', value: String(args[1]) } : null
    case 'markFlagged':
      return args[1] ? { ids, action: 'flag', value: null } : null
    case 'pinMessages':
      return args[1] ? { ids, action: 'pin', value: null } : null
    case 'snoozeMessages': {
      const until = Number(args[1])
      if (!Number.isFinite(until) || until <= now) return null
      return { ids, action: 'snooze', value: String(Math.max(1, Math.round((until - now) / 3_600_000))) }
    }
    case 'todoFromMessage':
      return { ids, action: 'createTodo', value: null }
    case 'unsubscribe':
      return { ids, action: 'unsubscribe', value: null }
    default:
      return null
  }
}

export const TRACKED_METHODS = new Set(['moveMessages', 'deleteMessages', 'moveToFolder', 'markFlagged', 'pinMessages', 'snoozeMessages', 'todoFromMessage', 'unsubscribe'])

/**
 * ipc.ts 的最小钩子：处理器执行前抓元数据（移走后邮件行就没了），成功后写入。
 * 返回 commit 函数（传入处理器结果）；不需要记录时返回 null。任何异常都吞掉，不影响操作本身。
 */
export function beginUserAction(db: DatabaseSync, method: string, args: unknown[]): ((result: unknown) => void) | null {
  if (!TRACKED_METHODS.has(method)) return null
  try {
    const now = Date.now()
    const a = actionOf(method, args as any[], now)
    if (!a) return null
    const ids = a.ids.slice(0, 500)
    const q = db.prepare(
      `SELECT m.id, m.account_id, m.from_addr, m.subject, m.list_id, m.category, m.is_newsletter, m.flags, m.date, f.special,
              (SELECT data FROM mail_ai WHERE message_id = m.id) AS ai
       FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?`
    )
    const batchId = ids.length > 1 ? randomUUID() : null
    const events: MineEvent[] = []
    for (const id of ids) {
      const r = q.get(id) as any
      if (!r || r.special !== 'inbox') continue
      let section: string | null = null
      try {
        section = r.ai ? JSON.parse(r.ai)?.section ?? null : null
      } catch {
        /* ignore */
      }
      const from = String(r.from_addr ?? '').toLowerCase()
      events.push({
        at: now,
        action: a.action,
        messageId: r.id,
        accountId: r.account_id,
        fromAddr: from,
        fromDomain: hostOf(from),
        subject: r.subject ?? '',
        subjectPattern: subjectPattern(r.subject),
        listId: r.list_id ?? null,
        category: r.category ?? null,
        isNewsletter: !!r.is_newsletter,
        section,
        value: a.value,
        ageMs: r.date ? Math.max(0, now - r.date) : null,
        wasUnread: !String(r.flags ?? '').includes('\\Seen'),
        batchId,
        batchSize: ids.length
      })
    }
    if (!events.length) return null
    return result => {
      // 没做成的不记：移动全部失败 / 没能转成待办 / 没有退订入口
      if (method === 'moveToFolder' && Number((result as any)?.ok ?? 1) === 0) return
      if (method === 'todoFromMessage' && !result) return
      if (method === 'unsubscribe' && (result as any)?.ok === false) return
      try {
        insertEvents(db, events)
      } catch (err) {
        console.error('[rule-suggest] log failed', err)
      }
    }
  } catch (err) {
    console.error('[rule-suggest] hook failed', err)
    return null
  }
}
