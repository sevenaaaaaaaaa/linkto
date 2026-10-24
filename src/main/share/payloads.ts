import { createHmac } from 'node:crypto'

/**
 * 各平台消息体构造（纯函数，可单测）：企业微信 / 钉钉（加签）/ 飞书（签名校验）/ Slack / Teams / Discord /
 * Telegram / Notion blocks / flomo。输入统一为 ShareDigest（一封或多封邮件的摘要）。
 */

export interface DigestMail {
  subject: string
  from: string
  to: string
  date: number
  dateText: string
  /** AI 要点（邮件理解已有结果时） */
  gist?: string | null
  highlights?: string[]
  /** 正文摘录（已截断） */
  excerpt: string
  attachments: { name: string; size: number }[]
  /** LinkTo 内部链接 */
  appLink: string
  /** 网页版备选链接 */
  webLink?: string | null
  /** link = 通用内容（订阅文章 / 网页）：from 是来源，appLink 是原文链接 */
  kind?: 'mail' | 'link'
}

/** 邮件 / 通用内容的字段名 */
export const labelsOf = (m: Pick<DigestMail, 'kind'> | undefined) =>
  m?.kind === 'link' ? { from: '来源', open: '原文链接', noun: '分享', many: '条内容', gist: '摘要' } : { from: '发件人', open: '本机打开', noun: '邮件', many: '封邮件', gist: 'AI 要点' }

export interface ShareDigest {
  mails: DigestMail[]
  note?: string
  /** 已归档到网盘的文件：有分享链接给 url，否则给路径说明 */
  files: { name: string; url?: string | null; where?: string | null }[]
  /** 只发链接（format = link） */
  linkOnly?: boolean
}

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)
const subj = (s: string) => (s || '').trim() || '（无主题）'

/** 按 UTF-8 字节截断（企业微信 4096 字节上限） */
export function truncateBytes(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= max) return s
  let cut = buf.subarray(0, max - 3).toString('utf8')
  if (cut.endsWith('\ufffd')) cut = cut.slice(0, -1)
  return cut + '…'
}

/** 按字符截断 */
export function truncateChars(s: string, max: number): string {
  const c = [...s]
  return c.length <= max ? s : c.slice(0, Math.max(0, max - 1)).join('') + '…'
}

const title = (d: ShareDigest) => (d.mails.length === 1 ? subj(d.mails[0].subject) : `${d.mails.length} ${labelsOf(d.mails[0]).many}`)

// ---------------------------------------------------------------- 通用 Markdown（企业微信 / 钉钉 / 飞书 lark_md / Discord）

/** 引用块里的正文：每行前缀 > ，去掉会破坏格式的标记 */
const quote = (s: string) =>
  s
    .split('\n')
    .map(l => `> ${l.replace(/^#+\s*/, '').replace(/[<>]/g, m => (m === '<' ? '‹' : '›'))}`.trimEnd())
    .join('\n')

/** 平台无关的 Markdown 正文（标题由各平台单独放） */
export function digestMarkdown(d: ShareDigest, opts: { bold?: (s: string) => string; link?: (text: string, url: string) => string; quoteBody?: boolean; noTitle?: boolean } = {}): string {
  const b = opts.bold ?? ((s: string) => `**${s}**`)
  const link = opts.link ?? ((t: string, u: string) => `[${t}](${u})`)
  const out: string[] = []
  if (d.note?.trim()) out.push(d.note.trim(), '')
  d.mails.forEach((m, i) => {
    if (d.mails.length > 1 || !opts.noTitle) out.push(b(`${d.mails.length > 1 ? `${i + 1}. ` : ''}${subj(m.subject)}`))
    const L = labelsOf(m)
    if (m.from) out.push(`${L.from}：${m.from}`)
    if (m.dateText) out.push(`时间：${m.dateText}`)
    if (d.linkOnly) {
      if (m.appLink) out.push(m.kind === 'link' ? link(L.open, m.appLink) : `${L.open}：${m.appLink}`)
      if (m.webLink) out.push(link('网页版搜索', m.webLink))
      out.push('')
      return
    }
    if (m.gist) out.push(`${b(L.gist)}：${m.gist}`)
    for (const h of (m.highlights ?? []).slice(0, 3)) out.push(`- ${h}`)
    if (m.excerpt) out.push(opts.quoteBody === false ? m.excerpt : quote(m.excerpt))
    // 通用内容：正文之后带上原文链接（邮件的本机链接只在「链接」格式里给）
    if (m.kind === 'link' && m.appLink) out.push(link(L.open, m.appLink))
    if (m.attachments.length) out.push(`附件：${m.attachments.map(a => `${a.name}（${fmtSize(a.size)}）`).join('、')}`)
    out.push('')
  })
  if (d.files.length) {
    out.push(b('文件'))
    for (const f of d.files) out.push(f.url ? `- ${link(f.name, f.url)}` : `- ${f.name}${f.where ? `：${f.where}` : ''}`)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ---------------------------------------------------------------- 企业微信

export function wecomPayload(d: ShareDigest) {
  const content = truncateBytes(`### ${title(d)}\n${digestMarkdown(d, { noTitle: true })}`, 4096)
  return { msgtype: 'markdown', markdown: { content } }
}

// ---------------------------------------------------------------- 钉钉（加签：timestamp + "\n" + secret 做 HmacSHA256，key = secret）

export function dingtalkSign(secret: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}\n${secret}`, 'utf8').digest('base64')
}

export function dingtalkUrl(url: string, secret: string | null | undefined, timestamp = Date.now()): string {
  if (!secret) return url
  const sign = encodeURIComponent(dingtalkSign(secret, timestamp))
  return `${url}${url.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${sign}`
}

export function dingtalkPayload(d: ShareDigest) {
  const t = title(d)
  // 钉钉 markdown 换行需要两个空格或空行；正文 ≤ 20000 字符
  // 通用内容不含「邮件」二字：补一行落款，让设了「邮件」关键词的机器人也能通过校验
  const tail = d.mails[0]?.kind === 'link' ? '\n\n— 由 LinkTo 邮件客户端分享' : ''
  const text = truncateChars(`#### ${t}\n\n${digestMarkdown(d, { noTitle: true }).replace(/\n/g, '\n\n').replace(/\n\n(> )/g, '\n$1')}${tail}`, 18000)
  return { msgtype: 'markdown', markdown: { title: truncateChars(`${labelsOf(d.mails[0]).noun}：${t}`, 60), text } }
}

// ---------------------------------------------------------------- 飞书 / Lark（签名校验：key = timestamp + "\n" + secret，对空串做 HmacSHA256）

export function feishuSign(secret: string, timestampSec: number): string {
  return createHmac('sha256', `${timestampSec}\n${secret}`).update('').digest('base64')
}

export function feishuPayload(d: ShareDigest, secret?: string | null, timestampSec = Math.floor(Date.now() / 1000)) {
  const body = truncateChars(digestMarkdown(d, { noTitle: true, quoteBody: false }), 9000)
  const card = {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: truncateChars(title(d), 100) } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: body } }]
  }
  return {
    ...(secret ? { timestamp: String(timestampSec), sign: feishuSign(secret, timestampSec) } : {}),
    msg_type: 'interactive',
    card
  }
}

// ---------------------------------------------------------------- Slack（Block Kit；mrkdwn：*粗体*、<url|文字>，转义 & < >）

const slackEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function slackPayload(d: ShareDigest) {
  const t = title(d)
  const blocks: unknown[] = [{ type: 'header', text: { type: 'plain_text', text: truncateChars(t, 150), emoji: false } }]
  const md = digestMarkdown(
    {
      ...d,
      note: d.note ? slackEsc(d.note) : d.note,
      mails: d.mails.map(m => ({ ...m, subject: slackEsc(m.subject), from: slackEsc(m.from), gist: m.gist ? slackEsc(m.gist) : m.gist, highlights: (m.highlights ?? []).map(slackEsc), excerpt: slackEsc(m.excerpt), attachments: m.attachments.map(a => ({ ...a, name: slackEsc(a.name) })) })),
      files: d.files.map(f => ({ ...f, name: slackEsc(f.name), where: f.where ? slackEsc(f.where) : f.where }))
    },
    { bold: s => `*${s}*`, link: (x, u) => `<${u}|${x}>`, noTitle: true }
  )
  // section 文本上限 3000：按段切块，最多 20 块
  const chunks: string[] = []
  let cur = ''
  for (const para of md.split('\n\n')) {
    if ((cur + '\n\n' + para).length > 2900) {
      if (cur) chunks.push(cur)
      cur = truncateChars(para, 2900)
    } else cur = cur ? `${cur}\n\n${para}` : para
  }
  if (cur) chunks.push(cur)
  for (const c of chunks.slice(0, 20)) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: c } })
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '来自 LinkTo' }] })
  return { text: truncateChars(`${labelsOf(d.mails[0]).noun}：${t}`, 300), blocks }
}

// ---------------------------------------------------------------- Microsoft Teams（Workflows / Incoming Webhook 都接受 Adaptive Card 附件）

export function teamsPayload(d: ShareDigest) {
  const body: unknown[] = [{ type: 'TextBlock', text: title(d), weight: 'Bolder', size: 'Medium', wrap: true }]
  if (d.note?.trim()) body.push({ type: 'TextBlock', text: d.note.trim(), wrap: true })
  d.mails.forEach((m, i) => {
    if (d.mails.length > 1) body.push({ type: 'TextBlock', text: `${i + 1}. ${subj(m.subject)}`, weight: 'Bolder', wrap: true, spacing: 'Medium', separator: true })
    const L = labelsOf(m)
    body.push({ type: 'FactSet', facts: [...(m.from ? [{ title: L.from, value: m.from }] : []), ...(m.dateText ? [{ title: '时间', value: m.dateText }] : []), ...(m.attachments.length ? [{ title: '附件', value: m.attachments.map(a => a.name).join('、') }] : [])] })
    if (d.linkOnly) {
      if (m.appLink) body.push({ type: 'TextBlock', text: m.kind === 'link' ? `[${L.open}](${m.appLink})` : `${L.open}：${m.appLink}`, wrap: true, isSubtle: m.kind !== 'link' })
      return
    }
    if (m.gist) body.push({ type: 'TextBlock', text: `**${labelsOf(m).gist}**：${m.gist}`, wrap: true })
    if (m.excerpt) body.push({ type: 'TextBlock', text: truncateChars(m.excerpt, 2000), wrap: true, isSubtle: true })
    if (m.kind === 'link' && m.appLink) body.push({ type: 'TextBlock', text: `[${L.open}](${m.appLink})`, wrap: true })
  })
  if (d.files.length) body.push({ type: 'TextBlock', text: d.files.map(f => (f.url ? `- [${f.name}](${f.url})` : `- ${f.name}${f.where ? `：${f.where}` : ''}`)).join('\n'), wrap: true })
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body, msteams: { width: 'Full' } }
      }
    ]
  }
}

// ---------------------------------------------------------------- Discord（Embed：title ≤256、description ≤4096、field value ≤1024，最多 10 个 embed）

export function discordPayload(d: ShareDigest) {
  const embeds = d.mails.slice(0, 10).map(m => {
    const L = labelsOf(m)
    const isLink = m.kind === 'link'
    const desc = d.linkOnly
      ? isLink
        ? `[${L.open}](${m.appLink})`
        : `${L.open}：${m.appLink}${m.webLink ? `\n[网页版搜索](${m.webLink})` : ''}`
      : [m.gist ? `**${L.gist}**：${m.gist}` : '', ...(m.highlights ?? []).slice(0, 3).map(h => `- ${h}`), m.excerpt ? quote(m.excerpt) : ''].filter(Boolean).join('\n')
    return {
      title: truncateChars(subj(m.subject), 256),
      ...(isLink && /^https?:\/\//i.test(m.appLink) ? { url: m.appLink } : {}),
      description: truncateChars(desc, 4000),
      color: 0x3b82f6,
      fields: [
        ...(m.from ? [{ name: L.from, value: truncateChars(m.from, 1024), inline: true }] : []),
        ...(m.dateText ? [{ name: '时间', value: m.dateText, inline: true }] : []),
        ...(m.attachments.length ? [{ name: '附件', value: truncateChars(m.attachments.map(a => a.name).join('、'), 1024), inline: false }] : [])
      ],
      timestamp: new Date(m.date || Date.now()).toISOString(),
      footer: { text: 'LinkTo' }
    }
  })
  const files = d.files.length ? d.files.map(f => (f.url ? `[${f.name}](${f.url})` : `${f.name}${f.where ? `：${f.where}` : ''}`)).join('\n') : ''
  const content = truncateChars([d.note?.trim() ?? '', files].filter(Boolean).join('\n'), 2000)
  return { username: 'LinkTo', ...(content ? { content } : {}), embeds, allowed_mentions: { parse: [] as string[] } }
}

// ---------------------------------------------------------------- Telegram（HTML parse_mode：只需转义 & < >）

const tgEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function telegramText(d: ShareDigest, max = 4096): string {
  const out: string[] = []
  if (d.note?.trim()) out.push(tgEsc(d.note.trim()), '')
  d.mails.forEach((m, i) => {
    const L = labelsOf(m)
    const openLink = m.kind === 'link' && m.appLink ? `<a href="${tgEsc(m.appLink)}">${L.open}</a>` : ''
    out.push(`<b>${tgEsc(`${d.mails.length > 1 ? `${i + 1}. ` : ''}${subj(m.subject)}`)}</b>`, ...(m.from ? [`${L.from}：${tgEsc(m.from)}`] : []), ...(m.dateText ? [`时间：${tgEsc(m.dateText)}`] : []))
    if (d.linkOnly) out.push(...(openLink ? [openLink] : [`${L.open}：<code>${tgEsc(m.appLink)}</code>`]), ...(m.webLink ? [`<a href="${tgEsc(m.webLink)}">网页版搜索</a>`] : []))
    else {
      if (m.gist) out.push(`<b>${L.gist}</b>：${tgEsc(m.gist)}`)
      if (m.excerpt) out.push(`<blockquote>${tgEsc(m.excerpt)}</blockquote>`)
      if (m.attachments.length) out.push(`附件：${tgEsc(m.attachments.map(a => a.name).join('、'))}`)
      if (openLink) out.push(openLink)
    }
    out.push('')
  })
  for (const f of d.files) out.push(f.url ? `<a href="${tgEsc(f.url)}">${tgEsc(f.name)}</a>` : tgEsc(`${f.name}${f.where ? `：${f.where}` : ''}`))
  const s = out.join('\n').trim()
  if ([...s].length <= max) return s
  // 截断时不能留下半个标签：退回纯文本
  const plain = s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  let limit = max - 50
  let res = tgEsc(truncateChars(plain, limit))
  while ([...res].length > max && limit > 100) {
    limit -= [...res].length - max + 20
    res = tgEsc(truncateChars(plain, limit))
  }
  return res
}

export function telegramMessage(chatId: string, d: ShareDigest) {
  return { chat_id: chatId, text: telegramText(d), parse_mode: 'HTML', disable_web_page_preview: true }
}

/** sendDocument 的 caption（≤1024） */
export function telegramCaption(d: ShareDigest): string {
  const m = d.mails[0]
  const s = m ? `<b>${tgEsc(subj(m.subject))}</b>\n${tgEsc(m.from)} · ${tgEsc(m.dateText)}${d.mails.length > 1 ? `\n等 ${d.mails.length} 封` : ''}` : ''
  return [...s].length <= 1024 ? s : tgEsc(truncateChars(`${subj(m!.subject)}`, 900))
}

// ---------------------------------------------------------------- flomo（纯文本 + 标签）

export function flomoPayload(d: ShareDigest, tags?: string | null) {
  const md = digestMarkdown(d, { bold: s => s, link: (t, u) => `${t} ${u}`, quoteBody: false })
  const tagLine = String(tags ?? '')
    .split(/[\s,，]+/)
    .map(t => t.trim().replace(/^#*/, ''))
    .filter(Boolean)
    .map(t => `#${t}`)
    .join(' ')
  const content = truncateChars(md, 4800 - tagLine.length) + (tagLine ? `\n\n${tagLine}` : '')
  return { content }
}

// ---------------------------------------------------------------- Notion（rich_text 每段 ≤2000 字；一次最多 100 个块）

export interface NotionSchema {
  /** 数据库里 title 类型属性的名字 */
  titleProp: string
  /** 可选的同名属性：名字 → 类型 */
  props: Record<string, string>
}

const rt = (text: string, opts: { bold?: boolean; link?: string | null } = {}) => {
  const out: unknown[] = []
  const chars = [...text]
  for (let i = 0; i < chars.length; i += 1900) {
    out.push({ type: 'text', text: { content: chars.slice(i, i + 1900).join(''), ...(opts.link ? { link: { url: opts.link } } : {}) }, ...(opts.bold ? { annotations: { bold: true } } : {}) })
  }
  return out.length ? out : [{ type: 'text', text: { content: '' } }]
}

const para = (text: string) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(text) } })

/** 长文本按段落切成 paragraph 块（每块 ≤1900 字） */
export function notionTextBlocks(text: string): unknown[] {
  const blocks: unknown[] = []
  for (const p of String(text ?? '').replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const t = p.trim()
    if (!t) continue
    const chars = [...t]
    for (let i = 0; i < chars.length; i += 1900) blocks.push(para(chars.slice(i, i + 1900).join('')))
  }
  return blocks
}

export function notionBlocks(m: DigestMail & { body: string }, d: Pick<ShareDigest, 'files' | 'note'>): unknown[] {
  const blocks: unknown[] = []
  if (d.note?.trim()) blocks.push({ object: 'block', type: 'quote', quote: { rich_text: rt(d.note.trim()) } })
  blocks.push({
    object: 'block',
    type: 'callout',
    callout:
      m.kind === 'link'
        ? { icon: { type: 'emoji', emoji: '🔗' }, rich_text: rt([m.from ? `来源：${m.from}` : '', m.dateText ? `时间：${m.dateText}` : ''].filter(Boolean).join('\n') || '网页内容') }
        : { icon: { type: 'emoji', emoji: '✉️' }, rich_text: rt(`发件人：${m.from}\n收件人：${m.to || '—'}\n时间：${m.dateText}`) }
  })
  if (m.gist) {
    blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: rt(labelsOf(m).gist) } })
    blocks.push(para(m.gist))
    for (const h of (m.highlights ?? []).slice(0, 4)) blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(h) } })
  }
  blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: rt('正文') } })
  blocks.push(...notionTextBlocks(m.body || m.excerpt || '（无正文）'))
  if (m.attachments.length || d.files.length) {
    blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: rt('附件') } })
    for (const a of m.attachments) blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(`${a.name}（${fmtSize(a.size)}）`) } })
    for (const f of d.files) blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: f.url ? rt(f.name, { link: f.url }) : rt(`${f.name}${f.where ? `：${f.where}` : ''}`) } })
  }
  if (m.kind === 'link') {
    if (m.appLink) blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt('原文链接', { link: /^https?:\/\//i.test(m.appLink) ? m.appLink : null }) } })
  } else blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(`本机打开：${m.appLink}`) } })
  return blocks
}

/** 建页请求体：数据库 parent 时按 schema 填同名属性；页面 parent 只有 title */
export function notionPage(parent: { type: 'database' | 'page'; id: string }, m: DigestMail & { body: string }, d: Pick<ShareDigest, 'files' | 'note'>, schema?: NotionSchema | null) {
  const all = notionBlocks(m, d)
  const titleText = truncateChars(subj(m.subject), 1900)
  let properties: Record<string, unknown>
  if (parent.type === 'database') {
    properties = { [schema?.titleProp || 'Name']: { title: rt(titleText) } }
    const has = (names: string[], type: string) => names.find(n => schema?.props[n] === type)
    const fromProp = has(m.kind === 'link' ? ['来源', 'Source', '来自', '发件人', 'From'] : ['发件人', 'From', 'Sender', '来自'], 'rich_text')
    if (fromProp) properties[fromProp] = { rich_text: rt(m.from) }
    const dateProp = has(['日期', 'Date', '时间', 'Received'], 'date')
    if (dateProp) properties[dateProp] = { date: { start: new Date(m.date || Date.now()).toISOString() } }
    const linkProp = has(['链接', 'Link', 'URL', 'Url'], 'url')
    if (linkProp && (m.webLink || /^https?:/i.test(m.appLink) || m.kind !== 'link')) properties[linkProp] = { url: m.webLink || m.appLink }
  } else {
    properties = { title: { title: rt(titleText) } }
  }
  const id = parent.id.replace(/-/g, '')
  return {
    body: { parent: parent.type === 'database' ? { database_id: id } : { page_id: id }, properties, children: all.slice(0, 100) },
    /** 超过 100 块的部分，建页后分批 append */
    rest: chunk(all.slice(100), 100)
  }
}

export function chunk<T>(list: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}

/** 从 Notion 数据库对象提取 schema */
export function notionSchemaOf(db: { properties?: Record<string, { type?: string }> } | null | undefined): NotionSchema {
  const props: Record<string, string> = {}
  let titleProp = 'Name'
  for (const [k, v] of Object.entries(db?.properties ?? {})) {
    props[k] = v?.type ?? ''
    if (v?.type === 'title') titleProp = k
  }
  return { titleProp, props }
}

/** 平台 Webhook 回包检查：返回中文错误或 null */
export function checkWebhookResponse(kind: string, status: number, body: string): string | null {
  if (status === 429) return '发送太频繁，被平台限流了，稍后再试'
  if (status === 401 || status === 403) return '鉴权失败：Webhook 地址、令牌或签名不对'
  if (status === 404) return 'Webhook 地址不存在（机器人可能已被删除）'
  if (status >= 500) return `平台服务出错（HTTP ${status}），稍后再试`
  if (status >= 400) return `平台拒绝了请求（HTTP ${status}）${body ? `：${truncateChars(body, 160)}` : ''}`
  let j: any = null
  try {
    j = body ? JSON.parse(body) : null
  } catch {
    /* 非 JSON（Slack 回 ok） */
  }
  if (kind === 'wecom' || kind === 'dingtalk') {
    if (j && typeof j.errcode === 'number' && j.errcode !== 0) {
      if (kind === 'dingtalk' && (j.errcode === 310000 || /sign|keyword|关键词/i.test(String(j.errmsg)))) return `钉钉校验未通过：${j.errmsg}（检查加签密钥，或在安全设置里把「邮件」设为关键词）`
      return `${kind === 'wecom' ? '企业微信' : '钉钉'}返回错误 ${j.errcode}：${j.errmsg ?? ''}`
    }
  }
  if (kind === 'feishu') {
    const code = j?.code ?? j?.StatusCode
    if (typeof code === 'number' && code !== 0) return code === 19021 ? '飞书签名校验失败：检查签名密钥，以及本机时间是否准确' : `飞书返回错误 ${code}：${j?.msg ?? j?.StatusMessage ?? ''}`
  }
  if (kind === 'slack' && body && body.trim() !== 'ok' && status !== 200) return `Slack 返回：${truncateChars(body, 120)}`
  if (kind === 'flomo' && j && typeof j.code === 'number' && j.code !== 0) return `flomo 返回错误：${j.message ?? j.code}`
  return null
}

/** Readwise Reader 存档请求体：带链接的直接收藏（article），正文类转 HTML 文档（email） */
export function readwiseBody(d: { url?: string | null; title: string; html?: string | null; summary?: string | null; author?: string | null }) {
  return {
    ...(d.url ? { url: d.url } : {}),
    title: d.title || '（无主题）',
    ...(d.author ? { author: d.author } : {}),
    ...(d.html ? { html: d.html, should_clean_html: true } : {}),
    ...(d.summary ? { summary: d.summary } : {}),
    category: d.url ? 'article' : 'email',
    saved_using: 'LinkTo'
  }
}
