import type { AgentEventKind } from './types'

/** 事件触发技能：事件类型的中文名与说明（主进程活动记录 / 渲染端编辑器与阅读页共用） */

/** 事件的中文名（活动记录标题 / 阅读页事件条 / 编辑器多选） */
export const EVENT_LABEL: Record<AgentEventKind, string> = {
  invoice: '发票',
  'payment-due': '付款到期',
  'flight-change': '行程变更',
  'travel-booking': '出行预订',
  'security-alert': '安全提醒',
  contract: '合同',
  'meeting-invite': '会议邀请',
  'meeting-notes': '会议纪要',
  'package-issue': '快递异常',
  'job-application': '求职进展',
  custom: '自定义条件'
}

/** 技能卡片标签：「⚡ 收到发票时自动运行」 */
export const EVENT_WHEN: Record<AgentEventKind, string> = {
  invoice: '收到发票 / 账单时',
  'payment-due': '有款项即将到期时',
  'flight-change': '航班 / 行程变更时',
  'travel-booking': '有新的出行预订时',
  'security-alert': '收到异常登录 / 安全提醒时',
  contract: '收到合同 / 协议时',
  'meeting-invite': '收到会议邀请时',
  'meeting-notes': '收到会议纪要 / 会后邮件时',
  'package-issue': '快递异常时',
  'job-application': '求职 / 招聘有进展时',
  custom: '新邮件满足条件时'
}

/** 编辑器多选的顺序 */
export const EVENT_KINDS: AgentEventKind[] = ['invoice', 'payment-due', 'flight-change', 'travel-booking', 'security-alert', 'contract', 'meeting-invite', 'meeting-notes', 'package-issue', 'job-application', 'custom']
