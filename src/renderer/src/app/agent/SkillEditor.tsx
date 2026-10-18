import { useEffect, useMemo, useState } from 'react'
import { useSkills, OUTPUT_LABEL } from '../../lib/agent-skills'
import { SKILL_CATEGORIES } from '@shared/agent-skills'
import { EVENT_KINDS, EVENT_LABEL } from '@shared/agent-events'
import { useMail } from '../../stores/mail'
import { IconClose, IconPlus, IconSave, IconTrash } from '../../components/icons'
import type { AgentDomain, AgentEventKind, AgentSkill, AgentSkillParam, AgentSkillTrigger, AgentToolInfo, AgentToolRisk } from '@shared/types'
import { btn, btnStyle, btnPrimary, btnPrimaryStyle, Chip, Seg } from '../finance/ui'
import { SkillIcon, SKILL_ICON_CHOICES, fieldCls, fieldSty } from './skill-ui'

const DOMAIN_LABEL: Record<AgentDomain, string> = {
  mail: '邮件',
  todo: '待办',
  finance: '财务',
  project: '项目',
  attachment: '附件',
  kb: '知识库',
  memory: '记忆',
  contact: '联系人',
  calendar: '日历',
  system: '系统'
}
const RISK_LABEL: Record<AgentToolRisk, string> = { read: '只读', write: '写入', external: '对外' }
const KIND_LABEL: Record<AgentSkillParam['kind'], string> = { text: '文本', days: '天数', date: '日期', contact: '联系人', project: '项目', select: '选项' }
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

type Sched = 'none' | 'hour' | 'day' | 'week'

function newId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 技能编辑器：新建 / 编辑自定义技能；内置技能只能改钉住、定时、事件触发与预授权（说明只读，可复制为自定义后修改）。
 * 保存走 agentSaveSkill。
 */
export function SkillEditor(props: { skill: AgentSkill | null; copy?: boolean; onClose(): void }) {
  const save = useSkills(st => st.save)
  const remove = useSkills(st => st.remove)
  const tools = useSkills(st => st.tools)
  const src = props.skill
  const builtinLocked = !!src?.builtin && !props.copy
  const [draft, setDraft] = useState<AgentSkill>(() =>
    src
      ? props.copy
        ? { ...structuredClone(src), id: newId(), name: `${src.name}（我的）`, builtin: false, pinned: false, schedule: null, category: src.category, triggers: (src.triggers ?? []).map(t => ({ ...t, enabled: false })) }
        : structuredClone(src)
      : { id: newId(), name: '', category: '自定义', description: '', instructions: '', params: [], output: 'report', icon: 'Sparkles', builtin: false, pinned: false, schedule: null }
  )
  const [toolMode, setToolMode] = useState<'default' | 'custom'>(draft.tools?.length ? 'custom' : 'default')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!useSkills.getState().tools.length) void useSkills.getState().loadTools()
  }, [])

  const set = (p: Partial<AgentSkill>) => setDraft(d => ({ ...d, ...p }))
  const params = draft.params ?? []
  const setParam = (i: number, p: Partial<AgentSkillParam>) => set({ params: params.map((x, j) => (j === i ? { ...x, ...p } : x)) })
  const sched: Sched = draft.schedule ? draft.schedule.every : 'none'
  const toolsByDomain = useMemo(() => {
    const m = new Map<AgentDomain, AgentToolInfo[]>()
    for (const t of tools) m.set(t.domain, [...(m.get(t.domain) ?? []), t])
    return [...m.entries()]
  }, [tools])
  const writeTools = tools.filter(t => t.risk === 'write' && (toolMode === 'default' || draft.tools?.includes(t.name)))
  const keys = params.map(p => p.key.trim())
  const dupKey = keys.some((k, i) => k && keys.indexOf(k) !== i)
  const valid = draft.name.trim() && draft.instructions.trim() && !dupKey && params.every(p => p.key.trim() && p.label.trim())

  const submit = async () => {
    if (!valid || saving) return
    setSaving(true)
    const out: AgentSkill = {
      ...draft,
      name: draft.name.trim(),
      category: draft.category.trim() || '自定义',
      tools: toolMode === 'custom' ? draft.tools ?? [] : undefined,
      autoApprove: (draft.autoApprove ?? []).filter(n => tools.length === 0 || writeTools.some(t => t.name === n)),
      params: params.map(p => ({ ...p, key: p.key.trim(), label: p.label.trim() }))
    }
    await save(out)
    setSaving(false)
    props.onClose()
  }

  const toggleIn = (list: string[] | undefined, v: string) => (list?.includes(v) ? list.filter(x => x !== v) : [...(list ?? []), v])

  return (
    <div className="fixed inset-0 z-50 flex justify-end fade-in" style={{ background: 'var(--scrim)' }} onMouseDown={props.onClose}>
      <div
        role="dialog"
        aria-label="技能编辑器"
        className="h-full w-[620px] max-w-full flex flex-col border-l border-[var(--border)]"
        style={{ background: 'var(--bg)', boxShadow: 'var(--shadow-float)' }}
        onMouseDown={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === 'Escape') props.onClose()
          if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
        }}
      >
        <header className="drag-region shrink-0 h-[var(--titlebar-h)] px-5 flex items-center gap-2 border-b border-[var(--border)]">
          <SkillIcon name={draft.icon} width={15} height={15} />
          <span className="text-md font-semibold truncate" style={{ color: 'var(--fg)' }}>
            {builtinLocked ? `${draft.name} · 设置` : src && !props.copy ? '编辑技能' : props.copy ? '复制为自定义技能' : '新建技能'}
          </span>
          {builtinLocked && <Chip>内置</Chip>}
          <span className="flex-1" />
          <button onClick={props.onClose} aria-label="关闭" className="no-drag icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--faint)' }}>
            <IconClose width={13} height={13} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          {builtinLocked && (
            <div className="px-3 py-2 rounded-[var(--r-sm)] text-xs leading-relaxed" style={{ background: 'var(--bg-soft)', color: 'var(--muted)' }}>
              内置技能的说明与参数不可修改；这里可以设置钉住、定时运行、事件触发和预授权。想改说明，请用「复制为自定义」。
            </div>
          )}

          {/* 基本信息 */}
          <Field label="名称">
            <input disabled={builtinLocked} autoFocus={!builtinLocked} value={draft.name} onChange={e => set({ name: e.target.value })} placeholder="如：供应商周报" className={fieldCls} style={fieldSty} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="分类">
              <input disabled={builtinLocked} list="skill-cats" value={draft.category} onChange={e => set({ category: e.target.value })} className={fieldCls} style={fieldSty} />
              <datalist id="skill-cats">
                {SKILL_CATEGORIES.map(c => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field label="输出">
              <Seg
                value={draft.output ?? 'report'}
                onChange={v => !builtinLocked && set({ output: v })}
                options={(Object.keys(OUTPUT_LABEL) as NonNullable<AgentSkill['output']>[]).map(k => ({ value: k, label: OUTPUT_LABEL[k] }))}
              />
            </Field>
          </div>
          {!builtinLocked && (
            <Field label="图标">
              <div className="flex flex-wrap gap-1">
                {SKILL_ICON_CHOICES.map(n => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => set({ icon: n })}
                    aria-pressed={draft.icon === n}
                    title={n}
                    className="w-7 h-7 rounded-[var(--r-xs)] inline-flex items-center justify-center border"
                    style={draft.icon === n ? { background: 'var(--selected)', borderColor: 'var(--border-strong)', color: 'var(--accent-ink)' } : { borderColor: 'transparent', color: 'var(--muted)' }}
                  >
                    <SkillIcon name={n} width={14} height={14} />
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Field label="一句话说明">
            <input disabled={builtinLocked} value={draft.description} onChange={e => set({ description: e.target.value })} placeholder="出现在技能卡片和侧栏提示里" className={fieldCls} style={fieldSty} />
          </Field>
          <Field label="任务说明" hint="像给资深助理写工作说明：查哪些数据、怎么判断、输出什么格式；用 {{参数名}} 引用参数">
            <textarea
              disabled={builtinLocked}
              value={draft.instructions}
              onChange={e => set({ instructions: e.target.value })}
              rows={builtinLocked ? 10 : 12}
              placeholder={'例：找出最近 {{days}} 天里供应商发来的报价与交付邮件……\n步骤：1. 搜索邮件… 2. 读邮件理解… 3. 财务汇总…\n输出格式：总览一句话 → 分供应商列表 → 待确认动作'}
              className="w-full px-2.5 py-2 rounded-[var(--r-sm)] border border-[var(--border)] text-xs leading-relaxed outline-none resize-y focus:border-[var(--border-strong)] selectable"
              style={{ ...fieldSty, fontFamily: 'var(--font-mono)' }}
            />
          </Field>
          {!builtinLocked && (
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--fg)' }}>
              <input type="checkbox" checked={draft.contextKind === 'message'} onChange={e => set({ contextKind: e.target.checked ? 'message' : null })} />
              需要针对一封邮件运行（会出现在阅读页右侧栏的技能入口里）
            </label>
          )}

          {/* 参数 */}
          <Field
            label="参数"
            right={
              !builtinLocked && (
                <button
                  className="h-6 px-2 rounded-[var(--r-xs)] text-2xs inline-flex items-center gap-1 hover:bg-[var(--hover)]"
                  style={{ color: 'var(--muted)' }}
                  onClick={() => set({ params: [...params, { key: params.some(p => p.key === 'days') ? `p${params.length + 1}` : 'days', label: '时间范围（天）', kind: 'days', default: 30 }] })}
                >
                  <IconPlus width={11} height={11} /> 添加参数
                </button>
              )
            }
          >
            {!params.length && <div className="text-xs" style={{ color: 'var(--faint)' }}>没有参数，运行时直接执行。</div>}
            <div className="flex flex-col gap-2">
              {params.map((p, i) => (
                <div key={i} className="rounded-[var(--r-sm)] border border-[var(--border)] p-2.5 flex flex-col gap-2" style={{ background: 'var(--surface-strong)' }}>
                  <div className="grid grid-cols-[110px_1fr_100px_auto] gap-2 items-center">
                    <input disabled={builtinLocked} value={p.key} onChange={e => setParam(i, { key: e.target.value.replace(/[^\w]/g, '') })} placeholder="key" className={`${fieldCls} !h-7 !text-xs`} style={{ ...fieldSty, fontFamily: 'var(--font-mono)' }} />
                    <input disabled={builtinLocked} value={p.label} onChange={e => setParam(i, { label: e.target.value })} placeholder="显示名称" className={`${fieldCls} !h-7 !text-xs`} style={fieldSty} />
                    <select disabled={builtinLocked} value={p.kind} onChange={e => setParam(i, { kind: e.target.value as AgentSkillParam['kind'] })} className={`${fieldCls} !h-7 !text-xs`} style={fieldSty}>
                      {(Object.keys(KIND_LABEL) as AgentSkillParam['kind'][]).map(k => (
                        <option key={k} value={k}>{KIND_LABEL[k]}</option>
                      ))}
                    </select>
                    {!builtinLocked && (
                      <button onClick={() => set({ params: params.filter((_, j) => j !== i) })} aria-label="删除参数" className="icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--faint)' }}>
                        <IconTrash width={12} height={12} />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                    <input
                      disabled={builtinLocked}
                      value={p.default ?? ''}
                      onChange={e => setParam(i, { default: p.kind === 'days' && e.target.value !== '' ? Number(e.target.value) || 0 : e.target.value })}
                      placeholder="默认值（可选）"
                      className={`${fieldCls} !h-7 !text-xs`}
                      style={fieldSty}
                    />
                    <input disabled={builtinLocked} value={p.placeholder ?? ''} onChange={e => setParam(i, { placeholder: e.target.value })} placeholder="输入提示（可选）" className={`${fieldCls} !h-7 !text-xs`} style={fieldSty} />
                    <label className="flex items-center gap-1 text-2xs whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                      <input disabled={builtinLocked} type="checkbox" checked={!!p.required} onChange={e => setParam(i, { required: e.target.checked })} /> 必填
                    </label>
                  </div>
                  {p.kind === 'select' && <OptionsInput disabled={builtinLocked} options={p.options ?? []} onChange={options => setParam(i, { options })} />}
                </div>
              ))}
            </div>
            {dupKey && <div className="text-2xs" style={{ color: 'var(--danger-ink)' }}>参数 key 不能重复</div>}
          </Field>

          {/* 工具 */}
          <Field label="允许的工具" hint="只读工具自动执行；写入工具需要确认（可在下面预授权）；对外工具（发信等）永远需要确认">
            <Seg
              value={toolMode}
              onChange={v => !builtinLocked && setToolMode(v)}
              options={[
                { value: 'default', label: '全部只读 + 需确认的写入' },
                { value: 'custom', label: '只允许选中的工具' }
              ]}
            />
            {!tools.length ? (
              <div className="text-xs" style={{ color: 'var(--faint)' }}>Agent 运行时尚未就绪，暂时读不到工具列表。</div>
            ) : (
              toolMode === 'custom' && (
                <div className="flex flex-col gap-2.5">
                  {toolsByDomain.map(([domain, list]) => (
                    <div key={domain}>
                      <div className="caps mb-1" style={{ color: 'var(--faint)', fontSize: 10 }}>{DOMAIN_LABEL[domain] ?? domain}</div>
                      <div className="flex flex-wrap gap-1">
                        {list.map(t => {
                          const on = !!draft.tools?.includes(t.name)
                          return (
                            <button
                              key={t.name}
                              type="button"
                              disabled={builtinLocked}
                              title={`${t.name} · ${t.description}`}
                              onClick={() => setDraft(d => ({ ...d, tools: toggleIn(d.tools, t.name) }))}
                              aria-pressed={on}
                              className="h-7 px-2 rounded-[var(--r-sm)] text-xs inline-flex items-center gap-1.5 border"
                              style={on ? { background: 'var(--selected)', borderColor: 'var(--border-strong)', color: 'var(--accent-ink)' } : { background: 'var(--surface-strong)', borderColor: 'var(--border)', color: 'var(--muted)' }}
                            >
                              {t.title}
                              {t.risk !== 'read' && <RiskTag risk={t.risk} />}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
          </Field>

          {writeTools.length > 0 && (
            <Field label="预授权的写入工具" hint="勾选后这个技能使用它们时不再逐条确认">
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {writeTools.map(t => (
                  <label key={t.name} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--fg)' }} title={t.description}>
                    <input type="checkbox" checked={!!draft.autoApprove?.includes(t.name)} onChange={() => setDraft(d => ({ ...d, autoApprove: toggleIn(d.autoApprove, t.name) }))} />
                    {t.title}
                  </label>
                ))}
              </div>
            </Field>
          )}

          {/* 定时 */}
          <Field label="定时运行" hint="定时运行的结果写进「自动任务」页的活动记录">
            <div className="flex flex-wrap items-center gap-2">
              <Seg
                value={sched}
                onChange={v => set({ schedule: v === 'none' ? null : { every: v, at: v === 'hour' ? undefined : draft.schedule?.at ?? '08:00', weekday: v === 'week' ? draft.schedule?.weekday ?? 1 : undefined } })}
                options={[
                  { value: 'none', label: '不定时' },
                  { value: 'hour', label: '每小时' },
                  { value: 'day', label: '每天' },
                  { value: 'week', label: '每周' }
                ]}
              />
              {sched === 'week' && (
                <select value={draft.schedule?.weekday ?? 1} onChange={e => set({ schedule: { ...draft.schedule!, weekday: Number(e.target.value) } })} className={`${fieldCls} !w-auto !h-7 !text-xs`} style={fieldSty}>
                  {WEEKDAYS.map((w, i) => (
                    <option key={w} value={i}>{w}</option>
                  ))}
                </select>
              )}
              {(sched === 'day' || sched === 'week') && (
                <input type="time" value={draft.schedule?.at ?? '08:00'} onChange={e => set({ schedule: { ...draft.schedule!, at: e.target.value } })} className={`${fieldCls} !w-auto !h-7 !text-xs tnum`} style={fieldSty} />
              )}
            </div>
          </Field>

          {/* 事件触发 */}
          <Field label="事件触发" hint="新邮件命中事件时，以这封邮件为上下文在后台运行；写操作只列为建议，结果写进活动记录">
            <TriggerEditor triggers={draft.triggers ?? []} onChange={triggers => set({ triggers })} />
          </Field>

          <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--fg)' }}>
            <input type="checkbox" checked={!!draft.pinned} onChange={e => set({ pinned: e.target.checked })} />
            钉在侧栏 Agent 下
          </label>
        </div>

        <footer className="shrink-0 px-5 py-3 border-t border-[var(--border)] flex items-center gap-2">
          {src && !src.builtin && !props.copy && (
            <button
              className={btn}
              style={{ ...btnStyle, color: 'var(--danger-ink)' }}
              onClick={async () => {
                await remove(src.id)
                props.onClose()
              }}
            >
              <IconTrash width={12} height={12} /> 删除
            </button>
          )}
          <span className="flex-1" />
          {!valid && !builtinLocked && <span className="text-2xs" style={{ color: 'var(--faint)' }}>名称、任务说明和参数的 key / 名称必填</span>}
          <button className={btn} style={btnStyle} onClick={props.onClose}>取消</button>
          <button className={btnPrimary} style={btnPrimaryStyle} disabled={!valid || saving} onClick={() => void submit()} title="⌘S">
            <IconSave width={12} height={12} /> {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function Field(props: { label: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>{props.label}</span>
        {props.hint && <span className="text-2xs truncate" style={{ color: 'var(--faint)' }} title={props.hint}>{props.hint}</span>}
        <span className="flex-1" />
        {props.right}
      </div>
      {props.children}
    </div>
  )
}

function RiskTag(props: { risk: AgentToolRisk }) {
  return (
    <span className="text-2xs px-1 rounded-[var(--r-xs)]" style={props.risk === 'external' ? { background: 'var(--danger-soft)', color: 'var(--danger-ink)' } : { background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
      {RISK_LABEL[props.risk]}
    </span>
  )
}

/** 选项输入：本地保留原始文本（逗号可正常输入），失焦时解析为 { value, label }；「值=显示名」可分开写 */
function OptionsInput(props: { options: { value: string; label: string }[]; disabled?: boolean; onChange(o: { value: string; label: string }[]): void }) {
  const [raw, setRaw] = useState(() => props.options.map(o => (o.value === o.label ? o.value : `${o.value}=${o.label}`)).join('，'))
  const commit = () =>
    props.onChange(
      raw
        .split(/[,，]/)
        .map(x => x.trim())
        .filter(Boolean)
        .map(x => {
          const [v, l] = x.split('=')
          return { value: v.trim(), label: (l ?? v).trim() }
        })
    )
  return (
    <input
      disabled={props.disabled}
      value={raw}
      onChange={e => setRaw(e.target.value)}
      onBlur={commit}
      placeholder="选项，用逗号分隔，如：本月，上个月"
      className={`${fieldCls} !h-7 !text-xs`}
      style={fieldSty}
    />
  )
}

/** 事件触发设置：事件多选（开 / 关）+ 每个开着的事件一行过滤条件与通知开关 */
function TriggerEditor(props: { triggers: AgentSkillTrigger[]; onChange(t: AgentSkillTrigger[]): void }) {
  const accounts = useMail(st => st.accounts)
  const list = props.triggers
  const on = (e: AgentEventKind) => list.some(t => t.event === e && t.enabled)
  const toggle = (e: AgentEventKind) => {
    const cur = list.find(t => t.event === e)
    if (cur) props.onChange(list.map(t => (t.event === e ? { ...t, enabled: !t.enabled } : t)))
    else props.onChange([...list, { event: e, enabled: true, notify: false, match: null }])
  }
  const patch = (e: AgentEventKind, p: Partial<AgentSkillTrigger>) => props.onChange(list.map(t => (t.event === e ? { ...t, ...p } : t)))
  const setMatch = (t: AgentSkillTrigger, k: 'from' | 'subject' | 'accountId', v: string) => patch(t.event, { match: { ...(t.match ?? {}), [k]: v || null } })
  const active = list.filter(t => t.enabled)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label="触发事件">
        {EVENT_KINDS.map(e => (
          <button
            key={e}
            type="button"
            onClick={() => toggle(e)}
            aria-pressed={on(e)}
            className="h-7 px-2 rounded-[var(--r-sm)] text-xs border"
            style={on(e) ? { background: 'var(--selected)', borderColor: 'var(--border-strong)', color: 'var(--accent-ink)' } : { background: 'var(--surface-strong)', borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            {EVENT_LABEL[e]}
          </button>
        ))}
      </div>
      {!active.length && <div className="text-xs" style={{ color: 'var(--faint)' }}>没有开启的触发，只在手动运行或定时时执行。</div>}
      {active.map(t => {
        const needCond = t.event === 'custom' && !(t.match?.from || t.match?.subject || t.match?.accountId)
        return (
          <div key={t.event} className="rounded-[var(--r-sm)] border border-[var(--border)] p-2.5 flex flex-col gap-2" style={{ background: 'var(--surface-strong)' }}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold" style={{ color: 'var(--fg)' }}>{EVENT_LABEL[t.event]}</span>
              <span className="flex-1" />
              <label className="flex items-center gap-1 text-2xs whitespace-nowrap" style={{ color: 'var(--muted)' }} title="运行完发系统通知（受通知总开关与免打扰约束）">
                <input type="checkbox" checked={!!t.notify} onChange={e => patch(t.event, { notify: e.target.checked })} /> 运行完通知我
              </label>
            </div>
            <div className="grid grid-cols-[1fr_1fr_130px] gap-2">
              <input value={t.match?.from ?? ''} onChange={e => setMatch(t, 'from', e.target.value)} placeholder="发件人包含（可选）" className={`${fieldCls} !h-7 !text-xs`} style={fieldSty} />
              <input value={t.match?.subject ?? ''} onChange={e => setMatch(t, 'subject', e.target.value)} placeholder="主题包含（可选）" className={`${fieldCls} !h-7 !text-xs`} style={fieldSty} />
              <select value={t.match?.accountId ?? ''} onChange={e => setMatch(t, 'accountId', e.target.value)} className={`${fieldCls} !h-7 !text-xs`} style={fieldSty} aria-label="限定账户">
                <option value="">所有账户</option>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>{a.email}</option>
                ))}
              </select>
            </div>
            {needCond && <div className="text-2xs" style={{ color: 'var(--warn-ink)' }}>自定义条件至少填一个过滤条件，否则不会触发。</div>}
          </div>
        )
      })}
    </div>
  )
}
