import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { decodeEntities, tidyText } from './text-parse'

export { OFFICE_EXTS, isOfficeMime } from './text-parse'

/**
 * Word / Excel / PowerPoint 附件正文（纯 Node，无第三方依赖；在 office-worker 子进程里跑，主进程不做解析）：
 *  - 最小 ZIP 读取器：读中央目录 → 按需解压单个条目（STORED / DEFLATE），条目数、单条与累计解压大小都有上限（防 zip bomb），
 *    条目名只当查找键、从不落盘；ZIP64 / 加密条目直接给出明确错误
 *  - OOXML：docx（段落 / 表格 → Markdown 表格 / 页眉页脚 / 脚注尾注，批注忽略）、xlsx（共享字符串 + 工作表名 + 单元格，
 *    按工作表输出、制表符分隔、日期格式按样式转换）、pptx（按幻灯片顺序 + 备注）；宏文件（docm / xlsm / pptm）只读 XML，不碰 vbaProject
 *  - OpenDocument：odt / ods / odp（content.xml）
 *  - 旧格式：.doc / .rtf 在 macOS 用系统 textutil（execFile，路径作参数，带超时）；.xls / .ppt 暂不支持
 * 工作表 / 幻灯片之间用分页符 \n\f\n 分隔（与 PDF 一致：slicePages 按工作表 / 页读，pages = 工作表数 / 幻灯片数）。
 */

export const OFFICE_LIMITS = {
  /** 原文件大小 */
  maxFileBytes: 60 * 1024 * 1024,
  /** ZIP 条目数 */
  maxEntries: 20_000,
  /** 单个条目解压后大小 */
  maxEntryBytes: 64 * 1024 * 1024,
  /** 本次累计解压大小 */
  maxTotalBytes: 160 * 1024 * 1024,
  /** 每个工作表最多读多少行 / 列 */
  maxRows: 2000,
  maxCols: 50,
  /** 最多读多少个工作表 / 幻灯片 */
  maxParts: 300,
  /** 输出总字数 */
  maxChars: 200_000,
  /** textutil 超时 */
  timeoutMs: 12_000
}

export type OfficeLimits = typeof OFFICE_LIMITS
export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'doc' | 'rtf'

export interface OfficeResult {
  ok: boolean
  error?: string
  text?: string
  /** docx：文档属性里的页数（没有则 1）；xlsx：工作表数；pptx：幻灯片数 */
  pages?: number
  truncated?: boolean
  format?: OfficeFormat
  /** 工作表名 / 幻灯片标题（按顺序） */
  parts?: string[]
}

/** 解析中遇到的、要原样告诉用户的错误 */
export class OfficeError extends Error {}

// ================================================================ ZIP

export interface ZipEntry {
  name: string
  method: number
  flags: number
  compSize: number
  size: number
  offset: number
}

export interface ZipArchive {
  entries: ZipEntry[]
  /** 小写名 → 条目 */
  byName: Map<string, ZipEntry>
  /** 解压一个条目（受单条 / 累计上限约束）；不存在返回 null */
  read(name: string): Buffer | null
  /** 读成 UTF-8 文本（去 BOM） */
  text(name: string): string | null
  has(name: string): boolean
}

const SIG_EOCD = 0x06054b50
const SIG_EOCD64_LOC = 0x07064b50
const SIG_CEN = 0x02014b50
const SIG_LOC = 0x04034b50

export function isZip(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5) && (buf[3] === 4 || buf[3] === 6)
}

/** OLE 复合文档（旧版 doc / xls / ppt，或加密后的 docx / xlsx / pptx） */
export function isCfb(buf: Uint8Array): boolean {
  return buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0 && buf[4] === 0xa1 && buf[5] === 0xb1 && buf[6] === 0x1a && buf[7] === 0xe1
}

function normName(n: string): string {
  return n.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()
}

/** 读 ZIP 中央目录（不解压任何东西）；损坏 / ZIP64 / 条目过多抛 OfficeError */
export function openZip(buf: Buffer, limits: Pick<OfficeLimits, 'maxEntries' | 'maxEntryBytes' | 'maxTotalBytes'> = OFFICE_LIMITS): ZipArchive {
  if (buf.length < 22) throw new OfficeError('文件已损坏或不是有效的 Office 文档（太短）')
  // EOCD：从文件尾往前找（注释最长 65535 字节）
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new OfficeError('文件已损坏或不是有效的 Office 文档（找不到 ZIP 目录）')
  const total = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOff = buf.readUInt32LE(eocd + 16)
  const zip64 = (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_EOCD64_LOC) || total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff
  if (zip64) throw new OfficeError('这是 ZIP64 格式的超大文档，暂不支持读取文字')
  if (total > limits.maxEntries) throw new OfficeError(`文档内部文件过多（${total} 个），为安全起见未读取`)
  if (cdOff + cdSize > eocd) throw new OfficeError('文件已损坏（ZIP 目录越界）')
  const entries: ZipEntry[] = []
  const byName = new Map<string, ZipEntry>()
  let p = cdOff
  for (let k = 0; k < total; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) throw new OfficeError('文件已损坏（ZIP 目录条目无效）')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const offset = buf.readUInt32LE(p + 42)
    if (p + 46 + nameLen > buf.length) throw new OfficeError('文件已损坏（ZIP 文件名越界）')
    // 文件名只当查找键：UTF-8 标志位或纯 ASCII 都按 UTF-8 解，不会用来拼任何本地路径
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen)
    if (compSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new OfficeError('这是 ZIP64 格式的超大文档，暂不支持读取文字')
    const e: ZipEntry = { name, method, flags, compSize, size, offset }
    entries.push(e)
    const key = normName(name)
    if (!byName.has(key)) byName.set(key, e)
    p += 46 + nameLen + extraLen + commentLen
  }
  let used = 0
  const read = (n: string): Buffer | null => {
    const e = byName.get(normName(n))
    if (!e) return null
    if (e.flags & 0x1) throw new OfficeError('文档已加密（需要密码），无法读取文字')
    if (e.size > limits.maxEntryBytes) throw new OfficeError(`文档内部文件过大（${Math.round(e.size / 1048576)} MB），为安全起见未读取`)
    if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== SIG_LOC) throw new OfficeError('文件已损坏（ZIP 条目头无效）')
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28)
    if (start + e.compSize > buf.length) throw new OfficeError('文件已损坏（ZIP 条目数据越界）')
    const data = buf.subarray(start, start + e.compSize)
    const room = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - used)
    if (room <= 0) throw new OfficeError('文档解压后过大，为安全起见停止读取')
    let out: Buffer
    if (e.method === 0) {
      out = data
    } else if (e.method === 8) {
      try {
        // maxOutputLength：声明的大小可能是假的，真实解压量超限立即中止（zip bomb）
        out = inflateRawSync(data, { maxOutputLength: room })
      } catch (err) {
        const code = (err as { code?: string })?.code
        if (code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) throw new OfficeError('文档解压后过大（疑似压缩炸弹），为安全起见未读取')
        throw new OfficeError('文件已损坏（解压失败）')
      }
    } else {
      throw new OfficeError(`文档使用了不支持的压缩方式（${e.method}）`)
    }
    if (out.length > room) throw new OfficeError('文档解压后过大（疑似压缩炸弹），为安全起见未读取')
    used += out.length
    return out
  }
  return {
    entries,
    byName,
    read,
    text(n) {
      const b = read(n)
      if (!b) return null
      const s = b.toString('utf8')
      return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
    },
    has: n => byName.has(normName(n))
  }
}

// ================================================================ XML

export interface XmlTok {
  /** open / close / text */
  t: 'o' | 'c' | 'x'
  /** 本地名（去掉命名空间前缀） */
  n: string
  /** 带前缀的原名 */
  q: string
  a: string
  /** 自闭合 */
  s: boolean
  /** 文本（已解实体） */
  v: string
}

const TOKEN = /<(\/?)([A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>/g

/** 极简 XML 词法：只出开 / 闭标签与文本；DOCTYPE / 注释 / 处理指令跳过（不展开任何外部实体） */
export function* xmlTokens(xml: string): Generator<XmlTok> {
  let last = 0
  let m: RegExpExecArray | null
  const re = new RegExp(TOKEN.source, 'g')
  while ((m = re.exec(xml))) {
    if (m.index > last) {
      const raw = xml.slice(last, m.index)
      if (raw) yield { t: 'x', n: '', q: '', a: '', s: false, v: raw.indexOf('&') >= 0 ? decodeEntities(raw) : raw }
    }
    last = re.lastIndex
    if (m[5] != null) {
      yield { t: 'x', n: '', q: '', a: '', s: false, v: m[5] }
      continue
    }
    if (!m[2]) continue
    const q = m[2]
    const colon = q.indexOf(':')
    const n = colon >= 0 ? q.slice(colon + 1) : q
    if (m[1]) yield { t: 'c', n, q, a: '', s: false, v: '' }
    else {
      const self = !!m[4]
      yield { t: 'o', n, q, a: m[3] || '', s: self, v: '' }
      if (self) yield { t: 'c', n, q, a: '', s: true, v: '' }
    }
  }
  if (last < xml.length) {
    const raw = xml.slice(last)
    if (raw.trim()) yield { t: 'x', n: '', q: '', a: '', s: false, v: decodeEntities(raw) }
  }
}

/** 取属性值（按本地名或带前缀名匹配） */
export function attr(a: string, name: string): string | null {
  // 带前缀的名字（r:id）精确匹配；不带前缀的按本地名匹配（可带任意前缀）
  const esc = name.replace(/[.\-]/g, '\\$&')
  const re = new RegExp(`(?:^|\\s)${name.includes(':') ? esc : `(?:[\\w.\\-]+:)?${esc}`}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
  const m = re.exec(a)
  if (!m) return null
  const v = m[1] ?? m[2] ?? ''
  return v.indexOf('&') >= 0 ? decodeEntities(v) : v
}

/** 关系 id：优先带前缀的 r:id（pptx 的 sldId 同时有无前缀的 id） */
function relId(a: string): string | null {
  return /(?:^|\s)[\w.\-]+:id\s*=\s*"([^"]*)"/.exec(a)?.[1] ?? attr(a, 'id')
}

/** 单元格文本里的换行 / 竖线：Markdown 表格与制表符行里都要压平 */
function cellText(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').replace(/\t/g, ' ').trim()
}

/** 行数组 → Markdown 表格（第一行作表头） */
export function markdownTable(rows: string[][]): string {
  const live = rows.filter(r => r.some(c => c.trim()))
  if (!live.length) return ''
  const cols = Math.max(...live.map(r => r.length))
  const fmt = (r: string[]) => `| ${Array.from({ length: cols }, (_, i) => cellText(r[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`
  if (cols === 1) return live.map(r => cellText(r[0] ?? '')).join('\n')
  return [fmt(live[0]), `|${' --- |'.repeat(cols)}`, ...live.slice(1).map(fmt)].join('\n')
}

/** 输出累加器：总字数到上限就标记截断 */
export class Budget {
  used = 0
  truncated = false
  constructor(public max: number) {}
  take(n: number): boolean {
    this.used += n
    if (this.used > this.max) this.truncated = true
    return !this.truncated
  }
  get full() {
    return this.truncated
  }
}

// ================================================================ docx

/** 一个 WordprocessingML 部件（document / header / footer / footnotes / endnotes）→ 文本；表格转 Markdown */
export function docxXmlToText(xml: string, budget = new Budget(OFFICE_LIMITS.maxChars)): string {
  const body: string[] = []
  // 段落栈（文本框里的段落嵌在外层段落里）；表格栈
  const paras: { buf: string; prefix: string }[] = []
  const tables: { rows: string[][]; row: string[] | null; cell: string[] | null }[] = []
  let skip = 0
  let inT = false
  const sink = (line: string) => {
    const tb = tables[tables.length - 1]
    if (tb?.cell) tb.cell.push(line)
    else {
      body.push(line)
      budget.take(line.length + 1)
    }
  }
  for (const k of xmlTokens(xml)) {
    if (budget.full) break
    if (skip) {
      if (k.t === 'o' && !k.s && SKIP_DOCX.has(k.n)) skip++
      else if (k.t === 'c' && !k.s && SKIP_DOCX.has(k.n)) skip--
      continue
    }
    const p = paras[paras.length - 1]
    if (k.t === 'x') {
      if (inT && p) p.buf += k.v
      continue
    }
    if (k.t === 'o') {
      switch (k.n) {
        case 'p':
          paras.push({ buf: '', prefix: '' })
          break
        case 't':
          inT = !k.s
          break
        case 'tab':
          // pPr 里的制表位定义（带 pos）不是文字
          if (p && !/\bpos\s*=/.test(k.a)) p.buf += '\t'
          break
        case 'br':
        case 'cr':
          if (p) p.buf += '\n'
          break
        case 'noBreakHyphen':
          if (p) p.buf += '-'
          break
        case 'sym': {
          const ch = attr(k.a, 'char')
          if (p && ch && /^[0-9a-f]{4}$/i.test(ch)) {
            const code = parseInt(ch, 16)
            // Symbol 字体私用区（F0xx）多是项目符号，跳过
            if (code < 0xe000 || code > 0xf8ff) p.buf += String.fromCharCode(code)
          }
          break
        }
        case 'pStyle': {
          const v = attr(k.a, 'val') ?? ''
          const h = /^(?:heading|标题)\s*(\d)$/i.exec(v) ?? (/^title$/i.test(v) ? ['', '1'] : null)
          if (p && h) p.prefix = '#'.repeat(Math.min(6, Number(h[1]) || 1)) + ' '
          break
        }
        case 'numPr':
          if (p && !p.prefix) p.prefix = '- '
          break
        case 'tbl':
          tables.push({ rows: [], row: null, cell: null })
          break
        case 'tr':
          if (tables.length) tables[tables.length - 1].row = []
          break
        case 'tc':
          if (tables.length) tables[tables.length - 1].cell = []
          break
        default:
          if (!k.s && SKIP_DOCX.has(k.n)) skip = 1
      }
      continue
    }
    // close
    switch (k.n) {
      case 't':
        inT = false
        break
      case 'p': {
        const done = paras.pop()
        if (!done) break
        const s = done.buf.replace(/[  ]+$/g, '')
        sink(s.trim() ? done.prefix + s : '')
        break
      }
      case 'tc': {
        const tb = tables[tables.length - 1]
        if (tb?.cell) {
          tb.row?.push(tb.cell.filter(Boolean).join(' '))
          tb.cell = null
        }
        break
      }
      case 'tr': {
        const tb = tables[tables.length - 1]
        if (tb?.row) {
          tb.rows.push(tb.row)
          tb.row = null
        }
        break
      }
      case 'tbl': {
        const tb = tables.pop()
        if (!tb) break
        if (tables.length) {
          // 嵌套表格：压平成文字放进外层单元格
          sink(tb.rows.map(r => r.filter(Boolean).join(' / ')).filter(Boolean).join('；'))
        } else {
          const md = markdownTable(tb.rows)
          if (md) {
            sink('')
            sink(md)
            sink('')
          }
        }
        break
      }
    }
  }
  return tidyText(body.join('\n'))
}

/** 删除的修订、域代码、兼容回退内容（与 Choice 重复）、批注范围外的东西：跳过 */
const SKIP_DOCX = new Set(['instrText', 'delText', 'del', 'Fallback', 'commentReference', 'annotationRef', 'rPh', 'moveFrom'])

function relsTargets(xml: string | null, base: string): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>()
  if (!xml) return out
  for (const k of xmlTokens(xml)) {
    if (k.t !== 'o' || k.n !== 'Relationship') continue
    const id = attr(k.a, 'Id')
    const target = attr(k.a, 'Target')
    if (!id || !target || attr(k.a, 'TargetMode') === 'External') continue
    out.set(id, { target: resolvePart(base, target), type: attr(k.a, 'Type') ?? '' })
  }
  return out
}

/** 包内相对路径解析（只在 ZIP 条目名空间里，不碰文件系统） */
export function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').filter(Boolean)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

function docxPages(zip: ZipArchive): number {
  const app = zip.text('docProps/app.xml')
  const n = app ? Number(/<(?:\w+:)?Pages>(\d+)</.exec(app)?.[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : 1
}

export function readDocx(zip: ZipArchive, limits: OfficeLimits = OFFICE_LIMITS): OfficeResult {
  const budget = new Budget(limits.maxChars)
  const rels = relsTargets(zip.text('word/_rels/document.xml.rels'), 'word')
  const main = zip.text('word/document.xml') ?? zip.text([...rels.values()].find(r => /officeDocument$/.test(r.type))?.target ?? '')
  if (main == null) throw new OfficeError('文件已损坏（缺少 Word 正文 document.xml）')
  const parts: string[] = [docxXmlToText(main, budget)]
  // 页眉页脚（多份常重复，去重）与脚注尾注；批注 comments.xml 不读
  const hf: string[] = []
  const seen = new Set<string>()
  for (const r of rels.values()) {
    if (budget.full) break
    if (!/\/(header|footer)$/.test(r.type)) continue
    const t = docxXmlToText(zip.text(r.target) ?? '', budget)
    for (const line of t.split('\n')) {
      const s = line.trim()
      if (s && !seen.has(s)) {
        seen.add(s)
        hf.push(s)
      }
    }
  }
  if (hf.length) parts.push(`## 页眉页脚\n${hf.join('\n')}`)
  for (const [file, label] of [
    ['word/footnotes.xml', '脚注'],
    ['word/endnotes.xml', '尾注']
  ] as const) {
    if (budget.full) break
    const x = zip.text(file)
    const t = x ? docxXmlToText(x, budget) : ''
    if (t.trim()) parts.push(`## ${label}\n${t}`)
  }
  const text = parts.filter(s => s.trim()).join('\n\n')
  return { ok: true, text, pages: docxPages(zip), truncated: budget.truncated, format: 'docx' }
}

// ================================================================ xlsx

/** sharedStrings.xml → 字符串数组（富文本 run 拼接，注音 rPh 跳过） */
export function parseSharedStrings(xml: string | null): string[] {
  const out: string[] = []
  if (!xml) return out
  let cur: string | null = null
  let inT = false
  let skip = 0
  for (const k of xmlTokens(xml)) {
    if (k.t === 'o' && k.n === 'rPh' && !k.s) skip++
    else if (k.t === 'c' && k.n === 'rPh' && !k.s) skip--
    else if (skip) continue
    else if (k.t === 'o' && k.n === 'si') cur = ''
    else if (k.t === 'c' && k.n === 'si') {
      out.push(cur ?? '')
      cur = null
    } else if (k.t === 'o' && k.n === 't') inT = !k.s
    else if (k.t === 'c' && k.n === 't') inT = false
    else if (k.t === 'x' && inT && cur != null) cur += k.v
  }
  return out
}

/** 内置日期格式 id（含中日韩区域格式） */
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])
const BUILTIN_TIME = new Set([18, 19, 20, 21, 45, 46, 47])

export type CellFmt = 'date' | 'datetime' | 'time' | 'percent' | null

/** 自定义格式码是不是日期 / 时间（去掉引号文字、转义字符和颜色 / 区域方括号后看有没有 y m d h s） */
export function fmtKindOfCode(code: string): CellFmt {
  const c = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .replace(/\[(?!h\]|hh\]|m\]|mm\]|s\]|ss\])[^\]]*\]/gi, '')
    .toLowerCase()
  if (/^general$/.test(c.trim())) return null
  const hasDate = /[yd]/.test(c) || /(^|[^h:])m{3,}/.test(c) || (/m/.test(c) && /[yd]/.test(c))
  const hasTime = /[hs]/.test(c) || /am\/pm|a\/p/.test(c)
  if (hasDate && hasTime) return 'datetime'
  if (hasDate) return 'date'
  if (hasTime) return 'time'
  if (/%/.test(c)) return 'percent'
  return null
}

/** styles.xml → cellXfs 下标 → 格式类别 */
export function parseCellFormats(xml: string | null): CellFmt[] {
  if (!xml) return []
  const custom = new Map<number, string>()
  const out: CellFmt[] = []
  let inXfs = false
  for (const k of xmlTokens(xml)) {
    if (k.t === 'o' && k.n === 'numFmt') {
      const id = Number(attr(k.a, 'numFmtId'))
      const code = attr(k.a, 'formatCode')
      if (Number.isFinite(id) && code != null) custom.set(id, code)
    } else if (k.n === 'cellXfs') inXfs = k.t === 'o' && !k.s
    else if (inXfs && k.t === 'o' && k.n === 'xf') {
      const id = Number(attr(k.a, 'numFmtId') ?? 0)
      const code = custom.get(id)
      out.push(code != null ? fmtKindOfCode(code) : BUILTIN_TIME.has(id) ? (id === 22 ? 'datetime' : 'time') : BUILTIN_DATE.has(id) ? (id === 22 ? 'datetime' : 'date') : id === 9 || id === 10 ? 'percent' : null)
    }
  }
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Excel 序列号 → 日期文本（1900 体系；date1904 时加 1462 天） */
export function excelSerialToText(serial: number, kind: Exclude<CellFmt, 'percent' | null>, date1904 = false): string {
  if (!Number.isFinite(serial)) return String(serial)
  const s = date1904 ? serial + 1462 : serial
  // 1900 体系：Excel 把 1900 年当闰年（序列号 60 = 不存在的 2/29），61 之前的日期补一天再按 1899-12-30 起算
  const days = s >= 61 ? s : s >= 1 ? s + 1 : s
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(days * 86400) * 1000)
  if (!Number.isFinite(d.getTime())) return String(serial)
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const secs = d.getUTCSeconds()
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${secs ? `:${pad(secs)}` : ''}`
  if (kind === 'time') return time
  if (kind === 'datetime') return `${date} ${time}`
  return date
}

/** 数值文本：去掉浮点噪声（0.30000000000000004 → 0.3） */
export function tidyNumber(v: string): string {
  const n = Number(v)
  if (!Number.isFinite(n) || v.trim() === '') return v
  if (Number.isInteger(n)) return Math.abs(n) < 1e15 ? String(n) : v
  return String(parseFloat(n.toPrecision(15)))
}

/** A1 → 列号（0 起） */
export function colIndex(ref: string): number {
  let n = 0
  for (const ch of ref) {
    const c = ch.charCodeAt(0)
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64)
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96)
    else break
  }
  return n - 1
}

export interface SheetOpts {
  shared: string[]
  formats: CellFmt[]
  date1904: boolean
  maxRows: number
  maxCols: number
}

/** 一个工作表 XML → 行（制表符分隔；空行跳过）；超过行 / 列上限截断 */
export function sheetXmlToRows(xml: string, o: SheetOpts, budget = new Budget(OFFICE_LIMITS.maxChars)): { lines: string[]; truncated: boolean } {
  const lines: string[] = []
  let truncated = false
  let row: string[] | null = null
  let col = -1
  let cell: { t: string; s: number; v: string; inV: boolean; inIs: boolean; inT: boolean; has: boolean } | null = null
  let skipF = false
  for (const k of xmlTokens(xml)) {
    if (k.t === 'o') {
      if (k.n === 'row') {
        row = []
        col = -1
      } else if (k.n === 'c' && row) {
        const r = attr(k.a, 'r')
        col = r ? colIndex(r) : col + 1
        cell = { t: attr(k.a, 't') ?? 'n', s: Number(attr(k.a, 's') ?? 0) || 0, v: '', inV: false, inIs: false, inT: false, has: false }
        if (k.s) cell = null
      } else if (cell) {
        if (k.n === 'v') cell.inV = !k.s
        else if (k.n === 'is') cell.inIs = !k.s
        else if (k.n === 't' && cell.inIs) cell.inT = !k.s
        else if (k.n === 'f') skipF = !k.s
        else if (k.n === 'rPh') skipF = !k.s
      }
      continue
    }
    if (k.t === 'x') {
      if (!cell || skipF) continue
      if (cell.inV || (cell.inIs && cell.inT)) {
        cell.v += k.v
        cell.has = true
      }
      continue
    }
    // close
    if (k.n === 'f' || k.n === 'rPh') skipF = false
    else if (k.n === 'v' && cell) cell.inV = false
    else if (k.n === 't' && cell) cell.inT = false
    else if (k.n === 'is' && cell) cell.inIs = false
    else if (k.n === 'c' && cell && row) {
      if (cell.has && col >= 0) {
        if (col >= o.maxCols) truncated = true
        else row[col] = cellValue(cell.t, cell.v, o.formats[cell.s] ?? null, o)
      }
      cell = null
    } else if (k.n === 'row' && row) {
      const vals = Array.from({ length: row.length }, (_, i) => cellText(row![i] ?? ''))
      while (vals.length && !vals[vals.length - 1]) vals.pop()
      row = null
      if (!vals.some(Boolean)) continue
      if (lines.length >= o.maxRows) {
        truncated = true
        break
      }
      const line = vals.join('\t')
      lines.push(line)
      if (!budget.take(line.length + 1)) break
    }
  }
  return { lines, truncated }
}

function cellValue(t: string, v: string, fmt: CellFmt, o: SheetOpts): string {
  switch (t) {
    case 's':
      return o.shared[Number(v)] ?? ''
    case 'b':
      return v.trim() === '1' ? 'TRUE' : 'FALSE'
    case 'inlineStr':
    case 'str':
    case 'e':
    case 'd':
      return v
    default: {
      if (fmt && fmt !== 'percent') return excelSerialToText(Number(v), fmt, o.date1904)
      if (fmt === 'percent' && Number.isFinite(Number(v))) return `${tidyNumber(String(Number(v) * 100))}%`
      return tidyNumber(v)
    }
  }
}

export function readXlsx(zip: ZipArchive, limits: OfficeLimits = OFFICE_LIMITS): OfficeResult {
  const wb = zip.text('xl/workbook.xml')
  if (wb == null) throw new OfficeError('文件已损坏（缺少工作簿 workbook.xml）')
  const rels = relsTargets(zip.text('xl/_rels/workbook.xml.rels'), 'xl')
  const sheets: { name: string; target: string; hidden: boolean }[] = []
  let date1904 = false
  for (const k of xmlTokens(wb)) {
    if (k.t !== 'o') continue
    if (k.n === 'workbookPr') date1904 = /^(1|true)$/i.test(attr(k.a, 'date1904') ?? '')
    if (k.n !== 'sheet') continue
    const name = attr(k.a, 'name') ?? `Sheet${sheets.length + 1}`
    const rid = relId(k.a)
    const target = (rid && rels.get(rid)?.target) || `xl/worksheets/sheet${sheets.length + 1}.xml`
    sheets.push({ name, target, hidden: /hidden/i.test(attr(k.a, 'state') ?? '') })
  }
  if (!sheets.length) {
    // 没有 workbook 描述：按 sheetN 编号排序兜底
    for (const e of zip.entries) {
      const m = /^xl\/worksheets\/sheet(\d+)\.xml$/i.exec(e.name)
      if (m) sheets.push({ name: `Sheet${m[1]}`, target: e.name, hidden: false })
    }
    sheets.sort((a, b) => Number(/\d+/.exec(a.name)?.[0]) - Number(/\d+/.exec(b.name)?.[0]))
  }
  const shared = parseSharedStrings(zip.text([...rels.values()].find(r => /\/sharedStrings$/.test(r.type))?.target ?? 'xl/sharedStrings.xml') ?? zip.text('xl/sharedStrings.xml'))
  const formats = parseCellFormats(zip.text([...rels.values()].find(r => /\/styles$/.test(r.type))?.target ?? 'xl/styles.xml') ?? zip.text('xl/styles.xml'))
  const budget = new Budget(limits.maxChars)
  const pages: string[] = []
  const names: string[] = []
  let truncated = sheets.length > limits.maxParts
  for (const sh of sheets.slice(0, limits.maxParts)) {
    if (budget.full) break
    const xml = zip.text(sh.target)
    // 图表工作表（chartsheet）/ 缺失的表：只留表名
    const res = xml && !/<(?:\w+:)?chartsheet\b/.test(xml.slice(0, 2000)) ? sheetXmlToRows(xml, { shared, formats, date1904, maxRows: limits.maxRows, maxCols: limits.maxCols }, budget) : { lines: [], truncated: false }
    if (res.truncated) truncated = true
    const head = `## ${sh.name}${sh.hidden ? '（隐藏）' : ''}`
    budget.take(head.length + 2)
    pages.push(res.lines.length ? `${head}\n${res.lines.join('\n')}${res.truncated ? `\n…（超过 ${limits.maxRows} 行 × ${limits.maxCols} 列的部分未读取）` : ''}` : `${head}\n（空表）`)
    names.push(sh.name)
  }
  return { ok: true, text: pages.join('\n\f\n'), pages: sheets.length, truncated: truncated || budget.truncated, format: 'xlsx', parts: names }
}

// ================================================================ pptx

/** 一张幻灯片 / 备注页 XML → 文本：a:p 段落、a:br 换行、表格单元格制表符分隔；skipFields 跳过页码等域 */
export function slideXmlToText(xml: string, skipFields = false): string {
  const out: string[] = []
  let para: string | null = null
  let inT = false
  let inTc = 0
  let row: string[] | null = null
  let cellBuf: string[] = []
  let fld = 0
  for (const k of xmlTokens(xml)) {
    if (k.t === 'o') {
      if (k.n === 'p' && k.q.startsWith('a:')) para = ''
      else if (k.n === 't' && k.q.startsWith('a:')) inT = !k.s
      else if (k.n === 'br' && para != null) para += '\n'
      else if (k.n === 'fld' && skipFields && !k.s) fld++
      else if (k.n === 'tr') row = []
      else if (k.n === 'tc') {
        inTc++
        cellBuf = []
      }
      continue
    }
    if (k.t === 'x') {
      if (inT && para != null && !fld) para += k.v
      continue
    }
    if (k.n === 't') inT = false
    else if (k.n === 'fld' && fld) fld--
    else if (k.n === 'p' && k.q.startsWith('a:') && para != null) {
      const s = para.trim()
      if (inTc) cellBuf.push(s)
      else if (s) out.push(s)
      para = null
    } else if (k.n === 'tc' && inTc) {
      inTc--
      row?.push(cellText(cellBuf.filter(Boolean).join(' ')))
    } else if (k.n === 'tr' && row) {
      if (row.some(Boolean)) out.push(row.join('\t'))
      row = null
    }
  }
  return tidyText(out.join('\n'))
}

export function readPptx(zip: ZipArchive, limits: OfficeLimits = OFFICE_LIMITS): OfficeResult {
  const pres = zip.text('ppt/presentation.xml')
  const rels = relsTargets(zip.text('ppt/_rels/presentation.xml.rels'), 'ppt')
  let slides: string[] = []
  if (pres) {
    for (const k of xmlTokens(pres)) {
      if (k.t === 'o' && k.n === 'sldId') {
        const t = rels.get(relId(k.a) ?? '')?.target
        if (t) slides.push(t)
      }
    }
  }
  if (!slides.length) {
    slides = zip.entries
      .map(e => e.name)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/i.exec(a)?.[1]) - Number(/(\d+)\.xml$/i.exec(b)?.[1]))
  }
  if (!slides.length && !pres) throw new OfficeError('文件已损坏（缺少演示文稿 presentation.xml）')
  const budget = new Budget(limits.maxChars)
  const pages: string[] = []
  const titles: string[] = []
  for (let i = 0; i < Math.min(slides.length, limits.maxParts); i++) {
    if (budget.full) break
    const path = slides[i]
    const xml = zip.text(path) ?? ''
    const hidden = /<p:sld\b[^>]*\bshow\s*=\s*"(0|false)"/.test(xml.slice(0, 2000))
    const body = slideXmlToText(xml)
    const dir = path.replace(/[^/]+$/, '')
    const srels = relsTargets(zip.text(`${dir}_rels/${path.slice(dir.length)}.rels`), dir.replace(/\/$/, ''))
    const notesPath = [...srels.values()].find(r => /\/notesSlide$/.test(r.type))?.target
    const notes = notesPath ? slideXmlToText(zip.text(notesPath) ?? '', true) : ''
    const page = `## 第 ${i + 1} 页${hidden ? '（隐藏）' : ''}\n${body || '（无文字）'}${notes ? `\n\n备注：${notes}` : ''}`
    budget.take(page.length + 3)
    pages.push(page)
    titles.push(body.split('\n')[0]?.slice(0, 60) ?? '')
  }
  return { ok: true, text: pages.join('\n\f\n'), pages: slides.length, truncated: budget.truncated || slides.length > limits.maxParts, format: 'pptx', parts: titles }
}

// ================================================================ OpenDocument

/**
 * content.xml → 文本。odt：段落 / 标题 / 表格（Markdown）；ods：每个 table:table 一页「## 表名」+ 制表符行；
 * odp：每个 draw:page 一页「## 第 N 页」+ 备注。重复行 / 列（number-*-repeated）按上限展开，空行跳过。
 */
export function odfContentToText(xml: string, kind: 'odt' | 'ods' | 'odp', limits: OfficeLimits = OFFICE_LIMITS): OfficeResult {
  const budget = new Budget(limits.maxChars)
  const pages: string[] = []
  const names: string[] = []
  let truncated = false
  let lines: string[] = []
  let paras: { buf: string; prefix: string }[] = []
  const tables: { name: string; rows: string[][]; row: string[] | null; rowRep: number; cell: string[] | null; colRep: number }[] = []
  let skip = 0
  let notes: string[] | null = null
  let slideNo = 0
  const sink = (line: string) => {
    const tb = tables[tables.length - 1]
    if (tb?.cell) tb.cell.push(line)
    else if (notes) notes.push(line)
    else {
      lines.push(line)
      budget.take(line.length + 1)
    }
  }
  const flushPage = (head: string) => {
    const body = tidyText(lines.join('\n'))
    pages.push(`${head}\n${body || (kind === 'ods' ? '（空表）' : '（无文字）')}`)
    lines = []
  }
  for (const k of xmlTokens(xml)) {
    if (budget.full) break
    if (skip) {
      if (k.t === 'o' && !k.s && SKIP_ODF.has(k.q)) skip++
      else if (k.t === 'c' && !k.s && SKIP_ODF.has(k.q)) skip--
      continue
    }
    const p = paras[paras.length - 1]
    if (k.t === 'x') {
      if (p) p.buf += k.v
      continue
    }
    if (k.t === 'o') {
      switch (k.q) {
        case 'text:p':
        case 'text:h':
          paras.push({ buf: '', prefix: k.q === 'text:h' && kind === 'odt' ? '#'.repeat(Math.min(6, Number(attr(k.a, 'outline-level')) || 1)) + ' ' : '' })
          if (k.s) paras.pop()
          break
        case 'text:s':
          if (p) p.buf += ' '.repeat(Math.min(50, Number(attr(k.a, 'c')) || 1))
          break
        case 'text:tab':
          if (p) p.buf += '\t'
          break
        case 'text:line-break':
          if (p) p.buf += '\n'
          break
        case 'table:table':
          tables.push({ name: attr(k.a, 'name') ?? `Sheet${pages.length + 1}`, rows: [], row: null, rowRep: 1, cell: null, colRep: 1 })
          break
        case 'table:table-row': {
          const tb = tables[tables.length - 1]
          if (tb) {
            tb.row = []
            tb.rowRep = Math.max(1, Number(attr(k.a, 'number-rows-repeated')) || 1)
            if (k.s) tb.row = null
          }
          break
        }
        case 'table:table-cell':
        case 'table:covered-table-cell': {
          const tb = tables[tables.length - 1]
          if (tb?.row) {
            tb.colRep = Math.max(1, Number(attr(k.a, 'number-columns-repeated')) || 1)
            tb.cell = []
            if (k.s) {
              // 空单元格：只占位（重复上千次的空列不展开）
              const n = Math.min(tb.colRep, limits.maxCols - tb.row.length)
              for (let i = 0; i < n; i++) tb.row.push('')
              tb.cell = null
            }
          }
          break
        }
        case 'draw:page':
          if (kind === 'odp') {
            slideNo++
            lines = []
          }
          break
        case 'presentation:notes':
          if (!k.s) notes = []
          break
        default:
          if (!k.s && SKIP_ODF.has(k.q)) skip = 1
      }
      continue
    }
    switch (k.q) {
      case 'text:p':
      case 'text:h': {
        const done = paras.pop()
        if (!done) break
        const s = done.buf.replace(/[  ]+$/g, '')
        sink(s.trim() ? done.prefix + s : '')
        break
      }
      case 'table:table-cell':
      case 'table:covered-table-cell': {
        const tb = tables[tables.length - 1]
        if (tb?.row && tb.cell) {
          const v = tb.cell.filter(Boolean).join(' ')
          const n = Math.min(tb.colRep, Math.max(0, limits.maxCols - tb.row.length))
          if (tb.colRep > n && v) truncated = true
          for (let i = 0; i < n; i++) tb.row.push(v)
          tb.cell = null
        }
        break
      }
      case 'table:table-row': {
        const tb = tables[tables.length - 1]
        if (tb?.row) {
          const vals = tb.row.map(cellText)
          while (vals.length && !vals[vals.length - 1]) vals.pop()
          if (vals.length) {
            const n = Math.min(tb.rowRep, Math.max(0, limits.maxRows - tb.rows.length))
            if (n < tb.rowRep) truncated = true
            for (let i = 0; i < n; i++) tb.rows.push(vals)
          }
          tb.row = null
        }
        break
      }
      case 'table:table': {
        const tb = tables.pop()
        if (!tb) break
        if (tables.length) sink(tb.rows.map(r => r.filter(Boolean).join(' / ')).join('；'))
        else if (kind === 'ods') {
          for (const r of tb.rows) sink(r.join('\t'))
          if (pages.length < limits.maxParts) flushPage(`## ${tb.name}`)
          else truncated = true
          names.push(tb.name)
        } else {
          const md = kind === 'odt' ? markdownTable(tb.rows) : tb.rows.map(r => r.join('\t')).join('\n')
          if (md) {
            sink('')
            sink(md)
            sink('')
          }
        }
        break
      }
      case 'presentation:notes': {
        const n = notes ? tidyText(notes.join('\n')) : ''
        notes = null
        if (n) sink(`\n备注：${n}`)
        break
      }
      case 'draw:page':
        if (kind === 'odp') {
          if (pages.length < limits.maxParts) flushPage(`## 第 ${slideNo} 页`)
          else truncated = true
          names.push(String(slideNo))
        }
        break
    }
  }
  if (kind === 'odt') return { ok: true, text: tidyText(lines.join('\n')), pages: 1, truncated: truncated || budget.truncated, format: 'odt' }
  return { ok: true, text: pages.join('\n\f\n'), pages: names.length, truncated: truncated || budget.truncated, format: kind, parts: names }
}

/** 批注、注释、修订、文本框外的替代内容：跳过 */
const SKIP_ODF = new Set(['office:annotation', 'text:tracked-changes', 'text:note-citation', 'svg:desc', 'svg:title', 'office:forms'])

function readOdf(zip: ZipArchive, limits: OfficeLimits): OfficeResult {
  const manifest = zip.text('META-INF/manifest.xml') ?? ''
  if (/encryption-data/.test(manifest)) throw new OfficeError('文档已加密（需要密码），无法读取文字')
  const mime = (zip.text('mimetype') ?? '').trim()
  const kind = /spreadsheet/.test(mime) ? 'ods' : /presentation/.test(mime) ? 'odp' : 'odt'
  const xml = zip.text('content.xml')
  if (xml == null) throw new OfficeError('文件已损坏（缺少 content.xml）')
  return odfContentToText(xml, kind, limits)
}

// ================================================================ 入口

/** 已打开的 ZIP 按内容判断是哪种文档 */
export function readOfficeZip(zip: ZipArchive, limits: OfficeLimits = OFFICE_LIMITS): OfficeResult {
  if (zip.has('word/document.xml')) return readDocx(zip, limits)
  if (zip.has('xl/workbook.xml')) return readXlsx(zip, limits)
  if (zip.has('ppt/presentation.xml') || zip.entries.some(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name))) return readPptx(zip, limits)
  if (zip.has('mimetype') || zip.has('content.xml')) return readOdf(zip, limits)
  if (zip.has('EncryptedPackage')) throw new OfficeError('文档已加密（需要密码），无法读取文字')
  // 内容类型清单里写着主文档部件（非标准路径）
  const ct = zip.text('[Content_Types].xml') ?? ''
  if (/wordprocessingml\.document\.main/.test(ct)) return readDocx(zip, limits)
  throw new OfficeError('不是可识别的 Word / Excel / PowerPoint 文档')
}

const OOXML_EXT = /^(docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|pptx|pptm|potx|potm|ppsx|ppsm)$/

/**
 * 字节 → 正文（同步，给子进程 / 单测用）。旧格式返回 { ok:false, format:'doc' } 让调用方走 textutil。
 */
export function extractOfficeBuffer(buf: Buffer, ext: string, limits: OfficeLimits = OFFICE_LIMITS): OfficeResult {
  const e = (ext || '').toLowerCase()
  try {
    if (isZip(buf)) {
      const r = readOfficeZip(openZip(buf, limits), limits)
      return { ...r, text: (r.text ?? '').slice(0, limits.maxChars), truncated: r.truncated || (r.text ?? '').length > limits.maxChars }
    }
    if (isCfb(buf)) {
      if (OOXML_EXT.test(e)) return { ok: false, error: '文档已加密（需要密码），无法读取文字' }
      if (e === 'xls' || e === 'xlt') return { ok: false, error: '旧版 Excel（.xls）暂不支持读取文字，可另存为 .xlsx 后再试' }
      if (e === 'ppt' || e === 'pps') return { ok: false, error: '旧版 PowerPoint（.ppt）暂不支持读取文字，可另存为 .pptx 后再试' }
      return { ok: false, format: 'doc', error: 'legacy' }
    }
    if (/^\s*\{\\rtf/.test(buf.subarray(0, 64).toString('latin1'))) return { ok: false, format: 'rtf', error: 'legacy' }
    if (e === 'doc' || e === 'dot') return { ok: false, format: 'doc', error: 'legacy' }
    return { ok: false, error: '文件已损坏或不是有效的 Office 文档' }
  } catch (err) {
    if (err instanceof OfficeError) return { ok: false, error: err.message }
    return { ok: false, error: `文件已损坏或无法解析：${err instanceof Error ? err.message : String(err)}` }
  }
}

/** macOS textutil 转纯文本（.doc / .rtf）：execFile 不经 shell，路径作参数，带超时与输出上限 */
export function textutilToText(path: string, timeoutMs = OFFICE_LIMITS.timeoutMs, maxBytes = 16 * 1024 * 1024): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (process.platform !== 'darwin') return Promise.resolve({ ok: false, error: '旧版 Word（.doc）只在 macOS 上支持读取文字，可另存为 .docx 后再试' })
  const abs = isAbsolute(path) ? path : resolve(path)
  return new Promise(done => {
    execFile('/usr/bin/textutil', ['-convert', 'txt', '-encoding', 'UTF-8', '-stdout', abs], { timeout: timeoutMs, maxBuffer: maxBytes, encoding: 'buffer', windowsHide: true }, (err, stdout) => {
      if (err) {
        const killed = (err as { killed?: boolean }).killed
        return done({ ok: false, error: killed ? `读取超时（${Math.round(timeoutMs / 1000)} 秒）` : '旧版 Word 文档无法读取（可能已加密或损坏），可另存为 .docx 后再试' })
      }
      done({ ok: true, text: tidyText(Buffer.from(stdout).toString('utf8').replace(/[\u2028\u2029]/g, '\n')) })
    })
  })
}

/** 文件 → 正文：大小检查 → 按内容解析；旧版 doc / rtf 交给 textutil */
export async function extractOffice(path: string, ext: string, limits: OfficeLimits = OFFICE_LIMITS): Promise<OfficeResult> {
  let size = 0
  try {
    size = statSync(path).size
  } catch (err) {
    return { ok: false, error: `读取失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (size > limits.maxFileBytes) return { ok: false, error: `文件过大（${Math.round(size / 1048576)} MB），未提取` }
  const buf = readFileSync(path)
  const r = extractOfficeBuffer(buf, ext, limits)
  if (r.ok || r.error !== 'legacy') return r
  const t = await textutilToText(path, limits.timeoutMs)
  if (!t.ok) return { ok: false, error: t.error }
  const text = t.text ?? ''
  return { ok: true, text: text.slice(0, limits.maxChars), pages: 1, truncated: text.length > limits.maxChars, format: r.format }
}
