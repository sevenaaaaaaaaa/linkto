import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import type { AppStore } from '../store'

/**
 * 内置本地推理引擎：node-llama-cpp（Metal GPU 加速）+ 模型按需下载。
 * 模型 gguf 存 userData/models/，首次启用时从 hf-mirror（失败回退 huggingface）拉取，
 * 支持断点续传与进度广播。与云端 AI 平级，装完即可用、断网可用。
 * 另支持导入用户自选 GGUF（8B/14B 等大模型），供本机与 OpenFlow 家族工具共用。
 */

export interface LocalModelDef {
  id: string
  label: string
  desc: string
  file: string
  repo: string
  sizeBytes: number
}

/** 用户自选 GGUF：不删源文件，只登记路径 */
export interface CustomLocalModel {
  id: string
  name: string
  path: string
  sizeBytes: number
}

const CUSTOM_MODELS_KEY = 'local-custom-models'

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

  private customModels(): CustomLocalModel[] {
    return this.appStore.get(CUSTOM_MODELS_KEY, [] as CustomLocalModel[])
  }

  /** 导入用户自选 GGUF（不复制不移动，登记原路径；8B/14B 等大模型均可） */
  addCustomModel(filePath: string): { ok: boolean; error?: string } {
    const p = filePath.trim()
    if (!/\.gguf$/i.test(p)) return { ok: false, error: '请选择 .gguf 模型文件' }
    let size = 0
    try {
      size = statSync(p).size
    } catch {
      return { ok: false, error: '文件不存在或不可读' }
    }
    if (size < 10_000_000) return { ok: false, error: '文件过小，不像有效的 GGUF 模型' }
    const list = this.customModels()
    if (list.some(m => m.path === p)) return { ok: false, error: '该模型已导入过' }
    const model: CustomLocalModel = {
      id: `custom-${Date.now().toString(36)}`,
      name: basename(p).replace(/\.gguf$/i, ''),
      path: p,
      sizeBytes: size
    }
    this.appStore.set(CUSTOM_MODELS_KEY, [...list, model])
    return { ok: true }
  }

  modelPath(id: string): string {
    const custom = this.customModels().find(m => m.id === id)
    if (custom) return custom.path
    const def = LOCAL_MODEL_CATALOG.find(m => m.id === id)
    return join(this.modelsDir, def?.file ?? `${id}.gguf`)
  }

  isDownloaded(id: string): boolean {
    const custom = this.customModels().find(m => m.id === id)
    if (custom) {
      try {
        return statSync(custom.path).size > 10_000_000
      } catch {
        return false
      }
    }
    const path = this.modelPath(id)
    if (!existsSync(path)) return false
    const def = LOCAL_MODEL_CATALOG.find(m => m.id === id)
    // 下载中会有 .part 临时文件，正式文件存在且 >10MB 视为完成
    return statSync(path).size > (def ? Math.max(def.sizeBytes * 0.9, 10_000_000) : 10_000_000)
  }

  localStatus(): { models: { id: string; label: string; desc: string; downloaded: boolean; sizeBytes: number; sizeText: string }[] } {
    return {
      models: [
        ...LOCAL_MODEL_CATALOG.map(m => ({
          id: m.id,
          label: m.label,
          desc: m.desc,
          downloaded: this.isDownloaded(m.id),
          sizeBytes: m.sizeBytes,
          sizeText: `${(m.sizeBytes / 1_000_000_000).toFixed(1)} GB`
        })),
        ...this.customModels().map(m => ({
          id: m.id,
          label: m.name,
          desc: `自选模型 · ${m.path}`,
          downloaded: this.isDownloaded(m.id),
          sizeBytes: m.sizeBytes,
          sizeText: `${(m.sizeBytes / 1_000_000_000).toFixed(1)} GB`
        }))
      ]
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
        let existing = existsSync(partPath) ? statSync(partPath).size : 0
        this.downloadAbort = new AbortController()
        const res = await fetch(url, {
          redirect: 'follow',
          signal: this.downloadAbort.signal,
          headers: existing > 0 ? { Range: `bytes=${existing}-` } : {}
        })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        // 断点续传要求 206；部分 CDN 忽略 Range 回 200 全量——按重头写处理，否则全量被 append 成双倍损坏文件
        if (existing > 0 && res.status !== 206) existing = 0
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
    // 自选模型只解除登记，绝不删用户的源文件
    if (modelId.startsWith('custom-')) {
      this.appStore.set(CUSTOM_MODELS_KEY, this.customModels().filter(m => m.id !== modelId))
      if (this.loadedModelId === modelId) {
        void this.context?.dispose().catch(() => {})
        this.context = null
        this.loadedModelId = null
      }
      return { ok: true }
    }
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

  /** 流式推理：与 AIService.stream 对齐（system 咒语 + 消息历史 → onDelta 增量）；opts 供 OpenAI 端点透传参数 */
  async stream(
    modelId: string,
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    onDelta: (delta: string) => void,
    opts?: { maxTokens?: number; temperature?: number }
  ): Promise<string> {
    // 单 sequence 串行处理，避免并发互踩；loadModel 必须在拿锁之后——
    // 并发时 A 可能正持有旧 context，B 在锁外 dispose/重建会直接把 A 炸掉
    while (this.generating) await new Promise(r => setTimeout(r, 100))
    this.generating = true
    try {
      await this.loadModel(modelId)
      if (!this.llama || !this.context) throw new Error('引擎未就绪')
      const { LlamaChatSession } = await import('node-llama-cpp')
      const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
      // sequence 池有限：本轮用完必须 dispose，否则下一次 getSequence 报 No sequences left
      let seq: import('node-llama-cpp').LlamaContextSequence | null = null
      try {
        seq = this.context.getSequence()
      } catch {
        // 兜底：强制重建上下文再取（上一轮异常未释放时；不清 loadedModelId 的话 loadModel 会早退，重试原样再抛）
        this.loadedModelId = null
        this.context = null
        await this.loadModel(modelId)
        seq = this.context!.getSequence()
      }
      const session = new LlamaChatSession({ contextSequence: seq, systemPrompt: system || undefined })
      // 非系统消息整体拼接为一段 prompt（邮件场景指令自包含，无需回放多轮历史）
      const body = messages
        .filter(m => m.role !== 'system')
        .map(m => (m.role === 'user' ? m.content : `（此前助手回复：${m.content}）`))
        .join('\n\n')
      let full = ''
      try {
        await session.prompt(body, {
          // 上下文窗口 8192，输出最多留一半给答案，避免长指令被挤掉
          maxTokens: Math.min(Math.max(opts?.maxTokens ?? 2048, 1), 4096),
          temperature: Math.min(Math.max(opts?.temperature ?? 0.7, 0), 2),
          onTextChunk: chunk => {
            full += chunk
            onDelta(chunk)
          }
        })
      } finally {
        await seq.dispose().catch(() => {})
      }
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