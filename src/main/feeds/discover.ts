import type { FeedCandidate } from '@shared/feeds'
import { absUrl, findAll, findFirst, parseHtml, textOf } from './html'

/**
 * 从网页里发现订阅地址（纯函数）：
 *  1. <link rel="alternate" type="application/rss+xml | atom+xml | feed+json | rdf+xml">（标准做法）
 *  2. 退而求其次：页面里指向 rss / atom / feed 的同站链接
 * 网页本身没写时，服务层再试几个常见路径（/feed、/rss.xml、/atom.xml、/index.xml …）。
 */

const FEED_TYPES = /application\/(rss|atom|rdf|feed)\+(xml|json)|application\/(x-)?rss|text\/xml|application\/json/i

export function discoverFeeds(html: string, pageUrl: string): FeedCandidate[] {
  const doc = parseHtml(html)
  const baseTag = findFirst(doc, n => n.name === 'base' && !!n.attrs.href)
  const base = absUrl(baseTag?.attrs.href, pageUrl) ?? pageUrl
  const out: FeedCandidate[] = []
  const seen = new Set<string>()
  const add = (href: string | undefined, title: string | null, type: string | null) => {
    const url = absUrl(href, base)
    if (!url || seen.has(url)) return
    seen.add(url)
    out.push({ url, title: title?.trim() || null, type })
  }
  for (const l of findAll(doc, n => n.name === 'link')) {
    const rel = (l.attrs.rel ?? '').toLowerCase().split(/\s+/)
    const type = (l.attrs.type ?? '').toLowerCase()
    if (!rel.includes('alternate') && !rel.includes('feed')) continue
    if (type && !FEED_TYPES.test(type)) continue
    if (!type && !rel.includes('feed')) continue
    // 评论订阅排在后面
    add(l.attrs.href, l.attrs.title ?? null, type || null)
  }
  out.sort((a, b) => Number(/comment|评论/i.test(a.title ?? a.url)) - Number(/comment|评论/i.test(b.title ?? b.url)))
  if (out.length) return out
  // 页面链接里找
  let host = ''
  try {
    host = new URL(base).hostname.replace(/^www\./, '')
  } catch {
    /* ignore */
  }
  for (const a of findAll(doc, n => n.name === 'a' && !!n.attrs.href)) {
    const href = a.attrs.href
    if (!/(^|[/._-])(rss|atom|feed)s?([/._?-]|$)|\.rss$|\.xml$|feed\.json$/i.test(href)) continue
    const url = absUrl(href, base)
    if (!url) continue
    try {
      if (new URL(url).hostname.replace(/^www\./, '') !== host) continue
    } catch {
      continue
    }
    add(url, textOf(a).slice(0, 80) || null, null)
    if (out.length >= 5) break
  }
  return out
}

/** 网页本身没声明订阅时试探的常见路径 */
export function guessFeedUrls(pageUrl: string): string[] {
  try {
    const u = new URL(pageUrl)
    const root = `${u.protocol}//${u.host}`
    const paths = ['/feed', '/rss.xml', '/atom.xml', '/index.xml', '/feed.xml', '/rss']
    const list = paths.map(p => root + p)
    // 子目录博客：/blog/ → /blog/feed
    const dir = u.pathname.replace(/[^/]*$/, '')
    if (dir && dir !== '/') list.unshift(`${root}${dir}feed`, `${root}${dir}index.xml`)
    return [...new Set(list)].slice(0, 8)
  } catch {
    return []
  }
}

/** 网页标题（发现失败时给用户看） */
export function pageTitle(html: string): string | null {
  const doc = parseHtml(html)
  const t = findFirst(doc, n => n.name === 'title')
  const text = t ? t.children.map(c => (c.type === 'text' ? c.text : '')).join('').replace(/\s+/g, ' ').trim() : ''
  return text.slice(0, 120) || null
}
