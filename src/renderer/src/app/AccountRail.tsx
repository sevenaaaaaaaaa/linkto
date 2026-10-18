import { useMail } from '../stores/mail'
import { api } from '../lib/api'
import { IconLayers, IconPlus } from '../components/icons'
import { accountHoverText } from './AccountIssues'

/** 品牌标「年轮 @」：@ = 邮件，两圈年轮 = Agent 记忆，荧光内核 = AI，向右的尾线 = To */
export function LogoMark(props: { size?: number; tile?: boolean }) {
  const s = props.size ?? 28
  return (
    <svg width={s} height={s} viewBox="0 0 120 120" role="img" aria-label="LinkTo">
      {props.tile && <rect x="2" y="2" width="116" height="116" rx="28" fill="var(--rail-bg)" />}
      <path d="M101.4 52.7 A42 42 0 1 0 60 102 L94 102" fill="none" stroke="var(--rail-fg)" strokeWidth="10" strokeLinecap="round" />
      <path d="M81.8 70.1 A24 24 0 1 1 81.8 49.9" fill="none" stroke="var(--rail-fg)" strokeWidth="10" strokeLinecap="round" />
      <circle cx="60" cy="60" r="10" fill="var(--ai)" />
    </svg>
  )
}

/** 账户名的单字标识：中文取首字，英文取首字母 */
const initialOf = (name: string) => ([...name.trim()][0] ?? '?').toUpperCase()

/**
 * 账户栏：最左侧深墨竖条，像切换工作区一样切换账户。
 * 每个账户一个颜色，贯穿账户栏 · 列表行左侧色条 · 阅读页「收于」标签 · 文件夹图标；
 * 角标 = 收件箱未读，右下圆点 = 同步状态（绿已同步 / 转圈同步中 / 红出错）。
 */
export function AccountRail() {
  const { accounts, folders, accountCtx, setAccountCtx } = useMail()
  const unreadOf = (id: string) => folders.filter(f => f.accountId === id && f.special === 'inbox').reduce((s, f) => s + f.unread, 0)
  const totalUnread = folders.filter(f => f.special === 'inbox').reduce((s, f) => s + f.unread, 0)

  return (
    /* 外层与侧栏同底色：顶部 52px 是和侧栏连成一体的标题带，红绿灯落在这里（不再受深色栏宽度约束）；
       深色账户栏从标题带下方开始，四周留边做成圆角柱 */
    <div className="w-[var(--rail-w)] shrink-0 h-full flex flex-col" style={{ background: 'var(--bg)' }}>
      <div className="drag-region h-[var(--titlebar-h)] w-full shrink-0" />
    <nav
      aria-label="账户"
      className="flex-1 min-h-0 mx-2 mb-2 rounded-[var(--r-lg)] flex flex-col items-center"
      style={{ background: 'var(--rail-bg)', color: 'var(--rail-fg)' }}
    >
      <div className="flex flex-col items-center gap-2.5 pt-3">
        <RailButton
          label={`全部账户 · ${totalUnread} 封未读`}
          active={accountCtx === null}
          onClick={() => setAccountCtx(null)}
          badge={0}
          style={{ background: 'var(--rail-line)' }}
        >
          <IconLayers width={18} height={18} />
        </RailButton>
        <div className="w-6 h-px my-0.5" style={{ background: 'var(--rail-line)' }} />
        {accounts.map((a, i) => (
          <RailButton
            key={a.id}
            label={accountHoverText(a, i < 9 ? `⌘${i + 1}` : undefined)}
            active={accountCtx === a.id}
            onClick={() => setAccountCtx(a.id)}
            badge={unreadOf(a.id)}
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
      </div>
      <div className="flex-1" />
      <div className="pb-3" title="LinkTo 林可兔">
        <LogoMark size={28} />
      </div>
    </nav>
    </div>
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
