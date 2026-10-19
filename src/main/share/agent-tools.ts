/* eslint-disable @typescript-eslint/no-explicit-any */
import { CONTENT_FORMATS, formatLabel, SHARE_FORMATS, SHARE_GROUP_LABEL, type ShareFormat, type ShareRequest } from '@shared/share'
import { feedService } from '../feeds'
import type { MailStore } from '../db'
import type { AgentTool } from '../agent/tools'
import { shareService } from './index'

/**
 * Agent 工具：list_share_targets（只读）/ share_mail（对外，总是需要确认）。
 * 由 agent/tools.ts 的注册表展开；ToolError 由调用方注入（避免循环依赖）。
 */

const FORMAT_ENUM = SHARE_FORMATS.map(f => f.id)

export function shareAgentTools(deps: { store: MailStore; fail(msg: string): Error }): AgentTool[] {
  const svc = () => {
    const s = shareService()
    if (!s) throw deps.fail('分享模块尚未就绪')
    return s
  }
  const resolveTarget = (q: string) => {
    const list = svc().targets()
    const v = String(q ?? '').trim().toLowerCase()
    const hit = list.find(t => t.id.toLowerCase() === v) ?? list.find(t => t.name.toLowerCase() === v) ?? list.find(t => t.name.toLowerCase().includes(v))
    if (!hit) throw deps.fail(`找不到分享目标「${q}」，可用：${list.map(t => `${t.name}（${t.id}）`).join('、')}`)
    return hit
  }
  const idsOf = (a: any, ctxId?: string | null): string[] => {
    const raw = Array.isArray(a.message_ids) ? a.message_ids : a.message_id ? [a.message_id] : ctxId ? [ctxId] : []
    return raw.map(String).filter(Boolean).slice(0, 50)
  }
  return [
    {
      name: 'list_share_targets',
      title: '分享目标',
      domain: 'mail',
      risk: 'read',
      description: '列出可以把邮件发过去 / 导出过去的目标：工作 IM 群机器人（企业微信 / 钉钉 / 飞书 / Slack / Teams）、IM（Telegram / Discord / 微信 / WhatsApp）、笔记（Notion / flomo / 备忘录 / Markdown 文件夹）、本地与网盘，以及各自支持的格式。',
      params: { type: 'object', properties: {} },
      run() {
        const list = svc().targets()
        return {
          data: list.map(t => ({ id: t.id, name: t.name, group: SHARE_GROUP_LABEL[t.group], formats: t.formats, external: t.external })),
          summary: `${list.length} 个目标`
        }
      }
    },
    {
      name: 'share_mail',
      title: '分享 / 导出邮件',
      domain: 'mail',
      risk: 'external',
      description:
        '把邮件发到某个分享目标（如团队群机器人、Telegram、Notion、flomo），或导出为 PDF / 长图 / EML / Markdown 到本地或网盘（对外动作，每次都需要用户确认）。先用 list_share_targets 查目标 id 与支持的格式。也可以分享一条订阅文章：给 feed_item_id（来自 feed_search），不给 message_ids。',
      params: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标 id 或名称（来自 list_share_targets）' },
          message_ids: { type: 'array', items: { type: 'string' }, description: '邮件 id；不填则用当前打开的邮件' },
          feed_item_id: { type: 'string', description: '要分享的订阅条目 id（分享订阅文章时填，此时忽略 message_ids；不支持 eml 格式）' },
          format: { type: 'string', enum: FORMAT_ENUM, description: 'text 文本摘要 / rich 富文本 / pdf / png 长图 / eml 原文 / md Markdown / link 链接；IM 默认 text' },
          include_attachments: { type: 'boolean', description: '连同附件（Webhook 会先存到目标设置的网盘再附链接）' },
          merge: { type: 'boolean', description: '多封合并为一条消息 / 一个 PDF' },
          note: { type: 'string', description: '附言，放在消息开头（如「@产品组 请看这封客户反馈」）' }
        },
        required: ['target']
      },
      preview: a => {
        let name = String(a.target ?? '')
        try {
          name = resolveTarget(a.target).name
        } catch {
          /* 预览时目标不存在：执行时再报错 */
        }
        if (a.feed_item_id) {
          const it = feedService()?.item(String(a.feed_item_id))
          return [`发到：${name}`, `格式：${formatLabel((a.format as ShareFormat) || 'text')}`, `订阅文章：${it?.title ?? a.feed_item_id}${it?.sourceTitle ? `（${it.sourceTitle}）` : ''}`, ...(a.note ? [`附言：${String(a.note).slice(0, 200)}`] : [])]
        }
        const ids = Array.isArray(a.message_ids) ? a.message_ids.map(String) : []
        const subjects = ids.slice(0, 5).map((id: string) => deps.store.getMessageRow(id)?.subject || id)
        return [
          `发到：${name}`,
          `格式：${formatLabel((a.format as ShareFormat) || 'text')}${a.include_attachments ? '（含附件）' : ''}${a.merge ? '，合并' : ''}`,
          ...(subjects.length ? [`邮件：${subjects.join('、')}${ids.length > 5 ? ` 等 ${ids.length} 封` : ''}`] : ['邮件：当前打开的这封']),
          ...(a.note ? [`附言：${String(a.note).slice(0, 200)}`] : [])
        ]
      },
      async run(a, ctx) {
        const t = resolveTarget(a.target)
        if (a.feed_item_id) {
          const it = feedService()?.item(String(a.feed_item_id))
          if (!it) throw deps.fail(`找不到订阅条目 ${a.feed_item_id}；先用 feed_search 查找`)
          const formats = t.formats.filter(f => CONTENT_FORMATS.includes(f))
          if (!formats.length) throw deps.fail(`「${t.name}」不支持分享网页内容`)
          const format = (formats.includes(a.format) ? a.format : formats.includes('text') ? 'text' : formats[0]) as ShareFormat
          const req: ShareRequest = { messageIds: [], content: { kind: 'link', title: it.title, url: it.url, source: it.sourceTitle, feedItemId: it.id }, targetId: t.id, format, note: a.note ? String(a.note) : undefined, confirmed: true }
          const res = t.id === 'sys:export' ? await svc().exportFiles({ ...req, where: 'quick' }) : await svc().send(req, { via: 'agent' })
          if (!res.ok) throw deps.fail(res.error ?? '发送失败')
          return { data: { ok: true, target: t.name, format, message: res.message, ...(res.paths?.length ? { paths: res.paths.slice(0, 10) } : {}) }, summary: res.message ?? `已发到 ${t.name}` }
        }
        const ids = idsOf(a, ctx.messageId)
        if (!ids.length) throw deps.fail('没有指定邮件（message_ids），当前也没有打开的邮件')
        const format = (FORMAT_ENUM.includes(a.format) ? a.format : t.formats.includes('text') ? 'text' : t.formats[0]) as ShareFormat
        if (!t.formats.includes(format)) throw deps.fail(`「${t.name}」不支持 ${formatLabel(format)}，可用：${t.formats.map(formatLabel).join('、')}`)
        // 走到这里说明用户已在确认卡上同意（external 工具总是先确认）
        const req = { messageIds: ids, targetId: t.id, format, includeAttachments: !!a.include_attachments, merge: !!a.merge, note: a.note ? String(a.note) : undefined, confirmed: true }
        const res = t.id === 'sys:export' ? await svc().exportFiles({ ...req, where: 'quick' }) : await svc().send(req, { via: 'agent' })
        if (!res.ok) throw deps.fail(res.error ?? '发送失败')
        return {
          data: { ok: true, target: t.name, format, message: res.message, ...(res.paths?.length ? { paths: res.paths.slice(0, 10) } : {}), ...(res.url ? { url: res.url } : {}) },
          summary: res.message ?? `已发到 ${t.name}`,
          refs: ids.slice(0, 6).map(id => ({ type: 'mail' as const, id, label: deps.store.getMessageRow(id)?.subject || '（无主题）' }))
        }
      }
    }
  ]
}
