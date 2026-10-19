import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { linesToText, type OcrLine } from './ocr-parse'

/**
 * Windows / Linux 的本机识字（不依赖 electron；子进程启动函数可注入，便于单测 mock）：
 *  - Windows：系统自带的 Windows.Media.Ocr（WinRT），经 Windows PowerShell 5.1 调用。脚本是固定文本（-EncodedCommand），
 *    图片路径 / 语言 / 尺寸上限只经环境变量里的 JSON 传入，从不拼进命令行或脚本；输出 JSON 里的非 ASCII 字符全部 \uXXXX 转义，与控制台代码页无关。
 *    语言按系统已安装的识字语言选（简体中文 → 繁体中文 → 英文 → 用户语言），一个都没有时给出安装指引。
 *  - Linux：tesseract（如已安装），execFile 不经 shell，TSV 输出带坐标，复用 macOS 的版面整理（linesToText）。
 * 都在子进程里跑，带超时与输出上限。
 */

export type NativePlatform = 'darwin' | 'win32' | 'linux' | 'other'

export function nativePlatformOf(p: string): NativePlatform {
  return p === 'darwin' || p === 'win32' || p === 'linux' ? p : 'other'
}

/** 本机识字直接能读的图片（按文件头判断的格式；其余格式先经 pdf-worker 渲染成 JPEG） */
export const NATIVE_IMAGE_EXTS: Record<'win32' | 'linux', Set<string>> = {
  win32: new Set(['png', 'jpg', 'bmp', 'gif', 'tiff']),
  linux: new Set(['png', 'jpg', 'bmp', 'tiff'])
}

/** 按文件头判断图片格式（附件缓存文件没有扩展名）；认不出返回 null */
export function sniffImageType(head: Uint8Array): 'png' | 'jpg' | 'gif' | 'bmp' | 'tiff' | 'webp' | null {
  const b = head
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return 'tiff'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  return null
}

// ---------------------------------------------------------------- 子进程

export interface ProcResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** 启动失败（ENOENT 等） */
  spawnError?: string
}

export interface ProcOptions {
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  maxBytes?: number
  /** stderr 每一行（进度） */
  onStderrLine?(line: string): void
}

export type Runner = (cmd: string, args: string[], opts: ProcOptions) => Promise<ProcResult>

/** 默认的子进程执行：不经 shell、隐藏窗口、超时 kill、输出上限 */
export const runProcess: Runner = (cmd, args, opts) =>
  new Promise(done => {
    let out = ''
    let err = ''
    let errBuf = ''
    let finished = false
    const max = opts.maxBytes ?? 32 * 1024 * 1024
    const finish = (r: ProcResult) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      done(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
    } catch (e) {
      return finish({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: (e as NodeJS.ErrnoException)?.code ?? String(e) })
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
      finish({ code: null, stdout: out, stderr: err, timedOut: true })
    }, opts.timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      if (out.length < max) out += d
    })
    child.stderr?.on('data', (d: string) => {
      if (err.length < 1024 * 1024) err += d
      errBuf += d
      const lines = errBuf.split(/\r?\n/)
      errBuf = lines.pop() ?? ''
      for (const l of lines) opts.onStderrLine?.(l)
    })
    child.on('error', e => finish({ code: null, stdout: out, stderr: err, timedOut: false, spawnError: (e as NodeJS.ErrnoException).code ?? e.message }))
    child.on('close', code => finish({ code, stdout: out, stderr: err, timedOut: false }))
  })

/** stderr 进度行「P 3 10」 */
export function parseProgressLine(line: string): { done: number; total: number } | null {
  const m = /^P (\d+) (\d+)\s*$/.exec(line.trim())
  return m ? { done: Number(m[1]), total: Number(m[2]) } : null
}

// ---------------------------------------------------------------- 识别词 → 行

export interface OcrWord {
  t: string
  /** 像素坐标（原点左上角） */
  x: number
  y: number
  w: number
  h: number
}

const CJK = /[\u2e80-\u9fff\u3000-\u303f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

/**
 * 同一行的词按横坐标拼接：中日韩文字之间不加空格（Windows OCR / tesseract 会把每个汉字识别成单独的词），
 * 拉丁文字之间、或间隔明显（超过半个行高）时加一个空格。
 */
export function joinOcrWords(words: OcrWord[]): string {
  const ws = words.filter(w => (w.t ?? '').trim()).sort((a, b) => a.x - b.x)
  let out = ''
  let prev: OcrWord | null = null
  for (const w of ws) {
    const t = w.t.trim()
    if (prev) {
      const a = out[out.length - 1]
      const gap = w.x - (prev.x + prev.w)
      const lineH = Math.max(prev.h, w.h, 1)
      const cjkEdge = CJK.test(a) || CJK.test(t[0])
      if (!cjkEdge || gap > lineH * 0.5) out += ' '
    }
    out += t
    prev = w
  }
  return out
}

/** 像素坐标的行 → linesToText 用的归一化行（原点左下角，与 macOS Vision 一致） */
export function wordsToLine(words: OcrWord[], pageW: number, pageH: number): OcrLine | null {
  const ws = words.filter(w => (w.t ?? '').trim() && Number.isFinite(w.x) && Number.isFinite(w.y))
  if (!ws.length || !(pageW > 0) || !(pageH > 0)) return null
  const x0 = Math.min(...ws.map(w => w.x))
  const y0 = Math.min(...ws.map(w => w.y))
  const x1 = Math.max(...ws.map(w => w.x + w.w))
  const y1 = Math.max(...ws.map(w => w.y + w.h))
  return { t: joinOcrWords(ws), c: 1, x: x0 / pageW, y: 1 - y1 / pageH, w: (x1 - x0) / pageW, h: (y1 - y0) / pageH }
}

// ---------------------------------------------------------------- Windows（Windows.Media.Ocr）

/** 识字任务：只经环境变量 LINKTO_OCR_JOB（JSON）传给脚本 */
export const WIN_OCR_ENV = 'LINKTO_OCR_JOB'

export interface WinOcrJob {
  /** probe = 只列出已安装的识字语言 */
  mode: 'probe' | 'ocr'
  images: string[]
  /** 按顺序尝试的语言标记（来自 probe 的结果） */
  langs: string[]
  maxDim: number
}

export const WIN_OCR_LANG_HINT =
  '这台电脑还没有安装中文的文字识别（OCR）组件：打开 Windows 设置 → 时间和语言 → 语言和区域（或「语言」）→ 中文（简体）→ 语言选项 → 在「光学字符识别」处点添加，装好后重试；也可以改用 AI 识字'

/** Windows PowerShell 5.1（WinRT 投影只在它里面可用；PowerShell 7 不行） */
export function powershellPath(systemRoot?: string | null): string {
  const root = (systemRoot || 'C:\\Windows').replace(/[\\/]+$/, '')
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/**
 * 固定脚本（不含任何外部输入）：读 $env:LINKTO_OCR_JOB → 加载 WinRT 类型 → 按语言创建 OcrEngine →
 * 逐张图片：StorageFile → BitmapDecoder → SoftwareBitmap（按 EXIF 摆正、长边不超过上限与 OcrEngine.MaxImageDimension）→ RecognizeAsync，
 * 每张图片的词与像素框收集起来，最后一次性以 JSON 写到 stdout；进度写 stderr「P i n」。
 */
export function buildWinOcrScript(): string {
  return String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Out-Json($o) {
  $j = ConvertTo-Json -InputObject $o -Depth 10 -Compress
  $j = [regex]::Replace($j, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  [Console]::Out.Write($j)
  [Console]::Out.Flush()
}
try {
  $job = $env:LINKTO_OCR_JOB | ConvertFrom-Json
} catch { Out-Json @{ ok = $false; error = 'job' }; exit 0 }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType=WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' })[0]
  $avail = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
} catch { Out-Json @{ ok = $false; error = 'winrt'; detail = "$($_.Exception.Message)" }; exit 0 }
function Await($op, [Type]$type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $t.Wait(90000)) { throw 'timeout' }
  $t.Result
}
if ($job.mode -eq 'probe') {
  Out-Json @{ ok = $true; langs = $avail; maxDim = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension }
  exit 0
}
$engine = $null
$used = $null
foreach ($tag in @($job.langs)) {
  try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new([string]$tag)) } catch { $engine = $null }
  if ($engine) { $used = [string]$tag; break }
}
if (-not $engine) {
  try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { $engine = $null }
  if ($engine) { $used = $engine.RecognizerLanguage.LanguageTag }
}
if (-not $engine) { Out-Json @{ ok = $false; error = 'no-lang'; langs = $avail }; exit 0 }
$pages = New-Object System.Collections.ArrayList
$images = @($job.images)
$n = $images.Count
$i = 0
foreach ($p in $images) {
  $i++
  $stream = $null
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync([string]$p)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $limit = [Math]::Min([double]$job.maxDim, [double][Windows.Media.Ocr.OcrEngine]::MaxImageDimension)
    $scale = [Math]::Min(1.0, $limit / [Math]::Max(1.0, [Math]::Max([double]$dec.PixelWidth, [double]$dec.PixelHeight)))
    $tf = New-Object Windows.Graphics.Imaging.BitmapTransform
    $tf.ScaledWidth = [uint32][Math]::Max(1, [Math]::Round($dec.PixelWidth * $scale))
    $tf.ScaledHeight = [uint32][Math]::Max(1, [Math]::Round($dec.PixelHeight * $scale))
    $bmp = Await ($dec.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tf, [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $lines = New-Object System.Collections.ArrayList
    foreach ($l in $res.Lines) {
      $words = New-Object System.Collections.ArrayList
      foreach ($wd in $l.Words) {
        $r = $wd.BoundingRect
        [void]$words.Add(@{ t = $wd.Text; x = [double]$r.X; y = [double]$r.Y; w = [double]$r.Width; h = [double]$r.Height })
      }
      [void]$lines.Add(@{ words = $words })
    }
    [void]$pages.Add(@{ w = [int]$bmp.PixelWidth; h = [int]$bmp.PixelHeight; lines = $lines })
  } catch {
    [void]$pages.Add(@{ w = 0; h = 0; lines = @(); error = "$($_.Exception.Message)" })
  } finally {
    if ($stream) { try { $stream.Dispose() } catch {} }
  }
  [Console]::Error.WriteLine("P $i $n")
}
Out-Json @{ ok = $true; lang = $used; pages = $pages }
`
}

/** -EncodedCommand：脚本按 UTF-16LE 编码再 base64（避免引号 / 换行在命令行里被解释） */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function winOcrArgs(): string[] {
  return ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(buildWinOcrScript())]
}

/** 子进程环境：继承系统环境 + 任务 JSON（路径等只出现在这里） */
export function winOcrEnv(job: WinOcrJob, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, [WIN_OCR_ENV]: JSON.stringify(job) }
}

export interface WinOcrPage {
  w: number
  h: number
  lines: { words: OcrWord[] }[]
  error?: string
}

export interface WinOcrOutput {
  ok: boolean
  error?: string
  detail?: string
  lang?: string | null
  langs?: string[]
  maxDim?: number
  pages?: WinOcrPage[]
}

/** PowerShell 的 ConvertTo-Json 会把单元素数组压成对象、空数组写成 null：统一成数组 */
function arr<T>(v: unknown): T[] {
  if (v == null) return []
  return (Array.isArray(v) ? v : [v]) as T[]
}

export function parseWinOcrOutput(stdout: string): WinOcrOutput | null {
  const s = (stdout ?? '').replace(/^\uFEFF/, '').trim()
  const start = s.indexOf('{')
  if (start < 0) return null
  let j: any
  try {
    j = JSON.parse(s.slice(start))
  } catch {
    return null
  }
  if (!j || typeof j !== 'object') return null
  return {
    ok: !!j.ok,
    error: j.error ?? undefined,
    detail: j.detail ?? undefined,
    lang: j.lang ?? null,
    langs: arr<string>(j.langs).map(String),
    maxDim: Number(j.maxDim) || undefined,
    pages: arr<any>(j.pages).map(p => ({
      w: Number(p?.w) || 0,
      h: Number(p?.h) || 0,
      error: p?.error ? String(p.error) : undefined,
      lines: arr<any>(p?.lines).map(l => ({ words: arr<any>(l?.words).map(w => ({ t: String(w?.t ?? ''), x: Number(w?.x) || 0, y: Number(w?.y) || 0, w: Number(w?.w) || 0, h: Number(w?.h) || 0 })) }))
    }))
  }
}

/** 一页的 Windows 识别结果 → 文本 */
export function winPageToText(p: WinOcrPage): string {
  const lines = p.lines.map(l => wordsToLine(l.words, p.w, p.h)).filter((l): l is OcrLine => !!l)
  return linesToText(lines)
}

/** 已安装的识字语言 → 尝试顺序：简体中文 → 繁体中文 → 英文 → 其余（空 = 没有可用语言） */
export function pickWinLangs(avail: string[]): string[] {
  const rank = (t: string) => {
    const s = t.toLowerCase()
    if (/^zh-(hans|cn|sg)/.test(s)) return 0
    if (/^zh-(hant|tw|hk|mo)/.test(s)) return 1
    if (s === 'zh') return 0
    if (/^en/.test(s)) return 2
    return 3
  }
  return [...new Set(avail.filter(Boolean))].sort((a, b) => rank(a) - rank(b))
}

export function winOcrErrorText(code?: string | null, detail?: string | null): string {
  switch (code) {
    case 'no-lang':
      return WIN_OCR_LANG_HINT
    case 'winrt':
      return '这台电脑的 Windows 不支持系统文字识别（需要 Windows 10 或更新版本），可以改用 AI 识字'
    case 'job':
      return '系统文字识别没有收到任务参数'
    case 'spawn':
      return '无法启动 Windows PowerShell，不能使用系统文字识别，可以改用 AI 识字'
    case 'timeout':
      return '系统文字识别超时'
    default:
      return `系统文字识别失败${code ? `（${code}${detail ? `：${detail.slice(0, 120)}` : ''}）` : ''}`
  }
}

// ---------------------------------------------------------------- Linux（tesseract）

export const TESSERACT_BINS = ['tesseract', '/usr/bin/tesseract', '/usr/local/bin/tesseract']

export const TESSERACT_MISSING =
  '没有找到 tesseract：可以安装后使用本机识字（Debian / Ubuntu：sudo apt install tesseract-ocr tesseract-ocr-chi-sim；Fedora：sudo dnf install tesseract tesseract-langpack-chi_sim），或者改用 AI 识字'

export const TESSERACT_NO_CHI = '已安装 tesseract，但缺少简体中文语言包（chi_sim），中文会识别不出来：sudo apt install tesseract-ocr-chi-sim'

/** tesseract --list-langs 的输出（新版本在 stdout，旧版本在 stderr）→ 语言列表 */
export function parseTesseractLangs(out: string): string[] {
  return (out ?? '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^list of|^error|^warning/i.test(l) && /^[A-Za-z0-9_\-.]+$/.test(l))
}

/** 识别语言参数：chi_sim + eng（有哪个用哪个）；都没有时用第一个可用语言（osd 除外） */
export function tesseractLangArg(langs: string[]): string | null {
  const want = ['chi_sim', 'eng'].filter(l => langs.includes(l))
  if (want.length) return want.join('+')
  return langs.find(l => l !== 'osd' && l !== 'equ') ?? null
}

/** 一张图片的识别参数：输入为绝对路径（不会被当作选项），输出到 stdout，TSV 带坐标 */
export function tesseractArgs(imagePath: string, lang: string): string[] {
  const abs = isAbsolute(imagePath) ? imagePath : resolve(imagePath)
  return [abs, 'stdout', '-l', lang, '--psm', '3', '-c', 'preserve_interword_spaces=1', 'tsv']
}

/** tesseract 的 TSV → 文本：按 block / par / line 分行，复用 linesToText 的版面整理 */
export function parseTesseractTsv(tsv: string): string {
  const rows = (tsv ?? '').split(/\r?\n/)
  let pageW = 0
  let pageH = 0
  const lines = new Map<string, OcrWord[]>()
  for (const row of rows) {
    const c = row.split('\t')
    if (c.length < 12 || c[0] === 'level') continue
    const level = Number(c[0])
    const [left, top, width, height] = [Number(c[6]), Number(c[7]), Number(c[8]), Number(c[9])]
    if (level === 1) {
      pageW = Math.max(pageW, left + width)
      pageH = Math.max(pageH, top + height)
      continue
    }
    if (level !== 5) continue
    const conf = Number(c[10])
    const text = c.slice(11).join('\t').trim()
    if (!text || conf < 0) continue
    const key = `${c[1]}/${c[2]}/${c[3]}/${c[4]}`
    const list = lines.get(key) ?? []
    list.push({ t: text, x: left, y: top, w: width, h: height })
    lines.set(key, list)
  }
  if (!pageW || !pageH) {
    for (const ws of lines.values())
      for (const w of ws) {
        pageW = Math.max(pageW, w.x + w.w)
        pageH = Math.max(pageH, w.y + w.h)
      }
  }
  const out = [...lines.values()].map(ws => wordsToLine(ws, pageW, pageH)).filter((l): l is OcrLine => !!l)
  return linesToText(out)
}

// ---------------------------------------------------------------- 可用性探测（带缓存）

export interface NativeProbe {
  platform: NativePlatform
  /** 能不能用本机识字 */
  ok: boolean
  /** 不能用的原因，或能用但有限制的提示（如缺中文语言包） */
  reason: string | null
  /** 界面用的引擎名 */
  engine: string | null
  /** Windows：识字语言尝试顺序；Linux：-l 参数 */
  langs: string[]
  /** Linux：tesseract 可执行文件 */
  bin?: string
  at: number
}

/** Windows 探测结果 → 可用性 */
export function winProbeFrom(r: ProcResult, now = Date.now()): NativeProbe {
  const base = { platform: 'win32' as const, engine: 'Windows 系统文字识别', at: now }
  if (r.spawnError) return { ...base, ok: false, reason: winOcrErrorText('spawn'), langs: [] }
  if (r.timedOut) return { ...base, ok: false, reason: '检测系统文字识别超时，可以稍后重试或改用 AI 识字', langs: [] }
  const out = parseWinOcrOutput(r.stdout)
  if (!out) return { ...base, ok: false, reason: winOcrErrorText(`exit ${r.code ?? '?'}`, r.stderr.trim()), langs: [] }
  if (!out.ok) return { ...base, ok: false, reason: winOcrErrorText(out.error, out.detail), langs: [] }
  const langs = pickWinLangs(out.langs ?? [])
  if (!langs.length) return { ...base, ok: false, reason: WIN_OCR_LANG_HINT, langs: [] }
  const hasZh = langs.some(l => /^zh/i.test(l))
  return { ...base, ok: true, reason: hasZh ? null : `只安装了 ${langs.join(' / ')} 的文字识别，中文可能识别不出来。${WIN_OCR_LANG_HINT.replace(/^这台电脑还没有安装中文的文字识别（OCR）组件：/, '添加方法：')}`, langs }
}

/** Linux 探测结果（逐个候选路径执行 --list-langs）→ 可用性 */
export function tesseractProbeFrom(bin: string | null, r: ProcResult | null, now = Date.now()): NativeProbe {
  const base = { platform: 'linux' as const, engine: 'Tesseract', at: now }
  if (!bin || !r || r.spawnError) return { ...base, ok: false, reason: TESSERACT_MISSING, langs: [] }
  if (r.timedOut) return { ...base, ok: false, reason: '检测 tesseract 超时，可以稍后重试或改用 AI 识字', langs: [], bin }
  const langs = parseTesseractLangs(`${r.stdout}\n${r.stderr}`)
  const arg = tesseractLangArg(langs)
  if (!arg) return { ...base, ok: false, reason: '已安装 tesseract，但没有可用的语言包：sudo apt install tesseract-ocr-chi-sim tesseract-ocr-eng', langs: [], bin }
  return { ...base, ok: true, reason: langs.includes('chi_sim') ? null : TESSERACT_NO_CHI, langs: [arg], bin }
}

let probeCache: NativeProbe | null = null

/** 探测本机识字（Windows / Linux）：成功缓存 10 分钟，失败缓存 1 分钟（装好语言包后很快就能用上） */
export async function probeNativeOcr(platform: NativePlatform, run: Runner = runProcess, opts: { force?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<NativeProbe> {
  const now = Date.now()
  if (!opts.force && probeCache && probeCache.platform === platform && now - probeCache.at < (probeCache.ok ? 10 * 60_000 : 60_000)) return probeCache
  let p: NativeProbe
  if (platform === 'win32') {
    const env = opts.env ?? process.env
    const r = await run(powershellPath(env.SystemRoot ?? env.SYSTEMROOT), winOcrArgs(), { env: winOcrEnv({ mode: 'probe', images: [], langs: [], maxDim: 0 }, env), timeoutMs: 25_000, maxBytes: 1024 * 1024 })
    p = winProbeFrom(r, now)
  } else if (platform === 'linux') {
    let hit: { bin: string; r: ProcResult } | null = null
    for (const bin of TESSERACT_BINS) {
      const r = await run(bin, ['--list-langs'], { env: opts.env, timeoutMs: 8_000, maxBytes: 256 * 1024 })
      if (!r.spawnError) {
        hit = { bin, r }
        break
      }
    }
    p = tesseractProbeFrom(hit?.bin ?? null, hit?.r ?? null, now)
  } else if (platform === 'darwin') {
    p = { platform, ok: true, reason: null, engine: 'macOS 系统文字识别', langs: [], at: now }
  } else {
    p = { platform, ok: false, reason: '这个系统上没有可用的本机识字，可以改用 AI 识字', engine: null, langs: [], at: now }
  }
  probeCache = p
  return p
}

export function resetNativeProbe() {
  probeCache = null
}

/**
 * 识字方式的平台降级（留痕截图用）：macOS 或本机识字可用 → 按设置；本机不可用 → 用户允许 AI 时改用 AI，否则说明原因。
 * 'ai' 本身不降级（AI 不可用时由识字流程给出原因）。
 */
export function chooseOcrEngine(
  engine: 'local' | 'ai' | 'local+ai',
  o: { macVision: boolean; nativeOk: boolean; nativeReason: string | null; aiAllowed: boolean }
): { engine: 'local' | 'ai' | 'local+ai' } | { error: string } {
  if (engine === 'ai' || o.macVision || o.nativeOk) return { engine }
  if (o.aiAllowed) return { engine: 'ai' }
  return { error: `${o.nativeReason ?? '这台电脑上没有可用的本机识字'}${/AI 识字/.test(o.nativeReason ?? '') ? '' : '；也可以开启 AI 并允许把附件内容发给 AI 后用 AI 识字'}` }
}

// ---------------------------------------------------------------- 识别

export interface NativeOcrResult {
  ok: boolean
  error?: string
  /** 每张图片一页的文本 */
  pages: string[]
}

/** 识别若干图片文件（已探测可用）：Windows 一个 PowerShell 进程处理全部图片；Linux 逐张调 tesseract */
export async function nativeOcrFiles(
  probe: NativeProbe,
  files: string[],
  opts: { maxDim: number; perPageMs: number; baseMs: number; onProgress?(done: number, total: number): void; env?: NodeJS.ProcessEnv },
  run: Runner = runProcess
): Promise<NativeOcrResult> {
  if (!probe.ok) return { ok: false, error: probe.reason ?? '本机识字不可用', pages: [] }
  if (!files.length) return { ok: true, pages: [] }
  if (probe.platform === 'win32') {
    const env = opts.env ?? process.env
    const timeoutMs = opts.baseMs + opts.perPageMs * files.length
    const r = await run(powershellPath(env.SystemRoot ?? env.SYSTEMROOT), winOcrArgs(), {
      env: winOcrEnv({ mode: 'ocr', images: files, langs: probe.langs, maxDim: opts.maxDim }, env),
      timeoutMs,
      onStderrLine: l => {
        const p = parseProgressLine(l)
        if (p) opts.onProgress?.(p.done, p.total)
      }
    })
    if (r.spawnError) return { ok: false, error: winOcrErrorText('spawn'), pages: [] }
    if (r.timedOut) return { ok: false, error: `系统文字识别超时（${Math.round(timeoutMs / 1000)} 秒）`, pages: [] }
    const out = parseWinOcrOutput(r.stdout)
    if (!out) return { ok: false, error: winOcrErrorText(`exit ${r.code ?? '?'}`, r.stderr.trim()), pages: [] }
    if (!out.ok) return { ok: false, error: winOcrErrorText(out.error, out.detail), pages: [] }
    const pages = (out.pages ?? []).map(winPageToText)
    if (pages.length && (out.pages ?? []).every(p => p.error)) return { ok: false, error: winOcrErrorText('decode', out.pages![0].error), pages: [] }
    return { ok: true, pages }
  }
  if (probe.platform === 'linux') {
    const pages: string[] = []
    const lang = probe.langs[0] ?? 'eng'
    for (let i = 0; i < files.length; i++) {
      opts.onProgress?.(i, files.length)
      const r = await run(probe.bin ?? 'tesseract', tesseractArgs(files[i], lang), { env: opts.env, timeoutMs: opts.perPageMs + opts.baseMs / 2, maxBytes: 16 * 1024 * 1024 })
      if (r.spawnError) return { ok: false, error: TESSERACT_MISSING, pages: [] }
      if (r.timedOut) {
        if (!pages.length) return { ok: false, error: 'tesseract 识别超时', pages: [] }
        pages.push('〔本页识别超时〕')
        continue
      }
      if (r.code !== 0 && !r.stdout.trim()) {
        const why = r.stderr.trim().split(/\r?\n/).pop()?.slice(0, 160) ?? ''
        if (!pages.length && files.length === 1) return { ok: false, error: `tesseract 识别失败${why ? `：${why}` : ''}`, pages: [] }
        pages.push('〔本页识别失败〕')
        continue
      }
      pages.push(parseTesseractTsv(r.stdout))
    }
    opts.onProgress?.(files.length, files.length)
    return { ok: true, pages }
  }
  return { ok: false, error: probe.reason ?? '本机识字不可用', pages: [] }
}
