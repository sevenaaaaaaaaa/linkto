/**
 * 订阅（RSS / Atom / JSON Feed）与 AI 搜索订阅：主进程与渲染端共用的数据契约与小工具（纯函数，无 Electron 依赖）。
 * 示例中的公司 / 主题一律虚构。
 */

/** feed = 普通订阅源；search = AI 搜索订阅（主题 → 新闻搜索 → 简报） */
export type FeedKind = 'feed' | 'search'

export type FeedFormat = 'rss' | 'rdf' | 'atom' | 'json'

/** 搜索 API（需要用户自己的 Key，Key 存在系统钥匙串级的密钥存储里） */
export type SearchApiProvider = 'brave' | 'tavily' | 'serpapi'

export const SEARCH_API_LABEL: Record<SearchApiProvider, string> = {
  brave: 'Brave Search',
  tavily: 'Tavily',
  serpapi: 'SerpAPI（Google News）'
}

export const SEARCH_API_DEFAULT_BASE: Record<SearchApiProvider, string> = {
  brave: 'https://api.search.brave.com',
  tavily: 'https://api.tavily.com',
  serpapi: 'https://serpapi.com'
}

/** 新闻搜索来源模板：URL 里的占位符 {q} {hl} {gl} {ceid} {lang} {mkt} 运行时代入；返回 RSS / Atom */
export interface SearchTemplate {
  id: string
  name: string
  url: string
  enabled: boolean
  builtin?: boolean
}

export const DEFAULT_SEARCH_TEMPLATES: SearchTemplate[] = [
  { id: 'google-news', name: 'Google 新闻', url: 'https://news.google.com/rss/search?q={q}&hl={hl}&gl={gl}&ceid={ceid}', enabled: true, builtin: true },
  { id: 'bing-news', name: 'Bing 新闻', url: 'https://www.bing.com/news/search?q={q}&format=rss&setlang={lang}&cc={gl}', enabled: true, builtin: true }
]

/** 语言 / 地区（新闻搜索的 hl / gl / ceid） */
export const SEARCH_LOCALES: { id: string; label: string; hl: string; gl: string; ceid: string; lang: string; mkt: string }[] = [
  { id: 'zh-CN', label: '简体中文 · 中国', hl: 'zh-CN', gl: 'CN', ceid: 'CN:zh-Hans', lang: 'zh-hans', mkt: 'zh-CN' },
  { id: 'zh-TW', label: '繁體中文 · 台灣', hl: 'zh-TW', gl: 'TW', ceid: 'TW:zh-Hant', lang: 'zh-hant', mkt: 'zh-TW' },
  { id: 'zh-HK', label: '繁體中文 · 香港', hl: 'zh-HK', gl: 'HK', ceid: 'HK:zh-Hant', lang: 'zh-hant', mkt: 'zh-HK' },
  { id: 'en-US', label: 'English · United States', hl: 'en-US', gl: 'US', ceid: 'US:en', lang: 'en', mkt: 'en-US' },
  { id: 'en-GB', label: 'English · United Kingdom', hl: 'en-GB', gl: 'GB', ceid: 'GB:en', lang: 'en', mkt: 'en-GB' },
  { id: 'ja-JP', label: '日本語 · 日本', hl: 'ja', gl: 'JP', ceid: 'JP:ja', lang: 'ja', mkt: 'ja-JP' },
  { id: 'de-DE', label: 'Deutsch · Deutschland', hl: 'de', gl: 'DE', ceid: 'DE:de', lang: 'de', mkt: 'de-DE' }
]

export function searchLocale(id: string | null | undefined) {
  return SEARCH_LOCALES.find(l => l.id === id) ?? SEARCH_LOCALES[0]
}

/** AI 搜索订阅的主题定义 */
export interface FeedTopic {
  /** 主题 / 搜索词，如「新能源车 行业动态」「Northwind Robotics」 */
  query: string
  cadence: 'daily' | 'weekly'
  /** SEARCH_LOCALES 的 id */
  locale: string
  /** 排除词（标题 / 摘要里出现就丢掉；也会作为 -词 传给搜索） */
  exclude: string[]
  /** 用哪些来源：模板 id 或 'api:brave' / 'api:tavily' / 'api:serpapi' */
  sources: string[]
  /** 每次最多取多少条新结果进简报 */
  maxResults: number
}

export interface FeedSource {
  id: string
  kind: FeedKind
  title: string
  /** 订阅地址（search 为空） */
  url: string | null
  siteUrl: string | null
  group: string | null
  format: FeedFormat | null
  /** 更新频率（分钟）；null = 跟随默认 */
  intervalMin: number | null
  /** 点开只有摘要的条目时自动抓取原文 */
  fullText: boolean
  enabled: boolean
  topic: FeedTopic | null
  lastFetchAt: number | null
  lastOkAt: number | null
  nextFetchAt: number | null
  failCount: number
  lastError: string | null
  createdAt: number
  unread: number
  total: number
}

export interface FeedEnclosure {
  url: string
  type: string | null
  length: number | null
}

/** 搜索结果（新闻搜索 RSS / 搜索 API 合并后） */
export interface SearchResult {
  title: string
  url: string
  source?: string | null
  publishedAt?: number | null
  snippet?: string | null
}

/** article = 订阅源文章；brief = AI 搜索订阅的一次简报（或无 AI 时的结果列表） */
export type FeedItemKind = 'article' | 'brief'

export interface FeedItem {
  id: string
  sourceId: string
  sourceTitle: string
  sourceKind: FeedKind
  kind: FeedItemKind
  title: string
  url: string | null
  author: string | null
  /** 纯文本摘要（≤ 300 字） */
  summary: string
  publishedAt: number | null
  fetchedAt: number
  /** 列表排序用时间（发布时间，缺失或在未来时用抓取时间） */
  sortAt: number
  read: boolean
  starred: boolean
  hasFull: boolean
  aiSummary: string | null
  enclosures: FeedEnclosure[]
}

export interface FeedItemDetail extends FeedItem {
  /** 已消毒的正文 HTML（订阅源自带的内容） */
  contentHtml: string
  /** 已消毒的全文 HTML（抓取原文后） */
  fullHtml: string | null
  /** 简报引用的搜索结果（brief） */
  results?: SearchResult[]
}

export interface FeedCandidate {
  url: string
  title: string | null
  type: string | null
}

/** 列表范围 */
export type FeedScope = { kind: 'all' } | { kind: 'starred' } | { kind: 'source'; id: string } | { kind: 'group'; name: string } | { kind: 'topics' } | { kind: 'digest' }

export type FeedFilter = 'unread' | 'all' | 'starred'

export interface FeedItemQuery {
  scope: FeedScope
  filter: FeedFilter
  q?: string
  limit?: number
  /** 分页：返回 sortAt < before 的 */
  before?: number | null
}

export interface FeedSettings {
  /** 默认更新频率（分钟） */
  defaultIntervalMin: number
  /** 每个源最多保留多少条（收藏的不算） */
  maxItemsPerFeed: number
  /** 已读多少天后清理（收藏的保留）；0 = 不按时间清理 */
  keepReadDays: number
  /** 每天生成「今日订阅精华」 */
  digest: boolean
  /** 精华并入今日简报卡片 */
  digestInBrief: boolean
  /** 阅读时默认加载远程图片 */
  loadImages: boolean
  templates: SearchTemplate[]
  /** 搜索 API 自定义端点（为空用官方地址） */
  apiBase: Partial<Record<SearchApiProvider, string>>
}

export const DEFAULT_FEED_SETTINGS: FeedSettings = {
  defaultIntervalMin: 60,
  maxItemsPerFeed: 300,
  keepReadDays: 30,
  digest: false,
  digestInBrief: true,
  loadImages: false,
  templates: DEFAULT_SEARCH_TEMPLATES,
  apiBase: {}
}

export const FEED_INTERVALS: { value: number; label: string }[] = [
  { value: 15, label: '每 15 分钟' },
  { value: 30, label: '每 30 分钟' },
  { value: 60, label: '每小时' },
  { value: 120, label: '每 2 小时' },
  { value: 360, label: '每 6 小时' },
  { value: 720, label: '每 12 小时' },
  { value: 1440, label: '每天' }
]

/** 今日订阅精华 */
export interface FeedDigest {
  day: string
  headline: string
  /** 已转义 / 自建的 HTML（链接只来自条目本身） */
  html: string
  source: 'ai' | 'list'
  count: number
  createdAt: number
}

export interface FeedRefreshResult {
  ok: boolean
  checked: number
  updated: number
  notModified: number
  added: number
  failed: number
  error?: string
}

export interface FeedTopicRunResult {
  ok: boolean
  found: number
  fresh: number
  itemId?: string | null
  source?: 'ai' | 'list' | null
  error?: string
  /** 各来源的抓取情况 */
  sources?: { id: string; ok: boolean; count: number; error?: string }[]
}

/** 把来源模板代入主题（排除词作为 -词 一并传给搜索） */
export function fillSearchTemplate(url: string, topic: Pick<FeedTopic, 'query' | 'locale' | 'exclude'>): string {
  const loc = searchLocale(topic.locale)
  const q = [topic.query.trim(), ...topic.exclude.map(w => w.trim()).filter(Boolean).map(w => `-${/\s/.test(w) ? `"${w}"` : w}`)].join(' ')
  const map: Record<string, string> = { q, hl: loc.hl, gl: loc.gl, ceid: loc.ceid, lang: loc.lang, mkt: loc.mkt }
  return url.replace(/\{(q|hl|gl|ceid|lang|mkt)\}/g, (_m, k: string) => encodeURIComponent(map[k] ?? ''))
}

export function feedIntervalLabel(min: number | null | undefined, def: number): string {
  const v = min ?? def
  return FEED_INTERVALS.find(i => i.value === v)?.label ?? `每 ${v} 分钟`
}

export function scopeKey(s: FeedScope): string {
  switch (s.kind) {
    case 'source':
      return `f/${encodeURIComponent(s.id)}`
    case 'group':
      return `g/${encodeURIComponent(s.name)}`
    default:
      return s.kind
  }
}

export function scopeFromKey(key: string | null | undefined): FeedScope {
  const k = String(key ?? '')
  if (k.startsWith('f/')) return { kind: 'source', id: decodeURIComponent(k.slice(2)) }
  if (k.startsWith('g/')) return { kind: 'group', name: decodeURIComponent(k.slice(2)) }
  if (k === 'starred' || k === 'topics' || k === 'digest') return { kind: k }
  return { kind: 'all' }
}
