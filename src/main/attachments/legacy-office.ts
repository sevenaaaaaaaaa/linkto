import { Budget, builtinFmtKind, excelSerialToText, fmtKindOfCode, OfficeError, tidyNumber, type CellFmt, type OfficeLimits, type OfficeResult } from './office'
import { tidyText } from './text-parse'

/**
 * 旧版 Office 二进制格式（Word / Excel / PowerPoint 97-2003）正文提取：纯函数、无 IO、无第三方依赖，在 office-worker 子进程里跑。
 *  - CFB（复合文档 / OLE2）读取器：头部 → DIFAT → FAT / MiniFAT → 目录树 → 流；扇区链断裂 / 循环、扇区数、流大小、目录项数都有上限
 *  - .xls（BIFF8）：Workbook 流 → 表名（BOUNDSHEET）、共享字符串（SST，含跨 CONTINUE 的字符串拆分）、各类单元格记录，
 *    按工作表输出（「## 表名」+ 制表符分隔行，与 xlsx 一致）；日期按 FORMAT / XF 粗略判断
 *  - .ppt：PowerPoint Document 流 → 按 Current User → UserEditAtom → PersistDirectory 定位幻灯片，按 SlideListWithText 的顺序分页，
 *    取 TextCharsAtom（UTF-16）/ TextBytesAtom（8 位）；定位不到时按流中出现顺序并说明
 *  - .doc：WordDocument 流的 FIB → 0Table / 1Table 流里的 piece table（Clx / PlcPcd）还原正文（压缩 8 位 / UTF-16 片段），去掉域代码
 *  - 加密（FILEPASS / 加密标志 / 加密的 Current User）给出「已加密」提示
 * 只读文本，从不执行宏、不解析嵌入对象。
 */

// ================================================================ CFB

const FREESECT = 0xffffffff
const ENDOFCHAIN = 0xfffffffe
const MAXREGSECT = 0xfffffffa
const NOSTREAM = 0xffffffff

export const CFB_LIMITS = {
  /** 单个流最大字节数 */
  maxStreamBytes: 64 * 1024 * 1024,
  /** 目录项数 */
  maxDirEntries: 50_000
}

export interface CfbEntry {
  id: number
  name: string
  /** 1 = storage，2 = stream，5 = root */
  type: number
  left: number
  right: number
  child: number
  start: number
  size: number
}

export interface Cfb {
  entries: CfbEntry[]
  sectorSize: number
  /** 某个 storage（默认根）下的直接子项（遍历兄弟红黑树） */
  children(parent?: number): CfbEntry[]
  /** 某个 storage 下按名字找（不区分大小写） */
  find(name: string, parent?: number): CfbEntry | null
  read(e: CfbEntry): Buffer
  /** 根目录下的流（没有返回 null） */
  stream(name: string): Buffer | null
}

export function isCfbBuffer(buf: Uint8Array): boolean {
  return buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0 && buf[4] === 0xa1 && buf[5] === 0xb1 && buf[6] === 0x1a && buf[7] === 0xe1
}

const corrupt = (why: string) => new OfficeError(`文件已损坏（${why}）`)

/** 打开复合文档：只解析头部、FAT、目录；流按需读取 */
export function openCfb(buf: Buffer, limits: Partial<typeof CFB_LIMITS> = {}): Cfb {
  const maxStream = limits.maxStreamBytes ?? CFB_LIMITS.maxStreamBytes
  const maxDir = limits.maxDirEntries ?? CFB_LIMITS.maxDirEntries
  if (buf.length < 512 || !isCfbBuffer(buf)) throw corrupt('不是有效的复合文档')
  const major = buf.readUInt16LE(0x1a)
  const shift = buf.readUInt16LE(0x1e)
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12))) throw corrupt('复合文档头无效')
  if (buf.readUInt16LE(0x1c) !== 0xfffe) throw corrupt('复合文档字节序标记无效')
  const ss = 1 << shift
  if (buf.readUInt16LE(0x20) !== 6) throw corrupt('迷你扇区大小无效')
  const miniSize = 64
  const nFat = buf.readUInt32LE(0x2c)
  const dirStart = buf.readUInt32LE(0x30)
  const cutoff = buf.readUInt32LE(0x38) || 4096
  const miniFatStart = buf.readUInt32LE(0x3c)
  const difatStart = buf.readUInt32LE(0x44)
  const nDifat = buf.readUInt32LE(0x48)
  /** 文件里实际有多少个扇区（最后一个可以不完整） */
  const nSectors = Math.ceil((buf.length - ss) / ss)
  if (nFat > nSectors || nDifat > nSectors) throw corrupt('扇区数超出文件大小')

  const sectorAt = (s: number): Buffer => {
    if (s > MAXREGSECT || s >= nSectors) throw corrupt('扇区编号超出范围')
    const off = (s + 1) * ss
    return buf.subarray(off, Math.min(buf.length, off + ss))
  }

  // DIFAT：头部 109 项 + DIFAT 扇区链
  const fatSecs: number[] = []
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) {
    const v = buf.readUInt32LE(0x4c + i * 4)
    if (v <= MAXREGSECT) fatSecs.push(v)
  }
  {
    let d = difatStart
    const seen = new Set<number>()
    while (fatSecs.length < nFat && d !== ENDOFCHAIN && d !== FREESECT) {
      if (seen.has(d)) throw corrupt('DIFAT 扇区链出现循环')
      if (seen.size >= nDifat + 1) throw corrupt('DIFAT 扇区数超出声明')
      seen.add(d)
      const sec = sectorAt(d)
      const per = ss / 4 - 1
      for (let i = 0; i < per && fatSecs.length < nFat && (i + 1) * 4 <= sec.length; i++) {
        const v = sec.readUInt32LE(i * 4)
        if (v <= MAXREGSECT) fatSecs.push(v)
      }
      d = sec.length >= ss ? sec.readUInt32LE(ss - 4) : ENDOFCHAIN
    }
  }
  if (!fatSecs.length) throw corrupt('没有 FAT 扇区')
  const fat = new Uint32Array(fatSecs.length * (ss / 4)).fill(FREESECT)
  fatSecs.forEach((s, k) => {
    const sec = sectorAt(s)
    for (let i = 0; i + 4 <= sec.length; i += 4) fat[k * (ss / 4) + i / 4] = sec.readUInt32LE(i)
  })

  /** 沿扇区链取 count 个扇区（count < 0 = 读到 ENDOFCHAIN）；断裂 / 循环 / 超出上限抛错 */
  const chain = (start: number, table: Uint32Array, count: number, max: number, what: string): number[] => {
    const out: number[] = []
    const seen = new Uint8Array(table.length)
    let s = start
    while (count < 0 || out.length < count) {
      if (s === ENDOFCHAIN) {
        if (count < 0) break
        throw corrupt(`${what}数据不完整`)
      }
      if (s > MAXREGSECT || s >= table.length) throw corrupt(`${what}扇区链断裂`)
      if (seen[s]) throw corrupt(`${what}扇区链出现循环`)
      seen[s] = 1
      out.push(s)
      if (out.length > max) throw new OfficeError(`文件中的${what}过大，未读取`)
      s = table[s]
    }
    return out
  }

  const readFat = (start: number, size: number, what: string): Buffer => {
    if (size > maxStream) throw new OfficeError(`文件中的${what}过大（${Math.round(size / 1048576)} MB），未读取`)
    const n = Math.ceil(size / ss)
    const secs = chain(start, fat, n, Math.min(nSectors, Math.ceil(maxStream / ss)), what)
    const out = Buffer.alloc(size)
    let off = 0
    for (const s of secs) {
      const sec = sectorAt(s)
      const take = Math.min(sec.length, size - off)
      sec.copy(out, off, 0, take)
      off += take
      if (sec.length < ss && off < size) throw corrupt(`${what}数据不完整`)
    }
    return out
  }

  // 目录
  const dirSecs = chain(dirStart, fat, -1, Math.ceil((maxDir * 128) / ss), '目录')
  const entries: CfbEntry[] = []
  for (const s of dirSecs) {
    const sec = sectorAt(s)
    for (let o = 0; o + 128 <= sec.length; o += 128) {
      const nameLen = Math.min(64, sec.readUInt16LE(o + 0x40))
      const type = sec[o + 0x42]
      const lo = sec.readUInt32LE(o + 0x78)
      const hi = major === 4 ? sec.readUInt32LE(o + 0x7c) : 0
      entries.push({
        id: entries.length,
        name: nameLen >= 2 ? sec.toString('utf16le', o, o + nameLen - 2) : '',
        type,
        left: sec.readUInt32LE(o + 0x44),
        right: sec.readUInt32LE(o + 0x48),
        child: sec.readUInt32LE(o + 0x4c),
        start: sec.readUInt32LE(o + 0x74),
        size: hi ? Number.MAX_SAFE_INTEGER : lo
      })
      if (entries.length > maxDir) throw new OfficeError('文件中的目录项过多，未读取')
    }
  }
  const root = entries[0]
  if (!root || root.type !== 5) throw corrupt('缺少根目录')

  // MiniFAT 与迷你流（小于 cutoff 的流都放在根目录的迷你流里）
  let miniFat: Uint32Array | null = null
  let miniStream: Buffer | null = null
  const ensureMini = () => {
    if (miniFat && miniStream) return
    const secs = miniFatStart <= MAXREGSECT ? chain(miniFatStart, fat, -1, nSectors, 'MiniFAT ') : []
    miniFat = new Uint32Array(secs.length * (ss / 4)).fill(FREESECT)
    secs.forEach((s, k) => {
      const sec = sectorAt(s)
      for (let i = 0; i + 4 <= sec.length; i += 4) miniFat![k * (ss / 4) + i / 4] = sec.readUInt32LE(i)
    })
    miniStream = root.size && root.start <= MAXREGSECT ? readFat(root.start, root.size, '迷你流') : Buffer.alloc(0)
  }

  const read = (e: CfbEntry): Buffer => {
    if (e.type !== 2) throw new OfficeError('不是数据流')
    if (e.size === 0) return Buffer.alloc(0)
    if (e.size >= cutoff) return readFat(e.start, e.size, `数据流「${e.name}」`)
    ensureMini()
    const secs = chain(e.start, miniFat!, Math.ceil(e.size / miniSize), miniFat!.length, `数据流「${e.name}」`)
    const out = Buffer.alloc(e.size)
    let off = 0
    for (const s of secs) {
      const at = s * miniSize
      if (at >= miniStream!.length) throw corrupt('迷你流越界')
      const take = Math.min(miniSize, e.size - off, miniStream!.length - at)
      miniStream!.copy(out, off, at, at + take)
      off += take
    }
    if (off < e.size) throw corrupt(`数据流「${e.name}」数据不完整`)
    return out
  }

  const children = (parent = 0): CfbEntry[] => {
    const p = entries[parent]
    if (!p) return []
    const out: CfbEntry[] = []
    const seen = new Set<number>()
    const stack = [p.child]
    while (stack.length) {
      const i = stack.pop()!
      if (i === NOSTREAM || i >= entries.length || seen.has(i)) continue
      seen.add(i)
      const e = entries[i]
      out.push(e)
      stack.push(e.left, e.right)
    }
    return out.sort((a, b) => a.id - b.id)
  }

  const find = (name: string, parent = 0): CfbEntry | null => {
    const n = name.toLowerCase()
    return children(parent).find(e => e.name.toLowerCase() === n) ?? null
  }

  return {
    entries,
    sectorSize: ss,
    children,
    find,
    read,
    stream(name) {
      const e = find(name)
      return e && e.type === 2 ? read(e) : null
    }
  }
}

const ENCRYPTED = '文档已加密（需要密码），无法读取文字'

// ================================================================ xls（BIFF8）

interface BiffRec {
  type: number
  pos: number
  data: Buffer
}

function* biffRecords(buf: Buffer, start = 0): Generator<BiffRec> {
  let p = start
  while (p + 4 <= buf.length) {
    const type = buf.readUInt16LE(p)
    const len = buf.readUInt16LE(p + 2)
    if (p + 4 + len > buf.length) return
    yield { type, pos: p, data: buf.subarray(p + 4, p + 4 + len) }
    p += 4 + len
  }
}

/** 跨 CONTINUE 记录的读取器：字符数组被拆开时，后一段开头多一个 fHighByte 标志字节 */
export class BiffReader {
  si = 0
  pos = 0
  constructor(private segs: Buffer[]) {}
  private next(): boolean {
    if (this.si + 1 >= this.segs.length) return false
    this.si++
    this.pos = 0
    return true
  }
  get done(): boolean {
    return this.si >= this.segs.length - 1 && this.pos >= (this.segs[this.si]?.length ?? 0)
  }
  private avail(): number {
    return (this.segs[this.si]?.length ?? 0) - this.pos
  }
  u8(): number {
    while (this.avail() <= 0) if (!this.next()) throw new RangeError('eof')
    return this.segs[this.si][this.pos++]
  }
  u16(): number {
    return this.u8() | (this.u8() << 8)
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0
  }
  skip(n: number) {
    while (n > 0) {
      while (this.avail() <= 0) if (!this.next()) throw new RangeError('eof')
      const k = Math.min(n, this.avail())
      this.pos += k
      n -= k
    }
  }
  /** cch 个字符（high = UTF-16，否则每字节一个字符的「压缩」Unicode） */
  chars(cch: number, high: boolean): string {
    let out = ''
    let left = cch
    while (left > 0) {
      if (this.avail() <= 0) {
        if (!this.next()) throw new RangeError('eof')
        high = (this.u8() & 1) === 1
        continue
      }
      const seg = this.segs[this.si]
      if (high) {
        const k = Math.min(left, Math.floor(this.avail() / 2))
        if (k === 0) throw new RangeError('split')
        out += seg.toString('utf16le', this.pos, this.pos + k * 2)
        this.pos += k * 2
        left -= k
      } else {
        const k = Math.min(left, this.avail())
        out += seg.toString('latin1', this.pos, this.pos + k)
        this.pos += k
        left -= k
      }
    }
    return out
  }
  /** XLUnicodeRichExtendedString（SST 里的字符串） */
  richString(): string {
    const cch = this.u16()
    const flags = this.u8()
    const runs = flags & 0x08 ? this.u16() : 0
    const ext = flags & 0x04 ? this.u32() : 0
    const s = this.chars(cch, (flags & 1) === 1)
    if (runs) this.skip(runs * 4)
    if (ext) this.skip(ext)
    return s
  }
}

/** SST 记录 + 其后的 CONTINUE 记录 → 共享字符串表（损坏时返回已读到的部分） */
export function parseSst(segs: Buffer[], max = 1_000_000): string[] {
  const r = new BiffReader(segs)
  const out: string[] = []
  try {
    r.u32()
    const unique = r.u32()
    const n = Math.min(unique, max)
    for (let i = 0; i < n && !r.done; i++) out.push(r.richString())
  } catch {
    /* 截断：保留已读到的部分 */
  }
  return out
}

/** XLUnicodeString（LABEL / FORMAT / STRING 记录里：cch u16 + flags + 字符） */
function xlString(data: Buffer, off: number, cont: Buffer[] = []): string {
  try {
    const r = new BiffReader([data.subarray(off), ...cont])
    const cch = r.u16()
    const flags = r.u8()
    return r.chars(cch, (flags & 1) === 1)
  } catch {
    return ''
  }
}

/** ShortXLUnicodeString（BOUNDSHEET 表名：cch u8 + flags + 字符） */
function shortXlString(data: Buffer, off: number): string {
  if (off + 2 > data.length) return ''
  const cch = data[off]
  const high = (data[off + 1] & 1) === 1
  const start = off + 2
  return high ? data.toString('utf16le', start, Math.min(data.length, start + cch * 2)) : data.toString('latin1', start, Math.min(data.length, start + cch))
}

/** RK 数值 */
export function decodeRk(rk: number): number {
  let v: number
  if (rk & 2) v = rk >> 2
  else {
    const b = Buffer.alloc(8)
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4)
    v = b.readDoubleLE(0)
  }
  return rk & 1 ? v / 100 : v
}

const BIFF_ERR: Record<number, string> = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A', 0x2b: '#GETTING_DATA' }

function numText(v: number, fmt: CellFmt, date1904: boolean): string {
  if (!Number.isFinite(v)) return String(v)
  if (fmt && fmt !== 'percent') return excelSerialToText(v, fmt, date1904)
  if (fmt === 'percent') return `${tidyNumber(String(v * 100))}%`
  return tidyNumber(String(v))
}

export function readXls(cfb: Cfb, limits: OfficeLimits): OfficeResult {
  if (!cfb.find('Workbook') && cfb.find('Book')) throw new OfficeError('Excel 5.0 / 95 格式的工作簿暂不支持读取文字，可另存为 .xlsx 后再试')
  const wb = cfb.stream('Workbook')
  if (!wb) throw corrupt('缺少工作簿数据流')
  const first = biffRecords(wb).next().value as BiffRec | undefined
  if (!first || first.type !== 0x0809 || first.data.length < 4) throw corrupt('工作簿开头不是 BOF 记录')
  if (first.data.readUInt16LE(0) !== 0x0600) throw new OfficeError('这个版本的 Excel 工作簿（BIFF8 之前）暂不支持读取文字，可另存为 .xlsx 后再试')

  // 工作簿全局：表名、共享字符串、格式、XF、日期体系；遇到 FILEPASS 即已加密
  const sheets: { name: string; pos: number; hidden: boolean; chart: boolean }[] = []
  const formats = new Map<number, string>()
  const xfFmt: number[] = []
  let sst: string[] = []
  let date1904 = false
  {
    const it = biffRecords(wb)
    let pending: { type: number; segs: Buffer[] } | null = null
    const flush = () => {
      if (pending?.type === 0x00fc) sst = parseSst(pending.segs)
      else if (pending?.type === 0x041e && pending.segs[0].length >= 2) formats.set(pending.segs[0].readUInt16LE(0), xlString(pending.segs[0], 2, pending.segs.slice(1)))
      pending = null
    }
    let n = 0
    for (const r of it) {
      if (r.type === 0x003c && pending) {
        pending.segs.push(r.data)
        continue
      }
      flush()
      if (n++ > 0 && r.type === 0x000a) break // 全局区 EOF
      switch (r.type) {
        case 0x002f:
          throw new OfficeError(ENCRYPTED)
        case 0x0085:
          if (r.data.length >= 8) sheets.push({ pos: r.data.readUInt32LE(0), hidden: (r.data[4] & 3) !== 0, chart: r.data[5] === 2, name: shortXlString(r.data, 6) || `Sheet${sheets.length + 1}` })
          break
        case 0x00fc:
        case 0x041e:
          pending = { type: r.type, segs: [r.data] }
          break
        case 0x00e0:
          if (r.data.length >= 4) xfFmt.push(r.data.readUInt16LE(2))
          break
        case 0x0022:
          if (r.data.length >= 2) date1904 = r.data.readUInt16LE(0) === 1
          break
      }
    }
    flush()
  }
  const fmtCache = new Map<number, CellFmt>()
  const fmtOfXf = (ixfe: number): CellFmt => {
    const id = xfFmt[ixfe]
    if (id == null) return null
    if (!fmtCache.has(id)) {
      const code = formats.get(id)
      fmtCache.set(id, code != null ? fmtKindOfCode(code) : builtinFmtKind(id))
    }
    return fmtCache.get(id) ?? null
  }

  const budget = new Budget(limits.maxChars)
  const pages: string[] = []
  const names: string[] = []
  let truncated = sheets.length > limits.maxParts
  for (const sh of sheets.slice(0, limits.maxParts)) {
    if (budget.full) break
    const head = `## ${sh.name}${sh.hidden ? '（隐藏）' : ''}`
    names.push(sh.name)
    budget.take(head.length + 2)
    const res = sh.chart ? { lines: [], truncated: false } : xlsSheetRows(wb, sh.pos, { sst, fmtOfXf, date1904, maxRows: limits.maxRows, maxCols: limits.maxCols }, budget)
    if (res.truncated) truncated = true
    pages.push(res.lines.length ? `${head}\n${res.lines.join('\n')}${res.truncated ? `\n…（超过 ${limits.maxRows} 行 × ${limits.maxCols} 列的部分未读取）` : ''}` : `${head}\n（空表）`)
  }
  return { ok: true, text: pages.join('\n\f\n'), pages: sheets.length, truncated: truncated || budget.truncated, format: 'xls', parts: names }
}

interface XlsSheetOpts {
  sst: string[]
  fmtOfXf(ixfe: number): CellFmt
  date1904: boolean
  maxRows: number
  maxCols: number
}

/** 一个工作表子流（从 BOF 到对应的 EOF）→ 制表符分隔的行 */
function xlsSheetRows(wb: Buffer, pos: number, o: XlsSheetOpts, budget: Budget): { lines: string[]; truncated: boolean } {
  const rows = new Map<number, string[]>()
  let truncated = false
  const set = (row: number, col: number, v: string) => {
    if (col >= o.maxCols) {
      truncated = true
      return
    }
    let r = rows.get(row)
    if (!r) {
      // 行数到上限：之后新出现的行不再收集（BIFF 按行块顺序存放）
      if (rows.size >= o.maxRows) {
        truncated = true
        return
      }
      r = []
      rows.set(row, r)
    }
    r[col] = v.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\t/g, ' ').trim()
  }
  if (pos <= 0 || pos >= wb.length) return { lines: [], truncated: false }
  let depth = 0
  let pendingStr: { row: number; col: number } | null = null
  let strSegs: Buffer[] | null = null
  const flushStr = () => {
    if (strSegs && pendingStr) set(pendingStr.row, pendingStr.col, xlString(strSegs[0], 0, strSegs.slice(1)))
    strSegs = null
    pendingStr = null
  }
  for (const r of biffRecords(wb, pos)) {
    const d = r.data
    if (r.type === 0x003c && strSegs) {
      strSegs.push(d)
      continue
    }
    if (strSegs) flushStr()
    if (r.type === 0x0809) {
      depth++
      continue
    }
    if (r.type === 0x000a) {
      if (--depth <= 0) break
      continue
    }
    if (depth !== 1) continue // 嵌入图表等子流
    if (d.length < 6 && r.type !== 0x0207) continue
    switch (r.type) {
      case 0x00fd: // LABELSST
        if (d.length >= 10) set(d.readUInt16LE(0), d.readUInt16LE(2), o.sst[d.readUInt32LE(6)] ?? '')
        break
      case 0x0204: // LABEL
      case 0x00d6: // RSTRING
        set(d.readUInt16LE(0), d.readUInt16LE(2), xlString(d, 6))
        break
      case 0x0203: // NUMBER
        if (d.length >= 14) set(d.readUInt16LE(0), d.readUInt16LE(2), numText(d.readDoubleLE(6), o.fmtOfXf(d.readUInt16LE(4)), o.date1904))
        break
      case 0x027e: // RK
        if (d.length >= 10) set(d.readUInt16LE(0), d.readUInt16LE(2), numText(decodeRk(d.readUInt32LE(6)), o.fmtOfXf(d.readUInt16LE(4)), o.date1904))
        break
      case 0x00bd: {
        // MULRK：rw, colFirst, [ixfe, rk]*, colLast
        const row = d.readUInt16LE(0)
        const c0 = d.readUInt16LE(2)
        const n = Math.floor((d.length - 6) / 6)
        for (let i = 0; i < n; i++) {
          const at = 4 + i * 6
          set(row, c0 + i, numText(decodeRk(d.readUInt32LE(at + 2)), o.fmtOfXf(d.readUInt16LE(at)), o.date1904))
        }
        break
      }
      case 0x0006: {
        // FORMULA：只取缓存的计算结果
        pendingStr = null
        if (d.length < 20) break
        const row = d.readUInt16LE(0)
        const col = d.readUInt16LE(2)
        if (d.readUInt16LE(12) === 0xffff) {
          const kind = d[6]
          if (kind === 0) pendingStr = { row, col } // 结果在紧随其后的 STRING 记录里
          else if (kind === 1) set(row, col, d[8] ? 'TRUE' : 'FALSE')
          else if (kind === 2) set(row, col, BIFF_ERR[d[8]] ?? '#ERR')
        } else set(row, col, numText(d.readDoubleLE(6), o.fmtOfXf(d.readUInt16LE(4)), o.date1904))
        break
      }
      case 0x0207: // STRING（公式的字符串结果）
        if (pendingStr) strSegs = [d]
        break
      case 0x0205: // BOOLERR
        if (d.length >= 8) set(d.readUInt16LE(0), d.readUInt16LE(2), d[7] ? (BIFF_ERR[d[6]] ?? '#ERR') : d[6] ? 'TRUE' : 'FALSE')
        break
    }
    // 公式的 STRING 结果只会紧跟在 FORMULA（及其共享公式 / 数组 / 模拟运算表记录）之后
    if (r.type !== 0x0006 && r.type !== 0x0207 && r.type !== 0x04bc && r.type !== 0x0221 && r.type !== 0x0236) pendingStr = null
  }
  if (strSegs) flushStr()
  const lines: string[] = []
  for (const k of [...rows.keys()].sort((a, b) => a - b)) {
    const r = rows.get(k)!
    const vals = Array.from({ length: r.length }, (_, i) => r[i] ?? '')
    while (vals.length && !vals[vals.length - 1]) vals.pop()
    if (!vals.some(Boolean)) continue
    const line = vals.join('\t')
    lines.push(line)
    if (!budget.take(line.length + 1)) {
      truncated = true
      break
    }
  }
  return { lines, truncated }
}

// ================================================================ ppt

interface PptRec {
  type: number
  inst: number
  ver: number
  /** 数据起点 */
  off: number
  len: number
}

function pptHeader(buf: Buffer, p: number, end: number): PptRec | null {
  if (p + 8 > end) return null
  const vi = buf.readUInt16LE(p)
  const len = buf.readUInt32LE(p + 4)
  if (p + 8 + len > end) return null
  return { ver: vi & 0x0f, inst: vi >> 4, type: buf.readUInt16LE(p + 2), off: p + 8, len }
}

/** [start, end) 范围内的同级记录 */
function* pptChildren(buf: Buffer, start: number, end: number): Generator<PptRec> {
  let p = start
  let n = 0
  while (p < end && n++ < 1_000_000) {
    const h = pptHeader(buf, p, end)
    if (!h) return
    yield h
    p = h.off + h.len
  }
}

const RT = {
  Document: 0x03e8,
  Slide: 0x03ee,
  SlideAtom: 0x03ef,
  Notes: 0x03f0,
  SlidePersistAtom: 0x03f3,
  MainMaster: 0x03f8,
  SlideListWithText: 0x0ff0,
  TextChars: 0x0fa0,
  TextBytes: 0x0fa8,
  UserEditAtom: 0x0ff5,
  PersistDirectoryAtom: 0x1772
}

/** PPT 文本原子 → 文本（\r 段落 / \v 换行 → \n，去掉其余控制字符） */
export function pptAtomText(buf: Buffer, h: PptRec): string {
  const raw = h.type === RT.TextChars ? buf.toString('utf16le', h.off, h.off + (h.len & ~1)) : buf.toString('latin1', h.off, h.off + h.len)
  return raw
    .replace(/[\r\v]/g, '\n')
    .replace(/[\x00-\x08\x0c\x0e-\x1f￾￿]/g, '')
    .trim()
}

/** 某个容器里（递归）的全部文本原子 */
function pptTexts(buf: Buffer, start: number, end: number, depth = 0, out: string[] = []): string[] {
  if (depth > 32) return out
  for (const h of pptChildren(buf, start, end)) {
    if (h.type === RT.TextChars || h.type === RT.TextBytes) {
      const t = pptAtomText(buf, h)
      if (t) out.push(t)
    } else if (h.ver === 0x0f) pptTexts(buf, h.off, h.off + h.len, depth + 1, out)
  }
  return out
}

/** Current User → UserEditAtom 链 → persistId → 流内偏移（新的编辑覆盖旧的） */
export function pptPersistMap(doc: Buffer, currentUser: Buffer | null): { map: Map<number, number>; docRef: number; encrypted: boolean } | null {
  if (!currentUser || currentUser.length < 20) return null
  const token = currentUser.readUInt32LE(12)
  if (token === 0xf3d1c4df) return { map: new Map(), docRef: 0, encrypted: true }
  let edit = currentUser.readUInt32LE(16)
  const map = new Map<number, number>()
  let docRef = 0
  const seen = new Set<number>()
  let first = true
  while (seen.size < 10_000) {
    if (seen.has(edit)) break
    seen.add(edit)
    const h = pptHeader(doc, edit, doc.length)
    if (!h || h.type !== RT.UserEditAtom || h.len < 0x1c) return first ? null : { map, docRef, encrypted: false }
    if (first) {
      docRef = doc.readUInt32LE(h.off + 16)
      // 带 encryptSessionPersistIdRef 的 UserEditAtom（长度 0x20）= 已加密
      if (h.len >= 0x20) return { map, docRef, encrypted: true }
    }
    first = false
    const dir = pptHeader(doc, doc.readUInt32LE(h.off + 12), doc.length)
    if (dir && dir.type === RT.PersistDirectoryAtom) {
      let p = dir.off
      const end = dir.off + dir.len
      while (p + 4 <= end) {
        const v = doc.readUInt32LE(p)
        const id0 = v & 0xfffff
        const n = v >>> 20
        p += 4
        for (let i = 0; i < n && p + 4 <= end; i++, p += 4) if (!map.has(id0 + i)) map.set(id0 + i, doc.readUInt32LE(p))
      }
    }
    const last = doc.readUInt32LE(h.off + 8)
    if (!last) break
    edit = last
  }
  return { map, docRef, encrypted: false }
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>()
  return list.filter(t => (seen.has(t) ? false : (seen.add(t), true)))
}

export function readPpt(cfb: Cfb, limits: OfficeLimits): OfficeResult {
  if (cfb.find('EncryptedSummary')) throw new OfficeError(ENCRYPTED)
  const doc = cfb.stream('PowerPoint Document')
  if (!doc) throw corrupt('缺少演示文稿数据流')
  const persist = pptPersistMap(doc, cfb.stream('Current User'))
  if (persist?.encrypted) throw new OfficeError(ENCRYPTED)

  const at = (offset: number | undefined, type: number): PptRec | null => {
    if (offset == null) return null
    const h = pptHeader(doc, offset, doc.length)
    return h && h.type === type ? h : null
  }
  // 文档容器：优先按 persist 定位，否则取流中第一个
  let docRec = persist ? at(persist.map.get(persist.docRef), RT.Document) : null
  if (!docRec) for (const h of pptChildren(doc, 0, doc.length)) if (h.type === RT.Document) docRec = h

  // SlideListWithText（instance 0 = 幻灯片）：SlidePersistAtom 分页，其后的文本原子属于这一页
  const slides: { ref: number; texts: string[] }[] = []
  if (docRec) {
    for (const h of pptChildren(doc, docRec.off, docRec.off + docRec.len)) {
      if (h.type !== RT.SlideListWithText || h.inst !== 0) continue
      for (const c of pptChildren(doc, h.off, h.off + h.len)) {
        if (c.type === RT.SlidePersistAtom && c.len >= 4) slides.push({ ref: doc.readUInt32LE(c.off), texts: [] })
        else if ((c.type === RT.TextChars || c.type === RT.TextBytes) && slides.length) {
          const t = pptAtomText(doc, c)
          if (t) slides[slides.length - 1].texts.push(t)
        }
      }
    }
  }

  let note: string | null = null
  const pages: { body: string[]; notes: string[] }[] = []
  if (slides.length) {
    for (const s of slides) {
      const body = [...s.texts]
      const notes: string[] = []
      const rec = persist ? at(persist.map.get(s.ref), RT.Slide) : null
      if (rec) {
        body.push(...pptTexts(doc, rec.off, rec.off + rec.len))
        // SlideAtom.notesIdRef → 备注页
        for (const c of pptChildren(doc, rec.off, rec.off + rec.len)) {
          if (c.type !== RT.SlideAtom || c.len < 20) continue
          const nref = doc.readUInt32LE(c.off + 16)
          const nrec = nref ? at(persist!.map.get(nref), RT.Notes) : null
          if (nrec) notes.push(...pptTexts(doc, nrec.off, nrec.off + nrec.len))
        }
      }
      pages.push({ body: dedupe(body), notes: dedupe(notes) })
    }
  } else {
    // 定位不到幻灯片列表：按流中出现顺序取每个幻灯片容器
    for (const h of pptChildren(doc, 0, doc.length)) if (h.type === RT.Slide) pages.push({ body: dedupe(pptTexts(doc, h.off, h.off + h.len)), notes: [] })
    if (pages.length > 1) note = '（未能读取放映顺序，以下按文件中出现的顺序排列）'
  }
  if (!pages.length) {
    // 连幻灯片容器都找不到：整个流里的文本原子
    const all = dedupe(pptTexts(doc, 0, doc.length))
    if (!all.length) return { ok: true, text: '', pages: 0, format: 'ppt', parts: [] }
    pages.push({ body: all, notes: [] })
    note = '（未能区分幻灯片，以下为文件中的全部文字）'
  }

  const budget = new Budget(limits.maxChars)
  const out: string[] = []
  const titles: string[] = []
  for (let i = 0; i < Math.min(pages.length, limits.maxParts); i++) {
    if (budget.full) break
    const body = tidyText(pages[i].body.join('\n'))
    const notes = tidyText(pages[i].notes.join('\n'))
    const page = `${i === 0 && note ? `${note}\n\n` : ''}## 第 ${i + 1} 页\n${body || '（无文字）'}${notes ? `\n\n备注：${notes}` : ''}`
    budget.take(page.length + 3)
    out.push(page)
    titles.push(body.split('\n')[0]?.slice(0, 60) ?? '')
  }
  return { ok: true, text: out.join('\n\f\n'), pages: pages.length, truncated: budget.truncated || pages.length > limits.maxParts, format: 'ppt', parts: titles }
}

// ================================================================ doc

/**
 * Word 正文里的特殊字符：域（0x13 代码 0x14 结果 0x15）只留结果；段落 / 换行 / 分页 → 换行；
 * 表格单元格标记 0x07 → 制表符（连续两个 = 行尾）；不间断连字符 → -；可选连字符与对象占位符去掉。
 */
export function cleanDocText(s: string): string {
  let out = ''
  const stack: boolean[] = [] // true = 正处在域代码部分
  let hidden = 0
  for (const ch of s) {
    if (ch === '\x13') {
      stack.push(true)
      hidden++
      continue
    }
    if (ch === '\x14') {
      if (stack.length && stack[stack.length - 1]) {
        stack[stack.length - 1] = false
        hidden--
      }
      continue
    }
    if (ch === '\x15') {
      if (stack.length && stack.pop()) hidden--
      continue
    }
    if (hidden > 0) continue
    out += ch
  }
  return tidyText(
    out
      .replace(/\x07\x07/g, '\x07\n')
      .replace(/\x07/g, '\t')
      .replace(/[\r\x0b\x0c]/g, '\n')
      .replace(/\x1e/g, '-')
      .replace(/ /g, ' ')
      .replace(/[\x00-\x08\x0e-\x1f]/g, '')
      .replace(/\t+\n/g, '\n')
  )
}

export function readDoc(cfb: Cfb, limits: OfficeLimits): OfficeResult {
  const wd = cfb.stream('WordDocument')
  if (!wd || wd.length < 34) throw corrupt('缺少 WordDocument 数据流')
  const ident = wd.readUInt16LE(0)
  if (ident !== 0xa5ec) throw new OfficeError(ident === 0xa5dc ? 'Word 6.0 / 95 格式的文档暂不支持读取文字，可另存为 .docx 后再试' : '文件已损坏（Word 文档头无效）')
  const nFib = wd.readUInt16LE(2)
  if (nFib < 0x00c0) throw new OfficeError('Word 6.0 / 95 格式的文档暂不支持读取文字，可另存为 .docx 后再试')
  const flags = wd.readUInt16LE(0x0a)
  if (flags & 0x0100 || flags & 0x8000) throw new OfficeError(ENCRYPTED)
  const table = cfb.stream(flags & 0x0200 ? '1Table' : '0Table')
  if (!table) throw corrupt('缺少 Table 数据流')
  // FIB：FibBase(32) → csw + fibRgW → cslw + fibRgLw → cbRgFcLcb + fibRgFcLcbBlob
  let p = 32
  const need = (n: number) => {
    if (p + n > wd.length) throw corrupt('FIB 不完整')
  }
  need(2)
  const csw = wd.readUInt16LE(p)
  p += 2 + csw * 2
  need(2)
  const cslw = wd.readUInt16LE(p)
  const lw = p + 2
  p = lw + cslw * 4
  need(2)
  const cbRgFcLcb = wd.readUInt16LE(p)
  const blob = p + 2
  if (cslw < 4 || cbRgFcLcb < 34) throw corrupt('FIB 不完整')
  p = blob + 34 * 8
  need(0)
  const ccpText = wd.readInt32LE(lw + 12)
  const fcClx = wd.readUInt32LE(blob + 33 * 8)
  const lcbClx = wd.readUInt32LE(blob + 33 * 8 + 4)
  if (!lcbClx || fcClx + lcbClx > table.length) throw corrupt('缺少分段表（Clx）')

  // Clx：若干 Prc（0x01）后跟 Pcdt（0x02 + lcb + PlcPcd）
  let q = fcClx
  const end = fcClx + lcbClx
  let plc: Buffer | null = null
  while (q < end) {
    const t = table[q]
    if (t === 0x01 && q + 3 <= end) q += 3 + table.readInt16LE(q + 1)
    else if (t === 0x02 && q + 5 <= end) {
      const lcb = table.readUInt32LE(q + 1)
      if (q + 5 + lcb > table.length) throw corrupt('分段表越界')
      plc = table.subarray(q + 5, q + 5 + lcb)
      break
    } else throw corrupt('分段表格式无效')
  }
  if (!plc || plc.length < 4 || (plc.length - 4) % 12) throw corrupt('分段表格式无效')
  const n = (plc.length - 4) / 12
  const limitCp = ccpText > 0 ? ccpText : Number.MAX_SAFE_INTEGER
  const maxRaw = limits.maxChars * 2 + 10_000
  let raw = ''
  let truncated = false
  for (let i = 0; i < n; i++) {
    const cp0 = plc.readUInt32LE(i * 4)
    const cp1 = plc.readUInt32LE((i + 1) * 4)
    if (cp0 >= limitCp) break
    const len = Math.min(cp1, limitCp) - cp0
    if (len <= 0) continue
    const pcd = 4 * (n + 1) + i * 8
    const fcv = plc.readUInt32LE(pcd + 2)
    const compressed = (fcv & 0x40000000) !== 0
    const fc = fcv & 0x3fffffff
    if (compressed) {
      const off = fc / 2
      if (off + len > wd.length) throw corrupt('正文片段越界')
      raw += new TextDecoder('windows-1252').decode(wd.subarray(off, off + len))
    } else {
      if (fc + len * 2 > wd.length) throw corrupt('正文片段越界')
      raw += wd.toString('utf16le', fc, fc + len * 2)
    }
    if (raw.length > maxRaw) {
      truncated = true
      break
    }
  }
  const text = cleanDocText(raw)
  return { ok: true, text: text.slice(0, limits.maxChars), pages: 1, truncated: truncated || text.length > limits.maxChars, format: 'doc' }
}

// ================================================================ 入口

/**
 * 复合文档 → 正文：按内含的流判断格式（不只看扩展名）。
 * docFallback = false 时 .doc 返回 { ok:false, format:'doc', error:'legacy' }，让调用方先试 macOS textutil。
 */
export function readLegacyOffice(buf: Buffer, limits: OfficeLimits, opts: { docFallback: boolean; ooxmlExt?: boolean }): OfficeResult {
  const cfb = openCfb(buf, { maxStreamBytes: limits.maxEntryBytes })
  // 加密的 docx / xlsx / pptx：外层是复合文档，里面是 EncryptionInfo + EncryptedPackage
  if (cfb.find('EncryptedPackage') || cfb.find('EncryptionInfo')) throw new OfficeError(ENCRYPTED)
  if (cfb.find('Workbook') || cfb.find('Book')) return readXls(cfb, limits)
  if (cfb.find('PowerPoint Document')) return readPpt(cfb, limits)
  if (cfb.find('WordDocument')) return opts.docFallback ? readDoc(cfb, limits) : { ok: false, format: 'doc', error: 'legacy' }
  if (opts.ooxmlExt) throw new OfficeError(ENCRYPTED)
  throw new OfficeError('不是可识别的 Word / Excel / PowerPoint 文档')
}
