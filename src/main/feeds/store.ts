/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FeedDigest, FeedEnclosure, FeedFormat, FeedItem, FeedItemDetail, FeedItemKind, FeedItemQuery, FeedKind, FeedSource, FeedTopic, SearchResult } from '@shared/feeds'
import { itemKey, normalizeUrl } from './dedupe'
import type { ParsedItem } from './parse'

/**
 * 订阅数据层（只新增表）：
 *  - feed_sources：订阅源与 AI 搜索订阅（kind=search，主题存 topic_json）
 *  - feed_items：条目（去重键 key 在同一源内唯一）
 *  - feed_gone：被保留策略清理掉的条目键（墓碑，防止下次抓取时「复活」成未读）
 *  - feed_seen：AI 搜索订阅出现过的结果（规范化 URL + 标题），跨次运行去重
 *  - feed_digests：今日订阅精华（每天一份）
 */

const DAY = 864e5

function json<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

export interface SourceRow {
  id: string
  kind: FeedKind
  title: string
  url: string | null
  site_url: string | null
  group_name: string | null
  format: string | null
  interval_min: number | null
  full_text: number
  enabled: number
  topic_json: string | null
  etag: string | null
  last_modified: string | null
  last_fetch_at: number | null
  last_ok_at: number | null
  next_fetch_at: number | null
  fail_count: number
  last_error: string | null
  sort: number
  created_at: number
}

export class FeedStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feed_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'feed',
        title TEXT NOT NULL,
        url TEXT,
        site_url TEXT,
        group_name TEXT,
        format TEXT,
        interval_min INTEGER,
        full_text INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        topic_json TEXT,
        etag TEXT,
        last_modified TEXT,
        last_fetch_at INTEGER,
        last_ok_at INTEGER,
        next_fetch_at INTEGER,
        fail_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feed_items (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'article',
        key TEXT NOT NULL,
        guid TEXT,
        url TEXT,
        url_norm TEXT,
        title TEXT NOT NULL,
        author TEXT,
        summary TEXT,
        content_html TEXT,
        full_html TEXT,
        full_at INTEGER,
        ai_summary TEXT,
        enclosures_json TEXT,
        extra_json TEXT,
        published_at INTEGER,
        fetched_at INTEGER NOT NULL,
        sort_at INTEGER NOT NULL,
        read_at INTEGER,
        starred INTEGER NOT NULL DEFAULT 0,
        UNIQUE(source_id, key)
      );
      CREATE INDEX IF NOT EXISTS idx_feed_items_source ON feed_items(source_id, sort_at);
      CREATE INDEX IF NOT EXISTS idx_feed_items_sort ON feed_items(sort_at);
      CREATE INDEX IF NOT EXISTS idx_feed_items_unread ON feed_items(read_at, source_id);
      CREATE INDEX IF NOT EXISTS idx_feed_items_url ON feed_items(source_id, url_norm);
      CREATE TABLE IF NOT EXISTS feed_gone (
        source_id TEXT NOT NULL,
        key TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (source_id, key)
      );
      CREATE TABLE IF NOT EXISTS feed_seen (
        source_id TEXT NOT NULL,
        url_norm TEXT NOT NULL,
        title TEXT,
        at INTEGER NOT NULL,
        PRIMARY KEY (source_id, url_norm)
      );
      CREATE TABLE IF NOT EXISTS feed_digests (
        day TEXT PRIMARY KEY,
        headline TEXT,
        html TEXT NOT NULL,
        source TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        item_ids_json TEXT,
        created_at INTEGER NOT NULL
      );
    `)
  }

  // ---------------------------------------------------------------- 源

  sourceRows(): SourceRow[] {
    return this.db.prepare('SELECT * FROM feed_sources ORDER BY sort, created_at').all() as any[]
  }

  sourceRow(id: string): SourceRow | null {
    return (this.db.prepare('SELECT * FROM feed_sources WHERE id = ?').get(id) as any) ?? null
  }

  sourceByUrl(url: string): SourceRow | null {
    const n = normalizeUrl(url)
    return this.sourceRows().find(r => r.url && normalizeUrl(r.url) === n) ?? null
  }

  sources(): FeedSource[] {
    const counts = new Map<string, { unread: number; total: number }>()
    for (const r of this.db.prepare('SELECT source_id, COUNT(*) AS total, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread FROM feed_items GROUP BY source_id').all() as any[])
      counts.set(r.source_id, { unread: Number(r.unread) || 0, total: Number(r.total) || 0 })
    return this.sourceRows().map(r => this.toSource(r, counts.get(r.id)))
  }

  source(id: string): FeedSource | null {
    const r = this.sourceRow(id)
    if (!r) return null
    const c = this.db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread FROM feed_items WHERE source_id = ?').get(id) as any
    return this.toSource(r, { unread: Number(c?.unread) || 0, total: Number(c?.total) || 0 })
  }

  private toSource(r: SourceRow, c?: { unread: number; total: number }): FeedSource {
    return {
      id: r.id,
      kind: r.kind === 'search' ? 'search' : 'feed',
      title: r.title,
      url: r.url,
      siteUrl: r.site_url,
      group: r.group_name || null,
      format: (r.format as FeedFormat) || null,
      intervalMin: r.interval_min ?? null,
      fullText: !!r.full_text,
      enabled: !!r.enabled,
      topic: json<FeedTopic | null>(r.topic_json, null),
      lastFetchAt: r.last_fetch_at,
      lastOkAt: r.last_ok_at,
      nextFetchAt: r.next_fetch_at,
      failCount: r.fail_count ?? 0,
      lastError: r.last_error,
      createdAt: r.created_at,
      unread: c?.unread ?? 0,
      total: c?.total ?? 0
    }
  }

  insertSource(s: { kind: FeedKind; title: string; url?: string | null; siteUrl?: string | null; group?: string | null; format?: string | null; intervalMin?: number | null; fullText?: boolean; topic?: FeedTopic | null }): string {
    const id = `feed-${randomUUID()}`
    const sort = (this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM feed_sources').get() as any).n
    this.db
      .prepare(
        `INSERT INTO feed_sources (id, kind, title, url, site_url, group_name, format, interval_min, full_text, enabled, topic_json, sort, created_at, next_fetch_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?)`
      )
      .run(id, s.kind, s.title.slice(0, 200), s.url ?? null, s.siteUrl ?? null, s.group?.trim() || null, s.format ?? null, s.intervalMin ?? null, s.fullText ? 1 : 0, s.topic ? JSON.stringify(s.topic) : null, sort, Date.now(), null)
    return id
  }

  updateSource(id: string, patch: Partial<{ title: string; url: string | null; siteUrl: string | null; group: string | null; format: string | null; intervalMin: number | null; fullText: boolean; enabled: boolean; topic: FeedTopic | null; etag: string | null; lastModified: string | null; lastFetchAt: number | null; lastOkAt: number | null; nextFetchAt: number | null; failCount: number; lastError: string | null; sort: number }>) {
    const map: Record<string, [string, (v: any) => unknown]> = {
      title: ['title', v => String(v ?? '').slice(0, 200)],
      url: ['url', v => v],
      siteUrl: ['site_url', v => v],
      group: ['group_name', v => (v ? String(v).trim() || null : null)],
      format: ['format', v => v],
      intervalMin: ['interval_min', v => (v == null ? null : Math.max(5, Math.min(10080, Math.round(Number(v) || 60))))],
      fullText: ['full_text', v => (v ? 1 : 0)],
      enabled: ['enabled', v => (v ? 1 : 0)],
      topic: ['topic_json', v => (v ? JSON.stringify(v) : null)],
      etag: ['etag', v => v],
      lastModified: ['last_modified', v => v],
      lastFetchAt: ['last_fetch_at', v => v],
      lastOkAt: ['last_ok_at', v => v],
      nextFetchAt: ['next_fetch_at', v => v],
      failCount: ['fail_count', v => Number(v) || 0],
      lastError: ['last_error', v => (v ? String(v).slice(0, 300) : null)],
      sort: ['sort', v => Number(v) || 0]
    }
    const sets: string[] = []
    const vals: any[] = []
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k]
      if (!m || v === undefined) continue
      sets.push(`${m[0]} = ?`)
      vals.push(m[1](v) as any)
    }
    if (!sets.length) return
    this.db.prepare(`UPDATE feed_sources SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  }

  deleteSource(id: string) {
    this.db.prepare('DELETE FROM feed_items WHERE source_id = ?').run(id)
    this.db.prepare('DELETE FROM feed_gone WHERE source_id = ?').run(id)
    this.db.prepare('DELETE FROM feed_seen WHERE source_id = ?').run(id)
    this.db.prepare('DELETE FROM feed_sources WHERE id = ?').run(id)
  }

  renameGroup(from: string, to: string | null) {
    this.db.prepare('UPDATE feed_sources SET group_name = ? WHERE group_name = ?').run(to?.trim() || null, from)
  }

  // ---------------------------------------------------------------- 条目

  /**
   * 写入一批解析后的条目：同源内按去重键（guid / 链接 / 标题+日期）去重，另外同链接视为同一条；
   * 已存在的只更新标题 / 正文（不动已读 / 收藏）；墓碑里的跳过。返回新增条数。
   */
  upsertItems(sourceId: string, items: ParsedItem[], now = Date.now()): { added: string[]; updated: number } {
    const added: string[] = []
    let updated = 0
    const gone = this.db.prepare('SELECT 1 FROM feed_gone WHERE source_id = ? AND key = ?')
    const byKey = this.db.prepare('SELECT id, title, content_html FROM feed_items WHERE source_id = ? AND key = ?')
    const byUrl = this.db.prepare('SELECT id, title, content_html FROM feed_items WHERE source_id = ? AND url_norm = ? LIMIT 1')
    const ins = this.db.prepare(
      `INSERT INTO feed_items (id, source_id, kind, key, guid, url, url_norm, title, author, summary, content_html, enclosures_json, published_at, fetched_at, sort_at)
       VALUES (?,?, 'article', ?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    const upd = this.db.prepare('UPDATE feed_items SET title = ?, summary = ?, content_html = ?, author = COALESCE(?, author) WHERE id = ?')
    const seenInBatch = new Set<string>()
    // 订阅里越靠前越新：同一批没有日期的条目按顺序给递减的排序时间，保持原顺序
    let i = 0
    for (const it of items) {
      i++
      const key = itemKey(it)
      if (seenInBatch.has(key)) continue
      seenInBatch.add(key)
      if (gone.get(sourceId, key)) continue
      const un = it.url ? normalizeUrl(it.url) : null
      const cur = (byKey.get(sourceId, key) as any) ?? (un ? (byUrl.get(sourceId, un) as any) : null)
      if (cur) {
        if (cur.title !== it.title || (it.contentHtml && cur.content_html !== it.contentHtml)) {
          upd.run(it.title, it.summary, it.contentHtml, it.author, cur.id)
          updated++
        }
        continue
      }
      const id = `fi-${randomUUID()}`
      const sortAt = it.publishedAt && it.publishedAt <= now + 60_000 ? it.publishedAt : now - i
      ins.run(id, sourceId, key, it.guid, it.url, un, it.title, it.author, it.summary, it.contentHtml, it.enclosures.length ? JSON.stringify(it.enclosures) : null, it.publishedAt, now, sortAt)
      added.push(id)
    }
    return { added, updated }
  }

  /** 简报类条目（AI 搜索订阅 / 每日精华） */
  insertBrief(sourceId: string, input: { title: string; html: string; summary: string; results: SearchResult[]; source: 'ai' | 'list' }, now = Date.now()): string {
    const id = `fi-${randomUUID()}`
    this.db
      .prepare(
        `INSERT INTO feed_items (id, source_id, kind, key, title, summary, content_html, extra_json, published_at, fetched_at, sort_at)
         VALUES (?,?, 'brief', ?,?,?,?,?,?,?,?)`
      )
      .run(id, sourceId, `b:${now}`, input.title.slice(0, 300), input.summary.slice(0, 600), input.html, JSON.stringify({ results: input.results, source: input.source }), now, now, now)
    return id
  }

  private toItem(r: any, titles: Map<string, { title: string; kind: FeedKind }>): FeedItem {
    const src = titles.get(r.source_id)
    return {
      id: r.id,
      sourceId: r.source_id,
      sourceTitle: src?.title ?? '',
      sourceKind: src?.kind ?? 'feed',
      kind: (r.kind as FeedItemKind) || 'article',
      title: r.title,
      url: r.url,
      author: r.author,
      summary: r.summary ?? '',
      publishedAt: r.published_at,
      fetchedAt: r.fetched_at,
      sortAt: r.sort_at,
      read: r.read_at != null,
      starred: !!r.starred,
      hasFull: !!r.full_html,
      aiSummary: r.ai_summary ?? null,
      enclosures: json<FeedEnclosure[]>(r.enclosures_json, [])
    }
  }

  private titles(): Map<string, { title: string; kind: FeedKind }> {
    const m = new Map<string, { title: string; kind: FeedKind }>()
    for (const r of this.db.prepare('SELECT id, title, kind FROM feed_sources').all() as any[]) m.set(r.id, { title: r.title, kind: r.kind === 'search' ? 'search' : 'feed' })
    return m
  }

  items(q: FeedItemQuery): FeedItem[] {
    const where: string[] = []
    const args: any[] = []
    const s = q.scope
    if (s.kind === 'source') {
      where.push('i.source_id = ?')
      args.push(s.id)
    } else if (s.kind === 'group') {
      where.push('i.source_id IN (SELECT id FROM feed_sources WHERE group_name = ?)')
      args.push(s.name)
    } else if (s.kind === 'topics') {
      where.push("i.source_id IN (SELECT id FROM feed_sources WHERE kind = 'search')")
    } else if (s.kind === 'starred') where.push('i.starred = 1')
    if (s.kind === 'all' || s.kind === 'group') where.push('i.source_id IN (SELECT id FROM feed_sources WHERE enabled = 1 OR kind = \'search\')')
    if (q.filter === 'unread') where.push('i.read_at IS NULL')
    if (q.filter === 'starred') where.push('i.starred = 1')
    if (q.before) {
      where.push('i.sort_at < ?')
      args.push(q.before)
    }
    const terms = String(q.q ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
    for (const t of terms) {
      where.push("(i.title LIKE ? ESCAPE '\\' OR i.summary LIKE ? ESCAPE '\\' OR i.author LIKE ? ESCAPE '\\' OR i.ai_summary LIKE ? ESCAPE '\\')")
      const like = `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%`
      args.push(like, like, like, like)
    }
    const limit = Math.max(1, Math.min(500, Math.round(q.limit ?? 120)))
    const rows = this.db
      .prepare(
        `SELECT i.id, i.source_id, i.kind, i.title, i.url, i.author, i.summary, i.published_at, i.fetched_at, i.sort_at, i.read_at, i.starred,
                (i.full_html IS NOT NULL) AS full_html, i.ai_summary, i.enclosures_json
         FROM feed_items i ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.sort_at DESC LIMIT ${limit}`
      )
      .all(...args) as any[]
    const t = this.titles()
    return rows.map(r => this.toItem(r, t))
  }

  /** 在条目里全文搜（标题 / 摘要 / 正文 / AI 摘要），给 Agent 用 */
  search(text: string, opts: { sourceId?: string | null; since?: number | null; limit?: number } = {}): FeedItem[] {
    const terms = String(text ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
    const where: string[] = []
    const args: any[] = []
    for (const t of terms) {
      where.push("(i.title LIKE ? ESCAPE '\\' OR i.summary LIKE ? ESCAPE '\\' OR i.content_html LIKE ? ESCAPE '\\' OR i.ai_summary LIKE ? ESCAPE '\\' OR i.full_html LIKE ? ESCAPE '\\')")
      const like = `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%`
      args.push(like, like, like, like, like)
    }
    if (opts.sourceId) {
      where.push('i.source_id = ?')
      args.push(opts.sourceId)
    }
    if (opts.since) {
      where.push('i.sort_at >= ?')
      args.push(opts.since)
    }
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20))
    const rows = this.db
      .prepare(
        `SELECT i.id, i.source_id, i.kind, i.title, i.url, i.author, i.summary, i.published_at, i.fetched_at, i.sort_at, i.read_at, i.starred,
                (i.full_html IS NOT NULL) AS full_html, i.ai_summary, i.enclosures_json
         FROM feed_items i ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.sort_at DESC LIMIT ${limit}`
      )
      .all(...args) as any[]
    const t = this.titles()
    return rows.map(r => this.toItem(r, t))
  }

  item(id: string): FeedItemDetail | null {
    const r = this.db.prepare('SELECT * FROM feed_items WHERE id = ?').get(id) as any
    if (!r) return null
    const base = this.toItem({ ...r, full_html: r.full_html ? 1 : 0 }, this.titles())
    const extra = json<{ results?: SearchResult[] }>(r.extra_json, {})
    return { ...base, contentHtml: r.content_html ?? '', fullHtml: r.full_html ?? null, ...(extra.results ? { results: extra.results } : {}) }
  }

  rawContent(id: string): { content: string; full: string | null } | null {
    const r = this.db.prepare('SELECT content_html, full_html FROM feed_items WHERE id = ?').get(id) as any
    return r ? { content: r.content_html ?? '', full: r.full_html ?? null } : null
  }

  setRead(ids: string[], read: boolean, now = Date.now()) {
    if (read) {
      const st = this.db.prepare('UPDATE feed_items SET read_at = COALESCE(read_at, ?) WHERE id = ?')
      for (const id of ids) st.run(now, id)
    } else {
      const st = this.db.prepare('UPDATE feed_items SET read_at = NULL WHERE id = ?')
      for (const id of ids) st.run(id)
    }
  }

  /** 范围内全部标已读；before = 只标这个时间之前的（防止标掉刚到的） */
  markAllRead(q: Pick<FeedItemQuery, 'scope'>, before: number | null, now = Date.now()): number {
    const items = this.items({ scope: q.scope, filter: 'unread', limit: 500 }).filter(i => !before || i.fetchedAt <= before)
    let n = 0
    // items() 每次最多 500：循环直到清完
    let batch = items
    while (batch.length) {
      this.setRead(
        batch.map(i => i.id),
        true,
        now
      )
      n += batch.length
      if (batch.length < 500) break
      batch = this.items({ scope: q.scope, filter: 'unread', limit: 500 }).filter(i => !before || i.fetchedAt <= before)
    }
    return n
  }

  setStarred(id: string, starred: boolean) {
    this.db.prepare('UPDATE feed_items SET starred = ? WHERE id = ?').run(starred ? 1 : 0, id)
  }

  setFull(id: string, html: string, now = Date.now()) {
    this.db.prepare('UPDATE feed_items SET full_html = ?, full_at = ? WHERE id = ?').run(html, now, id)
  }

  setAiSummary(id: string, text: string) {
    this.db.prepare('UPDATE feed_items SET ai_summary = ? WHERE id = ?').run(text, id)
  }

  unreadTotal(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM feed_items i JOIN feed_sources s ON s.id = i.source_id WHERE i.read_at IS NULL AND (s.enabled = 1 OR s.kind = 'search')").get() as any).n) || 0
  }

  /** 某时间以来的条目（精华汇总用） */
  since(t: number, limit = 80): FeedItem[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.source_id, i.kind, i.title, i.url, i.author, i.summary, i.published_at, i.fetched_at, i.sort_at, i.read_at, i.starred,
                (i.full_html IS NOT NULL) AS full_html, i.ai_summary, i.enclosures_json
         FROM feed_items i JOIN feed_sources s ON s.id = i.source_id
         WHERE i.fetched_at >= ? AND i.kind = 'article' AND s.enabled = 1 ORDER BY i.sort_at DESC LIMIT ?`
      )
      .all(t, limit) as any[]
    const ti = this.titles()
    return rows.map(r => this.toItem(r, ti))
  }

  // ---------------------------------------------------------------- 保留策略

  /**
   * 清理：每源最多 maxItems 条（收藏的不算、不删）；已读超过 keepReadDays 天的删除（收藏的保留）。
   * 删除的写墓碑（订阅里还挂着的旧条目不会以未读身份回来）；墓碑保留 180 天。
   */
  prune(opts: { maxItems: number; keepReadDays: number }, now = Date.now()): number {
    let removed = 0
    const tomb = this.db.prepare('INSERT OR REPLACE INTO feed_gone (source_id, key, at) VALUES (?,?,?)')
    const del = this.db.prepare('DELETE FROM feed_items WHERE id = ?')
    const drop = (rows: any[]) => {
      for (const r of rows) {
        if (r.kind === 'article') tomb.run(r.source_id, r.key, now)
        del.run(r.id)
        removed++
      }
    }
    if (opts.keepReadDays > 0) {
      drop(this.db.prepare('SELECT id, source_id, key, kind FROM feed_items WHERE starred = 0 AND read_at IS NOT NULL AND read_at < ?').all(now - opts.keepReadDays * DAY) as any[])
    }
    const max = Math.max(20, opts.maxItems)
    for (const s of this.db.prepare('SELECT source_id, COUNT(*) AS n FROM feed_items WHERE starred = 0 GROUP BY source_id HAVING n > ?').all(max) as any[]) {
      drop(this.db.prepare('SELECT id, source_id, key, kind FROM feed_items WHERE source_id = ? AND starred = 0 ORDER BY sort_at DESC LIMIT -1 OFFSET ?').all(s.source_id, max) as any[])
    }
    this.db.prepare('DELETE FROM feed_gone WHERE at < ?').run(now - 180 * DAY)
    this.db.prepare('DELETE FROM feed_seen WHERE at < ?').run(now - 180 * DAY)
    return removed
  }

  // ---------------------------------------------------------------- AI 搜索订阅历史

  seen(sourceId: string): { urls: Set<string>; titles: string[] } {
    const rows = this.db.prepare('SELECT url_norm, title FROM feed_seen WHERE source_id = ? ORDER BY at DESC LIMIT 2000').all(sourceId) as any[]
    return { urls: new Set(rows.map(r => r.url_norm)), titles: rows.map(r => r.title).filter(Boolean).slice(0, 600) }
  }

  addSeen(sourceId: string, results: SearchResult[], now = Date.now()) {
    const st = this.db.prepare('INSERT OR IGNORE INTO feed_seen (source_id, url_norm, title, at) VALUES (?,?,?,?)')
    for (const r of results) st.run(sourceId, normalizeUrl(r.url), r.title, now)
  }

  // ---------------------------------------------------------------- 精华

  digest(day: string): FeedDigest | null {
    const r = this.db.prepare('SELECT * FROM feed_digests WHERE day = ?').get(day) as any
    return r ? { day: r.day, headline: r.headline ?? '', html: r.html, source: r.source === 'ai' ? 'ai' : 'list', count: r.count ?? 0, createdAt: r.created_at } : null
  }

  latestDigest(): FeedDigest | null {
    const r = this.db.prepare('SELECT day FROM feed_digests ORDER BY day DESC LIMIT 1').get() as any
    return r ? this.digest(r.day) : null
  }

  saveDigest(d: FeedDigest, itemIds: string[]) {
    this.db
      .prepare('INSERT OR REPLACE INTO feed_digests (day, headline, html, source, count, item_ids_json, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(d.day, d.headline, d.html, d.source, d.count, JSON.stringify(itemIds), d.createdAt)
    this.db.prepare('DELETE FROM feed_digests WHERE day < ?').run(new Date(Date.now() - 60 * DAY).toISOString().slice(0, 10))
  }
}
