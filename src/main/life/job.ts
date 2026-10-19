import type { JobDef } from '../jobs/scheduler'
import { lifeService } from './index'

/** 自动任务「生活档案整理」：每天补扫最近 3 天的到期 / 续期类邮件、补关联财务，汇总 30 天内要办的事 */
export function lifeJob(): JobDef {
  return {
    id: 'life',
    name: '生活档案整理',
    description: '补扫最近 3 天的证件 / 保险 / 年检 / 域名 / 会员 / 保修等到期与续期邮件，续期成功的滚到下一期，汇总 30 天内要办的事',
    category: 'collect',
    ai: 'optional',
    cadence: { kind: 'daily', at: '08:15' },
    defaultEnabled: true,
    preferIdle: { minIdleSec: 60, maxDelayMs: 90 * 60_000 },
    run: async () => {
      const svc = lifeService()
      if (!svc) return { summary: '生活档案模块尚未就绪' }
      const r = await svc.organize(3)
      if (!r.ok) {
        if (r.error === '正在扫描') return { summary: '你正在手动扫描，本轮跳过' }
        throw new Error(r.error || '生活档案扫描失败')
      }
      const n = r.created.length
      const parts = [n ? `新增 ${n} 件` : '没有新事务']
      if (r.merged) parts.push(`归并 ${r.merged} 封`)
      if (r.upcoming.length) parts.push(`30 天内到期 ${r.upcoming.length} 件`)
      if (r.overdue.length) parts.push(`${r.overdue.length} 件已过期`)
      const label = (id: string) => svc.get(id)?.title ?? id
      return {
        summary: `扫描 ${r.scanned} 封：${parts.join('，')}`,
        activity:
          n || r.overdue.length
            ? {
                source: 'job',
                title: `生活档案：${n ? `新增 ${n} 件` : ''}${n && r.overdue.length ? '，' : ''}${r.overdue.length ? `${r.overdue.length} 件已过期` : ''}`,
                detail: parts.join('，'),
                refs: [...r.created.map(id => ({ type: 'life' as const, id, label: label(id) })), ...r.overdue.map(x => ({ type: 'life' as const, id: x.id, label: `已过期 · ${x.title}` }))].slice(0, 10),
                stats: { life: n }
              }
            : null
      }
    }
  }
}
