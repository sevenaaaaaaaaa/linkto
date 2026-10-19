import { useEffect, useState } from 'react'
import type { RuleAction, RuleCondition, RuleSuggestion } from '@shared/types'
import { api } from './api'

/** 规则建议列表（主进程挖掘 / 接受 / 忽略后推 'rule-suggestions' 事件，自动刷新） */
export function useRuleSuggestions(): { list: RuleSuggestion[] | null; reload: () => void } {
  const [list, setList] = useState<RuleSuggestion[] | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    const load = () =>
      void api
        .ruleSuggestions()
        .then(l => alive && setList(l))
        .catch(() => alive && setList([]))
    load()
    const off = api.onEvent(ev => {
      const t = (ev as { type?: string }).type
      if (t === 'rule-suggestions') load()
    })
    return () => {
      alive = false
      void off()
    }
  }, [tick])
  return { list, reload: () => setTick(t => t + 1) }
}

const ACTION_VERB: Partial<Record<RuleAction['type'], string>> = {
  archive: '自动归档',
  moveTrash: '自动删除',
  moveFolder: '自动移过去',
  flag: '自动加旗标',
  pin: '自动置顶',
  markRead: '自动标为已读',
  createTodo: '自动建待办'
}

/** 「以后自动归档？」 */
export function suggestionQuestion(s: RuleSuggestion): string {
  const a = s.rule.actions[0]
  if (!a) return '以后自动处理？'
  if (a.type === 'snooze') return `以后自动稍后 ${fmtHours(Number(a.value) || 3)}？`
  return `以后${ACTION_VERB[a.type] ?? '自动处理'}？`
}

export function fmtHours(h: number): string {
  return h % 24 === 0 ? `${h / 24} 天` : `${h} 小时`
}

const FIELD: Record<string, string> = { from: '发件人', to: '收件人', subject: '主题', listId: '邮件列表', hasAttachment: '带附件', isNewsletter: '是订阅邮件', ai: 'AI 判断' }
const OP: Record<string, string> = { contains: '包含', equals: '是', startsWith: '开头是', endsWith: '结尾是', regex: '匹配', is: '' }

/** 条件的人话：发件人是 a@b.example；发件人属于 shop.example（域名正则还原成域名） */
export function describeCondition(c: RuleCondition): string {
  if (c.field === 'from' && c.op === 'regex') {
    const m = c.value.match(/^\[@\.\](.+)\$$/)
    if (m) return `发件人属于 ${m[1].replace(/\\\./g, '.')}`
  }
  if (c.field === 'hasAttachment' || c.field === 'isNewsletter') return `${FIELD[c.field]}${c.value === 'no' ? '：否' : ''}`
  return `${FIELD[c.field] ?? c.field}${OP[c.op] ?? c.op} ${c.value}`
}

export function describeAction(a: RuleAction, folderName?: (id: string) => string | undefined): string {
  switch (a.type) {
    case 'archive':
      return '归档'
    case 'moveTrash':
      return '移到废纸篓'
    case 'moveFolder':
      return `移到「${folderName?.(a.value ?? '') ?? '文件夹'}」`
    case 'flag':
      return '加旗标'
    case 'pin':
      return '置顶'
    case 'snooze':
      return `稍后 ${fmtHours(Number(a.value) || 3)}`
    case 'createTodo':
      return '建待办'
    case 'markRead':
      return '标为已读'
    default:
      return a.type
  }
}
