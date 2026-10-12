import { useEffect, useMemo, useState } from 'react'
import { useMail, type Scope } from '../stores/mail'
import { api } from '../lib/api'
import { ThemeMenu } from './ThemeMenu'
import {
  IconInbox, IconFlag, IconTrash, IconArchive, IconSend, IconBook, IconFolder, IconCompose, IconSettings,
  IconChevronDown, IconChevronRight, IconRefresh, IconPin, IconSparkles, IconRobot, IconClock, IconShield,
  IconReplyAll, IconSave, IconClose
} from '../components/icons'
import { useView, goView } from '../lib/route'
import type { Folder, SpecialFolder } from '@shared/types'

/**
 * 侧边栏 —— Phase B 信息架构：核心 / 队列 / 智能 / 账户 四区
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

function AccountRow(props: {
  acc: { id: string; name: string; color: string; status: string; statusText: string }
  folders: Folder[]
  activeFolderId?: string
  onPick(f: Folder, title: string): void
}) {
  const [open, toggle] = useGroupOpen(`acc_${props.acc.id}`, false)
  const inbox = props.folders.find(f => f.special === 'inbox')
  const others = props.folders.filter(f => f !== inbox)
  const unread = props.folders.filter(f => f.special === 'inbox').reduce((s, f) => s + f.unread, 0)
  const status = props.acc.status
  return (
    <div>
      <Row
        color={props.acc.color}
        label={props.acc.name}
        unread={unread}
        active={!!inbox && props.activeFolderId === inbox.id}
        onClick={() => inbox && props.onPick(inbox, `${props.acc.name} · 收件箱`)}
        trailing={
          <>
            {status === 'syncing' && <IconRefresh width={11} height={11} className="spinning shrink-0" style={{ color: 'var(--faint)' }} />}
            {status === 'error' && <span title={props.acc.statusText} className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: 'var(--danger)' }} />}
            <span
              role="button"
              title={open ? '收起文件夹' : '展开文件夹'}
              onClick={e => {
                e.stopPropagation()
                toggle()
              }}
              className="w-5 h-5 -mr-1 shrink-0 inline-flex items-center justify-center rounded-[var(--r-xs)] opacity-0 group-hover:opacity-100 hover:bg-[var(--hover-strong)]"
              style={{ color: 'var(--muted)', opacity: open ? 1 : undefined }}
            >
              {open ? <IconChevronDown width={11} height={11} /> : <IconChevronRight width={11} height={11} />}
            </span>
          </>
        }
      />
      {open &&
        others.map(f => (
          <Row
            key={f.id}
            indent={1}
            icon={folderIcon(f)}
            label={SPECIAL_LABEL[f.special ?? ''] ?? f.name}
            unread={f.special === null ? f.unread : 0}
            muteCount
            active={props.activeFolderId === f.id}
            onClick={() => props.onPick(f, `${props.acc.name} · ${SPECIAL_LABEL[f.special ?? ''] ?? f.name}`)}
          />
        ))}
      {open && !props.folders.length && (
        <div className="pl-[34px] pr-2 h-6 flex items-center text-xs" style={{ color: 'var(--faint)' }}>
          {status === 'error' ? props.acc.statusText || '连接失败' : status === 'connected' ? '暂无文件夹' : '同步中…'}
        </div>
      )}
    </div>
  )
}

function folderIcon(f: Folder) {
  const p = { width: 14, height: 14 }
  switch (f.special) {
    case 'sent':
      return <IconSend {...p} />
    case 'drafts':
      return <IconCompose {...p} />
    case 'archive':
      return <IconArchive {...p} />
    case 'trash':
      return <IconTrash {...p} />
    default:
      return <IconFolder {...p} />
  }
}

export function Sidebar() {
  const { accounts, folders, scope, setScope } = useMail()
  const view = useView()
  const [pendingCount, setPendingCount] = useState(0)
  const [queueOpen, toggleQueue] = useGroupOpen('queue', true)
  const [smartOpen, toggleSmart] = useGroupOpen('smart', true)
  const [accOpen, toggleAcc] = useGroupOpen('accounts', true)

  useEffect(() => {
    const load = () => void api.screenerPendingCount().then(setPendingCount).catch(() => {})
    load()
    const off = api.onEvent(ev => {
      if ((ev as { type: string }).type === 'messages-changed') load()
    })
    return () => void off()
  }, [])

  const totalUnread = useMemo(() => folders.filter(f => f.special === 'inbox').reduce((s, f) => s + f.unread, 0), [folders])

  /** 邮件视图下的激活判断（非邮件视图时一律不激活） */
  const is = (k: Scope['kind']) => view === 'mail' && scope.kind === k
  const go = (next: Scope) => {
    goView('mail')
    setScope(next)
  }
  const ico = { width: 15, height: 15 }

  return (
    <div className="glass relative z-20 w-[var(--sidebar-w)] shrink-0 h-full flex flex-col border-r border-[var(--border-soft)]">
      {/* 标题栏（红绿灯区）52px：写邮件按钮与列表搜索、阅读工具栏同一基线 */}
      <div className="drag-region h-[var(--titlebar-h)] shrink-0 flex items-center justify-end pl-[76px] pr-2">
        <button
          onClick={() => api.openCompose()}
          title="写邮件（⌘N）"
          className="no-drag btn-liquid h-7 px-2.5 inline-flex items-center gap-1.5 rounded-[var(--r-sm)] text-xs font-semibold"
        >
          <IconCompose width={13} height={13} /> 写邮件
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-3" aria-label="邮箱导航">
        <Row icon={<IconInbox {...ico} />} label="统一收件箱" unread={totalUnread} active={is('unified')} onClick={() => go({ kind: 'unified', title: '统一收件箱' })} />
        <Row icon={<IconFlag {...ico} />} label="旗标" active={is('flagged')} onClick={() => go({ kind: 'flagged', title: '旗标' })} />
        <Row icon={<IconPin {...ico} />} label="置顶" active={is('pinned')} onClick={() => go({ kind: 'pinned', title: '置顶' })} />

        <GroupHeader label="队列" open={queueOpen} onToggle={toggleQueue} count={pendingCount} />
        {queueOpen && (
          <>
            <Row icon={<IconClock {...ico} />} label="稍后处理" active={is('snoozed')} onClick={() => go({ kind: 'snoozed', title: '稍后处理' })} />
            <Row icon={<IconShield {...ico} />} label="待审批" unread={pendingCount} active={is('screener')} onClick={() => go({ kind: 'screener', title: '待审批发件人' })} />
            <Row icon={<IconReplyAll {...ico} />} label="待跟进" active={is('followup')} onClick={() => go({ kind: 'followup', title: '待跟进（我发未回）' })} />
          </>
        )}

        <GroupHeader label="智能" open={smartOpen} onToggle={toggleSmart} />
        {smartOpen && (
          <>
            <Row icon={<IconSparkles {...ico} />} label="洞察" active={view === 'insights'} onClick={() => goView('insights')} />
            <Row icon={<IconBook {...ico} />} label="知识库" active={view === 'kb'} onClick={() => goView('kb')} />
            <Row icon={<IconRobot {...ico} />} label="Agent" active={view === 'agent'} onClick={() => goView('agent')} />
            <SmartViewsSection />
          </>
        )}

        <GroupHeader
          label="账户"
          open={accOpen}
          onToggle={toggleAcc}
          actions={
            <span className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity mr-1">
              <button onClick={() => accounts.forEach(a => void api.syncAccountNow(a.id))} title="立即同步全部账户" className="icon-btn w-5 h-5 inline-flex items-center justify-center" style={{ color: 'var(--faint)' }}>
                <IconRefresh width={11} height={11} />
              </button>
              <button onClick={() => api.openSettings('accounts')} title="账户设置" className="icon-btn w-5 h-5 inline-flex items-center justify-center" style={{ color: 'var(--faint)' }}>
                <IconSettings width={11} height={11} />
              </button>
            </span>
          }
        />
        {accOpen &&
          accounts.map(acc => (
            <AccountRow
              key={acc.id}
              acc={acc}
              folders={folders.filter(f => f.accountId === acc.id && !f.hidden)}
              activeFolderId={view === 'mail' && scope.kind === 'folder' ? scope.folderId : undefined}
              onPick={(f, title) => go({ kind: 'folder', folderId: f.id, title })}
            />
          ))}

        {!accounts.length && (
          <div className="mt-2 px-2 text-xs" style={{ color: 'var(--faint)' }}>
            还没有账户。
            <button className="block mt-1.5 hover:underline" style={{ color: 'var(--accent-ink)' }} onClick={() => api.openSettings('accounts')}>
              添加第一个邮箱 →
            </button>
          </div>
        )}
      </nav>

      <div className="shrink-0 h-11 border-t border-[var(--border-soft)] px-2 flex items-center gap-0.5">
        <ThemeMenu />
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('ms:toggle-palette'))}
          title="命令面板（⌘K）—— 所有视图与次级操作都在这里"
          className="icon-btn h-7 px-2 text-2xs font-medium"
          style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}
        >
          ⌘K
        </button>
        <div className="flex-1" />
        <button onClick={() => api.openSettings()} title="设置（⌘,）" className="icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--faint)' }}>
          <IconSettings width={15} height={15} />
        </button>
      </div>
    </div>
  )
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
