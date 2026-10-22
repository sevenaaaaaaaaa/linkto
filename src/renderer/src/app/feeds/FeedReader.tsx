import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { sanitizeEmailHtml } from '../../lib/sanitize'
import { askAgent } from '../../lib/agent-ask'
import { fmtFeedTime, hostOf, useFeeds } from '../../lib/feeds'
import { Markdown } from '../../components/Markdown'
import { MenuButton, type MenuItem } from '../../components/Menu'
import type { FeedItemDetail } from '@shared/feeds'
import {
  IconBook, IconCheckSquare, IconLink, IconMailDot, IconMore, IconRobot, IconSave, IconSparkles, IconStar, IconFileText, IconRefresh, IconSend
} from '../../components/icons'

/**
 * 订阅条目阅读区（独立于邮件 Reader，避免改坏它）：
 * 正文已在主进程白名单消毒，这里再走一遍邮件消毒（远程图片拦截）后放进 Shadow DOM 隔离样式；链接一律走系统浏览器。
 */

const toast = (detail: string) => window.dispatchEvent(new CustomEvent('ms:toast', { detail }))

function ToolBtn(props: { icon: React.ReactNode; label: string; onClick(): void; active?: boolean; compact?: boolean; hint?: string; disabled?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.hint ? `${props.label}（${props.hint}）` : props.label}
      aria-label={props.label}
      className={`no-drag icon-btn h-7 inline-flex items-center gap-1.5 text-xs whitespace-nowrap shrink-0 disabled:opacity-40 ${props.compact ? 'w-7 justify-center' : 'px-2'}`}
      style={{ color: props.active ? 'var(--accent-ink)' : 'var(--muted)', background: props.active ? 'var(--selected)' : undefined }}
    >
      {props.icon}
      {!props.compact && props.label}
    </button>
  )
}

function plain(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return (doc.body?.innerText || doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim()
}

export function FeedReader(props: { id: string | null }) {
  const [item, setItem] = useState<FeedItemDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'content' | 'full'>('content')
  const [fullBusy, setFullBusy] = useState(false)
  const [fullError, setFullError] = useState('')
  const [ai, setAi] = useState<{ busy: boolean; text: string; error: string }>({ busy: false, text: '', error: '' })
  const [showRemote, setShowRemote] = useState(false)
  const [remoteCount, setRemoteCount] = useState(0)
  const [compact, setCompact] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const sources = useFeeds(st => st.sources)
  const settings = useFeeds(st => st.settings)
  const listItem = useFeeds(st => st.items.find(i => i.id === props.id))
  const source = item ? sources.find(s => s.id === item.sourceId) : null

  useEffect(() => {
    const el = barRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(e => setCompact((e[0]?.contentRect.width ?? 999) < 560))
    ro.observe(el)
    return () => ro.disconnect()
  })

  // 载入条目；订阅源开了「全文」且只有摘要时自动抓原文
  useEffect(() => {
    let alive = true
    setItem(null)
    setAi({ busy: false, text: '', error: '' })
    setFullError('')
    setShowRemote(false)
    if (!props.id) return
    setLoading(true)
    void api.feedItem(props.id).then(d => {
      if (!alive) return
      setLoading(false)
      setItem(d)
      if (!d) return
      setAi({ busy: false, text: d.aiSummary ?? '', error: '' })
      const src = useFeeds.getState().sources.find(s => s.id === d.sourceId)
      if (d.fullHtml) setMode('full')
      else {
        setMode('content')
        if (src?.fullText && d.url && d.kind === 'article') void fetchFull(d)
      }
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.id])

  const fetchFull = async (d: FeedItemDetail | null = item) => {
    if (!d || fullBusy) return
    setFullBusy(true)
    setFullError('')
    const r = await api.feedFullText(d.id)
    setFullBusy(false)
    if (r.ok && r.html) {
      setItem(cur => (cur && cur.id === d.id ? { ...cur, fullHtml: r.html!, hasFull: true } : cur))
      setMode('full')
    } else setFullError(r.error || '抓取失败')
  }

  const html = item ? (mode === 'full' && item.fullHtml ? item.fullHtml : item.contentHtml) : ''

  // 渲染正文（Shadow DOM 隔离样式；CSS 变量穿透，跟随明暗与主题）
  useEffect(() => {
    const host = bodyRef.current
    if (!host) return
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    if (!item) {
      shadow.innerHTML = ''
      return
    }
    const allowRemote = !!settings?.loadImages || showRemote
    const source = html || (item.summary ? `<p>${item.summary.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)}</p>` : '<p style="color:var(--faint)">（这条没有正文，点「原文」在浏览器里看）</p>')
    const { html: safe, remoteImages } = sanitizeEmailHtml(source, { allowRemote, resolveCid: () => null })
    setRemoteCount(allowRemote ? 0 : remoteImages)
    shadow.innerHTML = `<style>
      :host { all: initial; display:block; font-family: var(--font-body); font-size: var(--reader-size, 15px); line-height:1.75; color: var(--fg); word-break: break-word; -webkit-font-smoothing: antialiased; }
      * { max-width: 100% !important; box-sizing: border-box; }
      img { height:auto; border-radius: 8px; margin: 8px 0; }
      img[data-ms-blocked] { display:none; }
      a { color: var(--accent-ink); text-underline-offset: 2px; }
      p { margin: 0.7em 0; }
      h1,h2,h3,h4 { line-height:1.35; margin: 1.1em 0 0.5em; color: var(--fg); }
      h4 { font-size: 0.95em; color: var(--muted); }
      blockquote { margin: 0.8em 0; padding: 0.2em 1em; border-left: 3px solid var(--border-strong); color: var(--muted); }
      pre, code { font-family: var(--font-mono); font-size: 0.88em; background: var(--hover); border-radius: 6px; }
      pre { padding: 10px 12px; overflow-x: auto; }
      code { padding: 1px 4px; }
      pre code { padding: 0; background: none; }
      table { border-collapse: collapse; }
      td, th { border: 1px solid var(--border-soft); padding: 4px 8px; }
      ol, ul { padding-left: 1.4em; }
      li { margin: 0.35em 0; }
      small { color: var(--faint); font-size: 0.85em; }
      em { color: var(--muted); }
      hr { border: 0; border-top: 1px solid var(--border-soft); }
    </style><div id="feed-body">${safe}</div>`
    const root = shadow.getElementById('feed-body')!
    root.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest('a')
      if (a) {
        e.preventDefault()
        if (/^https?:|^mailto:/i.test(a.href)) void api.openExternal(a.href)
      }
    })
  }, [item, html, showRemote, settings?.loadImages])

  const openOriginal = () => item?.url && void api.openExternal(item.url)

  const summarize = async (force = false) => {
    if (!item || ai.busy) return
    setAi({ busy: true, text: force ? '' : ai.text, error: '' })
    const r = await api.feedSummarize(item.id, force)
    setAi({ busy: false, text: r.text ?? '', error: r.ok ? '' : r.error || 'AI 摘要失败' })
  }

  const saveKb = async () => {
    if (!item) return
    const text = plain(item.fullHtml || item.contentHtml) || item.summary
    const content = `${ai.text ? `AI 摘要：\n${ai.text}\n\n` : ''}${text.slice(0, 8000)}\n\n来源：${item.sourceTitle}${item.url ? ` · ${item.url}` : ''}`
    await api.saveToKb({ kind: 'note', title: item.title, content, tags: ['订阅', item.sourceTitle].filter(Boolean) })
    toast('已存入知识库')
  }

  const toReading = async () => {
    if (!item) return
    const r = await api.feedToReading(item.id)
    toast(r.ok ? (r.created ? '已加入阅读清单' : '已在阅读清单里') : r.error || '没能加入阅读清单')
  }

  const toTodo = async () => {
    if (!item) return
    await api.createTodo({ title: `读：${item.title}`.slice(0, 200), data: { from: 'feed', link: item.url ?? null, notes: `来源：${item.sourceTitle}${item.url ? `\n${item.url}` : ''}${item.summary ? `\n\n${item.summary.slice(0, 300)}` : ''}` } })
    toast('已转为待办（侧栏「待办」查看）')
  }

  /** 分享：「分享与导出」中心在场时由它接管（监听 ms:share-request 并 preventDefault），否则复制链接 */
  const share = () => {
    if (!item) return
    const ev = new CustomEvent('ms:share-request', { cancelable: true, detail: { kind: 'link', title: item.title, url: item.url, text: ai.text || item.summary, source: item.sourceTitle, date: item.publishedAt, feedItemId: item.id } })
    window.dispatchEvent(ev)
    if (ev.defaultPrevented) return
    if (!item.url) return toast('这条没有原文链接')
    void navigator.clipboard.writeText(`${item.title}\n${item.url}`).then(() => toast('已复制标题和链接'))
  }

  const ask = () => {
    if (!item) return
    askAgent(
      `请帮我解读这条订阅内容：《${item.title}》（来源：${item.sourceTitle}${item.url ? `，链接：${item.url}` : ''}，订阅条目 id：${item.id}）。可以先用 feed_search 找到它并读正文，告诉我要点、和我的工作有什么关系、建议的下一步。`
    )
  }

  const toggleStar = () => item && void useFeeds.getState().toggleStar(item.id).then(() => setItem(cur => (cur ? { ...cur, starred: !cur.starred } : cur)))
  const toggleRead = () => {
    if (!item) return
    const read = !(listItem?.read ?? item.read)
    void useFeeds.getState().setRead(item.id, read)
    setItem(cur => (cur ? { ...cur, read } : cur))
  }

  // 订阅视图内的快捷键由 FeedsView 统一分发到这里
  const actRef = useRef<(a: string) => void>(() => {})
  actRef.current = (a: string) => {
    if (a === 'open') openOriginal()
    else if (a === 'full') void (item?.fullHtml ? setMode(m => (m === 'full' ? 'content' : 'full')) : fetchFull())
    else if (a === 'summary') void summarize()
  }
  useEffect(() => {
    const on = (e: Event) => actRef.current((e as CustomEvent<string>).detail)
    window.addEventListener('ms:feed-action', on)
    return () => window.removeEventListener('ms:feed-action', on)
  }, [])

  const moreItems: MenuItem[] = useMemo(
    () => [
      { kind: 'action', label: '加入阅读清单', icon: <IconBook width={13} height={13} />, onSelect: () => void toReading() },
      { kind: 'action', label: '转为待办', icon: <IconCheckSquare width={13} height={13} />, onSelect: () => void toTodo() },
      { kind: 'action', label: '存入知识库', icon: <IconSave width={13} height={13} />, onSelect: () => void saveKb() },
      { kind: 'sep' },
      { kind: 'action', label: '分享…', icon: <IconSend width={13} height={13} />, disabled: !item, onSelect: share },
      { kind: 'action', label: '复制链接', icon: <IconLink width={13} height={13} />, disabled: !item?.url, onSelect: () => item?.url && void navigator.clipboard.writeText(item.url).then(() => toast('已复制链接')) },
      { kind: 'sep' },
      ...(ai.text ? [{ kind: 'action' as const, label: '重新生成 AI 摘要', icon: <IconSparkles width={13} height={13} />, onSelect: () => void summarize(true) }] : []),
      ...(item?.url && item.kind === 'article' ? [{ kind: 'action' as const, label: item.fullHtml ? '重新显示全文' : '抓取全文', icon: <IconFileText width={13} height={13} />, hint: 'F', onSelect: () => void fetchFull() }] : [])
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item, ai.text]
  )

  if (!props.id) {
    return (
      <div className="flex-1 min-w-0 h-full flex flex-col">
        <div className="drag-region native-web-titlebar h-[var(--titlebar-h)] shrink-0 border-b border-[var(--border-soft)]" />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center px-6 text-balance">
            <div className="text-md font-medium" style={{ color: 'var(--faint)' }}>选择一条订阅开始阅读</div>
            <div className="mt-1.5 text-xs" style={{ color: 'var(--faint)', opacity: 0.75 }}>
              J/K 切换 · S 收藏 · M 已读 / 未读 · O 打开原文 · F 全文 · ⇧A 全部已读
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!item) {
    return (
      <div className="flex-1 min-w-0 h-full flex flex-col">
        <div className="drag-region native-web-titlebar h-[var(--titlebar-h)] shrink-0 border-b border-[var(--border-soft)]" />
        <div className="px-6 pt-5 space-y-3">
          {loading ? (
            <>
              <div className="h-[24px] w-[60%] rounded-lg shimmer" />
              <div className="h-[12px] w-[30%] rounded-sm shimmer" />
              <div className="h-[180px] rounded-[var(--r-md)] shimmer" />
            </>
          ) : (
            <div className="text-sm" style={{ color: 'var(--faint)' }}>这条已经不在了（可能被保留策略清理）</div>
          )}
        </div>
      </div>
    )
  }

  const read = listItem?.read ?? item.read
  const starred = listItem?.starred ?? item.starred
  const canFull = item.kind === 'article' && !!item.url

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col relative" data-feed-reader>
      <div ref={barRef} className="drag-region h-[var(--titlebar-h)] shrink-0 flex items-center gap-0.5 px-4 border-b border-[var(--border-soft)]">
        <button
          onClick={openOriginal}
          disabled={!item.url}
          title="在浏览器打开原文（O）"
          className="no-drag h-8 px-3 rounded-[var(--r-sm)] inline-flex items-center gap-1.5 text-xs font-semibold mr-1.5 transition-transform active:scale-95 disabled:opacity-40"
          style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
        >
          <IconLink width={13} height={13} />
          {!compact && '原文'}
        </button>
        <ToolBtn icon={<IconStar width={14} height={14} />} label={starred ? '已收藏' : '收藏'} hint="S" onClick={toggleStar} active={starred} compact={compact} />
        <ToolBtn icon={<IconMailDot width={14} height={14} />} label={read ? '标未读' : '标已读'} hint="M" onClick={toggleRead} compact={compact} />
        <ToolBtn icon={<IconSparkles width={14} height={14} />} label="AI 摘要" onClick={() => void summarize()} active={!!ai.text || ai.busy} compact={compact} />
        {canFull && (
          <ToolBtn
            icon={<IconFileText width={14} height={14} />}
            label={fullBusy ? '抓取中…' : item.fullHtml ? (mode === 'full' ? '看摘要' : '看全文') : '抓全文'}
            hint="F"
            onClick={() => (item.fullHtml ? setMode(m => (m === 'full' ? 'content' : 'full')) : void fetchFull())}
            active={mode === 'full'}
            disabled={fullBusy}
            compact={compact}
          />
        )}
        <div className="flex-1" />
        <ToolBtn icon={<IconBook width={14} height={14} />} label="阅读清单" onClick={() => void toReading()} compact />
        <ToolBtn icon={<IconSave width={14} height={14} />} label="存知识库" onClick={() => void saveKb()} compact />
        <ToolBtn icon={<IconCheckSquare width={14} height={14} />} label="转待办" onClick={() => void toTodo()} compact />
        <ToolBtn icon={<IconRobot width={14} height={14} />} label="问 Agent" onClick={ask} compact />
        <MenuButton title="更多操作" items={moreItems} width={220}>
          <IconMore width={15} height={15} />
        </MenuButton>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 pt-5 pb-3 mx-auto" style={{ maxWidth: 'calc(var(--reader-max) + 48px)' }}>
          <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--faint)' }}>
            <span className="truncate font-medium" style={{ color: 'var(--accent-ink)' }}>{item.sourceTitle || hostOf(item.url)}</span>
            {item.kind === 'brief' && <span className="text-2xs px-1.5 h-4 inline-flex items-center rounded-[var(--r-xs)] ai-chip">{item.results ? `AI 搜索 · ${item.results.length} 条结果` : 'AI 搜索'}</span>}
            {item.author && <span className="truncate">· {item.author}</span>}
            <span className="ml-auto shrink-0 tnum" style={{ fontFamily: 'var(--font-mono)' }} title={new Date(item.publishedAt ?? item.sortAt).toLocaleString()}>
              {fmtFeedTime(item.publishedAt ?? item.sortAt)}
            </span>
          </div>
          <h1 className="selectable mt-2 text-lg font-semibold leading-snug" style={{ color: 'var(--fg)', fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}>
            {item.title}
          </h1>
          {item.url && (
            <button onClick={openOriginal} className="mt-1 max-w-full truncate text-xs hover:underline text-left" style={{ color: 'var(--faint)' }} title={item.url}>
              {hostOf(item.url)}
            </button>
          )}

          {(ai.text || ai.busy || ai.error) && (
            <div className="mt-4 rounded-[var(--r-md)] px-4 py-3" style={{ background: 'var(--ai-soft)' }}>
              <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--muted)' }}>
                <IconSparkles width={12} height={12} style={{ color: 'var(--ai-line)' }} />
                AI 摘要
                {ai.busy && <IconRefresh width={11} height={11} className="spinning" />}
              </div>
              {ai.error ? (
                <div className="mt-1.5 text-sm" style={{ color: 'var(--danger)' }}>
                  {ai.error}
                  {/AI 未配置/.test(ai.error) && (
                    <button onClick={() => api.openSettings('ai')} className="ml-2 underline" style={{ color: 'var(--accent-ink)' }}>
                      去配置
                    </button>
                  )}
                </div>
              ) : (
                <div className="selectable mt-1.5 text-sm leading-relaxed" style={{ color: 'var(--fg)' }}>
                  {ai.text ? <Markdown text={ai.text} /> : <span style={{ color: 'var(--faint)' }}>正在阅读…</span>}
                </div>
              )}
            </div>
          )}

          {item.enclosures.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {item.enclosures.map(e => (
                <button key={e.url} onClick={() => void api.openExternal(e.url)} className="h-7 px-2.5 rounded-[var(--r-sm)] text-xs inline-flex items-center gap-1.5 border border-[var(--border-soft)] hover:bg-[var(--hover)]" style={{ color: 'var(--muted)' }} title={e.url}>
                  <IconLink width={12} height={12} />
                  {(e.type?.split('/')[0] === 'audio' ? '音频' : e.type?.split('/')[0] === 'video' ? '视频' : e.type?.startsWith('image') ? '图片' : '附件') + (e.length ? ` · ${Math.round(e.length / 1024 / 1024) || '<1'} MB` : '')}
                </button>
              ))}
            </div>
          )}

          {(fullError || fullBusy) && (
            <div className="mt-3 text-xs rounded-[var(--r-sm)] px-3.5 py-2.5 flex items-center gap-2" style={{ background: fullError ? 'var(--warn-soft)' : 'var(--hover)', color: 'var(--muted)' }}>
              {fullBusy ? '正在抓取原文并提取正文…' : `全文抓取失败：${fullError}`}
              {fullError && item.url && (
                <button onClick={openOriginal} className="ml-auto shrink-0 hover:underline" style={{ color: 'var(--accent-ink)' }}>
                  在浏览器打开
                </button>
              )}
            </div>
          )}
          {remoteCount > 0 && (
            <div className="mt-3 flex items-center gap-2 text-xs rounded-[var(--r-sm)] px-3.5 py-2.5" style={{ background: 'var(--hover)', color: 'var(--muted)' }}>
              <span>已拦截 {remoteCount} 张远程图片</span>
              <button onClick={() => setShowRemote(true)} className="ml-auto hover:underline shrink-0" style={{ color: 'var(--accent-ink)' }}>
                显示图片
              </button>
            </div>
          )}
          {mode === 'full' && item.fullHtml && (
            <div className="mt-3 text-2xs caps" style={{ color: 'var(--faint)' }}>
              全文 · 从原文网页提取{source?.fullText ? '（此订阅源自动抓取）' : ''}
            </div>
          )}
        </div>
        <div className="px-6 pb-10">
          <div className="mx-auto rounded-[var(--r-md)]" style={{ maxWidth: 'var(--reader-max)', background: 'var(--surface-strong)', border: '1px solid var(--border-soft)', padding: '20px 24px' }}>
            <div ref={bodyRef} className="selectable" />
          </div>
        </div>
      </div>
    </div>
  )
}
