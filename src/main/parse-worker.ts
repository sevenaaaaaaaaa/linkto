/**
 * MIME 解析专用 utilityProcess 入口：主进程把 raw eml 发过来，这里跑
 * simpleParser（CPU 密集）后回传结构化结果，大附件/复杂邮件不再卡 UI。
 */
import { simpleParser } from 'mailparser'

export interface ParseResult {
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

async function parse(raw: Buffer): Promise<ParseResult> {
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
    }))
  }
}

process.parentPort.on('message', async (e: { data: { id: string; raw: Buffer } }) => {
  const { id, raw } = e.data
  try {
    const result = await parse(Buffer.from(raw))
    process.parentPort.postMessage({ id, ok: true, result })
  } catch (err) {
    process.parentPort.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})