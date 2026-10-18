import type { JobDef } from '../jobs/scheduler'
import { HOUR_MS } from '../jobs/schedule'
import { followupService } from './index'

/** 自动任务「跟进检查」：每小时找回复、把到期未回的标为逾期并提醒、起草下一封催促草稿（不发送） */
export function followupJob(): JobDef {
  return {
    id: 'followup-check',
    name: '跟进检查',
    description: '发出后在等对方的邮件：对方回了自动结束；到期没回提醒你，并起草下一封更明确的催促草稿（只起草，不发送）',
    category: 'collect',
    ai: 'optional',
    cadence: { kind: 'every', ms: HOUR_MS },
    defaultEnabled: true,
    run: async ctx => {
      const svc = followupService()
      if (!svc) return { summary: '跟进模块尚未就绪' }
      const r = await svc.check(ctx.now, { aiAllowed: ctx.aiAllowed })
      const parts: string[] = []
      if (r.replied.length) parts.push(`${r.replied.length} 条对方已回复`)
      if (r.overdue.length) parts.push(`${r.overdue.length} 条到期未回`)
      if (r.nudged.length) parts.push(`起草 ${r.nudged.length} 封催促`)
      // 逐条的活动记录由服务写（回复 / 逾期 / 起草各一条），这里只给任务列表一句话结果
      return { summary: parts.length ? parts.join('，') : r.checked ? `检查 ${r.checked} 条跟进，没有变化` : '没有进行中的跟进' }
    }
  }
}
