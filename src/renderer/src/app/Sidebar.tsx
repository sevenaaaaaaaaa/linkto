import { useEffect, useMemo, useState } from 'react'
import { useMail, type Scope } from '../stores/mail'
import { api } from '../lib/api'
import { ThemeMenu } from './ThemeMenu'
import { OnboardingCard } from './Guidance'
import { SyncStatus } from './AccountIssues'
import { usePrefs } from '../lib/prefs'
import { useTodos, useTodoEvents, todayCount } from '../lib/todos'
import {
  IconInbox, IconFlag, IconTrash, IconArchive, IconSend, IconBook, IconFolder, IconCompose, IconSettings,
  IconChevronDown, IconRefresh, IconPin, IconSparkles, IconRobot, IconClock, IconShield,
  IconReplyAll, IconSave, IconClose, IconSearch, IconCheckSquare, IconAttach
} from '../components/icons'
import { useView, goView } from '../lib/route'
import type { Folder, FolderPref, SpecialFolder } from '@shared/types'
import { PinnedProjects, useProjectBadge, useProjectsRowActive } from './projects/ProjectBits'
import { IconLayers } from '../components/icons'

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
function GroupHeader(props: { label: string; open: boolean; onToggle(): void; count?: number; actions?: React.ReactNode }) {
  return (
    <div className="group mt-4 mb-0.5 h-6 flex items-center px-2">
      <button onClick={props.onToggle} className="caps flex-1 flex items-center gap-1 text-left hover:opacity-80" style={{ color: 'var(--faint)' }}>
        {props.label}
        <span className="transition-transform" style={{ transform: props.open ? 'none' : 'rotate(-90deg)', transitionDuration: 'var(--dur-2)' }}>
          <IconChevronDown width={11} height={11} />
        </span>
      </button>
      {props.actions}
      {!props.open && !!props.count && (
        <span className="text-2xs tnum" style={{ color: 'var(--muted)' }}>
          {props.count}
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
 * 侧栏（v3）：账户切换交给左侧账户栏，这里只回答「在这个账户里看什么」。
 * - 核心：收件箱（AI 分区）· 等待对方 · 稍后 · 旗标 · 置顶；待审批只在有人排队时出现
 * - 文件夹：只显示「常用」（管理面板里钉选）；选中账户时附带它的已发送 / 归档 / 废纸篓
 * - 智能：今日简报 · Agent · 知识库 · 我的视图
 */
export function Sidebar() {
  const { accounts, folders, scope, setScope, accountCtx } = useMail()
  const view = useView()
  const prefs = useFolderPrefs()
  const sb = usePrefs().sidebar
  useTodoEvents()
  const todoToday = todayCount(useTodos(st => st.todos))
  const projectBadge = useProjectBadge()
  const projectsActive = useProjectsRowActive()
  const [pendingCount, setPendingCount] = useState(0)
  const [foldersOpen, toggleFolders] = useGroupOpen('folders', true)
  const [smartOpen, toggleSmart] = useGroupOpen('smart', true)

  useEffect(() => {
    const load = () => void api.screenerPendingCount().then(setPendingCount).catch(() => {})
    load()
    const off = api.onEvent(ev => {
      if ((ev as { type: string }).type === 'messages-changed') load()
    })
    return () => void off()
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

  return (
    <div className="relative z-20 w-[var(--sidebar-w)] shrink-0 h-full flex flex-col border-r border-[var(--border)]" style={{ background: 'var(--bg)' }}>
      <div className="drag-region h-[var(--titlebar-h)] shrink-0 flex items-center gap-2 pl-5 pr-3">
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

      <div className="px-2 pb-2">
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

      <nav className="flex-1 overflow-y-auto px-2 pb-3" aria-label="邮箱导航">
        <Row icon={<IconInbox {...ico} />} label="收件箱" unread={inboxUnread} active={is('unified') || is('account')} onClick={goInbox} />
        <Row icon={<IconCheckSquare {...ico} />} label="待办" unread={todoToday} active={view === 'todo'} onClick={() => goView('todo')} />
        <Row icon={<IconLayers {...ico} />} label="项目" unread={projectBadge} active={projectsActive} onClick={() => goView('projects')} />
        <PinnedProjects Row={Row} />
        {sb.followup && <Row icon={<IconReplyAll {...ico} />} label="等待对方" active={is('followup')} onClick={() => go({ kind: 'followup', title: '等待对方回复' })} />}
        {sb.snoozed && <Row icon={<IconClock {...ico} />} label="稍后处理" active={is('snoozed')} onClick={() => go({ kind: 'snoozed', title: '稍后处理' })} />}
        {sb.flagged && <Row icon={<IconFlag {...ico} />} label="旗标" active={is('flagged')} onClick={() => go({ kind: 'flagged', title: '旗标' })} />}
        {sb.pinned && <Row icon={<IconPin {...ico} />} label="置顶" active={is('pinned')} onClick={() => go({ kind: 'pinned', title: '置顶' })} />}
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

        <GroupHeader label="智能" open={smartOpen} onToggle={toggleSmart} />
        {smartOpen && (
          <>
            {sb.brief && <Row icon={<IconSparkles {...ico} />} label="今日简报" active={view === 'insights'} onClick={() => goView('insights')} />}
            <Row
              icon={<IconRobot {...ico} />}
              label="Agent"
              active={view === 'agent'}
              onClick={() => goView('agent')}
              trailing={<kbd className="text-2xs" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>⌘J</kbd>}
            />
            {sb.kb && <Row icon={<IconBook {...ico} />} label="知识库" active={view === 'kb'} onClick={() => goView('kb')} />}
            <Row icon={<IconAttach {...ico} />} label="附件" active={view === 'attachments'} onClick={() => goView('attachments')} />
            <SmartViewsSection />
          </>
        )}

        {!accounts.length && (
          <div className="mt-4 px-2 text-xs" style={{ color: 'var(--faint)' }}>
            还没有账户。
            <button className="block mt-1.5 hover:underline" style={{ color: 'var(--accent-ink)' }} onClick={() => api.openSettings('accounts')}>
              添加第一个邮箱 →
            </button>
          </div>
        )}
      </nav>

      {sb.onboarding && <OnboardingCard />}
      <SyncFooter />

      <div className="shrink-0 h-11 border-t border-[var(--border)] px-2 flex items-center gap-0.5">
        <ThemeMenu />
        <div className="flex-1" />
        <button
          onClick={() => api.openGhost()}
          title="幽灵信 · 端到端加密阅后即焚"
          className="icon-btn w-7 h-7 inline-flex items-center justify-center"
          style={{ color: 'var(--faint)' }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="7" width="18" height="13" rx="3" />
            <path d="M3 10l9 5 9-5" />
            <path d="M8 7V5a4 4 0 0 1 8 0v2" opacity="0.55" />
          </svg>
        </button>
        <button onClick={() => api.openSettings()} title="设置（⌘,）" className="icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--faint)' }}>
          <IconSettings width={15} height={15} />
        </button>
      </div>
    </div>
  )
}

/** 同步状态：离线 / 账户出错（按类别给出重新登录 / 重试 / 查看详情）/ 同步中 / 全部已同步——实现见 AccountIssues */
function SyncFooter() {
  return <SyncStatus />
}

export type { SpecialFolder }

/** 我的视图：保存的 Smart Views，点击应用（范围+过滤+排序+聚合一体还原） */
function SmartViewsSection() {
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
      {views.map(v => (
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
