import { useEffect, useMemo, useState } from 'react'
import { useMail, type Scope } from '../stores/mail'
import { api } from '../lib/api'
import { ThemeMenu } from './ThemeMenu'
import { SyncStatus } from './AccountIssues'
import { usePrefs, getPrefs, setPrefs } from '../lib/prefs'
import { useTodos, useTodoEvents, todayCount } from '../lib/todos'
import { useFinanceBadge } from './finance/FinanceNav'
import { useLifeBadge } from './life/LifeStrip'
import { useTraceBadge } from './trace/TraceStrip'
import {
  IconFlag, IconTrash, IconArchive, IconSend, IconFolder, IconCompose, IconSettings,
  IconChevronDown, IconShield, IconSave, IconClose, IconSearch, IconList, IconGhost
} from '../components/icons'
import { useView, goView } from '../lib/route'
import type { Folder, FolderPref, SpecialFolder } from '@shared/types'
import { PinnedProjects, useProjectBadge, useProjectsRowActive } from './projects/ProjectBits'
import { AgentNavSection } from './agent/AgentNav'
import { FeedNavSection } from './feeds/FeedNav'
import { useOverdueCount } from '../lib/followups'
import { useFeedEvents, useFeeds, unreadOf } from '../lib/feeds'
import { OrganizeStatus } from './agent/AutomationPanel'
import { computeNavLayout, moreBadge, usagePins, type Badge, type NavId } from '../lib/sidebar-layout'
import { navIcon } from './upgrade/nav-meta'
import { SidebarEditor } from './upgrade/SidebarEditor'

/**
 * 侧边栏行组件与分组（v3 结构见 Sidebar）
 * - 分类过滤（个人 / 通知 / 订阅 / 噪声）不再占侧栏，改由列表头「筛选」与 ⌘K 承接（审计 IA-2 / IA-4）
 * - 激活态只由「当前视图 + scope」单一来源计算，杜绝双激活（审计 IA-1）
 * - L1 玻璃材质；行高 28px（--row-side-h）；选中 = --selected 底 + accent-ink 文字
 */
function Row(props: {
  icon?: React.ReactNode
  label: string
  unread?: number
  muteCount?: boolean
  active?: boolean
  indent?: number
  onClick(): void
  color?: string
  trailing?: React.ReactNode
}) {
  return (
    <button
      onClick={props.onClick}
      aria-current={props.active ? 'page' : undefined}
      className={`group relative w-full h-[var(--row-side-h)] flex items-center gap-2 px-2 rounded-[var(--r-sm)] text-sm transition-colors ${
        props.active ? 'font-medium' : 'hover:bg-[var(--hover)]'
      }`}
      style={{
        paddingLeft: props.indent ? 8 + props.indent * 18 : undefined,
        background: props.active ? 'var(--selected)' : undefined,
        color: props.active ? 'var(--accent-ink)' : 'var(--fg)'
      }}
    >
      <span className="w-4 shrink-0 inline-flex justify-center" style={{ color: props.active ? 'var(--accent)' : 'var(--faint)' }}>
        {props.color ? <span className="inline-block w-2 h-2 rounded-full" style={{ background: props.color }} /> : props.icon}
      </span>
      <span className="flex-1 text-left truncate">{props.label}</span>
      {props.trailing}
      {!!props.unread && props.unread > 0 && (
        <span
          className="text-2xs tnum shrink-0"
          style={{ color: props.active ? 'var(--accent-ink)' : props.muteCount ? 'var(--faint)' : 'var(--muted)', fontWeight: props.muteCount ? 400 : 500 }}
        >
          {props.unread > 999 ? '999+' : props.unread}
        </span>
      )}
    </button>
  )
}

/** 可折叠分组标题（mono 大写 · 11px） */
function GroupHeader(props: { label: string; open: boolean; onToggle(): void; count?: number; countMuted?: boolean; dot?: boolean; actions?: React.ReactNode }) {
  return (
    <div className="group mt-4 mb-0.5 h-6 flex items-center px-2">
      <button onClick={props.onToggle} className="caps flex-1 flex items-center gap-1 text-left hover:opacity-80" style={{ color: 'var(--faint)' }}>
        {props.label}
        <span className="transition-transform" style={{ transform: props.open ? 'none' : 'rotate(-90deg)', transitionDuration: 'var(--dur-2)' }}>
          <IconChevronDown width={11} height={11} />
        </span>
      </button>
      {props.actions}
      {!props.open && props.dot && <span className="w-1.5 h-1.5 rounded-full ml-1" style={{ background: 'var(--accent)' }} aria-label="当前页面在这里" />}
      {!props.open && !!props.count && (
        <span className="text-2xs tnum ml-1.5" style={{ color: props.countMuted ? 'var(--faint)' : 'var(--muted)', fontWeight: props.countMuted ? 400 : 500 }}>
          {props.count > 999 ? '999+' : props.count}
        </span>
      )}
    </div>
  )
}

/** 分组开合状态（按用户习惯持久化） */
function useGroupOpen(key: string, initial: boolean): [boolean, () => void] {
  const storageKey = `ms_side_${key}`
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(storageKey)
      return v === null ? initial : v === '1'
    } catch {
      return initial
    }
  })
  return [
    open,
    () =>
      setOpen(o => {
        try {
          localStorage.setItem(storageKey, o ? '0' : '1')
        } catch {
          /* 存储不可用时仅本次生效 */
        }
        return !o
      })
  ]
}

const SPECIAL_LABEL: Record<string, string> = {
  inbox: '收件箱',
  sent: '已发送',
  drafts: '草稿',
  trash: '废纸篓',
  junk: '垃圾邮件',
  archive: '归档',
  all: '所有邮件'
}

/** 文件夹偏好（常用 / 同步），由「管理文件夹」面板修改 */
export function useFolderPrefs(): Record<string, FolderPref> {
  const [prefs, setPrefs] = useState<Record<string, FolderPref>>({})
  useEffect(() => {
    const load = () => void api.getFolderPrefs().then(setPrefs).catch(() => {})
    load()
    window.addEventListener('ms:folder-prefs', load)
    return () => window.removeEventListener('ms:folder-prefs', load)
  }, [])
  return prefs
}

export const folderLabel = (f: Folder) => (f.special ? SPECIAL_LABEL[f.special] ?? f.name : f.path.replace(/^Folders\//, '').replace(/[/.]/g, ' / '))

function folderIcon(f: Folder, color?: string) {
  const p = { width: 14, height: 14, style: color ? { color } : undefined }
  switch (f.special) {
    case 'sent':
      return <IconSend {...p} />
    case 'drafts':
      return <IconCompose {...p} />
    case 'archive':
      return <IconArchive {...p} />
    case 'trash':
      return <IconTrash {...p} />
    case 'junk':
      return <IconShield {...p} />
    default:
      return <IconFolder {...p} />
  }
}

/**
 * 侧栏（v4 · 可自定义）：账户切换交给左侧账户栏，这里只回答「在这个账户里看什么」。
 * - 每个入口「钉在侧栏 / 收进更多 / 隐藏」+ 排序，见 lib/sidebar-layout（纯函数）与 upgrade/SidebarEditor
 * - 默认（克制）：核心 收件箱 · 待办 · 等待对方 · 项目；智能 今日简报 · Agent · 财务；其余在「更多」里
 * - 升级用户已经在用（有数据）的入口默认钉住；「更多」收起时把里面入口的角标汇总到「更多」上
 * - 导航可滚动区与底部状态区（整理进度 / 离线 / 账户出错）分开布局，小窗口下导航仍可滚动、不被遮挡
 */
export function Sidebar() {
  const { accounts, folders, scope, setScope, accountCtx } = useMail()
  const view = useView()
  const prefs = useFolderPrefs()
  const ui = usePrefs()
  const layout = useMemo(() => computeNavLayout(ui.nav, ui.sidebar), [ui.nav, ui.sidebar])
  useAutoPinSeed(ui.nav.autoPinned === null)
  useTodoEvents()
  const todoToday = todayCount(useTodos(st => st.todos))
  const projectBadge = useProjectBadge()
  const projectsActive = useProjectsRowActive()
  const followupOverdue = useOverdueCount()
  const financeBadge = useFinanceBadge()
  const lifeBadge = useLifeBadge()
  const traceBadge = useTraceBadge()
  useFeedEvents()
  const feedUnread = unreadOf(useFeeds(st => st.sources))
  const [pendingCount, setPendingCount] = useState(0)
  const [foldersOpen, toggleFolders] = useGroupOpen('folders', true)
  const [smartOpen, toggleSmart] = useGroupOpen('smart', true)
  const [moreOpen, toggleMore] = useGroupOpen('more', false)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    const load = () => void api.screenerPendingCount().then(setPendingCount).catch(() => {})
    load()
    const off = api.onEvent(ev => {
      if ((ev as { type: string }).type === 'messages-changed') load()
    })
    return () => void off()
  }, [])

  // ⌘K「编辑侧栏」/ 升级向导里的入口
  useEffect(() => {
    const on = () => setEditing(true)
    window.addEventListener(EDIT_SIDEBAR_EVENT, on)
    return () => window.removeEventListener(EDIT_SIDEBAR_EVENT, on)
  }, [])

  const ctxAccount = accountCtx ? accounts.find(a => a.id === accountCtx) ?? null : null
  const inScope = (f: Folder) => !accountCtx || f.accountId === accountCtx
  const inboxUnread = useMemo(
    () => folders.filter(f => f.special === 'inbox' && inScope(f)).reduce((s, f) => s + f.unread, 0),
    [folders, accountCtx]
  )
  const colorOf = (accountId: string) => accounts.find(a => a.id === accountId)?.color
  const pinned = folders.filter(f => inScope(f) && !f.hidden && prefs[f.id]?.pinned)
  const standard = ctxAccount
    ? folders.filter(f => f.accountId === ctxAccount.id && ['sent', 'archive', 'junk', 'trash'].includes(f.special ?? '') && !prefs[f.id]?.pinned)
    : []

  /** 邮件视图下的激活判断（非邮件视图时一律不激活） */
  const is = (k: Scope['kind']) => view === 'mail' && scope.kind === k
  const go = (next: Scope) => {
    goView('mail')
    setScope(next)
  }
  const goInbox = () =>
    go(ctxAccount ? { kind: 'account', accountId: ctxAccount.id, title: ctxAccount.name } : { kind: 'unified', title: '收件箱' })
  const ico = { width: 15, height: 15 }

  /** 各入口角标（muted = 只是未读量这类弱提示） */
  const badges: Partial<Record<NavId, Badge>> = {
    todo: { count: todoToday },
    followup: { count: followupOverdue },
    projects: { count: projectBadge },
    finance: { count: financeBadge, muted: true },
    feeds: { count: feedUnread, muted: true },
    life: { count: lifeBadge, muted: true },
    trace: { count: traceBadge }
  }
  // 财务 / 生活档案的角标在侧栏里是弱色（muteCount），但汇总到「更多」时算提醒（到期 / 逾期）
  const moreSum = moreBadge(layout.more, { ...badges, finance: { count: financeBadge }, life: { count: lifeBadge } })

  const entry = (id: NavId): React.ReactNode => {
    switch (id) {
      case 'inbox':
        return <Row key={id} icon={navIcon(id)} label="收件箱" unread={inboxUnread} active={is('unified') || is('account')} onClick={goInbox} />
      case 'todo':
        return <Row key={id} icon={navIcon(id)} label="待办" unread={todoToday} active={view === 'todo'} onClick={() => goView('todo')} />
      case 'followup':
        return <Row key={id} icon={navIcon(id)} label="等待对方" unread={followupOverdue} active={is('followup')} onClick={() => go({ kind: 'followup', title: '等待对方回复' })} />
      case 'projects':
        return (
          <div key={id}>
            <Row icon={navIcon(id)} label="项目" unread={projectBadge} active={projectsActive} onClick={() => goView('projects')} />
            <PinnedProjects Row={Row} />
          </div>
        )
      case 'brief':
        return <Row key={id} icon={navIcon(id)} label="今日简报" active={view === 'insights'} onClick={() => goView('insights')} />
      case 'agent':
        return <AgentNavSection key={id} Row={Row} ico={ico} />
      case 'finance':
        return <Row key={id} icon={navIcon(id)} label="财务" unread={financeBadge} muteCount active={view === 'finance'} onClick={() => goView('finance')} />
      case 'feeds':
        return <FeedNavSection key={id} Row={Row} ico={ico} />
      case 'life':
        return <Row key={id} icon={navIcon(id)} label="生活档案" unread={lifeBadge} muteCount active={view === 'life'} onClick={() => goView('life')} />
      case 'trace':
        return <Row key={id} icon={navIcon(id)} label="留痕" unread={traceBadge} active={view === 'trace'} onClick={() => goView('trace')} />
      case 'kb':
        return <Row key={id} icon={navIcon(id)} label="知识库" active={view === 'kb'} onClick={() => goView('kb')} />
      case 'attachments':
        return <Row key={id} icon={navIcon(id)} label="附件" active={view === 'attachments'} onClick={() => goView('attachments')} />
      case 'snoozed':
        return <Row key={id} icon={navIcon(id)} label="稍后处理" active={is('snoozed')} onClick={() => go({ kind: 'snoozed', title: '稍后处理' })} />
      case 'flagged':
        return <Row key={id} icon={navIcon(id)} label="旗标" active={is('flagged')} onClick={() => go({ kind: 'flagged', title: '旗标' })} />
      case 'pinned':
        return <Row key={id} icon={navIcon(id)} label="置顶" active={is('pinned')} onClick={() => go({ kind: 'pinned', title: '置顶' })} />
    }
  }

  // 「更多」收起时，当前所在页面如果在「更多」里，也给「更多」一个激活提示
  const moreHasActive = layout.more.some(id => isEntryActive(id, view, scope.kind))

  return (
    <div className="relative z-20 w-[var(--sidebar-w)] shrink-0 h-full flex flex-col border-r border-[var(--border)]" style={{ background: 'var(--native-sidebar-bg, var(--bg))' }}>
      <div className="drag-region native-web-titlebar h-[var(--titlebar-h)] shrink-0 flex items-center gap-2 pl-5 pr-3">
        <div className="flex-1 min-w-0 flex flex-col leading-tight">
          <span className="text-sm font-semibold truncate" style={{ color: 'var(--fg)' }}>{ctxAccount ? ctxAccount.name : '全部账户'}</span>
          <span className="text-2xs truncate" style={{ color: 'var(--faint)' }}>{ctxAccount ? ctxAccount.email : `${accounts.length} 个邮箱`}</span>
        </div>
        <button
          onClick={() => api.openCompose(ctxAccount ? ({ accountId: ctxAccount.id } as never) : undefined)}
          title="写邮件（⌘N）"
          aria-label="写邮件"
          className="no-drag h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-[var(--r-sm)] transition-transform active:scale-95"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
        >
          <IconCompose width={15} height={15} />
        </button>
      </div>

      <div className="px-2 pb-2 shrink-0">
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('ms:toggle-palette'))}
          title="命令面板：执行命令、跳转视图，或把文字交给邮件搜索 / Agent（⌘K）；只搜邮件用列表上方的搜索框（⌘F）"
          className="w-full h-8 px-2.5 flex items-center gap-2 rounded-[var(--r-sm)] text-sm border border-[var(--border)] hover:border-[var(--border-strong)] transition-colors"
          style={{ background: 'var(--surface-strong)', color: 'var(--faint)' }}
        >
          <IconSearch width={14} height={14} />
          <span className="flex-1 text-left">命令、跳转与提问</span>
          <kbd className="text-2xs" style={{ fontFamily: 'var(--font-mono)' }}>⌘K</kbd>
        </button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto px-2 pb-3" aria-label="邮箱导航">
        {layout.core.map(entry)}
        {pendingCount > 0 && (
          <Row icon={<IconShield {...ico} />} label="待审批发件人" unread={pendingCount} active={is('screener')} onClick={() => go({ kind: 'screener', title: '待审批发件人' })} />
        )}

        <GroupHeader
          label="文件夹"
          open={foldersOpen}
          onToggle={toggleFolders}
          actions={
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('ms:folders'))}
              className="text-2xs px-1.5 h-5 rounded-[var(--r-xs)] hover:bg-[var(--hover)]"
              style={{ color: 'var(--muted)' }}
            >
              管理
            </button>
          }
        />
        {foldersOpen && (
          <>
            {pinned.map(f => (
              <Row
                key={f.id}
                icon={folderIcon(f, colorOf(f.accountId))}
                label={folderLabel(f)}
                unread={f.special === null ? f.unread : 0}
                muteCount
                active={view === 'mail' && scope.kind === 'folder' && scope.folderId === f.id}
                onClick={() => go({ kind: 'folder', folderId: f.id, title: folderLabel(f) })}
              />
            ))}
            {standard.map(f => (
              <Row
                key={f.id}
                icon={folderIcon(f)}
                label={folderLabel(f)}
                active={view === 'mail' && scope.kind === 'folder' && scope.folderId === f.id}
                onClick={() => go({ kind: 'folder', folderId: f.id, title: `${ctxAccount?.name ?? ''} · ${folderLabel(f)}` })}
              />
            ))}
            {!pinned.length && !standard.length && (
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('ms:folders'))}
                className="w-full text-left px-2 py-1.5 text-xs leading-relaxed rounded-[var(--r-sm)] hover:bg-[var(--hover)]"
                style={{ color: 'var(--faint)' }}
              >
                把常用的文件夹钉到这里 →
              </button>
            )}
          </>
        )}

        {layout.smart.length > 0 && (
          <>
            <GroupHeader label="智能" open={smartOpen} onToggle={toggleSmart} />
            {smartOpen && layout.smart.map(entry)}
          </>
        )}

        {/* 私密通信：幽灵信（独立窗口，不占导航布局） */}
        <div className="mt-1.5">
          <Row
            icon={<IconGhost width={15} height={15} />}
            label="幽灵信"
            trailing={
              <span className="text-2xs px-1.5 py-0.5 rounded-[var(--r-xs)]" style={{ background: 'var(--accent-soft)', color: 'var(--accent-ink)' }}>
                端到端
              </span>
            }
            onClick={() => api.openGhost()}
          />
        </div>

        {layout.more.length > 0 && (
          <>
            <GroupHeader
              label="更多"
              open={moreOpen}
              onToggle={toggleMore}
              count={moreSum?.count}
              countMuted={moreSum?.muted}
              dot={!moreOpen && moreHasActive}
              actions={
                <button
                  onClick={() => setEditing(true)}
                  className="text-2xs px-1.5 h-5 rounded-[var(--r-xs)] hover:bg-[var(--hover)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                  style={{ color: 'var(--muted)' }}
                >
                  编辑
                </button>
              }
            />
            {moreOpen && layout.more.map(entry)}
          </>
        )}

        <SmartViewsSection />

        {!accounts.length && (
          <div className="mt-4 px-2 text-xs" style={{ color: 'var(--faint)' }}>
            还没有账户。
            <button className="block mt-1.5 hover:underline" style={{ color: 'var(--accent-ink)' }} onClick={() => api.openSettings('accounts')}>
              添加第一个邮箱 →
            </button>
            <button className="block mt-1 hover:underline" style={{ color: 'var(--muted)' }} onClick={() => api.openSettings('backup:pair')}>
              从另一台电脑快速开始 →
            </button>
          </div>
        )}
      </nav>

      {/* 底部状态区：整理进度（点开浮在侧栏上方）+ 离线 / 账户出错；限高可滚动，不挤占导航 */}
      <div className="shrink-0 pt-1.5 border-t border-[var(--border-soft)]">
        <OrganizeStatus />
        <div className="max-h-[32vh] overflow-y-auto">
          <SyncFooter />
        </div>
      </div>

      <div className="relative shrink-0 h-11 border-t border-[var(--border)] px-2 flex items-center gap-0.5">
        <ThemeMenu />
        <div className="flex-1" />
        <button
          onClick={() => setEditing(e => !e)}
          title="编辑侧栏：钉住、收进更多、隐藏与排序"
          aria-label="编辑侧栏"
          aria-expanded={editing}
          className="icon-btn w-7 h-7 inline-flex items-center justify-center"
          style={{ color: editing ? 'var(--accent-ink)' : 'var(--faint)' }}
        >
          <IconList width={15} height={15} />
        </button>
        <button
          onClick={() => api.openGhost()}
          title="幽灵信 · 端到端加密阅后即焚"
          className="icon-btn w-7 h-7 inline-flex items-center justify-center"
          style={{ color: 'var(--faint)' }}
        >
          <IconGhost width={15} height={15} />
        </button>
        <button onClick={() => api.openSettings()} title="设置（⌘,）" className="icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--faint)' }}>
          <IconSettings width={15} height={15} />
        </button>
        {editing && <SidebarEditPopover onClose={() => setEditing(false)} />}
      </div>
    </div>
  )
}

/** ⌘K「编辑侧栏…」等入口打开侧栏编辑浮层 */
export const EDIT_SIDEBAR_EVENT = 'ms:edit-sidebar'
export function openSidebarEditor() {
  window.dispatchEvent(new CustomEvent(EDIT_SIDEBAR_EVENT))
}

/** 当前页面是否就是这个入口（「更多」收起时给「更多」一个激活点） */
function isEntryActive(id: NavId, view: string, scopeKind: Scope['kind']): boolean {
  const mail = (k: Scope['kind']) => view === 'mail' && scopeKind === k
  switch (id) {
    case 'feeds':
    case 'life':
    case 'trace':
    case 'kb':
    case 'attachments':
    case 'finance':
    case 'todo':
    case 'projects':
    case 'agent':
      return view === id
    case 'brief':
      return view === 'insights'
    case 'snoozed':
    case 'flagged':
    case 'pinned':
    case 'followup':
      return mail(id)
    default:
      return false
  }
}

/** 升级 / 首次启动时算一次「已经在用」的入口（有数据就默认钉住），之后不随数据变化 */
function useAutoPinSeed(needed: boolean) {
  useEffect(() => {
    if (!needed) return
    let alive = true
    void api
      .sidebarUsage()
      .then(u => {
        if (!alive || getPrefs().nav.autoPinned !== null) return
        setPrefs({ nav: { ...getPrefs().nav, autoPinned: usagePins(u) } })
      })
      .catch(() => {
        // 统计失败：按默认方案，不再重试
        if (alive && getPrefs().nav.autoPinned === null) setPrefs({ nav: { ...getPrefs().nav, autoPinned: [] } })
      })
    return () => {
      alive = false
    }
  }, [needed])
}

/** 编辑侧栏浮层：锚在侧栏底部按钮上方；Esc / 点外面关闭 */
function SidebarEditPopover(props: { onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [props.onClose])
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={props.onClose} aria-hidden />
      <div
        role="dialog"
        aria-label="编辑侧栏"
        className="absolute left-2 bottom-full mb-1.5 z-50 w-[420px] max-w-[calc(100vw-80px)] max-h-[min(640px,calc(100vh-80px))] overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border)] px-3.5 pt-3 pb-3 pop-in"
        style={{ background: 'var(--surface-strong)', boxShadow: 'var(--shadow-float)' }}
      >
        <div className="flex items-center gap-2 mb-2.5 px-1">
          <span className="text-sm font-semibold flex-1" style={{ color: 'var(--fg)' }}>
            编辑侧栏
          </span>
          <button onClick={props.onClose} aria-label="关闭" className="w-6 h-6 grid place-items-center rounded-[var(--r-xs)] hover:bg-[var(--hover)]" style={{ color: 'var(--faint)' }}>
            <IconClose width={12} height={12} />
          </button>
        </div>
        <SidebarEditor />
      </div>
    </>
  )
}

/** 同步状态：离线 / 账户出错（按类别给出重新登录 / 重试 / 查看详情）/ 同步中 / 全部已同步——实现见 AccountIssues */
function SyncFooter() {
  return <SyncStatus />
}

export type { SpecialFolder }

/** 我的视图：保存的 Smart Views，点击应用（范围+过滤+排序+聚合一体还原） */
function SmartViewsSection() {
  const [open, toggle] = useGroupOpen('views', true)
  const [views, setViews] = useState<{ id: string; name: string; view: Record<string, unknown> }[]>([])

  useEffect(() => {
    const load = () => void api.listSmartViews().then(v => setViews(v as never)).catch(() => {})
    load()
    window.addEventListener('ms:views-changed', load)
    return () => window.removeEventListener('ms:views-changed', load)
  }, [])

  if (!views.length) return null

  const apply = (v: { id: string; name: string; view: Record<string, unknown> }) => {
    const view = v.view as {
      scope?: { kind: string; title: string; folderId?: string; accountId?: string; category?: string }
      filter?: string
      sort?: string
      gravity?: number
      groupThreads?: boolean
    }
    if (!view.scope) return
    goView('mail')
    useMail.getState().setScope(view.scope as never)
    if (view.sort) useMail.getState().setSort(view.sort as never)
    if (view.groupThreads !== undefined) useMail.getState().setGroupThreads(view.groupThreads)
    localStorage.setItem('ms_gravity', String(view.gravity ?? 0))
    localStorage.setItem('ms_filter', view.filter ?? 'all')
    // filter / gravity 由 MessageList 挂载时读取（localStorage 已更新）
    window.dispatchEvent(new CustomEvent('ms:apply-view', { detail: { filter: view.filter, gravity: view.gravity ?? 0 } }))
    window.dispatchEvent(new CustomEvent('ms:toast', { detail: `已应用视图「${v.name}」` }))
  }

  return (
    <div>
      <GroupHeader label="我的视图" open={open} onToggle={toggle} count={views.length} countMuted />
      {open && views.map(v => (
        <div key={v.id} className="relative group">
          <Row
            icon={<IconSave width={13} height={13} />}
            label={v.name}
            active={false}
            onClick={() => apply(v)}
          />
          <button
            onClick={async () => {
              await api.deleteSmartView(v.id)
              window.dispatchEvent(new CustomEvent('ms:views-changed'))
            }}
            title="删除视图"
            className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:block p-1 rounded-sm hover:bg-[var(--hover)]"
            style={{ color: 'var(--faint)' }}
          >
            <IconClose width={11} height={11} />
          </button>
        </div>
      ))}
    </div>
  )
}
