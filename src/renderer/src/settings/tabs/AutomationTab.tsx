import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { SectionTitle, SettingRow, Toggle } from './GeneralTab'
import { RulesTab } from './RulesTab'
import type { AISettings } from '@shared/types'

const isLocal = (url: string) => url === 'builtin-local' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url)

/**
 * 自动化（v3）：原先分散在 AI / 规则 / 集成三处的自动开关合并到这里。
 * 每一项都写清「会把什么发给 AI」，云端服务时置顶提醒；规则编辑器内嵌在下方。
 */
export function AutomationTab() {
  const [s, setS] = useState<AISettings | null>(null)
  const [ready, setReady] = useState<{ ready: boolean; reason?: string } | null>(null)
  useEffect(() => {
    void api.getAISettings().then(setS)
    void api.aiStatus().then(setReady)
  }, [])
  if (!s) return null
  const update = (patch: Partial<AISettings>) => {
    const next = { ...s, ...patch }
    setS(next)
    void api.setAISettings(next)
  }
  const host = s.baseURL.replace(/^https?:\/\//, '').split('/')[0]
  const cloud = !isLocal(s.baseURL)

  return (
    <div className="max-w-[640px]">
      <SectionTitle>AI 自动处理</SectionTitle>
      {ready && !ready.ready ? (
        <div className="text-xs leading-relaxed text-zinc-500 bg-zinc-100/70 rounded-xl px-4 py-3 mb-2">
          AI 还没配置好（{ready.reason}）。下面的开关会在配置完成后生效；在此之前，分区与要点由本地规则生成。
        </div>
      ) : (
        <div className="text-xs leading-relaxed text-zinc-500 bg-zinc-100/70 rounded-xl px-4 py-3 mb-2">
          {cloud
            ? `当前使用云端服务 ${host}：开启的项目会在你不操作时，把新邮件的发件人、主题和正文（最多约 4000 字）发给它。`
            : '当前使用本地模型：邮件内容不出本机。'}
        </div>
      )}
      <SettingRow label="理解新邮件" desc="分区（需要你处理 / 等待对方 / 打包）、一句话要点、时间 / 金额 / 验证码、建议的下一步。发送：近 14 天的新邮件全文">
        <Toggle checked={s.autoUnderstand ?? true} onChange={v => update({ autoUnderstand: v })} />
      </SettingRow>
      <SettingRow label="自动分类" desc="个人 / 通知 / 订阅 / 噪声，覆盖本地规则的判断。发送：发件人、主题、摘要片段">
        <Toggle checked={s.autoClassify} onChange={v => update({ autoClassify: v })} />
      </SettingRow>
      <SettingRow label="自动提炼" desc="账单 / 会议进待办，Newsletter 进阅读清单。发送：命中这几类的邮件全文">
        <Toggle checked={s.autoInsights} onChange={v => update({ autoInsights: v })} />
      </SettingRow>
      <SettingRow label="每日简报" desc="每天整理当日重点、主题摘要和清理建议。发送：近 36 小时邮件的主题与摘要">
        <Toggle checked={s.autoDigest} onChange={v => update({ autoDigest: v })} />
      </SettingRow>
      <div className="text-xs leading-relaxed text-zinc-500 mt-2 mb-6">
        你主动点的操作（打开邮件时的要点、摘要、起草、问 Agent）不受这些开关影响。MCP 服务与连接器在「集成」里设置。
      </div>

      <SectionTitle>规则</SectionTitle>
      <div className="h-[460px]">
        <RulesTab />
      </div>
    </div>
  )
}
