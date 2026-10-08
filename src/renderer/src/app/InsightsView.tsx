import { useEffect, useMemo, useState } from 'react'
import { api, fmtTime } from '../lib/api'
import { useMailEvent } from '../lib/api'
import { useMail } from '../stores/mail'
import type { CompanyInsight, DailyDigest, InsightRecord } from '@shared/types'

type Tab = 'daily' | 'todo' | 'reading' | 'company'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'daily', label: '今日商情', icon: '🌤' },
  { id: 'todo', label: '待办', icon: '✅' },
  { id: 'reading', label: '阅读清单', icon: '📚' },
  { id: 'company', label: '公司洞察', icon: '🏢' }
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
          <h1 className="text-[19px] font-semibold" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>智能洞察</h1>
          <p className="text-[12px] mt-0.5" style={{ color: 'var(--faint)' }}>
            由你配置的 AI 驱动 · 账单/会议自动成待办 · Newsletter 自动进阅读清单 · 每日商情与公司分析
          </p>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1 p-1 rounded-[var(--r-sm)]" style={{ background: 'var(--bg-soft)' }}>
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="flex items-center gap-1.5 text-[12.5px] px-3 py-1.5 rounded-[10px] transition-all"
              style={tab === t.id
                ? { background: 'var(--surface-strong)', color: 'var(--accent-strong)', boxShadow: 'var(--shadow-sm)', fontWeight: 600 }
                : { color: 'var(--muted)' }}
            >
              <span className="text-[13px] leading-none">{t.icon}</span>
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
        <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] glass p-8 text-center">
          <div className="text-[15px] font-medium" style={{ color: 'var(--fg)' }}>今天的商情还没生成</div>
          <div className="mt-1.5 text-[12.5px]" style={{ color: 'var(--faint)' }}>
            AI 会通读近 36 小时邮件，产出当日重点、主题 digest、备忘录与清理建议（每天自动生成一次）
          </div>
          <button
            onClick={generate}
            disabled={loading}
            className="mt-4 text-[13px] font-medium px-5 py-2.5 rounded-[var(--r-sm)] disabled:opacity-50"
            style={{ background: 'linear-gradient(120deg, var(--accent), oklch(58% .16 285))', color: 'var(--on-accent)' }}
          >
            {loading ? '正在阅读你的邮件…' : '立即生成'}
          </button>
          {error && <div className="mt-2.5 text-[12.5px]" style={{ color: 'var(--danger)' }}>{error}</div>}
        </div>
      )}

      {digest && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-[12px]" style={{ color: 'var(--faint)' }}>
              {digest.stats.total} 封邮件 · {digest.stats.senders} 个发件人 · 生成于 {fmtTime(digest.generatedAt)}
            </span>
            <div className="flex-1" />
            <button
              onClick={generate}
              disabled={loading}
              className="text-[12px] px-3 py-1.5 rounded-lg disabled:opacity-50"
              style={{ background: 'var(--bg-soft)', color: 'var(--accent-strong)' }}
            >
              {loading ? '生成中…' : '重新生成'}
            </button>
          </div>
          {error && <div className="text-[12.5px]" style={{ color: 'var(--danger)' }}>{error}</div>}

          <Panel title="今日重点" icon="⭐">
            <ul className="space-y-1.5">
              {digest.highlights.map((h, i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-relaxed" style={{ color: 'var(--fg)' }}>
                  <span style={{ color: 'var(--accent)' }}>{i + 1}.</span>
                  <span>{h}</span>
                </li>
              ))}
              {!digest.highlights.length && <Empty text="今天没有特别需要关注的" />}
            </ul>
          </Panel>

          <Panel title="主题 Digest" icon="🧵">
            <div className="space-y-3">
              {digest.themes.map(t => (
                <div key={t.theme} className="pl-3 border-l-2" style={{ borderColor: 'var(--accent)' }}>
                  <div className="text-[13px] font-semibold" style={{ color: 'var(--fg)' }}>
                    {t.theme}
                    {t.count > 0 && <span className="ml-1.5 text-[11px] font-normal" style={{ color: 'var(--faint)' }}>{t.count} 封</span>}
                  </div>
                  <div className="text-[12.5px] leading-relaxed mt-0.5" style={{ color: 'var(--muted)' }}>{t.summary}</div>
                </div>
              ))}
              {!digest.themes.length && <Empty text="暂无主题归纳" />}
            </div>
          </Panel>

          <Panel title="备忘录" icon="📝">
            <textarea
              value={memoText}
              onChange={e => setMemoText(e.target.value)}
              onBlur={() => void api.saveMemo('备忘录', memoText)}
              placeholder="AI 生成的备忘 + 你自己补充的都放这里（自动保存）"
              rows={3}
              className="w-full text-[13px] leading-relaxed rounded-[10px] px-3 py-2.5 outline-none border border-[var(--border-soft)] resize-none selectable"
              style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}
            />
          </Panel>

          <Panel title="清理建议" icon="🧹">
            <div className="space-y-2">
              {digest.deleteSuggestions.map(d => (
                <div key={d.messageId} className="flex items-center gap-2.5">
                  <span className="text-[14px]">🗑</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] truncate" style={{ color: 'var(--fg)' }}>{d.subject}</div>
                    <div className="text-[11.5px] truncate" style={{ color: 'var(--faint)' }}>{d.from} · {d.reason}</div>
                  </div>
                  <button
                    onClick={() => void deleteOne(d.messageId)}
                    className="text-[12px] px-2.5 py-1 rounded-lg shrink-0"
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

  return (
    <div className="max-w-[720px] mx-auto space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[12px]" style={{ color: 'var(--faint)' }}>{openCount} 项待办 · 来自账单、会议与提醒邮件</span>
        <div className="flex-1" />
        <button onClick={() => setShowDone(s => !s)} className="text-[12px] px-2.5 py-1 rounded-lg" style={{ background: 'var(--bg-soft)', color: 'var(--muted)' }}>
          {showDone ? '隐藏已完成' : '显示已完成'}
        </button>
      </div>
      {visible.map(item => {
        const d = item.data as { amount?: string | null; from?: string; link?: string | null }
        const done = item.status === 'done'
        return (
          <div
            key={item.id}
            className="flex items-center gap-3 rounded-[var(--r-sm)] border border-[var(--border-soft)] px-4 py-3 glass"
            style={done ? { opacity: 0.55 } : undefined}
          >
            <button
              onClick={() => void api.setInsightStatus(item.id, done ? 'open' : 'done').then(load)}
              className="w-[18px] h-[18px] rounded-full border shrink-0 flex items-center justify-center"
              style={{ borderColor: done ? 'var(--accent)' : 'var(--border-strong)', background: done ? 'var(--accent)' : 'transparent' }}
            >
              {done && <span className="text-[10px]" style={{ color: 'var(--on-accent)' }}>✓</span>}
            </button>
            <div className="flex-1 min-w-0">
              <div className="text-[13.5px]" style={{ color: 'var(--fg)', textDecoration: done ? 'line-through' : 'none' }}>{item.title}</div>
              <div className="text-[11.5px] truncate" style={{ color: 'var(--faint)' }}>
                {d.from ? `${d.from} · ` : ''}
                {item.dueAt ? `截止 ${new Date(item.dueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
                {d.amount ? ` · ${d.amount}` : ''}
              </div>
            </div>
            {item.messageId && (
              <button onClick={() => openMessage(item.messageId)} className="text-[12px] px-2.5 py-1 rounded-lg shrink-0" style={{ background: 'var(--bg-soft)', color: 'var(--accent-strong)' }}>
                查看邮件
              </button>
            )}
            <button onClick={() => void api.deleteInsight(item.id).then(load)} className="text-[12px] px-2 py-1 rounded-lg shrink-0" style={{ color: 'var(--faint)' }} title="移除">
              ✕
            </button>
          </div>
        )
      })}
      {!visible.length && <EmptyCard text="暂无待办。阅读账单 / 会议邮件时点「提炼」，或开启 设置 → AI → 自动提炼" />}
    </div>
  )
}

// ================= 阅读清单 =================

function ReadingTab() {
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
      <div key={item.id} className="rounded-[var(--r-sm)] border border-[var(--border-soft)] px-4 py-3 glass" style={item.status === 'done' ? { opacity: 0.55 } : undefined}>
        <div className="flex items-start gap-2.5">
          <span className="text-[15px] mt-0.5">📰</span>
          <div className="flex-1 min-w-0">
            <div className="text-[13.5px] font-medium leading-snug" style={{ color: 'var(--fg)' }}>{item.title}</div>
            {d.summary && <div className="text-[12px] mt-0.5 leading-relaxed" style={{ color: 'var(--muted)' }}>{d.summary}</div>}
            <div className="text-[11.5px] mt-1" style={{ color: 'var(--faint)' }}>{d.from ?? ''}</div>
          </div>
          <div className="flex flex-col gap-1 shrink-0">
            {d.url && (
              <button onClick={() => d.url && void api.openExternal(d.url)} className="text-[12px] px-2.5 py-1 rounded-lg" style={{ background: 'var(--accent-soft)', color: 'var(--accent-strong)' }}>
                打开链接
              </button>
            )}
            {item.messageId && (
              <button onClick={() => openMessage(item.messageId)} className="text-[12px] px-2.5 py-1 rounded-lg" style={{ background: 'var(--bg-soft)', color: 'var(--muted)' }}>
                原文
              </button>
            )}
            <button
              onClick={() => void api.setInsightStatus(item.id, item.status === 'done' ? 'open' : 'done').then(load)}
              className="text-[12px] px-2.5 py-1 rounded-lg"
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
    <div className="max-w-[720px] mx-auto space-y-3">
      {openItems.map(card)}
      {doneItems.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-[.08em] mb-1.5" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>已读</div>
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

  useEffect(() => {
    void api.listCompanyDomains().then(setDomains)
  }, [])

  const analyze = async (domain: string) => {
    if (!domain || running) return
    setRunning(true)
    setError('')
    const res = await api.companyInsight(domain)
    setRunning(false)
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
      <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] glass p-4">
        <div className="text-[13px] font-medium" style={{ color: 'var(--fg)' }}>发件公司分析</div>
        <div className="text-[12px] mt-0.5" style={{ color: 'var(--faint)' }}>
          输入或选择一家公司域名，AI 会按时间线剖析其运营策略，并给出品牌价值可信度与你被转化的指数
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && analyze(input)}
            placeholder="company.com"
            list="company-domain-list"
            className="flex-1 text-[13px] rounded-[10px] px-3 py-2 outline-none border border-[var(--border-soft)] selectable"
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
            className="text-[13px] font-medium px-4 py-2 rounded-[10px] disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
          >
            {running ? '分析中…' : '分析'}
          </button>
        </div>
        {error && <div className="mt-2 text-[12.5px]" style={{ color: 'var(--danger)' }}>{error}</div>}
        {domains.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {domains.slice(0, 10).map(d => (
              <button
                key={d.domain}
                onClick={() => pickExisting(d.domain)}
                className="text-[11.5px] px-2.5 py-1 rounded-full border"
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
      <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] glass p-5">
        <div className="flex items-baseline gap-2">
          <span className="text-[16px] font-semibold" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)' }}>{c.company}</span>
          <span className="text-[12px]" style={{ color: 'var(--faint)' }}>{c.domain} · {c.mailCount} 封邮件</span>
        </div>
        <div className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--muted)' }}>{c.summary}</div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ScoreCard title="品牌价值可信度" score={c.credibility.score} reasons={c.credibility.reasons} icon="🛡" />
        <ScoreCard title="你的转化指数" score={c.conversionIndex.score} reasons={c.conversionIndex.reasons} icon="🎯" />
      </div>

      <Panel title="运营策略时间线" icon="📈">
        <div className="space-y-0">
          {c.timeline.map((t, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: 'var(--accent)' }} />
                {i < c.timeline.length - 1 && <span className="w-px flex-1" style={{ background: 'var(--border)' }} />}
              </div>
              <div className="pb-3.5">
                <div className="text-[11.5px] font-medium" style={{ color: 'var(--accent-strong)', fontFamily: 'var(--font-mono)' }}>{t.period}</div>
                <div className="text-[12.5px] leading-relaxed" style={{ color: 'var(--fg)' }}>{t.event}</div>
              </div>
            </div>
          ))}
          {!c.timeline.length && <Empty text="时间线为空" />}
        </div>
      </Panel>

      <Panel title="运营策略剖析" icon="🧠">
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--fg)' }}>{c.strategy}</p>
      </Panel>
    </div>
  )
}

function ScoreCard(props: { title: string; score: number; reasons: string; icon: string }) {
  const hue = props.score >= 70 ? 'var(--ok)' : props.score >= 40 ? 'var(--warn)' : 'var(--danger)'
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] glass p-4">
      <div className="flex items-center gap-2">
        <span className="text-[15px]">{props.icon}</span>
        <span className="text-[12.5px] font-medium" style={{ color: 'var(--muted)' }}>{props.title}</span>
        <div className="flex-1" />
        <span className="text-[26px] font-bold leading-none font-[var(--font-mono)]" style={{ color: hue }}>{props.score}</span>
      </div>
      <div className="mt-2.5 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-soft)' }}>
        <div className="h-full rounded-full" style={{ width: `${props.score}%`, background: hue }} />
      </div>
      <div className="mt-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--faint)' }}>{props.reasons}</div>
    </div>
  )
}

// ================= 通用 =================

function Panel(props: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] glass p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[14px]">{props.icon}</span>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--fg)' }}>{props.title}</span>
      </div>
      {props.children}
    </div>
  )
}

function Empty(props: { text: string }) {
  return <div className="text-[12.5px] py-1" style={{ color: 'var(--faint)' }}>{props.text}</div>
}

function EmptyCard(props: { text: string }) {
  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-soft)] glass p-8 text-center text-[13px]" style={{ color: 'var(--faint)' }}>
      {props.text}
    </div>
  )
}
