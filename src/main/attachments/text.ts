import { app, ipcMain, powerMonitor, utilityProcess, type UtilityProcess } from 'electron'
import { allows, getAccess } from './access'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AISettings, AttachmentAccessBlock, AttachmentInvoiceFields, AttachmentTextInfo, FinanceData, OcrEngine } from '@shared/types'
import type { MailStore } from '../db'
import type { FinanceService } from '../finance/service'
import { setAttachmentTextReader } from '../agent/hooks'
import { parseEmailRaw } from '../mail/parse-pool'
import type { AttachmentService } from './service'
import type { IndexRow } from './store'
import type { PdfJob, PdfJobResult } from './pdf-worker'
import type { OfficeJob, OfficeJobResult } from './office-worker'
import { textutilToText } from './office'
import { ocrAvailability, runOcr } from './ocr'
import { isOcrImage } from './ocr-parse'
import { onBattery, runAsBackground } from '../jobs/budget'
import {
  checkAgainstPdf,
  classifyByContent,
  decodeBuffer,
  extractInvoiceFields,
  hasInvoiceFields,
  htmlToPlain,
  looksLikeInvoice,
  normalizeCjk,
  OFFICE_EXTS,
  PLAIN_EXTS,
  samePdfCheck,
  solidChars,
  textKindOf,
  tidyText
} from './text-parse'

/**
 * 附件正文：PDF 文本层（pdfjs，独立 utilityProcess）/ Word · Excel · PowerPoint（office.ts，独立 utilityProcess）/ 纯文本类附件（编码探测）/ HTML / eml。
 * 结果缓存在新表 attachment_text（按附件 id；文件哈希变了重新提取）。提取后顺带：
 *  - 拿不准的附件用正文关键词再分类（category_source = 'content'）
 *  - 发票正文抽字段（invoice_json）→ 与同一封邮件的财务记录核对（FinanceData.pdfCheck）
 * 对外：readAttachmentText IPC、hooks.setAttachmentTextReader、Agent read_attachment、知识库学习、附件整理任务的空闲补提取。
 */

export const ATTACHMENT_TEXT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS attachment_text (
    attachment_id TEXT PRIMARY KEY,
    text TEXT,
    method TEXT NOT NULL,
    pages INTEGER DEFAULT 0,
    chars INTEGER DEFAULT 0,
    extracted_at INTEGER,
    error TEXT,
    truncated INTEGER DEFAULT 0,
    encoding TEXT,
    hash TEXT,
    invoice_json TEXT
  );
`

/** 提取上限：页数 / PDF 文件大小 / 纯文本读取字节 / 存库字数 / 单个 PDF 超时 */
export const TEXT_LIMITS = { maxPages: 60, maxPdfBytes: 40 * 1024 * 1024, maxPlainBytes: 4 * 1024 * 1024, maxChars: 200_000, timeoutMs: 15_000 }

interface TextRow {
  attachment_id: string
  text: string | null
  method: string
  pages: number
  chars: number
  extracted_at: number
  error: string | null
  truncated: number
  encoding: string | null
  hash: string | null
  invoice_json: string | null
  ocr_note?: string | null
}

export interface ReadResult {
  ok: boolean
  text?: string
  info?: AttachmentTextInfo
  error?: string
  /** 被授权拦下（界面据此引导用户去授权） */
  blocked?: AttachmentAccessBlock
}

/** 读正文时要不要顺带做文字识别：auto = 扫描件 / 图片按设置的方式识别（需授权）；不传 = 只读文本层与缓存 */
export type OcrWant = 'auto' | Exclude<OcrEngine, 'off'>

function parseInvoice(s: string | null): AttachmentInvoiceFields | null {
  if (!s) return null
  try {
    return JSON.parse(s) as AttachmentInvoiceFields
  } catch {
    return null
  }
}

const OCR_METHODS = new Set(['ocr-local', 'ocr-ai', 'ocr-local+ai'])

function rowInfo(r: TextRow): AttachmentTextInfo {
  const ocr = OCR_METHODS.has(r.method)
  return {
    attachmentId: r.attachment_id,
    method: r.method === 'pdfjs' || r.method === 'plain' || r.method === 'office' || ocr ? (r.method as AttachmentTextInfo['method']) : 'none',
    ...(r.method === 'none' && r.error && /扫描|图片/.test(r.error) ? { needsOcr: true } : {}),
    ...(ocr && r.ocr_note ? { ocrNote: r.ocr_note } : {}),
    pages: r.pages ?? 0,
    chars: r.chars ?? 0,
    extractedAt: r.extracted_at ?? 0,
    error: r.error ?? null,
    truncated: !!r.truncated,
    encoding: r.encoding ?? null,
    invoice: parseInvoice(r.invoice_json)
  }
}

function readHead(path: string, max: number): Buffer {
  const size = statSync(path).size
  const n = Math.min(size, max)
  const buf = Buffer.alloc(n)
  const fd = openSync(path, 'r')
  try {
    let off = 0
    while (off < n) {
      const got = readSync(fd, buf, off, n - off, off)
      if (got <= 0) break
      off += got
    }
    return off < n ? buf.subarray(0, off) : buf
  } finally {
    closeSync(fd)
  }
}

/** RTF 粗略去控制字（只为能搜、能给 AI 看，不追求排版） */
function rtfToPlain(s: string): string {
  return tidyText(
    s
      .replace(/\\par[d]?/g, '\n')
      .replace(/\\'([0-9a-f]{2})/gi, '')
      .replace(/\\u(-?\d+)\??/g, (_, n: string) => String.fromCharCode((Number(n) + 65536) % 65536))
      .replace(/\{\\\*[^{}]*\}/g, '')
      .replace(/\\[a-z]+-?\d* ?/gi, '')
      .replace(/[{}]/g, '')
  )
}

// ---------------------------------------------------------------- PDF 工作进程

/**
 * 懒启动单个 utilityProcess，串行处理；单个文件超时即 kill（下次重新拉起），空闲 90 秒自动退出释放内存。
 * 主进程只做发消息 / 等结果，不碰 PDF 解析。Office 正文用同一实现、另一个入口（office-worker.js）。
 */
class PdfPool<J extends { id: string } = PdfJob, R extends { id: string; ok: boolean; error?: string } = PdfJobResult> {
  constructor(
    private script = 'pdf-worker.js',
    private serviceName = 'linkto-pdf-worker',
    private label = 'PDF'
  ) {}

  private child: UtilityProcess | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private waiters = new Map<string, (r: R) => void>()
  private idleTimer: NodeJS.Timeout | null = null

  private ensure(): UtilityProcess {
    if (this.child) return this.child
    const child = utilityProcess.fork(join(__dirname, this.script), [], { serviceName: this.serviceName })
    child.on('message', (msg: R) => {
      const w = this.waiters.get(msg?.id)
      if (!w) return
      this.waiters.delete(msg.id)
      w(msg)
    })
    child.on('exit', () => {
      if (this.child === child) this.child = null
      for (const [id, w] of this.waiters) w({ id, ok: false, error: `${this.label} 解析进程意外退出` } as R)
      this.waiters.clear()
    })
    this.child = child
    return child
  }

  private kill() {
    const c = this.child
    this.child = null
    try {
      c?.kill()
    } catch {
      /* 已退出 */
    }
  }

  run(job: Omit<J, 'id'>, timeoutMs: number): Promise<R> {
    const next = this.chain.then(() => this.exec({ ...job, id: randomUUID() } as J, timeoutMs))
    this.chain = next.catch(() => {})
    return next
  }

  private exec(job: J, timeoutMs: number): Promise<R> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    return new Promise<R>(resolve => {
      let child: UtilityProcess
      try {
        child = this.ensure()
      } catch (err) {
        return resolve({ id: job.id, ok: false, error: `无法启动 ${this.label} 解析进程：${err instanceof Error ? err.message : String(err)}` } as R)
      }
      const timer = setTimeout(() => {
        this.waiters.delete(job.id)
        this.kill()
        resolve({ id: job.id, ok: false, error: `提取超时（${Math.round(timeoutMs / 1000)} 秒）` } as R)
      }, timeoutMs)
      this.waiters.set(job.id, r => {
        clearTimeout(timer)
        resolve(r)
      })
      child.postMessage(job)
    }).finally(() => {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.kill(), 90_000)
    })
  }

  stop() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.kill()
  }
}

// ---------------------------------------------------------------- 服务

export interface AttachmentTextDeps {
  db: DatabaseSync
  store: MailStore
  attachments: AttachmentService
  finance?: () => FinanceService | null
  event(payload: unknown): void
  /** AI 识字用（baseURL / Key / 模型复用 AI 设置）；不传则只能本机识别 */
  getAISettings?: () => AISettings
}

export class AttachmentTextService {
  private pool = new PdfPool()
  private officePool = new PdfPool<OfficeJob, OfficeJobResult>('office-worker.js', 'linkto-office-worker', 'Office')
  private inflight = new Map<string, Promise<ReadResult>>()
  private backfilling = false

  constructor(private deps: AttachmentTextDeps) {
    deps.db.exec(ATTACHMENT_TEXT_SCHEMA)
    // 新列：识字的降级说明
    try {
      deps.db.exec('ALTER TABLE attachment_text ADD COLUMN ocr_note TEXT')
    } catch {
      /* 已有 */
    }
  }

  stop() {
    this.pool.stop()
    this.officePool.stop()
    if (this.ocrTimer) clearInterval(this.ocrTimer)
  }

  private row(id: string): TextRow | undefined {
    return this.deps.db.prepare('SELECT * FROM attachment_text WHERE attachment_id = ?').get(id) as TextRow | undefined
  }

  /** 页面 / 图片渲染成 JPEG（非 macOS 的识字用；留痕截图识字也借用这个进程） */
  renderForOcr(job: Omit<PdfJob, 'id'>, timeoutMs: number): Promise<PdfJobResult> {
    return this.pool.run(job, timeoutMs)
  }

  /** 已缓存的提取信息（不触发提取） */
  info(id: string): AttachmentTextInfo | null {
    const r = this.row(this.realId(id))
    return r ? rowInfo(r) : null
  }

  /** 批量取缓存信息（attachment_search 结果里带「有正文 / 页数」） */
  infoMany(ids: string[]): Map<string, AttachmentTextInfo> {
    const out = new Map<string, AttachmentTextInfo>()
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400)
      if (!part.length) continue
      const rows = this.deps.db
        .prepare(`SELECT attachment_id, method, pages, chars, extracted_at, error, truncated, encoding, NULL AS text, NULL AS hash, invoice_json FROM attachment_text WHERE attachment_id IN (${part.map(() => '?').join(',')})`)
        .all(...part) as unknown as TextRow[]
      for (const r of rows) out.set(r.attachment_id, rowInfo(r))
    }
    return out
  }

  private realId(id: string): string {
    return this.deps.attachments.getItem(id)?.id ?? id
  }

  private save(id: string, r: Omit<TextRow, 'attachment_id' | 'extracted_at'>) {
    this.deps.db
      .prepare(
        `INSERT INTO attachment_text (attachment_id, text, method, pages, chars, extracted_at, error, truncated, encoding, hash, invoice_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(attachment_id) DO UPDATE SET text=excluded.text, method=excluded.method, pages=excluded.pages, chars=excluded.chars,
           extracted_at=excluded.extracted_at, error=excluded.error, truncated=excluded.truncated, encoding=excluded.encoding,
           hash=excluded.hash, invoice_json=excluded.invoice_json`
      )
      .run(id, r.text, r.method, r.pages, r.chars, Date.now(), r.error, r.truncated, r.encoding, r.hash, r.invoice_json)
  }

  /**
   * 读正文：有缓存（且文件哈希没变）直接返回；否则按附件中心 ensureLocal（缓存 → eml 镜像 → IMAP → 网盘）取回本地后提取。
   * maxChars = 0 只要信息不要正文。opts.download = false 时不为提取去下载（后台补提取用）。
   */
  read(id0: string, maxChars = 20000, opts: { download?: boolean; ocr?: OcrWant } = {}): Promise<ReadResult> {
    const key = this.realId(id0)
    const running = this.inflight.get(key)
    const p = running ?? this.doRead(key, opts).then(r => this.autoOcr(key, r, opts.ocr)).finally(() => this.inflight.delete(key))
    if (!running) this.inflight.set(key, p)
    return p.then(r => (r.ok && r.text != null && maxChars >= 0 ? { ...r, text: r.text.slice(0, maxChars) } : r))
  }

  private async doRead(id: string, opts: { download?: boolean }): Promise<ReadResult> {
    const idx = this.deps.attachments.idx.get(id)
    const att = id.startsWith('r:') ? null : this.deps.store.getAttachment(id)
    if (!idx && !att) return { ok: false, error: '附件记录不存在' }
    const filename = idx?.filename ?? att?.filename ?? ''
    const ext = (idx?.ext || /\.([a-z0-9]{1,10})$/i.exec(filename)?.[1] || '').toLowerCase()
    const kind = textKindOf(ext, idx?.content_type ?? att?.contentType)
    const image = !kind && isOcrImage(ext, idx?.content_type ?? att?.contentType)
    if (!kind && !image) return { ok: false, error: '这种格式暂不支持读取文字（支持 PDF、Word / Excel / PowerPoint、图片识字与 txt / csv / md / html / eml 等纯文本）' }
    // 授权：用户同意前不读取任何附件内容（缓存的正文同样不返回）；Office 按 office 授权，图片按 ocr 授权
    const gate = allows(image ? 'ocr' : kind === 'pdf' ? 'pdf' : kind === 'office' ? 'office' : 'text', { accountId: idx?.account_id ?? null, reason: filename })
    if (!gate.ok) return { ok: false, error: gate.error, blocked: gate.block }
    if (!kind) return this.imageRead(id, idx?.hash ?? null)
    const cached = this.row(id)
    // 缓存有效：文件哈希没变；失败的（超时 / 解析出错）10 分钟后允许重试，扫描件 / 加密 / 不支持的格式 / 超限不重试
    if (cached && (!cached.hash || !idx?.hash || cached.hash === idx.hash)) {
      // 旧版本「.xls / .ppt 暂不支持」「.doc 只在 macOS 支持」的缓存结果：现在能读了，立即重试
      const legacyMiss = cached.method === 'none' && !!cached.error && /旧版 (Excel（\.xls）|PowerPoint（\.ppt）)暂不支持|旧版 Word（\.doc）只在 macOS/.test(cached.error)
      const retry = legacyMiss || (cached.method === 'none' && !!cached.error && !/扫描|图片|加密|暂不支持|过大/.test(cached.error) && Date.now() - cached.extracted_at > 10 * 60_000)
      if (!retry) return { ok: true, text: cached.text ?? '', info: rowInfo(cached) }
    }
    if (opts.download === false && !(idx ? idx.cached && !idx.remote_only : !!att)) return { ok: false, error: '附件不在本地' }
    const local = await this.deps.attachments.ensureLocal(id)
    if (!local.ok || !local.path) return { ok: false, error: local.error ?? '附件无法取得' }
    const realId = local.id ?? id
    const row = this.deps.attachments.idx.get(realId) ?? idx
    const res = await this.extractFile(local.path, kind, ext)
    const hash = row?.hash ?? null
    if (!res.ok) {
      this.save(realId, { text: '', method: 'none', pages: res.pages ?? 0, chars: 0, error: res.error ?? '提取失败', truncated: 0, encoding: null, hash, invoice_json: null })
      const r = this.row(realId)!
      this.deps.event({ type: 'attachment-text', id: realId })
      return { ok: true, text: '', info: rowInfo(r) }
    }
    const text = res.text ?? ''
    const invoice = text ? this.postProcess(realId, row, text) : null
    this.save(realId, {
      text,
      method: text ? res.method : 'none',
      pages: res.pages ?? 0,
      chars: text.length,
      error: text ? null : res.scanned ? '扫描件或纯图片 PDF：没有文本层（需要 OCR）' : '没有可提取的文字',
      truncated: res.truncated ? 1 : 0,
      encoding: res.encoding ?? null,
      hash,
      invoice_json: invoice ? JSON.stringify(invoice) : null
    })
    if (invoice && row) this.checkFinance([row.message_id])
    this.deps.event({ type: 'attachment-text', id: realId })
    const r = this.row(realId)!
    return { ok: true, text, info: rowInfo(r) }
  }

  private async extractFile(
    path: string,
    kind: NonNullable<ReturnType<typeof textKindOf>>,
    ext = ''
  ): Promise<{ ok: boolean; error?: string; text?: string; method: 'pdfjs' | 'plain' | 'office'; pages?: number; truncated?: boolean; scanned?: boolean; encoding?: string | null }> {
    if (kind === 'pdf') {
      const r = await this.pool.run({ path, maxPages: TEXT_LIMITS.maxPages, maxBytes: TEXT_LIMITS.maxPdfBytes, maxChars: TEXT_LIMITS.maxChars }, TEXT_LIMITS.timeoutMs)
      return { ok: r.ok, error: r.error, text: r.text, method: 'pdfjs', pages: r.pages, truncated: r.truncated, scanned: r.scanned }
    }
    if (kind === 'office') {
      // Word / Excel / PowerPoint：解压与 XML 抽取、旧版二进制格式（xls / ppt / doc）解析都在 office-worker 子进程里做（.doc 在 macOS 先试 textutil）
      const r = await this.officePool.run({ path, ext, maxChars: TEXT_LIMITS.maxChars }, TEXT_LIMITS.timeoutMs)
      return { ok: r.ok, error: r.error, text: r.text, method: 'office', pages: r.pages, truncated: r.truncated }
    }
    try {
      if (kind === 'eml') {
        const raw = readHead(path, 20 * 1024 * 1024)
        const parsed = await parseEmailRaw(raw)
        const text = tidyText(parsed.text || (parsed.html ? htmlToPlain(parsed.html) : ''))
        return { ok: true, text: text.slice(0, TEXT_LIMITS.maxChars), method: 'plain', pages: 1, truncated: text.length > TEXT_LIMITS.maxChars, encoding: 'mime' }
      }
      const size = statSync(path).size
      const buf = readHead(path, TEXT_LIMITS.maxPlainBytes)
      const { text: raw, encoding } = decodeBuffer(buf)
      const isRtf = kind !== 'html' && /^\s*\{\\rtf/.test(raw)
      // RTF：macOS 上优先用系统 textutil（能还原 \'xx 编码的中文），失败再粗略去控制字
      const viaTextutil = isRtf && process.platform === 'darwin' ? await textutilToText(path) : null
      let text = viaTextutil?.ok ? (viaTextutil.text ?? '') : kind === 'html' ? htmlToPlain(raw) : isRtf ? rtfToPlain(raw) : tidyText(normalizeCjk(raw))
      const truncated = size > buf.length || text.length > TEXT_LIMITS.maxChars
      text = text.slice(0, TEXT_LIMITS.maxChars)
      return { ok: true, text, method: 'plain', pages: 1, truncated, encoding }
    } catch (err) {
      return { ok: false, error: `读取失败：${err instanceof Error ? err.message : String(err)}`, method: 'plain' }
    }
  }

  /** 提取到正文后：正文关键词再分类；发票正文抽字段（返回给调用方存 invoice_json） */
  private postProcess(id: string, row: IndexRow | undefined, text: string): AttachmentInvoiceFields | null {
    let category = row?.category ?? 'other'
    if (row && !row.skip) {
      const res = classifyByContent({ category: row.category as never, confidence: row.confidence ?? 0, source: row.category_source }, text)
      if (res) {
        // category_source = 'content'：界面按「规则」展示；重建索引 / AI 补充分类都不会覆盖它，手动修改仍可覆盖
        this.deps.db.prepare(`UPDATE attachment_index SET category = ?, category_source = 'content', confidence = ?, ai_checked = 1 WHERE id = ?`).run(res.category, res.confidence, id)
        if (res.category !== row.category) this.deps.event({ type: 'attachments-changed' })
        category = res.category
      }
    }
    if (category !== 'invoice' && !looksLikeInvoice(text)) return null
    const f = extractInvoiceFields(text)
    return hasInvoiceFields(f) ? f : null
  }

  // ---------------------------------------------------------------- 财务核对

  /**
   * 有发票 PDF（同一封邮件的附件、已抽到金额 / 发票号）的财务记录：逐条核对，结果写进 FinanceData.pdfCheck。
   * messageIds 为空 = 全部记录。有改动时重新对账（PDF 发票号参与配对）。返回改动条数。
   */
  checkFinance(messageIds?: string[]): number {
    const fin = this.deps.finance?.()
    if (!fin) return 0
    // 授权收回后不再用缓存的发票正文核对
    if (!getAccess().readContent) return 0
    const want = messageIds?.length ? new Set(messageIds) : null
    const rows = fin.rows(false).filter(r => !want || r.data.messageIds?.some(m => want.has(m)))
    if (!rows.length) return 0
    const msgIds = [...new Set(rows.flatMap(r => r.data.messageIds ?? []))]
    const pdfs = new Map<string, { attachmentId: string; f: AttachmentInvoiceFields }[]>()
    for (let i = 0; i < msgIds.length; i += 400) {
      const part = msgIds.slice(i, i + 400)
      const list = this.deps.db
        .prepare(
          `SELECT t.attachment_id, t.invoice_json, i.message_id FROM attachment_text t JOIN attachment_index i ON i.id = t.attachment_id
           WHERE t.invoice_json IS NOT NULL AND i.skip = 0 AND i.message_id IN (${part.map(() => '?').join(',')}) ORDER BY i.date DESC, i.id`
        )
        .all(...part) as { attachment_id: string; invoice_json: string; message_id: string }[]
      for (const r of list) {
        const f = parseInvoice(r.invoice_json)
        if (!hasInvoiceFields(f)) continue
        pdfs.set(r.message_id, [...(pdfs.get(r.message_id) ?? []), { attachmentId: r.attachment_id, f }])
      }
    }
    let changed = 0
    const normNo = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    for (const r of rows) {
      const d = r.data as FinanceData
      const cands = (d.messageIds ?? []).flatMap(m => pdfs.get(m) ?? [])
      if (!cands.length) continue
      // 多张发票时优先发票号相同的，其次金额相同的
      const pick =
        cands.find(c => d.invoiceNo && c.f.invoiceNo && normNo(c.f.invoiceNo) === normNo(d.invoiceNo)) ??
        cands.find(c => d.amount != null && c.f.total != null && Math.abs(c.f.total - d.amount) < 0.01) ??
        cands[0]
      const check = checkAgainstPdf({ amount: d.amount, currency: d.currency, invoiceNo: d.invoiceNo }, pick.f, pick.attachmentId)
      if (!check || samePdfCheck(d.pdfCheck, check)) continue
      this.deps.store.updateInsight(r.id, { data: { pdfCheck: check } })
      changed++
    }
    if (changed) {
      try {
        fin.reconcile()
      } catch {
        /* 对账失败不影响核对结果 */
      }
      this.deps.event({ type: 'finance-changed' })
    }
    return changed
  }

  // ---------------------------------------------------------------- 给其他模块用

  /** 已缓存的正文节选（不触发提取）：messageId → 文本（多个附件拼接） */
  cachedTextsForMessages(messageIds: string[], maxChars = 4000, onlyPdf = true): Map<string, string> {
    const out = new Map<string, string>()
    // 授权收回后缓存的正文也不再交出去
    const access = getAccess()
    if (!access.readContent || (onlyPdf && !access.kinds.pdf)) return out
    const excluded = new Set(access.excludedAccounts)
    for (let i = 0; i < messageIds.length; i += 400) {
      const part = messageIds.slice(i, i + 400)
      if (!part.length) continue
      const rows = this.deps.db
        .prepare(
          `SELECT i.message_id, i.account_id, substr(t.text, 1, ?) AS text FROM attachment_text t JOIN attachment_index i ON i.id = t.attachment_id
           WHERE i.message_id IN (${part.map(() => '?').join(',')}) AND t.method != 'none' AND i.skip = 0${onlyPdf ? ` AND (t.method IN ('pdfjs', 'office') OR (t.method LIKE 'ocr-%' AND i.ext = 'pdf'))` : ''}
           ORDER BY i.id`
        )
        .all(maxChars, ...part) as { message_id: string; account_id: string; text: string }[]
      for (const r of rows) {
        if (excluded.has(r.account_id)) continue
        const prev = out.get(r.message_id)
        out.set(r.message_id, (prev ? `${prev}\n\n` : '') + r.text)
      }
    }
    for (const [k, v] of out) out.set(k, v.slice(0, maxChars))
    return out
  }

  /** 一封邮件的 PDF 附件正文节选（必要时现取现提取，最多 2 个 PDF） */
  async pdfExcerpt(messageId: string, maxChars = 3000): Promise<{ text: string; files: string[] }> {
    // PDF 优先，其次 Word / PowerPoint / Excel 文档
    const rows = this.deps.attachments.idx
      .byMessage(messageId)
      .filter(r => !r.skip && (r.ext === 'pdf' || OFFICE_EXTS.has(r.ext)))
      .sort((a, b) => Number(b.ext === 'pdf') - Number(a.ext === 'pdf'))
      .slice(0, 2)
    const parts: string[] = []
    const files: string[] = []
    for (const r of rows) {
      const res = await this.read(r.id, maxChars)
      if (!res.ok || !res.text) continue
      parts.push(`《${r.filename}》${res.info?.pages ? `（${res.info.pages} 页）` : ''}\n${res.text.replace(/\n\f\n/g, '\n')}`)
      files.push(r.filename)
    }
    return { text: parts.join('\n\n').slice(0, maxChars), files }
  }

  /**
   * 空闲补提取（附件整理任务调用，不阻塞）：本地已缓存、还没提取过的 PDF / 纯文本附件，新的优先，
   * 每轮最多 limit 个、总字节有上限，每个之间让出 300ms；结束后对全部财务记录做一次 PDF 核对。
   */
  async backfill(opts: { limit?: number; maxBytes?: number; since?: number } = {}): Promise<{ extracted: number; scanned: number; failed: number; checked: number }> {
    const out = { extracted: 0, scanned: 0, failed: 0, checked: 0 }
    if (this.backfilling) return out
    this.backfilling = true
    try {
      const limit = Math.max(1, opts.limit ?? 20)
      let budget = opts.maxBytes ?? 150 * 1024 * 1024
      const exts = ['pdf', ...PLAIN_EXTS, ...OFFICE_EXTS]
      const rows = this.deps.db
        .prepare(
          `SELECT i.id, i.size FROM attachment_index i LEFT JOIN attachment_text t ON t.attachment_id = i.id
           WHERE t.attachment_id IS NULL AND i.skip = 0 AND i.cached = 1 AND i.remote_only = 0 AND i.size <= ? AND i.date >= ?
             AND i.ext IN (${exts.map(() => '?').join(',')})
           ORDER BY (i.ext = 'pdf') DESC, i.date DESC LIMIT ?`
        )
        .all(TEXT_LIMITS.maxPdfBytes, opts.since ?? 0, ...exts, limit) as { id: string; size: number }[]
      for (const r of rows) {
        if (budget <= 0) break
        budget -= r.size || 0
        const res = await this.read(r.id, 0, { download: false }).catch(() => ({ ok: false }) as ReadResult)
        if (!res.ok) out.failed++
        else if (res.info?.method === 'none') out.scanned++
        else out.extracted++
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      out.checked = this.checkFinance()
    } finally {
      this.backfilling = false
    }
    return out
  }

  // ---------------------------------------------------------------- 扫描件 / 图片识字（OCR）

  private ocrInflight = new Map<string, Promise<ReadResult>>()
  private ocrTimer: NodeJS.Timeout | null = null
  private ocrBackfilling = false
  private ocrFailed = new Set<string>()

  /** 图片附件：有识字缓存（文件没变）直接返回；否则说明「需要文字识别」（不落库，后台补识别还能找到它） */
  private imageRead(id: string, hash: string | null): ReadResult {
    const cached = this.row(id)
    if (cached && (!cached.hash || !hash || cached.hash === hash)) return { ok: true, text: cached.text ?? '', info: rowInfo(cached) }
    return { ok: true, text: '', info: { attachmentId: id, method: 'none', pages: 1, chars: 0, extractedAt: 0, error: '图片：需要文字识别（OCR）', needsOcr: true } }
  }

  /** read(…, { ocr }) 的后续：扫描件 / 图片且允许识字时，按设置（或指定方式）识别 */
  private async autoOcr(id: string, r: ReadResult, want?: OcrWant): Promise<ReadResult> {
    if (!want || !r.ok || !r.info?.needsOcr) return r
    const engine = want === 'auto' ? getAccess().ocrEngine : want
    if (engine === 'off') return r
    const res = await this.ocr(id, engine, { silent: true })
    return res.ok ? res : r
  }

  /**
   * 对扫描件 PDF / 图片附件做文字识别，结果写进 attachment_text（method = ocr-local / ocr-ai / ocr-local+ai），
   * 之后与文本层一样参与再分类、发票字段抽取、财务核对、知识库与 Agent 读取。进度经事件 'attachment-ocr-progress' 推送。
   */
  ocr(id0: string, engine0?: OcrEngine | null, opts: { download?: boolean; silent?: boolean } = {}): Promise<ReadResult> {
    const key = this.realId(id0)
    const running = this.ocrInflight.get(key)
    if (running) return running
    const p = this.doOcr(key, engine0, opts).finally(() => this.ocrInflight.delete(key))
    this.ocrInflight.set(key, p)
    return p
  }

  private async doOcr(id: string, engine0: OcrEngine | null | undefined, opts: { download?: boolean; silent?: boolean }): Promise<ReadResult> {
    const engine = engine0 ?? getAccess().ocrEngine
    if (engine === 'off') return { ok: false, error: '文字识别已关闭（设置 → 附件与存储 → 附件内容读取）' }
    const idx = this.deps.attachments.idx.get(id)
    const att = id.startsWith('r:') ? null : this.deps.store.getAttachment(id)
    if (!idx && !att) return { ok: false, error: '附件记录不存在' }
    const filename = idx?.filename ?? att?.filename ?? ''
    const ext = (idx?.ext || /\.([a-z0-9]{1,10})$/i.exec(filename)?.[1] || '').toLowerCase()
    const ct = idx?.content_type ?? att?.contentType
    const kind = textKindOf(ext, ct) === 'pdf' ? 'pdf' : isOcrImage(ext, ct) ? 'image' : null
    if (!kind) return { ok: false, error: '只有扫描件 PDF 与图片可以做文字识别' }
    const gate = allows('ocr', { accountId: idx?.account_id ?? null, reason: filename, silent: opts.silent })
    if (!gate.ok) return { ok: false, error: gate.error, blocked: gate.block }
    if (opts.download === false && !(idx ? idx.cached && !idx.remote_only : !!att)) return { ok: false, error: '附件不在本地' }
    const local = await this.deps.attachments.ensureLocal(id)
    if (!local.ok || !local.path) return { ok: false, error: local.error ?? '附件无法取得' }
    const realId = local.id ?? id
    const row = this.deps.attachments.idx.get(realId) ?? idx
    const getAI = this.deps.getAISettings
    const res = await runOcr(
      local.path,
      kind,
      engine,
      { getAISettings: () => (getAI ? getAI() : NO_AI), render: (job, timeoutMs) => this.pool.run(job, timeoutMs) },
      { filename, onProgress: p => this.deps.event({ type: 'attachment-ocr-progress', id: realId, ...p }) }
    )
    if (!res.ok) return { ok: false, error: res.error ?? '文字识别失败', ...(res.blocked ? { blocked: res.blocked } : {}) }
    let text = res.text ?? ''
    const truncated = !!res.truncated || text.length > TEXT_LIMITS.maxChars
    text = text.slice(0, TEXT_LIMITS.maxChars)
    const solid = solidChars(text) > 0
    const invoice = solid ? this.postProcess(realId, row, text) : null
    this.save(realId, {
      text: solid ? text : '',
      method: solid ? (res.method ?? 'ocr-local') : 'none',
      pages: res.pages ?? 0,
      chars: solid ? text.length : 0,
      error: solid ? null : '文字识别没有找到文字',
      truncated: truncated ? 1 : 0,
      encoding: null,
      hash: row?.hash ?? null,
      invoice_json: invoice ? JSON.stringify(invoice) : null
    })
    this.deps.db.prepare('UPDATE attachment_text SET ocr_note = ? WHERE attachment_id = ?').run(res.note ?? null, realId)
    if (invoice && row) this.checkFinance([row.message_id])
    this.deps.event({ type: 'attachment-text', id: realId })
    const r = this.row(realId)!
    return { ok: true, text: r.text ?? '', info: rowInfo(r) }
  }

  /** 清除全部正文缓存（含识字结果），之后按需重新提取；返回删除的条数 */
  clearCache(): number {
    const n = Number(this.deps.db.prepare('DELETE FROM attachment_text').run().changes) || 0
    this.ocrFailed.clear()
    this.deps.event({ type: 'attachment-text', id: null })
    return n
  }

  /** 后台补识别：每 10 分钟看一次，只在接通电源、电脑空闲（≥ 2 分钟无操作）时做，每轮最多 2 份、每天最多 OCR_DAILY 份 */
  startOcrBackfill() {
    if (this.ocrTimer) return
    this.ocrTimer = setInterval(() => void this.ocrBackfill().catch(err => console.error('[ocr] backfill failed:', err)), 10 * 60_000)
    this.ocrTimer.unref?.()
  }

  async ocrBackfill(opts: { force?: boolean } = {}): Promise<{ done: number; skipped: string | null }> {
    const out = { done: 0, skipped: null as string | null }
    const access = getAccess()
    if (access.ocrEngine === 'off') return { ...out, skipped: '文字识别已关闭' }
    if (!allows('ocr', { silent: true }).ok) return { ...out, skipped: '未授权' }
    if (!opts.force) {
      if (onBattery()) return { ...out, skipped: '正在用电池' }
      let idle = 0
      try {
        idle = powerMonitor.getSystemIdleTime()
      } catch {
        idle = 0
      }
      if (idle < 120) return { ...out, skipped: '电脑不空闲' }
    }
    if (this.ocrBackfilling) return { ...out, skipped: '正在进行' }
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const today = (this.deps.db.prepare(`SELECT COUNT(*) AS n FROM attachment_text WHERE method LIKE 'ocr-%' AND extracted_at >= ?`).get(start.getTime()) as { n: number }).n
    const left = Math.min(2, OCR_DAILY - today)
    if (left <= 0) return { ...out, skipped: `今天已识别 ${today} 份（每日上限 ${OCR_DAILY}）` }
    this.ocrBackfilling = true
    try {
      const imgExts = ['png', 'jpg', 'jpeg', 'heic', 'heif', 'tif', 'tiff']
      // 扫描件 PDF（文本层判定为扫描）+ 像票据 / 合同 / 文档的图片（≥ 20KB，避开签名档小图标）
      const rows = this.deps.db
        .prepare(
          `SELECT i.id, i.account_id FROM attachment_index i LEFT JOIN attachment_text t ON t.attachment_id = i.id
           WHERE i.skip = 0 AND i.cached = 1 AND i.remote_only = 0 AND i.size <= ? AND (
             (i.ext = 'pdf' AND t.method = 'none' AND t.error LIKE '%扫描%') OR
             (t.attachment_id IS NULL AND i.size >= 20480 AND i.category IN ('invoice', 'contract', 'quote', 'document') AND i.ext IN (${imgExts.map(() => '?').join(',')}))
           ) ORDER BY i.date DESC LIMIT 40`
        )
        .all(TEXT_LIMITS.maxPdfBytes, ...imgExts) as { id: string; account_id: string }[]
      for (const r of rows) {
        if (out.done >= left) break
        if (this.ocrFailed.has(r.id) || access.excludedAccounts.includes(r.account_id)) continue
        // 后台上下文：AI 识字的每次请求计入后台用量（超上限 / 用电池时直接停）
        const res = await runAsBackground('ocr-backfill', () => this.ocr(r.id, null, { download: false, silent: true })).catch(err => ({ ok: false, error: String(err) }) as ReadResult)
        if (res.ok) out.done++
        else this.ocrFailed.add(r.id)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    } finally {
      this.ocrBackfilling = false
    }
    return out
  }
}

/** 后台补识别每天最多几份（用户主动识别的也计入当天总数） */
const OCR_DAILY = 20

const NO_AI = { enabled: false, baseURL: '', apiKey: '', model: '' } as unknown as AISettings

// ---------------------------------------------------------------- 单例与注册

let current: AttachmentTextService | null = null

export function attachmentText(): AttachmentTextService | null {
  return current
}

/** 创建正文服务：注册 api:readAttachmentText 与 hooks 读取器 */
export function initAttachmentText(deps: AttachmentTextDeps): AttachmentTextService {
  const svc = new AttachmentTextService(deps)
  current = svc
  ipcMain.handle('api:readAttachmentText', async (_event, attachmentId: unknown, maxChars?: unknown) => {
    try {
      const n = typeof maxChars === 'number' && Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 20000
      return await svc.read(String(attachmentId ?? ''), n)
    } catch (err) {
      console.error('[ipc:readAttachmentText]', err)
      throw err
    }
  })
  // 已缓存的提取信息（有正文 / 页数 / 字数；不触发提取、不含正文与发票字段）：附件卡与附件中心显示「有正文 · N 个工作表」
  ipcMain.handle('api:readAttachmentTextInfo', (_event, ids: unknown) => {
    if (!getAccess().readContent || !Array.isArray(ids)) return {}
    const out: Record<string, AttachmentTextInfo> = {}
    for (const [id, info] of svc.infoMany(ids.slice(0, 500).map(String))) out[id] = { ...info, invoice: null }
    return out
  })
  ipcMain.handle('api:ocrStatus', () => ocrAvailability(deps.getAISettings ? deps.getAISettings() : NO_AI))
  ipcMain.handle('api:ocrAttachment', async (_event, attachmentId: unknown, engine?: unknown, maxChars?: unknown) => {
    const e = engine === 'local' || engine === 'ai' || engine === 'local+ai' ? engine : null
    const n = typeof maxChars === 'number' && Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 20000
    const r = await svc.ocr(String(attachmentId ?? ''), e)
    return r.ok && r.text != null ? { ...r, text: r.text.slice(0, n) } : r
  })
  ipcMain.handle('api:clearAttachmentTextCache', () => ({ removed: svc.clearCache() }))
  svc.startOcrBackfill()
  app.on('before-quit', () => svc.stop())
  setAttachmentTextReader(async (id, maxChars) => {
    const r = await svc.read(id, maxChars ?? 20000)
    return r.ok && r.text && solidChars(r.text) > 0 ? r.text : null
  })
  return svc
}
