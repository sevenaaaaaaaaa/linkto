import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { SectionTitle, SettingRow, Toggle } from './GeneralTab'
import { RulesTab } from './RulesTab'
import { JobList, JobSettingsBlock } from '../../app/agent/AutomationJobs'
import { useAgentJobs } from '../../lib/automation'
import type { AISettings, GeneralSettings, Rule, RuleAction, RuleCondition } from '@shared/types'

interface Recipe {
  key: string
  title: string
  desc: string
  /** 需要用户补一个值（如联系人邮箱） */
  input?: { placeholder: string }
  ai?: boolean
  conditions(input: string): RuleCondition[]
  actions: RuleAction[]
}

/** 一键配方：常见自动化，点「启用」即生成一条规则（之后可在下方规则里改） */
const RECIPES: Recipe[] = [
  {
    key: 'codes',
    title: '验证码即时提醒',
    desc: '主题像验证码 → 即使开了智能通知也弹提醒',
    conditions: () => [{ field: 'subject', op: 'regex', value: '验证码|校验码|动态码|verification code|OTP|one-time' }],
    actions: [{ type: 'notify' }]
  },
  {
    key: 'newsletters',
    title: '订阅邮件静音',
    desc: '订阅邮件 → 自动标为已读，留在「打包」里慢慢看',
    conditions: () => [{ field: 'isNewsletter', op: 'is', value: 'yes' }],
    actions: [{ type: 'markRead' }]
  },
  {
    key: 'bills',
    title: '账单与发票进待办',
    desc: '主题含账单 / 发票 / 付款 → 建待办并加旗标',
    conditions: () => [{ field: 'subject', op: 'regex', value: '账单|发票|付款|缴费|续费|invoice|receipt|payment' }],
    actions: [{ type: 'createTodo', value: '付款' }, { type: 'flag' }]
  },
  {
    key: 'shipping',
    title: '快递通知晚点再看',
    desc: '快递 / 物流 / 签收 → 稍后 4 小时再回到收件箱',
    conditions: () => [{ field: 'subject', op: 'regex', value: '快递|物流|包裹|签收|派送|shipped|delivery|tracking' }],
    actions: [{ type: 'snooze', value: '4' }]
  },
  {
    key: 'vip',
    title: '重要联系人',
    desc: '来自 Ta 的邮件 → 强制通知并置顶',
    input: { placeholder: '对方邮箱，如 boss@company.com' },
    conditions: v => [{ field: 'from', op: 'contains', value: v }],
    actions: [{ type: 'notify' }, { type: 'pin' }]
  },
  {
    key: 'contracts',
    title: '合同存知识库',
    desc: '带附件且主题含合同 / 协议 → 存入知识库并加旗标',
    conditions: () => [
      { field: 'hasAttachment', op: 'is', value: 'yes' },
      { field: 'subject', op: 'regex', value: '合同|协议|contract|agreement|NDA' }
    ],
    actions: [{ type: 'saveToKb' }, { type: 'flag' }]
  },
  {
    key: 'ai-partner',
    title: '合作邀约不漏掉',
    desc: 'AI 判断是需要你本周回复的合作 / 商务邀约 → 通知并加旗标',
    ai: true,
    conditions: () => [{ field: 'ai', op: 'contains', value: '需要我在本周内回复的合作、商务或采访邀约' }],
    actions: [{ type: 'notify' }, { type: 'flag' }]
  },
  {
    key: 'ai-promo',
    title: '营销推广自动归档',
    desc: 'AI 判断是纯营销推广、没有需要我处理的内容 → 归档',
    ai: true,
    conditions: () => [{ field: 'ai', op: 'contains', value: '纯营销推广或广告，没有任何需要我处理或回复的内容' }],
    actions: [{ type: 'archive' }]
  },
  {
    key: 'ai-recruit',
    title: '猎头邮件收起来',
    desc: 'AI 判断是猎头 / 招聘外联 → 标已读并归档',
    ai: true,
    conditions: () => [{ field: 'ai', op: 'contains', value: '猎头或招聘方主动发来的职位推荐、外联邮件' }],
    actions: [{ type: 'markRead' }, { type: 'archive' }]
  }
]

const DAY_OPTIONS = [0, 3, 7, 14, 30]

const isLocal = (url: string) => url === 'builtin-local' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url)

/**
 * 自动化（v3）：原先分散在 AI / 规则 / 集成三处的自动开关合并到这里。
 * 每一项都写清「会把什么发给 AI」，云端服务时置顶提醒；规则编辑器内嵌在下方。
 */
export function AutomationTab() {
  const [s, setS] = useState<AISettings | null>(null)
  const [ready, setReady] = useState<{ ready: boolean; reason?: string } | null>(null)
  const [general, setGeneral] = useState<GeneralSettings | null>(null)
  const [rules, setRules] = useState<Rule[]>([])
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [rulesKey, setRulesKey] = useState(0)
  useEffect(() => {
    void api.getAISettings().then(setS)
    void api.aiStatus().then(setReady)
    void api.getGeneralSettings().then(setGeneral)
    void api.listRules().then(setRules)
  }, [rulesKey])
  const enabledRecipe = (k: string) => rules.some(r => r.id.startsWith(`recipe-${k}`))
  const addRecipe = async (r: Recipe) => {
    const v = (inputs[r.key] ?? '').trim()
    if (r.input && !v) return
    await api.saveRule({
      id: `recipe-${r.key}-${Date.now()}`,
      name: r.input ? `${r.title}：${v}` : r.title,
      enabled: true,
      order: rules.length,
      conditions: r.conditions(v),
      actions: r.actions
    })
    setInputs(x => ({ ...x, [r.key]: '' }))
    setRulesKey(k => k + 1)
  }
  const setCleanup = (patch: Partial<GeneralSettings>) => {
    if (!general) return
    const next = { ...general, ...patch }
    setGeneral(next)
    void api.setGeneralSettings(next)
  }
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

      <SectionTitle>后台任务</SectionTitle>
      <div className="text-xs mb-3 leading-relaxed" style={{ color: 'var(--faint)' }}>
        Agent 在后台按节奏替你收集与学习，结果记在「Agent → 自动任务」的活动记录里。与那里的开关是同一份设置。
      </div>
      <JobList compact />
      <BackgroundAiSettings />

      <SectionTitle>一键配方</SectionTitle>
      <div className="text-xs mb-3" style={{ color: 'var(--faint)' }}>点「启用」生成一条规则，只作用于之后新到的邮件；标了「AI」的需要先配置好 AI 模型。</div>
      <div className="grid grid-cols-2 gap-2.5">
        {RECIPES.map(r => {
          const on = enabledRecipe(r.key) && !r.input
          return (
            <div key={r.key} className="rounded-[var(--r-md)] border border-[var(--border)] p-3.5 flex flex-col gap-2" style={{ background: 'var(--surface-strong)' }}>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold flex-1" style={{ color: 'var(--fg)' }}>{r.title}</span>
                {r.ai && <span className="text-2xs font-bold px-1.5 py-px rounded-[var(--r-xs)] ai-chip">AI</span>}
              </div>
              <div className="text-xs leading-relaxed flex-1" style={{ color: 'var(--muted)' }}>{r.desc}</div>
              {r.input && (
                <input
                  value={inputs[r.key] ?? ''}
                  onChange={e => setInputs(x => ({ ...x, [r.key]: e.target.value }))}
                  placeholder={r.input.placeholder}
                  className="text-xs h-8 px-2.5 rounded-[var(--r-sm)] outline-none border border-[var(--border)]"
                  style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
                />
              )}
              <button
                onClick={() => void addRecipe(r)}
                disabled={on || (!!r.input && !(inputs[r.key] ?? '').trim())}
                className="self-start h-7 px-3 rounded-[var(--r-sm)] text-xs font-semibold disabled:opacity-50"
                style={on ? { color: 'var(--muted)', background: 'var(--hover)' } : { background: 'var(--accent)', color: 'var(--on-accent)' }}
              >
                {on ? '已启用' : r.input ? '添加' : '启用'}
              </button>
            </div>
          )
        })}
      </div>

      <SectionTitle>定期整理</SectionTitle>
      <SettingRow label="已读的订阅邮件" desc="超过这个天数自动归档（未读、加旗标、置顶的不动）">
        <select
          value={general?.cleanupNewsletterDays ?? 0}
          onChange={e => setCleanup({ cleanupNewsletterDays: Number(e.target.value) })}
          className="text-sm h-8 px-2 rounded-[var(--r-sm)] border border-[var(--border)]"
          style={{ background: 'var(--surface-strong)', color: 'var(--fg)' }}
        >
          {DAY_OPTIONS.map(d => (
            <option key={d} value={d}>{d ? `${d} 天后归档` : '不整理'}</option>
          ))}
        </select>
      </SettingRow>
      <SettingRow label="已读的通知类邮件" desc="验证码、物流、系统通知等，超过天数自动归档">
        <select
          value={general?.cleanupNotificationDays ?? 0}
          onChange={e => setCleanup({ cleanupNotificationDays: Number(e.target.value) })}
          className="text-sm h-8 px-2 rounded-[var(--r-sm)] border border-[var(--border)]"
          style={{ background: 'var(--surface-strong)', color: 'var(--fg)' }}
        >
          {DAY_OPTIONS.map(d => (
            <option key={d} value={d}>{d ? `${d} 天后归档` : '不整理'}</option>
          ))}
        </select>
      </SettingRow>

      <SectionTitle>我的规则</SectionTitle>
      <div className="h-[460px]">
        <RulesTab key={rulesKey} />
      </div>
    </div>
  )
}

/** 后台 AI 用量上限 / 只在接通电源时（与 Agent → 自动任务页同一份设置） */
function BackgroundAiSettings() {
  const { settings, saveSettings } = useAgentJobs()
  return (
    <div className="mt-4">
      <JobSettingsBlock settings={settings} onChange={p => void saveSettings(p)} />
    </div>
  )
}
