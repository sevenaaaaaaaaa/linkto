/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AgentRef } from '@shared/types'
import {
  agreementLine, fmtTraceTime, inRange, isTraceChannel, materialsText, TRACE_CHANNEL_LABEL, TRACE_CHANNELS, TRACE_STATUS_LABEL, TRACE_STATUSES,
  traceHasParty, validateSummary, type TraceRecord
} from '@shared/trace'
import type { MailStore } from '../db'
import { parseWhen, type JsonSchema } from '../agent/protocol'
import type { AgentTool } from '../agent/tools'
import { normMaterial } from './core'
import { traceService } from './index'

/**
 * Agent 工具：trace_list（只读）/ trace_create（写，需确认）/ trace_confirm_draft（写：起草书面确认，只起草不发送）。
 * 由 agent/tools.ts 的注册表展开；ToolError 由调用方注入（避免循环依赖）。
 */

const DAY = 864e5
const ref = (r: { id: string; title: string }): AgentRef => ({ type: 'trace', id: r.id, label: r.title })

function brief(r: TraceRecord) {
  const d = r.data
  const s = d.summary
  return {
    id: r.id,
    title: r.title,
    channel: TRACE_CHANNEL_LABEL[d.channel],
    occurred: fmtTraceTime(d.occurredAt),
    status: TRACE_STATUS_LABEL[d.status],
    parties: d.parties.map(p => `${p.name}${p.email ? ` <${p.email}>` : ''}${p.me ? '（我）' : ''}`),
    ...(s?.conclusion ? { conclusion: s.conclusion } : {}),
    agreements: (s?.agreements ?? []).map(agreementLine),
    ...(s?.pending.length ? { pending: s.pending } : {}),
    ...(s?.risks.length ? { risks: s.risks } : {}),
    ...(d.confirm
      ? {
          confirm: {
            to: d.confirm.to,
            sent: d.confirm.sentAt ? fmtTraceTime(d.confirm.sentAt) : null,
            reply: d.confirm.replyAt ? `${fmtTraceTime(d.confirm.replyAt)} ${d.confirm.verdict === 'disputed' ? '有异议' : '已确认'}` : null,
            ...(d.confirm.replyMessageId ? { reply_message_id: d.confirm.replyMessageId } : {})
          }
        }
      : {}),
    materials: d.materials.length,
    ...(d.links.messageIds.length ? { message_ids: d.links.messageIds.slice(0, 5) } : {}),
    hash: `${d.hash.slice(0, 16)}…`,
    versions: d.versions.length
  }
}

const AGREEMENT: JsonSchema = {
  type: 'object',
  properties: {
    who: { type: 'string', description: '谁（材料里的称呼；用户本人写「我」）' },
    what: { type: 'string', description: '做什么 / 约定内容' },
    when: { type: 'string', description: '时间，照抄原文写法（原文没有就不填）' },
    amount: { type: 'string', description: '金额，照抄原文写法（原文没有就不填）' },
    quote: { type: 'string', description: '支撑这条的原文片段' }
  },
  required: ['what']
}

export function traceAgentTools(deps: { store: MailStore; fail(message: string): Error }): AgentTool[] {
  const svc = () => {
    const s = traceService()
    if (!s) throw deps.fail('留痕模块尚未就绪')
    return s
  }
  return [
    {
      name: 'trace_list',
      title: '查留痕',
      domain: 'memory',
      risk: 'read',
      description:
        '列出「留痕」记录：电话 / 微信 / 会议 / 当面 / 其他 IM 里口头说定的事整理成的书面记录（结论、约定事项（谁 / 做什么 / 何时 / 金额）、待确认点、风险提示、书面确认状态：草稿 / 已整理 / 已发确认 / 对方已确认 / 有异议）。可按关键词、参与人、状态、时间范围筛选。',
      params: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '标题 / 约定内容 / 材料关键词' },
          party: { type: 'string', description: '参与人姓名或邮箱' },
          status: { type: 'string', enum: [...TRACE_STATUSES, 'all'], default: 'all' },
          within_days: { type: 'integer', minimum: 1, maximum: 3650, description: '只看最近 N 天发生的' },
          from: { type: 'string', description: '发生时间起（YYYY-MM-DD / 相对日期）' },
          to: { type: 'string', description: '发生时间止' },
          id: { type: 'string', description: '只看这一条（含原始材料全文）' },
          limit: { type: 'integer', minimum: 1, maximum: 60, default: 20 }
        }
      },
      run(a) {
        const all = svc().list()
        if (a.id) {
          const r = all.find(x => x.id === a.id)
          if (!r) throw deps.fail(`找不到留痕 ${a.id}；先用 trace_list 查看`)
          return { data: { ...brief(r), material_text: materialsText(r.data.materials).slice(0, 6000) }, summary: r.title, refs: [ref(r)] }
        }
        const now = Date.now()
        const from = a.from ? parseWhen(a.from, new Date(), '00:00') : a.within_days ? now - a.within_days * DAY : null
        const to = a.to ? (parseWhen(a.to, new Date(), '00:00') ?? 0) + DAY - 1 : null
        const q = String(a.query ?? '').trim().toLowerCase()
        const list = all.filter(r => {
          if (a.status && a.status !== 'all' && r.data.status !== a.status) return false
          if (a.party && !traceHasParty(r, String(a.party))) return false
          if (!inRange(r, from, to)) return false
          if (q) {
            const hay = `${r.title} ${r.data.summary?.conclusion ?? ''} ${(r.data.summary?.agreements ?? []).map(agreementLine).join(' ')} ${materialsText(r.data.materials)}`.toLowerCase()
            if (!hay.includes(q)) return false
          }
          return true
        })
        const items = list.slice(0, a.limit ?? 20)
        const by: Record<string, number> = {}
        for (const r of list) by[TRACE_STATUS_LABEL[r.data.status]] = (by[TRACE_STATUS_LABEL[r.data.status]] ?? 0) + 1
        return {
          data: { total: list.length, by_status: by, items: items.map(brief) },
          summary: list.length ? `${list.length} 条留痕` : '没有符合条件的留痕',
          refs: items.slice(0, 12).map(ref)
        }
      }
    },
    {
      name: 'trace_create',
      title: '记一笔留痕',
      domain: 'memory',
      risk: 'write',
      description:
        '新建一条留痕：把口头 / 聊天里说定的事记下来（原始材料 + 整理结果）。text 放用户粘贴的聊天记录或备注原文（作为凭据原样保存）；agreements 只能写材料里有依据的内容——金额、日期照抄原文，材料里找不到的会被自动移到「待确认」。不确定怎么整理时可以不填 agreements，设 organize=true 交给留痕自己整理（AI 已配置时用 AI，否则按模板）。',
      params: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '≤24 字概括' },
          channel: { type: 'string', enum: TRACE_CHANNELS, description: 'phone 电话 / wechat 微信 / meeting 会议 / in-person 当面 / im 其他 IM / other' },
          occurred_at: { type: 'string', description: '发生时间（YYYY-MM-DD HH:mm 或「昨天下午」等）' },
          parties: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } }, required: ['name'] }, description: '参与人（对方，可带邮箱）' },
          text: { type: 'string', description: '原始材料：粘贴的聊天记录 / 通话备注原文' },
          message_id: { type: 'string', description: '相关邮件 id（可选）' },
          conclusion: { type: 'string' },
          agreements: { type: 'array', items: AGREEMENT },
          pending: { type: 'array', items: { type: 'string' } },
          risks: { type: 'array', items: { type: 'string' } },
          organize: { type: 'boolean', description: '不填 agreements 时让留痕自动整理' }
        },
        required: ['title', 'text']
      },
      preview: a => [`${TRACE_CHANNEL_LABEL[isTraceChannel(a.channel) ? a.channel : 'other']} · ${a.title ?? ''}`, ...(Array.isArray(a.agreements) ? a.agreements.slice(0, 6).map((x: any) => `· ${agreementLine({ who: x.who ?? '', what: x.what ?? '', when: x.when, amount: x.amount })}`) : []), `原始材料 ${String(a.text ?? '').length} 字`],
      async run(a) {
        const text = String(a.text ?? '').trim()
        if (!text) throw deps.fail('text（原始材料）不能为空')
        if (a.message_id && !deps.store.getMessageRow(a.message_id)) throw deps.fail(`找不到邮件 ${a.message_id}`)
        const occurredAt = a.occurred_at ? parseWhen(String(a.occurred_at), new Date(), '12:00') : null
        const mat = normMaterial({ kind: 'text', text }, Date.now())
        const hasSummary = Array.isArray(a.agreements) && a.agreements.length
        const summary = hasSummary
          ? validateSummary(
              {
                conclusion: String(a.conclusion ?? ''),
                agreements: a.agreements.map((x: any) => ({ who: String(x?.who ?? ''), what: String(x?.what ?? ''), when: x?.when ? String(x.when) : null, amount: x?.amount ? String(x.amount) : null, quote: x?.quote ? String(x.quote) : null })).filter((x: any) => x.what),
                pending: Array.isArray(a.pending) ? a.pending.map(String) : [],
                risks: Array.isArray(a.risks) ? a.risks.map(String) : [],
                by: 'agent',
                at: Date.now()
              },
              mat ? materialsText([mat]) : text
            )
          : undefined
        const id = svc().create({
          title: String(a.title),
          channel: isTraceChannel(a.channel) ? a.channel : 'other',
          // 没给发生时间：用聊天记录里最后一条消息的时间
          occurredAt: occurredAt ?? (mat?.lines?.length ? Math.max(...mat.lines.map(l => l.at ?? 0)) || null : null),
          parties: Array.isArray(a.parties) ? a.parties.map((p: any) => ({ name: String(p?.name ?? ''), email: p?.email ? String(p.email) : null })) : [],
          materials: [{ kind: 'text', text }],
          summary,
          messageIds: a.message_id ? [String(a.message_id)] : [],
          source: 'agent'
        })
        let organized: { ok: boolean; by?: string; warnings?: string[]; error?: string } | null = null
        if (!hasSummary && a.organize) organized = await svc().organize(id, 'ai')
        const r = svc().list().find(x => x.id === id)!
        const warnings = [...(summary?.warnings ?? []), ...(organized?.warnings ?? [])]
        return {
          data: { ok: true, id, item: brief(r), ...(warnings.length ? { warnings } : {}), ...(organized && !organized.ok ? { organize_error: organized.error } : {}) },
          summary: `已记一笔留痕：${r.title}${warnings.length ? `（${warnings.length} 处已改为待确认）` : ''}`,
          refs: [ref(r)]
        }
      }
    },
    {
      name: 'trace_confirm_draft',
      title: '起草书面确认',
      domain: 'mail',
      risk: 'write',
      description:
        '为一条留痕起草「书面确认」邮件给对方（时间、事项、约定条款逐条、请对方回复确认或指正），打开撰写窗让用户检查后自己发送（绝不自动发送）；同时登记跟进（等对方回复，默认 3 天），对方回信后留痕自动标为「对方已确认」或「有异议」。to 不填时用参与人里的邮箱。',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '留痕 id（trace_list / trace_create 返回）' },
          to: { type: 'array', items: { type: 'string' }, description: '收件人邮箱（可选）' },
          wait_days: { type: 'integer', minimum: 1, maximum: 14, default: 3 }
        },
        required: ['id']
      },
      preview: a => {
        const r = traceService()?.get(String(a.id))
        return [r ? `书面确认：${r.title}` : String(a.id), `收件人：${(Array.isArray(a.to) && a.to.length ? a.to : r?.data.parties.filter(p => !p.me && p.email).map(p => p.email) ?? []).join('、') || '（在撰写窗里填）'}`, '只起草、不发送']
      },
      async run(a, ctx) {
        const r = svc().get(String(a.id))
        if (!r) throw deps.fail(`找不到留痕 ${a.id}；先用 trace_list 查看`)
        const res = await svc().confirmDraft(r.id, { to: Array.isArray(a.to) ? a.to.map(String) : undefined, waitDays: a.wait_days, open: !ctx.headless })
        if (!res.ok) throw deps.fail(res.error ?? '起草失败')
        const after = svc().get(r.id)!
        return {
          data: { ok: true, draft_id: res.draftId, ...(res.followupId ? { followup_id: res.followupId } : {}), to: after.data.confirm?.to ?? [], note: ctx.headless ? '已存为本地草稿，未发送；已登记跟进' : '已打开撰写窗，等用户检查后发送；没有自动发送；已登记跟进' },
          summary: `${ctx.headless ? '已存书面确认草稿' : '已打开书面确认撰写窗'}（未发送）· 已登记跟进`,
          refs: [ref(after), ...(res.followupId ? [{ type: 'followup' as const, id: res.followupId, label: after.data.confirm?.subject ?? after.title }] : [])]
        }
      }
    }
  ]
}

