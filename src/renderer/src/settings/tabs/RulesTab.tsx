import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { IconPlus, IconMinus } from '../../components/icons'
import { SectionTitle, Select, Toggle } from './GeneralTab'
import type { Rule, RuleActionType, RuleCondition, RuleField, RuleOp } from '@shared/types'

const FIELDS: { value: RuleField; label: string }[] = [
  { value: 'from', label: '发件人' },
  { value: 'to', label: '收件人' },
  { value: 'subject', label: '主题' },
  { value: 'listId', label: '邮件列表 ID' },
  { value: 'hasAttachment', label: '带附件' },
  { value: 'isNewsletter', label: '是订阅邮件' },
  { value: 'ai', label: 'AI 判断' }
]

const OPS: { value: RuleOp; label: string }[] = [
  { value: 'contains', label: '包含' },
  { value: 'equals', label: '等于' },
  { value: 'startsWith', label: '开头是' },
  { value: 'endsWith', label: '结尾是' },
  { value: 'regex', label: '正则匹配' },
  { value: 'is', label: '是' }
]

const ACTIONS: { value: RuleActionType; label: string }[] = [
  { value: 'setCategory', label: '标记类别' },
  { value: 'markRead', label: '标为已读' },
  { value: 'flag', label: '加旗标' },
  { value: 'unflag', label: '去旗标' },
  { value: 'markNewsletter', label: '标记为 Newsletter' },
  { value: 'moveTrash', label: '移到废纸篓' },
  { value: 'saveToKb', label: '存入知识库' },
  { value: 'notify', label: '发系统通知' },
  { value: 'runConnector', label: '发送到连接器' },
  { value: 'moveFolder', label: '移到文件夹' },
  { value: 'archive', label: '归档' },
  { value: 'pin', label: '置顶' },
  { value: 'snooze', label: '稍后处理（小时）' },
  { value: 'createTodo', label: '建待办' }
]

const CATEGORY_LABELS: Record<string, string> = {
  personal: '个人',
  notification: '通知',
  newsletter: 'Newsletter',
  noise: '噪声'
}

export function RulesTab() {
  const [rules, setRules] = useState<Rule[]>([])
  const [current, setCurrent] = useState<Rule | null>(null)

  const reload = async () => {
    const r = await api.listRules()
    setRules(r)
  }
  useEffect(() => void reload(), [])

  return (
    <div className="flex gap-5 h-full">
      <div className="w-[250px] shrink-0 flex flex-col">
        <div className="rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] flex-1 overflow-y-auto">
          {rules.map(r => (
            <button
              key={r.id}
              onClick={() => setCurrent(r)}
              className={`w-full px-3.5 py-3 text-left border-b border-ink/[0.04] last:border-0 ${
                current?.id === r.id ? 'bg-selected text-accent-ink font-medium' : 'hover:bg-ink/[0.03]'
              }`}
            >
              <span className="block text-sm font-medium truncate">{r.name}</span>
              <span className={`block text-xs mt-0.5 ${current?.id === r.id ? 'text-accent-ink/70' : 'text-zinc-400'}`}>
                {r.enabled ? '已启用' : '已停用'} · {r.conditions.length} 个条件
              </span>
            </button>
          ))}
          {!rules.length && <div className="p-4 text-sm text-zinc-400 text-center">还没有规则</div>}
        </div>
        <div className="mt-2.5 flex gap-1">
          <button
            onClick={async () => {
              const r: Rule = {
                id: `rule-${Date.now()}`,
                name: '新规则',
                enabled: true,
                order: rules.length,
                conditions: [{ field: 'from', op: 'contains', value: '' }],
                actions: [{ type: 'setCategory', value: 'personal' }]
              }
              await api.saveRule(r)
              await reload()
              setCurrent(r)
            }}
            className="p-2 rounded-lg text-zinc-500 hover:bg-ink/5"
          >
            <IconPlus width={16} height={16} />
          </button>
          <button
            onClick={async () => {
              if (current) {
                await api.deleteRule(current.id)
                setCurrent(null)
                await reload()
              }
            }}
            className="p-2 rounded-lg text-zinc-500 hover:bg-red-50 hover:text-red-500"
          >
            <IconMinus width={16} height={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto">
        {current ? (
          <RuleEditor
            rule={current}
            onChange={setCurrent}
            onSave={async () => {
              if (current) {
                await api.saveRule(current)
                await reload()
              }
            }}
          />
        ) : (
          <div className="text-sm text-zinc-400 mt-16 text-center">
            规则对新到达的邮件自动执行（条件全部满足才触发）。
            <br />
            例如：发件人包含「boss」→ 标记类别为「个人」。
            <br />
            条件选「AI 判断」可以用一句话描述，如「需要我本周内回复的合作邀约」→ 发送到连接器。
          </div>
        )}
      </div>
    </div>
  )
}

/** 规则编辑器（「建议的规则」接受前编辑也复用它：saveLabel 改按钮文字，hideEnabled 隐藏启用开关，footer 放在按钮左边） */
export function RuleEditor(props: { rule: Rule; onChange(r: Rule): void; onSave(): void; saveLabel?: string; hideEnabled?: boolean; footer?: React.ReactNode }) {
  const { rule: r } = props
  const isBool = (f: RuleField) => f === 'hasAttachment' || f === 'isNewsletter'
  // 「移到文件夹」的可选项：所有账户的非收件箱文件夹
  const [folderOptions, setFolderOptions] = useState<{ value: string; label: string }[]>([])
  useEffect(() => {
    void Promise.all([api.listFolders(), api.listAccounts()]).then(([folders, accounts]) =>
      setFolderOptions(
        folders
          .filter(f => f.special !== 'inbox' && f.special !== 'drafts')
          .map(f => ({ value: f.id, label: `${accounts.find(a => a.id === f.accountId)?.name ?? ''} · ${f.name}` }))
      )
    )
  }, [])
  // 「发送到连接器」的可选项：已连接实例 × 其动作
  const [connectorOptions, setConnectorOptions] = useState<{ value: string; label: string }[]>([])
  useEffect(() => {
    void Promise.all([api.listConnectorInstances(), api.listConnectorManifests()]).then(([instances, manifests]) => {
      setConnectorOptions(
        instances.filter(i => i.enabled).flatMap(i => {
          const m = manifests.find(x => x.id === i.manifestId)
          return (m?.actions ?? []).filter(a => !a.params?.some(p => p.required)).map(a => ({ value: `${i.id}:${a.id}`, label: `${m!.name} · ${a.name}` }))
        })
      )
    })
  }, [])

  return (
    <div className="max-w-[560px] space-y-3">
      <div className="flex items-center gap-3">
        <input
          value={r.name}
          onChange={e => props.onChange({ ...r, name: e.target.value })}
          className="flex-1 text-md font-semibold outline-none bg-transparent"
        />
        {!props.hideEnabled && (
          <>
            <span className="text-xs text-zinc-500">启用</span>
            <Toggle checked={r.enabled} onChange={v => props.onChange({ ...r, enabled: v })} />
          </>
        )}
      </div>

      <SectionTitle>当邮件满足所有条件</SectionTitle>
      <div className="rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] px-4 py-2 space-y-2">
        {r.conditions.map((c, i) => (
          <div key={i} className="flex items-center gap-2">
            <Select
              value={c.field}
              onChange={v => {
                const conditions = [...r.conditions]
                conditions[i] = { ...c, field: v as RuleField, op: v === 'ai' ? 'contains' : c.op }
                props.onChange({ ...r, conditions })
              }}
              options={FIELDS}
            />
            {c.field !== 'ai' && (
              <Select
                value={c.op}
                onChange={v => {
                  const conditions = [...r.conditions]
                  conditions[i] = { ...c, op: v as RuleOp }
                  props.onChange({ ...r, conditions })
                }}
                options={isBool(c.field) ? OPS.filter(o => o.value === 'is') : OPS.filter(o => o.value !== 'is')}
              />
            )}
            {!isBool(c.field) ? (
              <input
                value={c.value}
                onChange={e => {
                  const conditions = [...r.conditions]
                  conditions[i] = { ...c, value: e.target.value }
                  props.onChange({ ...r, conditions })
                }}
                placeholder={c.field === 'ai' ? '一句话描述条件，如：需要我本周内回复的合作邀约' : '关键词'}
                className="flex-1 text-sm bg-zinc-50 rounded-lg px-2.5 py-1.5 outline-none border border-ink/[0.05]"
              />
            ) : (
              <Select
                value={c.value || 'yes'}
                onChange={v => {
                  const conditions = [...r.conditions]
                  conditions[i] = { ...c, value: v }
                  props.onChange({ ...r, conditions })
                }}
                options={[
                  { value: 'yes', label: '是' },
                  { value: 'no', label: '否' }
                ]}
              />
            )}
            <button
              onClick={() => props.onChange({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })}
              className="p-1.5 rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50"
            >
              <IconMinus width={13} height={13} />
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            props.onChange({ ...r, conditions: [...r.conditions, { field: 'subject', op: 'contains', value: '' }] as RuleCondition[] })
          }
          className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          <IconPlus width={12} height={12} /> 添加条件
        </button>
      </div>

      <SectionTitle>执行动作</SectionTitle>
      <div className="rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] px-4 py-2 space-y-2">
        {r.actions.map((a, i) => (
          <div key={i} className="flex items-center gap-2">
            <Select
              value={a.type}
              onChange={v => {
                const actions = [...r.actions]
                actions[i] = {
                  type: v as RuleActionType,
                  value:
                    v === 'setCategory' ? 'personal'
                    : v === 'runConnector' ? connectorOptions[0]?.value
                    : v === 'moveFolder' ? folderOptions[0]?.value
                    : v === 'snooze' ? '3'
                    : undefined
                }
                props.onChange({ ...r, actions })
              }}
              options={ACTIONS}
            />
            {a.type === 'setCategory' && (
              <Select
                value={a.value ?? 'personal'}
                onChange={v => {
                  const actions = [...r.actions]
                  actions[i] = { ...a, value: v }
                  props.onChange({ ...r, actions })
                }}
                options={Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
              />
            )}
            {(a.type === 'snooze' || a.type === 'createTodo') && (
              <input
                value={a.value ?? ''}
                onChange={e => {
                  const actions = [...r.actions]
                  actions[i] = { ...a, value: e.target.value }
                  props.onChange({ ...r, actions })
                }}
                placeholder={a.type === 'snooze' ? '小时数，如 3' : '待办前缀，如「付款」（可空）'}
                className="w-[180px] text-sm bg-zinc-50 rounded-lg px-2.5 py-1.5 outline-none border border-ink/[0.05]"
              />
            )}
            {a.type === 'moveFolder' && folderOptions.length > 0 && (
              <Select
                value={a.value ?? folderOptions[0].value}
                onChange={v => {
                  const actions = [...r.actions]
                  actions[i] = { ...a, value: v }
                  props.onChange({ ...r, actions })
                }}
                options={folderOptions}
              />
            )}
            {a.type === 'runConnector' &&
              (connectorOptions.length ? (
                <Select
                  value={a.value ?? connectorOptions[0].value}
                  onChange={v => {
                    const actions = [...r.actions]
                    actions[i] = { ...a, value: v }
                    props.onChange({ ...r, actions })
                  }}
                  options={connectorOptions}
                />
              ) : (
                <span className="text-xs text-zinc-400">先在「集成」里连接一个连接器</span>
              ))}
            <div className="flex-1" />
            <button
              onClick={() => props.onChange({ ...r, actions: r.actions.filter((_, j) => j !== i) })}
              className="p-1.5 rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50"
            >
              <IconMinus width={13} height={13} />
            </button>
          </div>
        ))}
        <button
          onClick={() => props.onChange({ ...r, actions: [...r.actions, { type: 'markRead' }] })}
          className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          <IconPlus width={12} height={12} /> 添加动作
        </button>
      </div>

      <div className="flex items-center justify-end gap-3">
        {props.footer}
        <button onClick={props.onSave} className="text-sm font-medium px-4 py-2 rounded-xl bg-blue-600 text-on-accent hover:bg-blue-700">
          {props.saveLabel ?? '保存规则'}
        </button>
      </div>
    </div>
  )
}
