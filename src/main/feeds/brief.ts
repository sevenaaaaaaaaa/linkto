/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SearchResult } from '@shared/feeds'
import { escapeHtml } from './html'

/**
 * 简报 / 精华的 HTML 生成（纯函数）：AI 只给要点与「引用编号」，链接一律由这里按编号从搜索结果 / 条目里取，
 * AI 文字里夹带的任何网址都被剥掉——简报里不可能出现搜索结果以外的链接。
 */

export function jsonFromText(text: string): any {
  const s = String(text ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const body = fenced ? fenced[1] : s
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

/** 去掉文字里的网址（含 markdown 链接，保留链接文字） */
export function stripUrls(s: unknown): string {
  return String(s ?? '')
    .replace(/\[([^\]]*)\]\((?:https?:|www\.)[^)]*\)/gi, '$1')
    .replace(/<?(?:https?:\/\/|www\.)[^\s<>()（）]+>?/gi, '')
    // 网址去掉后留下的空括号（「（见 ）」「(see )」）
    .replace(/[（(]\s*(?:见|详见|参见|来源|see|via|source)?[:：]?\s*[)）]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function refList(raw: unknown, n: number): number[] {
  const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
  const out: number[] = []
  for (const v of arr) {
    const k = Math.round(Number(String(v).replace(/[[\]\s]/g, '')))
    if (Number.isFinite(k) && k >= 1 && k <= n && !out.includes(k)) out.push(k)
  }
  return out.slice(0, 6)
}

function host(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const fmtDay = (t: number | null | undefined) => {
  if (!t) return ''
  const d = new Date(t)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function sourceLinks(refs: number[], results: { title: string; url: string; source?: string | null }[]): string {
  return refs
    .map(k => {
      const r = results[k - 1]
      const label = r.source || host(r.url) || `来源 ${k}`
      return `<a href="${escapeHtml(r.url)}" title="${escapeHtml(r.title)}">[${k}] ${escapeHtml(label)}</a>`
    })
    .join(' · ')
}

function resultList(results: SearchResult[]): string {
  return `<ol>${results
    .map(
      r =>
        `<li><a href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a>${r.source || r.publishedAt ? ` <small>${escapeHtml([r.source, fmtDay(r.publishedAt)].filter(Boolean).join(' · '))}</small>` : ''}${
          r.snippet ? `<br><small>${escapeHtml(r.snippet)}</small>` : ''
        }</li>`
    )
    .join('')}</ol>`
}

export interface BriefBuild {
  title: string
  headline: string
  html: string
  summary: string
  source: 'ai' | 'list'
  /** AI 输出里被丢掉的引用（编号越界）个数，调试用 */
  droppedRefs: number
}

/** AI 搜索订阅的简报：ai = 模型输出（可为 null → 结果列表） */
export function buildTopicBrief(topic: string, results: SearchResult[], ai: any | null, now = Date.now()): BriefBuild {
  const day = fmtDay(now)
  const points = Array.isArray(ai?.points) ? ai.points : []
  let dropped = 0
  const valid = points
    .map((p: any) => {
      const raw = Array.isArray(p?.refs) ? p.refs.length : 0
      const refs = refList(p?.refs, results.length)
      dropped += raw - refs.length
      return { title: stripUrls(p?.title).slice(0, 60), detail: stripUrls(p?.detail).slice(0, 300), why: stripUrls(p?.why).slice(0, 200), refs }
    })
    .filter((p: any) => (p.title || p.detail) && p.refs.length)
  if (!valid.length) {
    const headline = `${topic}：${results.length} 条新结果`
    return {
      title: `${topic} · ${day}`,
      headline,
      html: `<p>${escapeHtml(headline)}</p>${resultList(results)}`,
      summary: results
        .slice(0, 3)
        .map(r => r.title)
        .join('；'),
      source: 'list',
      droppedRefs: dropped
    }
  }
  const headline = stripUrls(ai?.headline).slice(0, 80) || `${topic}：${valid.length} 个要点`
  const used = new Set<number>()
  const body = valid
    .map((p: any) => {
      p.refs.forEach((k: number) => used.add(k))
      return `<li><strong>${escapeHtml(p.title || p.detail.slice(0, 30))}</strong>${p.detail ? `<br>${escapeHtml(p.detail)}` : ''}${p.why ? `<br><em>为什么重要：${escapeHtml(p.why)}</em>` : ''}<br><small>来源：${sourceLinks(p.refs, results)}</small></li>`
    })
    .join('')
  const rest = results.filter((_r, i) => !used.has(i + 1))
  const html = `<p><strong>${escapeHtml(headline)}</strong></p><ol>${body}</ol>${rest.length ? `<h4>其他结果</h4>${resultList(rest)}` : ''}`
  return {
    title: `${topic} · ${day}`,
    headline,
    html,
    summary: `${headline}｜${valid
      .slice(0, 3)
      .map((p: any) => p.title)
      .join('；')}`,
    source: 'ai',
    droppedRefs: dropped
  }
}

export interface DigestEntry {
  id: string
  title: string
  url: string | null
  source: string
  summary: string
}

/** 今日订阅精华 */
export function buildDigest(entries: DigestEntry[], ai: any | null, now = Date.now()): { headline: string; html: string; source: 'ai' | 'list' } {
  const linkOf = (k: number) => {
    const e = entries[k - 1]
    const label = `[${k}] ${e.source}`
    return e.url ? `<a href="${escapeHtml(e.url)}" title="${escapeHtml(e.title)}">${escapeHtml(label)}</a>` : escapeHtml(label)
  }
  const sections = (Array.isArray(ai?.sections) ? ai.sections : [])
    .map((s: any) => ({
      theme: stripUrls(s?.theme).slice(0, 24),
      points: (Array.isArray(s?.points) ? s.points : []).map((p: any) => ({ text: stripUrls(p?.text).slice(0, 200), refs: refList(p?.refs, entries.length) })).filter((p: any) => p.text && p.refs.length)
    }))
    .filter((s: any) => s.points.length)
  if (!sections.length) {
    const groups = new Map<string, DigestEntry[]>()
    for (const e of entries) groups.set(e.source, [...(groups.get(e.source) ?? []), e])
    const headline = `今天订阅更新了 ${entries.length} 篇`
    const html = [...groups]
      .map(
        ([src, list]) =>
          `<h4>${escapeHtml(src)}</h4><ul>${list
            .slice(0, 6)
            .map(e => `<li>${e.url ? `<a href="${escapeHtml(e.url)}">${escapeHtml(e.title)}</a>` : escapeHtml(e.title)}</li>`)
            .join('')}</ul>`
      )
      .join('')
    return { headline, html: `<p>${escapeHtml(headline)}（${fmtDay(now)}）</p>${html}`, source: 'list' }
  }
  const headline = stripUrls(ai?.headline).slice(0, 80) || `今日订阅精华（${fmtDay(now)}）`
  const html = `<p><strong>${escapeHtml(headline)}</strong></p>${sections
    .map((s: any) => `<h4>${escapeHtml(s.theme || '要点')}</h4><ul>${s.points.map((p: any) => `<li>${escapeHtml(p.text)} <small>${p.refs.map(linkOf).join(' · ')}</small></li>`).join('')}</ul>`)
    .join('')}`
  return { headline, html, source: 'ai' }
}

/** 给 AI 的编号结果清单 */
export function numberedResults(results: SearchResult[]): string {
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n来源：${r.source || host(r.url) || '未知'}${r.publishedAt ? ` · ${new Date(r.publishedAt).toISOString().slice(0, 10)}` : ''}${r.snippet ? `\n摘要：${r.snippet.slice(0, 240)}` : ''}`)
    .join('\n\n')
}
