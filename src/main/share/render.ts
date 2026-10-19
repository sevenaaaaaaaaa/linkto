import { app, BrowserWindow, nativeImage, session } from 'electron'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mountScript, truncateScript } from './print-html'

/**
 * 离屏渲染：隐藏的 BrowserWindow 加载打印版 HTML（独立的内存会话，不带 Cookie），
 * - PDF：webContents.printToPDF
 * - 长图：固定宽度，逐屏 capturePage 后按位图拼接（超长截断并提示）
 */

const PARTITION = 'linkto-share-render'
let guarded = false

function renderSession(allowRemote: boolean) {
  const ses = session.fromPartition(PARTITION)
  if (!guarded) {
    guarded = true
    // 只放行本地打印页与（允许时的）远程图片；其余请求一律拦下
    ses.webRequest.onBeforeRequest((details, cb) => {
      const u = details.url
      if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('devtools:')) return cb({})
      if (/^https?:/i.test(u) && details.resourceType === 'image' && remoteAllowed) return cb({})
      cb({ cancel: true })
    })
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  }
  remoteAllowed = allowRemote
  return ses
}
let remoteAllowed = false

/** 渲染期间串行：会话级的远程图开关与临时文件互不干扰 */
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => {})
  return next
}

async function withPage<T>(html: string, width: number, allowRemote: boolean, fn: (win: BrowserWindow, height: number) => Promise<T>): Promise<T> {
  return serial(async () => {
    const dir = join(app.getPath('temp'), 'linkto-share')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${randomUUID()}.html`)
    writeFileSync(file, html, 'utf8')
    const win = new BrowserWindow({
      show: false,
      width,
      height: VIEW_H,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        session: renderSession(allowRemote),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        backgroundThrottling: false,
        spellcheck: false
      }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', e => e.preventDefault())
    try {
      win.setContentSize(width, VIEW_H)
      await win.loadFile(file)
      const height = Number(await win.webContents.executeJavaScript(mountScript(allowRemote ? 8000 : 1500), true)) || VIEW_H
      return await fn(win, height)
    } finally {
      if (!win.isDestroyed()) win.destroy()
      try {
        unlinkSync(file)
      } catch {
        /* 临时文件 */
      }
    }
  })
}

const VIEW_H = 1000

export async function renderPdf(html: string, allowRemote: boolean, footer?: string): Promise<Buffer> {
  return withPage(html, 900, allowRemote, async win => {
    const data = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.55, bottom: 0.6, left: 0.55, right: 0.55 },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="font-size:7.5px;width:100%;padding:0 12mm;color:#9aa0a6;display:flex;justify-content:space-between;font-family:-apple-system,'PingFang SC',sans-serif"><span>${(footer ?? '').replace(/[<>&]/g, '')}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`
    })
    return Buffer.from(data)
  })
}

export interface PngResult {
  png: Buffer
  width: number
  height: number
  truncated: boolean
}

/**
 * 长图：宽 width CSS 像素，最长 maxHeight CSS 像素（超出截断并在底部提示）。
 * 输出倍率默认跟随屏幕（Retina 2x），总像素过大时降到 1x，避免几百 MB 的位图。
 */
export async function renderPng(html: string, width: number, allowRemote: boolean, maxHeight = 16000): Promise<PngResult> {
  return withPage(html, width, allowRemote, async (win, h0) => {
    const wc = win.webContents
    const t = (await wc.executeJavaScript(truncateScript(maxHeight), true)) as { height: number; truncated: boolean }
    const total = Math.max(1, Math.min(t.height || h0, maxHeight + 200))
    const parts: { bmp: Buffer; w: number; h: number }[] = []
    let outScale = 0
    let outW = 0
    for (let y = 0; y < total; y += VIEW_H) {
      const actual = Number(
        await wc.executeJavaScript(`window.scrollTo(0, ${y}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(window.scrollY))))`, true)
      )
      const img = await wc.capturePage(undefined, { stayHidden: true })
      const sz = img.getSize()
      if (!sz.width || !sz.height) throw new Error('截图为空（渲染窗口没有绘制）')
      const scale = sz.width / width
      if (!outScale) {
        // 位图上限约 160 MB（BGRA 4 字节）
        const budget = 160 * 1024 * 1024
        outScale = width * scale * total * scale * 4 > budget ? Math.max(1, Math.sqrt(budget / (width * total * 4))) : scale
        outScale = Math.min(outScale, scale)
        outW = Math.round(width * outScale)
      }
      const segH = Math.min(VIEW_H, total - y)
      const top = y - actual
      const crop = img.crop({ x: 0, y: Math.round(top * scale), width: sz.width, height: Math.max(1, Math.min(sz.height - Math.round(top * scale), Math.round(segH * scale))) })
      const targetH = Math.max(1, Math.round(segH * outScale))
      const fitted = crop.getSize().width === outW && crop.getSize().height === targetH ? crop : crop.resize({ width: outW, height: targetH, quality: 'best' })
      const fs = fitted.getSize()
      parts.push({ bmp: fitted.toBitmap(), w: fs.width, h: fs.height })
    }
    const w = parts[0]?.w ?? outW
    const rows: Buffer[] = []
    let hSum = 0
    for (const p of parts) {
      if (p.w !== w) continue
      rows.push(p.bmp)
      hSum += p.h
    }
    const out = nativeImage.createFromBitmap(Buffer.concat(rows), { width: w, height: hSum, scaleFactor: 1 })
    return { png: out.toPNG(), width: w, height: hSum, truncated: t.truncated }
  })
}
