import { useEffect, useMemo, useState } from 'react'
import { api, useMailEvent } from '../../lib/api'
import { SectionTitle, SettingRow, Select, Toggle } from './GeneralTab'
import { IconPlus, IconTrash, IconSend, IconFolder } from '../../components/icons'
import type { CloudDriveConfig } from '@shared/types'
import {
  SHARE_GROUP_LABEL,
  SHARE_KINDS,
  kindMeta,
  renderNameTemplate,
  type ShareField,
  type ShareSettings,
  type ShareTargetInfo,
  type ShareTargetInput,
  type ShareTargetKind
} from '@shared/share'

/** 设置 → 分享与导出：管理分享目标（添加 / 测试 / 删除）、默认导出目录、命名模板、PDF 与长图选项 */
export function ShareTab() {
  const [s, setS] = useState<ShareSettings | null>(null)
  const [targets, setTargets] = useState<ShareTargetInfo[]>([])
  const [drives, setDrives] = useState<CloudDriveConfig[]>([])
  const [editing, setEditing] = useState<{ kind: ShareTargetKind; target?: ShareTargetInfo } | null>(null)
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [tpl, setTpl] = useState('')

  const load = () => {
    void api.shareSettings().then(v => {
      setS(v)
      setTpl(v.nameTemplate)
    })
    void api.shareTargets().then(setTargets)
    void api.listCloudDrives().then(setDrives)
  }
  useEffect(load, [])
  useMailEvent(ev => {
    if ((ev as { type: string }).type === 'share-targets-changed') void api.shareTargets().then(setTargets)
  })

  const example = useMemo(
    () => `${renderNameTemplate(tpl, { subject: '10 月服务费对账单', from: 'Northwind 财务', fromAddr: 'billing@northwind.example', date: new Date(2026, 9, 19, 9, 30).getTime(), account: '工作' })}.pdf`,
    [tpl]
  )

  if (!s) return null
  const update = async (patch: Partial<ShareSettings>) => {
    setS({ ...s, ...patch })
    setS(await api.shareSetSettings(patch))
  }
  const configured = targets.filter(t => t.config)

  const test = async (id: string) => {
    setBusy(id)
    setMsg(m => ({ ...m, [id]: { ok: true, text: '测试中…' } }))
    const r = await api.shareTestTarget(id)
    setMsg(m => ({ ...m, [id]: { ok: r.ok, text: r.ok ? r.message ?? '成功' : r.error ?? '失败' } }))
    setBusy(null)
  }
  const remove = async (t: ShareTargetInfo) => {
    if (!window.confirm(`删除分享目标「${t.name}」？保存的 Webhook 地址 / 令牌会一并清除。`)) return
    await api.shareRemoveTarget(t.id)
    void api.shareTargets().then(setTargets)
  }
  const pickExportDir = async () => {
    const dir = await api.pickDirectory('选择默认导出目录')
    if (dir) void update({ exportDir: dir })
  }

  return (
    <div className="max-w-[680px]">
      <SectionTitle>分享目标</SectionTitle>
      <div className="text-xs leading-relaxed mb-2" style={{ color: 'var(--faint)' }}>
        把邮件发到群机器人、Telegram、笔记工具或固定文件夹。Webhook 地址、签名密钥和令牌加密保存在本机钥匙串；每次对外发送前都会让你确认。系统分享、微信、WhatsApp、剪贴板和网盘无需配置，直接在分享面板（⌘⇧E）里用。
      </div>
      <div className="rounded-[var(--r-md)] border divide-y" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        {configured.length === 0 && (
          <div className="px-4 py-4 text-sm" style={{ color: 'var(--faint)' }}>
            还没有配置分享目标。
          </div>
        )}
        {configured.map(t => {
          const m = msg[t.id]
          return (
            <div key={t.id} className="px-4 py-3 flex items-center gap-3" style={{ borderColor: 'var(--border-soft)' }}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate" style={{ color: 'var(--fg)' }}>{t.name}</span>
                  <span className="text-2xs px-1.5 h-5 inline-flex items-center rounded-[var(--r-xs)] shrink-0" style={{ background: 'var(--hover)', color: 'var(--muted)' }}>
                    {kindMeta(t.config!.kind).label} · {SHARE_GROUP_LABEL[t.group]}
                  </span>
                </div>
                <div className="text-2xs truncate mt-0.5" style={{ color: m ? (m.ok ? 'var(--ok-ink)' : 'var(--danger-ink)') : 'var(--faint)' }}>
                  {m ? m.text : t.hint || '—'}
                </div>
              </div>
              <button onClick={() => void test(t.id)} disabled={busy === t.id} className="h-7 px-2.5 rounded-[var(--r-sm)] text-xs border hover:bg-[var(--hover)] disabled:opacity-40 inline-flex items-center gap-1" style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}>
                <IconSend width={12} height={12} /> 测试发送
              </button>
              <button onClick={() => setEditing({ kind: t.config!.kind, target: t })} className="h-7 px-2.5 rounded-[var(--r-sm)] text-xs border hover:bg-[var(--hover)]" style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}>
                编辑
              </button>
              <button onClick={() => void remove(t)} className="icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--danger)' }} aria-label={`删除 ${t.name}`} title="删除">
                <IconTrash width={13} height={13} />
              </button>
            </div>
          )
        })}
      </div>
      {editing ? (
        <TargetForm key={editing.target?.id ?? editing.kind} kind={editing.kind} target={editing.target} drives={drives} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void api.shareTargets().then(setTargets) }} />
      ) : (
        <div className="mt-3">
          <div className="text-xs mb-1.5" style={{ color: 'var(--muted)' }}>添加目标</div>
          <div className="flex flex-wrap gap-1.5">
            {SHARE_KINDS.map(k => (
              <button
                key={k.kind}
                onClick={() => setEditing({ kind: k.kind })}
                className="no-drag h-7 px-2.5 rounded-[var(--r-sm)] text-xs border transition-colors hover:bg-[var(--hover)] inline-flex items-center gap-1"
                style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
              >
                <IconPlus width={11} height={11} /> {k.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <SectionTitle>导出</SectionTitle>
      <SettingRow label="默认导出目录" desc={s.exportDir || '未设置：导出到「下载 / LinkTo」'}>
        <span className="inline-flex gap-1.5">
          {s.exportDir && (
            <button onClick={() => void update({ exportDir: null })} className="h-7 px-2.5 rounded-[var(--r-sm)] text-xs border hover:bg-[var(--hover)]" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
              恢复默认
            </button>
          )}
          <button onClick={() => void pickExportDir()} className="h-7 px-2.5 rounded-[var(--r-sm)] text-xs border hover:bg-[var(--hover)] inline-flex items-center gap-1" style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}>
            <IconFolder width={12} height={12} /> 选择…
          </button>
        </span>
      </SettingRow>
      <SettingRow label="每次导出都选择位置" desc="关闭时直接存到默认导出目录（快速导出）；打开时弹出保存对话框，并记住上次的目录">
        <Toggle checked={s.askWhere} onChange={v => void update({ askWhere: v })} />
      </SettingRow>
      <div className="py-3 border-b border-[var(--border-soft)]">
        <div className="text-sm" style={{ color: 'var(--fg)' }}>文件命名模板</div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--faint)' }}>
          可用：{'{date} {time} {year} {month} {day} {subject} {from} {fromAddr} {account}'}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={tpl}
            onChange={e => setTpl(e.target.value)}
            onBlur={() => void update({ nameTemplate: tpl })}
            className="no-drag flex-1 h-8 px-2.5 rounded-[var(--r-sm)] text-sm outline-none border"
            style={{ background: 'var(--bg-soft)', borderColor: 'var(--border)', color: 'var(--fg)', fontFamily: 'var(--font-mono)' }}
          />
        </div>
        <div className="mt-1.5 text-xs" style={{ color: 'var(--muted)' }}>
          示例：<span style={{ fontFamily: 'var(--font-mono)' }}>{example}</span>
        </div>
      </div>

      <SectionTitle>PDF 与长图</SectionTitle>
      <SettingRow label="PDF / 长图含附件清单" desc="在正文后列出附件名与大小">
        <Toggle checked={s.pdfAttachmentList} onChange={v => void update({ pdfAttachmentList: v })} />
      </SettingRow>
      <SettingRow label="多封导出 PDF 时合并成一个文件" desc="关闭时每封邮件各自一个 PDF；分享面板里也可以临时切换">
        <Toggle checked={s.pdfMerge} onChange={v => void update({ pdfMerge: v })} />
      </SettingRow>
      <SettingRow label="远程图片" desc="导出 PDF / 长图 / 富文本时是否加载邮件里的网络图片（加载会让发件方知道你打开过）">
        <Select
          value={s.remoteImages}
          onChange={v => void update({ remoteImages: v as ShareSettings['remoteImages'] })}
          options={[
            { value: 'follow', label: '跟随阅读设置' },
            { value: 'allow', label: '加载' },
            { value: 'block', label: '不加载' }
          ]}
        />
      </SettingRow>
      <SettingRow label="长图宽度" desc="发微信建议 750；更宽适合电脑上看">
        <Select
          value={String(s.imageWidth)}
          onChange={v => void update({ imageWidth: Number(v) })}
          options={[600, 750, 900, 1080].map(n => ({ value: String(n), label: `${n} 像素` }))}
        />
      </SettingRow>
      <SettingRow label="IM 消息正文摘录" desc="发到群机器人 / Telegram / flomo 时正文最多带多少字">
        <Select
          value={String(s.excerptChars)}
          onChange={v => void update({ excerptChars: Number(v) })}
          options={[200, 400, 600, 1000, 2000].map(n => ({ value: String(n), label: `${n} 字` }))}
        />
      </SettingRow>
    </div>
  )
}

function TargetForm(props: { kind: ShareTargetKind; target?: ShareTargetInfo; drives: CloudDriveConfig[]; onClose(): void; onSaved(): void }) {
  const meta = kindMeta(props.kind)
  const cfg = props.target?.config
  const [v, setV] = useState<Record<string, string>>(() => ({
    name: cfg?.name ?? meta.label,
    chatId: cfg?.chatId ?? '',
    parentType: cfg?.parentType ?? 'database',
    parentId: cfg?.parentId ?? '',
    folder: cfg?.folder ?? '',
    pathTemplate: cfg?.pathTemplate ?? '',
    driveId: cfg?.driveId ?? '',
    tags: cfg?.tags ?? '',
    notesFolder: cfg?.notesFolder ?? '',
    apiBase: cfg?.apiBase ?? '',
    url: '',
    secret: '',
    token: ''
  }))
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (k: string, val: string) => setV(p => ({ ...p, [k]: val }))

  const save = async () => {
    setSaving(true)
    setErr('')
    const input: ShareTargetInput = {
      id: cfg?.id,
      kind: props.kind,
      name: v.name,
      chatId: v.chatId,
      parentType: v.parentType === 'page' ? 'page' : 'database',
      parentId: v.parentId,
      folder: v.folder,
      pathTemplate: v.pathTemplate,
      driveId: v.driveId || null,
      tags: v.tags,
      notesFolder: v.notesFolder,
      apiBase: v.apiBase,
      url: v.url,
      secret: v.secret,
      token: v.token
    }
    const r = await api.shareSaveTarget(input)
    setSaving(false)
    if (r.ok) props.onSaved()
    else setErr(r.error ?? '保存失败')
  }

  const saved = props.target?.secrets
  const field = (f: ShareField) => {
    const has = f.secret && saved && (f.key === 'url' ? saved.url : f.key === 'secret' ? saved.secret : f.key === 'token' ? saved.token : false)
    if (f.kind === 'drive')
      return (
        <select value={v.driveId} onChange={e => set('driveId', e.target.value)} className="no-drag w-full h-8 px-2 rounded-[var(--r-sm)] text-sm outline-none border" style={{ background: 'var(--bg-soft)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
          <option value="">不存（PDF / 长图 / 附件不会发出）</option>
          {props.drives.map(d => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.kind === 'dropbox' ? '（附分享链接）' : '（附位置说明）'}
            </option>
          ))}
        </select>
      )
    if (f.kind === 'select')
      return (
        <select value={v[f.key]} onChange={e => set(f.key, e.target.value)} className="no-drag w-full h-8 px-2 rounded-[var(--r-sm)] text-sm outline-none border" style={{ background: 'var(--bg-soft)', borderColor: 'var(--border)', color: 'var(--fg)' }}>
          {f.options?.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
    if (f.kind === 'dir')
      return (
        <div className="flex items-center gap-2">
          <span className="flex-1 min-w-0 h-8 px-2.5 inline-flex items-center rounded-[var(--r-sm)] text-xs border truncate" style={{ background: 'var(--bg-soft)', borderColor: 'var(--border)', color: v[f.key] ? 'var(--fg)' : 'var(--faint)' }}>
            {v[f.key] || '未选择'}
          </span>
          <button
            onClick={() => void api.pickDirectory(f.label).then(d => d && set(f.key, d))}
            className="h-8 px-2.5 rounded-[var(--r-sm)] text-xs border hover:bg-[var(--hover)] inline-flex items-center gap-1 shrink-0"
            style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
          >
            <IconFolder width={12} height={12} /> 选择…
          </button>
        </div>
      )
    return (
      <input
        type={f.secret ? 'password' : 'text'}
        value={v[f.key]}
        onChange={e => set(f.key, e.target.value)}
        placeholder={has ? '已保存（留空保持不变）' : f.placeholder}
        autoComplete="off"
        spellCheck={false}
        className="no-drag w-full h-8 px-2.5 rounded-[var(--r-sm)] text-sm outline-none border"
        style={{ background: 'var(--bg-soft)', borderColor: 'var(--border)', color: 'var(--fg)', fontFamily: f.secret || f.key === 'chatId' || f.key === 'parentId' ? 'var(--font-mono)' : undefined }}
      />
    )
  }

  return (
    <div className="mt-3 rounded-[var(--r-md)] border p-4" style={{ borderColor: 'var(--accent)', background: 'var(--surface)' }}>
      <div className="text-sm font-semibold" style={{ color: 'var(--fg)' }}>{cfg ? `编辑：${cfg.name}` : `添加：${meta.label}`}</div>
      <div className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--muted)' }}>{meta.help}</div>
      <div className="mt-3 grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 items-center">
        <label className="text-xs" style={{ color: 'var(--muted)' }}>名称</label>
        <input value={v.name} onChange={e => set('name', e.target.value)} className="no-drag w-full h-8 px-2.5 rounded-[var(--r-sm)] text-sm outline-none border" style={{ background: 'var(--bg-soft)', borderColor: 'var(--border)', color: 'var(--fg)' }} />
        {meta.fields.map(f => (
          <FieldRow key={f.key} label={f.label} optional={f.optional}>
            {field(f)}
          </FieldRow>
        ))}
      </div>
      {err && (
        <div className="mt-3 text-xs rounded-[var(--r-sm)] px-2.5 py-1.5" role="alert" style={{ background: 'var(--danger-soft)', color: 'var(--danger-ink)' }}>
          {err}
        </div>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button onClick={props.onClose} className="h-8 px-3 rounded-[var(--r-sm)] text-sm border hover:bg-[var(--hover)]" style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}>
          取消
        </button>
        <button onClick={() => void save()} disabled={saving} className="h-8 px-3.5 rounded-[var(--r-sm)] text-sm font-medium hover:opacity-90 disabled:opacity-40" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

function FieldRow(props: { label: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <>
      <label className="text-xs" style={{ color: 'var(--muted)' }}>
        {props.label}
        {props.optional && <span style={{ color: 'var(--faint)' }}>（可选）</span>}
      </label>
      <div className="min-w-0">{props.children}</div>
    </>
  )
}
