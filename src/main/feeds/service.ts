/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  DEFAULT_FEED_SETTINGS, DEFAULT_SEARCH_TEMPLATES, fillSearchTemplate, SEARCH_API_LABEL,
  type FeedCandidate, type FeedDigest, type FeedItemQuery, type FeedRefreshResult, type FeedSettings, type FeedSource, type FeedTopic,
  type FeedTopicRunResult, type SearchApiProvider, type SearchResult, type SearchTemplate
} from '@shared/feeds'
import type { AISettings } from '@shared/types'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import type { AIService } from '../ai/service'
import { aiReady } from '../ai/service'
import { FEED_DIGEST, FEED_ITEM_SUMMARY, FEED_TOPIC_BRIEF } from '../ai/prompts'
import { isBudgetError } from '../jobs/budget'
import { FeedStore } from './store'
import { decodeBody, FeedParseError, parseFeed, sniffFeed, type ParsedFeed } from './parse'
import { discoverFeeds, guessFeedUrls, pageTitle } from './discover'
import { extractArticle } from './extract'
import { buildOpml, parseOpml } from './opml'
import { mergeSearchResults } from './dedupe'
import { buildApiRequest, parseApiResponse, apiErrorText, resultsFromFeed } from './search'
import { buildDigest, buildTopicBrief, jsonFromText, numberedResults } from './brief'
import { assertHttpUrl, backoffMinutes, FetchError, normalizeInputUrl, safeFetch, type SafeFetchResult } from './fetch'
import { htmlToText } from './html'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const SETTINGS_KEY = 'feedSettings'
const PROVIDERS: SearchApiProvider[] = ['brave', 'tavily', 'serpapi']
const secretId = (p: SearchApiProvider) => `feed:search:${p}`

export interface FeedServiceDeps {
  store: MailStore
  appStore: AppStore
  ai: AIService
  getAISettings(): AISettings
  event(payload: unknown): void
  /** 测试用：替换网络请求 */
  fetchImpl?: typeof fetch
}

export interface AddSourceInput {
  url: string
  group?: string | null
  title?: string | null
  intervalMin?: number | null
  fullText?: boolean
  /** 网页有多个订阅时自动选第一个（Agent / OPML 用） */
  autoPick?: boolean
}

export interface AddSourceResult {
  ok: boolean
  source?: FeedSource
  /** 网页里发现了多个订阅：让用户选 */
  candidates?: FeedCandidate[]
  /** 已经订阅过 */
  existing?: FeedSource
  error?: string
  /** 是从网页自动发现的 */
  discovered?: boolean
  added?: number
}

const ymd = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function errText(err: unknown): string {
  if (err instanceof FetchError || err instanceof FeedParseError) return err.message
  return err instanceof Error ? err.message.slice(0, 200) : String(err)
}

/**
 * 订阅服务：订阅源（添加 / 自动发现 / 条件请求更新 / 失败退避 / 保留策略 / OPML）、
 * 阅读（列表 / 已读 / 收藏 / 全文抓取 / AI 摘要 / 加入阅读清单）、
 * AI 搜索订阅（模板新闻搜索 + 搜索 API → 去重 → AI 简报，只引用搜索结果里的链接）、今日订阅精华。
 */
export class FeedService {
  readonly db: FeedStore
  private refreshing = new Set<string>()
  private changedTimer: NodeJS.Timeout | null = null

  constructor(
    private deps: FeedServiceDeps,
    db: FeedStore
  ) {
    this.db = db
  }

  // ---------------------------------------------------------------- 设置

  settings(): FeedSettings {
    const s = this.deps.appStore.get<FeedSettings>(SETTINGS_KEY, DEFAULT_FEED_SETTINGS)
    const templates = Array.isArray(s.templates) && s.templates.length ? s.templates : DEFAULT_SEARCH_TEMPLATES
    return {
      defaultIntervalMin: Math.max(5, Math.min(1440, Math.round(Number(s.defaultIntervalMin) || 60))),
      maxItemsPerFeed: Math.max(20, Math.min(5000, Math.round(Number(s.maxItemsPerFeed) || 300))),
      keepReadDays: Math.max(0, Math.min(3650, Math.round(Number(s.keepReadDays) || 0))),
      digest: !!s.digest,
      digestInBrief: s.digestInBrief !== false,
      loadImages: !!s.loadImages,
      templates: templates
        .filter(t => t && typeof t.url === 'string')
        .map(t => ({ id: String(t.id || `tpl-${Math.random().toString(36).slice(2, 8)}`), name: String(t.name || '自定义来源').slice(0, 40), url: String(t.url).trim(), enabled: t.enabled !== false, builtin: !!t.builtin })),
      apiBase: typeof s.apiBase === 'object' && s.apiBase ? s.apiBase : {}
    }
  }

  setSettings(patch: Partial<FeedSettings>): FeedSettings {
    const cur = this.settings()
    const next: FeedSettings = { ...cur, ...patch }
    if (patch.templates) {
      // 模板只允许 http(s)，且必须含 {q}
      next.templates = patch.templates.filter(t => {
        try {
          return /\{q\}/.test(t.url) && !!assertHttpUrl(t.url.replace(/\{\w+\}/g, 'x'))
        } catch {
          return false
        }
      }) as SearchTemplate[]
    }
    if (patch.apiBase) {
      const base: FeedSettings['apiBase'] = {}
      for (const p of PROVIDERS) {
        const v = String(patch.apiBase[p] ?? '').trim()
        if (!v) continue
        try {
          assertHttpUrl(v)
          base[p] = v
        } catch {
          /* 丢掉非法端点 */
        }
      }
      next.apiBase = base
    }
    this.deps.appStore.set(SETTINGS_KEY, next)
    this.changed()
    return this.settings()
  }

  searchKeys(): Record<SearchApiProvider, boolean> {
    const out = {} as Record<SearchApiProvider, boolean>
    for (const p of PROVIDERS) out[p] = !!this.deps.appStore.loadSecret(secretId(p))
    return out
  }

  setSearchKey(provider: SearchApiProvider, key: string | null): Record<SearchApiProvider, boolean> {
    if (!PROVIDERS.includes(provider)) throw new Error('不支持的搜索服务')
    this.deps.appStore.saveSecret(secretId(provider), String(key ?? '').trim())
    return this.searchKeys()
  }

  // ---------------------------------------------------------------- 事件

  changed(sourceId?: string | null) {
    if (this.changedTimer) return
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      this.deps.event({ type: 'feeds-changed', sourceId: sourceId ?? null })
    }, 120)
  }

  // ---------------------------------------------------------------- 网络

  private fetch(url: string, opts: Parameters<typeof safeFetch>[1] = {}): Promise<SafeFetchResult> {
    return safeFetch(url, { fetchImpl: this.deps.fetchImpl, ...opts })
  }

  private async fetchFeed(url: string, cond?: { etag?: string | null; lastModified?: string | null }): Promise<{ res: SafeFetchResult; feed: ParsedFeed | null; text: string }> {
    const res = await this.fetch(url, { etag: cond?.etag, lastModified: cond?.lastModified, maxBytes: 8 * 1024 * 1024 })
    if (res.notModified) return { res, feed: null, text: '' }
    const text = decodeBody(res.bytes, res.contentType)
    return { res, feed: parseFeed(text, res.url), text }
  }

  // ---------------------------------------------------------------- 订阅源

  sources(): FeedSource[] {
    return this.db.sources()
  }

  /** 只发现、不添加：给设置页「检查地址」用 */
  async discover(rawUrl: string): Promise<{ ok: boolean; isFeed?: boolean; title?: string | null; candidates: FeedCandidate[]; error?: string }> {
    try {
      const url = assertHttpUrl(normalizeInputUrl(rawUrl)).toString()
      const res = await this.fetch(url, { maxBytes: 4 * 1024 * 1024 })
      const text = decodeBody(res.bytes, res.contentType)
      const kind = sniffFeed(text)
      if (kind && kind !== 'html') {
        const feed = parseFeed(text, res.url)
        return { ok: true, isFeed: true, title: feed.title, candidates: [{ url: res.url, title: feed.title, type: kind }] }
      }
      let candidates = discoverFeeds(text, res.url)
      if (!candidates.length) candidates = await this.probe(res.url)
      return { ok: candidates.length > 0, isFeed: false, title: pageTitle(text), candidates, error: candidates.length ? undefined : '这个网页没有声明订阅地址，常见路径也没找到' }
    } catch (err) {
      return { ok: false, candidates: [], error: errText(err) }
    }
  }

  /** 网页没写订阅：试几个常见路径（最多 6 个，单个 8 秒） */
  private async probe(pageUrl: string): Promise<FeedCandidate[]> {
    const out: FeedCandidate[] = []
    for (const u of guessFeedUrls(pageUrl).slice(0, 6)) {
      try {
        const res = await this.fetch(u, { timeoutMs: 8000, maxBytes: 4 * 1024 * 1024 })
        const text = decodeBody(res.bytes, res.contentType)
        const kind = sniffFeed(text)
        if (!kind || kind === 'html') continue
        const feed = parseFeed(text, res.url)
        if (!out.some(c => c.url === res.url)) out.push({ url: res.url, title: feed.title, type: kind })
        if (out.length >= 2) break
      } catch {
        /* 下一个 */
      }
    }
    return out
  }

  async addSource(input: AddSourceInput, depth = 0): Promise<AddSourceResult> {
    let url: string
    try {
      url = assertHttpUrl(normalizeInputUrl(input.url)).toString()
    } catch (err) {
      return { ok: false, error: errText(err) }
    }
    const dup = this.db.sourceByUrl(url)
    if (dup) return { ok: false, error: '已经订阅过这个地址', existing: this.db.source(dup.id) ?? undefined }
    let res: SafeFetchResult
    let text: string
    try {
      res = await this.fetch(url, { maxBytes: 8 * 1024 * 1024 })
      text = decodeBody(res.bytes, res.contentType)
    } catch (err) {
      return { ok: false, error: errText(err) }
    }
    const kind = sniffFeed(text)
    if (!kind || kind === 'html') {
      if (depth > 0) return { ok: false, error: '这个地址不是订阅' }
      let candidates = discoverFeeds(text, res.url)
      if (!candidates.length) candidates = await this.probe(res.url)
      if (!candidates.length) return { ok: false, error: kind === 'html' ? '这个网页没有声明订阅地址，常见路径也没找到；请直接填 RSS / Atom 地址' : '不认识的内容格式' }
      if (candidates.length > 1 && !input.autoPick) return { ok: false, candidates, error: '这个网页有多个订阅，选一个' }
      const r = await this.addSource({ ...input, url: candidates[0].url }, depth + 1)
      return { ...r, discovered: true }
    }
    let feed: ParsedFeed
    try {
      feed = parseFeed(text, res.url)
    } catch (err) {
      return { ok: false, error: errText(err) }
    }
    const finalDup = res.url !== url ? this.db.sourceByUrl(res.url) : null
    if (finalDup) return { ok: false, error: '已经订阅过这个地址', existing: this.db.source(finalDup.id) ?? undefined }
    const now = Date.now()
    const id = this.db.insertSource({
      kind: 'feed',
      title: input.title?.trim() || feed.title,
      url: res.url,
      siteUrl: feed.siteUrl,
      group: input.group ?? null,
      format: feed.format,
      intervalMin: input.intervalMin ?? null,
      fullText: !!input.fullText
    })
    const { added } = this.db.upsertItems(id, feed.items, now)
    const interval = input.intervalMin ?? this.settings().defaultIntervalMin
    this.db.updateSource(id, { etag: res.etag, lastModified: res.lastModified, lastFetchAt: now, lastOkAt: now, nextFetchAt: now + interval * MIN, failCount: 0, lastError: null })
    this.prune()
    this.changed(id)
    return { ok: true, source: this.db.source(id) ?? undefined, added: added.length }
  }

  updateSource(id: string, patch: { title?: string; group?: string | null; intervalMin?: number | null; fullText?: boolean; enabled?: boolean; topic?: Partial<FeedTopic> }): FeedSource | null {
    const cur = this.db.sourceRow(id)
    if (!cur) return null
    const p: Parameters<FeedStore['updateSource']>[1] = {}
    if (patch.title !== undefined && patch.title.trim()) p.title = patch.title.trim()
    if (patch.group !== undefined) p.group = patch.group
    if (patch.intervalMin !== undefined) {
      p.intervalMin = patch.intervalMin
      // 改频率后按新频率重新排期
      const base = cur.last_fetch_at ?? Date.now()
      p.nextFetchAt = base + (patch.intervalMin ?? this.settings().defaultIntervalMin) * MIN
    }
    if (patch.fullText !== undefined) p.fullText = patch.fullText
    if (patch.enabled !== undefined) p.enabled = patch.enabled
    if (patch.topic && cur.kind === 'search') {
      const t = this.db.source(id)?.topic
      if (t) {
        const next = normTopic({ ...t, ...patch.topic })
        p.topic = next
        if (patch.topic.query) p.title = next.query
        if (patch.topic.cadence && patch.topic.cadence !== t.cadence) p.nextFetchAt = (cur.last_ok_at ?? Date.now()) + (next.cadence === 'weekly' ? 7 * DAY : DAY) - 10 * MIN
      }
    }
    this.db.updateSource(id, p)
    this.changed(id)
    return this.db.source(id)
  }

  deleteSource(id: string) {
    this.db.deleteSource(id)
    this.changed(id)
  }

  renameGroup(from: string, to: string | null) {
    this.db.renameGroup(from, to)
    this.changed()
  }

  /** 更新一个订阅源（条件请求；失败按次数退避） */
  async refreshSource(id: string): Promise<{ ok: boolean; status: 'updated' | 'not-modified' | 'failed' | 'skipped'; added: number; error?: string }> {
    const s = this.db.sourceRow(id)
    if (!s || s.kind !== 'feed' || !s.url) return { ok: false, status: 'skipped', added: 0, error: '不是订阅源' }
    if (this.refreshing.has(id)) return { ok: false, status: 'skipped', added: 0, error: '正在更新' }
    this.refreshing.add(id)
    const now = Date.now()
    const interval = s.interval_min ?? this.settings().defaultIntervalMin
    try {
      const { res, feed } = await this.fetchFeed(s.url, { etag: s.etag, lastModified: s.last_modified })
      if (!feed) {
        this.db.updateSource(id, { lastFetchAt: now, lastOkAt: now, nextFetchAt: now + interval * MIN, failCount: 0, lastError: null })
        return { ok: true, status: 'not-modified', added: 0 }
      }
      const { added, updated } = this.db.upsertItems(id, feed.items, now)
      this.db.updateSource(id, {
        etag: res.etag ?? null,
        lastModified: res.lastModified ?? null,
        lastFetchAt: now,
        lastOkAt: now,
        nextFetchAt: now + interval * MIN,
        failCount: 0,
        lastError: null,
        format: feed.format,
        ...(s.site_url ? {} : { siteUrl: feed.siteUrl }),
        ...(!s.title || s.title === s.url ? { title: feed.title } : {})
      })
      if (added.length || updated) this.changed(id)
      return { ok: true, status: 'updated', added: added.length }
    } catch (err) {
      const failures = (s.fail_count ?? 0) + 1
      const error = errText(err)
      this.db.updateSource(id, { lastFetchAt: now, failCount: failures, lastError: error, nextFetchAt: now + backoffMinutes(interval, failures) * MIN })
      this.changed(id)
      return { ok: false, status: 'failed', added: 0, error }
    } finally {
      this.refreshing.delete(id)
    }
  }

  /** 更新到期的（或全部 / 指定的）订阅源：并发 4 */
  async refresh(opts: { ids?: string[] | null; force?: boolean } = {}): Promise<FeedRefreshResult> {
    const now = Date.now()
    const rows = this.db
      .sourceRows()
      .filter(r => r.kind === 'feed' && r.url && (opts.ids?.length ? opts.ids.includes(r.id) : r.enabled))
      .filter(r => opts.force || opts.ids?.length || !r.next_fetch_at || r.next_fetch_at <= now)
    const out: FeedRefreshResult = { ok: true, checked: rows.length, updated: 0, notModified: 0, added: 0, failed: 0 }
    let i = 0
    const errors: string[] = []
    const worker = async () => {
      while (i < rows.length) {
        const r = rows[i++]
        const res = await this.refreshSource(r.id)
        if (res.status === 'updated') out.updated++
        if (res.status === 'not-modified') out.notModified++
        if (res.status === 'failed') {
          out.failed++
          if (res.error) errors.push(`${r.title}：${res.error}`)
        }
        out.added += res.added
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker))
    if (rows.length) this.prune()
    if (errors.length && out.failed === rows.length) {
      out.ok = false
      out.error = errors.slice(0, 3).join('；')
    }
    this.changed()
    return out
  }

  prune(): number {
    const s = this.settings()
    return this.db.prune({ maxItems: s.maxItemsPerFeed, keepReadDays: s.keepReadDays })
  }

  // ---------------------------------------------------------------- 阅读

  items(q: FeedItemQuery) {
    return this.db.items(q)
  }

  item(id: string) {
    return this.db.item(id)
  }

  markRead(ids: string[], read: boolean) {
    this.db.setRead(ids, read)
    this.changed()
  }

  markAllRead(q: Pick<FeedItemQuery, 'scope'>, before?: number | null): number {
    const n = this.db.markAllRead(q, before ?? Date.now())
    this.changed()
    return n
  }

  star(id: string, starred: boolean) {
    this.db.setStarred(id, starred)
    this.changed()
  }

  /** 抓取原文并提取正文（消毒后存下）；只在用户点开 / 点「全文」时调用 */
  async fullText(id: string): Promise<{ ok: boolean; html?: string; error?: string }> {
    const it = this.db.item(id)
    if (!it) return { ok: false, error: '条目不存在' }
    if (it.fullHtml) return { ok: true, html: it.fullHtml }
    if (!it.url) return { ok: false, error: '这条没有原文链接' }
    try {
      const res = await this.fetch(it.url, { maxBytes: 4 * 1024 * 1024, timeoutMs: 20_000, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' })
      if (res.contentType && !/html|xml|text\/plain/i.test(res.contentType)) return { ok: false, error: `原文不是网页（${res.contentType.split(';')[0]}）` }
      const text = decodeBody(res.bytes, res.contentType)
      const art = extractArticle(text, res.url)
      if (art.length < 80) return { ok: false, error: '没能从原文里提取出正文（可能需要登录或由脚本渲染）' }
      this.db.setFull(id, art.html)
      this.changed(it.sourceId)
      return { ok: true, html: art.html }
    } catch (err) {
      return { ok: false, error: errText(err) }
    }
  }

  /** AI 摘要（用户主动点，不走后台闸门）；结果缓存在条目上 */
  async summarize(id: string, force = false): Promise<{ ok: boolean; text?: string; error?: string }> {
    const it = this.db.item(id)
    if (!it) return { ok: false, error: '条目不存在' }
    if (it.aiSummary && !force) return { ok: true, text: it.aiSummary }
    if (!aiReady(this.deps.getAISettings(), false)) return { ok: false, error: 'AI 未配置' }
    const body = htmlToText(it.fullHtml || it.contentHtml || '') || it.summary
    if (!body.trim()) return { ok: false, error: '这条没有正文可以摘要，先抓取全文' }
    try {
      const text = (
        await this.deps.ai.complete(
          [
            { role: 'system', content: FEED_ITEM_SUMMARY },
            { role: 'user', content: `标题：${it.title}\n来源：${it.sourceTitle}${it.author ? ` · ${it.author}` : ''}\n正文：\n${body.slice(0, 7000)}` }
          ],
          900
        )
      ).trim()
      if (!text) return { ok: false, error: 'AI 没有返回内容' }
      this.db.setAiSummary(id, text)
      this.changed(it.sourceId)
      return { ok: true, text }
    } catch (err) {
      return { ok: false, error: errText(err) }
    }
  }

  /** 加入阅读清单（insights kind='reading'，与 Newsletter 提取的同一处） */
  toReading(id: string): { ok: boolean; id?: string; created?: boolean; error?: string } {
    const it = this.db.item(id)
    if (!it) return { ok: false, error: '条目不存在' }
    const rid = `reading-feed-${id}`
    const exists = !!this.deps.store.getInsight(rid)
    if (!exists) {
      this.deps.store.insertInsight({
        id: rid,
        kind: 'reading',
        title: it.title,
        data: { url: it.url ?? null, summary: (it.aiSummary?.split('\n')[0] ?? it.summary ?? '').slice(0, 300) || null, from: it.sourceTitle, feedItemId: id }
      })
      this.deps.event({ type: 'insights-changed' })
    }
    return { ok: true, id: rid, created: !exists }
  }

  unreadTotal(): number {
    return this.db.unreadTotal()
  }

  // ---------------------------------------------------------------- OPML

  async importOpml(text: string): Promise<{ ok: boolean; added: number; skipped: number; failed: { url: string; error: string }[]; error?: string }> {
    let entries
    try {
      entries = parseOpml(text)
    } catch (err) {
      return { ok: false, added: 0, skipped: 0, failed: [], error: errText(err) }
    }
    let added = 0
    let skipped = 0
    const now = Date.now()
    const ids: string[] = []
    for (const e of entries) {
      if (this.db.sourceByUrl(e.xmlUrl)) {
        skipped++
        continue
      }
      // 先登记，稍后后台逐个抓取（导入几百个也不会卡住界面）
      ids.push(this.db.insertSource({ kind: 'feed', title: e.title, url: e.xmlUrl, siteUrl: e.htmlUrl, group: e.group }))
      added++
    }
    for (const id of ids) this.db.updateSource(id, { nextFetchAt: now })
    this.changed()
    const r = ids.length ? await this.refresh({ ids }) : null
    const failed = ids
      .map(id => this.db.sourceRow(id))
      .filter((s): s is NonNullable<typeof s> => !!s && !!s.last_error)
      .map(s => ({ url: s.url ?? '', error: s.last_error ?? '' }))
    return { ok: true, added, skipped, failed: r ? failed : [] }
  }

  exportOpml(): string {
    return buildOpml(
      this.db
        .sourceRows()
        .filter(r => r.kind === 'feed' && r.url)
        .map(r => ({ title: r.title, xmlUrl: r.url!, htmlUrl: r.site_url, group: r.group_name }))
    )
  }

  // ---------------------------------------------------------------- AI 搜索订阅

  addTopic(input: Partial<FeedTopic> & { query: string; group?: string | null }): FeedSource {
    const topic = normTopic(input, this.settings())
    if (!topic.query) throw new Error('主题不能为空')
    const id = this.db.insertSource({ kind: 'search', title: topic.query, topic, group: input.group ?? null })
    this.db.updateSource(id, { nextFetchAt: Date.now() })
    this.changed(id)
    return this.db.source(id)!
  }

  /** 跑一次搜索订阅：搜索 → 合并去重 → （AI）简报 → 写成条目 */
  async runTopic(id: string, opts: { ai: boolean }): Promise<FeedTopicRunResult> {
    const src = this.db.source(id)
    if (!src || src.kind !== 'search' || !src.topic) return { ok: false, found: 0, fresh: 0, error: '不是 AI 搜索订阅' }
    if (this.refreshing.has(id)) return { ok: false, found: 0, fresh: 0, error: '正在运行' }
    this.refreshing.add(id)
    const topic = src.topic
    const settings = this.settings()
    const now = Date.now()
    const status: NonNullable<FeedTopicRunResult['sources']> = []
    const lists: SearchResult[][] = []
    try {
      for (const sid of topic.sources) {
        try {
          if (sid.startsWith('api:')) {
            const p = sid.slice(4) as SearchApiProvider
            if (!PROVIDERS.includes(p)) continue
            const key = this.deps.appStore.loadSecret(secretId(p))
            if (!key) {
              status.push({ id: sid, ok: false, count: 0, error: `${SEARCH_API_LABEL[p]} 还没填 Key` })
              continue
            }
            const req = buildApiRequest(p, topic, key, settings.apiBase[p], Math.max(10, topic.maxResults))
            let res: SafeFetchResult
            try {
              res = await this.fetch(req.url, { method: req.method, headers: req.headers, body: req.body, accept: 'application/json', maxBytes: 3 * 1024 * 1024, allowPrivate: !!settings.apiBase[p] })
            } catch (err) {
              if (err instanceof FetchError && err.code === 'http') throw new Error(apiErrorText(err.status ?? 0, String((err as any).body ?? '')))
              throw err
            }
            const json = JSON.parse(decodeBody(res.bytes, res.contentType))
            const list = parseApiResponse(p, json, now)
            lists.push(list)
            status.push({ id: sid, ok: true, count: list.length })
          } else {
            const tpl = settings.templates.find(t => t.id === sid)
            if (!tpl || !tpl.enabled) continue
            const { feed } = await this.fetchFeed(fillSearchTemplate(tpl.url, topic))
            const list = feed ? resultsFromFeed(feed) : []
            lists.push(list)
            status.push({ id: sid, ok: true, count: list.length })
          }
        } catch (err) {
          status.push({ id: sid, ok: false, count: 0, error: errText(err) })
        }
      }
      const interval = topic.cadence === 'weekly' ? 7 * DAY : DAY
      if (!status.some(s => s.ok)) {
        const error = status.map(s => s.error).filter(Boolean).slice(0, 2).join('；') || '没有可用的搜索来源'
        const failures = (this.db.sourceRow(id)?.fail_count ?? 0) + 1
        this.db.updateSource(id, { lastFetchAt: now, failCount: failures, lastError: error, nextFetchAt: now + Math.min(interval, backoffMinutes(60, failures) * MIN) })
        this.changed(id)
        return { ok: false, found: 0, fresh: 0, error, sources: status }
      }
      const found = lists.reduce((s, l) => s + l.length, 0)
      const fresh = mergeSearchResults(lists, this.db.seen(id), topic.exclude, topic.maxResults)
      const partialError = status.filter(s => !s.ok).map(s => s.error).filter(Boolean).slice(0, 2).join('；') || null
      if (!fresh.length) {
        this.db.updateSource(id, { lastFetchAt: now, lastOkAt: now, failCount: 0, lastError: partialError, nextFetchAt: now + interval - 10 * MIN })
        this.changed(id)
        return { ok: true, found, fresh: 0, itemId: null, source: null, sources: status }
      }
      let ai: any = null
      if (opts.ai && aiReady(this.deps.getAISettings(), false)) {
        try {
          const text = await this.deps.ai.complete(
            [
              { role: 'system', content: FEED_TOPIC_BRIEF },
              { role: 'user', content: `订阅主题：${topic.query}${topic.exclude.length ? `（排除：${topic.exclude.join('、')}）` : ''}\n今天：${ymd(now)}\n\n本次新结果：\n${numberedResults(fresh)}` }
            ],
            1600
          )
          ai = jsonFromText(text)
        } catch (err) {
          // 用量闸门 / AI 出错：退回结果列表，不影响订阅本身
          if (!isBudgetError(err)) console.error('[feeds] topic brief ai failed:', errText(err))
        }
      }
      const b = buildTopicBrief(topic.query, fresh, ai, now)
      const itemId = this.db.insertBrief(id, { title: b.title, html: b.html, summary: b.summary, results: fresh, source: b.source }, now)
      this.db.addSeen(id, fresh, now)
      this.db.updateSource(id, { lastFetchAt: now, lastOkAt: now, failCount: 0, lastError: partialError, nextFetchAt: now + interval - 10 * MIN })
      this.prune()
      this.changed(id)
      return { ok: true, found, fresh: fresh.length, itemId, source: b.source, sources: status }
    } finally {
      this.refreshing.delete(id)
    }
  }

  /** 跑到期的搜索订阅 */
  async runDueTopics(opts: { ai: boolean; force?: boolean }): Promise<{ ran: number; briefs: { id: string; title: string; fresh: number }[]; errors: string[] }> {
    const now = Date.now()
    const due = this.db.sourceRows().filter(r => r.kind === 'search' && r.enabled && (opts.force || !r.next_fetch_at || r.next_fetch_at <= now))
    const briefs: { id: string; title: string; fresh: number }[] = []
    const errors: string[] = []
    for (const r of due) {
      const res = await this.runTopic(r.id, { ai: opts.ai })
      if (res.itemId) briefs.push({ id: res.itemId, title: r.title, fresh: res.fresh })
      if (!res.ok && res.error) errors.push(`${r.title}：${res.error}`)
    }
    return { ran: due.length, briefs, errors }
  }

  // ---------------------------------------------------------------- 今日订阅精华

  digest(day?: string | null): FeedDigest | null {
    return day ? this.db.digest(day) : this.db.digest(ymd(Date.now())) ?? this.db.latestDigest()
  }

  async generateDigest(opts: { ai: boolean }): Promise<{ ok: boolean; digest?: FeedDigest; error?: string }> {
    const now = Date.now()
    const items = this.db.since(now - DAY, 60)
    if (!items.length) return { ok: false, error: '最近 24 小时订阅没有新文章' }
    const entries = items.map(i => ({ id: i.id, title: i.title, url: i.url, source: i.sourceTitle || '订阅', summary: (i.aiSummary || i.summary || '').slice(0, 200) }))
    let ai: any = null
    if (opts.ai && aiReady(this.deps.getAISettings(), false)) {
      try {
        const list = entries.map((e, k) => `[${k + 1}] 来源：${e.source}\n标题：${e.title}${e.summary ? `\n摘要：${e.summary}` : ''}`).join('\n\n')
        ai = jsonFromText(await this.deps.ai.complete([{ role: 'system', content: FEED_DIGEST }, { role: 'user', content: `今天：${ymd(now)}\n\n${list}` }], 1600))
      } catch (err) {
        if (!isBudgetError(err)) console.error('[feeds] digest ai failed:', errText(err))
      }
    }
    const b = buildDigest(entries, ai, now)
    const digest: FeedDigest = { day: ymd(now), headline: b.headline, html: b.html, source: b.source, count: entries.length, createdAt: now }
    this.db.saveDigest(
      digest,
      entries.map(e => e.id)
    )
    this.changed()
    return { ok: true, digest }
  }
}

export function normTopic(input: Partial<FeedTopic> & { query?: string }, settings?: FeedSettings): FeedTopic {
  const exclude = (Array.isArray(input.exclude) ? input.exclude : String(input.exclude ?? '').split(/[,，、\s]+/))
    .map(s => String(s).trim())
    .filter(Boolean)
    .slice(0, 20)
  const defaults = (settings?.templates ?? DEFAULT_SEARCH_TEMPLATES).filter(t => t.enabled).map(t => t.id)
  const sources = (Array.isArray(input.sources) && input.sources.length ? input.sources : defaults).map(String).slice(0, 8)
  return {
    query: String(input.query ?? '').trim().slice(0, 120),
    cadence: input.cadence === 'weekly' ? 'weekly' : 'daily',
    locale: String(input.locale || 'zh-CN'),
    exclude,
    sources: sources.length ? sources : ['google-news'],
    maxResults: Math.max(3, Math.min(40, Math.round(Number(input.maxResults) || 15)))
  }
}
