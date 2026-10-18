import type { Rule, RuleCondition, RuleAction, MessageCategory } from '@shared/types'

export interface RuleEvalContext {
  from: string
  to: string
  subject: string
  listId: string | null
  isNewsletter: boolean
  hasAttachment: boolean
  snippet: string
}

function matchField(ctx: RuleEvalContext, field: RuleCondition['field']): string {
  switch (field) {
    case 'from':
      return ctx.from
    case 'to':
      return ctx.to
    case 'subject':
      return ctx.subject
    case 'listId':
      return ctx.listId ?? ''
    case 'hasAttachment':
      return ctx.hasAttachment ? 'yes' : 'no'
    case 'isNewsletter':
      return ctx.isNewsletter ? 'yes' : 'no'
    case 'ai':
      return ''
  }
}

export const hasAiCondition = (r: Rule) => r.conditions.some(c => c.field === 'ai')

function matchCondition(c: RuleCondition, ctx: RuleEvalContext): boolean {
  const actual = matchField(ctx, c.field)
  const value = c.value ?? ''
  const boolExpected = c.op === 'is' ? value.toLowerCase() === 'yes' : false
  if (c.field === 'hasAttachment' || c.field === 'isNewsletter') {
    const actualYes = actual === 'yes'
    return boolExpected ? actualYes : !actualYes
  }
  switch (c.op) {
    case 'contains':
      return actual.toLowerCase().includes(value.toLowerCase())
    case 'equals':
      return actual.toLowerCase() === value.toLowerCase()
    case 'startsWith':
      return actual.toLowerCase().startsWith(value.toLowerCase())
    case 'endsWith':
      return actual.toLowerCase().endsWith(value.toLowerCase())
    case 'regex':
      try {
        return new RegExp(value, 'i').test(actual)
      } catch {
        return false
      }
    default:
      return false
  }
}

/** 合并多条命中规则的动作：同类型动作只保留一次（后面的规则覆盖前面的值） */
function mergeActions(lists: RuleAction[][]): RuleAction[] {
  const byType = new Map<string, RuleAction>()
  for (const list of lists) for (const a of list) byType.set(a.type, a)
  return [...byType.values()]
}

/**
 * 返回所有命中规则的动作（未命中返回空）——与常见邮件过滤器一致，多条规则可以叠加生效。
 * 含 AI 条件的规则不在这里判断（同步路径不能等模型）。
 */
export function evalRules(rules: Rule[], ctx: RuleEvalContext): RuleAction[] {
  const enabled = rules.filter(r => r.enabled && !hasAiCondition(r)).sort((a, b) => a.order - b.order)
  return mergeActions(enabled.filter(r => r.conditions.length > 0 && r.conditions.every(c => matchCondition(c, ctx))).map(r => r.actions))
}

/**
 * 含 AI 条件的规则：普通条件先在本地判断，全部通过后才逐条问 AI（judge 返回是否满足）。
 * 与普通规则相互独立，所有命中的规则叠加生效。
 */
export async function evalAiRules(
  rules: Rule[],
  ctx: RuleEvalContext,
  judge: (criteria: string) => Promise<boolean>
): Promise<RuleAction[]> {
  const candidates = rules.filter(r => r.enabled && hasAiCondition(r)).sort((a, b) => a.order - b.order)
  const hits: RuleAction[][] = []
  for (const rule of candidates) {
    const plain = rule.conditions.filter(c => c.field !== 'ai')
    if (!plain.every(c => matchCondition(c, ctx))) continue
    let ok = true
    for (const c of rule.conditions.filter(c => c.field === 'ai')) {
      if (!c.value.trim() || !(await judge(c.value.trim()))) {
        ok = false
        break
      }
    }
    if (ok) hits.push(rule.actions)
  }
  return mergeActions(hits)
}

export const CATEGORY_VALUES: MessageCategory[] = ['personal', 'notification', 'newsletter', 'noise']
