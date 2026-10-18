import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { IconPlus, IconMinus, IconBook, IconChevronRight, IconSearch, IconCheck } from '../../components/icons'
import { HtmlEditor } from './ContentTabs'
import {
  AUTO_PLACEHOLDERS,
  PRESET_CATEGORIES,
  TEMPLATE_PRESETS,
  UNCATEGORIZED,
  sortTemplateCategories as sortCategories,
  extractPlaceholders,
  isAutoPlaceholder,
  type TemplatePreset
} from '../../lib/template-presets'
import type { MailTemplate } from '@shared/types'

const NEW_CATEGORY = '__new__'

/** 用户模板 id 前缀：由预设添加的模板带上预设 id，用于在预设库里标记「已添加」 */
const presetTplPrefix = (presetId: string) => `tpl-p-${presetId}-`

const catOf = (t: { category?: string }) => t.category?.trim() || UNCATEGORIZED

/** 把 HTML / 文本里的 {占位符} 包成小标签（仅用于预设预览，内容为内置可信文本） */
function highlightPlaceholders(html: string): string {
  return html.replace(
    /\{([^{}\n<>]{1,24})\}/g,
    (_m, name: string) =>
      `<span class="inline-block px-1 mx-px rounded-xs bg-accent-soft text-ink font-mono text-[0.92em] leading-snug">{${name}}</span>`
  )
}

// ================= 模板 =================

export function TemplatesTab() {
  const [templates, setTemplates] = useState<MailTemplate[]>([])
  const [current, setCurrent] = useState<MailTemplate | null>(null)
  const [mode, setMode] = useState<'edit' | 'presets'>('edit')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [saved, setSaved] = useState(false)

  const reload = async () => {
    const t = await api.listTemplates()
    setTemplates(t)
    return t
  }
  useEffect(() => {
    void reload().then(t => {
      // 没有任何用户模板时，默认打开预设库
      if (!t.length) setMode('presets')
    })
  }, [])

  const groups = useMemo(() => {
    const map = new Map<string, MailTemplate[]>()
    for (const t of templates) map.set(catOf(t), [...(map.get(catOf(t)) ?? []), t])
    return sortCategories(map.keys()).map(c => [c, map.get(c)!] as const)
  }, [templates])

  const allCategories = useMemo(
    () => sortCategories([...PRESET_CATEGORIES, ...templates.map(catOf)].filter(c => c !== UNCATEGORIZED)),
    [templates]
  )

  const open = (t: MailTemplate) => {
    setCurrent(t)
    setMode('edit')
    setSaved(false)
  }

  const toggle = (c: string) =>
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  const addBlank = async () => {
    // 新建时沿用当前所在分类，便于在同一分类下连续新建
    const category = current && current.category ? current.category : undefined
    const t: MailTemplate = { id: `tpl-${Date.now()}`, name: '新模板', to: '', subject: '', html: '<p>{对方称呼}，您好：</p><p></p>', updatedAt: Date.now(), category }
    await api.saveTemplate(t)
    await reload()
    open(t)
  }

  const addPreset = async (p: TemplatePreset): Promise<MailTemplate> => {
    const t: MailTemplate = {
      id: `${presetTplPrefix(p.id)}${Date.now()}`,
      name: p.name,
      to: '',
      subject: p.subject,
      html: p.html,
      category: p.category,
      updatedAt: Date.now()
    }
    await api.saveTemplate(t)
    await reload()
    setCollapsed(prev => {
      const next = new Set(prev)
      next.delete(p.category)
      return next
    })
    return t
  }

  return (
    <div className="flex gap-5 h-full">
      <div className="w-[224px] shrink-0 flex flex-col min-h-0">
        <div className="rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] flex-1 min-h-0 overflow-y-auto py-1.5">
          <button
            onClick={() => setMode('presets')}
            className={`w-[calc(100%-12px)] mx-1.5 px-2.5 py-2 rounded-lg flex items-center gap-2 text-left text-sm transition ${
              mode === 'presets' ? 'bg-selected text-accent-ink font-medium' : 'text-zinc-700 hover:bg-ink/[0.03]'
            }`}
          >
            <IconBook width={15} height={15} className="shrink-0" />
            <span className="flex-1">预设库</span>
            <span className="text-2xs text-zinc-400 tnum">{TEMPLATE_PRESETS.length}</span>
          </button>

          <div className="mx-3 my-1.5 h-px bg-ink/[0.06]" />
          <div className="px-3 pt-1 pb-1 flex items-center text-2xs font-medium text-zinc-400 uppercase tracking-wide">
            <span className="flex-1">我的模板</span>
            <span className="tnum">{templates.length}</span>
          </div>

          {groups.map(([cat, list]) => {
            const isCollapsed = collapsed.has(cat)
            return (
              <div key={cat} className="mb-0.5">
                <button
                  onClick={() => toggle(cat)}
                  className="w-full px-3 py-1.5 flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700"
                >
                  <IconChevronRight
                    width={12}
                    height={12}
                    className="shrink-0 transition-transform"
                    style={{ transform: isCollapsed ? undefined : 'rotate(90deg)', transitionDuration: 'var(--dur-2)' }}
                  />
                  <span className="flex-1 text-left truncate">{cat}</span>
                  <span className="text-2xs text-zinc-400 tnum">{list.length}</span>
                </button>
                {!isCollapsed &&
                  list.map(t => {
                    const active = mode === 'edit' && current?.id === t.id
                    return (
                      <button
                        key={t.id}
                        onClick={() => open(t)}
                        className={`w-[calc(100%-12px)] mx-1.5 pl-7 pr-2.5 py-1.5 rounded-lg text-left text-sm transition ${
                          active ? 'bg-selected text-accent-ink font-medium' : 'hover:bg-ink/[0.03]'
                        }`}
                      >
                        <span className="block truncate">{t.name}</span>
                        {t.subject && (
                          <span className={`block text-2xs truncate ${active ? 'text-accent-ink/70' : 'text-zinc-400'}`}>{t.subject}</span>
                        )}
                      </button>
                    )
                  })}
              </div>
            )
          })}
          {!templates.length && (
            <div className="px-3 py-3 text-xs text-zinc-400 leading-relaxed">还没有模板。从「预设库」挑一个添加，或点下方 + 新建。</div>
          )}
        </div>
        <div className="mt-2.5 flex gap-1">
          <button onClick={() => void addBlank()} title="新建模板" className="p-2 rounded-lg text-zinc-500 hover:bg-ink/5">
            <IconPlus width={16} height={16} />
          </button>
          <button
            title="删除当前模板"
            disabled={mode !== 'edit' || !current}
            onClick={async () => {
              if (current) {
                await api.deleteTemplate(current.id)
                setCurrent(null)
                await reload()
              }
            }}
            className="p-2 rounded-lg text-zinc-500 hover:bg-red-50 hover:text-red-500 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
          >
            <IconMinus width={16} height={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-w-0 min-h-0">
        {mode === 'presets' ? (
          <PresetLibrary
            templates={templates}
            onAdd={addPreset}
            onEdit={t => open(t)}
          />
        ) : current ? (
          <TemplateEditor
            key={current.id}
            template={current}
            categories={allCategories}
            saved={saved}
            onChange={t => {
              setCurrent(t)
              setSaved(false)
            }}
            onSave={async () => {
              await api.saveTemplate({ ...current, updatedAt: Date.now() })
              await reload()
              setSaved(true)
            }}
          />
        ) : (
          <div className="text-sm text-zinc-400 mt-16 text-center leading-relaxed">
            模板用于快速插入常用邮件内容（撰写窗口主题栏右侧「插入模板…」）
            <div className="mt-3">
              <button onClick={() => setMode('presets')} className="text-sm px-3.5 py-1.5 rounded-lg border border-ink/[0.1] text-zinc-600 hover:bg-zinc-50">
                浏览预设库
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ================= 编辑器 =================

function TemplateEditor(props: {
  template: MailTemplate
  categories: string[]
  saved: boolean
  onChange(t: MailTemplate): void
  onSave(): Promise<void>
}) {
  const t = props.template
  const bodyRef = useRef<HTMLDivElement>(null)
  const [newCat, setNewCat] = useState<string | null>(null)
  const cat = t.category?.trim() ?? ''
  const options = cat && !props.categories.includes(cat) ? [...props.categories, cat] : props.categories

  // 模板里已出现、但不在自动填充之列的占位符（插入时需手动补全）
  const custom = extractPlaceholders(t.subject, t.html).filter(n => !isAutoPlaceholder(n))

  /** 在光标处插入占位符：焦点在主题框/正文中时就地插入，否则追加到正文末尾 */
  const insertPlaceholder = (name: string) => {
    const text = `{${name}}`
    const el = document.activeElement as HTMLElement | null
    const editable = el && (el.tagName === 'INPUT' || el.isContentEditable)
    if (!editable) {
      const body = bodyRef.current?.querySelector<HTMLElement>('[contenteditable]')
      if (!body) return
      body.focus()
      const sel = window.getSelection()
      sel?.selectAllChildren(body)
      sel?.collapseToEnd()
    }
    document.execCommand('insertText', false, text)
  }

  return (
    <div className="max-w-[560px] space-y-3">
      <input
        value={t.name}
        onChange={e => props.onChange({ ...t, name: e.target.value })}
        className="w-full text-md font-semibold outline-none bg-transparent"
        placeholder="模板名称"
      />
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500 w-10 shrink-0">分类</span>
        {newCat === null ? (
          <select
            value={cat}
            onChange={e => {
              if (e.target.value === NEW_CATEGORY) setNewCat('')
              else props.onChange({ ...t, category: e.target.value || undefined })
            }}
            className="text-sm bg-white rounded-lg px-2.5 py-1.5 outline-none border border-ink/[0.08] min-w-[180px]"
          >
            <option value="">{UNCATEGORIZED}</option>
            {options.map(c => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value={NEW_CATEGORY}>＋ 新建分类…</option>
          </select>
        ) : (
          <>
            <input
              autoFocus
              value={newCat}
              onChange={e => setNewCat(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  props.onChange({ ...t, category: newCat.trim() || undefined })
                  setNewCat(null)
                } else if (e.key === 'Escape') setNewCat(null)
              }}
              placeholder="新分类名称，回车确认"
              className="text-sm bg-white rounded-lg px-2.5 py-1.5 outline-none border border-ink/[0.14] min-w-[180px]"
            />
            <button
              onClick={() => {
                props.onChange({ ...t, category: newCat.trim() || undefined })
                setNewCat(null)
              }}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            >
              确定
            </button>
          </>
        )}
      </div>
      <input
        value={t.to}
        onChange={e => props.onChange({ ...t, to: e.target.value })}
        className="w-full text-sm rounded-xl bg-white border border-ink/[0.08] px-3.5 py-2.5 outline-none"
        placeholder="收件人（可选）"
      />
      <input
        value={t.subject}
        onChange={e => props.onChange({ ...t, subject: e.target.value })}
        className="w-full text-sm rounded-xl bg-white border border-ink/[0.08] px-3.5 py-2.5 outline-none"
        placeholder="主题"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-zinc-500 mr-0.5">占位符</span>
        {AUTO_PLACEHOLDERS.map(n => (
          <PlaceholderChip key={n} name={n} auto onInsert={insertPlaceholder} />
        ))}
        {custom.map(n => (
          <PlaceholderChip key={n} name={n} onInsert={insertPlaceholder} />
        ))}
      </div>
      <div ref={bodyRef}>
        <HtmlEditor html={t.html} onChange={html => props.onChange({ ...t, html })} minHeight={200} />
      </div>
      <div className="flex items-center gap-3">
        <span className="flex-1 text-2xs text-zinc-400 leading-relaxed">
          插入到撰写窗时自动填充：{'{我的名字}'} = 发件账户名，{'{对方称呼}'} = 首位收件人姓名，{'{日期}'} = 今天；其余占位符保留，发送前手动补全。
        </span>
        {props.saved && (
          <span className="text-xs text-green-600 inline-flex items-center gap-1 shrink-0">
            <IconCheck width={12} height={12} /> 已保存
          </span>
        )}
        <button
          onClick={() => void props.onSave()}
          className="text-sm font-medium px-4 py-2 rounded-xl bg-blue-600 text-on-accent hover:bg-blue-700 shrink-0"
        >
          保存
        </button>
      </div>
    </div>
  )
}

function PlaceholderChip(props: { name: string; auto?: boolean; onInsert(name: string): void }) {
  return (
    <button
      type="button"
      onMouseDown={e => e.preventDefault()}
      onClick={() => props.onInsert(props.name)}
      title={props.auto ? '插入时自动填充 · 点击插入到光标处' : '需手动补全 · 点击插入到光标处'}
      className={`text-2xs font-mono px-1.5 py-0.5 rounded-md border transition ${
        props.auto ? 'bg-accent-soft border-ink/[0.1] text-ink hover:bg-ink/[0.08]' : 'border-dashed border-ink/[0.16] text-zinc-500 hover:bg-zinc-50'
      }`}
    >
      {`{${props.name}}`}
    </button>
  )
}

// ================= 预设库 =================

function PresetLibrary(props: {
  templates: MailTemplate[]
  onAdd(p: TemplatePreset): Promise<MailTemplate>
  onEdit(t: MailTemplate): void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('')
  const [selectedId, setSelectedId] = useState<string>(TEMPLATE_PRESETS[0].id)
  const [justAdded, setJustAdded] = useState<MailTemplate | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return TEMPLATE_PRESETS.filter(p => {
      if (category && p.category !== category) return false
      if (!q) return true
      const text = `${p.name} ${p.category} ${p.subject} ${p.html.replace(/<[^>]+>/g, ' ')}`.toLowerCase()
      return text.includes(q)
    })
  }, [query, category])

  const grouped = useMemo(
    () => PRESET_CATEGORIES.map(c => [c, filtered.filter(p => p.category === c)] as const).filter(([, l]) => l.length),
    [filtered]
  )

  const selected = filtered.find(p => p.id === selectedId) ?? filtered[0]
  const addedCount = (p: TemplatePreset) => props.templates.filter(t => t.id.startsWith(presetTplPrefix(p.id))).length

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 mb-2.5">
        <div className="flex-1 flex items-center gap-2 rounded-xl bg-white border border-ink/[0.08] px-3 py-2">
          <IconSearch width={14} height={14} className="text-zinc-400 shrink-0" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索预设：催款、改期、Follow-up…"
            className="flex-1 min-w-0 text-sm outline-none bg-transparent"
          />
        </div>
        <select
          value={category}
          onChange={e => setCategory(e.target.value)}
          className="text-sm bg-white rounded-xl px-2.5 py-2 outline-none border border-ink/[0.08]"
        >
          <option value="">全部分类</option>
          {PRESET_CATEGORIES.map(c => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 min-h-0 flex gap-3">
        <div className="w-[188px] shrink-0 rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)] overflow-y-auto py-1.5">
          {grouped.map(([cat, list]) => (
            <div key={cat} className="mb-1">
              <div className="px-3 pt-1.5 pb-1 text-2xs font-medium text-zinc-400 uppercase tracking-wide">{cat}</div>
              {list.map(p => {
                const active = selected?.id === p.id
                const added = addedCount(p) > 0
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      setSelectedId(p.id)
                      setJustAdded(null)
                    }}
                    className={`w-[calc(100%-12px)] mx-1.5 px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 text-left text-sm transition ${
                      active ? 'bg-selected text-accent-ink font-medium' : 'hover:bg-ink/[0.03] text-zinc-700'
                    }`}
                  >
                    <span className="flex-1 truncate">{p.name}</span>
                    {added && <IconCheck width={12} height={12} className="shrink-0 text-zinc-400" />}
                  </button>
                )
              })}
            </div>
          ))}
          {!filtered.length && <div className="px-3 py-4 text-xs text-zinc-400">没有匹配的预设</div>}
        </div>

        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {selected ? (
            <div className="flex-1 min-h-0 overflow-y-auto rounded-2xl bg-white border border-ink/[0.06] shadow-[var(--shadow-sm)]">
              <div className="px-4 pt-3.5 pb-3 border-b border-ink/[0.05]">
                <div className="flex items-center gap-2">
                  <span className="text-md font-semibold text-zinc-800">{selected.name}</span>
                  <span className="text-2xs px-1.5 py-px rounded-sm bg-zinc-100 text-zinc-500">{selected.category}</span>
                </div>
                <div className="mt-1.5 text-sm text-zinc-600">
                  <span className="text-zinc-400 mr-1.5">主题</span>
                  <span dangerouslySetInnerHTML={{ __html: highlightPlaceholders(selected.subject) }} />
                </div>
              </div>
              <div
                className="px-4 py-3 text-sm leading-relaxed text-zinc-700 selectable [&_p]:mb-2.5 [&_p:last-child]:mb-0"
                dangerouslySetInnerHTML={{ __html: highlightPlaceholders(selected.html) }}
              />
            </div>
          ) : (
            <div className="text-sm text-zinc-400 mt-16 text-center">没有匹配的预设</div>
          )}
        </div>
      </div>

      {selected && (
        <div className="mt-2.5 flex items-center gap-2.5">
          {justAdded && justAdded.id.startsWith(presetTplPrefix(selected.id)) ? (
            <span className="flex-1 min-w-0 text-xs text-green-600 truncate">
              已添加到「我的模板 · {selected.category}」
              <button onClick={() => props.onEdit(justAdded)} className="ml-2 text-blue-600 underline underline-offset-2">
                去编辑
              </button>
            </span>
          ) : (
            <span className="flex-1 min-w-0 text-2xs text-zinc-400 truncate">
              {addedCount(selected) > 0 ? `已在我的模板中（${addedCount(selected)} 份）· 可再添加一份另行修改` : '添加后可在「我的模板」里自由修改'}
            </span>
          )}
          <button
            onClick={async () => setJustAdded(await props.onAdd(selected))}
            className="text-sm font-medium px-4 py-2 rounded-xl bg-blue-600 text-on-accent hover:bg-blue-700 shrink-0"
          >
            添加到我的模板
          </button>
        </div>
      )}
    </div>
  )
}
