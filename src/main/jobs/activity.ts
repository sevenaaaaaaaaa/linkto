import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AgentActivity, AgentRef } from '@shared/types'

/* eslint-disable @typescript-eslint/no-explicit-any */

const KEEP = 500

/**
 * 活动记录：Agent 在后台 / 技能 / 对话 / 首次整理里替用户做了什么。只留最近 500 条。
 * 另有一张「知识库学习记录」表：哪些邮件学过（结果、生成 / 合并到的条目），避免重复花 AI。
 */
export class ActivityStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_activity (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        refs_json TEXT DEFAULT '[]',
        stats_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_activity_at ON agent_activity(at);
      CREATE TABLE IF NOT EXISTS agent_kb_learned (
        message_id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        result TEXT NOT NULL,
        kb_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_kb_learned_at ON agent_kb_learned(at);
    `)
    // 一键动作（事件触发 / 会后跟进）：只新增列
    try {
      db.exec('ALTER TABLE agent_activity ADD COLUMN action_json TEXT')
    } catch {
      /* 已有该列 */
    }
  }

  add(a: Omit<AgentActivity, 'id' | 'at'> & { at?: number }): AgentActivity {
    const row: AgentActivity = {
      id: randomUUID(),
      at: a.at ?? Date.now(),
      source: a.source,
      title: String(a.title ?? '').slice(0, 200),
      detail: a.detail ? String(a.detail).slice(0, 2000) : null,
      refs: (a.refs ?? [])
        .filter((r, i, all) => all.findIndex(x => x.type === r.type && x.id === r.id) === i)
        .slice(0, 20)
        .map(r => ({ type: r.type, id: String(r.id), label: String(r.label ?? '').slice(0, 120) })),
      ...(a.stats ? { stats: a.stats } : {}),
      ...(a.action?.skillId ? { action: { label: String(a.action.label || '运行').slice(0, 20), skillId: String(a.action.skillId), messageId: a.action.messageId ?? null } } : {})
    }
    this.db
      .prepare('INSERT INTO agent_activity (id, at, source, title, detail, refs_json, stats_json, action_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.id, row.at, row.source, row.title, row.detail ?? null, JSON.stringify(row.refs ?? []), row.stats ? JSON.stringify(row.stats) : null, row.action ? JSON.stringify(row.action) : null)
    this.db.prepare(`DELETE FROM agent_activity WHERE id NOT IN (SELECT id FROM agent_activity ORDER BY at DESC LIMIT ${KEEP})`).run()
    return row
  }

  list(limit = 100): AgentActivity[] {
    const n = Math.max(1, Math.min(KEEP, Math.floor(Number(limit) || 100)))
    const rows = this.db.prepare('SELECT * FROM agent_activity ORDER BY at DESC LIMIT ?').all(n) as any[]
    return rows.map(r => {
      let refs: AgentRef[] = []
      let stats: Record<string, number> | undefined
      try {
        refs = JSON.parse(r.refs_json || '[]')
      } catch {
        /* ignore */
      }
      try {
        stats = r.stats_json ? JSON.parse(r.stats_json) : undefined
      } catch {
        /* ignore */
      }
      let action: AgentActivity['action'] = null
      try {
        action = r.action_json ? JSON.parse(r.action_json) : null
      } catch {
        /* ignore */
      }
      return { id: r.id, at: Number(r.at), source: r.source, title: r.title, detail: r.detail ?? null, refs, ...(stats ? { stats } : {}), ...(action ? { action } : {}) }
    })
  }

  // ---------------- 知识库学习记录 ----------------

  learnedIds(ids: string[]): Set<string> {
    const out = new Set<string>()
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400)
      if (!part.length) continue
      const rows = this.db.prepare(`SELECT message_id FROM agent_kb_learned WHERE message_id IN (${part.map(() => '?').join(',')})`).all(...part) as any[]
      for (const r of rows) out.add(r.message_id)
    }
    return out
  }

  markLearned(messageId: string, result: 'new' | 'merge' | 'skip' | 'unworthy' | 'error', kbId: string | null = null) {
    this.db
      .prepare('INSERT INTO agent_kb_learned (message_id, at, result, kb_id) VALUES (?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET at=excluded.at, result=excluded.result, kb_id=excluded.kb_id')
      .run(messageId, Date.now(), result, kbId)
  }

  /** since 之后学过（花过 AI）的邮件数 */
  learnedSince(since: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS c FROM agent_kb_learned WHERE at >= ? AND result != 'error'").get(since) as any)?.c ?? 0)
  }
}
