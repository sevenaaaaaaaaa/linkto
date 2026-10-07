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
  }
}

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

/** 返回规则命中的动作列表（未命中返回空） */
export function evalRules(rules: Rule[], ctx: RuleEvalContext): RuleAction[] {
  const enabled = rules.filter(r => r.enabled).sort((a, b) => a.order - b.order)
  for (const rule of enabled) {
    const hit =
      rule.conditions.length > 0 &&
      rule.conditions.every(c => matchCondition(c, ctx))
    if (hit) return rule.actions
  }
  return []
}

export const CATEGORY_VALUES: MessageCategory[] = ['personal', 'notification', 'newsletter', 'noise']
