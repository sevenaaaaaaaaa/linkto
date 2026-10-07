import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { SectionTitle } from './GeneralTab'
import type { ConnectorInstance, ConnectorManifest } from '@shared/types'

/** 集成页：连接器卡片式管理（对齐 Canary 集成交互），OpenFlow 家族产品将从这里接入 */
export function IntegrationsTab() {
  const [manifests, setManifests] = useState<ConnectorManifest[]>([])
  const [instances, setInstances] = useState<ConnectorInstance[]>([])
  const [configuring, setConfiguring] = useState<ConnectorManifest | null>(null)
  const [toast, setToast] = useState('')

  const reload = async () => {
    const [m, i] = await Promise.all([api.listConnectorManifests(), api.listConnectorInstances()])
    setManifests(m)
    setInstances(i)
  }
  useEffect(() => void reload(), [])

  const showToast = (t: string) => {
    setToast(t)
    setTimeout(() => setToast(''), 2500)
  }

  const instanceOf = (manifestId: string) => instances.find(i => i.manifestId === manifestId)

  return (
    <div className="max-w-[680px] relative">
      <div className="rounded-2xl bg-white border border-black/[0.06] shadow-sm divide-y divide-black/[0.04]">
        {manifests.map(m => {
          const inst = instanceOf(m.id)
          return (
            <div key={m.id} className="px-5 py-4 flex items-center gap-4">
              <span
                className="w-10 h-10 rounded-xl flex items-center justify-center text-[18px] shrink-0"
                style={{ background: `${m.color}18` }}
              >
                {m.icon}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold text-zinc-800">{m.name}</span>
                  {inst && <span className="text-[11px] px-1.5 py-px rounded bg-green-100 text-green-600">已连接</span>}
                </div>
                <div className="text-[12.5px] text-zinc-400 mt-0.5 leading-relaxed">{m.description}</div>
              </div>
              {inst ? (
                <button
                  onClick={async () => {
                    await api.disconnectConnector(inst.id)
                    await reload()
                    showToast(`已断开 ${m.name}`)
                  }}
                  className="text-[12.5px] px-3.5 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200 shrink-0"
                >
                  断开
                </button>
              ) : (
                <button
                  onClick={() => setConfiguring(m)}
                  className="text-[12.5px] px-4 py-1.5 rounded-lg bg-zinc-100 text-zinc-700 hover:bg-zinc-200 shrink-0"
                >
                  连接
                </button>
              )}
            </div>
          )
        })}
      </div>

      <SectionTitle>关于 OpenFlow 生态</SectionTitle>
      <div className="text-[12.5px] leading-relaxed text-zinc-500 bg-zinc-100/70 rounded-xl px-4 py-3">
        这里是 OpenFlow 家族的连接入口。每个连接器声明自己的鉴权方式与动作，Mail Studio
        在阅读邮件时即可把内容一键分享到对应产品（如把一封需求邮件转成任务）。家族产品连接器即将逐步上线；
        现在可以通过「通用 Webhook」先打通任何支持 Incoming Webhook 的工具。
      </div>

      {configuring && (
        <ConnectorConfigDialog
          manifest={configuring}
          onClose={() => setConfiguring(null)}
          onSaved={async () => {
            setConfiguring(null)
            await reload()
            showToast(`已连接 ${configuring.name}`)
          }}
        />
      )}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-zinc-900/90 text-white text-[13px] shadow-lg fade-in">
          {toast}
        </div>
      )}
    </div>
  )
}

function ConnectorConfigDialog(props: { manifest: ConnectorManifest; onClose(): void; onSaved(): void }) {
  const { manifest: m } = props
  const [config, setConfig] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const connect = async () => {
    setBusy(true)
    setError('')
    const res = await api.connectConnector(m.id, config)
    setBusy(false)
    if (res.ok) props.onSaved()
    else setError(res.error ?? '连接失败')
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/30 flex items-center justify-center" onClick={props.onClose}>
      <div className="w-[440px] bg-white rounded-2xl shadow-2xl overflow-hidden fade-in" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 flex items-center gap-3 border-b border-black/[0.05]">
          <span className="w-9 h-9 rounded-xl flex items-center justify-center text-[16px]" style={{ background: `${m.color}18` }}>
            {m.icon}
          </span>
          <div>
            <div className="text-[14.5px] font-semibold text-zinc-800">连接 {m.name}</div>
            <div className="text-[12px] text-zinc-400">
              {m.auth === 'webhook' ? 'Webhook 鉴权' : m.auth === 'apiKey' ? 'API Key 鉴权' : '无需鉴权'}
            </div>
          </div>
        </div>
        <div className="px-5 py-4 space-y-3">
          {(m.settingsFields ?? []).map(f => (
            <div key={f.key}>
              <label className="block text-[12.5px] text-zinc-600 mb-1">
                {f.label}
                {f.required && <span className="text-red-400"> *</span>}
              </label>
              {f.type === 'textarea' ? (
                <textarea
                  value={config[f.key] ?? ''}
                  onChange={e => setConfig({ ...config, [f.key]: e.target.value })}
                  className="w-full text-[13px] bg-zinc-50 rounded-lg px-3 py-2 outline-none border border-black/[0.06] resize-none h-20"
                  placeholder={f.label}
                />
              ) : (
                <input
                  value={config[f.key] ?? ''}
                  onChange={e => setConfig({ ...config, [f.key]: e.target.value })}
                  className="w-full text-[13px] bg-zinc-50 rounded-lg px-3 py-2 outline-none border border-black/[0.06] font-mono"
                  placeholder={f.type === undefined && f.key === 'url' ? 'https://…' : f.label}
                />
              )}
            </div>
          ))}
          {m.actions.length > 0 && (
            <div className="text-[12px] text-zinc-400">
              连接后可用动作：{m.actions.map(a => a.name).join('、')}
            </div>
          )}
          {error && <div className="text-[12.5px] text-red-500">{error}</div>}
        </div>
        <div className="px-5 py-3.5 border-t border-black/[0.05] flex justify-end gap-2">
          <button onClick={props.onClose} className="text-[13px] px-3.5 py-2 rounded-xl text-zinc-500 hover:bg-black/5">
            取消
          </button>
          <button
            onClick={connect}
            disabled={busy}
            className="text-[13px] font-medium px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {busy ? '连接中…' : '连接'}
          </button>
        </div>
      </div>
    </div>
  )
}
