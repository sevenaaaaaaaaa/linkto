import { createHash } from 'node:crypto'
import {
  canonicalContent, contentOf, emptyLinks, isTraceChannel, newMaterialId, parseChat,
  type TraceContent, type TraceData, type TraceInput, type TraceMaterial, type TraceSummary
} from '@shared/trace'

/**
 * 留痕的不可篡改提示（纯函数，无 Electron 依赖，单测可直接跑）：
 *  - 内容哈希：SHA-256(规范化 JSON(标题 + 场景 + 发生时间 + 参与人 + 原始材料 + 整理结果))
 *  - 修改留历史：任何内容改动先把「修改前的完整内容 + 当时的哈希」压进 versions，再写新内容与新哈希
 *  - 校验：重算当前内容的哈希与记录的哈希比对；历史版本逐个重算
 * 这是「本机可自证」的提示，不是法律意义上的存证：数据库在用户自己手里，改动 + 重算哈希仍然可能；
 * 书面确认邮件（对方回信）与发给自己的存档邮件才是第三方可见的留痕。
 */

/** 历史版本上限：保留最早的一版 + 最近的 MAX_VERSIONS-1 版 */
export const MAX_VERSIONS = 50

export function hashContent(c: TraceContent): string {
  return createHash('sha256').update(canonicalContent(c), 'utf8').digest('hex')
}

/** 清洗一条材料：聊天格式的文字顺带解析出消息 */
export function normMaterial(m: Omit<TraceMaterial, 'id' | 'addedAt'> & { id?: string; addedAt?: number }, now: number): TraceMaterial | null {
  const text = String(m.text ?? '')
    .replace(/\r\n?/g, '\n')
    .slice(0, 60_000)
    .trim()
  if (!text) return null
  const kind = m.kind === 'chat' || m.kind === 'ocr' || m.kind === 'note' || m.kind === 'mail' ? m.kind : 'text'
  const out: TraceMaterial = { id: m.id || newMaterialId(), kind, text, addedAt: m.addedAt ?? now }
  if (m.label) out.label = String(m.label).slice(0, 60)
  if (m.messageId) out.messageId = String(m.messageId)
  if (m.fileName) out.fileName = String(m.fileName).slice(0, 120)
  if (m.ocrMethod) out.ocrMethod = String(m.ocrMethod)
  // 粘贴的文字 / 截图识字认得出聊天结构的：解析发言人与时间（kind 记为 chat，截图保留 ocr 以示来源）
  if (kind === 'chat' || kind === 'text' || kind === 'ocr') {
    const p = parseChat(text, now)
    if (p.lines.length >= 2 || (kind === 'chat' && p.lines.length)) {
      out.lines = p.lines
      out.pattern = p.pattern
      if (kind === 'text') out.kind = 'chat'
    }
  }
  return out
}

const normSummary = (s: TraceInput['summary'] | TraceSummary | null | undefined, now: number): TraceSummary | null => {
  if (!s) return null
  return {
    conclusion: String(s.conclusion ?? '').slice(0, 800),
    agreements: (s.agreements ?? [])
      .filter(a => a && String(a.what ?? '').trim())
      .slice(0, 20)
      .map(a => ({
        who: String(a.who ?? '').slice(0, 40),
        what: String(a.what ?? '').slice(0, 300),
        when: a.when ? String(a.when).slice(0, 80) : null,
        amount: a.amount ? String(a.amount).slice(0, 80) : null,
        quote: a.quote ? String(a.quote).slice(0, 160) : null,
        ...(a.flags?.length ? { flags: a.flags } : {})
      })),
    pending: (s.pending ?? []).map(x => String(x).slice(0, 240)).filter(Boolean).slice(0, 20),
    risks: (s.risks ?? []).map(x => String(x).slice(0, 240)).filter(Boolean).slice(0, 20),
    by: (s as TraceSummary).by ?? 'manual',
    at: (s as TraceSummary).at ?? now,
    ...((s as TraceSummary).warnings?.length ? { warnings: (s as TraceSummary).warnings } : {})
  }
}

/** 新记录：内容 + 首次哈希 */
export function newTraceData(input: TraceInput, now = Date.now()): { title: string; data: TraceData } {
  const materials = (input.materials ?? []).map(m => normMaterial(m, now)).filter((m): m is TraceMaterial => !!m)
  const parties = (input.parties ?? [])
    .map(p => ({ name: String(p?.name ?? '').trim().slice(0, 40), email: p?.email ? String(p.email).trim().toLowerCase().slice(0, 120) : null, ...(p?.me ? { me: true } : {}) }))
    .filter(p => p.name || p.email)
    .map(p => ({ ...p, name: p.name || String(p.email).split('@')[0] }))
  const title = String(input.title ?? '').trim().slice(0, 120) || '未命名留痕'
  const base = {
    channel: isTraceChannel(input.channel) ? input.channel : 'other',
    occurredAt: input.occurredAt ?? null,
    parties,
    materials,
    summary: normSummary(input.summary, now)
  } as Pick<TraceData, 'channel' | 'occurredAt' | 'parties' | 'materials' | 'summary'>
  const hash = hashContent(contentOf(title, base))
  const links = emptyLinks()
  links.messageIds = [...new Set((input.messageIds ?? []).map(String))]
  links.projectIds = [...new Set((input.projectIds ?? []).map(String))]
  links.financeIds = [...new Set((input.financeIds ?? []).map(String))]
  return {
    title,
    data: {
      ...base,
      status: base.summary ? 'organized' : 'draft',
      links,
      confirm: null,
      hash,
      hashAlgo: 'sha256',
      firstHash: hash,
      createdAt: now,
      versions: [],
      source: input.source ?? 'manual',
      memoryIds: [],
      updatedAt: now
    }
  }
}

export type ContentPatch = Partial<TraceContent>

/**
 * 写入内容改动：内容（哈希）真的变了才把旧内容压进历史；返回新标题、新数据与是否改动。
 * 只改状态 / 关联 / 确认信息不经过这里（不算内容，不产生版本）。
 */
export function commitVersion(title: string, d: TraceData, patch: ContentPatch, reason: string, now = Date.now()): { title: string; data: TraceData; changed: boolean } {
  const before = contentOf(title, d)
  const nextTitle = patch.title !== undefined ? String(patch.title).trim().slice(0, 120) || title : title
  const next: TraceData = {
    ...d,
    ...(patch.channel !== undefined && isTraceChannel(patch.channel) ? { channel: patch.channel } : {}),
    ...(patch.occurredAt !== undefined ? { occurredAt: patch.occurredAt } : {}),
    ...(patch.parties !== undefined ? { parties: patch.parties } : {}),
    ...(patch.materials !== undefined ? { materials: patch.materials } : {}),
    ...(patch.summary !== undefined ? { summary: normSummary(patch.summary, now) } : {})
  }
  const hash = hashContent(contentOf(nextTitle, next))
  if (hash === d.hash) return { title: nextTitle, data: d, changed: false }
  let versions = [...(d.versions ?? []), { at: now, hash: d.hash || hashContent(before), reason: String(reason || '修改').slice(0, 80), content: before }]
  if (versions.length > MAX_VERSIONS) versions = [versions[0], ...versions.slice(versions.length - (MAX_VERSIONS - 1))]
  return { title: nextTitle, data: { ...next, hash, versions, updatedAt: now }, changed: true }
}

/** 校验：当前内容与记录的哈希是否一致；历史版本逐个重算 */
export function verifyRecord(title: string, d: TraceData): { ok: boolean; hash: string; computed: string; versions: boolean[] } {
  const computed = hashContent(contentOf(title, d))
  return { ok: computed === d.hash, hash: d.hash, computed, versions: (d.versions ?? []).map(v => hashContent(v.content) === v.hash) }
}
