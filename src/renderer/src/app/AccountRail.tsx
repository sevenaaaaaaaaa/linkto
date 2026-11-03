import { useEffect, useRef, useState } from 'react'
import { useMail, type Scope } from '../stores/mail'
import { api } from '../lib/api'
import { goView, goAgent, useView } from '../lib/route'
import { useSidebarCollapsed, setSidebarCollapsed } from '../lib/sidebar-collapse'
import { useTodos, useTodoEvents, todayCount } from '../lib/todos'
import { useOverdueCount } from '../lib/followups'
import { useProjectBadge } from './projects/ProjectBits'
import { useFeeds, useFeedEvents, unreadOf, openFeeds } from '../lib/feeds'
import { navIcon } from './upgrade/nav-meta'
import { accountHoverText } from './AccountIssues'
import { IconLayers, IconPlus, IconChevronRight } from '../components/icons'

/** 品牌标「年轮 @」：@ = 邮件，两圈年轮 = Agent 记忆，荧光内核 = AI，向右的尾线 = To；spin = 常驻慢转 */
export function LogoMark(props: { size?: number; tile?: boolean; spin?: boolean }) {
  const s = props.size ?? 28
  return (
    <svg width={s} height={s} viewBox="0 0 120 120" role="img" aria-label="LinkTo" className={props.spin ? 'logo-spin' : undefined}>
      {props.tile && <rect x="2" y="2" width="116" height="116" rx="28" fill="var(--rail-bg)" />}
      <path d="M101.4 52.7 A42 42 0 1 0 60 102 L94 102" fill="none" stroke="var(--rail-fg)" strokeWidth="10" strokeLinecap="round" />
      <path d="M81.8 70.1 A24 24 0 1 1 81.8 49.9" fill="none" stroke="var(--rail-fg)" strokeWidth="10" strokeLinecap="round" />
      <circle cx="60" cy="60" r="10" fill="var(--ai)" />
    </svg>
  )
}

/** 账户名的单字标识：中文取首字，英文取首字母 */
const initialOf = (name: string) => ([...name.trim()][0] ?? '?').toUpperCase()

/** Dock 里的导航入口（折叠时融入账户栏）：icon + 未读角标 + tooltip */
interface DockEntry {
  id: string
  icon: React.ReactNode
  label: string
  unread?: number
  muted?: boolean
  active: boolean
  onClick(): void
}

/**
 * 账户栏：最左侧深墨竖条，天然是应用的 Dock。
 * - 顶部 layers 图标 = 账户收纳开关：点一下把平时不常用的邮箱账户入口收起来，给 Dock 里的
 *   导航 icon 腾地方（收起时汇总未读挂在 layers 上；切换全部账户仍可用 ⌘0）
 * - 侧栏折叠（极简模式）时：核心导航（收件箱 / 待办 / 等待对方 / 项目 / 订阅）以 icon 融入 Dock
 * - 底部 Logo 常驻慢转：展开态点击 = 开启极简模式（侧栏收进 Dock）；折叠态点击 = AI 入口菜单
 */
export function AccountRail() {
  const { accounts, folders, accountCtx, setAccountCtx, scope, setScope } = useMail()
  const collapsed = useSidebarCollapsed()
  const view = useView()
  useTodoEvents()
  useFeedEvents()
  const todoToday = todayCount(useTodos(st => st.todos))
  const followupOverdue = useOverdueCount()
  const projectBadge = useProjectBadge()
  const feedUnread = unreadOf(useFeeds(st => st.sources))
  // 账户入口收纳：收起来给 Dock 里的导航 icon 腾地方（记住习惯）
  const [accountsHidden, setAccountsHidden] = useState(() => {
    try {
      return localStorage.getItem('ms_rail_accounts_hidden') === '1'
    } catch {
      return false
    }
  })
  const [aiMenu, setAiMenu] = useState(false)
  // 加密沟通（幽灵信）做成隐藏入口：连点 Logo ≥3 次触发；900ms 内不到 3 次则按正常 Logo 语义走
  const logoClicks = useRef(0)
  const logoTimer = useRef<number>(0)
  const onLogoClick = () => {
    logoClicks.current += 1
    if (logoClicks.current >= 3) {
      window.clearTimeout(logoTimer.current)
      logoClicks.current = 0
      setAiMenu(false)
      void api.openGhost()
      return
    }
    window.clearTimeout(logoTimer.current)
    logoTimer.current = window.setTimeout(() => {
      if (logoClicks.current < 3) {
        if (logoClicks.current === 2) {
          window.dispatchEvent(new CustomEvent('ms:toast', { detail: '再点一次 Logo，进入加密沟通（幽灵信）' }))
        }
        if (collapsed) setAiMenu(o => !o)
        else setSidebarCollapsed(true)
      }
      logoClicks.current = 0
    }, 900)
  }

  const toggleAccountsHidden = () => {
    setAccountsHidden(h => {
      try {
        localStorage.setItem('ms_rail_accounts_hidden', h ? '0' : '1')
      } catch {
        /* 存储不可用时仅本次生效 */
      }
      return !h
    })
  }

  const accountUnread = (id: string) => folders.filter(f => f.accountId === id && f.special === 'inbox').reduce((s, f) => s + f.unread, 0)
  const totalUnread = folders.filter(f => f.special === 'inbox').reduce((s, f) => s + f.unread, 0)
  const ctxAccount = accountCtx ? accounts.find(a => a.id === accountCtx) ?? null : null

  // AI 菜单：Esc 关闭
  useEffect(() => {
    if (!aiMenu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setAiMenu(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [aiMenu])
  // 退出极简模式时收起 AI 菜单（此时 Logo 的职责变了）
  useEffect(() => {
    if (!collapsed) setAiMenu(false)
  }, [collapsed])

  const go = (next: Scope) => {
    goView('mail')
    setScope(next)
  }
  const is = (k: Scope['kind']) => view === 'mail' && scope.kind === k

  /** 折叠时融入 Dock 的核心导航（克制的五个；其余入口在顶部浮层与 Logo 菜单里） */
  const dockEntries: DockEntry[] = [
    {
      id: 'inbox',
      icon: navIcon('inbox', 19),
      label: '收件箱',
      unread: folders.filter(f => f.special === 'inbox' && (!accountCtx || f.accountId === accountCtx)).reduce((s, f) => s + f.unread, 0),
      active: is('unified') || is('account'),
      onClick: () => go(ctxAccount ? { kind: 'account', accountId: ctxAccount.id, title: ctxAccount.name } : { kind: 'unified', title: '收件箱' })
    },
    { id: 'todo', icon: navIcon('todo', 19), label: '待办', unread: todoToday, active: view === 'todo', onClick: () => goView('todo') },
    { id: 'followup', icon: navIcon('followup', 19), label: '等待对方回复', unread: followupOverdue, active: is('followup'), onClick: () => go({ kind: 'followup', title: '等待对方回复' }) },
    { id: 'projects', icon: navIcon('projects', 19), label: '项目', unread: projectBadge, active: view === 'projects', onClick: () => goView('projects') },
    { id: 'feeds', icon: navIcon('feeds', 19), label: '订阅', unread: feedUnread, muted: true, active: view === 'feeds', onClick: () => openFeeds() }
  ]

  return (
    /* 外层与侧栏同底色：顶部 52px 是和侧栏连成一体的标题带，红绿灯落在这里（不再受深色栏宽度约束）；
       深色账户柱与右栏同节奏：圆角收为 r-md（10px），与列表 / 阅读区卡片的圆角统一 */
    <div className="w-[var(--rail-w)] shrink-0 h-full flex flex-col" style={{ background: 'var(--native-shell-bg, var(--bg))' }}>
      <div className="drag-region native-web-titlebar h-[var(--titlebar-h)] w-full shrink-0" />
      <nav
        aria-label="账户"
        className="rail-nav drag-region flex-1 min-h-0 mx-2 mb-2 rounded-[var(--r-md)] flex flex-col items-center overflow-y-auto"
        style={{ background: 'var(--rail-bg)', color: 'var(--rail-fg)', scrollbarWidth: 'none' }}
      >
        <div className="flex flex-col items-center gap-2.5 pt-3">
          {/* 顶部 layers = 账户收纳开关：收起平时不常用的邮箱入口，给下面的导航 icon 腾地方；
              收起时汇总未读挂在图标上（切全部账户仍可用 ⌘0） */}
          <RailButton
            label={accountsHidden ? `展开账户入口（${accounts.length} 个${totalUnread ? ` · 共 ${totalUnread > 99 ? '99+' : totalUnread} 未读` : ''}）` : `收起账户入口（${accounts.length} 个邮箱收进这个图标）`}
            active={false}
            onClick={toggleAccountsHidden}
            badge={accountsHidden ? totalUnread : 0}
            style={{ background: 'var(--rail-line)' }}
          >
            <IconLayers width={18} height={18} />
          </RailButton>
          {!accountsHidden && (
            <>
              <div className="w-6 h-px my-0.5" style={{ background: 'var(--rail-line)' }} />
              {accounts.map((a, i) => (
                <RailButton
                  key={a.id}
                  label={accountHoverText(a, i < 9 ? `⌘${i + 1}` : undefined)}
                  active={accountCtx === a.id}
                  onClick={() => setAccountCtx(a.id)}
                  badge={accountUnread(a.id)}
                  status={a.status}
                  style={{ background: a.color, color: 'oklch(100% 0 0)' }}
                >
                  <span className="text-base font-semibold">{initialOf(a.name)}</span>
                </RailButton>
              ))}
              <button
                onClick={() => api.openSettings('accounts')}
                title="添加账户"
                aria-label="添加账户"
                className="w-10 h-10 rounded-[var(--r-md)] inline-flex items-center justify-center transition-colors hover:bg-[var(--rail-line)]"
                style={{ border: '1px dashed var(--rail-line)', color: 'var(--rail-muted)' }}
              >
                <IconPlus width={16} height={16} />
              </button>
            </>
          )}

          {/* 极简模式：侧栏核心入口融入 Dock（其余入口走 ⌘K / Logo AI 菜单） */}
          {collapsed && (
            <>
              <div className="w-6 h-px my-0.5" style={{ background: 'var(--rail-line)' }} />
              {dockEntries.map(e => (
                <DockNavButton key={e.id} entry={e} />
              ))}
              <div className="w-6 h-px my-0.5" style={{ background: 'var(--rail-line)' }} />
            </>
          )}
        </div>
        <div className="flex-1 min-h-3" />
        <div className="pb-3 flex flex-col items-center gap-1.5">
          {collapsed && (
            <button
              onClick={() => setSidebarCollapsed(false)}
              title="展开侧栏"
              aria-label="展开侧栏"
              className="w-10 h-10 rounded-[var(--r-md)] inline-flex items-center justify-center transition-colors hover:bg-[var(--rail-line)]"
              style={{ color: 'var(--rail-muted)' }}
            >
              <IconChevronRight width={16} height={16} />
            </button>
          )}
          {/* Logo 常驻慢转，职责随状态切换：
              展开态点击 = 开启极简模式（侧栏收进 Dock）；折叠态点击 = AI 入口菜单；
              连点 ≥3 次 = 加密沟通（幽灵信）的隐藏入口 */}
          <button
            onClick={onLogoClick}
            title={collapsed ? 'AI 入口：Agent · 简报 · AI 搜索订阅' : '极简模式：把侧栏收进这条 Dock（再点 Dock 底部「›」展开）'}
            aria-label={collapsed ? 'AI 入口' : '开启极简模式'}
            aria-expanded={collapsed ? aiMenu : undefined}
            className="w-10 h-10 rounded-[var(--r-md)] inline-flex items-center justify-center transition-colors hover:bg-[var(--rail-line)]"
          >
            <LogoMark size={28} spin />
          </button>
        </div>
      </nav>

      {/* 折叠态 Logo 的 AI 入口菜单 */}
      {collapsed && aiMenu && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setAiMenu(false)} aria-hidden />
          <div
            role="menu"
            aria-label="AI 入口"
            className="fixed z-50 w-[224px] rounded-[var(--r-md)] border border-[var(--border)] p-1 pop-in"
            style={{ left: 'var(--rail-w)', bottom: 12, background: 'var(--surface-strong)', boxShadow: 'var(--shadow-float)' }}
          >
            <div className="caps px-2.5 pt-1.5 pb-1" style={{ color: 'var(--faint)' }}>
              AI 入口
            </div>
            <AiMenuItem icon={navIcon('agent', 14)} label="Agent · 对话" kbd="⌘J" onSelect={() => { setAiMenu(false); goAgent('chat') }} />
            <AiMenuItem icon={navIcon('agent', 14)} label="技能库" onSelect={() => { setAiMenu(false); goAgent('skills') }} />
            <AiMenuItem icon={navIcon('agent', 14)} label="自动任务" onSelect={() => { setAiMenu(false); goAgent('auto') }} />
            <AiMenuItem icon={navIcon('agent', 14)} label="记忆与画像" onSelect={() => { setAiMenu(false); goAgent('memory') }} />
            <div className="my-1 h-px" style={{ background: 'var(--border-soft)' }} />
            <AiMenuItem icon={navIcon('brief', 14)} label="今日简报" onSelect={() => { setAiMenu(false); goView('insights') }} />
            <AiMenuItem icon={navIcon('feeds', 14)} label="AI 搜索订阅" onSelect={() => { setAiMenu(false); openFeeds({ kind: 'topics' }) }} />
          </div>
        </>
      )}
    </div>
  )
}

/** Dock 里的导航 icon：与账户头像同一节奏（半透明底托，激活加亮），角标 = 未读 */
function DockNavButton(props: { entry: DockEntry }) {
  const e = props.entry
  return (
    <button
      onClick={e.onClick}
      title={`${e.label}${e.unread ? ` · ${e.unread > 999 ? '999+' : e.unread} 未读` : ''}`}
      aria-label={e.label}
      aria-pressed={e.active}
      className="relative w-10 h-10 rounded-[var(--r-md)] inline-flex items-center justify-center transition-[background,color] hover:bg-[var(--rail-line)]"
      style={{
        background: e.active ? 'var(--rail-line)' : 'color-mix(in oklab, var(--rail-line) 40%, transparent)',
        color: e.active ? 'var(--rail-fg)' : 'var(--rail-muted)'
      }}
    >
      {e.icon}
      {!!e.unread && e.unread > 0 && (
        <span
          className="absolute -top-1 -right-1 min-w-[17px] h-[17px] px-1 rounded-full text-2xs font-bold tnum inline-flex items-center justify-center"
          style={e.muted ? { background: 'var(--rail-line)', color: 'var(--rail-fg)', boxShadow: '0 0 0 2px var(--rail-bg)' } : { background: 'var(--ai)', color: 'var(--ai-ink)', boxShadow: '0 0 0 2px var(--rail-bg)' }}
        >
          {e.unread > 99 ? '99+' : e.unread}
        </span>
      )}
    </button>
  )
}

function AiMenuItem(props: { icon: React.ReactNode; label: string; kbd?: string; onSelect(): void }) {
  return (
    <button
      role="menuitem"
      onClick={props.onSelect}
      className="w-full h-8 px-2.5 flex items-center gap-2 rounded-[var(--r-sm)] text-[13px] text-left transition-colors hover:bg-[var(--hover)]"
      style={{ color: 'var(--fg)' }}
    >
      <span className="w-4 shrink-0 inline-flex justify-center" style={{ color: 'var(--faint)' }}>{props.icon}</span>
      <span className="flex-1 truncate">{props.label}</span>
      {props.kbd && <kbd className="text-2xs" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{props.kbd}</kbd>}
    </button>
  )
}

function RailButton(props: {
  label: string
  active: boolean
  onClick(): void
  badge: number
  status?: 'connected' | 'syncing' | 'error' | 'disabled'
  style: React.CSSProperties
  children: React.ReactNode
}) {
  const dot =
    props.status === 'error' ? 'var(--danger)' : props.status === 'syncing' ? 'var(--warn)' : props.status === 'disabled' ? 'var(--rail-muted)' : props.status ? 'var(--ok)' : null
  return (
    <button
      onClick={props.onClick}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      className="relative w-10 h-10 rounded-[var(--r-md)] inline-flex items-center justify-center transition-[box-shadow,transform] active:scale-95"
      style={{
        ...props.style,
        // 选中：荧光外圈（账户栏是唯一允许荧光做选中态的地方，因为底色是深墨）
        boxShadow: props.active ? '0 0 0 2px var(--rail-bg), 0 0 0 4px var(--ai)' : undefined
      }}
    >
      {props.children}
      {props.badge > 0 && (
        <span
          className="absolute -top-1.5 -right-2 min-w-[18px] h-[18px] px-1 rounded-full text-2xs font-bold tnum inline-flex items-center justify-center"
          style={{ background: 'var(--ai)', color: 'var(--ai-ink)', boxShadow: '0 0 0 2px var(--rail-bg)' }}
        >
          {props.badge > 99 ? '99+' : props.badge}
        </span>
      )}
      {dot && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${props.status === 'syncing' ? 'animate-pulse' : ''}`}
          style={{ background: dot, boxShadow: '0 0 0 2px var(--rail-bg)' }}
        />
      )}
    </button>
  )
}
