import TcpSocket from 'react-native-tcp-socket'

/**
 * ImapLite —— 跑在原生 TLS socket 上的极简 IMAP 客户端（v1）
 *
 * 覆盖：LOGIN / LSUB / SELECT / SEARCH / FETCH(envelope) / FETCH(正文)
 * 设计取舍：
 *  - 行协议 + literal 缓冲解析，够用不贪全
 *  - RFC2047 编码头解码（B/Q，utf-8 / gbk / latin1）
 *  - 正文优先取 BODY[1]（text/plain 首段），失败降级 BODY[TEXT]
 */

export interface ImapAccount {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
}

export interface MailBoxInfo {
  name: string
  flags: string[]
  delimiter: string
}

export interface MailEnvelope {
  uid: number
  flags: string[]
  date: number
  subject: string
  from: string
  to: string
}

type LineHandler = (line: string) => void

/** literal 内容行标记（feed 塞入；长度 5） */
const LIT_MARK = '\u0000LIT\u0000'

/** 手写 UTF-8 解码（Hermes 可能没有 TextDecoder；无效序列以 \uFFFD 占位） */
function decodeUtf8Bytes(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  const n = bytes.length
  while (i < n) {
    const b = bytes[i]
    if (b < 0x80) { out += String.fromCharCode(b); i++ }
    else if (b >= 0xC2 && b < 0xE0 && i + 1 < n && (bytes[i + 1] & 0xC0) === 0x80) {
      out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F)); i += 2
    } else if (b >= 0xE0 && b < 0xF0 && i + 2 < n && (bytes[i + 1] & 0xC0) === 0x80 && (bytes[i + 2] & 0xC0) === 0x80) {
      out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)); i += 3
    } else if (b >= 0xF0 && b < 0xF5 && i + 3 < n && (bytes[i + 1] & 0xC0) === 0x80 && (bytes[i + 2] & 0xC0) === 0x80 && (bytes[i + 3] & 0xC0) === 0x80) {
      const cp = (((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F)) - 0x10000
      out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); i += 4
    } else { out += '\uFFFD'; i++ }
  }
  return out
}

/** 有 TextDecoder 用 TextDecoder（支持 gbk 等），没有则对 utf-8 用手写解码 */
function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    // RN 旧 DOM 类型未声明 TextDecoder 构造 options
    const Decoder = TextDecoder as unknown as new (enc: string) => TextDecoder
    return new Decoder(charset).decode(bytes)
  } catch {
    if (/^utf-?8$/.test(charset)) return decodeUtf8Bytes(bytes)
    return new TextDecoder('latin1').decode(bytes)
  }
}

function decodeWords(s: string): string {
  // RFC2047: =?charset?B/Q?data?=（可出现在连续折叠中）
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, data: string) => {
    try {
      const charset = cs.toLowerCase()
      const bytes =
        enc.toLowerCase() === 'b'
          ? Uint8Array.from(atob(data), c => c.charCodeAt(0))
          : Uint8Array.from(
              data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))),
              c => c.charCodeAt(0)
            )
      return decodeBytes(bytes, charset)
    } catch {
      return data
    }
  })
}

function unquote(s: string): string {
  if (!s) return ''
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(.)/g, '$1')
  return s
}

/** 服务端以裸 UTF-8（非 RFC2047）发头时的 latin1→utf8 修复；含无效序列则保持原文（不误伤合法 latin1） */
function fixUtf8(s: string): string {
  if (!/[\u0080-\u00ff]/.test(s)) return s
  const bytes = Uint8Array.from(s.split('').map(c => c.charCodeAt(0)))
  const out = decodeUtf8Bytes(bytes)
  return out.includes('\uFFFD') ? s : out
}

/** 从一串原始头字段文本提取 FROM/TO/SUBJECT/DATE */
function parseHeaderBlock(raw: string): { from: string; to: string; subject: string; date: number } {
  let from = ''
  let to = ''
  let subject = ''
  let date = 0
  // 折叠行拼接：以空白开头的行为上一行的延续
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/)
    if (!m) continue
    const name = m[1].toLowerCase()
    const value = fixUtf8(decodeWords(m[2]).trim())
    if (name === 'from') from = value
    else if (name === 'to') to = value
    else if (name === 'subject') subject = value
    else if (name === 'date') {
      const t = Date.parse(value)
      if (!isNaN(t)) date = t
    }
  }
  // from/to 只取地址与人名的可读形式
  const pretty = (v: string) => {
    const mm = v.match(/^"?([^"<]*)"?\s*<([^>]+)>/)
    return mm ? (mm[1].trim() ? `${mm[1].trim()} <${mm[2]}>` : mm[2]) : v
  }
  return { from: pretty(from), to: pretty(to), subject, date }
}

export class ImapLite {
  private sock: TcpSocket.Socket | null = null
  private lastAcc: ImapAccount | null = null
  private buffer = ''
  private literals: { waiting: number | null; sink: ((chunk: string) => void) | null } = { waiting: null, sink: null }
  private lines: string[] = []
  private lineWaiters: LineHandler[] = []
  private tagSeq = 0
  private greeting: Promise<void> | null = null

  static quote(s: string): string {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }

  async connect(acc: ImapAccount, timeoutMs = 15000): Promise<void> {
    // 重置解析状态（重连复用实例时防串话）
    this.buffer = ''
    this.lines = []
    this.lineWaiters = []
    this.literals = { waiting: null, sink: null }
    this.lastAcc = acc
    // 关键：react-native-tcp-socket v6 的 createConnection 会静默忽略 tls 选项（原生 connect 仅从
    // startTLS 注册的 pendingTLS 取 TLS 配置），必须用 connectTLS 才真正走 TLS 握手。
    // 不传 rejectUnauthorized=false → 使用系统 CA 校验证书；自签证书即握手失败（中间人信号，
    // 错误消息带 cert/ssl/handshake 特征供守卫判定，见 security/guard.isMitmError）。
    const sock = await new Promise<TcpSocket.Socket>((resolve, reject) => {
      const opts = { host: acc.host, port: acc.port }
      const s: TcpSocket.Socket = acc.secure
        ? TcpSocket.connectTLS(opts, () => resolve(s))
        : TcpSocket.createConnection(opts, () => resolve(s))
      // 注意：这是「空闲超时」而非连接超时，覆盖握手+问候+登录全程；登录成功后必须清除
      //（否则用户停留超过 timeoutMs 后 socket 被销毁，后续操作全部报网络错误——历史断连根因）
      s.setTimeout(timeoutMs, () => {
        s.destroy()
        reject(new Error('连接超时'))
      })
      s.on('error', (e: unknown) => reject(new Error(`连接失败：${(e as { message?: string }).message ?? String(e)}`)))
    })
    this.sock = sock
    sock.on('data', (d: string | Uint8Array) => {
      if (typeof d === 'string') {
        this.feed(d)
        return
      }
      // Uint8Array → binary string（RN 无 node Buffer；latin1 保真传输给解析层）
      let out = ''
      for (let i = 0; i < d.length; i += 8192) {
        out += String.fromCharCode(...Array.from(d.subarray(i, i + 8192)))
      }
      this.feed(out)
    })
    sock.on('error', (e: unknown) => this.destroy(new Error(`网络错误：${(e as { message?: string }).message ?? String(e)}`)))

    // 等问候行 * OK/PREAUTH
    this.greeting = this.readLine().then(line => {
      if (!/^\* (OK|PREAUTH)/.test(line)) throw new Error(`服务器拒绝：${line.slice(0, 80)}`)
    })
    await this.greeting
    // 登录
    const res = await this.cmd(`LOGIN ${ImapLite.quote(acc.user)} ${ImapLite.quote(acc.pass)}`)
    if (!res.ok) throw new Error(res.lines.find(l => /AUTHENTICATIONFAILED|invalid|failed/i.test(l))?.slice(2).trim() ?? '登录失败：请检查用户名与授权码/应用专用密码')
    // 登录成功 → 清除空闲超时，让连接保持长活（命令级超时 readLine/cmd 继续兜底）
    sock.setTimeout(0)
  }

  /** 断线后惰性重连：用最近一次 connect 的账户参数重建连接（清空解析状态防串话） */
  async reconnect(timeoutMs = 15000): Promise<void> {
    if (!this.lastAcc) throw new Error('无可重连的账户参数')
    try { this.sock?.destroy() } catch { /* ignore */ }
    this.sock = null
    await this.connect(this.lastAcc, timeoutMs)
  }

  private destroy(err: Error) {
    try { this.sock?.destroy() } catch { /* ignore */ }
    this.sock = null
    for (const w of this.lineWaiters.splice(0)) w('') // 唤醒等待者令其报错
    if (this.pendingReject) this.pendingReject(err)
  }

  private pendingReject: ((e: Error) => void) | null = null

  private feed(chunk: string) {
    this.buffer += chunk
    // 处理 literal：上一行以 {N} 结尾 → 接下来 N 字节交给 sink
    while (true) {
      if (this.literals.waiting != null) {
        const need = this.literals.waiting
        const avail = this.buffer.length
        if (avail === 0) return
        const take = Math.min(need, avail)
        const data = this.buffer.slice(0, take)
        this.buffer = this.buffer.slice(take)
        this.literals.waiting = need - take
        this.literals.sink?.(data)
        if (this.literals.waiting > 0) return
        // 关键：消费完必须归位 null。若留在 0，后续数据会让 take 恒为 0 →
        // 同步 while(true) 死循环，JS 线程冻结（所有带 literal 的响应必现）
        this.literals.sink = null
        this.literals.waiting = null
        continue
      }
      const idx = this.buffer.indexOf('\r\n')
      if (idx < 0) return
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 2)
      const lit = line.match(/\{(\d+)\}$/)
      if (lit) {
        this.lines.push(line)
        this.literals.waiting = parseInt(lit[1], 10)
        // 链式保留调用方 sink（如正文收集器），同时把 literal 以 LIT 行喂给解析层
        const prev = this.literals.sink
        this.literals.sink = data => {
          this.lines.push(LIT_MARK + data)
          prev?.(data)
        }
        continue
      }
      const waiter = this.lineWaiters.shift()
      if (waiter) waiter(line)
      else this.lines.push(line)
    }
  }

  private readLine(timeoutMs = 25000): Promise<string> {
    if (this.lines.length) {
      return Promise.resolve(this.lines.shift()!)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.lineWaiters.indexOf(handler)
        if (i >= 0) this.lineWaiters.splice(i, 1)
        reject(new Error('响应超时'))
      }, timeoutMs)
      const handler: LineHandler = line => {
        clearTimeout(timer)
        resolve(line)
      }
      this.lineWaiters.push(handler)
    })
  }

  /** 执行一条命令，收集所有未 tag 行，返回 { ok, lines } */
  private async cmd(command: string, sinkLiteral?: (chunk: string) => void, timeoutMs = 30000): Promise<{ ok: boolean; lines: string[] }> {
    if (!this.sock) throw new Error('未连接')
    const tag = `A${++this.tagSeq}`
    const collected: string[] = []
    // 不带 sink 的命令应清掉上一条命令残留的 sink，防跨命令串数据
    this.literals.sink = sinkLiteral ?? null
    this.sock.write(`${tag} ${command}\r\n`)
    while (true) {
      const line = await this.readLine(timeoutMs)
      if (line.startsWith(LIT_MARK)) {
        // literal 内容行必须进入 collected（信封头字段都在 literal 里）
        collected.push(line)
        continue
      }
      if (line.startsWith(`${tag} `)) {
        const ok = /^\S+ OK/.test(line)
        return { ok, lines: collected }
      }
      if (line.startsWith('+')) {
        collected.push(line)
        continue
      }
      collected.push(line)
    }
  }

  async listMailboxes(): Promise<MailBoxInfo[]> {
    const r = await this.cmd('LSUB "" "*"')
    const out: MailBoxInfo[] = []
    for (const line of r.lines) {
      const m = line.match(/^\* LSUB \(([^)]*)\)\s+"?([^"]*)"? "?"?([^"]*)"?"?$/)
      if (m) out.push({ flags: m[1].trim().split(/\s+/).filter(Boolean), delimiter: unquote(m[2]), name: unquote(m[3]) })
    }
    return out
  }

  async selectMailbox(name: string): Promise<{ exists: number }> {
    const r = await this.cmd(`SELECT ${ImapLite.quote(name)}`)
    if (!r.ok) throw new Error(`打开邮箱失败：${name}`)
    let exists = 0
    for (const line of r.lines) {
      const m = line.match(/^\* (\d+) EXISTS/)
      if (m) exists = parseInt(m[1], 10)
    }
    return { exists }
  }

  /** 收件箱列表：SEARCH ALL 取最大 uid 往回拉 max 封 */
  async fetchEnvelopes(mailbox: string, max = 50): Promise<MailEnvelope[]> {
    await this.selectMailbox(mailbox)
    const s = await this.cmd('SEARCH ALL')
    const uids = s.lines
      .filter(l => l.startsWith('* SEARCH'))
      .flatMap(l => l.slice(8).trim().split(/\s+/).map(Number))
      .filter(n => !isNaN(n))
      .sort((a, b) => b - a)
      .slice(0, max)
    if (!uids.length) return []
    const range = uids.join(',')
    const r = await this.cmd(
      `FETCH ${range} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])`
    )
    return ImapLite.parseEnvelopes(r.lines)
  }

  /** 解析 FETCH 响应（literal 以 \u0000LIT\u0000 前缀行嵌入） */
  static parseEnvelopes(lines: string[]): MailEnvelope[] {
    const out: MailEnvelope[] = []
    let cur: { uid: number; flags: string[]; date: number } | null = null
    let headerRaw = ''
    let inHeader = false
    const flush = () => {
      if (!cur) return
      const h = parseHeaderBlock(headerRaw)
      out.push({ ...cur, subject: h.subject, from: h.from, to: h.to, date: cur.date || h.date })
      cur = null
      headerRaw = ''
      inHeader = false
    }
    for (const line of lines) {
      if (line.startsWith(LIT_MARK)) {
        headerRaw += line.slice(LIT_MARK.length)
        continue
      }
      // 一行式：* 1 FETCH (UID 1 FLAGS (\Seen) ... BODY[...] "...")
      const start = line.match(/^\* \d+ FETCH \((.*)\)\s*$/)
      // literal 式（真实服务器普遍形态）：* 1 FETCH (UID 1 ... BODY[...] {66}\r\n<literal>\r\n)
      const startLit = line.match(/^\* \d+ FETCH \((.*)\{\d+\}\s*$/)
      if (start || startLit) {
        flush()
        const spec = (start ?? startLit)![1]
        const uidm = spec.match(/UID (\d+)/)
        const flagsm = spec.match(/FLAGS \(([^)]*)\)/)
        const datem = spec.match(/INTERNALDATE "([^"]*)"/)
        cur = {
          uid: uidm ? parseInt(uidm[1], 10) : 0,
          flags: flagsm ? flagsm[1].trim().split(/\s+/).filter(Boolean) : [],
          date: datem ? Date.parse(datem[1]) : 0
        }
        // literal 式：头字段紧跟 literal；一行式仅当含 BODY[HEADER] 内联时（无 literal 则头为空）
        inHeader = Boolean(startLit) || /\[HEADER/i.test(spec)
        continue
      }
      if (inHeader && line.startsWith(')')) {
        flush()
        inHeader = false
      }
    }
    flush()
    return out
  }

  /** 正文：优先 BODY[1]，空则 BODY[TEXT]（纯文本近似） */
  async fetchBody(mailbox: string, uid: number): Promise<string> {
    await this.selectMailbox(mailbox)
    const parts: string[] = []
    const sink = (chunk: string) => parts.push(chunk)
    let r = await this.cmd(`FETCH ${uid} (BODY.PEEK[1])`, sink, 45000)
    let text = parts.join('').replace(/\u0000LIT\u0000/g, '')
    if (!text.trim() || /NIL/.test(text)) {
      parts.length = 0
      r = await this.cmd(`FETCH ${uid} (BODY.PEEK[TEXT])`, sink, 45000)
      text = parts.join('').replace(/\u0000LIT\u0000/g, '')
    }
    if (!r.ok) throw new Error('正文获取失败')
    return fixUtf8(text
      .replace(/^\* \d+ FETCH.*?\r?\n/, '')
      .replace(/\r?\n\)\r?\n?$/, '')
      .trim())
  }

  async markSeen(mailbox: string, uid: number): Promise<void> {
    await this.cmd(`STORE ${uid} +FLAGS (\\Seen)`)
  }

  async markUnseen(mailbox: string, uid: number): Promise<void> {
    await this.cmd(`STORE ${uid} -FLAGS (\\Seen)`)
  }

  logout(): Promise<void> {
    return this.cmd('LOGOUT').then(() => {
      this.sock?.end()
      this.sock = null
    }).catch(() => {
      this.sock?.destroy()
      this.sock = null
    })
  }
}