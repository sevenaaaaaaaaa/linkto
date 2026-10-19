/**
 * PDF 文本层提取专用 utilityProcess 入口：主进程把文件路径发过来，这里用 pdfjs-dist（legacy 构建）
 * 逐页 getTextContent，整理成文本后回传。CPU 密集的解析全在这个进程里，主进程 UI 不受影响；
 * 超时 / 崩溃由主进程 kill 后下次重新拉起。
 *
 * 注意：utilityProcess 里 process.type === 'utility'，pdfjs 会按「非 Node 环境」初始化，
 * 所以这里显式关闭 worker 内取数（useWorkerFetch: false），并提供基于 fs 的 CMap / 标准字体读取工厂；
 * 解析放在 fake worker（同进程）里跑，禁用字体渲染与 eval。
 */
import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { itemsToText, joinPages, looksScanned, solidChars, type PdfTextItem } from './text-parse'

export interface PdfJob {
  id: string
  path: string
  maxPages: number
  maxBytes: number
  maxChars: number
  /** render = 把页面渲染成 JPEG（AI 识字用，非 macOS 平台；pdfjs + @napi-rs/canvas）；默认提取文本层 */
  op?: 'text' | 'render'
  /** render：pdf 或图片 */
  kind?: 'pdf' | 'image'
  /** render：长边像素上限 */
  maxDim?: number
}

export interface PdfJobResult {
  id: string
  ok: boolean
  error?: string
  text?: string
  /** 文档总页数 */
  pages?: number
  /** 实际读了几页 */
  pagesRead?: number
  scanned?: boolean
  truncated?: boolean
  ms?: number
  /** render：每页 JPEG（base64） */
  images?: string[]
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let pdfjs: any = null
let pdfjsDir = ''

async function loadPdfjs(): Promise<any> {
  if (pdfjs) return pdfjs
  pdfjsDir = dirname(require.resolve('pdfjs-dist/package.json'))
  const build = join(pdfjsDir, 'legacy', 'build')
  // 先装上 worker 模块：pdfjs 发现 globalThis.pdfjsWorker 就在同进程里跑（fake worker），不再另起线程
  ;(globalThis as any).pdfjsWorker = await import(pathToFileURL(join(build, 'pdf.worker.mjs')).href)
  pdfjs = await import(pathToFileURL(join(build, 'pdf.mjs')).href)
  return pdfjs
}

/** 从包目录读 CMap（中日韩预定义编码需要），asar 内也能读 */
class FsCMapReaderFactory {
  constructor(private opts: { baseUrl?: string | null; isCompressed?: boolean }) {}
  async fetch({ name }: { name: string }) {
    const compressed = this.opts.isCompressed !== false
    const file = join(pdfjsDir, 'cmaps', name + (compressed ? '.bcmap' : ''))
    return { cMapData: new Uint8Array(await readFile(file)), isCompressed: compressed }
  }
}

class FsStandardFontDataFactory {
  constructor(_opts: { baseUrl?: string | null }) {}
  async fetch({ filename }: { filename: string }) {
    return new Uint8Array(await readFile(join(pdfjsDir, 'standard_fonts', filename)))
  }
}

async function extract(job: PdfJob): Promise<PdfJobResult> {
  const t0 = Date.now()
  const size = statSync(job.path).size
  if (size > job.maxBytes) return { id: job.id, ok: false, error: `文件过大（${Math.round(size / 1048576)} MB），未提取` }
  const lib = await loadPdfjs()
  const data = new Uint8Array(readFileSync(job.path))
  const task = lib.getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'standard_fonts/',
    CMapReaderFactory: FsCMapReaderFactory,
    StandardFontDataFactory: FsStandardFontDataFactory,
    verbosity: 0
  })
  let doc: any
  try {
    doc = await task.promise
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/password/i.test(msg) || (err as any)?.name === 'PasswordException') return { id: job.id, ok: false, error: 'PDF 已加密，需要密码' }
    return { id: job.id, ok: false, error: `无法解析 PDF：${msg}` }
  }
  try {
    const total = doc.numPages as number
    const n = Math.min(total, job.maxPages)
    const pages: string[] = []
    let chars = 0
    let truncated = n < total
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false })
      const t = itemsToText(tc.items as PdfTextItem[])
      page.cleanup()
      pages.push(t)
      chars += t.length
      if (chars > job.maxChars) {
        truncated = true
        break
      }
    }
    const solid = pages.reduce((s, p) => s + solidChars(p), 0)
    if (looksScanned(solid, pages.length)) return { id: job.id, ok: true, text: '', pages: total, pagesRead: pages.length, scanned: true, truncated, ms: Date.now() - t0 }
    let text = joinPages(pages)
    if (text.length > job.maxChars) {
      text = text.slice(0, job.maxChars)
      truncated = true
    }
    return { id: job.id, ok: true, text, pages: total, pagesRead: pages.length, scanned: false, truncated, ms: Date.now() - t0 }
  } finally {
    void doc.destroy().catch(() => {})
  }
}

// ---------------------------------------------------------------- 渲染成图片（AI 识字）

let napiCanvas: any = null

/** @napi-rs/canvas（pdfjs 的可选依赖）：提供画布，并补上 pdfjs 渲染要用的 DOMMatrix / ImageData / Path2D */
function loadCanvas(): any {
  if (napiCanvas) return napiCanvas
  napiCanvas = require('@napi-rs/canvas')
  const g = globalThis as any
  if (!g.DOMMatrix) g.DOMMatrix = napiCanvas.DOMMatrix
  if (!g.ImageData) g.ImageData = napiCanvas.ImageData
  if (!g.Path2D) g.Path2D = napiCanvas.Path2D
  return napiCanvas
}

class NapiCanvasFactory {
  constructor(_opts: unknown) {}
  create(width: number, height: number) {
    const canvas = loadCanvas().createCanvas(Math.max(1, width), Math.max(1, height))
    return { canvas, context: canvas.getContext('2d') }
  }
  reset(cc: { canvas: any }, width: number, height: number) {
    cc.canvas.width = width
    cc.canvas.height = height
  }
  destroy(cc: { canvas: any; context: any }) {
    if (cc.canvas) {
      cc.canvas.width = 0
      cc.canvas.height = 0
    }
    cc.canvas = null
    cc.context = null
  }
}

/** utilityProcess 里没有 document：滤镜（传输函数 / 高对比度）一律不用 */
class NoopFilterFactory {
  constructor(_opts: unknown) {}
  addFilter() {
    return 'none'
  }
  addHCMFilter() {
    return 'none'
  }
  addAlphaFilter() {
    return 'none'
  }
  addLuminosityFilter() {
    return 'none'
  }
  addHighlightHCMFilter() {
    return 'none'
  }
  destroy() {}
}

async function render(job: PdfJob): Promise<PdfJobResult> {
  const t0 = Date.now()
  const size = statSync(job.path).size
  if (size > job.maxBytes) return { id: job.id, ok: false, error: `文件过大（${Math.round(size / 1048576)} MB），未识别` }
  const canvasLib = loadCanvas()
  const maxDim = job.maxDim ?? 1600
  if (job.kind === 'image') {
    const img = await canvasLib.loadImage(readFileSync(job.path))
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
    const c = canvasLib.createCanvas(Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)))
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(img, 0, 0, c.width, c.height)
    const buf: Buffer = await c.encode('jpeg', 82)
    return { id: job.id, ok: true, pages: 1, pagesRead: 1, images: [buf.toString('base64')], ms: Date.now() - t0 }
  }
  const lib = await loadPdfjs()
  const task = lib.getDocument({
    data: new Uint8Array(readFileSync(job.path)),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'standard_fonts/',
    CMapReaderFactory: FsCMapReaderFactory,
    StandardFontDataFactory: FsStandardFontDataFactory,
    CanvasFactory: NapiCanvasFactory,
    FilterFactory: NoopFilterFactory,
    verbosity: 0
  })
  let doc: any
  try {
    doc = await task.promise
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/password/i.test(msg) || (err as any)?.name === 'PasswordException') return { id: job.id, ok: false, error: 'PDF 已加密，需要密码' }
    return { id: job.id, ok: false, error: `无法解析 PDF：${msg}` }
  }
  try {
    const total = doc.numPages as number
    const n = Math.min(total, job.maxPages)
    const images: string[] = []
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: Math.min(4, maxDim / Math.max(base.width, base.height)) })
      const c = canvasLib.createCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)))
      const ctx = c.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, c.width, c.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      const buf: Buffer = await c.encode('jpeg', 82)
      images.push(buf.toString('base64'))
      page.cleanup()
    }
    return { id: job.id, ok: true, pages: total, pagesRead: n, images, truncated: n < total, ms: Date.now() - t0 }
  } finally {
    void doc.destroy().catch(() => {})
  }
}

process.parentPort.on('message', async (e: { data: PdfJob }) => {
  const job = e.data
  try {
    process.parentPort.postMessage(job.op === 'render' ? await render(job) : await extract(job))
  } catch (err) {
    process.parentPort.postMessage({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies PdfJobResult)
  }
})
