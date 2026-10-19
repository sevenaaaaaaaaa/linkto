/**
 * 扫描件 / 图片识字（OCR）的纯函数部分：JXA 脚本生成、识别结果整理成文本、AI 视觉消息构造与错误归类。
 * 不依赖 electron，便于单测。
 */
import { aiKindFromHttp, type AIErrorKind } from '@shared/errors'
import { normalizeCjk, tidyText } from './text-parse'

/** 能识字的图片格式（本机识别靠 macOS ImageIO：heic / tiff 也能读） */
export const OCR_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'heic', 'heif', 'tif', 'tiff', 'webp', 'bmp', 'gif'])

export function isOcrImage(ext: string, contentType?: string | null): boolean {
  const e = (ext || '').toLowerCase()
  const ct = (contentType || '').toLowerCase()
  return OCR_IMAGE_EXTS.has(e) || /^image\/(png|jpe?g|heic|heif|tiff|webp|bmp|gif)$/.test(ct)
}

/** OCR 上限：本机识别页数 / AI 识别页数 / 渲染长边像素 / 本机识别超时（首次加载识别模型较慢） */
export const OCR_LIMITS = {
  localMaxPages: 30,
  aiMaxPages: 10,
  localMaxDim: 2400,
  aiMaxDim: 1600,
  maxFileBytes: 60 * 1024 * 1024,
  localBaseTimeoutMs: 45_000,
  localPerPageMs: 6_000,
  localMaxTimeoutMs: 240_000,
  aiPageTimeoutMs: 120_000
}

// ---------------------------------------------------------------- JXA（macOS 文字识别）

export interface JxaConfig {
  /** 文件绝对路径 */
  path: string
  kind: 'pdf' | 'image'
  maxPages: number
  /** 渲染长边像素上限 */
  maxDim: number
  /** 是否做本机文字识别（false = 只渲染出图片给 AI） */
  ocr: boolean
  /** 页面图片（JPEG）输出目录；null = 不输出 */
  outDir: string | null
  langs: string[]
}

/** 识别出的一行（Vision 的 boundingBox：0~1 归一化，原点在左下角） */
export interface OcrLine {
  t: string
  c: number
  x: number
  y: number
  w: number
  h: number
}

export interface OcrPage {
  w: number
  h: number
  lines?: OcrLine[]
  /** 渲染出的页面图片路径（outDir 有值时） */
  image?: string
  error?: string
}

export interface JxaResult {
  ok: boolean
  error?: string
  /** 文档总页数（图片 = 1） */
  total: number
  pages: OcrPage[]
}

/**
 * 生成 osascript -l JavaScript 脚本：PDF 用 CoreGraphics 逐页渲染成位图（处理旋转、白底），图片用 ImageIO 缩略图（长边上限、按 EXIF 方向摆正），
 * 交给 Vision 的 VNRecognizeTextRequest（accurate + 语言校正）同步识别。进度写 stderr（「P 页 总」），结果 JSON 作为脚本最后的值输出到 stdout。
 * 配置只以 JSON 字面量注入（JSON.stringify，另转义 U+2028/2029），路径里的引号、反斜杠、换行都不会变成代码。
 */
export function buildJxaScript(cfg: JxaConfig): string {
  const lit = JSON.stringify(cfg).replace(/[\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16)}`)
  return `ObjC.import('Foundation'); ObjC.import('CoreGraphics'); ObjC.import('ImageIO'); ObjC.import('Vision'); ObjC.import('AppKit')
const CFG = ${lit}
function recognize(cg) {
  const req = $.VNRecognizeTextRequest.alloc.init
  req.setRecognitionLevel(0)
  req.setUsesLanguageCorrection(true)
  req.setRecognitionLanguages($(CFG.langs))
  const h = $.VNImageRequestHandler.alloc.initWithCGImageOptions(cg, $({}))
  const err = Ref()
  if (!h.performRequestsError($([req]), err)) return { error: 'vision' }
  const res = req.results
  const lines = []
  for (let i = 0; i < res.count; i++) {
    const o = res.objectAtIndex(i)
    const c = o.topCandidates(1)
    if (!c.count) continue
    const top = c.objectAtIndex(0)
    const b = o.boundingBox
    lines.push({ t: top.string.js, c: Number(top.confidence), x: Number(b.origin.x), y: Number(b.origin.y), w: Number(b.size.width), h: Number(b.size.height) })
  }
  return { lines }
}
function saveJpeg(cg, file) {
  const rep = $.NSBitmapImageRep.alloc.initWithCGImage(cg)
  const data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypeJPEG, $({ NSImageCompressionFactor: 0.82 }))
  data.writeToFileAtomically($(file), true)
}
function handle(cg, i, n, out) {
  const page = { w: Number($.CGImageGetWidth(cg)), h: Number($.CGImageGetHeight(cg)) }
  if (CFG.ocr) Object.assign(page, recognize(cg))
  if (CFG.outDir) {
    const file = CFG.outDir + '/p' + i + '.jpg'
    saveJpeg(cg, file)
    page.image = file
  }
  out.pages.push(page)
  console.log('P ' + i + ' ' + n)
}
function runPdf() {
  const doc = $.CGPDFDocumentCreateWithURL($.NSURL.fileURLWithPath($(CFG.path)))
  if (!doc || doc.isNil && doc.isNil()) return { ok: false, error: 'open', total: 0, pages: [] }
  if (!$.CGPDFDocumentIsUnlocked(doc) && !$.CGPDFDocumentUnlockWithPassword(doc, '')) return { ok: false, error: 'locked', total: 0, pages: [] }
  const total = Number($.CGPDFDocumentGetNumberOfPages(doc))
  if (!(total > 0)) return { ok: false, error: 'open', total: 0, pages: [] }
  const n = Math.min(total, CFG.maxPages)
  const out = { ok: true, total: total, pages: [] }
  for (let i = 1; i <= n; i++) {
    const page = $.CGPDFDocumentGetPage(doc, i)
    const box = $.CGPDFPageGetBoxRect(page, 1)
    const rot = Number($.CGPDFPageGetRotationAngle(page))
    let pw = Number(box.size.width), ph = Number(box.size.height)
    if (rot % 180 !== 0) { const t = pw; pw = ph; ph = t }
    if (!(pw > 0 && ph > 0)) continue
    const scale = Math.min(4, CFG.maxDim / Math.max(pw, ph))
    const W = Math.max(1, Math.round(pw * scale)), H = Math.max(1, Math.round(ph * scale))
    const ctx = $.CGBitmapContextCreate(null, W, H, 8, 0, $.CGColorSpaceCreateDeviceRGB(), 1)
    $.CGContextSetRGBFillColor(ctx, 1, 1, 1, 1)
    $.CGContextFillRect(ctx, $.CGRectMake(0, 0, W, H))
    $.CGContextConcatCTM(ctx, $.CGPDFPageGetDrawingTransform(page, 1, $.CGRectMake(0, 0, W, H), 0, true))
    $.CGContextDrawPDFPage(ctx, page)
    handle($.CGBitmapContextCreateImage(ctx), i, n, out)
  }
  return out
}
function runImage() {
  const src = $.CGImageSourceCreateWithURL($.NSURL.fileURLWithPath($(CFG.path)), null)
  if (!src || src.isNil && src.isNil()) return { ok: false, error: 'open', total: 0, pages: [] }
  const opts = $({ kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: CFG.maxDim, kCGImageSourceCreateThumbnailWithTransform: true })
  const cg = $.CGImageSourceCreateThumbnailAtIndex(src, 0, opts)
  if (!cg || cg.isNil && cg.isNil()) return { ok: false, error: 'decode', total: 1, pages: [] }
  const out = { ok: true, total: 1, pages: [] }
  handle(cg, 1, 1, out)
  return out
}
JSON.stringify(CFG.kind === 'pdf' ? runPdf() : runImage())
`
}

/** 解析 osascript 的 stdout（最后一个 JSON 对象）；失败返回 null */
export function parseJxaOutput(stdout: string): JxaResult | null {
  const s = stdout.trim()
  const start = s.indexOf('{')
  if (start < 0) return null
  try {
    const r = JSON.parse(s.slice(start)) as JxaResult
    if (!r || !Array.isArray(r.pages)) return null
    return { ok: !!r.ok, error: r.error, total: Number(r.total) || r.pages.length, pages: r.pages }
  } catch {
    return null
  }
}

/** stderr 进度行「P 3 10」→ { done: 3, total: 10 } */
export function parseJxaProgress(line: string): { done: number; total: number } | null {
  const m = /^P (\d+) (\d+)\s*$/.exec(line.trim())
  return m ? { done: Number(m[1]), total: Number(m[2]) } : null
}

export function jxaErrorText(code?: string): string {
  if (code === 'locked') return 'PDF 已加密，需要密码'
  if (code === 'open') return '无法打开这个文件'
  if (code === 'decode') return '无法解码这张图片'
  return code ? `文字识别失败（${code}）` : '文字识别失败'
}

// ---------------------------------------------------------------- 识别结果 → 文本

/**
 * 一页的识别行 → 文本：按版面从上到下分行（纵向重叠过半的视为同一行，如表格的各列），
 * 同一行内按横坐标排列，间隔大的用两个空格分开（保留表格列感），段落间（行距明显变大）空一行。
 */
export function linesToText(lines: OcrLine[]): string {
  const items = lines
    .map(l => ({ ...l, t: (l.t ?? '').trim(), top: 1 - (l.y + l.h), mid: 1 - (l.y + l.h / 2) }))
    .filter(l => l.t && Number.isFinite(l.x) && Number.isFinite(l.y))
    .sort((a, b) => a.mid - b.mid || a.x - b.x)
  type Item = (typeof items)[number]
  const rows: { mid: number; h: number; top: number; bottom: number; items: Item[] }[] = []
  for (const it of items) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(it.mid - row.mid) < Math.min(row.h, it.h) * 0.5) {
      row.items.push(it)
      row.top = Math.min(row.top, it.top)
      row.bottom = Math.max(row.bottom, it.top + it.h)
      continue
    }
    rows.push({ mid: it.mid, h: it.h, top: it.top, bottom: it.top + it.h, items: [it] })
  }
  const heights = rows.map(r => r.h).sort((a, b) => a - b)
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 0
  const out: string[] = []
  let prevBottom: number | null = null
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x)
    let line = ''
    let prev: Item | null = null
    for (const it of r.items) {
      if (prev) {
        const charW = prev.w / Math.max(1, [...prev.t].length)
        const gap = it.x - (prev.x + prev.w)
        // 不同的识别块之间至少一个空格（中文表格的列常被识别成相邻的块）；间隔大的用两个空格保留列感
        line += gap > charW * 1.5 ? '  ' : ' '
      }
      line += it.t
      prev = it
    }
    if (prevBottom != null && medianH > 0 && r.top - prevBottom > medianH * 1.6) out.push('')
    out.push(line)
    prevBottom = r.bottom
  }
  return tidyText(normalizeCjk(out.join('\n')))
}

/** 多页 → 正文（与 PDF 文本层一致：页间用换页符分隔） */
export function pagesToText(pages: string[]): string {
  return pages.map(p => p.trim()).join('\n\f\n')
}

// ---------------------------------------------------------------- AI 视觉

export type VisionContent = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'high' | 'low' | 'auto' } }
export interface VisionMessage {
  role: 'system' | 'user'
  content: string | VisionContent[]
}

/**
 * 一页的多模态消息：系统提示 + [说明文字, 页面图片]。
 * localText 有值 = 「本机 + AI 校对」：把本机识别结果一并给 AI，让它对照图片改错字、还原表格。
 */
export function buildVisionMessages(opts: { system: string; dataUrl: string; page: number; total: number; filename?: string; localText?: string | null }): VisionMessage[] {
  const where = `${opts.filename ? `文件「${opts.filename}」，` : ''}第 ${opts.page} / ${opts.total} 页。`
  const text =
    opts.localText != null
      ? `${where}下面是本机文字识别的结果（可能有错字、漏字、表格被拆散），请对照图片校对后输出：\n<<<\n${opts.localText.slice(0, 12000)}\n>>>`
      : `${where}请识别图片里的全部文字。`
  return [
    { role: 'system', content: opts.system },
    { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: opts.dataUrl, detail: 'high' } }] }
  ]
}

/** 去掉模型输出外层的 ``` 围栏与客套开头 */
export function cleanVisionText(s: string): string {
  let t = (s ?? '').trim()
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(t)
  if (fence) t = fence[1]
  t = t.replace(/^(以下是|下面是)[^\n]{0,30}[:：]\s*\n/, '')
  return tidyText(t)
}

export const VISION_UNSUPPORTED = '当前模型不支持识图，请在设置里填一个支持视觉的模型'

/**
 * 视觉请求的 HTTP 错误归类：模型不支持图片（400 / 415 / 422，或正文提到 image / vision / 多模态）→ 'no-vision'；
 * 其余按 AI 通用分类（auth / quota / model / server …）。
 */
export function classifyVisionError(status: number, body: string): AIErrorKind | 'no-vision' {
  const b = body || ''
  const mentionsImage = /image|vision|multi-?modal|image_url|视觉|图片|图像|识图/i.test(b)
  const sizeIssue = /too (large|big)|exceed|maximum|过大|超过/i.test(b)
  if ((status === 400 || status === 415 || status === 422 || status === 0) && mentionsImage && !sizeIssue) return 'no-vision'
  if ((status === 400 || status === 422) && /content.*(must be a string|type)|unsupported content|expected string/i.test(b)) return 'no-vision'
  return aiKindFromHttp(status, b)
}
