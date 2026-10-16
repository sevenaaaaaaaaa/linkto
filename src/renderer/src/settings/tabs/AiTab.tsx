import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { SectionTitle, SettingRow, Toggle } from './GeneralTab'
import type { AISettings, CustomPrompt } from '@shared/types'

const PRESETS = [
  { label: '智谱 GLM（推荐）', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7' },
  { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Ollama 本地部署（隐私优先）', baseURL: 'http://localhost:11434/v1', model: '' },
  { label: 'LM Studio 本地部署', baseURL: 'http://localhost:1234/v1', model: '' }
]

export function AiTab() {
  const [s, setS] = useState<AISettings | null>(null)
  const [testing, setTesting] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [probe, setProbe] = useState<'idle' | 'probing' | 'found' | 'none'>('idle')
  const [probeInfo, setProbeInfo] = useState<{ provider: string; baseURL: string; models: string[] } | null>(null)
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [fetchMsg, setFetchMsg] = useState('')
  const [localModels, setLocalModels] = useState<{ id: string; label: string; desc: string; downloaded: boolean; sizeBytes: number; sizeText: string }[]>([])
  const [dl, setDl] = useState<{ modelId: string; percent: number; done: boolean; error?: string } | null>(null)

  const reloadLocal = () => void api.aiLocalStatus().then(r => setLocalModels(r.models))
  useEffect(() => {
    void api.getAISettings().then(setS)
    reloadLocal()
  }, [])
  // 下载进度事件 → 进度条 / 完成刷新
  useEffect(() => {
    const off = api.onEvent(raw => {
      const e = raw as { type?: string; modelId?: string; received?: number; total?: number; done?: boolean; error?: string }
      if (e.type !== 'ai-local-download') return
      const total = e.total ?? 0
      const received = e.received ?? 0
      setDl({ modelId: e.modelId ?? '', percent: e.done ? 100 : total ? Math.round((received / total) * 100) : 0, done: !!e.done, error: e.error })
      if (e.done) {
        if (e.error) {
          // 失败信息保留一段时间供用户看到
          setDl({ modelId: e.modelId ?? '', percent: 0, done: true, error: e.error })
          setTimeout(() => setDl(null), 6000)
        } else {
          setDl(null)
          reloadLocal()
        }
      }
    })
    return () => { off?.() }
  }, [])

  if (!s) return null
  const update = (patch: Partial<AISettings>) => {
    const next = { ...s, ...patch }
    setS(next)
    void api.setAISettings(next)
  }

  const isBuiltinLocal = s.baseURL === 'builtin-local'
  const isLocal = isBuiltinLocal || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(s.baseURL)

  const probeLocal = async () => {
    setProbe('probing')
    const res = await api.aiProbeLocal()
    if (res.found) {
      setProbe('found')
      setProbeInfo({ provider: res.provider, baseURL: res.baseURL, models: res.models })
      setFetchedModels(res.models)
      setFetchMsg('')
    } else {
      setProbe('none')
    }
  }

  const fetchModels = async () => {
    setFetchMsg('拉取中…')
    const res = await api.aiListModels()
    if (res.models.length) {
      setFetchedModels(res.models)
      setFetchMsg('')
    } else {
      setFetchMsg(res.error ?? '未拉取到模型')
    }
  }

  const test = async () => {
    setTesting('testing')
    const requestId = `test-${Date.now()}`
    try {
      const done = new Promise<{ ok: boolean; msg: string }>(resolve => {
        const off = api.onEvent(ev => {
          const e = ev as { type: string; requestId?: string; delta?: string; done?: boolean; error?: string }
          if (e.type === 'ai-stream' && e.requestId === requestId && e.done) {
            off()
            resolve(e.error ? { ok: false, msg: e.error } : { ok: true, msg: '连接成功' })
          }
        })
        setTimeout(() => resolve({ ok: false, msg: '连接超时' }), 20_000)
      })
      if (!isLocal && !s.apiKey) return setTesting('fail'), setTestMsg('请先填写 API Key'), void 0
      await api.aiStream(requestId, [{ role: 'user', content: '回复「OK」两个字即可' }])
      const res = await done
      setTesting(res.ok ? 'ok' : 'fail')
      setTestMsg(res.msg)
    } catch {
      setTesting('fail')
      setTestMsg('连接失败')
    }
  }

  // ---- 自定义咒语管理 ----
  const addPrompt = () => {
    update({ customPrompts: [...(s.customPrompts ?? []), { id: `p-${Date.now().toString(36)}`, name: `咒语 ${(s.customPrompts?.length ?? 0) + 1}`, text: '', enabled: true }] })
  }
  const updatePrompt = (id: string, patch: Partial<CustomPrompt>) => {
    update({ customPrompts: (s.customPrompts ?? []).map(p => (p.id === id ? { ...p, ...patch } : p)) })
  }
  const removePrompt = (id: string) => {
    update({ customPrompts: (s.customPrompts ?? []).filter(p => p.id !== id) })
  }

  return (
    <div className="max-w-[620px]">
      <SectionTitle>AI 服务</SectionTitle>
      <SettingRow label="启用 AI 功能" desc="摘要、智能分类、起草回复、知识库问答">
        <Toggle checked={s.enabled} onChange={v => update({ enabled: v })} />
      </SettingRow>

      <div className={`rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] px-4 py-1 mt-3 ${s.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <div className="flex items-center gap-3 py-3 border-b border-ink/[0.04]">
          <span className="w-24 text-sm text-zinc-700 shrink-0">预设</span>
          <div className="flex gap-1.5 flex-wrap">
            {PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => update({ baseURL: p.baseURL, model: p.model || s.model })}
                className={`text-xs px-2.5 py-1 rounded-full transition ${
                  s.baseURL === p.baseURL ? 'bg-blue-600 text-on-accent' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 内置本地引擎：仅轻量任务（结构化 AI 建议用 API 或本地部署端点） */}
        <div className="py-3 border-b border-ink/[0.04]">
          <div className="flex items-center gap-3">
            <span className="w-24 text-sm text-zinc-700 shrink-0">内置引擎</span>
            <span className="text-xs text-zinc-500 flex-1">
              轻量备用：仅适合摘要 / 翻译等简单任务（Metal GPU 加速 · 断网可用 · 内容不出机）。
              <b className="text-zinc-700">智能洞察 / 筛选判定 / AI 搜索等结构化功能请用上方 API 预设或本地部署 7B+ 模型</b>
              ，4B 级端侧模型无法可靠完成。
            </span>
          </div>
          <div className="mt-2 ml-[112px] space-y-2">
            {localModels.map(m => {
              const active = isBuiltinLocal && s.model === m.id
              const downloading = dl?.modelId === m.id && !dl.done
              return (
                <div key={m.id} className="flex items-center gap-2.5 rounded-xl bg-zinc-50 px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-800">{m.label}</span>
                      <span className="text-xs text-zinc-400">{m.desc} · {m.sizeText}</span>
                      {active && <span className="text-2xs px-1.5 py-px rounded-sm bg-green-100 text-green-600">使用中</span>}
                      {m.downloaded && !active && <span className="text-2xs text-zinc-400">已下载</span>}
                    </div>
                    {downloading && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-zinc-200 overflow-hidden">
                          <div className="h-full bg-blue-600 transition-all" style={{ width: `${dl?.percent ?? 0}%` }} />
                        </div>
                        <span className="text-xs text-zinc-500 tabular-nums w-9">{dl?.percent ?? 0}%</span>
                        <button onClick={() => void api.aiLocalCancelDownload()} className="text-xs text-zinc-400 hover:text-red-500">取消</button>
                      </div>
                    )}
                    {dl?.done && dl.error && dl.modelId === m.id && <div className="text-xs text-red-500 mt-1">{dl.error}</div>}
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    {downloading ? null : m.downloaded ? (
                      <>
                        {!active && (
                          <button onClick={() => update({ baseURL: 'builtin-local', model: m.id })} className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-on-accent hover:bg-blue-700">
                            启用
                          </button>
                        )}
                        <button
                          onClick={async () => {
                            await api.aiLocalRemove(m.id)
                            reloadLocal()
                          }}
                          className="text-xs text-zinc-400 hover:text-red-500"
                        >
                          删除
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => void api.aiLocalDownload(m.id)}
                        className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
                      >
                        下载
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* 本地推理：一键探测 + 模型列表 + 安装引导 */}
        <div className="flex items-center gap-3 py-3 border-b border-ink/[0.04]">
          <span className="w-24 text-sm text-zinc-700 shrink-0">本地模型</span>
          <button
            onClick={probeLocal}
            disabled={probe === 'probing'}
            className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200 disabled:opacity-50"
          >
            {probe === 'probing' ? '探测中…' : '探测本机推理服务'}
          </button>
          {probe === 'found' && probeInfo && (
            <span className="text-xs text-green-600">✓ {probeInfo.provider} 在线（{probeInfo.models.length} 个模型，已列出在下方）</span>
          )}
          {probe === 'none' && <span className="text-xs text-zinc-500">未检测到本地服务</span>}
        </div>
        {probe === 'none' && (
          <div className="mb-3 rounded-xl bg-amber-50 border border-amber-200/60 px-3.5 py-2.5 text-xs leading-relaxed text-amber-800">
            推荐安装 <b>Ollama</b> 跑端侧小模型（断网可用、隐私不出机）：
            <code className="block mt-1 bg-white/70 rounded-md px-2 py-1 font-mono text-xs">brew install --cask ollama && ollama pull qwen3:8b</code>
            <div className="mt-1 text-amber-700">结构化 AI（洞察/筛选/搜索）建议 7B+：qwen3:8b · llama3.1:8b · gemma3:12b，全部本机运行，内容不出机。</div>
          </div>
        )}

        <Field label="Base URL" value={s.baseURL} onChange={v => update({ baseURL: v })} placeholder="https://…/v1" mono />
        <Field
          label="API Key"
          value={s.apiKey}
          onChange={v => update({ apiKey: v })}
          placeholder={isLocal ? '本地服务无需 Key' : 'sk-…'}
          type="password"
        />
        <Field label="模型" value={s.model} onChange={v => update({ model: v })} placeholder="glm-4.7" mono />
        {(fetchedModels.length > 0 || isLocal) && (
          <div className="flex items-start gap-3 py-3 border-b border-ink/[0.04]">
            <span className="w-24 text-sm text-zinc-700 shrink-0 pt-0.5">可用模型</span>
            <div className="flex-1">
              <button onClick={fetchModels} className="text-xs text-blue-600 hover:underline">
                {fetchedModels.length ? '刷新模型列表' : '从服务拉取模型列表'}
              </button>
              {fetchMsg && <span className="ml-2 text-xs text-zinc-400">{fetchMsg}</span>}
              {fetchedModels.length > 0 && (
                <div className="flex gap-1.5 flex-wrap mt-1.5">
                  {fetchedModels.map(m => (
                    <button
                      key={m}
                      onClick={() => update({ model: m })}
                      className={`text-xs px-2 py-0.5 rounded-full border transition font-mono ${
                        s.model === m ? 'bg-blue-600 text-on-accent border-blue-600' : 'bg-zinc-50 text-zinc-600 border-ink/[0.08] hover:bg-zinc-100'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 py-3">
          <span className="w-24 text-sm text-zinc-700 shrink-0">连接测试</span>
          <button
            onClick={test}
            disabled={testing === 'testing'}
            className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200 disabled:opacity-50"
          >
            {testing === 'testing' ? '测试中…' : '测试连接'}
          </button>
          {testing === 'ok' && <span className="text-xs text-green-600">✓ {testMsg}</span>}
          {testing === 'fail' && <span className="text-xs text-red-500">✕ {testMsg}</span>}
        </div>
      </div>

      <SectionTitle>自定义咒语</SectionTitle>
      <div className="text-xs text-zinc-500 mb-2">启用的咒语会追加到所有 AI 功能的系统提示（摘要 / 起草 / 问答 / 商情 / 洞察），例如「回复保持简洁正式，不超过 120 字」。</div>
      {(s.customPrompts ?? []).map(p => (
        <div key={p.id} className="rounded-xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] px-3.5 py-2.5 mb-2">
          <div className="flex items-center gap-2.5">
            <input
              value={p.name}
              onChange={e => updatePrompt(p.id, { name: e.target.value })}
              className="w-32 text-sm bg-zinc-50 rounded-lg px-2 py-1 outline-none border border-ink/[0.05]"
            />
            <Toggle checked={p.enabled} onChange={v => updatePrompt(p.id, { enabled: v })} />
            <div className="flex-1" />
            <button onClick={() => removePrompt(p.id)} className="text-xs text-zinc-400 hover:text-red-500">删除</button>
          </div>
          <textarea
            value={p.text}
            onChange={e => updatePrompt(p.id, { text: e.target.value })}
            placeholder="写你的咒语，例如：用中文回复；先给结论再给细节；语气专业但不生硬…"
            rows={3}
            className="mt-2 w-full text-xs bg-zinc-50 rounded-lg px-2.5 py-2 outline-none border border-ink/[0.05] resize-y leading-relaxed"
          />
        </div>
      ))}
      <button onClick={addPrompt} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200">
        + 添加咒语
      </button>

      <SectionTitle>自动化</SectionTitle>
      {!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(s.baseURL) && s.baseURL !== 'builtin-local' && (
        <div className="text-xs leading-relaxed text-zinc-500 bg-zinc-100/70 rounded-xl px-4 py-2.5 mb-2">
          以下自动化开启后，新邮件内容会在你不操作时自动发送给当前的云端 AI 服务（{s.baseURL.replace(/^https?:\/\//, '').split('/')[0]}）。介意的话保持关闭，或改用本地模型。
        </div>
      )}
      <SettingRow label="自动分类新邮件" desc="新邮件入库后自动标记：个人 / 通知 / 订阅 / 噪声">
        <Toggle checked={s.autoClassify} onChange={v => update({ autoClassify: v })} />
      </SettingRow>
      <SettingRow label="自动提炼" desc="账单 / 会议邮件自动进待办，Newsletter 自动进阅读清单（智能洞察）">
        <Toggle checked={s.autoInsights} onChange={v => update({ autoInsights: v })} />
      </SettingRow>
      <SettingRow label="每日商情" desc="每天自动整理：当日重点、主题 digest、备忘录、清理建议">
        <Toggle checked={s.autoDigest} onChange={v => update({ autoDigest: v })} />
      </SettingRow>

      <SectionTitle>隐私说明</SectionTitle>
      <div className="text-xs leading-relaxed text-zinc-500 bg-zinc-100/70 rounded-xl px-4 py-3">
        邮件内容仅在你主动触发（摘要 / 起草 / 问答）或开启自动化时，才会发送给你所配置的 AI 服务。选择 Ollama / LM Studio 等本地模型时，内容完全不出本机。
        分类使用本地启发式规则优先，AI 仅作兜底。API Key 与密码一样经系统钥匙串加密保存在本机。
      </div>
    </div>
  )
}

function Field(props: { label: string; value: string; onChange(v: string): void; placeholder?: string; type?: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-ink/[0.04]">
      <span className="w-24 text-sm text-zinc-700 shrink-0">{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        onChange={e => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        className={`flex-1 text-sm bg-zinc-50 rounded-lg px-2.5 py-1.5 outline-none border border-ink/[0.05] ${props.mono ? 'font-mono' : ''}`}
      />
    </div>
  )
}