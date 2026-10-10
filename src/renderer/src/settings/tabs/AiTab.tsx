import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { SectionTitle, SettingRow, Toggle } from './GeneralTab'
import type { AISettings, CustomPrompt } from '@shared/types'

const PRESETS = [
  { label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7' },
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'Ollama 本地', baseURL: 'http://localhost:11434/v1', model: '' },
  { label: 'LM Studio', baseURL: 'http://localhost:1234/v1', model: '' }
]

/** 端侧推荐模型（4B 级别：邮件分类/摘要/起草足够用） */
const LOCAL_MODELS = ['gemma3:4b', 'qwen3:4b', 'llama3.2:3b', 'phi4-mini:3.8b']

export function AiTab() {
  const [s, setS] = useState<AISettings | null>(null)
  const [testing, setTesting] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testMsg, setTestMsg] = useState('')
  const [probe, setProbe] = useState<'idle' | 'probing' | 'found' | 'none'>('idle')
  const [probeInfo, setProbeInfo] = useState<{ provider: string; baseURL: string; models: string[] } | null>(null)
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [fetchMsg, setFetchMsg] = useState('')

  useEffect(() => {
    void api.getAISettings().then(setS)
  }, [])

  if (!s) return null
  const update = (patch: Partial<AISettings>) => {
    const next = { ...s, ...patch }
    setS(next)
    void api.setAISettings(next)
  }

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(s.baseURL)

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

      <div className={`rounded-2xl bg-white border border-black/[0.06] shadow-sm px-4 py-1 mt-3 ${s.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <div className="flex items-center gap-3 py-3 border-b border-black/[0.04]">
          <span className="w-24 text-[13.5px] text-zinc-700 shrink-0">预设</span>
          <div className="flex gap-1.5 flex-wrap">
            {PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => update({ baseURL: p.baseURL, model: p.model || s.model })}
                className={`text-[12.5px] px-2.5 py-1 rounded-full transition ${
                  s.baseURL === p.baseURL ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* 本地推理：一键探测 + 模型列表 + 安装引导 */}
        <div className="flex items-center gap-3 py-3 border-b border-black/[0.04]">
          <span className="w-24 text-[13.5px] text-zinc-700 shrink-0">本地模型</span>
          <button
            onClick={probeLocal}
            disabled={probe === 'probing'}
            className="text-[12.5px] px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200 disabled:opacity-50"
          >
            {probe === 'probing' ? '探测中…' : '探测本机推理服务'}
          </button>
          {probe === 'found' && probeInfo && (
            <span className="text-[12.5px] text-green-600">✓ {probeInfo.provider} 在线（{probeInfo.models.length} 个模型，已列出在下方）</span>
          )}
          {probe === 'none' && <span className="text-[12.5px] text-zinc-500">未检测到本地服务</span>}
        </div>
        {probe === 'none' && (
          <div className="mb-3 rounded-xl bg-amber-50 border border-amber-200/60 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-amber-800">
            推荐安装 <b>Ollama</b> 跑端侧小模型（断网可用、隐私不出机）：
            <code className="block mt-1 bg-white/70 rounded-md px-2 py-1 font-mono text-[11.5px]">brew install --cask ollama && ollama pull {LOCAL_MODELS[0]}</code>
            <div className="mt-1 text-amber-700">轻量推荐：{LOCAL_MODELS.join(' · ')} —— 摘要/分类/起草已足够流畅。</div>
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
          <div className="flex items-start gap-3 py-3 border-b border-black/[0.04]">
            <span className="w-24 text-[13.5px] text-zinc-700 shrink-0 pt-0.5">可用模型</span>
            <div className="flex-1">
              <button onClick={fetchModels} className="text-[12px] text-blue-600 hover:underline">
                {fetchedModels.length ? '刷新模型列表' : '从服务拉取模型列表'}
              </button>
              {fetchMsg && <span className="ml-2 text-[12px] text-zinc-400">{fetchMsg}</span>}
              {fetchedModels.length > 0 && (
                <div className="flex gap-1.5 flex-wrap mt-1.5">
                  {fetchedModels.map(m => (
                    <button
                      key={m}
                      onClick={() => update({ model: m })}
                      className={`text-[11.5px] px-2 py-0.5 rounded-full border transition font-mono ${
                        s.model === m ? 'bg-blue-600 text-white border-blue-600' : 'bg-zinc-50 text-zinc-600 border-black/[0.08] hover:bg-zinc-100'
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
          <span className="w-24 text-[13.5px] text-zinc-700 shrink-0">连接测试</span>
          <button
            onClick={test}
            disabled={testing === 'testing'}
            className="text-[12.5px] px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200 disabled:opacity-50"
          >
            {testing === 'testing' ? '测试中…' : '测试连接'}
          </button>
          {testing === 'ok' && <span className="text-[12.5px] text-green-600">✓ {testMsg}</span>}
          {testing === 'fail' && <span className="text-[12.5px] text-red-500">✕ {testMsg}</span>}
        </div>
      </div>

      <SectionTitle>自定义咒语</SectionTitle>
      <div className="text-[12.5px] text-zinc-500 mb-2">启用的咒语会追加到所有 AI 功能的系统提示（摘要 / 起草 / 问答 / 商情 / 洞察），例如「回复保持简洁正式，不超过 120 字」。</div>
      {(s.customPrompts ?? []).map(p => (
        <div key={p.id} className="rounded-xl bg-white border border-black/[0.06] shadow-sm px-3.5 py-2.5 mb-2">
          <div className="flex items-center gap-2.5">
            <input
              value={p.name}
              onChange={e => updatePrompt(p.id, { name: e.target.value })}
              className="w-32 text-[13px] bg-zinc-50 rounded-lg px-2 py-1 outline-none border border-black/[0.05]"
            />
            <Toggle checked={p.enabled} onChange={v => updatePrompt(p.id, { enabled: v })} />
            <div className="flex-1" />
            <button onClick={() => removePrompt(p.id)} className="text-[12px] text-zinc-400 hover:text-red-500">删除</button>
          </div>
          <textarea
            value={p.text}
            onChange={e => updatePrompt(p.id, { text: e.target.value })}
            placeholder="写你的咒语，例如：用中文回复；先给结论再给细节；语气专业但不生硬…"
            rows={3}
            className="mt-2 w-full text-[12.5px] bg-zinc-50 rounded-lg px-2.5 py-2 outline-none border border-black/[0.05] resize-y leading-relaxed"
          />
        </div>
      ))}
      <button onClick={addPrompt} className="text-[12.5px] px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200">
        + 添加咒语
      </button>

      <SectionTitle>自动化</SectionTitle>
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
      <div className="text-[12.5px] leading-relaxed text-zinc-500 bg-zinc-100/70 rounded-xl px-4 py-3">
        邮件内容仅在你主动触发（摘要 / 起草 / 问答）或开启自动化时，才会发送给你所配置的 AI 服务。选择 Ollama / LM Studio 等本地模型时，内容完全不出本机。
        分类使用本地启发式规则优先，AI 仅作兜底。API Key 与密码一样保存在本机钥匙串中。
      </div>
    </div>
  )
}

function Field(props: { label: string; value: string; onChange(v: string): void; placeholder?: string; type?: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-black/[0.04]">
      <span className="w-24 text-[13.5px] text-zinc-700 shrink-0">{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        onChange={e => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        className={`flex-1 text-[13px] bg-zinc-50 rounded-lg px-2.5 py-1.5 outline-none border border-black/[0.05] ${props.mono ? 'font-mono' : ''}`}
      />
    </div>
  )
}