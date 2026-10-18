import { useEffect, useMemo, useState } from 'react'
import { api, fmtTime } from '../lib/api'
import { useMailEvent } from '../lib/api'
import { useMail } from '../stores/mail'
import {
  IconSunrise, IconCheckSquare, IconBook, IconBuilding, IconStar, IconLayers,
  IconFileText, IconTrash, IconShield, IconTarget, IconTrendingUp, IconBrain, IconRss, IconSparkles } from '../components/icons'
import type { CompanyInsight, DailyDigest, InsightRecord, SwipeData } from '@shared/types'
import { Markdown } from '../components/Markdown'
import { AIErrorNote } from '../components/AIErrorNote'
import { openAISettings } from '../lib/ai-error'

type Tab = 'daily' | 'todo' | 'reading' | 'company'

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'daily', label: '今日商情', icon: <IconSunrise width={13} height={13} /> },
  { id: 'todo', label: '待办', icon: <IconCheckSquare width={13} height={13} /> },
  { id: 'reading', label: '阅读清单', icon: <IconBook width={13} height={13} /> },
  { id: 'company', label: '公司洞察', icon: <IconBuilding width={13} height={13} /> }
]

function openMessage(messageId: string | null) {
  if (!messageId) return
  location.hash = '#/mail'
  useMail.getState().setScope({ kind: 'unified', title: '统一收件箱' })
  setTimeout(() => useMail.getState().select(messageId), 60)
}

export function InsightsView() {
  const [tab, setTab] = useState<Tab>('daily')

  return (
    <div className="flex-1 h-full flex flex-col">
      <div className="drag-region h-[52px] shrink-0" />
      <div className="shrink-0 px-6 pb-4 flex items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>智能洞察</h1>
          <p className="text-xs mt-0.5" style={{ color: 'var(--faint)' }}>
            由你配置的 AI 驱动 · 账单/会议自动成待办 · Newsletter 自动进阅读清单 · 每日商情与公司分析
          </p>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1 p-1 rounded-[var(--r-sm)]" style={{ background: 'var(--bg-soft)' }}>
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all"
              style={tab === t.id
                ? { background: 'var(--surface-strong)', color: 'var(--accent-strong)', boxShadow: 'var(--shadow-sm)', fontWeight: 600 }
                : { color: 'var(--muted)' }}
            >
              <span className="leading-none inline-flex">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-8">
        {tab === 'daily' && <DailyTab />}
        {tab === 'todo' && <TodoTab />}
        {tab === 'reading' && <ReadingTab />}
        {tab === 'company' && <CompanyTab />}
      </div>
    </div>
  )
}

// ================= 今日商情 =================

function DailyTab() {
  const [digest, setDigest] = useState<DailyDigest | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [memoText, setMemoText] = useState('')
  const [memoLoaded, setMemoLoaded] = useState(false)
  // AI 未配置：首屏直接给克制的引导，而不是点了「立即生成」再报错
  const [aiReady, setAiReady] = useState<{ ready: boolean; reason?: string } | null>(null)
  useEffect(() => {
    const check = () => void api.aiStatus().then(setAiReady).catch(() => {})
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])

  const load = async () => {
    const rows = (await api.listInsights('daily')) as InsightRecord[]
    const d = rows[0]?.data as unknown as DailyDigest | undefined
    setDigest(d ?? null)
    if (!memoLoaded) {
      const memos = (await api.listInsights('memo')) as InsightRecord[]
      if (memos[0]) setMemoText(String((memos[0].data as { content?: string }).content ?? ''))
      setMemoLoaded(true)
    }
  }

  useEffect(() => void load(), [])
  useMailEvent(ev => {
    if (ev.type === 'insights-changed') void load()
  })

  const generate = async () => {
    setLoading(true)
    setError('')
    const res = await api.generateDaily(true)
    setLoading(false)
    if (!res.ok && res.error) setError(res.error)
    await load()
  }

  const deleteOne = async (messageId: string) => {
    await api.moveMessages([messageId], 'trash')
    await load()
  }

  return (
    <div className="max-w-[760px] mx-auto space-y-4">
      {!digest && (
        <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] surface p-8 text-center">
          <div className="text-md font-medium" style={{ color: 'var(--fg)' }}>今天的商情还没生成</div>
          <div className="mt-1.5 text-xs" style={{ color: 'var(--faint)' }}>
            AI 会通读近 36 小时邮件，产出当日重点、主题 digest、备忘录与清理建议（每天自动生成一次）
          </div>
          {aiReady?.ready === false ? (
            <div className="mt-4 inline-flex flex-col items-center gap-2">
              <span className="text-xs" style={{ color: 'var(--muted)' }}>还没有配置 AI（{aiReady.reason}），配置后即可生成</span>
              <button
                onClick={openAISettings}
                className="text-sm font-medium px-5 py-2 rounded-[var(--r-sm)] border border-[var(--border)] hover:bg-[var(--hover)]"
                style={{ color: 'var(--fg)', background: 'var(--surface-strong)' }}
              >
                去设置 AI
              </button>
            </div>
          ) : (
            <button
              onClick={generate}
              disabled={loading}
              className="mt-4 text-sm font-medium px-5 py-2.5 rounded-[var(--r-sm)] disabled:opacity-50"
              style={{ background: 'var(--accent-grad)', color: 'var(--on-accent)' }}
            >
              {loading ? '正在阅读你的邮件…' : '立即生成'}
            </button>
          )}
          {error && <AIErrorNote className="mt-2.5 justify-center" error={error} onRetry={() => void generate()} />}
        </div>
      )}

      {digest && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--faint)' }}>
              {digest.stats.total} 封邮件 · {digest.stats.senders} 个发件人 · 生成于 {fmtTime(digest.generatedAt)}
            </span>
            <div className="flex-1" />
            <button
              onClick={generate}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded-lg disabled:opacity-50"
              style={{ background: 'var(--bg-soft)', color: 'var(--accent-strong)' }}
            >
              {loading ? '生成中…' : '重新生成'}
            </button>
          </div>
          {error && <AIErrorNote error={error} onRetry={() => void generate()} />}

          <Panel title="今日重点" icon={<IconStar width={14} height={14} />}>
            <ul className="space-y-1.5">
              {digest.highlights.map((h, i) => (
                <li key={i} className="flex gap-2 text-sm leading-relaxed" style={{ color: 'var(--fg)' }}>
                  <span style={{ color: 'var(--accent)' }}>{i + 1}.</span>
                  <span>{h}</span>
                </li>
              ))}
              {!digest.highlights.length && <Empty text="今天没有特别需要关注的" />}
            </ul>
          </Panel>

          <Panel title="主题 Digest" icon={<IconLayers width={14} height={14} />}>
            <div className="space-y-3">
              {digest.themes.map(t => (
                <div key={t.theme} className="pl-3 border-l-2" style={{ borderColor: 'var(--accent)' }}>
                  <div className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>
                    {t.theme}
                    {t.count > 0 && <span className="ml-1.5 text-2xs font-normal" style={{ color: 'var(--faint)' }}>{t.count} 封</span>}
                  </div>
                  <div className="text-xs leading-relaxed mt-0.5" style={{ color: 'var(--muted)' }}>{t.summary}</div>
                </div>
              ))}
              {!digest.themes.length && <Empty text="暂无主题归纳" />}
            </div>
          </Panel>

          <Panel title="备忘录" icon={<IconFileText width={14} height={14} />}>
            <textarea
              value={memoText}
              onChange={e => setMemoText(e.target.value)}
              onBlur={() => void api.saveMemo('备忘录', memoText)}
              placeholder="AI 生成的备忘 + 你自己补充的都放这里（自动保存）"
              rows={3}
              className="w-full text-sm leading-relaxed rounded-lg px-3 py-2.5 outline-none border border-[var(--border-soft)] resize-none selectable"
              style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
            />
          </Panel>

          <Panel title="清理建议" icon={<IconTrash width={14} height={14} />}>
            <div className="space-y-2">
              {digest.deleteSuggestions.map(d => (
                <div key={d.messageId} className="flex items-center gap-2.5">
                  <span className="inline-flex" style={{ color: 'var(--faint)' }}><IconTrash width={14} height={14} /></span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate" style={{ color: 'var(--fg)' }}>{d.subject}</div>
                    <div className="text-xs truncate" style={{ color: 'var(--faint)' }}>{d.from} · {d.reason}</div>
                  </div>
                  <button
                    onClick={() => void deleteOne(d.messageId)}
                    className="text-xs px-2.5 py-1 rounded-lg shrink-0"
                    style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}
                  >
                    删除
                  </button>
                </div>
              ))}
              {!digest.deleteSuggestions.length && <Empty text="没有建议删除的邮件" />}
            </div>
          </Panel>
        </>
      )}
    </div>
  )
}

// ================= 待办 =================

function TodoTab() {
  const [items, setItems] = useState<InsightRecord[]>([])
  const [showDone, setShowDone] = useState(false)

  const load = () => void api.listInsights('todo').then(r => setItems(r as InsightRecord[]))
  useEffect(() => load(), [])
  useMailEvent(ev => {
    if (ev.type === 'insights-changed') load()
  })

  const visible = items.filter(i => (showDone ? true : i.status === 'open'))
  const openCount = items.filter(i => i.status === 'open').length

  // 清单分组（批量提问 / todo 清单模式生成的成组待办）
  const { sets, flat } = useMemo(() => {
    const sets: { id: string; title: string; items: InsightRecord[] }[] = []
    const byId = new Map<string, { id: string; title: string; items: InsightRecord[] }>()
    const flat: InsightRecord[] = []
    for (const item of visible) {
      const setId = (item.data as { set?: string }).set
      if (setId) {
        let g = byId.get(setId)
        if (!g) {
          g = { id: setId, title: (item.data as { setTitle?: string }).setTitle ?? '待办清单', items: [] }
          byId.set(setId, g)
          sets.push(g)
        }
        g.items.push(item)
      } else {
        flat.push(item)
      }
    }
    return { sets, flat }
  }, [visible])

  const row = (item: InsightRecord) => {
    const d = item.data as { amount?: string | null; from?: string; link?: string | null }
    const done = item.status === 'done'
    return (
      <div key={item.id} className="flex items-center gap-3">
        <button
          onClick={() => void api.setInsightStatus(item.id, done ? 'open' : 'done').then(load)}
          className="w-[18px] h-[18px] rounded-full border shrink-0 flex items-center justify-center"
          style={{ borderColor: done ? 'var(--accent)' : 'var(--border-strong)', background: done ? 'var(--accent)' : 'transparent' }}
        >
          {done && <span className="text-2xs" style={{ color: 'var(--on-accent)' }}>✓</span>}
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm" style={{ color: 'var(--fg)', textDecoration: done ? 'line-through' : 'none' }}>{item.title}</div>
          <div className="text-2xs truncate" style={{ color: 'var(--faint)' }}>
            {item.dueAt ? `截止 ${fmtTime(item.dueAt)}` : ''}
            {d.amount ? ` · ${d.amount}` : ''}
            {d.from ? ` · ${d.from}` : ''}
          </div>
        </div>
        {item.messageId && (
          <button onClick={() => openMessage(item.messageId)} className="text-xs px-2 py-0.5 rounded-lg shrink-0" style={{ background: 'var(--bg-soft)', color: 'var(--accent-strong)' }}>
            原文
          </button>
        )}
        <button onClick={() => void api.deleteInsight(item.id).then(load)} className="text-xs px-1.5 py-0.5 rounded-lg shrink-0" style={{ color: 'var(--faint)' }} title="移除">
          ✕
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-[720px] mx-auto space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs" style={{ color: 'var(--faint)' }}>{openCount} 项待办 · 来自账单/会议邮件、批量提问与清单</span>
        <div className="flex-1" />
        <button onClick={() => setShowDone(s => !s)} className="text-xs px-2.5 py-1 rounded-lg" style={{ background: 'var(--bg-soft)', color: 'var(--muted)' }}>
          {showDone ? '隐藏已完成' : '显示已完成'}
        </button>
      </div>

      {sets.map(g => {
        const doneN = g.items.filter(i => i.status === 'done').length
        return (
          <div key={g.id} className="rounded-[var(--r-sm)] border border-[var(--border-soft)] surface p-4">
            <div className="flex items-center gap-2 mb-2.5">
              <span className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>{g.title}</span>
              <span
                className="text-2xs px-1.5 py-px rounded-full"
                style={{ background: doneN === g.items.length ? 'var(--ok-soft)' : 'var(--accent-soft)', color: doneN === g.items.length ? 'var(--ok)' : 'var(--accent-strong)' }}
              >
                {doneN}/{g.items.length}
              </span>
            </div>
            <div className="space-y-2">{g.items.map(row)}</div>
          </div>
        )
      })}

      {flat.length > 0 && (
        <div className="space-y-2.5 rounded-[var(--r-sm)] border border-[var(--border-soft)] surface p-4">
          {flat.map(row)}
        </div>
      )}

      {!visible.length && <EmptyCard text="暂无待办。阅读账单 / 会议邮件时点「提炼」，多选邮件后点「提问」，或开启 设置 → AI → 自动提炼" />}
    </div>
  )
}

// ================= 阅读清单 =================

function ReadingTab() {
  const [section, setSection] = useState<'articles' | 'swipe'>(() => (localStorage.getItem('ms_reading_section') as 'swipe') || 'articles')
  const [swipeCount, setSwipeCount] = useState(0)
  useEffect(() => {
    const load = () => void api.listInsights('swipe').then(r => setSwipeCount(r.filter(x => x.status !== ('dismissed' as never)).length))
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])
  const pick = (v: 'articles' | 'swipe') => {
    setSection(v)
    localStorage.setItem('ms_reading_section', v)
  }
  return (
    <div className="max-w-[760px] mx-auto">
      <div className="mb-4 inline-flex p-0.5 rounded-[var(--r-sm)]" style={{ background: 'var(--hover)' }} role="tablist">
        {(
          [
            ['articles', '文章'],
            ['swipe', `营销灵感${swipeCount ? ` · ${swipeCount}` : ''}`]
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={section === k}
            onClick={() => pick(k)}
            className="h-7 px-3 rounded-[var(--r-xs)] text-xs"
            style={section === k ? { background: 'var(--surface-strong)', color: 'var(--fg)', fontWeight: 600, boxShadow: 'var(--shadow-sm)' } : { color: 'var(--muted)' }}
          >
            {label}
          </button>
        ))}
      </div>
      {section === 'articles' ? <ArticlesList /> : <SwipeFile onCount={setSwipeCount} />}
    </div>
  )
}

/** 营销灵感：公司洞察挑出的范本邮件，按公司 / 生命周期阶段 / 手法筛选 */
function SwipeFile(props: { onCount(n: number): void }) {
  const [items, setItems] = useState<InsightRecord[]>([])
  const [stage, setStage] = useState('')
  const [company, setCompany] = useState('')
  const load = () =>
    void api.listInsights('swipe').then(r => {
      const list = (r as InsightRecord[]).filter(x => (x.status as string) !== 'dismissed')
      setItems(list)
      props.onCount(list.length)
    })
  useEffect(() => load(), [])
  useMailEvent(ev => {
    if (ev.type === 'insights-changed') load()
  })
  const data = (i: InsightRecord) => i.data as unknown as SwipeData
  const companies = [...new Set(items.map(i => data(i).company).filter(Boolean))]
  const stages = [...new Set(items.map(i => data(i).stage).filter(Boolean))]
  const shown = items.filter(i => (!stage || data(i).stage === stage) && (!company || data(i).company === company))

  if (!items.length) return <EmptyCard text="还没有营销灵感。在「公司洞察」里分析一家公司，AI 会把最值得学的邮件收到这里。" />
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        <FilterChip on={!company} onClick={() => setCompany('')}>全部公司</FilterChip>
        {companies.map(c => (
          <FilterChip key={c} on={company === c} onClick={() => setCompany(company === c ? '' : c)}>{c}</FilterChip>
        ))}
      </div>
      {stages.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <FilterChip on={!stage} onClick={() => setStage('')}>全部阶段</FilterChip>
          {stages.map(st => (
            <FilterChip key={st} on={stage === st} onClick={() => setStage(stage === st ? '' : st)}>{st}</FilterChip>
          ))}
        </div>
      )}
      {shown.map(i => {
        const d = data(i)
        return (
          <div key={i.id} className="rounded-[var(--r-md)] border border-[var(--border-soft)] surface p-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold leading-snug" style={{ color: 'var(--fg)' }}>{i.title}</div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--faint)' }}>
                  {d.company} · {d.date ? new Date(d.date).toLocaleDateString('zh-CN') : ''}
                </div>
              </div>
              <div className="flex gap-1.5 shrink-0">
                {i.messageId && <SourceBtn id={i.messageId} subject={i.title} />}
                <button
                  onClick={() => void api.updateTodo(i.id, { status: 'dismissed' }).then(load)}
                  className="text-2xs h-6 px-2 rounded-[var(--r-xs)] hover:bg-[var(--hover)]"
                  style={{ color: 'var(--faint)' }}
                >
                  移出
                </button>
              </div>
            </div>
            <div className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--fg)' }}>
              <mark className="hl">{d.why}</mark>
            </div>
            {d.learn?.length > 0 && (
              <ul className="mt-2 pl-4 list-disc text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
                {d.learn.map((l, j) => <li key={j}>{l}</li>)}
              </ul>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {d.stage && <Tag>{d.stage}</Tag>}
              {(d.triggers ?? []).map(t => <Tag key={t}>{t}</Tag>)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function FilterChip(props: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      className="text-xs h-7 px-2.5 rounded-full border"
      style={props.on ? { background: 'var(--fg)', color: 'var(--surface-strong)', borderColor: 'var(--fg)' } : { borderColor: 'var(--border)', color: 'var(--muted)' }}
    >
      {props.children}
    </button>
  )
}

function ArticlesList() {
  const [items, setItems] = useState<InsightRecord[]>([])

  const load = () => void api.listInsights('reading').then(r => setItems(r as InsightRecord[]))
  useEffect(() => load(), [])
  useMailEvent(ev => {
    if (ev.type === 'insights-changed') load()
  })

  const openItems = items.filter(i => i.status === 'open')
  const doneItems = items.filter(i => i.status === 'done')

  const card = (item: InsightRecord) => {
    const d = item.data as { url?: string | null; summary?: string | null; from?: string }
    return (
      <div key={item.id} className="rounded-[var(--r-sm)] border border-[var(--border-soft)] px-4 py-3 surface" style={item.status === 'done' ? { opacity: 0.55 } : undefined}>
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5" style={{ color: 'var(--cat-newsletter)' }}><IconRss width={15} height={15} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium leading-snug" style={{ color: 'var(--fg)' }}>{item.title}</div>
            {d.summary && <div className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--muted)' }}>{d.summary}</div>}
            <div className="text-xs mt-1" style={{ color: 'var(--faint)' }}>{d.from ?? ''}</div>
          </div>
          <div className="flex flex-col gap-1 shrink-0">
            {d.url && (
              <button onClick={() => d.url && void api.openExternal(d.url)} className="text-xs px-2.5 py-1 rounded-lg" style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}>
                打开链接
              </button>
            )}
            {item.messageId && (
              <button onClick={() => openMessage(item.messageId)} className="text-xs px-2.5 py-1 rounded-lg" style={{ background: 'var(--bg-soft)', color: 'var(--muted)' }}>
                原文
              </button>
            )}
            <button
              onClick={() => void api.setInsightStatus(item.id, item.status === 'done' ? 'open' : 'done').then(load)}
              className="text-xs px-2.5 py-1 rounded-lg"
              style={{ color: 'var(--faint)' }}
            >
              {item.status === 'done' ? '标未读' : '已读'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {openItems.map(card)}
      {doneItems.length > 0 && (
        <div>
          <div className="text-2xs uppercase tracking-[0.06em] mb-1.5" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>已读</div>
          <div className="space-y-2">{doneItems.map(card)}</div>
        </div>
      )}
      {!items.length && <EmptyCard text="暂无阅读清单。Newsletter 邮件会自动提取文章进入这里（需开启自动提炼）" />}
    </div>
  )
}

// ================= 公司洞察 =================

function CompanyTab() {
  const [domains, setDomains] = useState<{ domain: string; name: string; count: number }[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<CompanyInsight | null>(null)
  const [progress, setProgress] = useState('')

  useEffect(() => {
    void api.listCompanyDomains().then(setDomains)
  }, [])
  useMailEvent(ev => {
    const e = ev as unknown as { type: string; text?: string }
    if (e.type === 'company-progress') setProgress(e.text ?? '')
  })

  const analyze = async (domain: string) => {
    if (!domain || running) return
    setRunning(true)
    setError('')
    setProgress('')
    const res = await api.companyInsight(domain)
    setRunning(false)
    setProgress('')
    if (!res.ok) {
      setError(res.error ?? '分析失败')
      return
    }
    if (res.insight) setResult(res.insight)
  }

  const pickExisting = async (domain: string) => {
    setInput(domain)
    setResult(null)
    await analyze(domain)
  }

  return (
    <div className="max-w-[720px] mx-auto space-y-4">
      <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] surface p-4">
        <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>发件公司分析</div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--faint)' }}>
          输入公司域名或任一发件邮箱。AI 会读正文，拆出发布节奏、营销活动和每个转化点，并把最值得学的邮件收进阅读清单的「营销灵感」
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && analyze(input)}
            placeholder="company.com"
            list="company-domain-list"
            className="flex-1 text-sm rounded-lg px-3 py-2 outline-none border border-[var(--border-soft)] selectable"
            style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
          />
          <datalist id="company-domain-list">
            {domains.map(d => (
              <option key={d.domain} value={d.domain}>{d.name}（{d.count} 封）</option>
            ))}
          </datalist>
          <button
            onClick={() => analyze(input)}
            disabled={running || !input}
            className="text-sm font-medium px-4 py-2 rounded-lg disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          >
            {running ? '分析中…' : '分析'}
          </button>
        </div>
        {running && progress && <div className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{progress}</div>}
        {error && <AIErrorNote className="mt-2" error={error} onRetry={() => void analyze(input)} />}
        {domains.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {domains.slice(0, 10).map(d => (
              <button
                key={d.domain}
                onClick={() => pickExisting(d.domain)}
                className="text-xs px-2.5 py-1 rounded-full border"
                style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
              >
                {d.name || d.domain} · {d.count}
              </button>
            ))}
          </div>
        )}
      </div>

      {result && <CompanyReport insight={result} />}
    </div>
  )
}

function CompanyReport(props: { insight: CompanyInsight }) {
  const c = props.insight
  return (
    <div className="space-y-4 pop-in">
      <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] surface p-5">
        <div className="flex items-baseline gap-2">
          <span className="text-md font-semibold" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>{c.company}</span>
          <span className="text-xs" style={{ color: 'var(--faint)' }}>{c.domain} · {c.mailCount} 封邮件</span>
        </div>
        <div className="mt-1.5 text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>{c.summary}</div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ScoreCard title="品牌价值可信度" score={c.credibility.score} reasons={c.credibility.reasons} icon={<IconShield width={15} height={15} />} />
        <ScoreCard title="你的转化指数" score={c.conversionIndex.score} reasons={c.conversionIndex.reasons} icon={<IconTarget width={15} height={15} />} />
      </div>

      <Panel title="运营策略时间线" icon={<IconTrendingUp width={14} height={14} />}>
        <div className="space-y-0">
          {c.timeline.map((t, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: 'var(--accent)' }} />
                {i < c.timeline.length - 1 && <span className="w-px flex-1" style={{ background: 'var(--border)' }} />}
              </div>
              <div className="pb-3.5">
                <div className="text-xs font-medium" style={{ color: 'var(--accent-strong)', fontFamily: 'var(--font-mono)' }}>{t.period}</div>
                <div className="text-xs leading-relaxed" style={{ color: 'var(--fg)' }}>{t.event}</div>
              </div>
            </div>
          ))}
          {!c.timeline.length && <Empty text="时间线为空" />}
        </div>
      </Panel>

      <Panel title="运营策略剖析" icon={<IconBrain width={14} height={14} />}>
        <div className="text-sm leading-relaxed" style={{ color: 'var(--fg)' }}><Markdown text={c.strategy} /></div>
        {c.cadence && <div className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>发信节奏：{c.cadence}</div>}
      </Panel>

      {!!c.launches?.length && (
        <Panel title={`发布节奏 · ${c.launches.length}`} icon={<IconTrendingUp width={14} height={14} />}>
          <div className="flex flex-col divide-y divide-[var(--border-soft)]">
            {c.launches.map((l, i) => (
              <div key={i} className="py-2.5 flex gap-3 items-start">
                <span className="w-16 shrink-0 text-xs tnum" style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{l.date}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>{l.title}</div>
                  <div className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--muted)' }}>{l.angle}</div>
                </div>
                <SourceBtn id={l.messageId} subject={l.subject} />
              </div>
            ))}
          </div>
        </Panel>
      )}

      {!!c.campaigns?.length && (
        <Panel title={`营销活动 · ${c.campaigns.length}`} icon={<IconTarget width={14} height={14} />}>
          <div className="grid grid-cols-2 gap-2.5">
            {c.campaigns.map((m, i) => (
              <div key={i} className="rounded-[var(--r-sm)] border border-[var(--border)] p-3 flex flex-col gap-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold flex-1" style={{ color: 'var(--fg)' }}>{m.theme}</span>
                  <span className="text-2xs tnum" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{m.period}</span>
                </div>
                {m.offer && m.offer !== '无' && <div className="text-xs" style={{ color: 'var(--muted)' }}>利益点：{m.offer}</div>}
                <div className="flex flex-wrap gap-1">{m.tactics.map(t => <Tag key={t}>{t}</Tag>)}</div>
                {m.messageIds.length > 0 && (
                  <button onClick={() => openMessage(m.messageIds[0])} className="self-start text-2xs underline underline-offset-2" style={{ color: 'var(--muted)' }}>
                    看邮件（{m.messageIds.length} 封）
                  </button>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {!!c.conversionPoints?.length && (
        <Panel title={`转化点 · ${c.conversionPoints.length}`} icon={<IconTarget width={14} height={14} />}>
          {STAGES.filter(st => c.conversionPoints!.some(p => p.stage === st)).concat(c.conversionPoints.some(p => !STAGES.includes(p.stage)) ? ['其他'] : []).map(st => (
            <div key={st} className="mb-3 last:mb-0">
              <div className="text-xs font-semibold mb-1.5" style={{ color: 'var(--faint)' }}>{st}</div>
              <div className="flex flex-col gap-1.5">
                {c.conversionPoints!.filter(p => (st === '其他' ? !STAGES.includes(p.stage) : p.stage === st)).map((p, i) => (
                  <div key={i} className="rounded-[var(--r-sm)] border border-[var(--border)] px-3 py-2.5 flex gap-3 items-start">
                    <div className="flex-1 min-w-0">
                      {p.cta && (
                        <div className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>
                          「{p.cta}」
                        </div>
                      )}
                      <div className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--muted)' }}>{p.why}</div>
                      <div className="mt-1.5 flex flex-wrap gap-1">{p.triggers.map(t => <Tag key={t}>{t}</Tag>)}</div>
                    </div>
                    <SourceBtn id={p.messageId} subject={p.subject} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Panel>
      )}

      {!!c.bestPicks?.length && (
        <Panel title="最值得学习的邮件" icon={<IconSparkles width={14} height={14} />}>
          <div className="text-xs mb-2.5" style={{ color: 'var(--faint)' }}>已收进「阅读清单 → 营销灵感」</div>
          <div className="flex flex-col gap-2.5">
            {c.bestPicks.map((b, i) => (
              <div key={i} className="rounded-[var(--r-sm)] p-3.5" style={{ background: 'var(--ai-soft)' }}>
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>{b.subject || '（无主题）'}</div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{b.why}</div>
                  </div>
                  <SourceBtn id={b.messageId} subject={b.subject} />
                </div>
                <ul className="mt-2 pl-4 list-disc text-xs leading-relaxed" style={{ color: 'var(--fg)' }}>
                  {b.learn.map((l, j) => <li key={j}>{l}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  )
}

const STAGES = ['拉新', '激活', '付费转化', '升级增购', '留存', '召回', '推荐裂变']

function Tag(props: { children: React.ReactNode }) {
  return <span className="text-2xs px-1.5 h-5 inline-flex items-center rounded-[var(--r-xs)]" style={{ background: 'var(--hover)', color: 'var(--muted)' }}>{props.children}</span>
}

function SourceBtn(props: { id: string; subject: string }) {
  return (
    <button
      onClick={() => openMessage(props.id)}
      title={props.subject}
      className="shrink-0 text-2xs h-6 px-2 rounded-[var(--r-xs)] border border-[var(--border)] hover:bg-[var(--hover)]"
      style={{ color: 'var(--muted)' }}
    >
      原邮件 ↗
    </button>
  )
}

function ScoreCard(props: { title: string; score: number; reasons: string; icon: React.ReactNode }) {
  const hue = props.score >= 70 ? 'var(--ok)' : props.score >= 40 ? 'var(--warn)' : 'var(--danger)'
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] surface p-4">
      <div className="flex items-center gap-2">
        <span className="inline-flex" style={{ color: hue }}>{props.icon}</span>
        <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>{props.title}</span>
        <div className="flex-1" />
        <span className="text-xl font-semibold leading-none font-[var(--font-mono)]" style={{ color: hue }}>{props.score}</span>
      </div>
      <div className="mt-2.5 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-soft)' }}>
        <div className="h-full rounded-full" style={{ width: `${props.score}%`, background: hue }} />
      </div>
      <div className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--faint)' }}>{props.reasons}</div>
    </div>
  )
}

// ================= 通用 =================

function Panel(props: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] surface p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-flex" style={{ color: 'var(--accent)' }}>{props.icon}</span>
        <span className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>{props.title}</span>
      </div>
      {props.children}
    </div>
  )
}

function Empty(props: { text: string }) {
  return <div className="text-xs py-1" style={{ color: 'var(--faint)' }}>{props.text}</div>
}

function EmptyCard(props: { text: string }) {
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] surface p-8 text-center text-sm" style={{ color: 'var(--faint)' }}>
      {props.text}
    </div>
  )
}
