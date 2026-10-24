import { app, BrowserWindow, clipboard, ClipboardItem, dialog, shell, ShareMenu } from 'electron'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Address, MessageFull, MailInsight } from '@shared/types'
import {
  appLinkFor,
  CONTENT_FORMATS,
  DEFAULT_SHARE_SETTINGS,
  dedupeName,
  FILE_FORMATS,
  formatExt,
  formatLabel,
  kindMeta,
  parseAppLink,
  renderNameTemplate,
  safeFileName,
  SHARE_KINDS,
  webLinksFor,
  type ShareContent,
  type ShareFormat,
  type ShareLinks,
  type SharePreview,
  type ShareRequest,
  type ShareResult,
  type ShareSettings,
  type ShareTarget,
  type ShareTargetInfo,
  type ShareTargetInput
} from '@shared/share'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import { DEFAULT_GENERAL } from '../store'
import type { SyncEngine } from '../mail/sync-engine'
import { driveUpload, driveWebUrl, listDrives, uploadAttachment } from '../cloud-drive'
import { attachmentService } from '../attachments'
import { logActivity } from '../agent/hooks'
import { escapeHtml, excerpt, htmlToMarkdown, htmlToPlain, sanitizeHtml } from './html'
import {
  checkWebhookResponse,
  dingtalkPayload,
  dingtalkUrl,
  digestMarkdown,
  discordPayload,
  feishuPayload,
  flomoPayload,
  notionPage,
  notionSchemaOf,
  readwiseBody,
  slackPayload,
  teamsPayload,
  telegramCaption,
  telegramMessage,
  wecomPayload,
  type DigestMail,
  type NotionSchema,
  type ShareDigest
} from './payloads'
import { buildPrintHtml, type PrintMail } from './print-html'
import { renderPdf, renderPng } from './render'
import { buildNotesJxa, notesErrorText } from './jxa'
import { httpRequest, postJson, ShareHttpError } from './http'
import { feedService } from '../feeds'

/**
 * 导出与分享中心：把邮件导出为 EML / PDF / Markdown / 长图 / 文本，发到 IM / 工作 IM / 笔记 / 本地 / 网盘 / 系统分享。
 * - 分享目标存 AppStore KV（share-targets），Webhook 地址 / 签名密钥 / Token 走 appStore.saveSecret（share:<id>）
 * - 所有对外发送都要求 req.confirmed（界面确认 / Agent 确认卡）
 */

export interface ShareDeps {
  store: MailStore
  appStore: AppStore
  engine: () => SyncEngine
  /** 复用 ipc.ts 已注册的处理器（getMessage 会按需拉正文） */
  call(method: string, args: unknown[]): Promise<unknown>
  event(payload: unknown): void
  mainWindow(): BrowserWindow | null
  /** 打开主窗口并定位到某封邮件 */
  openMessage(id: string): void
}

const KV_TARGETS = 'share-targets'
const KV_SETTINGS = 'share-settings'
const SECRET = (id: string) => `share:${id}`
const MAX_MAILS = 50
const MAX_IM_MESSAGES = 20
const TELEGRAM_MAX = 50 * 1024 * 1024

interface Secrets {
  url?: string
  secret?: string
  token?: string
}

interface Loaded {
  full: MessageFull
  insight: MailInsight | null
  accountName: string
  provider: string
  /** 通用内容（订阅文章 / 网页）：full 是按它拼出的占位邮件，展示时按 content 的字段来 */
  content?: ShareContent
}

interface GenFile {
  name: string
  data: Buffer
  /** Markdown 的附件目录：文件名 → 本地路径 */
  assets?: { name: string; path: string }[]
  /** 长图被截断 */
  truncated?: boolean
}

const fmtAddr = (a: Address | null | undefined) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '')
const fmtAddrs = (l: Address[] | null | undefined) => (l ?? []).map(fmtAddr).filter(Boolean).join('，')
const pad = (n: number) => String(n).padStart(2, '0')
const fmtDate = (t: number) => {
  const d = new Date(t || Date.now())
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const isoLocal = (t: number) => {
  const d = new Date(t || Date.now())
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
}
const subj = (s: string | null | undefined) => (s || '').trim() || '（无主题）'
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const textToHtml = (t: string) =>
  String(t ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')

const BUILTINS: ShareTargetInfo[] = [
  { id: 'sys:export', name: '导出到本地', group: 'local', kind: 'builtin', formats: ['pdf', 'png', 'eml', 'md', 'text', 'rich'], external: false, hint: '默认导出目录或保存对话框' },
  { id: 'sys:clipboard', name: '复制到剪贴板', group: 'system', kind: 'builtin', formats: ['text', 'rich', 'link', 'png'], external: false, hint: '文本 / 富文本 / 链接 / 长图' },
  { id: 'sys:share', name: '系统分享…', group: 'system', kind: 'builtin', formats: ['text', 'link', 'pdf', 'png', 'eml', 'md'], external: false, hint: '信息、隔空投送，以及系统里已安装的 App（微信、QQ、LINE…）' },
  { id: 'sys:wechat', name: '微信', group: 'im', kind: 'builtin', formats: ['png', 'rich', 'text', 'link'], external: true, hint: '复制后打开微信，在聊天里粘贴发送' },
  { id: 'sys:whatsapp', name: 'WhatsApp', group: 'im', kind: 'builtin', formats: ['text', 'link'], external: true, hint: '打开 WhatsApp 并带上文字，选择联系人后发送' },
  { id: 'sys:telegram-link', name: 'Telegram（打开应用）', group: 'im', kind: 'builtin', formats: ['text', 'link'], external: true, hint: '打开 Telegram 并带上文字' }
]

export class ShareService {
  /** 测试用：系统分享菜单弹出后自动关闭（毫秒，0 = 不关） */
  private menuAutoClose = Number(process.env.LINKTO_SHARE_MENU_AUTOCLOSE_MS || 0)

  constructor(private deps: ShareDeps) {}

  // ================================================================ 设置与目标

  settings(): ShareSettings {
    const s = this.deps.appStore.get<ShareSettings>(KV_SETTINGS, DEFAULT_SHARE_SETTINGS)
    return { ...DEFAULT_SHARE_SETTINGS, ...s, recent: Array.isArray(s.recent) ? s.recent : [] }
  }

  setSettings(patch: Partial<ShareSettings>): ShareSettings {
    const cur = this.settings()
    const next: ShareSettings = { ...cur, ...(patch ?? {}) }
    next.imageWidth = Math.max(360, Math.min(1440, Math.round(Number(next.imageWidth) || 750)))
    next.excerptChars = Math.max(100, Math.min(3000, Math.round(Number(next.excerptChars) || 600)))
    next.nameTemplate = String(next.nameTemplate || DEFAULT_SHARE_SETTINGS.nameTemplate).slice(0, 120)
    next.recent = (next.recent ?? []).filter(x => typeof x === 'string').slice(0, 8)
    this.deps.appStore.set(KV_SETTINGS, next)
    return next
  }

  private rawTargets(): ShareTarget[] {
    const l = this.deps.appStore.getRaw<ShareTarget[]>(KV_TARGETS, [])
    return Array.isArray(l) ? l : []
  }

  private secrets(id: string): Secrets {
    try {
      return JSON.parse(this.deps.appStore.loadSecret(SECRET(id)) || '{}') as Secrets
    } catch {
      return {}
    }
  }

  private maskUrl(u?: string): string {
    if (!u) return ''
    try {
      const x = new URL(u)
      return `${x.host}${x.pathname.length > 12 ? x.pathname.slice(0, 12) + '…' : x.pathname}`
    } catch {
      return u.slice(0, 16) + '…'
    }
  }

  targets(): ShareTargetInfo[] {
    const stored = this.rawTargets().map(t => {
      const meta = kindMeta(t.kind)
      const s = this.secrets(t.id)
      const hint =
        t.kind === 'telegram'
          ? `Chat ${t.chatId ?? ''}`
          : t.kind === 'notion'
            ? `${t.parentType === 'page' ? '页面' : '数据库'} ${String(t.parentId ?? '').slice(0, 8)}…`
            : t.kind === 'apple-notes'
              ? t.notesFolder || '默认文件夹'
              : t.kind === 'md-folder' || t.kind === 'local-folder'
                ? t.folder ?? ''
                : this.maskUrl(s.url)
      return {
        id: t.id,
        name: t.name || meta.label,
        group: meta.group,
        kind: t.kind,
        formats: meta.formats,
        external: !['apple-notes', 'md-folder', 'local-folder'].includes(t.kind),
        hint,
        secrets: { url: !!s.url, secret: !!s.secret, token: !!s.token },
        config: t
      } satisfies ShareTargetInfo
    })
    const drives = listDrives(this.deps.appStore).map(
      d =>
        ({
          id: `drive:${d.id}`,
          name: d.name,
          group: 'drive',
          kind: 'drive',
          formats: ['pdf', 'png', 'eml', 'md'],
          external: false,
          hint: d.kind === 'local' ? d.localPath ?? '' : d.kind === 'dropbox' ? 'Dropbox' : 'WebDAV'
        }) satisfies ShareTargetInfo
    )
    return [...stored, ...drives, ...BUILTINS]
  }

  saveTarget(input: ShareTargetInput): { ok: boolean; error?: string; id?: string } {
    if (!input || !SHARE_KINDS.some(k => k.kind === input.kind)) return { ok: false, error: '未知的目标类型' }
    const meta = kindMeta(input.kind)
    const list = this.rawTargets()
    const id = input.id && list.some(t => t.id === input.id) ? input.id : randomUUID()
    const old = this.secrets(id)
    // 密钥字段留空 = 保持原值；签名密钥传 '-' 表示清除
    const sec: Secrets = {
      url: input.url?.trim() || old.url,
      secret: input.secret === '-' ? undefined : input.secret?.trim() || old.secret,
      token: input.token?.trim() || old.token
    }
    const need = (k: string) => meta.fields.some(f => f.key === k && !f.optional)
    if (need('url') && !sec.url) return { ok: false, error: '请填写 Webhook / API 地址' }
    if (sec.url && !/^https?:\/\//i.test(sec.url)) return { ok: false, error: '地址需以 http:// 或 https:// 开头' }
    if (need('token') && !sec.token) return { ok: false, error: input.kind === 'telegram' ? '请填写 Bot Token' : '请填写 Integration Token' }
    if (input.kind === 'telegram' && !String(input.chatId ?? '').trim()) return { ok: false, error: '请填写 Chat ID' }
    if (input.kind === 'notion' && !/[0-9a-f]{32}/i.test(String(input.parentId ?? '').replace(/-/g, ''))) return { ok: false, error: '数据库 / 页面 ID 应是链接里 32 位的那串' }
    if ((input.kind === 'md-folder' || input.kind === 'local-folder') && !this.isDir(input.folder)) return { ok: false, error: '请选择一个存在的文件夹' }
    if (input.apiBase && !/^https?:\/\//i.test(input.apiBase.trim())) return { ok: false, error: 'API 地址需以 http(s):// 开头' }
    const cfg: ShareTarget = {
      id,
      kind: input.kind,
      name: (input.name || meta.label).trim().slice(0, 40),
      chatId: input.chatId?.trim() || undefined,
      parentType: input.kind === 'notion' ? (input.parentType === 'page' ? 'page' : 'database') : undefined,
      parentId: input.kind === 'notion' ? (String(input.parentId ?? '').replace(/-/g, '').match(/[0-9a-f]{32}/i)?.[0] ?? '') : undefined,
      folder: input.folder?.trim() || undefined,
      pathTemplate: input.pathTemplate?.trim() || undefined,
      driveId: input.driveId || null,
      tags: input.tags?.trim() || undefined,
      notesFolder: input.notesFolder?.trim() || undefined,
      apiBase: input.apiBase?.trim().replace(/\/+$/, '') || undefined,
      createdAt: list.find(t => t.id === id)?.createdAt ?? Date.now()
    }
    const i = list.findIndex(t => t.id === id)
    if (i >= 0) list[i] = cfg
    else list.push(cfg)
    this.deps.appStore.set(KV_TARGETS, list)
    this.deps.appStore.saveSecret(SECRET(id), sec.url || sec.secret || sec.token ? JSON.stringify(sec) : '')
    this.deps.event({ type: 'share-targets-changed' })
    return { ok: true, id }
  }

  removeTarget(id: string): void {
    this.deps.appStore.set(
      KV_TARGETS,
      this.rawTargets().filter(t => t.id !== id)
    )
    this.deps.appStore.deleteSecret(SECRET(id))
    const s = this.settings()
    if (s.recent.includes(id)) this.setSettings({ recent: s.recent.filter(x => x !== id) })
    this.deps.event({ type: 'share-targets-changed' })
  }

  private isDir(p?: string | null): boolean {
    try {
      return !!p && statSync(p).isDirectory()
    } catch {
      return false
    }
  }

  private target(id: string): ShareTargetInfo | null {
    return this.targets().find(t => t.id === id) ?? null
  }

  // ================================================================ 邮件数据

  private async load(ids: string[]): Promise<Loaded[]> {
    const list = [...new Set((ids ?? []).filter(Boolean))].slice(0, MAX_MAILS)
    if (!list.length) throw new Error('没有选中邮件')
    const accounts = this.deps.store.listAccounts()
    const ais = (() => {
      try {
        return this.deps.store.getMailAi(list)
      } catch {
        return {} as Record<string, MailInsight>
      }
    })()
    const out: Loaded[] = []
    for (const id of list) {
      let full = this.deps.store.getMessageFull(id)
      if (full && !full.html && !full.text) full = ((await this.deps.call('getMessage', [id]).catch(() => null)) as MessageFull | null) ?? full
      if (!full) continue
      const acc = accounts.find(a => a.id === full!.accountId)
      out.push({ full, insight: ais[id] ?? null, accountName: acc?.name ?? '', provider: acc?.provider ?? '' })
    }
    if (!out.length) throw new Error('邮件不存在（可能已被删除）')
    return out
  }

  /** 请求 → 要处理的条目：通用内容优先，否则按邮件 id 取 */
  private async loadReq(req: Pick<ShareRequest, 'messageIds' | 'content'>): Promise<Loaded[]> {
    if (req.content) return [this.loadContent(req.content)]
    return this.load(req.messageIds)
  }

  /** 通用内容 → 占位邮件（主题 = 标题、正文 = 全文 / 订阅正文 / 摘要），复用邮件的各种生成逻辑 */
  private loadContent(c: ShareContent): Loaded {
    let title = String(c?.title ?? '').trim().slice(0, 300)
    let url = String(c?.url ?? '').trim()
    if (url && !/^https?:\/\//i.test(url)) url = ''
    let html = typeof c?.html === 'string' ? c.html : ''
    let text = String(c?.text ?? '').trim()
    let source = String(c?.source ?? '').trim().slice(0, 120)
    let date = Number(c?.date) || 0
    if (c?.feedItemId) {
      const it = feedService()?.item(String(c.feedItemId)) ?? null
      if (it) {
        html = it.fullHtml || it.contentHtml || html
        if (!text) text = it.aiSummary || it.summary || ''
        if (!url && it.url) url = it.url
        if (!source) source = it.sourceTitle
        if (!title) title = it.title
        if (!date) date = it.publishedAt ?? it.sortAt ?? 0
      }
    }
    if (!title && !url && !html && !text) throw new Error('没有可分享的内容')
    const content: ShareContent = { kind: 'link', title: title || url || '（无标题）', url: url || null, text: text || null, html: html || null, source: source || null, date: date || null, feedItemId: c?.feedItemId ?? null }
    const full = {
      id: `content:${c?.feedItemId ?? ''}`,
      accountId: '',
      folderPath: '',
      uid: 0,
      messageId: null,
      subject: content.title,
      from: source ? { name: source, address: '' } : null,
      to: [],
      cc: [],
      date: date || Date.now(),
      html: html || null,
      text: html ? null : text || null,
      snippet: text,
      attachments: []
    } as unknown as MessageFull
    // 摘要当作「要点」：IM / 笔记里显示在正文摘录之前（正文就是摘要时不重复）
    const insight = html && text ? ({ gist: excerpt(text, 300), highlights: [] } as unknown as MailInsight) : null
    return { full, insight, accountName: '', provider: '', content }
  }

  /** 发件人行（通用内容是来源） */
  private fromText(m: Loaded): string {
    return m.content ? m.content.source ?? '' : fmtAddr(m.full.from)
  }

  private allowRemote(): boolean {
    const s = this.settings().remoteImages
    if (s === 'allow') return true
    if (s === 'block') return false
    return this.deps.appStore.get('general', DEFAULT_GENERAL).remoteImages === 'allow'
  }

  private nameOf(m: Loaded, ext: string): string {
    return `${renderNameTemplate(this.settings().nameTemplate, { subject: m.full.subject, from: m.full.from?.name ?? '', fromAddr: m.full.from?.address ?? '', date: m.full.date, account: m.accountName })}.${ext}`
  }

  private mergedName(list: Loaded[], ext: string): string {
    const d = new Date()
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${list.length}封邮件.${ext}`
  }

  private plain(m: Loaded): string {
    return (m.full.text?.trim() || (m.full.html ? htmlToPlain(m.full.html) : '') || m.full.snippet || '').trim()
  }

  links(m: Loaded | MessageFull): ShareLinks {
    if ('full' in m && m.content) return { app: m.content.url ?? '', gmail: null, outlook: null, outlookQuery: null }
    const full = 'full' in m ? m.full : m
    const provider = 'full' in m ? m.provider : ''
    const web = webLinksFor(full.messageId, full.subject, provider)
    return {
      app: appLinkFor(full.messageId, full.id),
      gmail: provider === 'outlook' || provider === 'office365' ? null : web.gmail,
      outlook: provider === 'gmail' ? null : web.outlook,
      outlookQuery: provider === 'gmail' ? null : web.outlookQuery
    }
  }

  async linksFor(id: string): Promise<ShareLinks | null> {
    const full = this.deps.store.getMessageFull(id)
    if (!full) return null
    const acc = this.deps.store.listAccounts().find(a => a.id === full.accountId)
    const web = webLinksFor(full.messageId, full.subject, acc?.provider)
    return {
      app: appLinkFor(full.messageId, full.id),
      gmail: acc?.provider === 'outlook' || acc?.provider === 'office365' ? null : web.gmail,
      outlook: acc?.provider === 'gmail' ? null : web.outlook,
      outlookQuery: acc?.provider === 'gmail' ? null : web.outlookQuery
    }
  }

  private realAttachments(m: Loaded) {
    return m.full.attachments.filter(a => !a.inline)
  }

  /** 内嵌图（cid:）→ data: URI（只取已在本地的，单张 ≤ 5 MB） */
  private cidResolver(m: Loaded): (src: string) => string | null {
    const map = new Map<string, { id: string; ct: string }>()
    for (const a of m.full.attachments) if (a.contentId) map.set(a.contentId.replace(/[<>]/g, '').toLowerCase(), { id: a.id, ct: a.contentType })
    return (src: string) => {
      const hit = map.get(src.slice(4).replace(/[<>]/g, '').toLowerCase())
      if (!hit || !/^image\//i.test(hit.ct)) return null
      const p = this.deps.store.getAttachment(hit.id)?.path ?? this.deps.appStore.attachmentPath(hit.id)
      try {
        if (!p || !existsSync(p) || statSync(p).size > 5 * 1048576) return null
        return `data:${hit.ct};base64,${readFileSync(p).toString('base64')}`
      } catch {
        return null
      }
    }
  }

  private safeBodyHtml(m: Loaded, allowRemote: boolean, keepStyle = false): string {
    const src = m.full.html ?? (m.full.text ? textToHtml(m.full.text) : '<p>（此邮件没有正文内容）</p>')
    return sanitizeHtml(src, { allowRemote, resolveImg: this.cidResolver(m), keepStyle })
  }

  private digestMail(m: Loaded): DigestMail {
    const links = this.links(m)
    if (m.content) {
      return {
        kind: 'link',
        subject: m.full.subject,
        from: m.content.source ?? '',
        to: '',
        date: m.full.date,
        dateText: m.content.date ? fmtDate(m.content.date) : '',
        gist: m.insight?.gist || null,
        highlights: [],
        excerpt: excerpt(this.plain(m), this.settings().excerptChars),
        attachments: [],
        appLink: links.app,
        webLink: null
      }
    }
    return {
      subject: m.full.subject,
      from: fmtAddr(m.full.from) || '（未知发件人）',
      to: fmtAddrs(m.full.to),
      date: m.full.date,
      dateText: fmtDate(m.full.date),
      gist: m.insight?.gist || null,
      highlights: m.insight?.highlights ?? [],
      excerpt: excerpt(this.plain(m), this.settings().excerptChars),
      attachments: this.realAttachments(m).map(a => ({ name: a.filename, size: a.size })),
      appLink: links.app,
      webLink: links.gmail ?? links.outlook
    }
  }

  private digest(list: Loaded[], req: Pick<ShareRequest, 'note' | 'format'>, files: ShareDigest['files'] = []): ShareDigest {
    return { mails: list.map(m => this.digestMail(m)), note: req.note?.trim() || undefined, files, linkOnly: req.format === 'link' }
  }

  // ================================================================ 生成内容

  textOf(list: Loaded[]): string {
    return list
      .map(m => {
        const l = this.links(m)
        if (m.content) {
          const c = m.content
          return [subj(m.full.subject), ...(c.source ? [`来源：${c.source}`] : []), ...(c.date ? [`时间：${fmtDate(c.date)}`] : []), ...(c.url ? [`链接：${c.url}`] : []), '', ...(m.insight?.gist ? [`摘要：${m.insight.gist}`, ''] : []), this.plain(m)].join('\n').trim()
        }
        return [
          subj(m.full.subject),
          `发件人：${fmtAddr(m.full.from)}`,
          `收件人：${fmtAddrs(m.full.to) || '—'}`,
          ...(m.full.cc.length ? [`抄送：${fmtAddrs(m.full.cc)}`] : []),
          `时间：${fmtDate(m.full.date)}`,
          ...(this.realAttachments(m).length ? [`附件：${this.realAttachments(m).map(a => a.filename).join('、')}`] : []),
          `链接：${l.app}`,
          '',
          this.plain(m)
        ].join('\n')
      })
      .join('\n\n────────\n\n')
  }

  private linkText(list: Loaded[]): string {
    return list
      .map(m => {
        const l = this.links(m)
        if (m.content) return [`${subj(m.full.subject)}${m.content.source ? `（${m.content.source}）` : ''}`, ...(l.app ? [l.app] : [])].join('\n')
        return [
          `${subj(m.full.subject)}（${fmtAddr(m.full.from)} · ${fmtDate(m.full.date)}）`,
          `本机打开：${l.app}`,
          ...(l.gmail ? [`Gmail 网页版：${l.gmail}`] : []),
          ...(l.outlook ? [`Outlook 网页版：${l.outlook}${l.outlookQuery ? `（打开后在搜索框粘贴：${l.outlookQuery}）` : ''}`] : [])
        ].join('\n')
      })
      .join('\n\n')
  }

  private linkHtml(list: Loaded[]): string {
    return list
      .map(m => {
        const l = this.links(m)
        const a = (u: string, t: string) => `<a href="${escapeHtml(u)}">${escapeHtml(t)}</a>`
        if (m.content) return `<p>${l.app ? a(l.app, subj(m.full.subject)) : `<b>${escapeHtml(subj(m.full.subject))}</b>`}${m.content.source ? `（${escapeHtml(m.content.source)}）` : ''}</p>`
        return `<p><b>${escapeHtml(subj(m.full.subject))}</b>（${escapeHtml(fmtAddr(m.full.from))} · ${fmtDate(m.full.date)}）<br>${a(l.app, '在 LinkTo 中打开')}${l.gmail ? ` · ${a(l.gmail, 'Gmail 网页版')}` : ''}${l.outlook ? ` · ${a(l.outlook, 'Outlook 网页版')}${l.outlookQuery ? `（搜索：${escapeHtml(l.outlookQuery)}）` : ''}` : ''}</p>`
      })
      .join('')
  }

  /** 富文本：头部信息表 + 消毒后的正文 */
  richHtml(list: Loaded[], allowRemote = this.allowRemote()): string {
    return list
      .map(m => {
        const row = (k: string, v: string) => `<tr><td style="color:#86909c;padding:1px 12px 1px 0;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:1px 0">${escapeHtml(v)}</td></tr>`
        if (m.content) {
          const c = m.content
          const link = c.url ? `<tr><td style="color:#86909c;padding:1px 12px 1px 0;white-space:nowrap;vertical-align:top">链接</td><td style="padding:1px 0"><a href="${escapeHtml(c.url)}">${escapeHtml(c.url)}</a></td></tr>` : ''
          return `<div><h2 style="margin:0 0 8px">${escapeHtml(subj(m.full.subject))}</h2><table style="border-collapse:collapse;font-size:13px;margin-bottom:12px">${c.source ? row('来源', c.source) : ''}${c.date ? row('时间', fmtDate(c.date)) : ''}${link}</table>${m.insight?.gist ? `<p><b>摘要</b>：${escapeHtml(m.insight.gist)}</p>` : ''}<div>${this.safeBodyHtml(m, allowRemote)}</div></div>`
        }
        return `<div><h2 style="margin:0 0 8px">${escapeHtml(subj(m.full.subject))}</h2><table style="border-collapse:collapse;font-size:13px;margin-bottom:12px">${row('发件人', fmtAddr(m.full.from))}${row('收件人', fmtAddrs(m.full.to) || '—')}${m.full.cc.length ? row('抄送', fmtAddrs(m.full.cc)) : ''}${row('时间', fmtDate(m.full.date))}${this.realAttachments(m).length ? row('附件', this.realAttachments(m).map(a => a.filename).join('、')) : ''}</table><div>${this.safeBodyHtml(m, allowRemote)}</div></div>`
      })
      .join('<hr>')
  }

  private printMails(list: Loaded[], allowRemote: boolean): PrintMail[] {
    return list.map(m => ({
      ...(m.content
        ? { meta: [...(m.content.source ? [{ label: '来源', value: m.content.source }] : []), ...(m.content.date ? [{ label: '时间', value: fmtDate(m.content.date) }] : []), ...(m.content.url ? [{ label: '链接', value: m.content.url }] : []), ...(m.insight?.gist ? [{ label: '摘要', value: m.insight.gist }] : [])] }
        : {}),
      subject: subj(m.full.subject),
      from: fmtAddr(m.full.from),
      to: fmtAddrs(m.full.to),
      cc: fmtAddrs(m.full.cc),
      dateText: fmtDate(m.full.date),
      html: this.safeBodyHtml(m, allowRemote, true),
      attachments: this.realAttachments(m).map(a => ({ name: a.filename, size: a.size })),
      gist: m.content ? null : m.insight?.gist || null
    }))
  }

  private async pdfOf(list: Loaded[]): Promise<Buffer> {
    const allow = this.allowRemote()
    const html = buildPrintHtml(this.printMails(list, allow), { allowRemote: allow, attachmentList: this.settings().pdfAttachmentList, mode: 'pdf' })
    return renderPdf(html, allow, `LinkTo · ${fmtDate(Date.now())}`)
  }

  private async pngOf(list: Loaded[]): Promise<{ png: Buffer; truncated: boolean }> {
    const allow = this.allowRemote()
    const s = this.settings()
    const html = buildPrintHtml(this.printMails(list, allow), { allowRemote: allow, attachmentList: s.pdfAttachmentList, mode: 'png', width: s.imageWidth, footer: `LinkTo · ${fmtDate(Date.now())}` })
    const r = await renderPng(html, s.imageWidth, allow)
    return { png: r.png, truncated: r.truncated }
  }

  /** 原文：本地镜像优先，没有就从 IMAP 取（并补存镜像） */
  async emlOf(m: Loaded): Promise<Buffer> {
    const p = this.deps.appStore.emlPath(m.full.accountId, m.full.folderPath, m.full.uid)
    if (existsSync(p)) {
      const b = readFileSync(p)
      if (b.length) return b
    }
    const worker = this.deps.engine()?.getWorker(m.full.accountId)
    if (!worker) throw new Error('本地没有原文镜像，且该账户未连接，无法从服务器取原文')
    let raw: Buffer | null = null
    try {
      raw = await worker.downloadFromFolder(m.full.folderPath, m.full.uid)
    } catch (err) {
      throw new Error(`从服务器取原文失败：${errText(err)}`)
    }
    if (!raw?.length) throw new Error('服务器上找不到这封邮件的原文（可能已被移动或删除）')
    try {
      writeFileSync(p, raw)
    } catch {
      /* 镜像写失败不影响导出 */
    }
    return raw
  }

  /** 附件本地路径（必要时从镜像 / 服务器 / 网盘取回） */
  private async attachmentPath(id: string): Promise<string | null> {
    const p = this.deps.store.getAttachment(id)?.path ?? this.deps.appStore.attachmentPath(id)
    if (p && existsSync(p)) return p
    const r = await attachmentService()?.ensureLocal(id).catch(() => null)
    return r?.ok && r.path && existsSync(r.path) ? r.path : null
  }

  markdownOf(m: Loaded, assetDir?: string | null, assets: { name: string }[] = []): string {
    const l = this.links(m)
    const y = (v: string) => JSON.stringify(v)
    if (m.content) {
      const c = m.content
      const fm = ['---', `title: ${y(subj(m.full.subject))}`, ...(c.source ? [`source: ${y(c.source)}`] : []), ...(c.url ? [`url: ${y(c.url)}`] : []), ...(c.date ? [`date: ${isoLocal(c.date)}`] : []), `saved: ${isoLocal(Date.now())}`, 'tags: [feed]', '---'].join('\n')
      const body = m.full.html ? htmlToMarkdown(m.full.html) : this.plain(m)
      const parts = [fm, '', `# ${subj(m.full.subject)}`, '']
      if (m.insight?.gist) parts.push(`> **摘要**：${m.insight.gist}`, '')
      parts.push(body || '（无正文）')
      if (c.url) parts.push('', `[原文链接](<${c.url}>)`)
      return parts.join('\n').replace(/\n{3,}/g, '\n\n') + '\n'
    }
    const atts = this.realAttachments(m)
    const fm = [
      '---',
      `title: ${y(subj(m.full.subject))}`,
      `from: ${y(fmtAddr(m.full.from))}`,
      `to: [${m.full.to.map(a => y(fmtAddr(a))).join(', ')}]`,
      ...(m.full.cc.length ? [`cc: [${m.full.cc.map(a => y(fmtAddr(a))).join(', ')}]`] : []),
      `date: ${isoLocal(m.full.date)}`,
      ...(m.full.messageId ? [`message_id: ${y(m.full.messageId)}`] : []),
      `link: ${y(l.app)}`,
      ...(l.gmail ? [`web: ${y(l.gmail)}`] : l.outlook ? [`web: ${y(l.outlook)}`] : []),
      ...(atts.length ? [`attachments: [${atts.map(a => y(a.filename)).join(', ')}]`] : []),
      'tags: [email]',
      '---'
    ].join('\n')
    const body = m.full.html ? htmlToMarkdown(m.full.html) : this.plain(m)
    const parts = [fm, '', `# ${subj(m.full.subject)}`, '']
    if (m.insight?.gist) parts.push(`> **AI 要点**：${m.insight.gist}`, '')
    parts.push(body || '（无正文）')
    if (atts.length) {
      parts.push('', '## 附件', '')
      for (const a of atts) {
        const saved = assetDir ? assets.find(x => x.name === safeFileName(a.filename, 120)) : null
        parts.push(saved ? `- [${a.filename.replace(/[[\]]/g, '')}](<./${assetDir}/${saved.name}>)` : `- ${a.filename}`)
      }
    }
    return parts.join('\n').replace(/\n{3,}/g, '\n\n') + '\n'
  }

  /** 生成文件（多封：PDF / 长图 / 文本按 merge 合并；EML / Markdown 每封一个） */
  async generate(list: Loaded[], format: ShareFormat, opts: { merge?: boolean; includeAttachments?: boolean } = {}): Promise<GenFile[]> {
    const merge = opts.merge ?? (format === 'pdf' ? this.settings().pdfMerge : true)
    const ext = formatExt(format)
    const groups = merge && list.length > 1 && !['eml', 'md'].includes(format) ? [list] : list.map(m => [m])
    const out: GenFile[] = []
    for (const g of groups) {
      const name = g.length > 1 ? this.mergedName(g, ext) : this.nameOf(g[0], ext)
      if (format === 'pdf') out.push({ name, data: await this.pdfOf(g) })
      else if (format === 'png') {
        const r = await this.pngOf(g)
        out.push({ name, data: r.png, truncated: r.truncated })
      } else if (format === 'eml') out.push({ name, data: await this.emlOf(g[0]) })
      else if (format === 'md') {
        const m = g[0]
        const assets: { name: string; path: string }[] = []
        const dirName = name.replace(/\.md$/, '')
        if (opts.includeAttachments) {
          for (const a of this.realAttachments(m)) {
            const p = await this.attachmentPath(a.id)
            if (p) assets.push({ name: dedupeName(safeFileName(a.filename, 120), n => assets.some(x => x.name === n)), path: p })
          }
        }
        out.push({ name, data: Buffer.from(this.markdownOf(m, assets.length ? dirName : null, assets), 'utf8'), assets })
      } else if (format === 'rich') out.push({ name, data: Buffer.from(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(subj(g[0].full.subject))}</title>${this.richHtml(g)}`, 'utf8') })
      else if (format === 'link') out.push({ name, data: Buffer.from(this.linkText(g), 'utf8') })
      else out.push({ name, data: Buffer.from(this.textOf(g), 'utf8') })
    }
    return out
  }

  /** 写到目录：重名自动加序号；Markdown 附件放同名文件夹 */
  private writeFiles(dir: string, files: GenFile[]): string[] {
    mkdirSync(dir, { recursive: true })
    const paths: string[] = []
    for (const f of files) {
      const name = dedupeName(f.name, n => existsSync(join(dir, n)))
      const target = join(dir, name)
      let data = f.data
      if (f.assets?.length) {
        const oldDir = f.name.replace(/\.md$/, '')
        const newDir = name.replace(/\.md$/, '')
        const assetDir = join(dir, newDir)
        mkdirSync(assetDir, { recursive: true })
        for (const a of f.assets) copyFileSync(a.path, join(assetDir, a.name))
        if (oldDir !== newDir) data = Buffer.from(data.toString('utf8').split(`](<./${oldDir}/`).join(`](<./${newDir}/`), 'utf8')
      }
      writeFileSync(target, data)
      paths.push(target)
    }
    return paths
  }

  private defaultExportDir(): string {
    const s = this.settings()
    if (s.exportDir && this.isDir(s.exportDir)) return s.exportDir
    return join(app.getPath('downloads'), 'LinkTo')
  }

  // ================================================================ 导出

  async exportFiles(req: ShareRequest): Promise<ShareResult> {
    try {
      if (req.content && !CONTENT_FORMATS.includes(req.format)) return { ok: false, error: `网页内容不支持导出 ${formatLabel(req.format)}` }
      const list = await this.loadReq(req)
      const files = await this.generate(list, req.format, { merge: req.merge, includeAttachments: req.content ? false : req.includeAttachments ?? req.format === 'md' })
      const s = this.settings()
      const where = req.where ?? (s.askWhere ? 'ask' : 'quick')
      let dir: string
      if (where === 'dir') {
        if (!req.dir || !this.isDir(req.dir)) return { ok: false, error: '导出目录不存在' }
        dir = req.dir
      } else if (where === 'ask') {
        const win = this.deps.mainWindow() ?? BrowserWindow.getFocusedWindow() ?? undefined
        const base = s.lastDir && this.isDir(s.lastDir) ? s.lastDir : this.defaultExportDir()
        if (files.length === 1 && !files[0].assets?.length) {
          const r = win ? await dialog.showSaveDialog(win, { defaultPath: join(base, files[0].name) }) : await dialog.showSaveDialog({ defaultPath: join(base, files[0].name) })
          if (r.canceled || !r.filePath) return { ok: false, canceled: true }
          writeFileSync(r.filePath, files[0].data)
          this.setSettings({ lastDir: dirname(r.filePath) })
          return this.done(list, `已导出 ${formatLabel(req.format)}：${basename(r.filePath)}`, [r.filePath], 'sys:export')
        }
        const opts = { title: `选择导出 ${files.length} 个文件的位置`, defaultPath: base, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
        const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
        dir = r.filePaths[0]
        this.setSettings({ lastDir: dir })
      } else dir = this.defaultExportDir()
      const paths = this.writeFiles(dir, files)
      const trunc = files.some(f => f.truncated) ? '（长图过长已截断）' : ''
      return this.done(list, `已导出 ${paths.length} 个 ${formatLabel(req.format)} 到 ${dir}${trunc}`, paths, req.targetId || 'sys:export')
    } catch (err) {
      return { ok: false, error: `导出失败：${errText(err)}` }
    }
  }

  /** 成功：活动记录 + 最近使用 */
  private done(list: Loaded[], message: string, paths: string[] = [], targetId?: string, extra: Partial<ShareResult> = {}, silent = false): ShareResult {
    if (targetId) {
      const s = this.settings()
      this.setSettings({ recent: [targetId, ...s.recent.filter(x => x !== targetId)] })
    }
    if (!silent) {
      try {
        logActivity({
          source: 'share',
          title: message.slice(0, 80),
          detail: list.some(m => m.content)
            ? list.map(m => `${subj(m.full.subject)}${m.content?.url ? `\n${m.content.url}` : ''}`).join('\n')
            : list.length > 1
              ? `${list.length} 封：${list.slice(0, 3).map(m => subj(m.full.subject)).join('、')}${list.length > 3 ? '…' : ''}`
              : null,
          refs: list.filter(m => !m.content).slice(0, 6).map(m => ({ type: 'mail' as const, id: m.full.id, label: subj(m.full.subject) }))
        })
      } catch {
        /* 活动记录失败不影响结果 */
      }
    }
    return { ok: true, message, paths, count: list.length, ...extra }
  }

  // ================================================================ 剪贴板

  async copy(ids: string[], kind: 'text' | 'rich' | 'link' | 'png'): Promise<ShareResult> {
    try {
      return await this.copyList(await this.load(ids), kind)
    } catch (err) {
      return { ok: false, error: `复制失败：${errText(err)}` }
    }
  }

  private async copyList(list: Loaded[], kind: 'text' | 'rich' | 'link' | 'png'): Promise<ShareResult> {
    try {
      // Electron 44 的异步剪贴板：一次 write 里的多种 MIME 原子提交（富文本 = HTML + 纯文本双格式）
      if (kind === 'text') await clipboard.writeText(this.textOf(list))
      else if (kind === 'rich') await clipboard.write([new ClipboardItem({ 'text/plain': this.textOf(list), 'text/html': this.richHtml(list) })])
      else if (kind === 'link') await clipboard.write([new ClipboardItem({ 'text/plain': this.linkText(list), 'text/html': this.linkHtml(list) })])
      else {
        const r = await this.pngOf(list)
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(r.png)], { type: 'image/png' }) })])
        return { ok: true, message: `长图已复制${r.truncated ? '（过长已截断）' : ''}`, count: list.length }
      }
      return { ok: true, message: kind === 'link' ? '链接已复制' : kind === 'rich' ? '已复制富文本（带格式）' : '已复制文本', count: list.length }
    } catch (err) {
      return { ok: false, error: `复制失败：${errText(err)}` }
    }
  }

  // ================================================================ 预览

  async preview(req: ShareRequest): Promise<SharePreview> {
    const t = this.target(req.targetId)
    const base: SharePreview = { ok: false, target: t?.name ?? req.targetId, external: !!t?.external, title: '', body: '', files: [], warnings: [] }
    if (!t) return { ...base, error: '分享目标不存在' }
    if (!t.formats.includes(req.format)) return { ...base, error: `「${t.name}」不支持 ${formatLabel(req.format)}` }
    if (req.content && !CONTENT_FORMATS.includes(req.format)) return { ...base, error: `网页内容不支持${formatLabel(req.format)}` }
    try {
      const list = await this.loadReq(req)
      const warn: string[] = []
      if (!req.content && req.messageIds.length > MAX_MAILS) warn.push(`一次最多 ${MAX_MAILS} 封，超出的不会处理`)
      if (!this.allowRemote() && ['pdf', 'png', 'rich'].includes(req.format) && list.some(m => /<img[^>]+src=["']?https?:/i.test(m.full.html ?? ''))) warn.push('远程图片按设置不加载（设置 → 分享与导出 可改）')
      const fileNames = () => {
        const ext = formatExt(req.format)
        const merge = req.merge ?? (req.format === 'pdf' ? this.settings().pdfMerge : true)
        if (merge && list.length > 1 && !['eml', 'md'].includes(req.format)) return [this.mergedName(list, ext)]
        return list.map(m => this.nameOf(m, ext))
      }
      const attNames = req.includeAttachments && !req.content ? list.flatMap(m => this.realAttachments(m).map(a => a.filename)) : []
      const cfg = t.config
      const isFile = FILE_FORMATS.includes(req.format)
      const title = list.length === 1 ? subj(list[0].full.subject) : `${list.length} 封邮件`
      if (cfg && ['wecom', 'dingtalk', 'feishu', 'slack', 'teams', 'discord', 'telegram'].includes(cfg.kind)) {
        if (isFile && cfg.kind !== 'telegram' && !cfg.driveId) return { ...base, error: 'Webhook 不能直接发文件：在设置里给这个目标选「文件先存到网盘」，或改用文本 / 富文本' }
        const drive = cfg.driveId ? listDrives(this.deps.appStore).find(d => d.id === cfg.driveId) : null
        const files = isFile || attNames.length ? [...(isFile ? fileNames() : []), ...attNames] : []
        if (files.length && cfg.kind !== 'telegram') warn.push(drive ? `文件先存到「${drive.name}」，消息里附${drive.kind === 'dropbox' ? '分享链接' : '位置说明'}` : '没有设置网盘，附件不会发出')
        if (cfg.kind === 'telegram' && files.length) warn.push('文件逐个发送，单个上限 50 MB')
        const n = req.merge || list.length === 1 ? 1 : Math.min(list.length, MAX_IM_MESSAGES)
        if (n > 1) warn.push(`将发出 ${n} 条消息（每封一条）`)
        const d = this.digest(req.merge ? list : list.slice(0, 1), req, files.map(f => ({ name: f, where: drive?.name ?? null })))
        return { ...base, ok: true, title, body: digestMarkdown(d), files, warnings: warn }
      }
      if (cfg?.kind === 'notion') return { ...base, ok: true, title, body: list.map(m => `# ${subj(m.full.subject)}\n${this.fromText(m)} · ${fmtDate(m.full.date)}\n\n${excerpt(req.format === 'md' && m.full.html ? htmlToMarkdown(m.full.html) : this.plain(m), 1200)}`).join('\n\n'), files: [], warnings: [`将在 Notion 新建 ${list.length} 个页面`, ...warn] }
      if (cfg?.kind === 'flomo') return { ...base, ok: true, title, body: list.map(m => flomoPayload(this.digest([m], req), cfg.tags).content).join('\n\n— — —\n\n'), files: [], warnings: [`将新建 ${list.length} 条 memo`, ...warn] }
      if (cfg?.kind === 'readwise') return { ...base, ok: true, title, body: list.map(m => `# ${subj(m.full.subject)}\n${this.fromText(m)}\n\n${this.plain(m).slice(0, 600)}`).join('\n\n— — —\n\n'), files: [], warnings: [`将存入 Readwise Reader 稍后读（${list.length} 条）`, ...warn] }
      if (cfg?.kind === 'apple-notes') return { ...base, ok: true, title, body: this.textOf(list).slice(0, 4000), files: [], warnings: [`将在备忘录「${cfg.notesFolder || '默认文件夹'}」新建 ${list.length} 条备忘录`, ...warn] }
      if (cfg?.kind === 'md-folder') {
        const rel = list.map(m => `${renderNameTemplate(cfg.pathTemplate || '{year}/{month}/{subject}', { subject: m.full.subject, from: m.full.from?.name ?? '', fromAddr: m.full.from?.address ?? '', date: m.full.date, account: m.accountName }, { allowDirs: true })}.md`)
        return { ...base, ok: true, title, body: this.markdownOf(list[0]).slice(0, 4000), files: rel.map(r => join(cfg.folder ?? '', r)), warnings: [...(req.includeAttachments ? ['附件放在与笔记同名的文件夹里'] : []), ...warn] }
      }
      const files = [...fileNames(), ...(req.format === 'md' && req.includeAttachments ? attNames.map(a => `附件：${a}`) : [])]
      if (req.targetId === 'sys:export' || cfg?.kind === 'local-folder') {
        const dir = cfg?.folder ?? (this.settings().askWhere ? '（导出时选择位置）' : this.defaultExportDir())
        return { ...base, ok: true, title, body: req.format === 'text' ? this.textOf(list).slice(0, 4000) : req.format === 'md' ? this.markdownOf(list[0]).slice(0, 4000) : `将生成 ${files.length} 个文件，保存到：\n${dir}`, files, warnings: warn }
      }
      if (req.targetId.startsWith('drive:')) return { ...base, ok: true, title, body: `将上传到网盘「${t.name}」的 /share 目录`, files: [...files, ...(req.includeAttachments ? attNames : [])], warnings: warn }
      if (req.targetId === 'sys:clipboard' || req.targetId === 'sys:wechat') {
        const body = req.format === 'link' ? this.linkText(list) : req.format === 'png' ? '将生成长图并复制到剪贴板' : this.textOf(list).slice(0, 4000)
        return { ...base, ok: true, title, body, files: [], warnings: req.targetId === 'sys:wechat' ? ['复制后会打开微信，在聊天窗口里粘贴（⌘V）发送', ...warn] : warn }
      }
      if (req.targetId === 'sys:whatsapp' || req.targetId === 'sys:telegram-link') {
        return { ...base, ok: true, title, body: this.imText(list, req), files: [], warnings: ['会打开应用并带上这段文字，选择联系人后由你发送', ...warn] }
      }
      // 系统分享
      return { ...base, ok: true, title, body: req.format === 'text' || req.format === 'link' ? this.imText(list, req) : `将生成 ${files.length} 个文件，交给系统分享菜单`, files: req.format === 'text' || req.format === 'link' ? [] : files, warnings: warn }
    } catch (err) {
      return { ...base, error: errText(err) }
    }
  }

  private imText(list: Loaded[], req: ShareRequest): string {
    const s = req.format === 'link' ? this.linkText(list) : digestMarkdown(this.digest(list, req), { bold: x => x, link: (x, u) => `${x} ${u}`, quoteBody: false })
    return s.slice(0, 3500)
  }

  // ================================================================ 发送

  async send(req: ShareRequest, opts: { via?: 'ui' | 'agent' } = {}): Promise<ShareResult> {
    const t = this.target(req.targetId)
    if (!t) return { ok: false, error: '分享目标不存在' }
    if (!t.formats.includes(req.format)) return { ok: false, error: `「${t.name}」不支持 ${formatLabel(req.format)}` }
    if (t.external && !req.confirmed) return { ok: false, error: '对外发送需要先在界面上确认' }
    const silent = opts.via === 'agent' // Agent 运行时自己记活动
    if (req.content && !CONTENT_FORMATS.includes(req.format)) return { ok: false, error: `网页内容不支持${formatLabel(req.format)}` }
    try {
      const list = await this.loadReq(req)
      const cfg = t.config
      if (req.targetId === 'sys:export') return this.exportFiles(req)
      if (cfg?.kind === 'local-folder') return this.exportFiles({ ...req, where: 'dir', dir: cfg.folder })
      if (req.targetId === 'sys:clipboard') {
        const r = await this.copyList(list, req.format === 'png' || req.format === 'rich' || req.format === 'link' ? req.format : 'text')
        if (r.ok) this.done(list, r.message ?? '已复制', [], req.targetId, {}, true)
        return r
      }
      if (req.targetId === 'sys:wechat') {
        const r = await this.copyList(list, req.format === 'png' || req.format === 'rich' || req.format === 'link' ? req.format : 'text')
        if (!r.ok) return r
        await shell.openExternal('weixin://').catch(() => {})
        return this.done(list, `已复制${req.format === 'png' ? '长图' : '内容'}并打开微信：到聊天里粘贴发送`, [], req.targetId, {}, silent)
      }
      if (req.targetId === 'sys:whatsapp' || req.targetId === 'sys:telegram-link') {
        const text = this.imText(list, req)
        const url = req.targetId === 'sys:whatsapp' ? `https://wa.me/?text=${encodeURIComponent(text)}` : `tg://msg?text=${encodeURIComponent(text)}`
        await shell.openExternal(url)
        return this.done(list, `已打开 ${t.name}，选择联系人后发送`, [], req.targetId, { url }, silent)
      }
      if (req.targetId === 'sys:share') return this.systemShare(list, req)
      if (req.targetId.startsWith('drive:')) return this.toDrive(list, req, req.targetId.slice(6), silent)
      if (!cfg) return { ok: false, error: '分享目标不存在' }
      switch (cfg.kind) {
        case 'wecom':
        case 'dingtalk':
        case 'feishu':
        case 'slack':
        case 'teams':
        case 'discord':
          return await this.toWebhook(cfg, list, req, silent)
        case 'telegram':
          return await this.toTelegram(cfg, list, req, silent)
        case 'notion':
          return await this.toNotion(cfg, list, req, silent)
        case 'flomo':
          return await this.toFlomo(cfg, list, req, silent)
        case 'readwise':
          return await this.toReadwise(cfg, list, req, silent)
        case 'apple-notes':
          return await this.toNotes(cfg, list, req, silent)
        case 'md-folder':
          return await this.toMdFolder(cfg, list, req, silent)
        default:
          return { ok: false, error: '未知的目标类型' }
      }
    } catch (err) {
      return { ok: false, error: `${t.name}：${errText(err)}` }
    }
  }

  /** 生成的文件 + 附件上传到网盘：返回消息里要带的链接 / 位置 */
  private async archiveFiles(driveId: string, list: Loaded[], req: ShareRequest): Promise<ShareDigest['files']> {
    const drive = listDrives(this.deps.appStore).find(d => d.id === driveId)
    if (!drive) throw new Error('目标设置的网盘已不存在')
    const out: ShareDigest['files'] = []
    const put = async (name: string, data: Buffer, remote: string) => {
      const r = await driveUpload(this.deps.appStore, driveId, remote, data)
      if (!r.ok) throw new Error(`存到网盘「${drive.name}」失败：${r.error ?? '未知错误'}`)
      const url = drive.kind === 'dropbox' && r.path ? await this.dropboxLink(driveId, r.path).catch(() => null) : null
      out.push({ name, url, where: url ? null : drive.kind === 'local' ? `${drive.name}：${r.path}` : `${drive.name}：${r.path}${driveWebUrl(this.deps.appStore, driveId, remote) ? `（${driveWebUrl(this.deps.appStore, driveId, remote)}）` : ''}` })
    }
    if (FILE_FORMATS.includes(req.format)) {
      for (const f of await this.generate(list, req.format, { merge: req.merge, includeAttachments: false })) await put(f.name, f.data, `/share/${f.name}`)
    }
    if (req.includeAttachments) {
      for (const m of list)
        for (const a of this.realAttachments(m)) {
          const p = await this.attachmentPath(a.id)
          if (!p) continue
          await put(a.filename, readFileSync(p), `/share/attachments/${safeFileName(a.filename, 120)}`)
        }
    }
    return out
  }

  private async dropboxLink(driveId: string, fullPath: string): Promise<string | null> {
    const token = this.deps.appStore.loadSecret(`drive-${driveId}`)
    if (!token) return null
    const r = await postJson('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', { path: fullPath }, { Authorization: `Bearer ${token}` }, 15000)
    if (r.status === 200 && r.json?.url) return String(r.json.url)
    const existing = r.json?.error?.shared_link_already_exists?.metadata?.url
    if (existing) return String(existing)
    const l = await postJson('https://api.dropboxapi.com/2/sharing/list_shared_links', { path: fullPath, direct_only: true }, { Authorization: `Bearer ${token}` }, 15000)
    return l.json?.links?.[0]?.url ?? null
  }

  private async toWebhook(cfg: ShareTarget, list: Loaded[], req: ShareRequest, silent: boolean): Promise<ShareResult> {
    const sec = this.secrets(cfg.id)
    if (!sec.url) return { ok: false, error: 'Webhook 地址缺失，请在设置里重新填写' }
    const needFiles = FILE_FORMATS.includes(req.format) || !!req.includeAttachments
    if (FILE_FORMATS.includes(req.format) && !cfg.driveId) return { ok: false, error: 'Webhook 不能直接发文件：在设置里给这个目标选「文件先存到网盘」，或改用文本 / 富文本' }
    const files = needFiles && cfg.driveId ? await this.archiveFiles(cfg.driveId, list, req) : []
    const groups = req.merge || list.length === 1 ? [list] : list.slice(0, MAX_IM_MESSAGES).map(m => [m])
    let sent = 0
    for (let i = 0; i < groups.length; i++) {
      const d = this.digest(groups[i], req, i === 0 ? files : [])
      await this.postWebhook(cfg.kind, sec, d)
      sent++
    }
    return this.done(list, `已发到 ${cfg.name}${sent > 1 ? `（${sent} 条消息）` : ''}`, [], cfg.id, { count: sent }, silent)
  }

  private async postWebhook(kind: ShareTarget['kind'], sec: Secrets, d: ShareDigest): Promise<void> {
    let url = sec.url!
    let body: unknown
    switch (kind) {
      case 'wecom':
        body = wecomPayload(d)
        break
      case 'dingtalk':
        url = dingtalkUrl(url, sec.secret)
        body = dingtalkPayload(d)
        break
      case 'feishu':
        body = feishuPayload(d, sec.secret)
        break
      case 'slack':
        body = slackPayload(d)
        break
      case 'teams':
        body = teamsPayload(d)
        break
      case 'discord':
        body = discordPayload(d)
        break
      default:
        throw new Error('不是 Webhook 目标')
    }
    const r = await postJson(url, body)
    const err = checkWebhookResponse(kind, r.status, r.text)
    if (err) throw new Error(err)
  }

  private tgBase(cfg: ShareTarget, token: string) {
    return `${(cfg.apiBase || 'https://api.telegram.org').replace(/\/+$/, '')}/bot${token}`
  }

  private async tgCall(cfg: ShareTarget, token: string, method: string, body: unknown | FormData, timeoutMs = 20000): Promise<any> {
    const url = `${this.tgBase(cfg, token)}/${method}`
    const r =
      body instanceof FormData ? await httpRequest(url, { method: 'POST', body, timeoutMs }) : await postJson(url, body, {}, timeoutMs)
    if (r.status === 401 || r.status === 404) throw new Error('Bot Token 无效')
    if (!r.json?.ok) {
      const desc = String(r.json?.description ?? `HTTP ${r.status}`)
      if (/chat not found/i.test(desc)) throw new Error('找不到这个 Chat ID：先在 Telegram 里给机器人发一条消息，或把它加进群')
      if (/too large|Request Entity Too Large/i.test(desc) || r.status === 413) throw new Error('文件太大（机器人接口上限 50 MB）')
      if (/bot was blocked|kicked/i.test(desc)) throw new Error('机器人被对方屏蔽或移出了群')
      throw new Error(`Telegram 返回：${desc}`)
    }
    return r.json.result
  }

  private async toTelegram(cfg: ShareTarget, list: Loaded[], req: ShareRequest, silent: boolean): Promise<ShareResult> {
    const token = this.secrets(cfg.id).token
    if (!token || !cfg.chatId) return { ok: false, error: 'Bot Token 或 Chat ID 缺失' }
    let n = 0
    const sendDoc = async (name: string, data: Buffer, caption: string) => {
      if (data.length > TELEGRAM_MAX) throw new Error(`「${name}」${Math.round(data.length / 1048576)} MB，超过机器人接口 50 MB 上限`)
      const form = new FormData()
      form.append('chat_id', cfg.chatId!)
      form.append('caption', caption)
      form.append('parse_mode', 'HTML')
      form.append('document', new Blob([new Uint8Array(data)]), name)
      await this.tgCall(cfg, token, 'sendDocument', form, 120000)
      n++
    }
    if (FILE_FORMATS.includes(req.format)) {
      const files = await this.generate(list, req.format, { merge: req.merge, includeAttachments: false })
      for (const f of files) await sendDoc(f.name, f.data, req.note?.trim() ? `${escapeHtml(req.note.trim()).slice(0, 300)}\n${telegramCaption(this.digest(list, req))}` : telegramCaption(this.digest(list, req)))
    } else {
      const groups = req.merge || list.length === 1 ? [list] : list.slice(0, MAX_IM_MESSAGES).map(m => [m])
      for (const g of groups) {
        await this.tgCall(cfg, token, 'sendMessage', telegramMessage(cfg.chatId, this.digest(g, req)))
        n++
      }
    }
    if (req.includeAttachments) {
      for (const m of list)
        for (const a of this.realAttachments(m)) {
          const p = await this.attachmentPath(a.id)
          if (p) await sendDoc(a.filename, readFileSync(p), escapeHtml(`附件 · ${subj(m.full.subject)}`).slice(0, 1000))
        }
    }
    return this.done(list, `已发到 Telegram「${cfg.name}」（${n} 条）`, [], cfg.id, { count: n }, silent)
  }

  private notionHeaders(token: string) {
    return { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' }
  }

  private notionErr(status: number, json: any): string {
    const msg = String(json?.message ?? '')
    if (status === 401) return 'Notion Token 无效'
    if (status === 404 || json?.code === 'object_not_found') return '找不到数据库 / 页面：确认 ID 正确，并已在该页面「连接」里添加你的 Integration'
    if (status === 429) return 'Notion 限流了，稍后再试'
    if (json?.code === 'validation_error') return `Notion 校验失败：${msg.slice(0, 200)}`
    return `Notion 返回 HTTP ${status}${msg ? `：${msg.slice(0, 200)}` : ''}`
  }

  private async toNotion(cfg: ShareTarget, list: Loaded[], req: ShareRequest, silent: boolean): Promise<ShareResult> {
    const token = this.secrets(cfg.id).token
    if (!token || !cfg.parentId) return { ok: false, error: 'Notion Token 或数据库 / 页面 ID 缺失' }
    const base = (cfg.apiBase || 'https://api.notion.com').replace(/\/+$/, '')
    const parent = { type: cfg.parentType === 'page' ? ('page' as const) : ('database' as const), id: cfg.parentId }
    let schema: NotionSchema | null = null
    if (parent.type === 'database') {
      const r = await httpRequest(`${base}/v1/databases/${parent.id}`, { headers: this.notionHeaders(token) })
      if (r.status !== 200) throw new Error(this.notionErr(r.status, r.json))
      schema = notionSchemaOf(r.json)
    }
    const urls: string[] = []
    for (const m of list) {
      const body = req.format === 'md' && m.full.html ? htmlToMarkdown(m.full.html) : this.plain(m)
      const page = notionPage(parent, { ...this.digestMail(m), body }, { files: [], note: req.note }, schema)
      const r = await postJson(`${base}/v1/pages`, page.body, this.notionHeaders(token), 30000)
      if (r.status !== 200) throw new Error(this.notionErr(r.status, r.json))
      const pageId = String(r.json?.id ?? '')
      for (const chunk of page.rest) {
        const a = await httpRequest(`${base}/v1/blocks/${pageId}/children`, { method: 'PATCH', headers: { ...this.notionHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ children: chunk }), timeoutMs: 30000 })
        if (a.status !== 200) throw new Error(this.notionErr(a.status, a.json))
      }
      if (r.json?.url) urls.push(String(r.json.url))
    }
    return this.done(list, `已存到 Notion「${cfg.name}」（${list.length} 页）`, [], cfg.id, { url: urls[0] }, silent)
  }

  private async toFlomo(cfg: ShareTarget, list: Loaded[], req: ShareRequest, silent: boolean): Promise<ShareResult> {
    const url = this.secrets(cfg.id).url
    if (!url) return { ok: false, error: 'flomo API 地址缺失' }
    for (const m of list) {
      const r = await postJson(url, flomoPayload(this.digest([m], req), cfg.tags))
      const err = checkWebhookResponse('flomo', r.status, r.text)
      if (err) throw new Error(err)
    }
    return this.done(list, `已记到 flomo（${list.length} 条）`, [], cfg.id, {}, silent)
  }

  /** Readwise Reader：带链接的收藏 URL，邮件按正文存稍后读 */
  private async toReadwise(cfg: ShareTarget, list: Loaded[], req: ShareRequest, silent: boolean): Promise<ShareResult> {
    const token = this.secrets(cfg.id).token
    if (!token) return { ok: false, error: 'Readwise Token 缺失' }
    for (const m of list) {
      const url = m.content?.url ?? null
      const body = readwiseBody({
        url,
        title: m.full.subject,
        author: fmtAddr(m.full.from),
        html: url ? null : m.full.html ?? null,
        summary: this.plain(m).slice(0, 400)
      })
      const r = await postJson('https://readwise.io/reader/api/v3/save/', body, { Authorization: `Token ${token}` })
      if (r.status >= 300) throw new Error(`Readwise ${r.status}：${String(r.text ?? '').slice(0, 140)}`)
    }
    return this.done(list, `已存入 Readwise Reader（${list.length} 条）`, [], cfg.id, {}, silent)
  }

  runJxa(script: string, timeoutMs = 20000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (process.platform !== 'darwin') return reject(new Error('Apple 备忘录只在 macOS 上可用'))
      execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) reject(new Error(notesErrorText(`${stderr || ''} ${err.message}`)))
        else resolve(String(stdout).trim())
      })
    })
  }

  private async toNotes(cfg: ShareTarget, list: Loaded[], req: ShareRequest, silent: boolean): Promise<ShareResult> {
    for (const m of list) {
      const head = m.content
        ? `<h1>${escapeHtml(subj(m.full.subject))}</h1>${m.content.source ? `<div>来源：${escapeHtml(m.content.source)}</div>` : ''}${m.content.date ? `<div>时间：${fmtDate(m.content.date)}</div>` : ''}${req.note?.trim() ? `<div><i>${escapeHtml(req.note.trim())}</i></div>` : ''}<div><br></div>`
        : `<h1>${escapeHtml(subj(m.full.subject))}</h1><div>发件人：${escapeHtml(fmtAddr(m.full.from))}</div><div>时间：${fmtDate(m.full.date)}</div>${req.note?.trim() ? `<div><i>${escapeHtml(req.note.trim())}</i></div>` : ''}<div><br></div>`
      const body = req.format === 'link' ? this.linkHtml([m]) : req.format === 'rich' ? this.safeBodyHtml(m, false) : textToHtml(this.plain(m))
      const tail = `<div><br></div><div>${escapeHtml(this.links(m).app)}</div>`
      await this.runJxa(buildNotesJxa({ title: subj(m.full.subject), html: head + body + tail, folder: cfg.notesFolder }))
    }
    return this.done(list, `已存到备忘录${cfg.notesFolder ? `「${cfg.notesFolder}」` : ''}（${list.length} 条）`, [], cfg.id, {}, silent)
  }

  private async toMdFolder(cfg: ShareTarget, list: Loaded[], req: ShareRequest, silent: boolean): Promise<ShareResult> {
    if (!cfg.folder || !this.isDir(cfg.folder)) return { ok: false, error: '笔记文件夹不存在，请在设置里重新选择' }
    const paths: string[] = []
    for (const m of list) {
      const rel = renderNameTemplate(cfg.pathTemplate || '{year}/{month}/{subject}', { subject: m.full.subject, from: m.full.from?.name ?? '', fromAddr: m.full.from?.address ?? '', date: m.full.date, account: m.accountName }, { allowDirs: true })
      const dir = join(cfg.folder, dirname(rel))
      const [f] = await this.generate([m], 'md', { includeAttachments: req.includeAttachments })
      f.name = `${basename(rel)}.md`
      // generate 按导出命名模板生成了附件目录名，这里改成笔记的文件名
      if (f.assets?.length) f.data = Buffer.from(this.markdownOf(m, basename(rel), f.assets), 'utf8')
      paths.push(...this.writeFiles(dir, [f]))
    }
    return this.done(list, `已存到笔记文件夹（${paths.length} 篇）`, paths, cfg.id, {}, silent)
  }

  private async toDrive(list: Loaded[], req: ShareRequest, driveId: string, silent: boolean): Promise<ShareResult> {
    const drive = listDrives(this.deps.appStore).find(d => d.id === driveId)
    if (!drive) return { ok: false, error: '网盘不存在' }
    const paths: string[] = []
    for (const f of await this.generate(list, req.format, { merge: req.merge, includeAttachments: false })) {
      const r = await driveUpload(this.deps.appStore, driveId, `/share/${f.name}`, f.data)
      if (!r.ok) return { ok: false, error: `上传到「${drive.name}」失败：${r.error ?? '未知错误'}` }
      paths.push(r.path ?? f.name)
    }
    if (req.includeAttachments) {
      for (const m of list)
        for (const a of this.realAttachments(m)) {
          const p = await this.attachmentPath(a.id)
          if (!p) continue
          const r = await uploadAttachment(this.deps.appStore, p, a.filename, driveId)
          if (r.ok) {
            paths.push(r.path ?? a.filename)
            attachmentService()?.recordLegacyUpload(a.id, driveId, `/attachments/${basename(r.path ?? a.filename)}`)
          }
        }
    }
    return this.done(list, `已存到「${drive.name}」（${paths.length} 个文件）`, paths, `drive:${driveId}`, {}, silent)
  }

  private async systemShare(list: Loaded[], req: ShareRequest): Promise<ShareResult> {
    if (process.platform !== 'darwin') return { ok: false, error: '系统分享菜单只在 macOS 上可用' }
    const win = this.deps.mainWindow() ?? BrowserWindow.getFocusedWindow()
    if (!win) return { ok: false, error: '主窗口未打开' }
    let item: Electron.SharingItem
    if (req.format === 'text') item = { texts: [this.imText(list, req)] }
    else if (req.format === 'link') item = { texts: [this.linkText(list)] }
    else {
      const dir = join(app.getPath('temp'), 'linkto-share', randomUUID())
      const files = await this.generate(list, req.format, { merge: req.merge, includeAttachments: false })
      item = { filePaths: this.writeFiles(dir, files) }
    }
    const menu = new ShareMenu(item)
    menu.popup({ window: win })
    if (this.menuAutoClose > 0) setTimeout(() => menu.closePopup(win), this.menuAutoClose)
    this.done(list, '已打开系统分享菜单', item.filePaths ?? [], 'sys:share', {}, true)
    return { ok: true, message: '已打开系统分享菜单', paths: item.filePaths ?? [], count: list.length }
  }

  // ================================================================ 测试

  async test(id: string): Promise<ShareResult> {
    const t = this.rawTargets().find(x => x.id === id)
    if (!t) return { ok: false, error: '分享目标不存在' }
    const sample: ShareDigest = {
      mails: [
        {
          subject: 'LinkTo 测试消息',
          from: 'LinkTo <test@linkto.invalid>',
          to: '',
          date: Date.now(),
          dateText: fmtDate(Date.now()),
          gist: '这是一条连接测试，收到即说明配置正确。',
          highlights: [],
          excerpt: '分享目标配置成功后，可以在阅读页「分享 / 导出」或 ⌘⇧E 里把邮件发到这里。',
          attachments: [],
          appLink: 'linkto://open'
        }
      ],
      files: []
    }
    try {
      const sec = this.secrets(t.id)
      switch (t.kind) {
        case 'wecom':
        case 'dingtalk':
        case 'feishu':
        case 'slack':
        case 'teams':
        case 'discord':
          if (!sec.url) return { ok: false, error: 'Webhook 地址缺失' }
          await this.postWebhook(t.kind, sec, sample)
          return { ok: true, message: '测试消息已发送，去群里看看' }
        case 'telegram': {
          if (!sec.token || !t.chatId) return { ok: false, error: 'Bot Token 或 Chat ID 缺失' }
          const me = await this.tgCall(t, sec.token, 'getMe', {})
          await this.tgCall(t, sec.token, 'sendMessage', telegramMessage(t.chatId, sample))
          return { ok: true, message: `测试消息已由 @${me?.username ?? 'bot'} 发出` }
        }
        case 'notion': {
          if (!sec.token || !t.parentId) return { ok: false, error: 'Notion Token 或 ID 缺失' }
          const base = (t.apiBase || 'https://api.notion.com').replace(/\/+$/, '')
          const r = await httpRequest(`${base}/v1/${t.parentType === 'page' ? 'pages' : 'databases'}/${t.parentId}`, { headers: this.notionHeaders(sec.token) })
          if (r.status !== 200) return { ok: false, error: this.notionErr(r.status, r.json) }
          const title = (r.json?.title?.[0]?.plain_text as string | undefined) ?? (Object.values(r.json?.properties ?? {}).find((p: any) => p?.type === 'title') as any)?.title?.[0]?.plain_text
          return { ok: true, message: `已连上 Notion${title ? `「${title}」` : ''}（测试只读取，不新建页面）` }
        }
        case 'flomo': {
          if (!sec.url) return { ok: false, error: 'flomo API 地址缺失' }
          const r = await postJson(sec.url, flomoPayload(sample, t.tags))
          const err = checkWebhookResponse('flomo', r.status, r.text)
          return err ? { ok: false, error: err } : { ok: true, message: '已记一条测试 memo 到 flomo' }
        }
        case 'readwise': {
          if (!sec.token) return { ok: false, error: 'Readwise Token 缺失' }
          const r = await postJson('https://readwise.io/reader/api/v3/save/', readwiseBody({ title: 'LinkTo 连接测试', summary: '这是一条来自 LinkTo 的测试保存，可在 Reader 里直接删除。' }), { Authorization: `Token ${sec.token}` })
          return r.status >= 300 ? { ok: false, error: `Readwise ${r.status}：${String(r.text ?? '').slice(0, 140)}` } : { ok: true, message: '已连上 Readwise（存了一条测试文档，可在 Reader 删除）' }
        }
        case 'apple-notes': {
          const name = await this.runJxa(`Application('Notes').defaultAccount().name()`)
          return { ok: true, message: `已获得备忘录权限（账户：${name}）；测试不写入备忘录` }
        }
        case 'md-folder':
        case 'local-folder': {
          if (!this.isDir(t.folder)) return { ok: false, error: '文件夹不存在' }
          const probe = join(t.folder!, `.linkto-probe-${Date.now()}`)
          writeFileSync(probe, 'ok')
          unlinkSync(probe)
          return { ok: true, message: '文件夹可写' }
        }
      }
      return { ok: false, error: '未知的目标类型' }
    } catch (err) {
      return { ok: false, error: err instanceof ShareHttpError ? err.message : errText(err) }
    }
  }

  // ================================================================ linkto:// 链接

  /** 解析链接并定位邮件；找不到返回中文原因 */
  openLink(url: string): { ok: boolean; error?: string; id?: string } {
    const p = parseAppLink(url)
    if (!p) return { ok: false, error: '不是 LinkTo 邮件链接' }
    let id: string | null = null
    if (p.id && this.deps.store.getMessageRow(p.id)) id = p.id
    if (!id && p.mid) {
      const row = this.deps.store.db
        .prepare('SELECT id FROM messages WHERE message_id IN (?, ?) ORDER BY date DESC LIMIT 1')
        .get(p.mid, `<${p.mid}>`) as { id: string } | undefined
      id = row?.id ?? null
    }
    if (!id) return { ok: false, error: '本机没有找到这封邮件（可能在另一台设备或还没同步）' }
    this.deps.openMessage(id)
    return { ok: true, id }
  }
}
