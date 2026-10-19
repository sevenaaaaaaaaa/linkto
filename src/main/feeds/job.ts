import type { JobDef } from '../jobs/scheduler'
import { HOUR_MS } from '../jobs/schedule'
import { feedService } from './index'

/**
 * 订阅的自动任务：
 *  - 订阅源更新（每 15 分钟检查一次，各源按自己的频率到期才抓；不用 AI）
 *  - AI 搜索订阅（每小时检查到期的主题；AI 可选，走后台用量闸门，不可用时输出结果列表）
 *  - 今日订阅精华（每天 08:40；与 设置 → 订阅「今日订阅精华」同一开关）
 */
export function feedJobs(): JobDef[] {
  return [
    {
      id: 'feeds',
      name: '订阅源更新',
      description: '按各订阅源的频率抓取 RSS / Atom / JSON Feed（条件请求，没更新不重复下载），清理超出保留策略的旧条目',
      category: 'collect',
      ai: 'none',
      cadence: { kind: 'every', ms: Number(process.env.LINKTO_FEEDS_EVERY_MS) || 15 * 60_000 },
      defaultEnabled: true,
      needsNetwork: true,
      run: async () => {
        const svc = feedService()
        if (!svc) return { summary: '订阅模块尚未就绪' }
        const r = await svc.refresh()
        if (!r.checked) return { summary: '没有到期的订阅源' }
        if (!r.ok) throw new Error(r.error || '订阅源更新失败')
        const parts = [`检查 ${r.checked} 个源`]
        if (r.added) parts.push(`新增 ${r.added} 篇`)
        if (r.notModified) parts.push(`${r.notModified} 个没有更新`)
        if (r.failed) parts.push(`${r.failed} 个失败`)
        return { summary: parts.join('，') }
      }
    },
    {
      id: 'feed-topics',
      name: 'AI 搜索订阅',
      description: '按每天 / 每周的频率搜索你订阅的主题，和历史结果去重后生成简报（AI 不可用时输出结果列表；链接只来自搜索结果）',
      category: 'collect',
      ai: 'optional',
      cadence: { kind: 'every', ms: HOUR_MS },
      defaultEnabled: true,
      needsNetwork: true,
      run: async ctx => {
        const svc = feedService()
        if (!svc) return { summary: '订阅模块尚未就绪' }
        const r = await svc.runDueTopics({ ai: ctx.aiAllowed })
        if (!r.ran) return { summary: '没有到期的搜索订阅' }
        if (!r.briefs.length && r.errors.length === r.ran) throw new Error(r.errors.slice(0, 2).join('；'))
        const n = r.briefs.length
        return {
          summary: n ? `${n} 个主题有新结果：${r.briefs.map(b => `${b.title}（${b.fresh} 条）`).join('、')}` : `运行 ${r.ran} 个主题，没有新结果`,
          activity: n
            ? { source: 'job', title: `AI 搜索订阅：${n} 份新简报`, detail: r.briefs.map(b => `${b.title} · ${b.fresh} 条新结果`).join('\n'), refs: [], stats: { feedBriefs: n } }
            : null
        }
      }
    },
    {
      id: 'feed-digest',
      name: '今日订阅精华',
      description: '每天把订阅源最近 24 小时的新文章归纳成几个主题（AI 不可用时按来源列出），可并入今日简报',
      category: 'learn',
      ai: 'optional',
      cadence: { kind: 'daily', at: '08:40' },
      defaultEnabled: false,
      preferIdle: { minIdleSec: 30, maxDelayMs: 60 * 60_000 },
      getEnabled: () => !!feedService()?.settings().digest,
      setEnabled: v => void feedService()?.setSettings({ digest: v }),
      run: async ctx => {
        const svc = feedService()
        if (!svc) return { summary: '订阅模块尚未就绪' }
        const r = await svc.generateDigest({ ai: ctx.aiAllowed })
        if (!r.ok) return { summary: r.error || '没有生成' }
        return {
          summary: `${r.digest!.source === 'ai' ? 'AI 精华' : '按来源列表'}：${r.digest!.headline}`,
          activity: { source: 'job', title: '今日订阅精华已生成', detail: r.digest!.headline, refs: [], stats: { feedDigest: 1 } }
        }
      }
    }
  ]
}
