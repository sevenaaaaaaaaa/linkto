import { utilityProcess, UtilityProcess } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * MIME 解析工作进程池：懒启动单个 utilityProcess，串行处理解析请求；
 * 崩溃自动重启；worker 不可用/超时时调用方应回退主进程解析（见 parseEmailRaw）。
 */

export interface ParsedEmail {
  text: string
  html: string | null
  attachments: {
    filename?: string
    contentType?: string
    size: number
    cid?: string
    content: Buffer
  }[]
}

type Pending = {
  resolve(result: ParsedEmail): void
  reject(err: Error): void
  timer: NodeJS.Timeout
}

class ParsePool {
  private child: UtilityProcess | null = null
  private pending = new Map<string, Pending>()
  private starting: Promise<void> | null = null

  private ensureChild(): Promise<void> {
    if (this.child) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = new Promise<void>(resolve => {
      const child = utilityProcess.fork(join(__dirname, 'parse-worker.js'), [], { serviceName: 'linkto-parse-worker' })
      child.on('message', (msg: { id: string; ok: boolean; result?: ParsedEmail; error?: string }) => {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok && msg.result) p.resolve(msg.result)
        else p.reject(new Error(msg.error ?? 'parse worker error'))
      })
      child.on('exit', () => {
        this.child = null
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new Error('parse worker exited'))
        }
        this.pending.clear()
      })
      this.child = child
      this.starting = null
      resolve()
    })
    return this.starting
  }

  /** 解析一封原始邮件；超时/崩溃抛错（调用方回退主进程 simpleParser） */
  async parse(raw: Buffer, timeoutMs = 15_000): Promise<ParsedEmail> {
    await this.ensureChild()
    const child = this.child
    if (!child) throw new Error('parse worker unavailable')
    const id = `p-${randomUUID()}`
    return new Promise<ParsedEmail>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('parse worker timeout'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.postMessage({ id, raw })
    })
  }
}

export const parsePool = new ParsePool()

/** 统一入口：优先 worker 解析，失败回退主进程 simpleParser（永不失败抛出到同步链路） */
export async function parseEmailRaw(raw: Buffer): Promise<ParsedEmail & { viaWorker: boolean }> {
  try {
    const r = await parsePool.parse(raw)
    return { ...r, viaWorker: true }
  } catch {
    const { simpleParser } = await import('mailparser')
    const parsed = await simpleParser(raw)
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      html: typeof parsed.html === 'string' ? parsed.html : null,
      attachments: (parsed.attachments ?? []).map(a => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size ?? a.content?.length ?? 0,
        cid: a.cid,
        content: a.content ?? Buffer.alloc(0)
      })),
      viaWorker: false
    }
  }
}