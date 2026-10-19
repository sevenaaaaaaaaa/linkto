/* eslint-disable @typescript-eslint/no-explicit-any */
import { SEARCH_LOCALES, type FeedItem } from '@shared/feeds'
import { ymd } from '../agent/protocol'
import type { AgentTool } from '../agent/tools'
import { htmlToText } from './html'
import { feedService } from './index'

/**
 * Agent 工具：feed_list / feed_search（只读）、feed_subscribe / ai_search_subscribe（写，需确认）。
 * 由 agent/tools.ts 的注册表展开；ToolError 由调用方注入（避免循环依赖）。
 */

const DAY = 864e5
const fmt = (t: number | null | undefined) => (t ? `${ymd(new Date(t))} ${String(new Date(t).getHours()).padStart(2, '0')}:${String(new Date(t).getMinutes()).padStart(2, '0')}` : null)

function brief(i: FeedItem) {
  return {
    id: i.id,
    title: i.title,
    source: i.sourceTitle,
    type: i.kind === 'brief' ? 'AI 搜索简报' : '文章',
    ...(i.url ? { url: i.url } : {}),
    ...(i.author ? { author: i.author } : {}),
    published: fmt(i.publishedAt ?? i.sortAt),
    read: i.read,
    ...(i.starred ? { starred: true } : {}),
    summary: (i.aiSummary || i.summary || '').slice(0, 280)
  }
}

export function feedAgentTools(deps: { fail(message: string): Error }): AgentTool[] {
  const svc = () => {
    const s = feedService()
    if (!s) throw deps.fail('订阅模块尚未就绪')
    return s
  }
  const findSource = (ref: unknown) => {
    const q = String(ref ?? '').trim().toLowerCase()
    if (!q) return null
    const all = svc().sources()
    return all.find(s => s.id === ref) ?? all.find(s => s.title.toLowerCase() === q) ?? all.find(s => s.title.toLowerCase().includes(q) || (s.url ?? '').toLowerCase().includes(q)) ?? null
  }

  return [
    {
      name: 'feed_list',
      title: '查订阅源',
      domain: 'kb',
      risk: 'read',
      description: '列出用户的 RSS / Atom / JSON Feed 订阅源与 AI 搜索订阅（主题）：名称、分组、未读数、更新频率、上次更新与错误。',
      params: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['all', 'feed', 'search'], default: 'all', description: 'feed = 订阅源；search = AI 搜索订阅' },
          group: { type: 'string', description: '只看某个分组' }
        }
      },
      run(a) {
        const s = svc()
        const def = s.settings().defaultIntervalMin
        const list = s.sources().filter(x => (!a.kind || a.kind === 'all' || x.kind === a.kind) && (!a.group || (x.group ?? '') === a.group))
        return {
          data: {
            total: list.length,
            unread: list.reduce((n, x) => n + x.unread, 0),
            sources: list.map(x => ({
              id: x.id,
              type: x.kind === 'search' ? 'AI 搜索订阅' : '订阅源',
              title: x.title,
              ...(x.url ? { url: x.url } : {}),
              ...(x.group ? { group: x.group } : {}),
              unread: x.unread,
              total: x.total,
              ...(x.kind === 'feed' ? { every_min: x.intervalMin ?? def, full_text: x.fullText } : {}),
              ...(x.topic ? { query: x.topic.query, cadence: x.topic.cadence === 'weekly' ? '每周' : '每天', exclude: x.topic.exclude } : {}),
              last_ok: fmt(x.lastOkAt),
              ...(x.lastError ? { error: x.lastError } : {}),
              ...(x.enabled ? {} : { paused: true })
            }))
          },
          summary: list.length ? `${list.length} 个订阅，${list.reduce((n, x) => n + x.unread, 0)} 篇未读` : '还没有订阅'
        }
      }
    },
    {
      name: 'feed_search',
      title: '搜订阅内容',
      domain: 'kb',
      risk: 'read',
      description:
        '在订阅条目（RSS 文章与 AI 搜索订阅的简报）里搜索：标题 / 摘要 / 正文 / AI 摘要。可按订阅源、最近 N 天、只看未读或收藏筛选；不填关键词 = 最近的条目。返回标题、来源、原文链接、发布时间、摘要；include_content=true 时附正文（截断）。',
      params: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词（空格分隔，全部命中）' },
          source: { type: 'string', description: '订阅源 id 或名称' },
          days: { type: 'integer', minimum: 1, maximum: 365, description: '只看最近 N 天' },
          unread_only: { type: 'boolean' },
          starred_only: { type: 'boolean' },
          include_content: { type: 'boolean', description: '附带正文（每条最多 1500 字）' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 }
        }
      },
      run(a) {
        const s = svc()
        let sourceId: string | null = null
        if (a.source) {
          const src = findSource(a.source)
          if (!src) throw deps.fail(`找不到订阅源「${a.source}」；先用 feed_list 查看`)
          sourceId = src.id
        }
        const since = a.days ? Date.now() - Number(a.days) * DAY : null
        let list = s.db.search(String(a.query ?? ''), { sourceId, since, limit: 100 })
        if (a.unread_only) list = list.filter(i => !i.read)
        if (a.starred_only) list = list.filter(i => i.starred)
        const items = list.slice(0, Math.max(1, Math.min(50, a.limit ?? 15)))
        return {
          data: {
            total: list.length,
            items: items.map(i => {
              const b: Record<string, unknown> = brief(i)
              if (a.include_content || i.kind === 'brief') {
                const d = s.item(i.id)
                if (d) {
                  if (a.include_content) b.content = htmlToText(d.fullHtml || d.contentHtml).slice(0, 1500)
                  if (d.results?.length) b.results = d.results.slice(0, 15).map(r => ({ title: r.title, url: r.url, source: r.source ?? null }))
                }
              }
              return b
            })
          },
          summary: list.length ? `找到 ${list.length} 条订阅内容` : '订阅里没有找到'
        }
      }
    },
    {
      name: 'feed_subscribe',
      title: '添加订阅源',
      domain: 'kb',
      risk: 'write',
      description: '订阅一个 RSS / Atom / JSON Feed 地址；给网页地址时自动发现页面声明的订阅（多个时取第一个）。可设分组、更新频率（分钟）、是否点开时自动抓取全文。',
      params: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '订阅地址或网站地址（http / https）' },
          group: { type: 'string', description: '分组 / 文件夹' },
          every_min: { type: 'integer', minimum: 15, maximum: 1440, description: '更新频率（分钟），不填用默认' },
          full_text: { type: 'boolean', description: '只有摘要的条目点开时自动抓全文' }
        },
        required: ['url']
      },
      preview: a => [`订阅：${a.url}`, [a.group ? `分组「${a.group}」` : '', a.every_min ? `每 ${a.every_min} 分钟` : '', a.full_text ? '抓全文' : ''].filter(Boolean).join(' · ') || '默认设置'],
      async run(a) {
        const r = await svc().addSource({ url: String(a.url ?? ''), group: a.group ?? null, intervalMin: a.every_min ?? null, fullText: !!a.full_text, autoPick: true })
        if (!r.ok) {
          if (r.existing) return { data: { ok: false, already: true, id: r.existing.id, title: r.existing.title }, summary: `已经订阅过「${r.existing.title}」` }
          throw deps.fail(r.error || '订阅失败')
        }
        const src = r.source!
        return { data: { ok: true, id: src.id, title: src.title, url: src.url, discovered: !!r.discovered, items: src.total }, summary: `已订阅「${src.title}」（${src.total} 篇）` }
      }
    },
    {
      name: 'ai_search_subscribe',
      title: '添加 AI 搜索订阅',
      domain: 'kb',
      risk: 'write',
      description:
        '订阅一个主题（如「新能源车 行业动态」「某公司 新闻」「某技术 新论文」）：每天 / 每周用新闻搜索找新结果，去重后生成简报（要点 + 为什么重要 + 逐条来源链接）放进订阅。只把主题词发给搜索服务。run_now=true 时立即跑一次。',
      params: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '主题 / 搜索词' },
          cadence: { type: 'string', enum: ['daily', 'weekly'], default: 'daily' },
          locale: { type: 'string', enum: SEARCH_LOCALES.map(l => l.id), default: 'zh-CN', description: '语言 / 地区' },
          exclude: { type: 'array', items: { type: 'string' }, description: '排除词' },
          run_now: { type: 'boolean', description: '添加后立即运行一次' }
        },
        required: ['query']
      },
      preview: a => [`主题：${a.query}`, `${a.cadence === 'weekly' ? '每周' : '每天'} · ${a.locale ?? 'zh-CN'}${a.exclude?.length ? ` · 排除 ${a.exclude.join('、')}` : ''}`],
      async run(a) {
        const s = svc()
        const q = String(a.query ?? '').trim()
        if (!q) throw deps.fail('主题不能为空')
        const dup = s.sources().find(x => x.kind === 'search' && x.topic?.query === q)
        if (dup) return { data: { ok: false, already: true, id: dup.id }, summary: `已经订阅过主题「${q}」` }
        const src = s.addTopic({ query: q, cadence: a.cadence === 'weekly' ? 'weekly' : 'daily', locale: a.locale || 'zh-CN', exclude: Array.isArray(a.exclude) ? a.exclude : [] })
        if (!a.run_now) return { data: { ok: true, id: src.id, query: q }, summary: `已订阅主题「${q}」` }
        const r = await s.runTopic(src.id, { ai: true })
        return {
          data: { ok: true, id: src.id, query: q, run: { ok: r.ok, fresh: r.fresh, brief_id: r.itemId ?? null, error: r.error ?? null } },
          summary: r.ok ? `已订阅主题「${q}」，首轮 ${r.fresh} 条新结果` : `已订阅主题「${q}」，首轮运行失败：${r.error}`
        }
      }
    }
  ]
}
