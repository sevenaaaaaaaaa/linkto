import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { SEARCH_INDEX_VERSION, addressText, segmentForIndex } from './search-text'

/**
 * 中文友好检索索引（与旧 messages_fts trigram 并存，只新增表）：
 *  - search_fts：FTS5 unicode61 分词、无内容（contentless_delete）表，rowid = messages.rowid；
 *    四列 subject / sender / recipients / body 存的是 CJK 二元组预处理后的文本（见 search-text.ts）
 *  - search_doc：已建索引的 messages.rowid（回填进度 / 判断哪些邮件还没进索引）
 *  - search_meta：索引版本（切分规则变化时整体重建）
 * 写入：本连接上的 TEMP 触发器（不落库，其他连接 / 旧版本程序不受影响）在邮件增删改时同步更新；
 * 存量邮件由 backfill 分片回填（主线程时间片，单片 ≤ 20ms，不阻塞界面）。
 */

const SUBJECT_MAX = 400
const SENDER_MAX = 400
const RECIPIENTS_MAX = 2000
/** 正文只索引开头一段（控制索引体积；长邮件的关键信息通常在前面） */
const BODY_MAX = 6000

export interface SearchIndexStatus {
  enabled: boolean
  indexed: number
  total: number
  building: boolean
}

/** 由 messages 行（别名 X）生成四列预处理文本的 SQL 片段 */
const docValues = (x: string) => `
  linkto_seg(${x}.subject, ${SUBJECT_MAX}),
  linkto_seg(coalesce(${x}.from_name, '') || ' ' || coalesce(${x}.from_addr, ''), ${SENDER_MAX}),
  linkto_seg(linkto_addr(${x}.to_json, ${x}.cc_json), ${RECIPIENTS_MAX}),
  linkto_seg(CASE WHEN length(coalesce(${x}.text, '')) > 0 THEN ${x}.text ELSE coalesce(${x}.snippet, '') END, ${BODY_MAX})`

/** SQLITE_BUSY / SQLITE_LOCKED：暂时性的，稍后重试即可 */
function isBusy(err: unknown): boolean {
  const e = err as { errcode?: number; message?: string } | null
  const code = (e?.errcode ?? 0) & 0xff
  return code === 5 || code === 6 || /database is locked|database table is locked|busy/i.test(e?.message ?? '')
}

export class SearchIndex {
  enabled = false
  private complete = false
  private timer: NodeJS.Timeout | null = null
  private cursor = Number.MAX_SAFE_INTEGER
  private pickStmt: StatementSync | null = null
  private indexed = 0
  private total = 0
  private lastReport = 0
  onProgress: ((s: SearchIndexStatus) => void) | null = null

  constructor(private db: DatabaseSync) {}

  /** 建表 + 注册切分函数 + TEMP 触发器；失败（如 SQLite 缺 FTS5 选项）时禁用，查询退回旧路径 */
  init(): boolean {
    const db = this.db
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
          subject, sender, recipients, body,
          content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2', prefix='1 2'
        );
        CREATE TABLE IF NOT EXISTS search_doc (rowid INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `)
      const ver = (db.prepare("SELECT value FROM search_meta WHERE key = 'version'").get() as { value: string } | undefined)?.value
      if (ver !== String(SEARCH_INDEX_VERSION)) {
        db.exec("INSERT INTO search_fts(search_fts) VALUES('delete-all'); DELETE FROM search_doc;")
        db.prepare("INSERT INTO search_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SEARCH_INDEX_VERSION))
      }
      db.function('linkto_seg', { deterministic: true }, (s: unknown, max: unknown) => segmentForIndex(s == null ? '' : String(s), Number(max) || 0))
      db.function('linkto_addr', { deterministic: true }, (a: unknown, b: unknown) => addressText(a == null ? null : String(a), b == null ? null : String(b)))
      db.exec(`
        DROP TRIGGER IF EXISTS temp.search_idx_ai;
        DROP TRIGGER IF EXISTS temp.search_idx_ad;
        DROP TRIGGER IF EXISTS temp.search_idx_au;
        CREATE TEMP TRIGGER search_idx_ai AFTER INSERT ON main.messages BEGIN
          DELETE FROM search_fts WHERE rowid = new.rowid;
          INSERT INTO search_fts(rowid, subject, sender, recipients, body) VALUES (new.rowid, ${docValues('new')});
          INSERT OR IGNORE INTO search_doc(rowid) VALUES (new.rowid);
        END;
        CREATE TEMP TRIGGER search_idx_ad AFTER DELETE ON main.messages BEGIN
          DELETE FROM search_fts WHERE rowid = old.rowid;
          DELETE FROM search_doc WHERE rowid = old.rowid;
        END;
        CREATE TEMP TRIGGER search_idx_au AFTER UPDATE OF subject, from_name, from_addr, to_json, cc_json, text, snippet ON main.messages BEGIN
          DELETE FROM search_fts WHERE rowid = old.rowid;
          INSERT INTO search_fts(rowid, subject, sender, recipients, body) VALUES (new.rowid, ${docValues('new')});
          INSERT OR IGNORE INTO search_doc(rowid) VALUES (new.rowid);
        END;
      `)
      this.enabled = true
      this.recount()
      return true
    } catch (err) {
      console.error('[search-index] init failed, falling back to LIKE search:', err)
      this.enabled = false
      return false
    }
  }

  /** 索引是否已覆盖全部邮件（未覆盖时查询对未入索引的邮件补一段 LIKE） */
  isComplete(): boolean {
    return this.enabled && this.complete
  }

  status(): SearchIndexStatus {
    return { enabled: this.enabled, indexed: this.indexed, total: this.total, building: this.enabled && !this.complete }
  }

  /**
   * 统计覆盖度。启动时只做两次 COUNT（毫秒级）；数量对不上（其他连接删过邮件，search_doc 有残留）时
   * 才精确数一遍仍存在的邮件。回填的第一片若又发现未入索引的邮件，会把 complete 改回 false。
   */
  private recount() {
    this.total = (this.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c
    this.indexed = (this.db.prepare('SELECT COUNT(*) AS c FROM search_doc').get() as { c: number }).c
    if (this.indexed > this.total) {
      // 其他连接删掉的邮件：索引条目一并清掉（rowid 之后可能被新邮件复用）
      const stale = 'SELECT rowid FROM search_doc WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.rowid = search_doc.rowid)'
      this.db.exec(`DELETE FROM search_fts WHERE rowid IN (${stale}); DELETE FROM search_doc WHERE rowid IN (${stale});`)
      this.indexed = (this.db.prepare('SELECT COUNT(*) AS c FROM search_doc').get() as { c: number }).c
    }
    this.complete = this.indexed >= this.total
  }

  /**
   * 后台分批回填存量邮件（新邮件优先：按 rowid 从大到小）。
   * 每片最多约 20ms，片间让出主线程；delayMs 后开始（等启动同步先跑）。
   */
  startBackfill(delayMs = 8000) {
    if (!this.enabled || this.timer) return
    this.cursor = Number.MAX_SAFE_INTEGER
    // 已全部覆盖（数量一致）：不必再扫一遍
    if (this.complete) {
      this.report(true)
      return
    }
    const step = () => {
      this.timer = null
      if (!this.enabled) return
      // 别的代码正持有本连接的事务：这一片让过去
      if (this.db.isTransaction) {
        this.timer = setTimeout(step, 200)
        return
      }
      let done = false
      try {
        done = this.backfillSlice(20)
      } catch (err) {
        // 数据库忙（其他连接持有写锁）等：稍后重试，回填链不中断
        console.warn('[search-index] backfill slice postponed:', err instanceof Error ? err.message : err)
        this.timer = setTimeout(step, 2000)
        return
      }
      if (done) {
        this.recount()
        this.report(true)
        // 回填期间其他连接写入的行若仍有遗漏，稍后再扫一轮（不阻塞）
        if (!this.complete) {
          this.cursor = Number.MAX_SAFE_INTEGER
          this.timer = setTimeout(step, 60_000)
        }
        return
      }
      this.report(false)
      // 片间让出主线程（约 25% 占空比）：界面操作与同步优先
      this.timer = setTimeout(step, 60)
    }
    this.timer = setTimeout(step, delayMs)
  }

  /** 回填一片（最多 budgetMs 毫秒）；返回 true = 已没有待回填的邮件。测试 / 压测可直接循环调用 */
  backfillSlice(budgetMs: number): boolean {
    if (!this.enabled) return true
    this.pickStmt ??= this.db.prepare(
      'SELECT m.rowid AS r FROM messages m WHERE m.rowid < ? AND NOT EXISTS (SELECT 1 FROM search_doc d WHERE d.rowid = m.rowid) ORDER BY m.rowid DESC LIMIT ?'
    )
    const t0 = performance.now()
    while (performance.now() - t0 < budgetMs) {
      const ids = (this.pickStmt.all(this.cursor, 40) as { r: number }[]).map(r => r.r)
      if (!ids.length) return true
      this.complete = false
      try {
        this.indexRows(ids)
      } catch (err) {
        if (isBusy(err)) throw err
        // 整批失败：逐行重试，个别坏行记入 search_doc 跳过（记日志），不让回填卡在同一处
        console.error('[search-index] backfill batch failed, retrying row by row:', err)
        for (const id of ids) {
          try {
            this.indexRows([id])
          } catch (e) {
            if (isBusy(e)) throw e
            console.error('[search-index] skip row', id, e)
            this.db.prepare('INSERT OR IGNORE INTO search_doc(rowid) VALUES (?)').run(id)
          }
        }
      }
      this.indexed += ids.length
      this.cursor = ids[ids.length - 1]
    }
    return false
  }

  /** 为这些 messages.rowid 重建索引（单事务） */
  private indexRows(ids: number[]) {
    const ph = ids.map(() => '?').join(',')
    this.db.exec('BEGIN')
    try {
      // 先删再插：TEMP 触发器可能已经为其中某行建过索引（与回填交错时）
      this.db.prepare(`DELETE FROM search_fts WHERE rowid IN (${ph})`).run(...ids)
      this.db
        .prepare(`INSERT INTO search_fts(rowid, subject, sender, recipients, body) SELECT m.rowid, ${docValues('m')} FROM messages m WHERE m.rowid IN (${ph})`)
        .run(...ids)
      this.db.prepare(`INSERT OR IGNORE INTO search_doc(rowid) SELECT rowid FROM messages WHERE rowid IN (${ph})`).run(...ids)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private report(force: boolean) {
    const now = Date.now()
    if (!force && now - this.lastReport < 1000) return
    this.lastReport = now
    if (this.indexed >= this.total) this.complete = true
    try {
      this.onProgress?.(this.status())
    } catch {
      /* ignore */
    }
  }
}
