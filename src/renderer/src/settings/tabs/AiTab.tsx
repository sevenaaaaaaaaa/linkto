import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { SectionTitle, SettingRow, Toggle } from './GeneralTab'
import type { AISettings } from '@shared/types'

const PRESETS = [
  { label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7' },
  { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'Ollama 本地', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b' }
]

export function AiTab() {
  const [s, setS] = useState<AISettings | null>(null)
  const [testing, setTesting] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testMsg, setTestMsg] = useState('')

  useEffect(() => {
    void api.getAISettings().then(setS)
  }, [])

  if (!s) return null
  const update = (patch: Partial<AISettings>) => {
    const next = { ...s, ...patch }
    setS(next)
    void api.setAISettings(next)
  }

  const test = async () => {
    setTesting('testing')
    const requestId = `test-${Date.now()}`
    const prev = s.apiKey
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
      if (!prev) return setTesting('fail'), setTestMsg('请先填写 API Key'), void 0
      await api.aiStream(requestId, [{ role: 'user', content: '回复「OK」两个字即可' }])
      const res = await done
      setTesting(res.ok ? 'ok' : 'fail')
      setTestMsg(res.msg)
    } catch {
      setTesting('fail')
      setTestMsg('连接失败')
    }
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
                onClick={() => update({ baseURL: p.baseURL, model: p.model })}
                className={`text-[12.5px] px-2.5 py-1 rounded-full transition ${
                  s.baseURL === p.baseURL ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <Field label="Base URL" value={s.baseURL} onChange={v => update({ baseURL: v })} placeholder="https://…/v1" mono />
        <Field label="API Key" value={s.apiKey} onChange={v => update({ apiKey: v })} placeholder="sk-…" type="password" />
        <Field label="模型" value={s.model} onChange={v => update({ model: v })} placeholder="glm-4.7" mono />
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
        邮件内容仅在你主动触发（摘要 / 起草 / 问答）或开启自动化时，才会发送给你所配置的 AI 服务商。
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
