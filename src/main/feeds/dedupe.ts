import type { SearchResult } from '@shared/feeds'

/**
 * 去重与规范化（纯函数，单测覆盖）：
 *  - URL 规范化：协议 / www / 默认端口 / 片段 / 跟踪参数 / 参数顺序 / 结尾斜杠
 *  - 条目去重键：guid > 规范化链接 > 标题 + 日期哈希
 *  - 标题相似度：字二元组 Dice 系数（中英文通吃），新闻搜索里「同一条新闻多家转载」靠它合并
 *  - 搜索结果合并：多来源合并 + 与历史去重 + 排除词过滤
 */

const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|yclid|igshid|spm|scm|share_token|sharer?_?source|from|ref|ref_src|source|src|cmpid|campaign|_hsenc|_hsmi|ocid|cvid|ei|ved|usg|oq|gs_lcp|wt\.mc_id)$/i

export function normalizeUrl(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return s.toLowerCase()
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return s
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|amp)\./, '')
  const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : ''
  let path = u.pathname.replace(/\/{2,}/g, '/')
  path = path.replace(/\/(index\.(html?|php|aspx?))$/i, '/')
  if (path.length > 1) path = path.replace(/\/+$/, '')
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
  const q = params.length ? `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : ''
  return `${host}${port}${path === '/' ? '' : path}${q}`
}

/** FNV-1a 32 位（不需要密码学强度，只做去重键） */
export function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** 标题归一：去掉「 - 来源」后缀、标点、空白，统一小写 */
export function titleKey(title: string | null | undefined): string {
  return String(title ?? '')
    .replace(/\s+[-–—|｜_]\s+[^-–—|｜_]{1,40}$/u, '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

/** 条目去重键：guid > 链接 > 标题 + 发布日（日精度，同一天同标题视为同一条） */
export function itemKey(it: { guid?: string | null; url?: string | null; title?: string | null; publishedAt?: number | null }): string {
  const g = String(it.guid ?? '').trim()
  if (g) return `g:${g.length > 200 ? hash(g) + g.slice(0, 120) : g}`
  const u = normalizeUrl(it.url)
  if (u) return `u:${u.length > 300 ? hash(u) + u.slice(0, 200) : u}`
  const day = it.publishedAt ? new Date(it.publishedAt).toISOString().slice(0, 10) : ''
  return `h:${hash(`${titleKey(it.title)}|${day}`)}`
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>()
  if (s.length < 2) {
    if (s) m.set(s, 1)
    return m
  }
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

/** 标题相似度 0~1（字二元组 Dice 系数） */
export function titleSimilarity(a: string, b: string): number {
  const x = titleKey(a)
  const y = titleKey(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const A = bigrams(x)
  const B = bigrams(y)
  let inter = 0
  let total = 0
  for (const v of A.values()) total += v
  for (const v of B.values()) total += v
  for (const [g, v] of A) inter += Math.min(v, B.get(g) ?? 0)
  return total ? (2 * inter) / total : 0
}

export const SIMILAR_TITLE = 0.82

export interface SeenHistory {
  urls: Set<string>
  titles: string[]
}

/** 去掉新闻搜索在标题末尾附加的「 - 来源名」，并把来源记下来 */
export function splitSourceSuffix(title: string): { title: string; source: string | null } {
  const m = /^(.*\S)\s+[-–—|｜]\s+([^-–—|｜]{1,40})$/u.exec(String(title ?? '').trim())
  if (!m || m[1].length < 6) return { title: String(title ?? '').trim(), source: null }
  return { title: m[1].trim(), source: m[2].trim() }
}

/**
 * 合并多来源的搜索结果：
 *  - 规范化 URL 去重、标题相似（≥ 0.82）去重（保留摘要更长 / 更早出现的那条）
 *  - 与历史（之前简报里出现过的 URL / 标题）去重
 *  - 排除词：标题或摘要里出现即丢弃（大小写不敏感）
 *  - 按发布时间倒序；没有时间的排后
 */
export function mergeSearchResults(lists: SearchResult[][], history: SeenHistory, exclude: string[] = [], max = 30): SearchResult[] {
  const ex = exclude.map(w => w.trim().toLowerCase()).filter(Boolean)
  const out: SearchResult[] = []
  const urls = new Set<string>()
  for (const list of lists) {
    for (const r0 of list) {
      if (!r0?.url || !r0.title) continue
      const split = splitSourceSuffix(r0.title)
      const r: SearchResult = { ...r0, title: split.title, source: r0.source || split.source }
      const nu = normalizeUrl(r.url)
      if (!nu || urls.has(nu) || history.urls.has(nu)) continue
      const hay = `${r.title} ${r.snippet ?? ''}`.toLowerCase()
      if (ex.some(w => hay.includes(w))) continue
      if (history.titles.some(t => titleSimilarity(t, r.title) >= SIMILAR_TITLE)) continue
      const dup = out.findIndex(o => titleSimilarity(o.title, r.title) >= SIMILAR_TITLE)
      if (dup >= 0) {
        const o = out[dup]
        if ((r.snippet?.length ?? 0) > (o.snippet?.length ?? 0)) out[dup] = { ...o, snippet: r.snippet }
        urls.add(nu)
        continue
      }
      urls.add(nu)
      out.push(r)
    }
  }
  out.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
  return out.slice(0, max)
}
