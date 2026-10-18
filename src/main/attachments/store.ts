import type { DatabaseSync } from 'node:sqlite'
import type { AttachmentCategory, AttachmentCloudCopy, AttachmentItem, AttachmentQuery } from '@shared/attachments'

/**
 * 附件索引表（新增表，不改 attachments 原表——attachments 由同步引擎 INSERT OR REPLACE，
 * 加列会在重新下载时被冲掉）。一行 = 一个附件：
 *  - 已下载：id = attachments.id，cache_path 指向缓存文件
 *  - 仅元数据：id = r:<messageId>:<part>（来自 IMAP BODYSTRUCTURE），下载后合并到真实行
 * 用户状态（钉住 / 手动分类 / 网盘副本 / 哈希）在重建索引时保留。
 */
export const ATTACHMENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS attachment_index (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    filename TEXT DEFAULT '',
    content_type TEXT DEFAULT '',
    size INTEGER DEFAULT 0,
    ext TEXT DEFAULT '',
    category TEXT NOT NULL DEFAULT 'other',
    category_source TEXT NOT NULL DEFAULT 'rule',
    confidence REAL DEFAULT 0,
    ai_checked INTEGER DEFAULT 0,
    counterparty TEXT DEFAULT '',
    counterparty_addr TEXT DEFAULT '',
    direction TEXT DEFAULT 'in',
    subject TEXT DEFAULT '',
    date INTEGER DEFAULT 0,
    part TEXT,
    remote_only INTEGER DEFAULT 0,
    cached INTEGER DEFAULT 0,
    cache_path TEXT,
    hash TEXT,
    pinned INTEGER DEFAULT 0,
    released_at INTEGER,
    cloud_json TEXT DEFAULT '[]',
    indexed_at INTEGER,
    skip INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_attidx_msg ON attachment_index(message_id);
  CREATE INDEX IF NOT EXISTS idx_attidx_cat ON attachment_index(category, date DESC);
  CREATE INDEX IF NOT EXISTS idx_attidx_date ON attachment_index(date DESC);
  CREATE INDEX IF NOT EXISTS idx_attidx_hash ON attachment_index(hash);
  CREATE INDEX IF NOT EXISTS idx_attidx_party ON attachment_index(counterparty);
`

export interface IndexRow {
  id: string
  message_id: string
  account_id: string
  filename: string
  content_type: string
  size: number
  ext: string
  category: string
  category_source: string
  confidence: number
  ai_checked: number
  counterparty: string
  counterparty_addr: string
  direction: string
  subject: string
  date: number
  part: string | null
  remote_only: number
  cached: number
  cache_path: string | null
  hash: string | null
  pinned: number
  released_at: number | null
  cloud_json: string
  indexed_at: number
  /** 1 = 内联图片 / 签名小图等噪声：只登记不展示 */
  skip?: number
}

export interface IndexUpsert {
  id: string
  messageId: string
  accountId: string
  filename: string
  contentType: string
  size: number
  ext: string
  category: AttachmentCategory
  confidence: number
  counterparty: string
  counterpartyAddr: string
  direction: 'in' | 'out'
  subject: string
  date: number
  part: string | null
  remoteOnly: boolean
  cached: boolean
  cachePath: string | null
}

function parseCloud(s: string | null | undefined): AttachmentCloudCopy[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? (v as AttachmentCloudCopy[]) : []
  } catch {
    return []
  }
}

export function rowToItem(r: IndexRow): AttachmentItem {
  return {
    id: r.id,
    messageId: r.message_id,
    accountId: r.account_id,
    filename: r.filename || '附件',
    contentType: r.content_type || 'application/octet-stream',
    size: r.size ?? 0,
    ext: r.ext ?? '',
    category: (r.category || 'other') as AttachmentCategory,
    categorySource: r.category_source === 'ai' ? 'ai' : r.category_source === 'manual' ? 'manual' : 'rule',
    confidence: r.confidence ?? 0,
    counterparty: r.counterparty ?? '',
    counterpartyAddr: r.counterparty_addr ?? '',
    direction: r.direction === 'out' ? 'out' : 'in',
    subject: r.subject ?? '',
    date: r.date ?? 0,
    remoteOnly: !!r.remote_only,
    cached: !!r.cached,
    releasedAt: r.released_at ?? null,
    hash: r.hash ?? null,
    pinned: !!r.pinned,
    cloud: parseCloud(r.cloud_json)
  }
}

export class AttachmentIndexStore {
  constructor(public db: DatabaseSync) {
    db.exec(ATTACHMENT_SCHEMA)
  }

  get(id: string): IndexRow | undefined {
    return this.db.prepare('SELECT * FROM attachment_index WHERE id = ?').get(id) as IndexRow | undefined
  }

  getMany(ids: string[]): IndexRow[] {
    const out: IndexRow[] = []
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400)
      if (!part.length) continue
      out.push(...(this.db.prepare(`SELECT * FROM attachment_index WHERE id IN (${part.map(() => '?').join(',')})`).all(...part) as unknown as IndexRow[]))
    }
    return out
  }

  all(): IndexRow[] {
    return this.db.prepare('SELECT * FROM attachment_index').all() as unknown as IndexRow[]
  }

  byMessage(messageId: string): IndexRow[] {
    return this.db.prepare('SELECT * FROM attachment_index WHERE message_id = ? ORDER BY id').all(messageId) as unknown as IndexRow[]
  }

  /** 新增或刷新元数据；保留钉住 / 手动或 AI 分类 / 哈希 / 网盘副本 / 释放记录 */
  upsert(u: IndexUpsert) {
    this.db
      .prepare(
        `INSERT INTO attachment_index (id, message_id, account_id, filename, content_type, size, ext, category, category_source, confidence,
           counterparty, counterparty_addr, direction, subject, date, part, remote_only, cached, cache_path, indexed_at)
         VALUES (?,?,?,?,?,?,?,?,'rule',?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           message_id=excluded.message_id, account_id=excluded.account_id, filename=excluded.filename,
           content_type=excluded.content_type, size=excluded.size, ext=excluded.ext,
           category=CASE WHEN attachment_index.category_source='rule' THEN excluded.category ELSE attachment_index.category END,
           confidence=CASE WHEN attachment_index.category_source='rule' THEN excluded.confidence ELSE attachment_index.confidence END,
           counterparty=excluded.counterparty, counterparty_addr=excluded.counterparty_addr, direction=excluded.direction,
           subject=excluded.subject, date=excluded.date, part=excluded.part, remote_only=excluded.remote_only,
           cached=excluded.cached, cache_path=excluded.cache_path, indexed_at=excluded.indexed_at`
      )
      .run(
        u.id, u.messageId, u.accountId, u.filename, u.contentType, u.size, u.ext, u.category, u.confidence,
        u.counterparty, u.counterpartyAddr, u.direction, u.subject, u.date, u.part, u.remoteOnly ? 1 : 0,
        u.cached ? 1 : 0, u.cachePath, Date.now()
      )
  }

  /** 下载后：把仅元数据行的用户状态（钉住 / 手动分类 / 网盘副本）合并到真实行，再删掉占位行 */
  mergeRemote(remoteId: string, realId: string) {
    const r = this.get(remoteId)
    const real = this.get(realId)
    if (!r || !real) return
    const cloud = [...parseCloud(real.cloud_json), ...parseCloud(r.cloud_json)]
    this.db
      .prepare(
        `UPDATE attachment_index SET pinned = MAX(pinned, ?), cloud_json = ?,
           category = CASE WHEN ? != 'rule' THEN ? ELSE category END,
           category_source = CASE WHEN ? != 'rule' THEN ? ELSE category_source END
         WHERE id = ?`
      )
      .run(r.pinned, JSON.stringify(cloud), r.category_source, r.category, r.category_source, r.category_source, realId)
    this.db.prepare('DELETE FROM attachment_index WHERE id = ?').run(remoteId)
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM attachment_index WHERE id = ?').run(id)
  }

  setCached(id: string, cached: boolean, releasedAt?: number | null) {
    if (releasedAt === undefined) this.db.prepare('UPDATE attachment_index SET cached = ? WHERE id = ?').run(cached ? 1 : 0, id)
    else this.db.prepare('UPDATE attachment_index SET cached = ?, released_at = ? WHERE id = ?').run(cached ? 1 : 0, releasedAt, id)
  }

  setHash(id: string, hash: string) {
    this.db.prepare('UPDATE attachment_index SET hash = ? WHERE id = ?').run(hash, id)
  }

  setPinned(ids: string[], pinned: boolean) {
    const st = this.db.prepare('UPDATE attachment_index SET pinned = ? WHERE id = ?')
    for (const id of ids) st.run(pinned ? 1 : 0, id)
  }

  setCategory(ids: string[], category: AttachmentCategory, source: 'manual' | 'ai', confidence = 1) {
    const st = this.db.prepare('UPDATE attachment_index SET category = ?, category_source = ?, confidence = ?, ai_checked = 1 WHERE id = ?')
    for (const id of ids) st.run(category, source, confidence, id)
  }

  markAiChecked(ids: string[]) {
    const st = this.db.prepare('UPDATE attachment_index SET ai_checked = 1 WHERE id = ?')
    for (const id of ids) st.run(id)
  }

  addCloud(id: string, copy: AttachmentCloudCopy) {
    const r = this.get(id)
    if (!r) return
    const list = parseCloud(r.cloud_json).filter(c => !(c.driveId === copy.driveId && c.path === copy.path))
    list.push(copy)
    this.db.prepare('UPDATE attachment_index SET cloud_json = ? WHERE id = ?').run(JSON.stringify(list), id)
  }

  setCloud(id: string, list: AttachmentCloudCopy[]) {
    this.db.prepare('UPDATE attachment_index SET cloud_json = ? WHERE id = ?').run(JSON.stringify(list), id)
  }

  /** 同一网盘上同哈希的已有副本（去重：同内容只存一份） */
  cloudByHash(hash: string, driveId: string): AttachmentCloudCopy | null {
    const rows = this.db.prepare(`SELECT cloud_json FROM attachment_index WHERE hash = ? AND cloud_json != '[]'`).all(hash) as { cloud_json: string }[]
    for (const r of rows) {
      const hit = parseCloud(r.cloud_json).find(c => c.driveId === driveId)
      if (hit) return hit
    }
    return null
  }

  /** 网盘上这个路径已登记的内容哈希（远端网盘无法廉价取哈希，靠自己的登记判断「同名同内容」） */
  hashAtCloudPath(driveId: string, path: string): string | null {
    const rows = this.db.prepare(`SELECT hash, cloud_json FROM attachment_index WHERE instr(cloud_json, ?) > 0`).all(JSON.stringify(path)) as { hash: string | null; cloud_json: string }[]
    for (const r of rows) {
      const hit = parseCloud(r.cloud_json).find(c => c.driveId === driveId && c.path === path)
      if (hit) return hit.hash ?? r.hash ?? null
    }
    return null
  }

  list(q: AttachmentQuery): { rows: IndexRow[]; total: number } {
    const where: string[] = ['skip = 0']
    const params: (string | number)[] = []
    if (q.category) {
      where.push('category = ?')
      params.push(q.category)
    }
    if (q.accountId) {
      where.push('account_id = ?')
      params.push(q.accountId)
    }
    if (q.counterparty) {
      where.push('counterparty = ?')
      params.push(q.counterparty)
    }
    if (q.year) {
      const from = new Date(q.year, 0, 1).getTime()
      const to = new Date(q.year + 1, 0, 1).getTime()
      where.push('date >= ? AND date < ?')
      params.push(from, to)
    }
    if (q.search && q.search.trim()) {
      const like = `%${q.search.trim().replace(/[%_]/g, m => '\\' + m)}%`
      where.push(`(filename LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\' OR counterparty LIKE ? ESCAPE '\\' OR counterparty_addr LIKE ? ESCAPE '\\')`)
      params.push(like, like, like, like)
    }
    switch (q.state) {
      case 'local':
        where.push('cached = 1')
        break
      case 'released':
        where.push('cached = 0 AND released_at IS NOT NULL AND remote_only = 0')
        break
      case 'remote':
        where.push('remote_only = 1')
        break
      case 'archived':
        where.push(`cloud_json != '[]'`)
        break
      case 'unarchived':
        where.push(`cloud_json = '[]'`)
        break
    }
    const w = `WHERE ${where.join(' AND ')}`
    const order = q.sort === 'size' ? 'size DESC' : q.sort === 'name' ? 'filename COLLATE NOCASE ASC' : 'date DESC'
    const total = (this.db.prepare(`SELECT COUNT(*) c FROM attachment_index ${w}`).get(...params) as { c: number }).c
    const limit = Math.max(1, Math.min(2000, q.limit ?? 200))
    const offset = Math.max(0, q.offset ?? 0)
    const rows = this.db.prepare(`SELECT * FROM attachment_index ${w} ORDER BY ${order}, id LIMIT ${limit} OFFSET ${offset}`).all(...params) as unknown as IndexRow[]
    return { rows, total }
  }
}
