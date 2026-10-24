import { useEffect, useMemo, useState } from 'react'
import { api, useMailEvent } from '../../lib/api'
import { SectionTitle, SettingRow, Toggle, Select } from './GeneralTab'
import { IconClose, IconPlus, IconRefresh, IconRss, IconSearch } from '../../components/icons'
import {
  DEFAULT_SEARCH_TEMPLATES, FEED_INTERVALS, SEARCH_API_LABEL, SEARCH_LOCALES, searchLocale,
  type FeedCandidate, type FeedSettings, type FeedSource, type SearchApiProvider, type SearchTemplate
} from '@shared/feeds'

/** 设置 → 订阅：订阅源管理、AI 搜索订阅、搜索来源与 API Key、阅读与保留、OPML */

const PROVIDERS: SearchApiProvider[] = ['brave', 'tavily', 'serpapi']

const inputCls = 'no-drag h-8 px-2.5 rounded-lg text-sm outline-none border border-[var(--border-soft)] min-w-0'
const inputStyle = { background: 'var(--surface-strong)', color: 'var(--fg)' }
const btnCls = 'no-drag h-8 px-3 rounded-lg text-xs font-medium disabled:opacity-50 shrink-0'
const primary = { background: 'var(--accent)', color: 'var(--on-accent)' }
const ghost = { background: 'var(--hover)', color: 'var(--fg)' }

function when(t: number | null | undefined): string {
  if (!t) return '从未'
  const d = new Date(t)
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function Note(props: { text: string; error?: boolean }) {
  if (!props.text) return null
  return (
    <div className="mt-2 text-xs leading-relaxed" style={{ color: props.error ? 'var(--danger)' : 'var(--muted)' }}>
      {props.text}
    </div>
  )
}

export function FeedsTab() {
  const [sources, setSources] = useState<FeedSource[]>([])
  const [s, setS] = useState<FeedSettings | null>(null)
  const [keys, setKeys] = useState<Record<SearchApiProvider, boolean>>({ brave: false, tavily: false, serpapi: false })
  const load = () => {
    void api.feedSources().then(setSources)
    void api.feedGetSettings().then(setS)
    void api.feedSearchKeys().then(setKeys)
  }
  useEffect(load, [])
  useMailEvent(ev => {
    if ((ev as { type: string }).type === 'feeds-changed') void api.feedSources().then(setSources)
  })
  const save = async (patch: Partial<FeedSettings>) => setS(await api.feedSetSettings(patch))

  if (!s) return null
  const feeds = sources.filter(x => x.kind === 'feed')
  const topics = sources.filter(x => x.kind === 'search')
  const groups = [...new Set(feeds.map(f => f.group).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b, 'zh-CN'))

  return (
    <div className="max-w-[720px]" data-feeds-settings>
      <AddSource groups={groups} onAdded={load} />
      <SourceList feeds={feeds} groups={groups} settings={s} onChanged={load} />

      <SectionTitle>AI 搜索订阅</SectionTitle>
      <p className="text-xs leading-relaxed mb-2" style={{ color: 'var(--faint)' }}>
        订阅一个主题，按每天 / 每周用新闻搜索找新结果，和历史去重后生成简报（要点 · 为什么重要 · 逐条来源链接）。只把主题词发给搜索服务，不会带上你的邮件内容；AI 简报走后台用量上限，AI 不可用时输出结果列表。
      </p>
      <AddTopic settings={s} keys={keys} onAdded={load} />
      <TopicSuggest onAdded={load} />
      <TopicList topics={topics} settings={s} keys={keys} onChanged={load} />

      <SectionTitle>搜索来源</SectionTitle>
      <TemplateEditor settings={s} onSave={t => void save({ templates: t })} />
      <ApiKeys settings={s} keys={keys} onKeys={setKeys} onBase={b => void save({ apiBase: b })} />

      <SectionTitle>阅读与保留</SectionTitle>
      <SettingRow label="默认更新频率" desc="每个订阅源也可以单独设置；失败时自动退避，最长一天重试一次">
        <Select value={String(s.defaultIntervalMin)} onChange={v => void save({ defaultIntervalMin: Number(v) })} options={FEED_INTERVALS.map(i => ({ value: String(i.value), label: i.label }))} />
      </SettingRow>
      <SettingRow label="每个订阅源最多保留" desc="超出的旧条目自动清理（收藏的不算、不会被删）">
        <Select value={String(s.maxItemsPerFeed)} onChange={v => void save({ maxItemsPerFeed: Number(v) })} options={[100, 200, 300, 500, 1000, 2000].map(n => ({ value: String(n), label: `${n} 条` }))} />
      </SettingRow>
      <SettingRow label="已读条目保留" desc="读过多少天后清理（收藏的永久保留）">
        <Select value={String(s.keepReadDays)} onChange={v => void save({ keepReadDays: Number(v) })} options={[{ value: '0', label: '不按时间清理' }, ...[7, 14, 30, 60, 90, 180].map(n => ({ value: String(n), label: `${n} 天` }))]} />
      </SettingRow>
      <SettingRow label="今日订阅精华" desc="每天 08:40 把最近 24 小时的新文章归纳成几个主题（AI 用量计入后台上限；AI 不可用时按来源列出）">
        <Toggle checked={s.digest} onChange={v => void save({ digest: v })} />
      </SettingRow>
      <SettingRow label="精华并入今日简报" desc="收件箱顶部的今日简报卡片里多一行订阅精华">
        <Toggle checked={s.digestInBrief} onChange={v => void save({ digestInBrief: v })} />
      </SettingRow>
      <SettingRow label="阅读时自动加载图片" desc="关闭时远程图片先拦截，点「显示图片」再加载">
        <Toggle checked={s.loadImages} onChange={v => void save({ loadImages: v })} />
      </SettingRow>

      <SectionTitle>OPML</SectionTitle>
      <OpmlRow count={feeds.length} onImported={load} />
    </div>
  )
}

// ---------------------------------------------------------------- 添加订阅源

function AddSource(props: { groups: string[]; onAdded(): void }) {
  const [url, setUrl] = useState('')
  const [group, setGroup] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error?: boolean }>({ text: '' })
  const [cands, setCands] = useState<FeedCandidate[]>([])
  const add = async (target: string) => {
    if (!target.trim() || busy) return
    setBusy(true)
    setMsg({ text: '' })
    const r = await api.feedAddSource({ url: target.trim(), group: group.trim() || null })
    setBusy(false)
    if (r.ok && r.source) {
      setMsg({ text: `已订阅「${r.source.title}」${r.discovered ? '（从网页自动发现）' : ''}，${r.added ?? 0} 篇` })
      setUrl('')
      setCands([])
      props.onAdded()
    } else if (r.candidates?.length) {
      setCands(r.candidates)
      setMsg({ text: r.error || '选一个订阅' })
    } else setMsg({ text: r.existing ? `已经订阅过「${r.existing.title}」` : r.error || '添加失败', error: !r.existing })
  }
  return (
    <>
      <SectionTitle>订阅源</SectionTitle>
      <form
        onSubmit={e => {
          e.preventDefault()
          void add(url)
        }}
        className="flex gap-2 mt-2"
      >
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="RSS / Atom / JSON Feed 地址，或网站地址（自动发现）" className={`${inputCls} flex-1`} style={inputStyle} data-feed-add-url />
        <input value={group} onChange={e => setGroup(e.target.value)} placeholder="分组（可选）" list="feed-groups" className={`${inputCls} w-[120px]`} style={inputStyle} />
        <datalist id="feed-groups">
          {props.groups.map(g => (
            <option key={g} value={g} />
          ))}
        </datalist>
        <button type="submit" disabled={busy || !url.trim()} className={btnCls} style={primary}>
          {busy ? '检查中…' : '添加'}
        </button>
      </form>
      <Note text={msg.text} error={msg.error} />
      {cands.length > 0 && (
        <div className="mt-2 rounded-lg border border-[var(--border-soft)] divide-y divide-[var(--border-soft)]">
          {cands.map(c => (
            <div key={c.url} className="flex items-center gap-3 px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate" style={{ color: 'var(--fg)' }}>{c.title || '（无标题）'}</div>
                <div className="text-xs truncate" style={{ color: 'var(--faint)' }}>{c.url}</div>
              </div>
              <button onClick={() => void add(c.url)} disabled={busy} className={btnCls} style={ghost}>
                订阅这个
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------- 订阅源列表

function SourceList(props: { feeds: FeedSource[]; groups: string[]; settings: FeedSettings; onChanged(): void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const byGroup = useMemo(() => {
    const m = new Map<string, FeedSource[]>()
    for (const f of props.feeds) m.set(f.group ?? '', [...(m.get(f.group ?? '') ?? []), f])
    return [...m.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'zh-CN')))
  }, [props.feeds])
  const update = async (id: string, patch: Parameters<typeof api.feedUpdateSource>[1]) => {
    await api.feedUpdateSource(id, patch)
    props.onChanged()
  }
  const refresh = async (id: string) => {
    setBusy(id)
    await api.feedRefresh([id])
    setBusy(null)
    props.onChanged()
  }
  const remove = async (f: FeedSource) => {
    if (!window.confirm(`删除订阅「${f.title}」？它的 ${f.total} 条内容（含收藏）会一起删除。`)) return
    await api.feedDeleteSource(f.id)
    props.onChanged()
  }
  if (!props.feeds.length) return <div className="mt-3 text-xs" style={{ color: 'var(--faint)' }}>还没有订阅源。</div>
  return (
    <div className="mt-3 space-y-3">
      {byGroup.map(([g, list]) => (
        <div key={g || '_'}>
          <div className="flex items-center gap-2 px-1 pb-1 text-2xs font-semibold" style={{ color: 'var(--faint)', letterSpacing: '0.04em' }}>
            {g || '未分组'} · {list.length}
            {g && (
              <button
                onClick={() => {
                  const to = window.prompt(`重命名分组「${g}」（留空 = 取消分组）`, g)
                  if (to !== null) void api.feedRenameGroup(g, to.trim() || null).then(props.onChanged)
                }}
                className="font-normal hover:underline"
                style={{ color: 'var(--accent-ink)' }}
              >
                重命名
              </button>
            )}
          </div>
          <div className="rounded-lg border border-[var(--border-soft)] divide-y divide-[var(--border-soft)]">
            {list.map(f => (
              <div key={f.id} className="px-3 py-2.5" data-feed-source={f.id}>
                <div className="flex items-center gap-2">
                  <span className="shrink-0" style={{ color: f.lastError && f.failCount ? 'var(--danger)' : 'var(--faint)' }}>
                    <IconRss width={13} height={13} />
                  </span>
                  {editing === f.id ? (
                    <input
                      autoFocus
                      defaultValue={f.title}
                      onBlur={e => {
                        setEditing(null)
                        if (e.target.value.trim() && e.target.value.trim() !== f.title) void update(f.id, { title: e.target.value.trim() })
                      }}
                      onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      className={`${inputCls} flex-1 h-7`}
                      style={inputStyle}
                    />
                  ) : (
                    <button onClick={() => setEditing(f.id)} title="点击改名" className="flex-1 min-w-0 text-left text-sm truncate" style={{ color: f.enabled ? 'var(--fg)' : 'var(--faint)' }}>
                      {f.title}
                    </button>
                  )}
                  <span className="text-2xs tnum shrink-0" style={{ color: 'var(--faint)' }}>{f.unread ? `${f.unread} 未读 · ` : ''}{f.total} 条</span>
                  <button onClick={() => void refresh(f.id)} disabled={busy === f.id} title="立即更新" className="no-drag icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--muted)' }}>
                    <IconRefresh width={13} height={13} className={busy === f.id ? 'spinning' : ''} />
                  </button>
                  <button onClick={() => void remove(f)} title="删除订阅" className="no-drag icon-btn w-7 h-7 inline-flex items-center justify-center hover:!text-[var(--danger)]" style={{ color: 'var(--faint)' }}>
                    <IconClose width={13} height={13} />
                  </button>
                </div>
                <div className="mt-0.5 pl-[21px] text-xs truncate" style={{ color: 'var(--faint)' }} title={f.url ?? ''}>
                  {f.url}
                </div>
                <div className="mt-1.5 pl-[21px] flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs" style={{ color: 'var(--muted)' }}>
                  <span style={{ color: f.lastError && f.failCount ? 'var(--danger)' : 'var(--faint)' }}>
                    {f.lastError && f.failCount ? `更新失败（${f.failCount} 次）：${f.lastError}` : `上次更新 ${when(f.lastOkAt)}`}
                  </span>
                  <span className="flex-1" />
                  <input
                    defaultValue={f.group ?? ''}
                    key={`${f.id}-${f.group}`}
                    list="feed-groups"
                    placeholder="分组"
                    onBlur={e => {
                      const v = e.target.value.trim() || null
                      if (v !== (f.group ?? null)) void update(f.id, { group: v })
                    }}
                    onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    className={`${inputCls} h-7 w-[96px] text-xs`}
                    style={inputStyle}
                  />
                  <Select
                    value={f.intervalMin == null ? '' : String(f.intervalMin)}
                    onChange={v => void update(f.id, { intervalMin: v ? Number(v) : null })}
                    options={[{ value: '', label: `默认（${FEED_INTERVALS.find(i => i.value === props.settings.defaultIntervalMin)?.label ?? `${props.settings.defaultIntervalMin} 分钟`}）` }, ...FEED_INTERVALS.map(i => ({ value: String(i.value), label: i.label }))]}
                  />
                  <label className="inline-flex items-center gap-1.5" title="只有摘要的条目点开时自动抓取原文并提取正文">
                    全文
                    <Toggle checked={f.fullText} onChange={v => void update(f.id, { fullText: v })} />
                  </label>
                  <label className="inline-flex items-center gap-1.5" title="暂停后不再自动更新">
                    启用
                    <Toggle checked={f.enabled} onChange={v => void update(f.id, { enabled: v })} />
                  </label>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- AI 搜索订阅

function sourceOptions(settings: FeedSettings, keys: Record<SearchApiProvider, boolean>): { id: string; label: string; ready: boolean }[] {
  return [
    ...settings.templates.filter(t => t.enabled).map(t => ({ id: t.id, label: t.name, ready: true })),
    ...PROVIDERS.map(p => ({ id: `api:${p}`, label: SEARCH_API_LABEL[p], ready: keys[p] }))
  ]
}

function SourcePicker(props: { value: string[]; settings: FeedSettings; keys: Record<SearchApiProvider, boolean>; onChange(v: string[]): void }) {
  const opts = sourceOptions(props.settings, props.keys)
  return (
    <div className="flex flex-wrap gap-1.5">
      {opts.map(o => {
        const on = props.value.includes(o.id)
        return (
          <button
            key={o.id}
            type="button"
            disabled={!o.ready && !on}
            title={o.ready ? o.label : `${o.label}：先在下方「搜索来源」里填 Key`}
            onClick={() => props.onChange(on ? props.value.filter(x => x !== o.id) : [...props.value, o.id])}
            className="no-drag h-7 px-2.5 rounded-full text-xs border transition-colors disabled:opacity-40"
            style={on ? { background: 'var(--selected)', borderColor: 'var(--accent)', color: 'var(--accent-ink)' } : { borderColor: 'var(--border-soft)', color: 'var(--muted)' }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** AI 从邮件统计推荐订阅主题：采样高频发件人与订阅类邮件，一键添加 */
function TopicSuggest(props: { onAdded(): void }) {
  const [busy, setBusy] = useState(false)
  const [items, setItems] = useState<{ query: string; reason: string; cadence: 'daily' | 'weekly'; added?: boolean }[]>([])
  const [msg, setMsg] = useState<{ text: string; error?: boolean }>({ text: '' })

  const ask = async () => {
    if (busy) return
    setBusy(true)
    setMsg({ text: '' })
    try {
      const r = await api.feedSuggestTopics()
      if (!r.ok) setMsg({ text: r.error ?? 'AI 暂时不可用', error: true })
      else if (!r.topics.length) setMsg({ text: 'AI 没找到足够明确的主题，先多攒一些订阅类邮件再来' })
      else setItems(r.topics.map(t => ({ ...t })))
    } finally {
      setBusy(false)
    }
  }

  const add = async (i: number) => {
    const it = items[i]
    if (!it || it.added) return
    try {
      await api.feedAddTopic({ query: it.query, cadence: it.cadence })
      setItems(items.map((x, j) => (j === i ? { ...x, added: true } : x)))
      props.onAdded()
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), error: true })
    }
  }

  return (
    <div className="mt-2">
      <button onClick={() => void ask()} disabled={busy} className={btnCls} style={ghost}>
        <IconSearch width={13} height={13} />
        {busy ? 'AI 正在读你的邮件…' : '✨ AI 从我的邮件推荐主题'}
      </button>
      {items.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {items.map((it, i) => (
            <div key={it.query} className="flex items-center gap-3 rounded-lg border border-[var(--border-soft)] px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate" style={{ color: 'var(--fg)' }}>
                  {it.query}
                  <span className="ml-2 text-xs" style={{ color: 'var(--faint)' }}>
                    {it.cadence === 'daily' ? '每天' : '每周'}
                  </span>
                </div>
                <div className="text-xs truncate" style={{ color: 'var(--faint)' }}>
                  {it.reason}
                </div>
              </div>
              <button onClick={() => void add(i)} disabled={it.added} className={`${btnCls} shrink-0`} style={it.added ? ghost : primary}>
                {it.added ? '已订阅' : '订阅'}
              </button>
            </div>
          ))}
        </div>
      )}
      <Note text={msg.text} error={msg.error} />
    </div>
  )
}

function AddTopic(props: { settings: FeedSettings; keys: Record<SearchApiProvider, boolean>; onAdded(): void }) {
  const [query, setQuery] = useState('')
  const [cadence, setCadence] = useState<'daily' | 'weekly'>('daily')
  const [locale, setLocale] = useState('zh-CN')
  const [exclude, setExclude] = useState('')
  const [srcs, setSrcs] = useState<string[]>(() => props.settings.templates.filter(t => t.enabled).map(t => t.id))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error?: boolean }>({ text: '' })
  const add = async (runNow: boolean) => {
    if (!query.trim() || busy) return
    if (!srcs.length) return setMsg({ text: '至少选一个搜索来源', error: true })
    setBusy(true)
    setMsg({ text: '' })
    try {
      const src = await api.feedAddTopic({ query: query.trim(), cadence, locale, exclude: exclude.split(/[,，、\s]+/).filter(Boolean), sources: srcs })
      setQuery('')
      setExclude('')
      props.onAdded()
      if (runNow) {
        setMsg({ text: `已订阅「${src.title}」，正在搜索…` })
        const r = await api.feedRunTopic(src.id)
        setMsg(r.ok ? { text: `已订阅「${src.title}」：找到 ${r.found} 条，${r.fresh} 条新结果${r.source === 'ai' ? '，AI 简报已生成' : r.fresh ? '（结果列表）' : ''}` } : { text: `已订阅，但首轮搜索失败：${r.error}`, error: true })
        props.onAdded()
      } else setMsg({ text: `已订阅「${src.title}」，下一轮自动任务时运行` })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-lg border border-[var(--border-soft)] p-3" data-feed-topic-form>
      <div className="flex gap-2">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="主题，如：新能源车 行业动态 / Northwind Robotics / 固态电池 论文" className={`${inputCls} flex-1`} style={inputStyle} />
        <Select value={cadence} onChange={v => setCadence(v === 'weekly' ? 'weekly' : 'daily')} options={[{ value: 'daily', label: '每天' }, { value: 'weekly', label: '每周' }]} />
        <Select value={locale} onChange={setLocale} options={SEARCH_LOCALES.map(l => ({ value: l.id, label: l.label }))} />
      </div>
      <div className="mt-2 flex gap-2">
        <input value={exclude} onChange={e => setExclude(e.target.value)} placeholder="排除词（逗号分隔，可选）" className={`${inputCls} flex-1`} style={inputStyle} />
      </div>
      <div className="mt-2.5 flex items-center gap-3">
        <span className="text-xs shrink-0" style={{ color: 'var(--faint)' }}>来源</span>
        <SourcePicker value={srcs} settings={props.settings} keys={props.keys} onChange={setSrcs} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => void add(true)} disabled={busy || !query.trim()} className={btnCls} style={primary}>
          {busy ? '搜索中…' : '订阅并立即运行'}
        </button>
        <button onClick={() => void add(false)} disabled={busy || !query.trim()} className={btnCls} style={ghost}>
          只订阅
        </button>
      </div>
      <Note text={msg.text} error={msg.error} />
    </div>
  )
}

function TopicList(props: { topics: FeedSource[]; settings: FeedSettings; keys: Record<SearchApiProvider, boolean>; onChanged(): void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const run = async (id: string) => {
    setBusy(id)
    const r = await api.feedRunTopic(id)
    setBusy(null)
    setMsg(m => ({ ...m, [id]: r.ok ? `找到 ${r.found} 条，${r.fresh} 条新结果${r.source === 'ai' ? '（AI 简报）' : ''}` : `失败：${r.error}` }))
    props.onChanged()
  }
  const update = async (id: string, topic: Parameters<typeof api.feedUpdateSource>[1]['topic']) => {
    await api.feedUpdateSource(id, { topic })
    props.onChanged()
  }
  if (!props.topics.length) return null
  return (
    <div className="mt-3 rounded-lg border border-[var(--border-soft)] divide-y divide-[var(--border-soft)]">
      {props.topics.map(t => (
        <div key={t.id} className="px-3 py-2.5" data-feed-topic={t.id}>
          <div className="flex items-center gap-2">
            <span className="shrink-0" style={{ color: 'var(--faint)' }}>
              <IconSearch width={13} height={13} />
            </span>
            <span className="flex-1 min-w-0 text-sm truncate" style={{ color: 'var(--fg)' }}>{t.title}</span>
            <span className="text-2xs tnum shrink-0" style={{ color: 'var(--faint)' }}>{t.total} 份简报</span>
            <button onClick={() => void run(t.id)} disabled={busy === t.id} className={btnCls} style={ghost}>
              {busy === t.id ? '运行中…' : '立即运行'}
            </button>
            <button
              onClick={() => {
                if (window.confirm(`删除 AI 搜索订阅「${t.title}」和它的简报？`)) void api.feedDeleteSource(t.id).then(props.onChanged)
              }}
              title="删除"
              className="no-drag icon-btn w-7 h-7 inline-flex items-center justify-center"
              style={{ color: 'var(--faint)' }}
            >
              <IconClose width={13} height={13} />
            </button>
          </div>
          {t.topic && (
            <div className="mt-1.5 pl-[21px] flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs" style={{ color: 'var(--muted)' }}>
              <Select value={t.topic.cadence} onChange={v => void update(t.id, { cadence: v === 'weekly' ? 'weekly' : 'daily' })} options={[{ value: 'daily', label: '每天' }, { value: 'weekly', label: '每周' }]} />
              <span style={{ color: 'var(--faint)' }}>{searchLocale(t.topic.locale).label}</span>
              <input
                key={`${t.id}-${t.topic.exclude.join(',')}`}
                defaultValue={t.topic.exclude.join('，')}
                placeholder="排除词"
                onBlur={e => {
                  const v = e.target.value.split(/[,，、\s]+/).filter(Boolean)
                  if (v.join(',') !== t.topic!.exclude.join(',')) void update(t.id, { exclude: v })
                }}
                onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                className={`${inputCls} h-7 w-[160px] text-xs`}
                style={inputStyle}
              />
              <span className="flex-1" />
              <span style={{ color: t.lastError ? 'var(--danger)' : 'var(--faint)' }}>{t.lastError ? `上次：${t.lastError}` : `上次运行 ${when(t.lastOkAt)}`}</span>
            </div>
          )}
          {t.topic && (
            <div className="mt-1.5 pl-[21px]">
              <SourcePicker value={t.topic.sources} settings={props.settings} keys={props.keys} onChange={v => v.length && void update(t.id, { sources: v })} />
            </div>
          )}
          {msg[t.id] && <div className="mt-1.5 pl-[21px] text-xs" style={{ color: 'var(--muted)' }}>{msg[t.id]}</div>}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- 搜索来源

function TemplateEditor(props: { settings: FeedSettings; onSave(t: SearchTemplate[]): void }) {
  const [list, setList] = useState<SearchTemplate[]>(props.settings.templates)
  useEffect(() => setList(props.settings.templates), [props.settings.templates])
  const dirty = JSON.stringify(list) !== JSON.stringify(props.settings.templates)
  const valid = list.every(t => /^https?:\/\//i.test(t.url) && t.url.includes('{q}'))
  return (
    <div className="mt-2" data-feed-templates>
      <p className="text-xs leading-relaxed mb-2" style={{ color: 'var(--faint)' }}>
        无需 Key 的新闻搜索 RSS 模板。占位符：{'{q}'} 搜索词、{'{hl}'} {'{gl}'} {'{ceid}'} {'{lang}'} {'{mkt}'} 语言地区。返回 RSS / Atom 的搜索都可以加进来。
      </p>
      <div className="space-y-2">
        {list.map((t, i) => (
          <div key={t.id} className="flex items-center gap-2">
            <Toggle checked={t.enabled} onChange={v => setList(l => l.map((x, j) => (j === i ? { ...x, enabled: v } : x)))} />
            <input value={t.name} onChange={e => setList(l => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${inputCls} w-[110px]`} style={inputStyle} />
            <input value={t.url} onChange={e => setList(l => l.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} className={`${inputCls} flex-1 font-mono text-xs`} style={inputStyle} spellCheck={false} />
            {!t.builtin && (
              <button onClick={() => setList(l => l.filter((_x, j) => j !== i))} title="删除" className="no-drag icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--faint)' }}>
                <IconClose width={13} height={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button onClick={() => setList(l => [...l, { id: `tpl-${Date.now().toString(36)}`, name: '自定义', url: 'https://', enabled: true }])} className={`${btnCls} inline-flex items-center gap-1`} style={ghost}>
          <IconPlus width={12} height={12} />
          添加来源
        </button>
        <button onClick={() => setList(DEFAULT_SEARCH_TEMPLATES)} className={btnCls} style={ghost}>
          恢复默认
        </button>
        <div className="flex-1" />
        {dirty && !valid && <span className="text-xs" style={{ color: 'var(--danger)' }}>地址需以 http(s) 开头并包含 {'{q}'}</span>}
        <button onClick={() => props.onSave(list)} disabled={!dirty || !valid} className={btnCls} style={primary}>
          保存来源
        </button>
      </div>
    </div>
  )
}

function ApiKeys(props: { settings: FeedSettings; keys: Record<SearchApiProvider, boolean>; onKeys(k: Record<SearchApiProvider, boolean>): void; onBase(b: FeedSettings['apiBase']): void }) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [base, setBase] = useState<Record<string, string>>(() => ({ ...props.settings.apiBase }) as Record<string, string>)
  const [adv, setAdv] = useState(() => Object.values(props.settings.apiBase).some(Boolean))
  return (
    <div className="mt-4" data-feed-apikeys>
      <div className="text-xs mb-1.5" style={{ color: 'var(--faint)' }}>
        搜索 API（可选，需要你自己的 Key；Key 加密保存在本机，只发给对应的搜索服务）
      </div>
      {PROVIDERS.map(p => (
        <div key={p} className="flex items-center gap-2 py-1.5">
          <span className="w-[150px] text-sm shrink-0" style={{ color: 'var(--fg)' }}>{SEARCH_API_LABEL[p]}</span>
          <span className="text-2xs w-[44px] shrink-0" style={{ color: props.keys[p] ? 'var(--ok)' : 'var(--faint)' }}>{props.keys[p] ? '已填写' : '未填写'}</span>
          <input
            type="password"
            value={draft[p] ?? ''}
            onChange={e => setDraft(d => ({ ...d, [p]: e.target.value }))}
            placeholder={props.keys[p] ? '••••••••（填新的覆盖）' : 'API Key'}
            className={`${inputCls} flex-1`}
            style={inputStyle}
            autoComplete="off"
          />
          <button
            disabled={!draft[p]?.trim()}
            onClick={() =>
              void api.feedSetSearchKey(p, draft[p].trim()).then(k => {
                props.onKeys(k)
                setDraft(d => ({ ...d, [p]: '' }))
              })
            }
            className={btnCls}
            style={primary}
          >
            保存
          </button>
          {props.keys[p] && (
            <button onClick={() => void api.feedSetSearchKey(p, null).then(props.onKeys)} className={btnCls} style={ghost}>
              清除
            </button>
          )}
        </div>
      ))}
      <button onClick={() => setAdv(a => !a)} className="mt-1 text-xs hover:underline" style={{ color: 'var(--accent-ink)' }}>
        {adv ? '收起自定义端点' : '自定义端点（代理 / 自建网关）'}
      </button>
      {adv && (
        <div className="mt-2 space-y-1.5">
          {PROVIDERS.map(p => (
            <div key={p} className="flex items-center gap-2">
              <span className="w-[150px] text-xs shrink-0" style={{ color: 'var(--muted)' }}>{SEARCH_API_LABEL[p]}</span>
              <input value={base[p] ?? ''} onChange={e => setBase(b => ({ ...b, [p]: e.target.value }))} placeholder="留空 = 官方地址" className={`${inputCls} flex-1 font-mono text-xs`} style={inputStyle} spellCheck={false} />
            </div>
          ))}
          <div className="flex justify-end">
            <button onClick={() => props.onBase(base as FeedSettings['apiBase'])} className={btnCls} style={primary}>
              保存端点
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function OpmlRow(props: { count: number; onImported(): void }) {
  const [msg, setMsg] = useState<{ text: string; error?: boolean }>({ text: '' })
  const [busy, setBusy] = useState(false)
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const r = await api.feedImportOpml()
            setBusy(false)
            if (r.canceled) return
            setMsg(r.ok ? { text: `导入 ${r.added} 个订阅源${r.skipped ? `，跳过 ${r.skipped} 个已有的` : ''}${r.failed.length ? `；${r.failed.length} 个暂时抓取失败（会自动重试）` : ''}` } : { text: r.error || '导入失败', error: true })
            props.onImported()
          }}
          className={btnCls}
          style={ghost}
        >
          {busy ? '导入中…' : '导入 OPML…'}
        </button>
        <button
          disabled={!props.count}
          onClick={async () => {
            const r = await api.feedExportOpml()
            if (r.canceled) return
            setMsg(r.ok ? { text: `已导出 ${r.count} 个订阅源到 ${r.path}` } : { text: r.error || '导出失败', error: true })
          }}
          className={btnCls}
          style={ghost}
        >
          导出 OPML…
        </button>
      </div>
      <Note text={msg.text} error={msg.error} />
    </div>
  )
}
