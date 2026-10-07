import { useEffect, useState } from 'react'
import { api, useMailEvent } from '../lib/api'
import { GeneralTab } from './tabs/GeneralTab'
import { AccountsTab } from './tabs/AccountsTab'
import { NotificationsTab } from './tabs/NotificationsTab'
import { SignaturesTab, TemplatesTab } from './tabs/ContentTabs'
import { RulesTab } from './tabs/RulesTab'
import { AiTab } from './tabs/AiTab'
import { IntegrationsTab } from './tabs/IntegrationsTab'
import {
  IconSettings, IconUser, IconBell, IconCompose, IconBook,
  IconLayers, IconSparkles, IconPlug
} from '../components/icons'

const TABS = [
  { id: 'general', label: '常规', icon: IconSettings },
  { id: 'accounts', label: '账户', icon: IconUser },
  { id: 'notifications', label: '通知', icon: IconBell },
  { id: 'signatures', label: '签名', icon: IconCompose },
  { id: 'templates', label: '模板', icon: IconBook },
  { id: 'rules', label: '规则', icon: IconLayers },
  { id: 'ai', label: 'AI', icon: IconSparkles },
  { id: 'integrations', label: '集成', icon: IconPlug }
] as const

export default function SettingsApp() {
  const [tab, setTab] = useState<string>(() => {
    const m = location.hash.match(/^#\/(\w+)/)
    return m?.[1] ?? 'general'
  })

  useEffect(() => {
    const onHash = () => {
      const m = location.hash.match(/^#\/(\w+)/)
      if (m) setTab(m[1])
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useMailEvent(ev => {
    if ((ev as { type: string }).type === 'settings-navigate') {
      setTab((ev as unknown as { tab: string }).tab)
    }
  })

  return (
    <div className="h-full flex flex-col">
      <div className="drag-region h-[48px] shrink-0 flex items-center justify-center">
        <span className="text-[13.5px] font-semibold text-zinc-600">设置</span>
      </div>
      <div className="shrink-0 px-8 pb-3 flex items-start justify-center gap-1">
        {TABS.map(t => {
          const Icon = t.icon
          const active = tab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`no-drag flex flex-col items-center gap-1 w-[74px] py-2.5 rounded-xl transition ${
                active ? 'bg-white shadow-sm border border-black/[0.06] text-blue-600' : 'text-zinc-500 hover:bg-black/[0.04]'
              }`}
            >
              <Icon width={19} height={19} />
              <span className="text-[11.5px]">{t.label}</span>
            </button>
          )
        })}
      </div>
      <div className="flex-1 overflow-y-auto px-8 pb-8">
        {tab === 'general' && <GeneralTab />}
        {tab === 'accounts' && <AccountsTab />}
        {tab === 'notifications' && <NotificationsTab />}
        {tab === 'signatures' && <SignaturesTab />}
        {tab === 'templates' && <TemplatesTab />}
        {tab === 'rules' && <RulesTab />}
        {tab === 'ai' && <AiTab />}
        {tab === 'integrations' && <IntegrationsTab />}
      </div>
    </div>
  )
}
