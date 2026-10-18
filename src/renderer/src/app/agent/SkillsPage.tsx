import { useMemo, useState } from 'react'
import { useSkills, sortSkills, categoryOrder, OUTPUT_LABEL, scheduleLabel, requestSkillRun } from '../../lib/agent-skills'
import { IconSearch, IconPlus, IconPin, IconPlay, IconClock, IconMailDot } from '../../components/icons'
import type { AgentSkill } from '@shared/types'
import { btn, btnStyle, btnPrimary, btnPrimaryStyle, Chip, SectionTitle } from '../finance/ui'
import { SkillIcon, paramSummary } from './skill-ui'
import { SkillEditor } from './SkillEditor'

/** 技能库：按分类分组的卡片；搜索、钉住、运行（参数卡 → 对话页）、复制为自定义、新建 / 编辑 */
export function SkillsPage() {
  const skills = useSkills(st => st.skills)
  const fallback = useSkills(st => st.fallback)
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<string>('all')
  const [editing, setEditing] = useState<{ skill: AgentSkill | null; copy?: boolean } | null>(null)

  const categories = useMemo(() => [...new Set(skills.map(s => s.category))].sort((a, b) => categoryOrder(a) - categoryOrder(b)), [skills])
  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase()
    return sortSkills(skills).filter(s => {
      if (cat === 'pinned' ? !s.pinned : cat !== 'all' && s.category !== cat) return false
      if (!k) return true
      return `${s.name} ${s.description} ${s.category} ${(s.params ?? []).map(p => p.label).join(' ')}`.toLowerCase().includes(k)
    })
  }, [skills, q, cat])
  const groups = useMemo(() => {
    const m = new Map<string, AgentSkill[]>()
    for (const s of filtered) m.set(s.category, [...(m.get(s.category) ?? []), s])
    return [...m.entries()]
  }, [filtered])
  const pinnedCount = skills.filter(s => s.pinned).length

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-6 pt-3 pb-2 flex flex-wrap items-center gap-2">
        <label className="h-8 px-2.5 flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border)] focus-within:border-[var(--border-strong)] min-w-[200px] flex-1 max-w-[320px]" style={{ background: 'var(--surface-strong)' }}>
          <IconSearch width={13} height={13} style={{ color: 'var(--faint)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={`搜索 ${skills.length} 个技能`} className="flex-1 min-w-0 bg-transparent outline-none text-sm" style={{ color: 'var(--fg)' }} />
        </label>
        <div className="flex flex-wrap gap-1">
          {[{ v: 'all', l: '全部' }, { v: 'pinned', l: `已钉住 ${pinnedCount}` }, ...categories.map(c => ({ v: c, l: c }))].map(o => (
            <button
              key={o.v}
              onClick={() => setCat(o.v)}
              aria-pressed={cat === o.v}
              className="h-7 px-2.5 rounded-[var(--r-sm)] text-xs"
              style={cat === o.v ? { background: 'var(--selected)', color: 'var(--accent-ink)', fontWeight: 600 } : { color: 'var(--muted)' }}
            >
              {o.l}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button className={btnPrimary} style={btnPrimaryStyle} onClick={() => setEditing({ skill: null })}>
          <IconPlus width={13} height={13} /> 新建技能
        </button>
      </div>

      {fallback && (
        <div className="mx-6 mb-1 px-3 py-2 rounded-[var(--r-sm)] text-xs" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
          Agent 运行时尚未就绪：正在显示内置技能目录，钉住与编辑只在本次打开期间有效。
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 pb-8">
        {!filtered.length && (
          <div className="mt-20 text-center text-sm" style={{ color: 'var(--faint)' }}>
            没有匹配的技能。
            <button className="ml-1 underline underline-offset-2" style={{ color: 'var(--muted)' }} onClick={() => setEditing({ skill: null })}>
              新建一个 →
            </button>
          </div>
        )}
        {groups.map(([category, list]) => (
          <section key={category} className="mt-2">
            <SectionTitle count={list.length}>{category}</SectionTitle>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2.5">
              {list.map(s => (
                <SkillCard key={s.id} skill={s} onEdit={() => setEditing({ skill: s })} onCopy={() => setEditing({ skill: s, copy: true })} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {editing && <SkillEditor skill={editing.skill} copy={editing.copy} onClose={() => setEditing(null)} />}
    </div>
  )
}

function SkillCard(props: { skill: AgentSkill; onEdit(): void; onCopy(): void }) {
  const s = props.skill
  const togglePin = useSkills(st => st.togglePin)
  const sched = scheduleLabel(s.schedule)
  const params = paramSummary(s)
  return (
    <article
      className="group rounded-[var(--r-md)] border border-[var(--border)] p-3.5 flex flex-col gap-2 hover:border-[var(--border-strong)] transition-colors"
      style={{ background: 'var(--surface-strong)' }}
    >
      <div className="flex items-start gap-2.5">
        <span className="w-8 h-8 shrink-0 rounded-[var(--r-sm)] inline-flex items-center justify-center" style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}>
          <SkillIcon name={s.icon} width={15} height={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--fg)' }}>{s.name}</h3>
            {!s.builtin && <Chip>自定义</Chip>}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed line-clamp-2" style={{ color: 'var(--muted)' }}>{s.description}</p>
        </div>
        <button
          onClick={() => void togglePin(s.id)}
          aria-pressed={!!s.pinned}
          title={s.pinned ? '已钉在侧栏 Agent 下（点击取消）' : '钉到侧栏 Agent 下'}
          className={`icon-btn w-7 h-7 shrink-0 inline-flex items-center justify-center ${s.pinned ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
          style={{ color: s.pinned ? 'var(--fg)' : 'var(--faint)' }}
        >
          <IconPin width={13} height={13} fill={s.pinned ? 'currentColor' : 'none'} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {s.output && <Chip>{OUTPUT_LABEL[s.output]}</Chip>}
        {s.contextKind === 'message' && (
          <Chip title="需要针对一封邮件运行：在阅读页右侧栏 Agent 里也能一键使用">
            <IconMailDot width={10} height={10} /> 针对邮件
          </Chip>
        )}
        {sched && (
          <Chip tone="info" title="定时运行，结果写进活动记录">
            <IconClock width={10} height={10} /> {sched}
          </Chip>
        )}
        {params && (
          <span className="text-2xs truncate min-w-0" style={{ color: 'var(--faint)' }} title={`参数：${params}`}>
            参数：{params}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 pt-0.5">
        <button className={`${btnPrimary} !h-7`} style={btnPrimaryStyle} onClick={() => requestSkillRun({ skill: s, always: true })}>
          <IconPlay width={10} height={10} /> 运行
        </button>
        <span className="flex-1" />
        <button className={`${btn} !h-7 !font-normal opacity-0 group-hover:opacity-100 focus:opacity-100`} style={btnStyle} onClick={props.onCopy}>
          复制为自定义
        </button>
        <button className={`${btn} !h-7 !font-normal opacity-0 group-hover:opacity-100 focus:opacity-100`} style={btnStyle} onClick={props.onEdit}>
          {s.builtin ? '设置' : '编辑'}
        </button>
      </div>
    </article>
  )
}
