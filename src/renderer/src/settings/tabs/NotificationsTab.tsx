import { useEffect, useState } from 'react'
import { api, useMailEvent } from '../../lib/api'
import { SectionTitle, SettingRow, Toggle, Select } from './GeneralTab'
import type { NotificationAction, NotificationSettings } from '@shared/types'

const ACTIONS: { value: NotificationAction; label: string }[] = [
  { value: 'none', label: '无操作' },
  { value: 'markRead', label: '标为已读' },
  { value: 'reply', label: '回复' },
  { value: 'delete', label: '删除' },
  { value: 'archive', label: '归档' },
  { value: 'flag', label: '加旗标' }
]

const SOUNDS = [
  { value: 'default', label: '默认' },
  { value: 'silent', label: '静音' }
]

export function NotificationsTab() {
  const [s, setS] = useState<NotificationSettings | null>(null)
  const [accounts, setAccounts] = useState<{ id: string; name: string; email: string }[]>([])
  const [testing, setTesting] = useState(false)

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

  const per = (accountId: string) => s.perAccount[accountId] ?? { enabled: true, sound: 'default' }
  const setPer = (accountId: string, patch: Partial<{ enabled: boolean; sound: string }>) =>
    update({ perAccount: { ...s.perAccount, [accountId]: { ...per(accountId), ...patch } } })

  return (
    <div className="max-w-[620px]">
      <SectionTitle>通知</SectionTitle>
      <SettingRow label="启用通知">
        <Toggle checked={s.enabled} onChange={v => update({ enabled: v })} />
      </SettingRow>
      <SettingRow label="智能通知" desc="仅个人邮件触发通知，订阅与通知类不打扰">
        <Toggle checked={s.smart} onChange={v => update({ smart: v })} />
      </SettingRow>
      <SettingRow label="通知声音">
        <Toggle checked={s.sound} onChange={v => update({ sound: v })} />
      </SettingRow>
      <SettingRow label="测试通知" desc="立即发送一条系统通知，用于确认 macOS 通知权限是否可用">
        <button
          onClick={async () => {
            setTesting(true)
            try {
              await api.notifyTest()
            } finally {
              setTimeout(() => setTesting(false), 1200)
            }
          }}
          disabled={testing}
          className="no-drag text-[12.5px] px-3 py-1.5 rounded-lg border border-black/[0.08] bg-white hover:bg-zinc-50 disabled:opacity-50"
        >
          {testing ? '已发送' : '发送测试通知'}
        </button>
      </SettingRow>

      <SectionTitle>通知操作</SectionTitle>
      {[0, 1, 2].map(i => (
        <SettingRow key={i} label={`操作 ${i + 1}`}>
          <Select value={s.actions[i]} onChange={v => setAction(i, v)} options={ACTIONS} />
        </SettingRow>
      ))}

      <SectionTitle>按账户</SectionTitle>
      {accounts.map(a => (
        <div key={a.id} className="py-3 border-b border-black/[0.04]">
          <div className="text-[13.5px] text-zinc-800 mb-2">{a.name}</div>
          <div className="flex items-center gap-6 pl-1">
            <label className="flex items-center gap-2 text-[13px] text-zinc-600">
              <Toggle checked={per(a.id).enabled} onChange={v => setPer(a.id, { enabled: v })} />
              通知
            </label>
            <label className="flex items-center gap-2 text-[13px] text-zinc-600">
              声音
              <Select value={per(a.id).sound} onChange={v => setPer(a.id, { sound: v })} options={SOUNDS} />
            </label>
          </div>
        </div>
      ))}
      {!accounts.length && <div className="text-[13px] text-zinc-400 py-3">添加账户后可分别设置</div>}
    </div>
  )
}
