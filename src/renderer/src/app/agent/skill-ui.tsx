import { useEffect, useMemo, useRef, useState, type SVGProps } from 'react'
import * as Icons from '../../components/icons'
import { api } from '../../lib/api'
import { useMail } from '../../stores/mail'
import { useProjects, isLive } from '../../lib/projects'
import { defaultParams, launchSkill, OUTPUT_LABEL, type SkillParams, type SkillRunRequest } from '../../lib/agent-skills'
import type { AgentSkill, AgentSkillParam } from '@shared/types'
import type { RecipientSuggestion } from '@shared/ipc'
import { btn, btnStyle, btnPrimary, btnPrimaryStyle, Chip } from '../finance/ui'

/** 技能图标：AgentSkill.icon 是 icons.tsx 组件名去掉 Icon 前缀；找不到时用 Sparkles */
export function SkillIcon(props: { name?: string | null } & SVGProps<SVGSVGElement>) {
  const { name, ...rest } = props
  const map = Icons as unknown as Record<string, ((p: SVGProps<SVGSVGElement>) => React.ReactElement) | undefined>
  const C = (name && map[`Icon${name}`]) || Icons.IconSparkles
  return <C {...rest} />
}

/** 编辑器里可选的图标（技能语义常用的一组） */
export const SKILL_ICON_CHOICES = [
  'Sparkles', 'Sunrise', 'Moon', 'Hourglass', 'Send', 'Archive', 'Unsub', 'Flag', 'Users', 'Heart', 'Calendar', 'BellRing',
  'Layers', 'Briefcase', 'TrendingUp', 'Refresh', 'Receipt', 'Building', 'Attach', 'FileText', 'Book', 'Rss', 'Plane', 'Package',
  'Reply', 'CheckSquare', 'Forward', 'Compose', 'Shield', 'Landmark', 'Target', 'Search', 'Brain', 'Zap'
]

export const fieldCls = 'w-full h-8 px-2.5 rounded-[var(--r-sm)] border border-[var(--border)] text-sm outline-none focus:border-[var(--border-strong)]'
export const fieldSty = { background: 'var(--surface-strong)', color: 'var(--fg)' }

/** 单个参数的输入控件（参数卡与编辑器预览共用） */
export function ParamField(props: { param: AgentSkillParam; value: string | number | undefined; onChange(v: string | number): void; autoFocus?: boolean }) {
  const p = props.param
  const v = props.value ?? ''
  if (p.kind === 'days') {
    return (
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          min={1}
          max={3650}
          autoFocus={props.autoFocus}
          value={v}
          onChange={e => props.onChange(e.target.value === '' ? '' : Number(e.target.value))}
          className={`${fieldCls} !w-24 tnum`}
          style={fieldSty}
        />
        <span className="text-xs" style={{ color: 'var(--muted)' }}>天</span>
        <span className="flex-1" />
        {[7, 14, 30, 90].map(n => (
          <button
            key={n}
            type="button"
            onClick={() => props.onChange(n)}
            className="h-6 px-2 rounded-[var(--r-xs)] text-2xs tnum"
            style={Number(v) === n ? { background: 'var(--selected)', color: 'var(--accent-ink)', fontWeight: 600 } : { background: 'var(--hover)', color: 'var(--muted)' }}
          >
            {n}
          </button>
        ))}
      </div>
    )
  }
  if (p.kind === 'select') {
    return (
      <div className="flex flex-wrap gap-1">
        {(p.options ?? []).map(o => (
          <button
            key={o.value}
            type="button"
            onClick={() => props.onChange(o.value)}
            className="h-7 px-2.5 rounded-[var(--r-sm)] text-xs border"
            style={
              String(v) === o.value
                ? { background: 'var(--selected)', color: 'var(--accent-ink)', borderColor: 'var(--border-strong)', fontWeight: 600 }
                : { background: 'var(--surface-strong)', color: 'var(--muted)', borderColor: 'var(--border)' }
            }
          >
            {o.label}
          </button>
        ))}
      </div>
    )
  }
  if (p.kind === 'date') {
    return <input type="date" autoFocus={props.autoFocus} value={String(v)} onChange={e => props.onChange(e.target.value)} className={fieldCls} style={fieldSty} />
  }
  if (p.kind === 'project') return <ProjectField value={String(v)} onChange={props.onChange} />
  if (p.kind === 'contact') return <ContactField value={String(v)} onChange={props.onChange} placeholder={p.placeholder} autoFocus={props.autoFocus} />
  if (p.required) {
    return (
      <textarea
        autoFocus={props.autoFocus}
        value={String(v)}
        onChange={e => props.onChange(e.target.value)}
        placeholder={p.placeholder}
        rows={4}
        className="w-full px-2.5 py-2 rounded-[var(--r-sm)] border border-[var(--border)] text-sm leading-relaxed outline-none resize-none focus:border-[var(--border-strong)]"
        style={fieldSty}
      />
    )
  }
  return <input autoFocus={props.autoFocus} value={String(v)} onChange={e => props.onChange(e.target.value)} placeholder={p.placeholder} className={fieldCls} style={fieldSty} />
}

function ProjectField(props: { value: string; onChange(v: string): void }) {
  const items = useProjects(st => st.items)
  const loaded = useProjects(st => st.loaded)
  useEffect(() => {
    if (!loaded) void useProjects.getState().load()
  }, [loaded])
  const live = items.filter(isLive)
  return (
    <select value={props.value} onChange={e => props.onChange(e.target.value)} className={fieldCls} style={fieldSty}>
      <option value="">{live.length ? '（全部进行中的项目）' : '还没有进行中的项目'}</option>
      {live.map(p => (
        <option key={p.id} value={p.data.name}>
          {p.data.name}
        </option>
      ))}
    </select>
  )
}

/** 联系人：邮箱 / 姓名 / 域名，带往来联系人联想 */
function ContactField(props: { value: string; onChange(v: string): void; placeholder?: string; autoFocus?: boolean }) {
  const [sugs, setSugs] = useState<RecipientSuggestion[]>([])
  const listId = useMemo(() => `contact-sugs-${Math.random().toString(36).slice(2, 8)}`, [])
  useEffect(() => {
    const q = props.value.trim()
    if (q.length < 1) {
      setSugs([])
      return
    }
    let alive = true
    const t = window.setTimeout(() => {
      void api
        .suggestRecipients(q, 8)
        .then(r => alive && setSugs(Array.isArray(r) ? r : []))
        .catch(() => alive && setSugs([]))
    }, 150)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [props.value])
  return (
    <>
      <input
        list={listId}
        autoFocus={props.autoFocus}
        value={props.value}
        onChange={e => props.onChange(e.target.value)}
        placeholder={props.placeholder ?? '邮箱、姓名或公司域名'}
        className={fieldCls}
        style={fieldSty}
      />
      <datalist id={listId}>
        {sugs.map(s => (
          <option key={s.address} value={s.address}>
            {s.name ? `${s.name} · 往来 ${s.total} 封` : `往来 ${s.total} 封`}
          </option>
        ))}
      </datalist>
    </>
  )
}

/** 参数卡：运行前确认 / 填写参数；需要邮件上下文的技能显示「针对哪封邮件」 */
export function SkillParamCard(props: { req: SkillRunRequest; onClose(): void }) {
  const { skill } = props.req
  const [values, setValues] = useState<SkillParams>(() => ({ ...defaultParams(skill), ...props.req.prefill }))
  const selectedId = useMail(st => st.selectedId)
  const messages = useMail(st => st.messages)
  const messageId = props.req.messageId ?? (skill.contextKind === 'message' ? selectedId : null)
  const msg = messageId ? messages.find(m => m.id === messageId) : null
  const missing = (skill.params ?? []).filter(p => p.required && String(values[p.key] ?? '').trim() === '')
  const blocked = missing.length > 0 || (skill.contextKind === 'message' && !messageId)
  const cardRef = useRef<HTMLDivElement>(null)

  const run = () => {
    if (blocked) return
    const clean: SkillParams = {}
    for (const [k, v] of Object.entries(values)) if (String(v).trim() !== '') clean[k] = typeof v === 'string' ? v.trim() : v
    props.onClose()
    if (props.req.onRun) props.req.onRun(clean, messageId ?? null)
    else launchSkill(skill.id, clean, messageId ?? null)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        props.onClose()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        run()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] px-4 fade-in" style={{ background: 'var(--scrim)' }} onMouseDown={props.onClose}>
      <div
        ref={cardRef}
        role="dialog"
        aria-label={`运行技能：${skill.name}`}
        className="w-[440px] max-w-full rounded-[var(--r-md)] border border-[var(--border)] overflow-hidden pop-in"
        style={{ background: 'var(--surface-strong)', boxShadow: 'var(--shadow-float)' }}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-3 flex items-start gap-3">
          <span className="w-8 h-8 shrink-0 rounded-[var(--r-sm)] inline-flex items-center justify-center" style={{ background: 'var(--ai-soft)', color: 'var(--fg)' }}>
            <SkillIcon name={skill.icon} width={16} height={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-md font-semibold" style={{ color: 'var(--fg)' }}>{skill.name}</div>
            <div className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{skill.description}</div>
          </div>
        </div>
        <div className="px-4 pb-3 flex flex-col gap-3">
          {skill.contextKind === 'message' && (
            <div className="rounded-[var(--r-sm)] px-3 py-2 text-xs leading-relaxed border border-[var(--border)]" style={{ background: 'var(--bg-soft)', color: 'var(--fg)' }}>
              <span style={{ color: 'var(--faint)' }}>针对邮件：</span>
              {msg ? msg.subject || '（无主题）' : messageId ? '当前选中的邮件' : <span style={{ color: 'var(--danger-ink)' }}>请先在邮件列表里选中一封邮件</span>}
            </div>
          )}
          {(skill.params ?? []).map((p, i) => (
            <label key={p.key} className="flex flex-col gap-1.5">
              <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
                {p.label}
                {p.required && <span style={{ color: 'var(--danger-ink)' }}> *</span>}
              </span>
              <ParamField param={p} value={values[p.key]} autoFocus={i === 0 && p.kind !== 'select'} onChange={v => setValues(cur => ({ ...cur, [p.key]: v }))} />
            </label>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-[var(--border-soft)] flex items-center gap-2">
          {skill.output && <Chip>{OUTPUT_LABEL[skill.output]}</Chip>}
          <span className="text-2xs" style={{ color: 'var(--faint)' }}>写操作会先让你确认</span>
          <span className="flex-1" />
          <button className={btn} style={btnStyle} onClick={props.onClose}>取消</button>
          <button className={btnPrimary} style={btnPrimaryStyle} disabled={blocked} onClick={run} title="⌘↵">
            <Icons.IconPlay width={11} height={11} /> 运行
          </button>
        </div>
      </div>
    </div>
  )
}

/** 全局参数卡宿主：requestSkillRun 需要参数时由这里弹出（挂在 MailShell） */
export function SkillRunHost() {
  const [req, setReq] = useState<SkillRunRequest | null>(null)
  useEffect(() => {
    const on = (e: Event) => setReq((e as CustomEvent<SkillRunRequest>).detail)
    window.addEventListener('ms:skill-run-request', on)
    return () => window.removeEventListener('ms:skill-run-request', on)
  }, [])
  if (!req) return null
  return <SkillParamCard key={req.skill.id} req={req} onClose={() => setReq(null)} />
}

/** 技能的一行元信息：输出 · 参数 · 定时 · 需要邮件 */
export function paramSummary(skill: AgentSkill): string {
  return (skill.params ?? []).map(p => p.label.replace(/（.*?）/g, '')).join(' · ')
}
