import { app } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AISettings, AttachmentAccessBlock, OcrAvailability, OcrEngine } from '@shared/types'
import { AIError, checkAiRequestGuard, isLocalEndpoint } from '../ai/service'
import { OCR_PROOFREAD, OCR_VISION } from '../ai/prompts'
import { allowsAI, getAccess } from './access'
import type { PdfJob, PdfJobResult } from './pdf-worker'
import {
  buildJxaScript,
  buildVisionMessages,
  classifyVisionError,
  cleanVisionText,
  jxaErrorText,
  linesToText,
  OCR_LIMITS,
  pagesToText,
  parseJxaOutput,
  parseJxaProgress,
  VISION_UNSUPPORTED,
  type JxaConfig,
  type JxaResult,
  type VisionMessage
} from './ocr-parse'
import { NATIVE_IMAGE_EXTS, nativeOcrFiles, nativePlatformOf, probeNativeOcr, sniffImageType, type NativeProbe } from './ocr-native'

/**
 * 扫描件 / 图片识字（OCR）。三种方式：
 *  - local：本机识别，不出本机，都在子进程里跑，带超时与页数 / 分辨率上限，不阻塞主进程：
 *    macOS 系统文字识别（Vision，VNRecognizeTextRequest accurate + 语言校正），经 osascript -l JavaScript 的 ObjC 桥调用；
 *    Windows 系统文字识别（Windows.Media.Ocr，经 Windows PowerShell）/ Linux tesseract（如已安装），见 ocr-native.ts；
 *    这两个平台的 PDF 先由 pdf-worker 渲染成图片。
 *  - ai：页面渲染成 JPEG（macOS 用 CoreGraphics，其他平台用 pdf-worker 里的 pdfjs + @napi-rs/canvas），
 *    以 OpenAI 兼容多模态消息逐页发给视觉模型（每页一次请求；云端需要单独授权）。
 *  - local+ai：先本机识别，再把图片 + 本机结果交给 AI 校对错字、还原表格；AI 不可用时退回本机结果。
 * 一次只跑一个识别任务（串行），避免多个大文件同时占满 CPU / 请求。
 */

export type OcrMethod = 'ocr-local' | 'ocr-ai' | 'ocr-local+ai'

export interface OcrRunResult {
  ok: boolean
  error?: string
  blocked?: AttachmentAccessBlock
  text?: string
  method?: OcrMethod
  /** 文档总页数 */
  pages?: number
  /** 只识别了前若干页 */
  truncated?: boolean
  /** 降级说明（如「AI 校对失败，已用本机识别结果」） */
  note?: string | null
  ms?: number
}

export interface OcrProgress {
  stage: 'local' | 'render' | 'ai'
  done: number
  total: number
}

export interface OcrRunDeps {
  getAISettings(): AISettings
  /** pdf-worker 渲染（非 macOS 的 AI 识字） */
  render(job: Omit<PdfJob, 'id'>, timeoutMs: number): Promise<PdfJobResult>
}

const LANGS = ['zh-Hans', 'zh-Hant', 'en-US']

/** 识字用的平台；开发构建可用 LINKTO_OCR_PLATFORM 模拟其他平台（测试 Windows / Linux 分支），正式安装包忽略 */
export function ocrPlatform(): string {
  const o = process.env.LINKTO_OCR_PLATFORM
  return o && !app.isPackaged ? o : process.platform
}

/** macOS 系统文字识别（Vision / JXA）可用；Windows / Linux 的本机识字见 localOcrStatus() */
export function localOcrSupported(): boolean {
  return ocrPlatform() === 'darwin'
}

/** 本机识字能不能用（Windows 要看装没装识字语言，Linux 要看装没装 tesseract；结果有缓存） */
export function localOcrStatus(force = false): Promise<NativeProbe> {
  return probeNativeOcr(nativePlatformOf(ocrPlatform()), undefined, { force })
}

/** AI 识字能不能用：AI 已开启、不是内置小模型（不支持识图）、有 Key 或是本地端点 */
function aiVisionReady(s: AISettings): string | null {
  if (!s.enabled) return '还没有开启 AI（设置 → AI）'
  if (s.baseURL === 'builtin-local') return '内置本地模型不支持识图，请在设置 → AI 里换成支持视觉的模型'
  if (!s.apiKey && !isLocalEndpoint(s.baseURL)) return '还没有填写 AI 的 API Key（设置 → AI）'
  return null
}

export function visionModelOf(s: AISettings): string {
  return (getAccess().visionModel ?? '').trim() || s.model
}

/** 界面用：本机 / AI 识字各自能不能用、为什么（localReason：不能用的原因，或能用但有限制的提示） */
export async function ocrAvailability(s: AISettings): Promise<OcrAvailability> {
  const a = getAccess()
  const aiWhy = aiVisionReady(s)
  const aiLocal = s.baseURL === 'builtin-local' || isLocalEndpoint(s.baseURL)
  const local = await localOcrStatus().catch(err => ({ ok: false, reason: `检测本机识字失败：${err instanceof Error ? err.message : String(err)}`, engine: null }) as Pick<NativeProbe, 'ok' | 'reason' | 'engine'>)
  return {
    platform: ocrPlatform(),
    local: local.ok,
    localReason: local.reason,
    localEngine: local.engine,
    ai: !aiWhy && (aiLocal || a.sendToCloudAI),
    aiReason: aiWhy ?? (aiLocal || a.sendToCloudAI ? null : '还没有允许把附件内容发给云端 AI'),
    aiLocal,
    model: aiWhy ? null : visionModelOf(s),
    engine: a.ocrEngine,
    aiMaxPages: OCR_LIMITS.aiMaxPages,
    localMaxPages: OCR_LIMITS.localMaxPages
  }
}

// ---------------------------------------------------------------- 串行队列

let chain: Promise<unknown> = Promise.resolve()

function queued<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

// ---------------------------------------------------------------- 本机识别（osascript / JXA）

function runJxa(cfg: JxaConfig, onProgress?: (done: number, total: number) => void): Promise<JxaResult> {
  const timeoutMs = Math.min(OCR_LIMITS.localMaxTimeoutMs, OCR_LIMITS.localBaseTimeoutMs + OCR_LIMITS.localPerPageMs * cfg.maxPages)
  return new Promise(resolve => {
    let out = ''
    let errBuf = ''
    let done = false
    const finish = (r: JxaResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', buildJxaScript(cfg)], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      return finish({ ok: false, error: `无法启动系统文字识别：${err instanceof Error ? err.message : String(err)}`, total: 0, pages: [] })
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
      finish({ ok: false, error: `文字识别超时（${Math.round(timeoutMs / 1000)} 秒）`, total: 0, pages: [] })
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      out += d
    })
    child.stderr?.on('data', (d: string) => {
      errBuf += d
      const lines = errBuf.split('\n')
      errBuf = lines.pop() ?? ''
      for (const l of lines) {
        const p = parseJxaProgress(l)
        if (p) onProgress?.(p.done, p.total)
        else if (l.trim()) console.warn('[ocr] osascript:', l.slice(0, 200))
      }
    })
    child.on('error', err => finish({ ok: false, error: `系统文字识别出错：${err.message}`, total: 0, pages: [] }))
    child.on('close', code => {
      const r = parseJxaOutput(out)
      if (r) return finish(r.ok ? r : { ...r, error: jxaErrorText(r.error) })
      finish({ ok: false, error: `系统文字识别失败${code ? `（退出码 ${code}）` : ''}`, total: 0, pages: [] })
    })
  })
}

// ---------------------------------------------------------------- 页面图片

interface PageImages {
  ok: boolean
  error?: string
  total: number
  /** data URL（image/jpeg） */
  urls: string[]
  /** local+ai 时顺带的本机识别文本（与 urls 同序；只在 macOS 有） */
  localTexts?: string[]
}

function tempDir(): string {
  const dir = join(app.getPath('temp'), `linkto-ocr-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function readJpegs(paths: (string | undefined)[]): string[] {
  return paths.map(p => (p ? `data:image/jpeg;base64,${readFileSync(p).toString('base64')}` : ''))
}

/** 渲染页面为图片；withLocal = 同一遍里顺带做本机识别（macOS） */
async function pageImages(path: string, kind: 'pdf' | 'image', deps: OcrRunDeps, opts: { withLocal: boolean; localPages: number; onProgress?: (p: OcrProgress) => void }): Promise<PageImages> {
  if (localOcrSupported()) {
    const dir = tempDir()
    try {
      const r = await runJxa(
        { path, kind, maxPages: opts.withLocal ? opts.localPages : OCR_LIMITS.aiMaxPages, maxDim: opts.withLocal ? 2000 : OCR_LIMITS.aiMaxDim, ocr: opts.withLocal, outDir: dir, langs: LANGS },
        (done, total) => opts.onProgress?.({ stage: opts.withLocal ? 'local' : 'render', done, total })
      )
      if (!r.ok) return { ok: false, error: r.error, total: r.total, urls: [] }
      return {
        ok: true,
        total: r.total,
        urls: readJpegs(r.pages.map(p => p.image)),
        localTexts: opts.withLocal ? r.pages.map(p => linesToText(p.lines ?? [])) : undefined
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  // Windows / Linux：图片能直接发就直接发，其余经 pdf-worker 渲染；withLocal 时再交给本机识字（Windows OCR / tesseract）
  const prep = await prepareImages(path, kind, deps, { maxPages: opts.withLocal ? opts.localPages : OCR_LIMITS.aiMaxPages, maxDim: opts.withLocal ? 2000 : OCR_LIMITS.aiMaxDim, urls: true, files: opts.withLocal, onProgress: opts.onProgress })
  try {
    if (!prep.ok) return { ok: false, error: prep.error, total: prep.total, urls: [] }
    if (!opts.withLocal) return { ok: true, total: prep.total, urls: prep.urls }
    const nat = await runNative(prep.files, opts.onProgress)
    if (!nat.ok) return { ok: false, error: nat.error, total: prep.total, urls: [] }
    return { ok: true, total: prep.total, urls: prep.urls, localTexts: nat.pages }
  } finally {
    prep.cleanup()
  }
}

/** 直接作为 data URL 发给 AI 的图片：常见格式、不太大（大图仍经渲染缩小） */
const DIRECT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
const DIRECT_MAX_BYTES = 2 * 1024 * 1024

interface Prepared {
  ok: boolean
  error?: string
  total: number
  /** data URL（AI 用） */
  urls: string[]
  /** 图片文件（本机识字用） */
  files: string[]
  cleanup(): void
}

/** 非 macOS：准备页面图片（data URL 给 AI、文件给本机识字）；PDF 与本机读不了的图片经 pdf-worker 渲染成 JPEG */
async function prepareImages(path: string, kind: 'pdf' | 'image', deps: OcrRunDeps, o: { maxPages: number; maxDim: number; urls: boolean; files: boolean; onProgress?: (p: OcrProgress) => void }): Promise<Prepared> {
  const noop = () => {}
  if (kind === 'image') {
    // 附件缓存文件没有扩展名：按文件头判断格式
    let type: ReturnType<typeof sniffImageType> = null
    let size = Infinity
    try {
      size = statSync(path).size
      const fd = openSync(path, 'r')
      try {
        const head = Buffer.alloc(16)
        type = sniffImageType(head.subarray(0, readSync(fd, head, 0, 16, 0)))
      } finally {
        closeSync(fd)
      }
    } catch {
      type = null
    }
    const plat = nativePlatformOf(ocrPlatform())
    const nativeOk = !!type && (plat === 'win32' || plat === 'linux') && NATIVE_IMAGE_EXTS[plat].has(type)
    let url: string | null = null
    if (o.urls && type && DIRECT_MIME[type] && size <= DIRECT_MAX_BYTES) {
      try {
        url = `data:${DIRECT_MIME[type]};base64,${readFileSync(path).toString('base64')}`
      } catch {
        url = null
      }
    }
    if ((!o.urls || url) && (!o.files || nativeOk)) return { ok: true, total: 1, urls: url ? [url] : [], files: o.files ? [path] : [], cleanup: noop }
  }
  o.onProgress?.({ stage: 'render', done: 0, total: 1 })
  const r = await deps.render({ path, maxPages: o.maxPages, maxBytes: OCR_LIMITS.maxFileBytes, maxChars: 0, op: 'render', kind, maxDim: o.maxDim }, 30_000 + 8_000 * o.maxPages)
  if (!r.ok || !r.images?.length) return { ok: false, error: r.error ?? '页面渲染失败', total: r.pages ?? 0, urls: [], files: [], cleanup: noop }
  const total = r.pages ?? r.images.length
  const urls = o.urls ? r.images.map(b => `data:image/jpeg;base64,${b}`) : []
  if (!o.files) return { ok: true, total, urls, files: [], cleanup: noop }
  const dir = tempDir()
  const files = r.images.map((b, i) => {
    const f = join(dir, `page-${i + 1}.jpg`)
    writeFileSync(f, Buffer.from(b, 'base64'))
    return f
  })
  return { ok: true, total, urls, files, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Windows / Linux 本机识字（先探测；探测结果有缓存） */
async function runNative(files: string[], onProgress?: (p: OcrProgress) => void): Promise<{ ok: boolean; error?: string; pages: string[] }> {
  const probe = await localOcrStatus()
  if (!probe.ok) return { ok: false, error: probe.reason ?? '本机识字不可用', pages: [] }
  return nativeOcrFiles(probe, files, {
    maxDim: OCR_LIMITS.localMaxDim,
    baseMs: OCR_LIMITS.localBaseTimeoutMs,
    perPageMs: OCR_LIMITS.localPerPageMs * 2,
    onProgress: (done, total) => onProgress?.({ stage: 'local', done, total })
  })
}

// ---------------------------------------------------------------- AI 视觉请求

export class VisionUnsupportedError extends Error {
  constructor() {
    super(VISION_UNSUPPORTED)
    this.name = 'VisionUnsupportedError'
  }
}

function contentOf(json: any): string {
  const c = json?.choices?.[0]?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
  return ''
}

/** 一次多模态请求（非流式）；错误归类：不支持图片 → VisionUnsupportedError，其余 → AIError（中文固定句） */
export async function visionChat(s: AISettings, model: string, messages: VisionMessage[]): Promise<string> {
  checkAiRequestGuard()
  const isLocal = isLocalEndpoint(s.baseURL)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OCR_LIMITS.aiPageTimeoutMs)
  try {
    let res: Response
    try {
      res = await fetch(`${s.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
        body: JSON.stringify({ model, messages, stream: false, temperature: 0, max_tokens: 4096 })
      })
    } catch (err) {
      if (controller.signal.aborted) throw new AIError('timeout', `${Math.round(OCR_LIMITS.aiPageTimeoutMs / 1000)} 秒没有响应`)
      throw new AIError(isLocal ? 'network-local' : 'network', (err as { cause?: { code?: string } })?.cause?.code)
    }
    const body = await res.text().catch(() => '')
    if (!res.ok) throw visionHttpError(res.status, body, model)
    let json: any
    try {
      json = JSON.parse(body)
    } catch {
      throw new Error('AI 识字返回的不是有效 JSON')
    }
    if (json?.error) throw visionHttpError(0, JSON.stringify(json.error), model)
    return contentOf(json)
  } finally {
    clearTimeout(timer)
  }
}

export function visionHttpError(status: number, body: string, model: string): Error {
  const kind = classifyVisionError(status, body)
  if (kind === 'no-vision') return new VisionUnsupportedError()
  if (kind === 'model') return new AIError('model', `「${model}」，在 设置 → 附件与存储 → 视觉模型 里换一个可用的模型`)
  if (kind === 'unknown') return new Error(`AI 识字失败${status ? ` (${status})` : ''}：${body.replace(/\s+/g, ' ').slice(0, 160)}`)
  return new AIError(kind, status ? `HTTP ${status}` : undefined)
}

// ---------------------------------------------------------------- 对外：识别一个文件

export function runOcr(path: string, kind: 'pdf' | 'image', engine: Exclude<OcrEngine, 'off'>, deps: OcrRunDeps, opts: { filename?: string; onProgress?: (p: OcrProgress) => void } = {}): Promise<OcrRunResult> {
  return queued(() => doRun(path, kind, engine, deps, opts))
}

async function doRun(path: string, kind: 'pdf' | 'image', engine0: Exclude<OcrEngine, 'off'>, deps: OcrRunDeps, opts: { filename?: string; onProgress?: (p: OcrProgress) => void }): Promise<OcrRunResult> {
  const t0 = Date.now()
  try {
    if (statSync(path).size > OCR_LIMITS.maxFileBytes) return { ok: false, error: `文件过大（超过 ${OCR_LIMITS.maxFileBytes / 1048576} MB），未识别` }
  } catch {
    return { ok: false, error: '附件文件不存在' }
  }
  // 非 macOS：本机识字（Windows OCR / tesseract）不可用时，local+ai 等同 ai；local 直接说明原因与办法
  let engine = engine0
  if (!localOcrSupported() && engine !== 'ai') {
    const probe = await localOcrStatus()
    if (!probe.ok) {
      if (engine === 'local') return { ok: false, error: probe.reason ?? '这台电脑上没有可用的本机识字，可以在设置 → 附件与存储里改用 AI 识字' }
      engine = 'ai'
    } else if (engine === 'local') {
      const prep = await prepareImages(path, kind, deps, { maxPages: OCR_LIMITS.localMaxPages, maxDim: OCR_LIMITS.localMaxDim, urls: false, files: true, onProgress: opts.onProgress })
      try {
        if (!prep.ok) return { ok: false, error: prep.error }
        const nat = await runNative(prep.files, opts.onProgress)
        if (!nat.ok) return { ok: false, error: nat.error }
        return { ok: true, text: pagesToText(nat.pages), method: 'ocr-local', pages: prep.total, truncated: nat.pages.length < prep.total, ms: Date.now() - t0 }
      } finally {
        prep.cleanup()
      }
    }
  }

  if (engine === 'local') {
    const r = await runJxa({ path, kind, maxPages: OCR_LIMITS.localMaxPages, maxDim: OCR_LIMITS.localMaxDim, ocr: true, outDir: null, langs: LANGS }, (done, total) =>
      opts.onProgress?.({ stage: 'local', done, total })
    )
    if (!r.ok) return { ok: false, error: r.error }
    const text = pagesToText(r.pages.map(p => linesToText(p.lines ?? [])))
    return { ok: true, text, method: 'ocr-local', pages: r.total, truncated: r.pages.length < r.total, ms: Date.now() - t0 }
  }

  const s = deps.getAISettings()
  const why = aiVisionReady(s)
  const cloudOk = allowsAI(s.baseURL)

  if (engine === 'ai') {
    if (why) return { ok: false, error: why }
    if (!cloudOk) return { ok: false, blocked: 'cloud', error: '还没有允许把附件内容发给云端 AI（设置 → 附件与存储 → 附件内容读取）' }
    const imgs = await pageImages(path, kind, deps, { withLocal: false, localPages: 0, onProgress: opts.onProgress })
    if (!imgs.ok) return { ok: false, error: imgs.error }
    const model = visionModelOf(s)
    const pages: string[] = []
    for (let i = 0; i < imgs.urls.length; i++) {
      opts.onProgress?.({ stage: 'ai', done: i, total: imgs.urls.length })
      try {
        const out = await visionChat(s, model, buildVisionMessages({ system: OCR_VISION, dataUrl: imgs.urls[i], page: i + 1, total: imgs.total, filename: opts.filename }))
        pages.push(cleanVisionText(out))
      } catch (err) {
        // 第一页就失败（不支持识图 / Key 无效…）直接报错；后面的页失败保留已识别的部分
        if (!pages.length) return { ok: false, error: err instanceof Error ? err.message : String(err) }
        pages.push('〔本页识别失败〕')
      }
    }
    opts.onProgress?.({ stage: 'ai', done: imgs.urls.length, total: imgs.urls.length })
    return { ok: true, text: pagesToText(pages), method: 'ocr-ai', pages: imgs.total, truncated: imgs.urls.length < imgs.total, ms: Date.now() - t0 }
  }

  // local+ai：一遍渲染 + 本机识别（macOS 同一个 osascript 进程；Windows / Linux 渲染后交给本机识字），前 aiMaxPages 页交给 AI 校对
  const imgs = await pageImages(path, kind, deps, { withLocal: true, localPages: OCR_LIMITS.localMaxPages, onProgress: opts.onProgress })
  if (!imgs.ok) return { ok: false, error: imgs.error }
  const local = imgs.localTexts ?? []
  const localResult = (note: string | null): OcrRunResult => ({ ok: true, text: pagesToText(local), method: 'ocr-local', pages: imgs.total, truncated: local.length < imgs.total, note, ms: Date.now() - t0 })
  if (why) return localResult(`AI 校对没有进行：${why}，已用本机识别结果`)
  if (!cloudOk) return localResult('没有允许把附件内容发给云端 AI，只用了本机识别结果')
  const model = visionModelOf(s)
  const n = Math.min(local.length, OCR_LIMITS.aiMaxPages)
  const out = [...local]
  let fixed = 0
  let lastErr: string | null = null
  for (let i = 0; i < n; i++) {
    opts.onProgress?.({ stage: 'ai', done: i, total: n })
    try {
      const t = cleanVisionText(await visionChat(s, model, buildVisionMessages({ system: OCR_PROOFREAD, dataUrl: imgs.urls[i], page: i + 1, total: imgs.total, filename: opts.filename, localText: local[i] })))
      if (t) {
        out[i] = t
        fixed++
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
      // 不支持识图 / 鉴权 / 额度类错误后面的页也一样会失败：停下，保留本机结果
      if (err instanceof VisionUnsupportedError || err instanceof AIError || (err instanceof Error && err.name === 'BudgetError')) break
    }
  }
  opts.onProgress?.({ stage: 'ai', done: n, total: n })
  if (!fixed) return localResult(`AI 校对失败（${lastErr ?? '没有返回内容'}），已用本机识别结果`)
  const note = fixed < local.length ? `AI 校对了前 ${fixed} 页，其余页为本机识别结果${lastErr ? `（${lastErr}）` : ''}` : null
  return { ok: true, text: pagesToText(out), method: 'ocr-local+ai', pages: imgs.total, truncated: local.length < imgs.total, note, ms: Date.now() - t0 }
}
