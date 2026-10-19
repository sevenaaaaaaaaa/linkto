import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { useMail } from '../../stores/mail'
import { useOverlayTurn, OVERLAY_PRIORITY } from '../../lib/overlays'
import { wizardDecision, wizardSteps, type UpgradeState, type WizardMode, type WizardStep } from '@shared/upgrade'
import { useContentAccessDraft, ContentAccessForm } from '../attachments/ContentAccess'
import { useOnboardingScan, useOrganizeDraft, OrganizeSetup, OrganizeProgress, isFinishedRun } from '../agent/AutomationPanel'
import { SidebarEditor } from './SidebarEditor'
import { IconRobot, IconRss, IconLink, IconCloud, IconShield, IconCheck, IconFileText } from '../../components/icons'
import { IconWallet } from '../finance/FinanceNav'

/**
 * 升级向导（一个大浮层，分步、可跳过 / 稍后、进度点）——把以前散落的「首次」引导收到一处：
 *  ① 这次有什么新东西 ② 附件内容读取授权（复用 ContentAccess 的表单与保存逻辑）
 *  ③ 首次整理（复用 onboarding 扫描：范围、步骤，含生活档案）④ 侧栏：钉住常用入口
 *
 * 何时出现（纯函数 wizardDecision，见 @shared/upgrade）：
 *  - 老用户升级到新功能版本后首次打开 → 完整向导
 *  - 新装用户：先走添加账户；首个账户首次同步完成后 → 只出（授权 +）首次整理
 *  - 以后再加账户 → 只出首次整理
 * 经「首次」浮层协调器排队：同一时间只有一个浮层；用户主动点开的授权说明可以插队。
 */

const OPEN_EVENT = 'ms:upgrade-wizard'

/** ⌘K「查看本次更新」（full）/「整理邮件」（organize）：手动打开向导 */
export function openUpgradeWizard(mode: 'full' | 'organize' = 'full') {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: mode }))
}

const STEP_LABEL: Record<WizardStep, string> = {
  whatsnew: '新功能',
  access: '附件读取',
  organize: '首次整理',
  sidebar: '侧栏'
}

export function UpgradeWizardHost() {
  const accounts = useMail(st => st.accounts)
  const onb = useOnboardingScan(st => st.st)
  const [state, setState] = useState<UpgradeState | null>(null)
  const [accessAsked, setAccessAsked] = useState<boolean | null>(null)
  const [settled, setSettled] = useState(false)
  const [later, setLater] = useState(false)
  const [mode, setMode] = useState<WizardMode>('none')

  useEffect(() => {
    void api.upgradeState().then(setState).catch(() => {})
    void api.contentAccessGet().then(a => setAccessAsked(a.asked)).catch(() => setAccessAsked(true))
    // 启动后稍等再出现：让首屏先稳定（账户 / 列表加载完），不和启动动画抢
    const t = window.setTimeout(() => setSettled(true), 1500)
    const onOpen = (e: Event) => {
      setLater(false)
      setMode((e as CustomEvent<'full' | 'organize'>).detail === 'organize' ? 'organize' : 'full')
    }
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  const organizePending = !!onb && !onb.legacy && onb.pendingAccounts.length > 0 && !onb.hidden && !onb.running
  const decided = state && settled && accessAsked !== null
    ? wizardDecision({ state, hasAccounts: accounts.length > 0, laterThisSession: later, organizePending })
    : 'none'

  // 一旦打开就锁定模式，直到关闭（中途状态变化不换步骤）
  useEffect(() => {
    if (mode === 'none' && decided !== 'none') setMode(decided)
  }, [decided, mode])

  const turn = useOverlayTurn('upgrade-wizard', mode !== 'none', OVERLAY_PRIORITY.wizard)
  if (mode === 'none' || !turn || !state) return null

  const close = async (how: 'done' | 'skip' | 'later') => {
    const st = useOnboardingScan.getState().st
    const untouched = !!st && st.pendingAccounts.length > 0 && !st.running && !st.startedAt
    setLater(true)
    setMode('none')
    if (how === 'later') {
      if (mode === 'full') setState(await api.upgradeLater())
      if (untouched) void api.onboardingScanLater()
      return
    }
    if (mode === 'full' || state.kind === 'fresh') setState(await api.upgradeSetSeen({ outcome: how === 'done' ? 'done' : 'skipped' }))
    // 待整理的账户：跳过 = 不再提醒；完成但没开始整理 = 稍后（连续两次后主进程自动不再提醒）
    if (untouched) void (how === 'skip' ? api.onboardingScanDismiss() : api.onboardingScanLater())
  }

  return <Wizard mode={mode} accessAsked={!!accessAsked} edition={state.edition} onClose={close} onAccessAsked={() => setAccessAsked(true)} />
}

function Wizard(props: { mode: WizardMode; accessAsked: boolean; edition: string; onClose(how: 'done' | 'skip' | 'later'): void; onAccessAsked(): void }) {
  const steps = useMemo(() => wizardSteps(props.mode, { accessAsked: props.accessAsked }), [props.mode])
  const [i, setI] = useState(0)
  const step = steps[Math.min(i, steps.length - 1)]
  const last = i >= steps.length - 1

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose('later')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [props.onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 fade-in" style={{ background: 'var(--scrim)' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="upgrade-title"
        className="w-[760px] max-w-full h-[min(640px,calc(100vh-32px))] flex flex-col rounded-[var(--r-lg)] border pop-in"
        style={{ background: 'var(--surface-strong)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-float)' }}
      >
        <header className="shrink-0 h-12 px-5 flex items-center gap-3 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <span className="caps" style={{ color: 'var(--faint)' }}>
            {props.mode === 'full' ? `LinkTo ${props.edition} · 更新向导` : '开始使用'}
          </span>
          <span className="flex-1" />
          {steps.length > 1 && (
            <ol className="flex items-center gap-1.5" aria-label="进度">
              {steps.map((s, k) => (
                <li key={s}>
                  <button
                    onClick={() => setI(k)}
                    aria-current={k === i ? 'step' : undefined}
                    title={STEP_LABEL[s]}
                    aria-label={`第 ${k + 1} 步：${STEP_LABEL[s]}`}
                    className="block h-1.5 rounded-full transition-all"
                    style={{ width: k === i ? 18 : 6, background: k <= i ? 'var(--accent)' : 'var(--border-strong)', transitionDuration: 'var(--dur-2)' }}
                  />
                </li>
              ))}
            </ol>
          )}
          <span className="flex-1" />
          <button onClick={() => props.onClose('later')} className="h-7 px-2.5 rounded-[var(--r-sm)] text-xs hover:bg-[var(--hover)]" style={{ color: 'var(--muted)' }} title="下次打开 LinkTo 时再看（Esc）">
            稍后
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto px-7 py-6">
          {step === 'whatsnew' && <WhatsNew />}
          {step === 'access' && <AccessStep onAsked={props.onAccessAsked} />}
          {step === 'organize' && <OrganizeStep fresh={props.mode !== 'full'} />}
          {step === 'sidebar' && <SidebarStep />}
        </div>

        <footer className="shrink-0 h-14 px-5 flex items-center gap-2 border-t" style={{ borderColor: 'var(--border-soft)' }}>
          <button onClick={() => props.onClose('skip')} className="text-xs hover:underline" style={{ color: 'var(--faint)' }}>
            {props.mode === 'full' ? '跳过向导' : '不再提醒'}
          </button>
          <span className="flex-1" />
          <span className="text-2xs tnum mr-1" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
            {i + 1} / {steps.length}
          </span>
          {i > 0 && (
            <button onClick={() => setI(i - 1)} className="h-8 px-3 rounded-[var(--r-sm)] text-sm border border-[var(--border)] hover:bg-[var(--hover)]" style={{ color: 'var(--fg)' }}>
              上一步
            </button>
          )}
          <button
            onClick={() => (last ? props.onClose('done') : setI(i + 1))}
            autoFocus
            className="h-8 px-4 rounded-[var(--r-sm)] text-sm font-semibold transition-opacity hover:opacity-90"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          >
            {last ? '完成' : '下一步'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function StepTitle(props: { title: string; desc?: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h2 id="upgrade-title" className="text-lg font-semibold" style={{ color: 'var(--fg)', letterSpacing: 'var(--tracking-tight)' }}>
        {props.title}
      </h2>
      {props.desc && (
        <p className="mt-1 text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
          {props.desc}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- ① 新东西

const CARDS: { icon: React.ReactNode; title: string; desc: string; action?: { label: string; run(): void } }[] = [
  {
    icon: <IconRobot width={16} height={16} />,
    title: 'Agent 与技能',
    desc: '在对话里让 Agent 查邮件、建待办、起草回复；技能可以一键运行、定时运行，或在新邮件到达时自动触发。'
  },
  {
    icon: <IconWallet width={16} height={16} />,
    title: '财务 · 生活档案 · 留痕',
    desc: '账单与订阅自动对账；证件、保险、年检等到期前提醒；口头约定记一笔，起草书面确认并跟进回复。'
  },
  {
    icon: <IconFileText width={16} height={16} />,
    title: 'PDF · Office · 识字',
    desc: '附件里的文字可以查看、搜索、归类和提问，扫描件与图片也能识字；读取前会先征得你同意（下一步）。'
  },
  {
    icon: <IconRss width={16} height={16} />,
    title: '订阅',
    desc: 'RSS 与 AI 搜索订阅和邮件放在一起读，每天一份精华，可并入今日简报。'
  },
  {
    icon: <IconLink width={16} height={16} />,
    title: '分享与导出',
    desc: '邮件、会话与整理结果一键导出为 PDF / Markdown，或发到常用的协作工具（⌘⇧E）。'
  },
  {
    icon: <IconCloud width={16} height={16} />,
    title: '同步与备份',
    desc: '账户（含独立密码）、Agent 记忆、知识库、技能与各中心数据经你自己的邮箱加密同步到其他设备；也可按类别加密备份与恢复。',
    action: { label: '打开设置', run: () => void api.openSettings('backup') }
  }
]

function WhatsNew() {
  return (
    <>
      <StepTitle title="这次有什么新东西" desc="LinkTo 不只是收发邮件：它会把邮件里的事整理成待办、款项、到期事务和知识，并能替你跑腿。" />
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}>
        {CARDS.map(c => (
          <div key={c.title} className="rounded-[var(--r-md)] border border-[var(--border)] p-4 flex flex-col gap-2" style={{ background: 'var(--bg-soft)' }}>
            <span className="w-8 h-8 rounded-full inline-flex items-center justify-center" style={{ background: 'var(--accent-soft)', color: 'var(--accent-ink)' }}>
              {c.icon}
            </span>
            <div className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>
              {c.title}
            </div>
            <div className="text-xs leading-relaxed flex-1" style={{ color: 'var(--muted)' }}>
              {c.desc}
            </div>
            {c.action && (
              <button onClick={c.action.run} className="self-start text-xs hover:underline" style={{ color: 'var(--accent-ink)' }}>
                {c.action.label} →
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- ② 附件读取授权

function AccessStep(props: { onAsked(): void }) {
  const draft = useContentAccessDraft()
  const [saved, setSaved] = useState<'allowed' | 'declined' | null>(null)
  useEffect(() => {
    void draft.load()
  }, [])
  const cur = draft.cur
  if (!cur) return <div className="h-40 rounded-[var(--r-md)] shimmer" />
  return (
    <>
      <StepTitle title={cur.readContent ? '附件内容读取已开启' : '允许 LinkTo 读取附件内容？'} />
      <ContentAccessForm draft={draft} engineName="wizard-engine" />
      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={async () => {
            await draft.allow()
            setSaved('allowed')
            props.onAsked()
          }}
          disabled={draft.busy}
          className="h-8 px-3.5 rounded-[var(--r-sm)] text-sm font-medium inline-flex items-center gap-1.5 border transition-colors disabled:opacity-40"
          style={{ borderColor: 'var(--accent)', color: 'var(--accent-ink)', background: 'var(--accent-soft)' }}
        >
          <IconShield width={13} height={13} />
          {cur.readContent ? '保存' : '允许'}
        </button>
        {!cur.readContent && (
          <button
            onClick={async () => {
              await draft.decline()
              setSaved('declined')
              props.onAsked()
            }}
            className="h-8 px-3 rounded-[var(--r-sm)] text-sm border border-[var(--border)] hover:bg-[var(--hover)]"
            style={{ color: 'var(--fg)' }}
          >
            暂不
          </button>
        )}
        {saved && (
          <span className="text-xs inline-flex items-center gap-1" style={{ color: 'var(--muted)' }}>
            <IconCheck width={12} height={12} />
            {saved === 'allowed' ? '已保存' : '好的，需要时再问你'}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-2xs" style={{ color: 'var(--faint)' }}>
          随时可在 设置 → 附件与存储 修改
        </span>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- ③ 首次整理

function OrganizeStep(props: { fresh: boolean }) {
  const st = useOnboardingScan(s => s.st)
  const closedRun = useOnboardingScan(s => s.closedRun)
  const draft = useOrganizeDraft(st)
  if (!st) return <div className="h-40 rounded-[var(--r-md)] shimmer" />
  if (st.running || isFinishedRun(st, closedRun))
    return (
      <>
        <StepTitle
          title={st.running ? `正在整理近 ${st.days ?? 90} 天的邮件…` : '整理完成'}
          desc={st.running ? '整理在后台进行，可以继续下一步；进度也会显示在侧栏底部。' : '结果已经放进对应的页面；关掉向导后，在侧栏底部「整理完成 · 查看结果」里可以逐项打开。'}
        />
        <OrganizeProgress st={st} embedded />
      </>
    )
  const names = (st.accounts ?? []).map(a => a.email)
  const who = names.length === 1 ? names[0] : names.length ? `${names[0]} 等 ${names.length} 个邮箱` : '你的邮箱'
  const desc = draft.already
    ? '之前已经整理过。这次新增了「生活档案」：建议补扫一次，把证件、保险、年检、域名等到期事务找出来。'
    : props.fresh && !st.legacy
      ? `${who} 已经同步好了。让 Agent 扫描最近的邮件，收集待办、账单与订阅、附件、到期事务，并找出值得沉淀的知识和项目线索。`
      : '让 Agent 扫描最近的邮件，收集待办、账单与订阅、附件、到期事务，并找出值得沉淀的知识和项目线索。整理在后台进行，可以继续用。'
  return (
    <>
      <StepTitle title={draft.already ? '补一次整理？' : '让 Agent 先整理一遍？'} desc={desc} />
      <OrganizeSetup draft={draft} />
      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={draft.start}
          disabled={!draft.canStart}
          className="h-8 px-3.5 rounded-[var(--r-sm)] text-sm font-medium border transition-colors disabled:opacity-40"
          style={{ borderColor: 'var(--accent)', color: 'var(--accent-ink)', background: 'var(--accent-soft)' }}
        >
          开始整理
        </button>
        <span className="text-xs" style={{ color: 'var(--faint)' }}>
          不想现在整理？可以先跳过，以后在 ⌘K 里找到「整理邮件」。
        </span>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- ④ 侧栏

function SidebarStep() {
  const [ai, setAi] = useState(true)
  const [mcp, setMcp] = useState(true)
  useEffect(() => {
    void api.aiStatus().then(s => setAi(s.ready)).catch(() => {})
    void api.getMcpStatus().then(s => setMcp((s as { enabled: boolean }).enabled)).catch(() => {})
  }, [])
  return (
    <>
      <StepTitle
        title="侧栏更清爽了"
        desc="默认只钉住常用入口，其余收进「更多」；你已经在用的入口替你钉住了。随时可以在侧栏底部「编辑侧栏」或 设置 → 个性化 里调整。"
      />
      <SidebarEditor compact />
      {(!ai || !mcp) && (
        <div className="mt-5 rounded-[var(--r-md)] border border-[var(--border)] px-4 py-3" style={{ background: 'var(--bg-soft)' }}>
          <div className="text-xs font-medium mb-1.5" style={{ color: 'var(--fg)' }}>
            还可以
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {!ai && (
              <button onClick={() => void api.openSettings('ai')} className="hover:underline" style={{ color: 'var(--accent-ink)' }}>
                选择 AI 模型（云端或本地）→
              </button>
            )}
            {!mcp && (
              <button onClick={() => void api.openSettings('integrations')} className="hover:underline" style={{ color: 'var(--accent-ink)' }}>
                把 LinkTo 接到 Claude Code（MCP）→
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}
