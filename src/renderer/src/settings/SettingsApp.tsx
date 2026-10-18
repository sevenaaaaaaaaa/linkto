import { useEffect, useMemo, useState } from 'react'
import { useMailEvent } from '../lib/api'
import { GeneralTab } from './tabs/GeneralTab'
import { AccountsTab } from './tabs/AccountsTab'
import { NotificationsTab } from './tabs/NotificationsTab'
import { SignaturesTab, TemplatesTab } from './tabs/ContentTabs'
import { AutomationTab } from './tabs/AutomationTab'
import { AiTab } from './tabs/AiTab'
import { IntegrationsTab } from './tabs/IntegrationsTab'
import { BackupTab } from './tabs/BackupTab'
import { PersonalTab } from './tabs/PersonalTab'
import {
  IconSettings, IconUser, IconBell, IconCompose, IconBook, IconSearch,
  IconLayers, IconSparkles, IconPlug, IconArchive, IconPalette
} from '../components/icons'

interface Page {
  id: string
  label: string
  desc: string
  icon: (p: { width?: number; height?: number }) => React.ReactElement
  /** 搜索关键词：页面里的设置项名称与常见叫法 */
  keywords: string
}

/** 按用途分组：你的邮箱 → 收件体验 → 智能 → 数据与系统 */
const GROUPS: { title: string; pages: Page[] }[] = [
  {
    title: '你的邮箱',
    pages: [
      { id: 'accounts', label: '账户', desc: '添加邮箱、授权、服务器设置与同步状态', icon: IconUser, keywords: '账户 邮箱 授权 OAuth Gmail Outlook QQ 163 Proton Bridge 密码 授权码 服务器 IMAP SMTP 端口 停用 删除账户' },
      { id: 'signatures', label: '签名', desc: '每个账户的默认签名', icon: IconCompose, keywords: '签名 落款' },
      { id: 'templates', label: '模板', desc: '常用回复模板与分门别类的预设库', icon: IconBook, keywords: '模板 预设 快捷回复 催款 会议 婉拒 感谢 求职 客服 英文' }
    ]
  },
  {
    title: '收件体验',
    pages: [
      { id: 'personal', label: '个性化', desc: '列表、阅读、侧栏、账户颜色、字体与快捷键', icon: IconPalette, keywords: '个性化 密度 紧凑 舒适 字号 字体 宽度 侧栏 快捷键 单键 颜色 AI 要点 分区 简报 划重点 右侧栏' },
      { id: 'notifications', label: '通知', desc: '新邮件提醒、智能通知、免打扰与声音', icon: IconBell, keywords: '通知 提醒 声音 免打扰 智能通知 角标 测试通知' },
      { id: 'rules', label: '自动化', desc: 'AI 自动处理、规则与一键配方、定期整理', icon: IconLayers, keywords: '自动化 规则 配方 自动归档 自动分类 自动提炼 每日简报 理解新邮件 AI 判断 连接器动作 整理 清理' }
    ]
  },
  {
    title: '智能',
    pages: [
      { id: 'ai', label: 'AI 模型', desc: '云端 API、本地模型、内置引擎与自定义咒语', icon: IconSparkles, keywords: 'AI 模型 API Key DeepSeek GLM OpenAI Ollama LM Studio 本地 内置引擎 咒语 提示词' },
      { id: 'integrations', label: '集成', desc: 'MCP 服务、连接器、网盘', icon: IconPlug, keywords: '集成 MCP Claude Code 连接器 网盘 WebDAV Dropbox Proton Drive Webhook' }
    ]
  },
  {
    title: '数据与系统',
    pages: [
      { id: 'backup', label: '备份', desc: '加密备份账户配置，跨设备恢复', icon: IconArchive, keywords: '备份 恢复 迁移 iCloud Dropbox Proton Drive 坚果云 OneDrive 口令 加密' },
      { id: 'general', label: '通用', desc: '外观主题、隐私、开机自启与关于', icon: IconSettings, keywords: '通用 主题 明暗 深色 外观 远程图片 隐私 删除 开机自启 Dock 角标 Screener 新发件人审批 关于 版本' }
    ]
  }
]
const PAGES = GROUPS.flatMap(g => g.pages)

export default function SettingsApp() {
  const [tab, setTab] = useState<string>(() => location.hash.match(/^#\/(\w+)/)?.[1] ?? 'personal')
  const [q, setQ] = useState('')

  useEffect(() => {
    const onHash = () => {
      const m = location.hash.match(/^#\/(\w+)/)
      if (m) setTab(m[1])
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useMailEvent(ev => {
    if ((ev as { type: string }).type === 'settings-navigate') setTab((ev as unknown as { tab: string }).tab)
  })

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return null
    return PAGES.filter(p => `${p.label} ${p.desc} ${p.keywords}`.toLowerCase().includes(needle))
  }, [q])
  const page = PAGES.find(p => p.id === tab) ?? PAGES[0]

  return (
    <div className="h-full flex" style={{ background: 'var(--bg)' }}>
      <aside className="w-[220px] shrink-0 h-full flex flex-col border-r border-[var(--border)]" style={{ background: 'var(--bg-soft)' }}>
        {/* 红绿灯区 */}
        <div className="drag-region h-[52px] shrink-0" />
        <div className="px-3 pb-3">
          <label className="no-drag h-8 px-2.5 flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border)]" style={{ background: 'var(--surface-strong)', color: 'var(--faint)' }}>
            <IconSearch width={13} height={13} />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && matches?.[0]) {
                  setTab(matches[0].id)
                  setQ('')
                }
                if (e.key === 'Escape') setQ('')
              }}
              placeholder="搜索设置"
              className="flex-1 min-w-0 bg-transparent outline-none text-sm"
              style={{ color: 'var(--fg)' }}
            />
          </label>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label="设置分区">
          {matches ? (
            <>
              <div className="px-2 pt-1 pb-1.5 text-2xs font-semibold" style={{ color: 'var(--faint)' }}>
                {matches.length ? `${matches.length} 个结果` : '没有匹配的设置'}
              </div>
              {matches.map(p => (
                <NavItem
                  key={p.id}
                  page={p}
                  active={false}
                  sub={p.desc}
                  onClick={() => {
                    setTab(p.id)
                    setQ('')
                  }}
                />
              ))}
            </>
          ) : (
            GROUPS.map(g => (
              <div key={g.title} className="mb-3">
                <div className="px-2 pt-1 pb-1 text-2xs font-semibold" style={{ color: 'var(--faint)', letterSpacing: '0.04em' }}>{g.title}</div>
                {g.pages.map(p => (
                  <NavItem key={p.id} page={p} active={tab === p.id} onClick={() => setTab(p.id)} />
                ))}
              </div>
            ))
          )}
        </nav>
      </aside>

      <main className="flex-1 min-w-0 h-full flex flex-col">
        <header className="drag-region shrink-0 px-8 pt-7 pb-4">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--fg)', letterSpacing: '-0.01em' }}>{page.label}</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>{page.desc}</p>
        </header>
        <div className="flex-1 overflow-y-auto px-8 pb-10">
          {tab === 'general' && <GeneralTab />}
          {tab === 'personal' && <PersonalTab />}
          {tab === 'accounts' && <AccountsTab />}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'signatures' && <SignaturesTab />}
          {tab === 'templates' && <TemplatesTab />}
          {tab === 'rules' && <AutomationTab />}
          {tab === 'ai' && <AiTab />}
          {tab === 'integrations' && <IntegrationsTab />}
          {tab === 'backup' && <BackupTab />}
        </div>
      </main>
    </div>
  )
}

function NavItem(props: { page: Page; active: boolean; sub?: string; onClick(): void }) {
  const Icon = props.page.icon
  return (
    <button
      onClick={props.onClick}
      aria-current={props.active ? 'page' : undefined}
      className="no-drag w-full flex items-center gap-2.5 px-2 py-1.5 rounded-[var(--r-sm)] text-left text-sm transition-colors hover:bg-[var(--hover)]"
      style={props.active ? { background: 'var(--selected)', color: 'var(--fg)', fontWeight: 600 } : { color: 'var(--fg)' }}
    >
      <span className="w-5 shrink-0 inline-flex justify-center" style={{ color: props.active ? 'var(--fg)' : 'var(--muted)' }}>
        <Icon width={15} height={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{props.page.label}</span>
        {props.sub && <span className="block truncate text-2xs font-normal" style={{ color: 'var(--faint)' }}>{props.sub}</span>}
      </span>
    </button>
  )
}
