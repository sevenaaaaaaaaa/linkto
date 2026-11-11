export interface AgentEntry { index: number; summary: string; tasks: Array<{ title: string; detail: string; minutes: number }> }
/** Validate model output before it reaches any state-changing tool. */
export function parseAgentResponse(raw: string, count: number): AgentEntry[] {
  const value: unknown = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
  if (!value || typeof value !== 'object' || !Array.isArray((value as { entries?: unknown }).entries)) throw new Error('Agent 返回的格式不正确，未修改任何记录')
  const entries = (value as { entries: unknown[] }).entries
  if (entries.length > count) throw new Error('Agent 返回了无效的邮件引用')
  const seen = new Set<number>()
  let taskCount = 0
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw new Error('Agent 返回格式不正确')
    const e = entry as Record<string, unknown>
    if (!Number.isInteger(e.index) || Number(e.index) < 0 || Number(e.index) >= count || seen.has(Number(e.index)) || typeof e.summary !== 'string' || !Array.isArray(e.tasks) || e.tasks.length > 2) throw new Error('Agent 返回了无效的邮件引用或行动项')
    seen.add(Number(e.index))
    return { index: Number(e.index), summary: e.summary.slice(0, 1600), tasks: e.tasks.map(task => {
      if (!task || typeof task !== 'object') throw new Error('Agent 行动项无效')
      const t = task as Record<string, unknown>
      if (typeof t.title !== 'string' || !t.title.trim() || typeof t.detail !== 'string' || !Number.isInteger(t.minutes) || Number(t.minutes) < 5 || Number(t.minutes) > 120 || Number(t.minutes) % 5 || ++taskCount > 10) throw new Error('Agent 行动项无效，未保存待办')
      return { title: t.title.trim().slice(0, 240), detail: t.detail.slice(0, 4000), minutes: Number(t.minutes) }
    }) }
  })
}
