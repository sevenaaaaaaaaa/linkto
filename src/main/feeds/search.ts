/* eslint-disable @typescript-eslint/no-explicit-any */
import { searchLocale, SEARCH_API_DEFAULT_BASE, type FeedTopic, type SearchApiProvider, type SearchResult } from '@shared/feeds'
import { htmlToText } from './html'
import { parseFeedDate, type ParsedFeed } from './parse'

/**
 * 搜索来源（纯函数部分）：
 *  - 新闻搜索 RSS（模板）→ 解析后的订阅 → SearchResult
 *  - 搜索 API（Brave / Tavily / SerpAPI）：请求构造 + 响应解析；网络请求由服务层的安全抓取执行
 * 只把用户在「AI 搜索订阅」里写的主题发给搜索服务，绝不带邮件内容。
 */

export function resultsFromFeed(feed: ParsedFeed): SearchResult[] {
  return feed.items.map(it => ({
    title: it.title,
    url: it.url ?? '',
    source: it.author ?? null,
    publishedAt: it.publishedAt,
    snippet: it.summary ? it.summary.slice(0, 280) : null
  }))
}

export interface ApiRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
}

function queryOf(topic: Pick<FeedTopic, 'query' | 'exclude'>): string {
  return [topic.query.trim(), ...topic.exclude.map(w => w.trim()).filter(Boolean).map(w => `-${w}`)].join(' ')
}

export function buildApiRequest(provider: SearchApiProvider, topic: Pick<FeedTopic, 'query' | 'exclude' | 'locale' | 'cadence'>, key: string, base?: string | null, count = 20): ApiRequest {
  const root = String(base || SEARCH_API_DEFAULT_BASE[provider]).replace(/\/+$/, '')
  const loc = searchLocale(topic.locale)
  const q = queryOf(topic)
  if (provider === 'brave') {
    const p = new URLSearchParams({ q, count: String(Math.min(50, count)), country: loc.gl, search_lang: loc.lang.startsWith('zh') ? (loc.lang === 'zh-hant' ? 'zh-hant' : 'zh-hans') : loc.lang, freshness: topic.cadence === 'weekly' ? 'pw' : 'pd' })
    return { url: `${root}/res/v1/news/search?${p}`, method: 'GET', headers: { Accept: 'application/json', 'X-Subscription-Token': key } }
  }
  if (provider === 'tavily') {
    return {
      url: `${root}/search`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: q, topic: 'news', max_results: Math.min(20, count), days: topic.cadence === 'weekly' ? 7 : 2, include_answer: false })
    }
  }
  const p = new URLSearchParams({ engine: 'google_news', q, hl: loc.hl.toLowerCase(), gl: loc.gl.toLowerCase(), api_key: key })
  return { url: `${root}/search.json?${p}`, method: 'GET', headers: { Accept: 'application/json' } }
}

/** Brave 的 age：「2 hours ago」「3 days ago」或 ISO 时间 */
function relativeAge(s: unknown, now: number): number | null {
  const str = String(s ?? '').trim()
  if (!str) return null
  const m = /^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i.exec(str)
  if (m) {
    const unit = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2].toLowerCase() as 'minute']
    return now - Number(m[1]) * unit
  }
  return parseFeedDate(str, now)
}

export function parseApiResponse(provider: SearchApiProvider, json: any, now = Date.now()): SearchResult[] {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '')
    } catch {
      return null
    }
  }
  if (!json || typeof json !== 'object') return []
  if (provider === 'brave') {
    const list = Array.isArray(json.results) ? json.results : Array.isArray(json.news?.results) ? json.news.results : []
    return list
      .filter((r: any) => r && /^https?:\/\//i.test(str(r.url)))
      .map((r: any) => ({
        title: htmlToText(str(r.title)),
        url: str(r.url),
        source: str(r.meta_url?.hostname) || host(str(r.url)),
        publishedAt: relativeAge(r.page_age, now) ?? relativeAge(r.age, now),
        snippet: htmlToText(str(r.description)).slice(0, 280) || null
      }))
  }
  if (provider === 'tavily') {
    const list = Array.isArray(json.results) ? json.results : []
    return list
      .filter((r: any) => r && /^https?:\/\//i.test(str(r.url)))
      .map((r: any) => ({
        title: str(r.title),
        url: str(r.url),
        source: host(str(r.url)),
        publishedAt: parseFeedDate(str(r.published_date), now),
        snippet: str(r.content).slice(0, 280) || null
      }))
  }
  const list = Array.isArray(json.news_results) ? json.news_results : []
  const flat: any[] = []
  for (const r of list) {
    if (Array.isArray(r?.stories)) flat.push(...r.stories)
    else flat.push(r)
  }
  return flat
    .filter((r: any) => r && /^https?:\/\//i.test(str(r.link)))
    .map((r: any) => ({
      title: str(r.title),
      url: str(r.link),
      source: str(r.source?.name) || str(r.source) || host(str(r.link)),
      publishedAt: parseFeedDate(str(r.iso_date) || str(r.date), now),
      snippet: str(r.snippet).slice(0, 280) || null
    }))
}

/** API 的错误响应 → 中文原因 */
export function apiErrorText(status: number, body: string): string {
  if (status === 401 || status === 403) return 'Key 无效或没有权限'
  if (status === 429) return '请求太频繁或额度用完'
  if (status >= 500) return `搜索服务出错（${status}）`
  const msg = /"(?:message|error|detail)"\s*:\s*"([^"]{1,120})"/.exec(body)?.[1]
  return msg ? `请求失败：${msg}` : `请求失败（HTTP ${status}）`
}
