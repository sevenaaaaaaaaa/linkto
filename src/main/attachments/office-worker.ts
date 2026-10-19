/**
 * Word / Excel / PowerPoint 正文提取专用 utilityProcess 入口：解压 + XML 文本抽取都是同步 CPU 活，
 * 放在这里跑，主进程只收发消息；超时 / 崩溃由主进程 kill 后下次重新拉起（与 pdf-worker 共用同一套进程池实现）。
 * 只读取 ZIP 里的 XML 文本部件 / 复合文档（旧版 xls / ppt / doc）里的文本记录，从不执行宏、不加载外部资源、不把任何条目写到磁盘。
 */
import { extractOffice, OFFICE_LIMITS } from './office'

export interface OfficeJob {
  id: string
  path: string
  ext: string
  maxChars: number
}

export interface OfficeJobResult {
  id: string
  ok: boolean
  error?: string
  text?: string
  /** docx：页数（文档属性）；xlsx / xls：工作表数；pptx / ppt：幻灯片数 */
  pages?: number
  truncated?: boolean
  format?: string
  ms?: number
}

process.parentPort.on('message', async (e: { data: OfficeJob }) => {
  const job = e.data
  const t0 = Date.now()
  try {
    const r = await extractOffice(job.path, job.ext, { ...OFFICE_LIMITS, maxChars: job.maxChars || OFFICE_LIMITS.maxChars })
    process.parentPort.postMessage({ id: job.id, ok: r.ok, error: r.error, text: r.text, pages: r.pages, truncated: r.truncated, format: r.format, ms: Date.now() - t0 } satisfies OfficeJobResult)
  } catch (err) {
    process.parentPort.postMessage({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies OfficeJobResult)
  }
})
