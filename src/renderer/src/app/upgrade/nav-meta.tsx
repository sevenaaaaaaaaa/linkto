import {
  IconInbox, IconCheckSquare, IconReplyAll, IconLayers, IconSparkles, IconRobot, IconRss, IconBook, IconAttach, IconClock, IconFlag, IconPin
} from '../../components/icons'
import { IconWallet } from '../finance/FinanceNav'
import { IconLife } from '../life/icons'
import { IconTrace } from '../trace/icons'
import type { NavId } from '../../lib/sidebar-layout'

/** 侧栏入口的图标与一句话说明（侧栏 / 编辑侧栏 / 升级向导共用） */
export function navIcon(id: NavId, size = 15): React.ReactNode {
  const p = { width: size, height: size }
  switch (id) {
    case 'inbox':
      return <IconInbox {...p} />
    case 'todo':
      return <IconCheckSquare {...p} />
    case 'followup':
      return <IconReplyAll {...p} />
    case 'projects':
      return <IconLayers {...p} />
    case 'brief':
      return <IconSparkles {...p} />
    case 'agent':
      return <IconRobot {...p} />
    case 'finance':
      return <IconWallet {...p} />
    case 'feeds':
      return <IconRss {...p} />
    case 'life':
      return <IconLife {...p} />
    case 'trace':
      return <IconTrace {...p} />
    case 'kb':
      return <IconBook {...p} />
    case 'attachments':
      return <IconAttach {...p} />
    case 'snoozed':
      return <IconClock {...p} />
    case 'flagged':
      return <IconFlag {...p} />
    case 'pinned':
      return <IconPin {...p} />
  }
}

export const NAV_HINT: Record<NavId, string> = {
  inbox: '所有账户的收件箱（AI 分区）',
  todo: '从邮件里收集的待办，今天到期的计数',
  followup: '我发出去还没等到回复的',
  projects: '同一件事的往来与时间线',
  brief: '今天的重点、商情与阅读清单',
  agent: '对话 · 技能 · 自动任务 · 记忆',
  finance: '账单、订阅、订单与对账',
  feeds: 'RSS 与 AI 搜索订阅',
  life: '证件、保险、年检、域名等到期事务',
  trace: '口头约定与书面确认',
  kb: '沉淀下来的决定、方案与资料',
  attachments: '附件整理、归档到网盘、释放空间',
  snoozed: '到点自动回到收件箱',
  flagged: '加了旗标的邮件',
  pinned: '置顶的邮件'
}
