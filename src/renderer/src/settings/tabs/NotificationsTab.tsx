import { useEffect, useState } from 'react'
import { api, useMailEvent } from '../../lib/api'
import { SectionTitle, SettingRow, Toggle, Select } from './GeneralTab'
import type { NotificationAction, NotificationSettings, QuietHours } from '@shared/types'

const ACTIONS: { value: NotificationAction; label: string }[] = [
  { value: 'none', label: '无操作' },
  { value: 'markRead', label: '标为已读' },
  { value: 'reply', label: '回复' },
  { value: 'delete', label: '删除' },
  { value: 'archive', label: '归档' },
  { value: 'flag', label: '加旗标' }
]

const DEFAULT_QUIET: QuietHours = { enabled: false, start: '22:00', end: '08:00' }

type TestResult = { ok: boolean; via: 'native' | 'applescript' | 'none'; error?: string }

const SOUNDS = [
  { value: 'default', label: '默认' },
  { value: 'silent', label: '静音' }
]

export function NotificationsTab() {
  const [s, setS] = useState<NotificationSettings | null>(null)
  const [accounts, setAccounts] = useState<{ id: string; name: string; email: string }[]>([])
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  useEffect(() => {
    void api.getNotificationSettings().then(setS)
    void api.listAccounts().then(as => setAccounts(as.map(a => ({ id: a.id, name: a.name, email: a.email }))))
  }, [])

  useMailEvent(ev => {
    if ((ev as { type: string }).type === 'accounts-changed') {
      void api.listAccounts().then(as => setAccounts(as.map(a => ({ id: a.id, name: a.name, email: a.email }))))
    }
  })

  if (!s) return null
  const update = (patch: Partial<NotificationSettings>) => {
    const next = { ...s, ...patch }
    setS(next)
    void api.setNotificationSettings(next)
  }

  const setAction = (i: number, v: string) => {
    const actions = [...s.actions] as [NotificationAction, NotificationAction, NotificationAction]
    actions[i] = v as NotificationAction
    update({ actions })
  }

  const quiet = s.quietHours ?? DEFAULT_QUIET
  const setQuiet = (patch: Partial<QuietHours>) => update({ quietHours: { ...quiet, ...patch } })

  const per = (accountId: string) => s.perAccount[accountId] ?? { enabled: true, sound: 'default' }
  const setPer = (accountId: string, patch: Partial<{ enabled: boolean; sound: string }>) =>
    update({ perAccount: { ...s.perAccount, [accountId]: { ...per(accountId), ...patch } } })

  return (
    <div className="max-w-[620px]">
      <SectionTitle>通知</SectionTitle>
      <SettingRow label="启用通知">
        <Toggle checked={s.enabled} onChange={v => update({ enabled: v })} />
      </SettingRow>
      <SettingRow label="智能通知" desc="仅个人邮件和「需要你处理」的邮件触发通知，订阅与系统通知不打扰">
        <Toggle checked={s.smart} onChange={v => update({ smart: v })} />
      </SettingRow>
      <SettingRow label="通知声音">
        <Toggle checked={s.sound} onChange={v => update({ sound: v })} />
      </SettingRow>
      <SettingRow label="免打扰时段" desc="时段内新邮件不弹通知（规则中的「通知我」除外），支持跨午夜">
        <div className="flex items-center gap-2">
          {quiet.enabled && (
            <>
              <input
                type="time"
                value={quiet.start}
                onChange={e => e.target.value && setQuiet({ start: e.target.value })}
                className="no-drag text-sm bg-zinc-100 rounded-lg px-2 py-1 outline-none border border-ink/[0.05]"
              />
              <span className="text-xs text-zinc-400">至</span>
              <input
                type="time"
                value={quiet.end}
                onChange={e => e.target.value && setQuiet({ end: e.target.value })}
                className="no-drag text-sm bg-zinc-100 rounded-lg px-2 py-1 outline-none border border-ink/[0.05]"
              />
            </>
          )}
          <Toggle checked={quiet.enabled} onChange={v => setQuiet({ enabled: v })} />
        </div>
      </SettingRow>
      <SettingRow label="测试通知" desc="立即发送一条系统通知，用于确认 macOS 通知权限是否可用">
        <button
          onClick={async () => {
            setTesting(true)
            setTestResult(null)
            try {
              setTestResult(await api.notifyTestResult())
            } catch (err) {
              setTestResult({ ok: false, via: 'none', error: String((err as Error)?.message ?? err) })
            } finally {
              setTimeout(() => setTesting(false), 1200)
            }
          }}
          disabled={testing}
          className="no-drag text-xs px-3 py-1.5 rounded-lg border border-ink/[0.08] bg-white hover:bg-zinc-50 disabled:opacity-50"
        >
          {testing ? '已发送' : '发送测试通知'}
        </button>
      </SettingRow>
      {testResult && <TestResultNote r={testResult} />}

      <SectionTitle>通知操作</SectionTitle>
      {[0, 1, 2].map(i => (
        <SettingRow key={i} label={`操作 ${i + 1}`}>
          <Select value={s.actions[i]} onChange={v => setAction(i, v)} options={ACTIONS} />
        </SettingRow>
      ))}

      <SectionTitle>按账户</SectionTitle>
      {accounts.map(a => (
        <div key={a.id} className="py-3 border-b border-ink/[0.04]">
          <div className="text-sm text-zinc-800 mb-2">{a.name}</div>
          <div className="flex items-center gap-6 pl-1">
            <label className="flex items-center gap-2 text-sm text-zinc-600">
              <Toggle checked={per(a.id).enabled} onChange={v => setPer(a.id, { enabled: v })} />
              通知
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-600">
              声音
              <Select value={per(a.id).sound} onChange={v => setPer(a.id, { sound: v })} options={SOUNDS} />
            </label>
          </div>
        </div>
      ))}
      {!accounts.length && <div className="text-sm text-zinc-400 py-3">添加账户后可分别设置</div>}
    </div>
  )
}

/** 测试通知结果说明：系统通知失败时指引去「系统设置 → 通知」放行 */
function TestResultNote({ r }: { r: TestResult }) {
  if (r.ok && r.via === 'native') {
    return (
      <div className="text-xs py-2 leading-relaxed" style={{ color: 'var(--ok-ink)' }}>
        已交给系统通知中心。若没有看到横幅，请到「系统设置 → 通知 → LinkTo」打开「允许通知」，提醒样式选「横幅」或「提醒」，并确认未开启专注模式。
      </div>
    )
  }
  return (
    <div className="text-xs py-2 leading-relaxed" style={{ color: r.via === 'none' ? 'var(--danger-ink)' : 'var(--warn-ink)' }}>
      系统通知发送失败{r.error ? `（${r.error}）` : ''}。
      {r.via === 'applescript'
        ? '已改用兜底通知（显示为「脚本编辑器」，没有操作按钮，点击无法定位邮件）。'
        : '兜底通知也未能发出。'}
      请到「系统设置 → 通知 → LinkTo」允许通知；列表里没有 LinkTo 时，先用安装包里的「打不开？双击我」重新签名后重启应用再试。
    </div>
  )
}
