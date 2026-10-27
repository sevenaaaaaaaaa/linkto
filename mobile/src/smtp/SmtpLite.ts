import TcpSocket from 'react-native-tcp-socket'
import { buildMessage, type OutgoingMail } from './message'

export interface SmtpConfig {
  host: string
  port: number
  user: string
  pass: string
}

/**
 * SmtpLite —— 原生 TLS socket 上的极简 SMTP（隐式 TLS，465）。
 * 覆盖 EHLO / AUTH LOGIN（失败降级 AUTH PLAIN） / MAIL / RCPT / DATA / QUIT。
 * 587 STARTTLS 暂不支持；Outlook 这类只开 587 的账户请先用桌面端发信。
 */
export class SmtpLite {
  private sock: TcpSocket.Socket | null = null
  private buffer = ''
  private waiters: Array<(line: string) => void> = []

  private feed(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const i = this.buffer.indexOf('\r\n')
      if (i < 0) return
      const line = this.buffer.slice(0, i)
      this.buffer = this.buffer.slice(i + 2)
      const w = this.waiters.shift()
      if (w) w(line)
    }
  }

  private readLine(timeoutMs = 20000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(handler)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new Error('SMTP 响应超时'))
      }, timeoutMs)
      const handler = (line: string) => {
        clearTimeout(timer)
        resolve(line)
      }
      this.waiters.push(handler)
    })
  }

  private async response(timeoutMs = 20000): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = []
    while (true) {
      const line = await this.readLine(timeoutMs)
      lines.push(line)
      const m = line.match(/^(\d{3})([ -])(.*)$/)
      if (!m) throw new Error('SMTP 响应异常：' + line.slice(0, 80))
      if (m[2] === ' ') return { code: parseInt(m[1], 10), lines }
    }
  }

  private async cmd(line: string, timeoutMs = 20000): Promise<{ code: number; lines: string[] }> {
    if (!this.sock) throw new Error('未连接 SMTP')
    this.sock.write(line + '\r\n')
    return this.response(timeoutMs)
  }

  async connect(cfg: SmtpConfig, timeoutMs = 20000): Promise<void> {
    this.buffer = ''
    this.waiters = []
    const socket = await new Promise<TcpSocket.Socket>((resolve, reject) => {
      const s = TcpSocket.connectTLS({ host: cfg.host, port: cfg.port, tlsCheckValidity: true }, () => resolve(s))
      s.setTimeout(timeoutMs, () => {
        s.destroy()
        reject(new Error('SMTP 连接超时'))
      })
      s.on('error', (e: unknown) => reject(new Error('SMTP 连接失败：' + ((e as { message?: string }).message ?? String(e)))))
    })
    this.sock = socket
    socket.on('data', (d: string | Uint8Array) => {
      if (typeof d === 'string') {
        this.feed(d)
        return
      }
      let out = ''
      for (let i = 0; i < d.length; i += 8192) out += String.fromCharCode(...Array.from(d.subarray(i, i + 8192)))
      this.feed(out)
    })
    socket.on('error', () => {
      for (const w of this.waiters.splice(0)) w('')
    })
    socket.setTimeout(0)

    const greet = await this.response()
    if (greet.code !== 220) throw new Error('SMTP 服务器拒绝连接')
    const ehlo = await this.cmd('EHLO linkto.mobile')
    if (ehlo.code !== 250) throw new Error('SMTP EHLO 失败')

    let auth = await this.cmd('AUTH LOGIN')
    if (auth.code === 334) {
      auth = await this.cmd(btoa(cfg.user))
      if (auth.code === 334) auth = await this.cmd(btoa(cfg.pass))
    } else {
      auth = await this.cmd('AUTH PLAIN ' + btoa('\u0000' + cfg.user + '\u0000' + cfg.pass))
    }
    if (auth.code !== 235) throw new Error('SMTP 登录失败：请检查授权码 / SMTP 是否开启')
  }

  async send(mail: OutgoingMail): Promise<void> {
    if (!this.sock) throw new Error('未连接 SMTP')
    const from = 'MAIL FROM:<' + mail.from + '>'
    const r1 = await this.cmd(from)
    if (r1.code !== 250) throw new Error('SMTP MAIL FROM 失败')
    for (const addr of [...mail.to, ...(mail.cc ?? [])]) {
      const r = await this.cmd('RCPT TO:<' + addr + '>')
      if (r.code !== 250 && r.code !== 251) throw new Error('SMTP RCPT 被拒绝：' + addr)
    }
    const data = await this.cmd('DATA')
    if (data.code !== 354) throw new Error('SMTP DATA 被拒绝')
    const raw = buildMessage(mail)
    this.sock.write(raw)
    const done = await this.cmd('.')
    if (done.code !== 250) throw new Error('SMTP 发送失败')
  }

  async close(): Promise<void> {
    try {
      if (this.sock) {
        this.sock.write('QUIT\r\n')
        this.sock.destroy()
      }
    } catch {
      /* ignore */
    }
    this.sock = null
  }
}
