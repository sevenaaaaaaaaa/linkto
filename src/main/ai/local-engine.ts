import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { AppStore } from '../store'

/**
 * 内置本地推理引擎：node-llama-cpp（Metal GPU 加速）+ 模型按需下载。
 * 模型 gguf 存 userData/models/，首次启用时从 hf-mirror（失败回退 huggingface）拉取，
 * 支持断点续传与进度广播。与云端 AI 平级，装完即可用、断网可用。
 */

export interface LocalModelDef {
  id: string
  label: string
  desc: string
  file: string
  repo: string
  sizeBytes: number
}

/** 内置可选模型（4B 级 q4：邮件摘要/分类/起草的性价比之选） */
export const LOCAL_MODEL_CATALOG: LocalModelDef[] = [
  {
    id: 'gemma-3-4b-q4',
    label: 'Gemma 3 4B',
    desc: '谷歌端侧模型，综合最均衡（推荐）',
    file: 'gemma-3-4b-it-Q4_K_M.gguf',
    repo: 'ggml-org/gemma-3-4b-it-GGUF',
    sizeBytes: 2_450_000_000
  },
  {
    id: 'qwen3-4b-q4',
    label: 'Qwen3 4B',
    desc: '通义千问，中文理解最强',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    repo: 'Qwen/Qwen3-4B-Instruct-2507-GGUF',
    sizeBytes: 2_400_000_000
  },
  {
    id: 'llama-3.2-3b-q4',
    label: 'Llama 3.2 3B',
    desc: 'Meta 轻量款，磁盘紧张时选它',
    file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    sizeBytes: 2_020_000_000
  }
]

export interface DownloadProgress {
  modelId: string
  received: number
  total: number
  percent: number
  done?: boolean
  error?: string
}

export class LocalEngine {
  private llama: import('node-llama-cpp').Llama | null = null
  private loadedModelId: string | null = null
  private context: import('node-llama-cpp').LlamaContext | null = null
  private generating = false
  private downloadAbort = new AbortController()

  constructor(private appStore: AppStore) {
    mkdirSync(this.modelsDir, { recursive: true })
  }

  private get modelsDir(): string {
    return join(this.appStore.dataDir, 'models')
  }

  modelPath(id: string): string {
    const def = LOCAL_MODEL_CATALOG.find(m => m.id === id)
    return join(this.modelsDir, def?.file ?? `${id}.gguf`)
  }

  isDownloaded(id: string): boolean {
    const path = this.modelPath(id)
    if (!existsSync(path)) return false
    const def = LOCAL_MODEL_CATALOG.find(m => m.id === id)
    // 下载中会有 .part 临时文件，正式文件存在且 >10MB 视为完成
    return statSync(path).size > (def ? Math.min(def.sizeBytes * 0.9, 10_000_000) : 10_000_000)
  }

  localStatus(): { models: { id: string; label: string; desc: string; downloaded: boolean; sizeBytes: number; sizeText: string }[] } {
    return {
      models: LOCAL_MODEL_CATALOG.map(m => ({
        id: m.id,
        label: m.label,
        desc: m.desc,
        downloaded: this.isDownloaded(m.id),
        sizeBytes: m.sizeBytes,
        sizeText: `${(m.sizeBytes / 1_000_000_000).toFixed(1)} GB`
      }))
    }
  }

  /** 下载模型：镜像优先、断点续传、进度广播 */
  async download(
    modelId: string,
    onProgress: (p: DownloadProgress) => void
  ): Promise<{ ok: boolean; error?: string }> {
    const def = LOCAL_MODEL_CATALOG.find(m => m.id === modelId)
    if (!def) return { ok: false, error: '未知模型' }
    const finalPath = this.modelPath(modelId)
    if (this.isDownloaded(modelId)) return { ok: true }

    const sources = [
      `https://hf-mirror.com/${def.repo}/resolve/main/${def.file}`,
      `https://huggingface.co/${def.repo}/resolve/main/${def.file}`
    ]
    const partPath = `${finalPath}.part`
    let lastError = '下载失败'

    for (const url of sources) {
      try {
        const existing = existsSync(partPath) ? statSync(partPath).size : 0
        this.downloadAbort = new AbortController()
        const res = await fetch(url, {
          redirect: 'follow',
          signal: this.downloadAbort.signal,
          headers: existing > 0 ? { Range: `bytes=${existing}-` } : {}
        })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        const total = Number(res.headers.get('content-length') ?? 0) + existing
        let received = existing
        const stream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
        const out = createWriteStream(partPath, { flags: existing > 0 ? 'a' : 'w' })
        let lastReport = 0
        for await (const chunk of stream) {
          received += (chunk as Buffer).length
          if (received - lastReport > 2_000_000) {
            lastReport = received
            onProgress({ modelId, received, total, percent: total ? Math.round((received / total) * 100) : 0 })
          }
          if (!out.write(chunk as Buffer)) await new Promise<void>(r => out.once('drain', r))
        }
        await new Promise<void>(r => out.end(r))
        if (received < 1_000_000) throw new Error('下载内容异常（过小）')
        renameSync(partPath, finalPath)
        onProgress({ modelId, received, total, percent: 100, done: true })
        return { ok: true }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        // 用户中止则不再尝试下一个源
        if (lastError.includes('abort') || lastError.includes('AbortError')) break
      }
    }
    onProgress({ modelId, received: 0, total: 0, percent: 0, done: true, error: lastError })
    // 清理无效残留
    if (existsSync(partPath) && statSync(partPath).size < 1_000_000) unlinkSync(partPath)
    return { ok: false, error: lastError }
  }

  cancelDownload() {
    this.downloadAbort.abort()
  }

  removeModel(modelId: string): { ok: boolean; error?: string } {
    const path = this.modelPath(modelId)
    if (existsSync(path)) {
      try {
        unlinkSync(path)
        if (this.loadedModelId === modelId) {
          void this.context?.dispose().catch(() => {})
          this.context = null
          this.loadedModelId = null
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
    return { ok: true }
  }

  private async loadModel(modelId: string) {
    if (this.loadedModelId === modelId && this.llama && this.context) return
    if (!this.isDownloaded(modelId)) throw new Error('模型尚未下载')
    const { getLlama } = await import('node-llama-cpp')
    if (!this.llama) this.llama = await getLlama()
    const model = await this.llama.loadModel({ modelPath: this.modelPath(modelId) })
    if (this.context) await this.context.dispose()
    this.context = await model.createContext({ contextSize: 8192 })
    this.loadedModelId = modelId
  }

  /** 流式推理：与 AIService.stream 对齐（system 咒语 + 消息历史 → onDelta 增量） */
  async stream(
    modelId: string,
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    onDelta: (delta: string) => void
  ): Promise<string> {
    await this.loadModel(modelId)
    if (!this.llama || !this.context) throw new Error('引擎未就绪')
    // 单 sequence 串行处理，避免并发互踩
    while (this.generating) await new Promise(r => setTimeout(r, 100))
    this.generating = true
    try {
      const { LlamaChatSession } = await import('node-llama-cpp')
      const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
      const session = new LlamaChatSession({
        contextSequence: this.context.getSequence(),
        systemPrompt: system || undefined
      })
      // 非系统消息整体拼接为一段 prompt（邮件场景指令自包含，无需回放多轮历史）
      const body = messages
        .filter(m => m.role !== 'system')
        .map(m => (m.role === 'user' ? m.content : `（此前助手回复：${m.content}）`))
        .join('\n\n')
      let full = ''
      await session.prompt(body, {
        maxTokens: 2048,
        temperature: 0.7,
        onTextChunk: chunk => {
          full += chunk
          onDelta(chunk)
        }
      })
      return full
    } finally {
      this.generating = false
    }
  }

  async dispose() {
    if (this.context) await this.context.dispose().catch(() => {})
    if (this.llama) await this.llama.dispose().catch(() => {})
    this.llama = null
    this.context = null
    this.loadedModelId = null
  }
}