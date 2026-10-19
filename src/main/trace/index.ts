/* eslint-disable @typescript-eslint/no-explicit-any */
import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AISettings } from '@shared/types'
import type { TraceUpdatePatch } from '@shared/ipc'
import { agreementLine, chatToText, fmtTraceTime, TRACE_CHANNEL_LABEL, TRACE_MATERIAL_LABEL, TRACE_STATUS_LABEL, traceToMarkdown, type TraceRecord } from '@shared/trace'
import type { MailStore } from '../db'
import type { AppStore } from '../store'
import { DEFAULT_NOTIFICATIONS } from '../store'
import type { AIService } from '../ai/service'
import type { SyncEngine } from '../mail/sync-engine'
import { onOutboxEvent } from '../mail/outbox'
import { inQuietHours } from '../notify-policy'
import { allows, allowsAI, getAccess } from '../attachments/access'
import { localOcrStatus, localOcrSupported, ocrAvailability, runOcr } from '../attachments/ocr'
import { chooseOcrEngine } from '../attachments/ocr-native'
import { OCR_LIMITS } from '../attachments/ocr-parse'
import type { PdfJobResult } from '../attachments/pdf-worker'
import { attachmentText } from '../attachments/text'
import { TraceService } from './service'
import { TraceSync } from './sync'

export { TraceService } from './service'

let service: TraceService | null = null
let sync: TraceSync | null = null
let captureOpener: (() => void) | null = null

/** 打开「记一笔留痕」浮层（全局快捷键 / Dock / 托盘） */
export function openTraceCapture() {
  captureOpener?.()
}

/** 留痕服务（未初始化时为 null）：Agent 工具 / 同步钩子共用 */
/** 留痕同步（设置 → 同步与备份 的「留痕」类别开关） */
export function traceSyncHandle(): TraceSync | null {
  return sync
}

export function traceService(): TraceService | null {
  return service
}

export interface InitTraceDeps {
  store: MailStore
  appStore: AppStore
  ai: AIService
  engine: SyncEngine
  getAISettings(): AISettings
  event(payload: unknown): void
  openCompose(prefill: Record<string, unknown>): void
  onTodosChanged?(id: string): void
  /** 显示主窗口并打开「记一笔留痕」浮层 */
  openCapture(): void
  /** 显示主窗口并打开某条留痕 */
  openTrace(id: string): void
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 存档用 HTML（PDF 导出与存档邮件共用；独立文档，不走应用主题） */
function traceToHtml(r: TraceRecord, opts: { verified: boolean | null; forMail?: boolean }): string {
  const d = r.data
  const s = d.summary
  const row = (k: string, v: string) => `<tr><td style="padding:3px 12px 3px 0;color:#666;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:3px 0">${v}</td></tr>`
  const parts: string[] = []
  parts.push(`<h1 style="font-size:20px;margin:0 0 12px">${esc(r.title)}</h1>`)
  parts.push(
    `<table style="border-collapse:collapse;font-size:13px;margin-bottom:14px">${[
      row('场景', esc(TRACE_CHANNEL_LABEL[d.channel])),
      row('发生时间', esc(fmtTraceTime(d.occurredAt))),
      row('参与人', esc(d.parties.map(p => `${p.name}${p.email ? ` <${p.email}>` : ''}${p.me ? '（我）' : ''}`).join('、') || '—')),
      row('状态', esc(TRACE_STATUS_LABEL[d.status])),
      row('记录创建', esc(fmtTraceTime(d.createdAt)))
    ].join('')}</table>`
  )
  if (s) {
    parts.push('<h2 style="font-size:15px;margin:18px 0 6px">整理结果</h2>')
    if (s.conclusion) parts.push(`<p><strong>结论：</strong>${esc(s.conclusion)}</p>`)
    if (s.agreements.length) parts.push(`<p><strong>约定事项</strong></p><ol>${s.agreements.map(a => `<li>${esc(agreementLine(a))}${a.quote ? `<div style="color:#666;font-size:12px">原文：${esc(a.quote)}</div>` : ''}</li>`).join('')}</ol>`)
    if (s.pending.length) parts.push(`<p><strong>待确认</strong></p><ul>${s.pending.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`)
    if (s.risks.length) parts.push(`<p><strong>风险提示</strong></p><ul>${s.risks.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`)
  }
  if (d.confirm) {
    const c = d.confirm
    parts.push('<h2 style="font-size:15px;margin:18px 0 6px">书面确认</h2>')
    parts.push(
      `<table style="border-collapse:collapse;font-size:13px">${[
        row('收件人', esc(c.to.join('、') || '—')),
        row('主题', esc(c.subject)),
        row('起草', esc(fmtTraceTime(c.draftedAt))),
        ...(c.sentAt ? [row('发出', esc(fmtTraceTime(c.sentAt)))] : []),
        ...(c.replyAt ? [row('对方回信', esc(`${fmtTraceTime(c.replyAt)} · ${c.verdict === 'disputed' ? '有异议' : '已确认'}${c.evidence?.length ? `（${c.evidence.join('、')}）` : ''}`))] : [])
      ].join('')}</table>`
    )
  }
  parts.push('<h2 style="font-size:15px;margin:18px 0 6px">原始材料</h2>')
  for (const m of d.materials) {
    const body = m.kind === 'chat' && m.lines?.length ? chatToText(m.lines) : m.text
    parts.push(`<p style="margin:10px 0 4px;color:#666;font-size:12px">${esc(TRACE_MATERIAL_LABEL[m.kind])}${m.label ? ` · ${esc(m.label)}` : ''}${m.fileName ? ` · ${esc(m.fileName)}` : ''} · ${esc(fmtTraceTime(m.addedAt))} 加入</p>`)
    parts.push(`<pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:13px;margin:0;padding:8px 10px;border:1px solid #ddd;border-radius:6px">${esc(body)}</pre>`)
  }
  parts.push('<h2 style="font-size:15px;margin:18px 0 6px">完整性</h2>')
  parts.push(
    `<p style="font-size:12px;color:#444">内容哈希（SHA-256）：<code>${esc(d.hash)}</code><br>首次记录哈希：<code>${esc(d.firstHash)}</code>${opts.verified != null ? `<br>校验：${opts.verified ? '当前内容与哈希一致' : '当前内容与哈希不一致'}` : ''}${d.versions.length ? `<br>修改历史：${d.versions.length} 个旧版本（最近一次：${esc(fmtTraceTime(d.versions[d.versions.length - 1].at))} · ${esc(d.versions[d.versions.length - 1].reason)}）` : ''}</p>`
  )
  if (opts.forMail) parts.unshift('<p style="color:#666;font-size:12px">这是一封留痕存档邮件：由你发给自己，邮件服务器上的收发时间可作为这份记录的时间旁证。</p>')
  else parts.push(`<p style="color:#999;font-size:11px;margin-top:24px">由 LinkTo 留痕导出 · ${esc(fmtTraceTime(Date.now()))}</p>`)
  return parts.join('\n')
}

const ymd = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\n\r\t]/g, ' ').trim().slice(0, 40) || '留痕'

/** 初始化留痕：服务 + IPC（trace*）+ 书面确认对账（发件队列 / 新邮件 / 每分钟）+ 跨设备同步 */
export function initTrace(deps: InitTraceDeps): TraceService {
  const live = new Set<Notification>()
  const svc = new TraceService({
    store: deps.store,
    ai: deps.ai,
    getAISettings: deps.getAISettings,
    event: deps.event,
    openCompose: deps.openCompose,
    onTodosChanged: deps.onTodosChanged,
    onLocalChange: () => sync?.notifyLocalChange(),
    device: () => null,
    notify: (title, body, id) => {
      const s = deps.appStore.get('notifications', DEFAULT_NOTIFICATIONS)
      if (!s.enabled || inQuietHours(s.quietHours, new Date()) || !Notification.isSupported()) return
      const n = new Notification({ title, body: body.slice(0, 180), silent: !s.sound })
      live.add(n)
      n.on('click', () => {
        deps.openTrace(id)
        live.delete(n)
      })
      n.on('close', () => live.delete(n))
      n.show()
    }
  })
  service = svc
  captureOpener = deps.openCapture
  sync = new TraceSync({ appStore: deps.appStore, engine: deps.engine, service: svc, event: deps.event })

  /** 截图识字：用户主动粘贴 / 拖入的图片，写临时文件后走与附件相同的识字流程（授权一致） */
  const ocrImage = async (input: { dataUrl: string; name?: string | null }) => {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(input?.dataUrl ?? ''))
    if (!m) return { ok: false, error: '不是图片' }
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length > OCR_LIMITS.maxFileBytes) return { ok: false, error: `图片过大（超过 ${Math.round(OCR_LIMITS.maxFileBytes / 1048576)} MB）` }
    const gate = allows('ocr', { reason: input.name || '留痕截图' })
    if (!gate.ok) return { ok: false, error: gate.error, blocked: gate.block }
    const engine0 = getAccess().ocrEngine
    if (engine0 === 'off') return { ok: false, error: '文字识别已关闭（设置 → 附件与存储 → 附件内容读取）' }
    // 非 macOS：本机识字（Windows 系统文字识别 / tesseract）可用就用；不可用而用户允许 AI（allowsAI + 上面的 ocr 授权）时改走 AI 识字
    const mac = localOcrSupported()
    const probe = mac || engine0 === 'ai' ? null : await localOcrStatus().catch(() => null)
    const ai = deps.getAISettings()
    const pick = chooseOcrEngine(engine0, { macVision: mac, nativeOk: !!probe?.ok, nativeReason: probe?.reason ?? null, aiAllowed: !!ai.enabled && allowsAI(ai.baseURL) })
    if ('error' in pick) return { ok: false, error: pick.error }
    const engine = pick.engine
    const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '')
    const path = join(app.getPath('temp'), `linkto-trace-${randomUUID()}.${ext}`)
    try {
      writeFileSync(path, buf)
      const res = await runOcr(
        path,
        'image',
        engine,
        {
          getAISettings: deps.getAISettings,
          // 非 macOS：常见格式的截图直接发给 AI / 交给本机识字；其他格式或过大的图片借附件正文服务的 pdf-worker 渲染
          render: async (job, timeoutMs) => attachmentText()?.renderForOcr(job, timeoutMs) ?? ({ id: '', ok: false, error: '图片渲染服务尚未就绪，请稍后再试' } as PdfJobResult)
        },
        { filename: input.name ?? undefined }
      )
      if (!res.ok) return { ok: false, error: res.error ?? '识字失败', ...(res.blocked ? { blocked: res.blocked } : {}) }
      const text = (res.text ?? '').trim()
      if (!text) return { ok: false, error: '图片里没有识别到文字' }
      return { ok: true, text, method: res.method, note: res.note ?? null }
    } finally {
      try {
        rmSync(path, { force: true })
      } catch {
        /* 临时文件 */
      }
    }
  }

  const exportTrace = async (e: Electron.IpcMainInvokeEvent, id: string, format: 'md' | 'pdf') => {
    const r = svc.get(String(id))
    if (!r) return { ok: false, error: '留痕不存在' }
    const rec: TraceRecord = { id: r.id, title: r.title, createdAt: r.createdAt, data: r.data }
    const verified = svc.verify(r.id)?.ok ?? null
    const win = BrowserWindow.fromWebContents(e.sender)
    const ext = format === 'pdf' ? 'pdf' : 'md'
    const opt = {
      title: format === 'pdf' ? '导出留痕（PDF）' : '导出留痕（Markdown）',
      defaultPath: join(app.getPath('documents'), `留痕-${ymd(r.data.occurredAt ?? r.createdAt)}-${safeName(r.title)}.${ext}`),
      filters: [format === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'Markdown', extensions: ['md'] }]
    }
    const res = win ? await dialog.showSaveDialog(win, opt) : await dialog.showSaveDialog(opt)
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    if (format === 'md') {
      writeFileSync(res.filePath, traceToMarkdown(rec, { verified }), 'utf8')
      return { ok: true, path: res.filePath }
    }
    // PDF：隐藏窗口渲染存档 HTML 再打印（不显示、不抢焦点；禁用脚本）
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)}</title></head><body style="font-family:-apple-system,'PingFang SC','Helvetica Neue',sans-serif;color:#111;margin:32px;line-height:1.6">${traceToHtml(rec, { verified })}</body></html>`
    const w = new BrowserWindow({ show: false, focusable: false, webPreferences: { sandbox: true, javascript: false, offscreen: false } })
    try {
      await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      const pdf = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } })
      writeFileSync(res.filePath, pdf)
      return { ok: true, path: res.filePath }
    } finally {
      if (!w.isDestroyed()) w.destroy()
    }
  }

  const archiveMail = (id: string) => {
    const r = svc.get(String(id))
    if (!r) return { ok: false, error: '留痕不存在' }
    const accounts = deps.store.listAccounts()
    const acct = accounts.find(a => r.data.links.messageIds.some(m => deps.store.getMessageRow(m)?.account_id === a.id)) ?? accounts.find(a => a.enabled) ?? accounts[0]
    if (!acct) return { ok: false, error: '还没有添加邮件账户' }
    const rec: TraceRecord = { id: r.id, title: r.title, createdAt: r.createdAt, data: r.data }
    deps.openCompose({
      accountId: acct.id,
      to: [{ address: acct.email }],
      subject: `[留痕存档] ${r.title}（${fmtTraceTime(r.data.occurredAt, false)}）`.slice(0, 140),
      html: traceToHtml(rec, { verified: svc.verify(r.id)?.ok ?? null, forMail: true })
    })
    return { ok: true }
  }

  const handlers: Record<string, (...args: any[]) => unknown> = {
    traceList: () => svc.list(),
    traceCreate: async (input: any, opts?: { organize?: 'ai' | 'template' | null }) => {
      const id = svc.create({ ...(input ?? {}), source: input?.source ?? 'manual' })
      if (!opts?.organize) return { id }
      const organized = await svc.organize(id, opts.organize)
      return { id, organized }
    },
    traceUpdate: (id: string, patch: TraceUpdatePatch, reason?: string) => svc.update(String(id), patch ?? {}, reason ? String(reason).slice(0, 80) : '修改'),
    traceDelete: (id: string) => svc.remove(String(id)),
    traceOrganize: (id: string, mode: 'ai' | 'template') => svc.organize(String(id), mode === 'template' ? 'template' : 'ai'),
    traceOcrImage: (input: { dataUrl: string; name?: string | null }) => ocrImage(input ?? ({} as never)),
    traceConfirmDraft: (id: string, opts?: { to?: string[]; waitDays?: number }) => svc.confirmDraft(String(id), opts ?? {}),
    traceCheckReplies: () => svc.checkConfirmations(),
    traceFromMessage: (messageId: string) => svc.fromMessage(String(messageId)),
    traceMakeTodo: (id: string, index?: number | null) => svc.makeTodo(String(id), index == null ? null : Number(index)),
    traceRemember: (id: string, index: number) => svc.remember(String(id), Number(index)),
    traceVerify: (id: string) => svc.verify(String(id)),
    traceArchiveMail: (id: string) => archiveMail(id),
    traceOpenCapture: () => deps.openCapture(),
    traceCapabilities: async () => {
      const a = svc.aiAvailable()
      let ocr = null
      try {
        ocr = await ocrAvailability(deps.getAISettings())
      } catch {
        ocr = null
      }
      return { ...a, ocr }
    },
    traceSyncStatus: () => sync!.status(),
    traceSyncConfigure: (input: { enabled: boolean }) => sync!.configure({ enabled: !!input?.enabled }),
    traceSyncNow: () => sync!.syncNow()
  }
  for (const [method, handler] of Object.entries(handlers)) {
    ipcMain.handle(`api:${method}`, async (_e, ...args) => {
      try {
        return await handler(...args)
      } catch (err) {
        console.error(`[ipc:${method}]`, err)
        throw err
      }
    })
  }
  ipcMain.handle('api:traceExport', async (e, id: string, format: 'md' | 'pdf') => {
    try {
      return await exportTrace(e, id, format === 'pdf' ? 'pdf' : 'md')
    } catch (err) {
      console.error('[ipc:traceExport]', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 书面确认对账：发出（发件队列 sent）后、新邮件到达后各看一次，另每分钟兜底
  const check = () => {
    try {
      svc.checkConfirmations()
    } catch (err) {
      console.error('[trace] confirm check failed:', err)
    }
  }
  onOutboxEvent(e => {
    if (e.type === 'sent') setTimeout(check, 1500)
  })
  setTimeout(check, 30_000)
  setInterval(check, 60_000)
  sync.start()
  return svc
}

/** 新邮件到达（在跟进的 onArrival 之后调用）：对方回信可能是书面确认的回复 */
export function traceOnArrival(_messageId: string) {
  if (!service) return
  setTimeout(() => {
    try {
      service?.checkConfirmations()
    } catch (err) {
      console.error('[trace] arrival check failed:', err)
    }
  }, 2000)
}

export function stopTrace() {
  sync?.stop()
}
