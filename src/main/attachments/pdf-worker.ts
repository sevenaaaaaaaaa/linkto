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

process.parentPort.on('message', async (e: { data: PdfJob }) => {
  const job = e.data
  try {
    process.parentPort.postMessage(await extract(job))
  } catch (err) {
    process.parentPort.postMessage({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies PdfJobResult)
  }
})
