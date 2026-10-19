import { findAll, findFirst, parseHtml, sanitizeNode, textOf, type HNode, type HText } from './html'

/**
 * 简易正文提取（readability 思路的精简版，纯函数）：
 *  1. 去掉脚本 / 样式 / 导航 / 页眉页脚 / 侧栏 / 评论 / 分享 / 广告等噪声块（看标签与 class / id）
 *  2. 给每个段落打分（长度、逗号句读数），分数累加到父节点（全部）与祖父节点（一半）
 *  3. 候选节点按 class / id 加减分，再乘 (1 - 链接密度)，取最高者；<article> 足够长时直接用
 *  4. 输出白名单消毒后的 HTML 与纯文本
 */

export interface ExtractedArticle {
  title: string | null
  byline: string | null
  /** 已消毒 */
  html: string
  text: string
  length: number
}

const POSITIVE = /article|body|content|entry|hentry|h-entry|main|page|post|text|blog|story|正文|内容/i
const NEGATIVE = /hidden|^hid$|\bhid\b|banner|combx|comment|com-|contact|foot|footer|footnote|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget|ad-|ads|advert|breadcrumb|menu|nav|subscribe|newsletter|popup|modal|cookie|login|signup|recommend|评论|分享|相关|推荐|广告/i
const NOISE_TAGS = new Set(['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'iframe', 'svg', 'button', 'select', 'input', 'textarea', 'template', 'menu', 'dialog'])
const PARA_TAGS = new Set(['p', 'pre', 'td', 'blockquote', 'li', 'h2', 'h3'])

function classId(n: HNode): string {
  return `${n.attrs.class ?? ''} ${n.attrs.id ?? ''} ${n.attrs.role ?? ''}`
}

function classWeight(n: HNode): number {
  const s = classId(n)
  let w = 0
  if (NEGATIVE.test(s)) w -= 25
  if (POSITIVE.test(s)) w += 25
  return w
}

function removeNoise(root: HNode) {
  const rec = (n: HNode) => {
    n.children = n.children.filter(c => {
      if (c.type === 'text') return true
      if (NOISE_TAGS.has(c.name)) return false
      if (c.attrs.hidden !== undefined || /display\s*:\s*none/i.test(c.attrs.style ?? '') || c.attrs['aria-hidden'] === 'true') return false
      const ci = classId(c)
      // 噪声 class 且不像正文容器、文字也不多 → 去掉
      if (c.name !== 'body' && c.name !== 'article' && c.name !== 'main' && NEGATIVE.test(ci) && !POSITIVE.test(ci)) return false
      return true
    })
    for (const c of n.children) if (c.type === 'el') rec(c)
  }
  rec(root)
}

function linkDensity(n: HNode): number {
  const total = textOf(n).length
  if (!total) return 0
  let links = 0
  for (const a of findAll(n, x => x.name === 'a')) links += textOf(a).length
  return Math.min(1, links / total)
}

function punctuation(t: string): number {
  return (t.match(/[,，、。；;！？!?]/g) ?? []).length
}

function initScore(n: HNode): number {
  let s = 0
  switch (n.name) {
    case 'article':
      s = 10
      break
    case 'main':
    case 'div':
    case 'section':
      s = 5
      break
    case 'pre':
    case 'td':
    case 'blockquote':
      s = 3
      break
    case 'ol':
    case 'ul':
    case 'dl':
    case 'dd':
    case 'dt':
    case 'li':
    case 'form':
      s = -3
      break
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'th':
      s = -5
      break
  }
  return s + classWeight(n)
}

function metaContent(doc: HNode, ...keys: string[]): string | null {
  for (const k of keys) {
    const m = findFirst(doc, n => n.name === 'meta' && (n.attrs.property === k || n.attrs.name === k) && !!n.attrs.content)
    if (m) return m.attrs.content.trim()
  }
  return null
}

function titleText(doc: HNode): string | null {
  const og = metaContent(doc, 'og:title', 'twitter:title')
  if (og) return og
  const t = findFirst(doc, n => n.name === 'title')
  const raw = t ? t.children.map((c: HNode | HText) => (c.type === 'text' ? c.text : '')).join('').trim() : ''
  if (raw) return raw.replace(/\s+[-–—|｜_]\s+[^-–—|｜_]{1,30}$/u, '').trim() || raw
  const h1 = findFirst(doc, n => n.name === 'h1')
  return h1 ? textOf(h1) || null : null
}

export function extractArticle(html: string, url: string | null): ExtractedArticle {
  const doc = parseHtml(html)
  const title = titleText(doc)
  const byline = metaContent(doc, 'author', 'article:author', 'byl')
  const body = findFirst(doc, n => n.name === 'body') ?? doc
  removeNoise(body)

  const scores = new Map<HNode, number>()
  const bump = (n: HNode | null, v: number) => {
    if (!n || n.name === '#root') return
    if (!scores.has(n)) scores.set(n, initScore(n))
    scores.set(n, scores.get(n)! + v)
  }
  for (const p of findAll(body, n => PARA_TAGS.has(n.name))) {
    const t = textOf(p)
    if (t.length < 25) continue
    const score = 1 + punctuation(t) + Math.min(3, Math.floor(t.length / 100))
    bump(p.parent, score)
    bump(p.parent?.parent ?? null, score / 2)
  }

  let best: HNode | null = null
  let bestScore = -Infinity
  for (const [n, s] of scores) {
    const final = s * (1 - linkDensity(n))
    if (final > bestScore) {
      bestScore = final
      best = n
    }
  }
  // 明确的 <article> / [itemprop=articleBody] 足够长时优先
  const explicit = findFirst(body, n => n.attrs.itemprop === 'articleBody') ?? findFirst(body, n => n.name === 'article' && textOf(n).length > 400)
  if (explicit && (!best || textOf(explicit).length >= textOf(best).length * 0.6)) best = explicit
  // 最佳节点只有零星文字：把同父节点下得分不错的兄弟节点一起带上
  let pick: HNode = best ?? body
  if (best && best.parent && textOf(best).length < 600) {
    const threshold = Math.max(10, (scores.get(best) ?? 0) * 0.2)
    const sibs = best.parent.children.filter((c): c is HNode => c.type === 'el' && (c === best || (scores.get(c) ?? 0) >= threshold || (c.name === 'p' && textOf(c).length > 80)))
    if (sibs.length > 1) pick = { type: 'el', name: 'div', attrs: {}, children: sibs, parent: null }
  }
  if (textOf(pick).length < 140) pick = body
  // 正文里重复的标题去掉
  const wrapper: HNode = { type: 'el', name: '#root', attrs: {}, children: [pick], parent: null }
  let out = sanitizeNode(wrapper, { base: url, dropTinyImages: true })
  if (title) {
    const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`^(<div>)*\\s*<h1>\\s*${esc}\\s*</h1>`), '$1')
  }
  out = out.replace(/(<p>\s*<\/p>)+/g, '').replace(/(<div>\s*<\/div>)+/g, '').trim()
  const text = textOf(pick)
  return { title, byline, html: out, text, length: text.length }
}
