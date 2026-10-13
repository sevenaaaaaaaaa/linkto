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
      try {
        return new TextDecoder(charset).decode(bytes)
      } catch {
        return new TextDecoder('latin1').decode(bytes)
      }
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
    const value = decodeWords(m[2]).trim()
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
    // 关键：react-native-tcp-socket v6 的 createConnection 会静默忽略 tls 选项（原生 connect 仅从
    // startTLS 注册的 pendingTLS 取 TLS 配置），必须用 connectTLS 才真正走 TLS 握手。
    // 不传 rejectUnauthorized=false → 使用系统 CA 校验证书；自签证书即握手失败（中间人信号，
    // 错误消息带 cert/ssl/handshake 特征供守卫判定，见 security/guard.isMitmError）。
    const sock = await new Promise<TcpSocket.Socket>((resolve, reject) => {
      const opts = { host: acc.host, port: acc.port }
      const s: TcpSocket.Socket = acc.secure
        ? TcpSocket.connectTLS(opts, () => resolve(s))
        : TcpSocket.createConnection(opts, () => resolve(s))
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
        this.literals.sink = null
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
        this.literals.sink = data => {
          // literal 原文并入最近一行之后的缓冲（简单方案：作为独立行推送）
          this.lines.push('\u0000LIT\u0000' + data)
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
    this.literals.sink = sinkLiteral ?? this.literals.sink
    this.sock.write(`${tag} ${command}\r\n`)
    while (true) {
      const line = await this.readLine(timeoutMs)
      if (line.startsWith('\u0000LIT\u0000')) continue
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
      if (line.startsWith('\u0000LIT\u0000')) {
        headerRaw += line.slice(7)
        continue
      }
      const start = line.match(/^\* \d+ FETCH \((.*)\)\s*$/)
      if (start) {
        flush()
        const uidm = start[1].match(/UID (\d+)/)
        const flagsm = start[1].match(/FLAGS \(([^)]*)\)/)
        const datem = start[1].match(/INTERNALDATE "([^"]*)"/)
        cur = {
          uid: uidm ? parseInt(uidm[1], 10) : 0,
          flags: flagsm ? flagsm[1].trim().split(/\s+/).filter(Boolean) : [],
          date: datem ? Date.parse(datem[1]) : 0
        }
        inHeader = /\[HEADER/.test(start[1])
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
    return text
      .replace(/^\* \d+ FETCH.*?\r?\n/, '')
      .replace(/\r?\n\)\r?\n?$/, '')
      .trim()
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