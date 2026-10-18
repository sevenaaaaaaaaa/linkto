import { useEffect, useState } from 'react'
import { api, useAsync, fmtFullDate } from '../../lib/api'
import { IconSearch, IconClose, IconPlus, IconSave, IconPin, IconHeart, IconUsers, IconBellRing, IconRefresh, IconUser } from '../../components/icons'
import type { AgentMemory, ContactProfile, MemoryScope } from '@shared/types'
import { AIErrorNote } from '../../components/AIErrorNote'
import { btn, btnStyle, btnPrimary, btnPrimaryStyle, Chip, type Tone } from '../finance/ui'
import { fieldCls, fieldSty } from './skill-ui'

export const SCOPE_META: Record<MemoryScope, { label: string; icon: React.ReactNode; tone: Tone }> = {
  fact: { label: '事实', icon: <IconPin width={11} height={11} />, tone: 'info' },
  preference: { label: '偏好', icon: <IconHeart width={11} height={11} />, tone: 'warn' },
  person: { label: '人物关系', icon: <IconUsers width={11} height={11} />, tone: 'ok' },
  commitment: { label: '承诺', icon: <IconBellRing width={11} height={11} />, tone: 'danger' },
  routine: { label: '惯例', icon: <IconRefresh width={11} height={11} />, tone: 'muted' }
}

const FILTERS: (MemoryScope | 'all')[] = ['all', 'fact', 'preference', 'person', 'commitment', 'routine']

/** Agent 记忆页：长期记忆（分域过滤、搜索、编辑、归档）+ 发件人画像 —— 由旧 AgentView 迁移，样式改走 token */
export function MemoryPage(props: { onStatsChange?(): void }) {
  const [scope, setScope] = useState<MemoryScope | 'all'>('all')
  const [q, setQ] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const { data: memories, reload } = useAsync(() => api.listMemories(scope), [scope])
  const { data: stats, reload: reloadStats } = useAsync(() => api.memoryStats(), [scope])
  const [editing, setEditing] = useState<AgentMemory | null>(null)
  const [creating, setCreating] = useState(false)
  const [profileAddr, setProfileAddr] = useState('')
  const [profile, setProfile] = useState<ContactProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState('')

  const reloadAll = () => {
    reload()
    reloadStats()
    props.onStatsChange?.()
  }

  useEffect(() => {
    return api.onEvent(ev => {
      if ((ev as { type: string }).type === 'agent-changed') reloadAll()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const all = memories ?? []
  const archivedCount = all.filter(m => m.status === 'archived').length
  const filtered = all.filter(m => {
    if ((m.status === 'archived') !== showArchived) return false
    if (!q.trim()) return true
    return `${m.title} ${m.content} ${m.entity}`.toLowerCase().includes(q.toLowerCase())
  })

  const runProfile = async () => {
    const addr = profileAddr.trim()
    if (!addr || profileLoading) return
    setProfileLoading(true)
    setProfileError('')
    setProfile(null)
    const res = await api.agentProfile(addr).catch(e => ({ ok: false as const, error: String(e), profile: undefined }))
    setProfileLoading(false)
    if (res.ok && res.profile) {
      setProfile(res.profile)
      reloadAll()
    } else setProfileError(res.error ?? '生成失败')
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 工具条：分域过滤 · 搜索 · 画像 · 记一条 */}
      <div className="shrink-0 px-6 pt-3 pb-2 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map(f => {
            const active = scope === f
            const count = f === 'all' ? stats?.total : stats?.byScope?.[f]
            return (
              <button
                key={f}
                onClick={() => setScope(f)}
                aria-pressed={active}
                className="h-7 px-2.5 rounded-[var(--r-sm)] text-xs inline-flex items-center gap-1 border"
                style={
                  active
                    ? { background: 'var(--selected)', color: 'var(--accent-ink)', borderColor: 'var(--border-strong)', fontWeight: 600 }
                    : { background: 'var(--surface-strong)', color: 'var(--muted)', borderColor: 'var(--border)' }
                }
              >
                {f !== 'all' && SCOPE_META[f].icon}
                {f === 'all' ? '全部' : SCOPE_META[f].label}
                {typeof count === 'number' && (
                  <span className="tnum text-2xs" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <span className="flex-1" />
        <label className="h-8 px-2.5 flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border)] focus-within:border-[var(--border-strong)] w-52" style={{ background: 'var(--surface-strong)' }}>
          <IconSearch width={13} height={13} style={{ color: 'var(--faint)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索记忆" className="flex-1 min-w-0 bg-transparent outline-none text-sm" style={{ color: 'var(--fg)' }} />
        </label>
        <button className={btnPrimary} style={btnPrimaryStyle} onClick={() => setCreating(true)}>
          <IconPlus width={13} height={13} /> 记一条
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {/* 发件人画像 */}
        <section className="mt-1 mb-4 rounded-[var(--r-md)] border border-[var(--border)] px-4 py-3" style={{ background: 'var(--surface-strong)' }}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--fg)' }}>
              <IconUser width={13} height={13} /> 发件人画像
            </span>
            <span className="text-xs" style={{ color: 'var(--faint)' }}>输入邮箱或域名，Agent 读完往来后生成画像，关键事实会沉淀为人物记忆</span>
            <span className="flex-1" />
            <input
              value={profileAddr}
              onChange={e => setProfileAddr(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void runProfile()}
              placeholder="如 lin@northwind.example 或 northwind.example"
              className={`${fieldCls} !w-64 !h-7 !text-xs`}
              style={fieldSty}
            />
            <button className={btn} style={btnStyle} disabled={profileLoading || !profileAddr.trim()} onClick={() => void runProfile()}>
              {profileLoading ? '分析中…' : '生成画像'}
            </button>
          </div>
          {(profile || profileError) && (
            <div className="mt-3 pt-3 border-t border-[var(--border-soft)]">
              {profileError ? (
                <AIErrorNote error={profileError} onRetry={() => void runProfile()} />
              ) : profile ? (
                <>
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <span className="text-base font-semibold" style={{ color: 'var(--fg)' }}>{profile.displayName}</span>
                    <span className="text-xs" style={{ color: 'var(--faint)' }}>{profile.addr}</span>
                    <Chip>{profile.mailCount} 封往来</Chip>
                    <Chip>我的回复率 {profile.myReplyRate}%</Chip>
                    <span className="flex-1" />
                    <button
                      onClick={() => {
                        setProfile(null)
                        setProfileError('')
                      }}
                      aria-label="关闭画像"
                      className="icon-btn w-6 h-6 inline-flex items-center justify-center"
                      style={{ color: 'var(--faint)' }}
                    >
                      <IconClose width={12} height={12} />
                    </button>
                  </div>
                  <p className="text-sm leading-relaxed selectable" style={{ color: 'var(--fg)' }}>{profile.summary}</p>
                  {profile.topTopics.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {profile.topTopics.map(t => (
                        <Chip key={t} tone="ai">{t}</Chip>
                      ))}
                    </div>
                  )}
                  {profile.keyFacts.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {profile.keyFacts.map(f => (
                        <li key={f} className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>· {f}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 text-2xs" style={{ color: 'var(--faint)' }}>
                    首次联系 {fmtFullDate(profile.firstContact)} · 最近 {fmtFullDate(profile.lastContact)} · 关键事实已沉淀为人物记忆
                  </div>
                </>
              ) : null}
            </div>
          )}
        </section>

        {/* 最常用记忆 */}
        {scope === 'all' && !showArchived && stats?.topUsed?.length ? (
          <div className="mb-3 flex items-center gap-1.5 flex-wrap">
            <span className="text-xs" style={{ color: 'var(--faint)' }}>Agent 最常用：</span>
            {stats.topUsed.map(m => (
              <button key={m.id} onClick={() => setEditing(m)} title={m.content} className="max-w-[220px]">
                <Chip>
                  {SCOPE_META[m.scope]?.icon}
                  <span className="truncate">{m.title}</span>
                </Chip>
              </button>
            ))}
          </div>
        ) : null}

        {!filtered.length && (
          <div className="mt-20 text-center text-sm leading-relaxed" style={{ color: 'var(--faint)' }}>
            {showArchived ? (
              '没有已归档的记忆。'
            ) : scope === 'all' && !q ? (
              <>
                Agent 的记忆还是空的。
                <br />
                阅读邮件时在右侧栏点「从这封邮件学习」，或运行技能时让它记住要点，Agent 会越来越懂你。
              </>
            ) : (
              '没有匹配的记忆。'
            )}
          </div>
        )}

        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {filtered.map(m => {
            const meta = SCOPE_META[m.scope] ?? SCOPE_META.fact
            return (
              <article key={m.id} className="group rounded-[var(--r-md)] border border-[var(--border)] p-4 flex flex-col hover:border-[var(--border-strong)] transition-colors" style={{ background: 'var(--surface-strong)' }}>
                <div className="flex items-center gap-1.5 mb-1.5 min-w-0">
                  <Chip tone={meta.tone}>
                    {meta.icon} {meta.label}
                  </Chip>
                  {m.source === 'manual' && <Chip>手动</Chip>}
                  {m.entity && <span className="text-2xs truncate max-w-[140px]" style={{ color: 'var(--faint)' }}>{m.entity}</span>}
                  <span className="flex-1" />
                  <span className="text-2xs tnum shrink-0" title="被 Agent 引用的次数" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>×{m.useCount}</span>
                </div>
                <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>{m.title}</div>
                <div className="mt-1 text-xs leading-relaxed line-clamp-4 selectable" style={{ color: 'var(--muted)' }}>{m.content}</div>
                <div className="mt-auto pt-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <span className="text-2xs" style={{ color: 'var(--faint)' }}>{fmtFullDate(m.updatedAt)}</span>
                  <span className="flex-1" />
                  <MiniBtn onClick={() => setEditing(m)}>编辑</MiniBtn>
                  <MiniBtn
                    onClick={async () => {
                      await api.updateMemory(m.id, { status: m.status === 'archived' ? 'active' : 'archived' })
                      reloadAll()
                    }}
                  >
                    {m.status === 'archived' ? '恢复' : '归档'}
                  </MiniBtn>
                  <MiniBtn
                    danger
                    onClick={async () => {
                      await api.deleteMemory(m.id)
                      reloadAll()
                    }}
                  >
                    删除
                  </MiniBtn>
                </div>
              </article>
            )
          })}
        </div>

        {(archivedCount > 0 || showArchived) && (
          <button onClick={() => setShowArchived(s => !s)} className="mt-4 text-xs underline underline-offset-2" style={{ color: 'var(--muted)' }}>
            {showArchived ? '← 返回记忆' : `查看 ${archivedCount} 条已归档`}
          </button>
        )}
      </div>

      {(editing || creating) && (
        <MemoryEditor
          item={editing}
          defaultScope={scope === 'all' ? 'fact' : scope}
          onClose={() => {
            setEditing(null)
            setCreating(false)
            reloadAll()
          }}
        />
      )}
    </div>
  )
}

function MiniBtn(props: { children: React.ReactNode; onClick(): void; danger?: boolean }) {
  return (
    <button onClick={props.onClick} className="h-6 px-2 rounded-[var(--r-xs)] text-2xs hover:bg-[var(--hover)]" style={{ color: props.danger ? 'var(--danger-ink)' : 'var(--muted)' }}>
      {props.children}
    </button>
  )
}

function MemoryEditor(props: { item: AgentMemory | null; defaultScope: MemoryScope; onClose(): void }) {
  const [scope, setScope] = useState<MemoryScope>(props.item?.scope ?? props.defaultScope)
  const [title, setTitle] = useState(props.item?.title ?? '')
  const [content, setContent] = useState(props.item?.content ?? '')
  const [entity, setEntity] = useState(props.item?.entity ?? '')

  const save = async () => {
    if (!title.trim()) return
    if (props.item) {
      await api.updateMemory(props.item.id, { title, content, scope })
      if (entity !== props.item.entity) {
        // entity 变更走删除重建（upsert 以 entity+title 去重）
        await api.deleteMemory(props.item.id)
        await api.saveMemory({ scope, title, content, entity })
      }
    } else {
      await api.saveMemory({ scope, title, content, entity })
    }
    props.onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 fade-in" style={{ background: 'var(--scrim)' }} onMouseDown={props.onClose}>
      <div
        role="dialog"
        aria-label={props.item ? '编辑记忆' : '记一条'}
        className="w-[520px] max-w-full rounded-[var(--r-md)] border border-[var(--border)] flex flex-col overflow-hidden pop-in"
        style={{ background: 'var(--surface-strong)', boxShadow: 'var(--shadow-float)' }}
        onMouseDown={e => e.stopPropagation()}
        onKeyDown={e => e.key === 'Escape' && props.onClose()}
      >
        <div className="px-5 py-3.5 border-b border-[var(--border-soft)] flex items-center gap-2">
          <span className="text-md font-semibold" style={{ color: 'var(--fg)' }}>{props.item ? '编辑记忆' : '记一条'}</span>
          <span className="flex-1" />
          <select value={scope} onChange={e => setScope(e.target.value as MemoryScope)} className={`${fieldCls} !w-auto !h-7 !text-xs`} style={fieldSty}>
            {FILTERS.filter((f): f is MemoryScope => f !== 'all').map(f => (
              <option key={f} value={f}>
                {SCOPE_META[f].label}
              </option>
            ))}
          </select>
        </div>
        <div className="px-5 py-4 flex flex-col gap-3">
          <input autoFocus value={title} onChange={e => setTitle(e.target.value)} className={`${fieldCls} !h-9 !text-base font-medium`} style={fieldSty} placeholder="标题，如：合作方坚持用邮件确认" />
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            className="w-full h-28 resize-none text-sm leading-relaxed outline-none px-2.5 py-2 rounded-[var(--r-sm)] border border-[var(--border)] focus:border-[var(--border-strong)]"
            style={fieldSty}
            placeholder="记忆内容（会被 Agent 在起草 / 问答 / 技能中主动参考）"
          />
          <input value={entity} onChange={e => setEntity(e.target.value)} className={`${fieldCls} !text-xs`} style={fieldSty} placeholder="关联实体（可选）：邮箱或域名，如 boss@acme.example" />
        </div>
        <div className="px-5 py-3 border-t border-[var(--border-soft)] flex justify-end gap-2">
          <button className={btn} style={btnStyle} onClick={props.onClose}>取消</button>
          <button className={btnPrimary} style={btnPrimaryStyle} disabled={!title.trim()} onClick={() => void save()}>
            <IconSave width={12} height={12} /> 保存
          </button>
        </div>
      </div>
    </div>
  )
}
