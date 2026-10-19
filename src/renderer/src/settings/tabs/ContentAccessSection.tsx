import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { SectionTitle, SettingRow, Toggle, Select } from './GeneralTab'
import { GhostBtn } from '../../app/attachments/Sheets'
import { KindChips, ENGINE_OPTIONS } from '../../app/attachments/ContentAccess'
import type { AccountWithStatus, AttachmentAccessSettings, OcrAvailability, OcrEngine } from '@shared/types'

/**
 * 设置 → 附件与存储 →「附件内容读取」：总开关、分类型开关、云端 AI 授权、扫描件识字方式与视觉模型、排除账户、清除正文缓存。
 */
export function ContentAccessSection() {
  const [a, setA] = useState<AttachmentAccessSettings | null>(null)
  const [st, setSt] = useState<OcrAvailability | null>(null)
  const [accounts, setAccounts] = useState<AccountWithStatus[]>([])
  const [model, setModel] = useState('')
  const [cleared, setCleared] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const loadStatus = () => void api.ocrStatus().then(setSt).catch(() => {})
  useEffect(() => {
    void api.contentAccessGet().then(v => {
      setA(v)
      setModel(v.visionModel ?? '')
    })
    loadStatus()
    void api.listAccounts().then(setAccounts).catch(() => {})
    const off = api.onEvent(ev => {
      const e = ev as { type?: string; settings?: AttachmentAccessSettings }
      if (e.type === 'content-access-changed' && e.settings) {
        setA(e.settings)
        loadStatus()
      }
    })
    return () => void off()
  }, [])

  if (!a) return null
  const update = async (patch: Partial<AttachmentAccessSettings>) => {
    setA({ ...a, ...patch, kinds: { ...a.kinds, ...(patch.kinds ?? {}) } })
    setA(await api.contentAccessSet(patch))
    loadStatus()
  }
  const off = !a.readContent
  const engines = [{ value: 'off', label: '关闭' }, ...ENGINE_OPTIONS.filter(o => !o.needsLocal || st?.local !== false).map(o => ({ value: o.id, label: o.label }))]
  const engineDesc = a.ocrEngine === 'off' ? '扫描件与图片不做文字识别' : ENGINE_OPTIONS.find(o => o.id === a.ocrEngine)?.desc ?? ''
  const usesAI = a.ocrEngine === 'ai' || a.ocrEngine === 'local+ai'

  return (
    <>
      <SectionTitle>附件内容读取</SectionTitle>
      <div className="text-xs leading-relaxed mb-1" style={{ color: 'var(--faint)' }}>
        授权后 LinkTo 在本机读取附件里的文字，用于查看文字、按内容归类、核对发票与账单、整理进知识库、回答你对附件的提问。没有授权时只用文件名、类型和大小。
      </div>
      <SettingRow label="允许读取附件内容" desc="总开关；关闭后已提取的正文也不再被使用">
        <Toggle checked={a.readContent} onChange={v => void update({ readContent: v })} />
      </SettingRow>
      <div className={`py-3 border-b border-[var(--border-soft)] ${off ? 'opacity-50' : ''}`}>
        <div className="text-sm" style={{ color: 'var(--fg)' }}>读取哪些附件</div>
        <div className="text-xs mt-0.5 mb-2" style={{ color: 'var(--faint)' }}>按类型单独开关</div>
        <KindChips kinds={a.kinds} disabled={off} onChange={(k, v) => void update({ kinds: { ...a.kinds, [k]: v } })} />
      </div>
      <SettingRow
        label="允许把附件内容发给云端 AI"
        desc={
          st?.aiLocal
            ? '当前 AI 是本地模型，附件内容不出本机，这一项不影响它'
            : 'Agent 问答、知识库提炼、生活档案、自动技能和 AI 识字会把附件节选（或扫描页图片）发给「设置 → AI」里配置的服务；关闭时这些功能只用文件名与邮件正文'
        }
      >
        <Toggle checked={a.sendToCloudAI} onChange={v => void update({ sendToCloudAI: v })} />
      </SettingRow>
      <SettingRow label="扫描件与图片识字" desc={engineDesc}>
        <Select value={a.ocrEngine} onChange={v => void update({ ocrEngine: v as OcrEngine })} options={engines} />
      </SettingRow>
      {(usesAI || a.visionModel) && (
        <div className="py-3 border-b border-[var(--border-soft)]">
          <div className="text-sm" style={{ color: 'var(--fg)' }}>视觉模型</div>
          <div className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--faint)' }}>
            AI 识字用的模型，需要支持图片输入；留空则用 AI 设置里的模型。接口地址与 Key 沿用 AI 设置。每页约一次视觉请求（单份最多 {st?.aiMaxPages ?? 10} 页），按你的 AI 服务计费；后台补识别计入后台 AI 每日用量。
          </div>
          <input
            value={model}
            onChange={e => setModel(e.target.value)}
            onBlur={() => model.trim() !== (a.visionModel ?? '') && void update({ visionModel: model.trim() || null })}
            placeholder={st?.model && !a.visionModel ? `默认：${st.model}` : '与 AI 设置相同'}
            spellCheck={false}
            className="no-drag mt-2 w-full max-w-[360px] h-8 px-2.5 rounded-[var(--r-sm)] text-sm outline-none border"
            style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-soft)', borderColor: 'var(--border)', color: 'var(--fg)' }}
          />
          {st && !st.ai && st.aiReason && <div className="mt-1.5 text-2xs" style={{ color: 'var(--warn-ink)' }}>AI 识字暂不可用：{st.aiReason}</div>}
        </div>
      )}
      {st?.localReason && (
        <div className="py-2 text-2xs leading-relaxed" style={{ color: st.local ? 'var(--faint)' : 'var(--warn-ink)' }}>
          {st.local ? `本机识别（${st.localEngine ?? '系统文字识别'}）：` : '本机识别暂不可用：'}
          {st.localReason}
        </div>
      )}
      {accounts.length > 0 && (
        <div className="py-3 border-b border-[var(--border-soft)]">
          <div className="text-sm" style={{ color: 'var(--fg)' }}>不读取这些账户的附件</div>
          <div className="text-xs mt-0.5 mb-2" style={{ color: 'var(--faint)' }}>例如公司邮箱：勾选后这个账户的附件内容一律不读取</div>
          <div className="flex flex-col gap-1">
            {accounts.map(acc => {
              const on = a.excludedAccounts.includes(acc.id)
              return (
                <label key={acc.id} className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--fg)' }}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => void update({ excludedAccounts: on ? a.excludedAccounts.filter(x => x !== acc.id) : [...a.excludedAccounts, acc.id] })}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  <span className="truncate">{acc.name || acc.email}</span>
                  {acc.name && <span className="text-2xs truncate" style={{ color: 'var(--faint)' }}>{acc.email}</span>}
                </label>
              )
            })}
          </div>
        </div>
      )}
      <div className="py-3 flex items-center gap-3">
        <span className="flex-1 min-w-0 text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
          {cleared ?? '已提取的正文与识字结果保存在本机，用于搜索与核对；清除后需要时会重新提取。'}
        </span>
        {confirmClear ? (
          <>
            <GhostBtn onClick={() => setConfirmClear(false)}>取消</GhostBtn>
            <GhostBtn
              tone="danger"
              onClick={() => {
                setConfirmClear(false)
                void api.clearAttachmentTextCache().then(r => setCleared(`已清除 ${r.removed} 份已提取的正文`))
              }}
            >
              确认清除
            </GhostBtn>
          </>
        ) : (
          <GhostBtn onClick={() => setConfirmClear(true)}>清除已提取的正文缓存</GhostBtn>
        )}
      </div>
    </>
  )
}
