/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AgentRef, LifeCategory, LifeData } from '@shared/types'
import { COMMON_EXPECTED, daysUntil, LIFE_CATEGORIES, LIFE_CATEGORY_LABEL, lifeUrgency, repeatLabel } from '@shared/life'
import type { MailStore } from '../db'
import { parseWhen, ymd, type JsonSchema } from '../agent/protocol'
import type { AgentTool } from '../agent/tools'
import { lifeService } from './index'
import type { LifeRow } from './merge'

/**
 * Agent 工具：life_list（只读）/ life_create / life_update（写，需确认）。
 * 由 agent/tools.ts 的注册表展开；ToolError 由调用方注入（避免循环依赖）。
 */

const DAY = 864e5
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const fmtDay = (ms: number | null | undefined) => (ms ? `${ymd(new Date(ms))} ${WEEKDAY[new Date(ms).getDay()]}` : null)
const money = (n: number | null | undefined, cur?: string | null) => (n == null ? null : `${!cur || cur === 'CNY' ? '¥' : `${cur} `}${Math.round(n * 100) / 100}`)
const CAT_ENUM = LIFE_CATEGORIES as string[]
const URGENCY_LABEL = { overdue: '已过期', soon: '30 天内到期', act: '该开始办了', later: '还早', done: '已办妥', undated: '缺到期日' } as const

const lifeRef = (r: { id: string; title: string }): AgentRef => ({ type: 'life', id: r.id, label: r.title })

function brief(r: LifeRow, now: number) {
  const d = r.data
  const t = r.dueAt ?? d.expiresAt ?? null
  return {
    id: r.id,
    title: r.title,
    category: LIFE_CATEGORY_LABEL[d.category],
    subject: d.subject,
    ...(d.provider ? { provider: d.provider } : {}),
    ...(t ? { due: fmtDay(t), days_left: daysUntil(t, now) } : {}),
    ...(d.actionFrom ? { start_from: fmtDay(d.actionFrom) } : {}),
    state: URGENCY_LABEL[lifeUrgency(r, now)],
    repeat: repeatLabel(d.repeat ?? null),
    remind_days: d.remindDays,
    ...(d.reference ? { reference: d.reference } : {}),
    ...(d.amount != null ? { cost: money(d.amount, d.currency) } : {}),
    ...(d.notes ? { notes: String(d.notes).slice(0, 120) } : {}),
    ...(d.todoId ? { todo_id: d.todoId } : {}),
    ...(d.financeId ? { finance_id: d.financeId } : {}),
    mails: d.messageIds.length,
    ...(d.messageIds[0] ? { message_id: d.messageIds[d.messageIds.length - 1] } : {})
  }
}

const parseDay = (v: unknown): number | null | undefined => {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  const t = parseWhen(String(v), new Date(), '23:59')
  return t ?? undefined
}

const repeatOf = (v: unknown, interval: unknown): LifeData['repeat'] | undefined => {
  if (v === undefined) return undefined
  if (v === 'none' || v === null) return null
  if (v === 'year' || v === 'month') return { every: v, interval: Math.max(1, Math.min(10, Math.round(Number(interval) || 1))) }
  return undefined
}

const LIFE_FIELDS: Record<string, JsonSchema> = {
  category: { type: 'string', enum: CAT_ENUM, description: '类别：id-document 证件 / insurance 保险 / vehicle 车辆 / membership 会员 / domain 域名主机 / warranty 保修 / contract 合同 / housing 住房 / tax 税务 / health 健康 / education 教育 / card 银行卡 / other' },
  subject: { type: 'string', description: '对象，如「护照」「车险 · 苏A·12345」「example.com」；不要写完整证件号' },
  provider: { type: 'string', description: '机构 / 商家' },
  expires_at: { type: 'string', description: '到期 / 截止 / 预约日期（YYYY-MM-DD 或「明年3月18日」等）' },
  action_from: { type: 'string', description: '建议开始办理的日期（不填按类别自动算）' },
  repeat: { type: 'string', enum: ['year', 'month', 'none'], description: '循环：year 每年 / month 每月 / none 不循环' },
  interval: { type: 'integer', minimum: 1, maximum: 10, description: '每几年 / 几个月（默认 1）' },
  remind_days: { type: 'array', items: { type: 'integer' }, description: '提前几天提醒，如 [30, 7, 1]' },
  reference: { type: 'string', description: '编号（保单号 / 证件尾号），只会保存尾号' },
  amount: { type: 'number', description: '预计费用' },
  currency: { type: 'string', description: '币种，默认 CNY' },
  notes: { type: 'string', description: '备注 / 准备清单' }
}

export function lifeAgentTools(deps: { store: MailStore; fail(message: string): Error }): AgentTool[] {
  const svc = () => {
    const s = lifeService()
    if (!s) throw deps.fail('生活档案模块尚未就绪')
    return s
  }
  const dataPatch = (a: Record<string, any>): Partial<LifeData> => {
    const p: Partial<LifeData> = {}
    if (a.category !== undefined) p.category = (CAT_ENUM.includes(a.category) ? a.category : 'other') as LifeCategory
    if (a.subject !== undefined) p.subject = String(a.subject)
    if (a.provider !== undefined) p.provider = a.provider ? String(a.provider) : null
    const exp = parseDay(a.expires_at)
    if (a.expires_at !== undefined && exp === undefined) throw deps.fail(`到期日「${a.expires_at}」看不懂，换成 YYYY-MM-DD`)
    if (exp !== undefined) p.expiresAt = exp
    const act = parseDay(a.action_from)
    if (act !== undefined) p.actionFrom = act
    const rep = repeatOf(a.repeat, a.interval)
    if (rep !== undefined) p.repeat = rep
    if (Array.isArray(a.remind_days)) p.remindDays = a.remind_days.map(Number)
    if (a.reference !== undefined) p.reference = a.reference ? String(a.reference) : null
    if (a.amount !== undefined) p.amount = a.amount == null ? null : Number(a.amount)
    if (a.currency !== undefined) p.currency = String(a.currency || 'CNY').toUpperCase()
    if (a.notes !== undefined) p.notes = a.notes ? String(a.notes) : null
    return p
  }

  return [
    {
      name: 'life_list',
      title: '查生活档案',
      domain: 'calendar',
      risk: 'read',
      description:
        '列出生活档案里的到期 / 续期事务（证件、保险、车辆年检、会员、域名主机、保修、合同、住房、税务、体检、学费、信用卡年费）：到期日、剩余天数、建议开始办理日、循环、提醒天数、编号尾号、费用。可按类别、时间范围（未来 N 天 / 起止日期）、状态筛选；结果附各类别条数与常见但没找到的事项（如没有车险记录）。',
      params: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: CAT_ENUM },
          within_days: { type: 'integer', minimum: 1, maximum: 1100, description: '只看未来 N 天内到期的（含已过期未办的）' },
          from: { type: 'string', description: '到期日起（YYYY-MM-DD / 相对日期）' },
          to: { type: 'string', description: '到期日止' },
          status: { type: 'string', enum: ['open', 'done', 'all'], default: 'open' },
          query: { type: 'string', description: '对象 / 机构 / 备注关键词' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 40 }
        }
      },
      run(a) {
        const now = Date.now()
        const all = svc().rows(false)
        const from = a.from ? parseWhen(a.from, new Date(), '00:00') : null
        const to = a.to ? (parseWhen(a.to, new Date(), '00:00') ?? 0) + DAY - 1 : null
        const list = all.filter(r => {
          const t = r.dueAt ?? r.data.expiresAt ?? null
          const st = a.status ?? 'open'
          if (st !== 'all' && (st === 'done' ? r.status !== 'done' : r.status === 'done')) return false
          if (a.category && r.data.category !== a.category) return false
          if (a.within_days && (!t || t > now + a.within_days * DAY)) return false
          if (from && (!t || t < from)) return false
          if (to && (!t || t > to)) return false
          if (a.query) {
            const q = String(a.query).toLowerCase()
            if (!`${r.title} ${r.data.subject} ${r.data.provider ?? ''} ${r.data.notes ?? ''}`.toLowerCase().includes(q)) return false
          }
          return true
        })
        list.sort((x, y) => (x.dueAt ?? Infinity) - (y.dueAt ?? Infinity))
        const byCat: Record<string, number> = {}
        for (const r of all) if (r.status !== 'done') byCat[LIFE_CATEGORY_LABEL[r.data.category]] = (byCat[LIFE_CATEGORY_LABEL[r.data.category]] ?? 0) + 1
        const missing = COMMON_EXPECTED.filter(e => !all.some(r => r.data.category === e.category && e.test.test(`${r.title} ${r.data.subject}`))).map(e => e.label)
        const overdue = list.filter(r => lifeUrgency(r, now) === 'overdue').length
        const items = list.slice(0, a.limit ?? 40)
        return {
          data: { total: list.length, by_category: byCat, not_found_common: missing, items: items.map(r => brief(r, now)) },
          summary: list.length ? `${list.length} 件${overdue ? `，${overdue} 件已过期` : ''}` : '没有符合条件的生活事务',
          refs: items.slice(0, 12).map(lifeRef)
        }
      }
    },
    {
      name: 'life_create',
      title: '加入生活档案',
      domain: 'calendar',
      risk: 'write',
      description: '新建一条生活事务（证件到期、续保、年检、域名续费、会员年费、保修截止、租约、报税、体检预约…），到期前按提醒天数发系统通知。message_id 可关联来源邮件。',
      params: { type: 'object', properties: { ...LIFE_FIELDS, title: { type: 'string', description: '标题（不填用对象）' }, message_id: { type: 'string', description: '来源邮件 id' } }, required: ['category', 'subject'] },
      preview: a => [`${LIFE_CATEGORY_LABEL[(CAT_ENUM.includes(a.category) ? a.category : 'other') as LifeCategory]} · ${a.subject ?? ''}${a.provider ? ` · ${a.provider}` : ''}`, a.expires_at ? `到期：${a.expires_at}` : '到期日待补'],
      run(a) {
        const data = dataPatch(a)
        if (a.message_id) {
          if (!deps.store.getMessageRow(a.message_id)) throw deps.fail(`找不到邮件 ${a.message_id}`)
          data.messageIds = [String(a.message_id)]
        }
        const id = svc().create({ title: a.title, dueAt: data.expiresAt ?? null, data })
        const r = svc().get(id)!
        return { data: { ok: true, id, item: brief(r, Date.now()) }, summary: `已加入生活档案：${r.title}${r.dueAt ? `（${fmtDay(r.dueAt)} 到期）` : ''}`, refs: [lifeRef(r)] }
      }
    },
    {
      name: 'life_update',
      title: '改生活档案',
      domain: 'calendar',
      risk: 'write',
      description: '修改一条生活事务：到期日、建议办理日、循环、提醒天数、编号、费用、备注；status=done 表示已办妥（循环事务自动滚到下一期），status=open 重新打开。',
      params: { type: 'object', properties: { id: { type: 'string', description: '事务 id（life_list 返回）' }, ...LIFE_FIELDS, title: { type: 'string' }, status: { type: 'string', enum: ['open', 'done'] } }, required: ['id'] },
      preview: a => {
        const r = lifeService()?.get(String(a.id))
        const changes = Object.keys(a).filter(k => !['id', 'reason'].includes(k))
        return [r ? r.title : String(a.id), a.status === 'done' ? (r?.data.repeat ? '标记已办妥，滚到下一期' : '标记已办妥') : `修改：${changes.join('、') || '—'}`]
      },
      run(a) {
        const cur = svc().get(String(a.id))
        if (!cur || cur.status === 'dismissed') throw deps.fail(`找不到生活事务 ${a.id}；先用 life_list 查看`)
        const data = dataPatch(a)
        svc().update(cur.id, { title: a.title, status: a.status === 'done' || a.status === 'open' ? a.status : undefined, ...(data.expiresAt !== undefined ? { dueAt: data.expiresAt } : {}), data })
        const r = svc().get(cur.id)!
        return { data: { ok: true, item: brief(r, Date.now()) }, summary: a.status === 'done' ? (r.status === 'open' ? `已办妥，下一期 ${fmtDay(r.dueAt)}` : '已标记办妥') : `已更新「${r.title}」`, refs: [lifeRef(r)] }
      }
    }
  ]
}
