import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { SectionTitle, SettingRow, Toggle, Select } from './GeneralTab'
import { IconCloud, IconClose, IconPlus } from '../../components/icons'
import type { ArchiveTarget, AttachmentCategory, AttachmentSettings, AttachmentStats } from '@shared/attachments'
import { ATTACHMENT_CATEGORIES, DEFAULT_ATTACHMENT_PATH_TEMPLATE } from '@shared/attachments'
import { renderPathTemplate } from '@shared/attachment-paths'
import { fmtBytes, useAttachmentEvents } from '../../app/attachments/model'
import { ReleaseSheet, GhostBtn, PrimaryBtn } from '../../app/attachments/Sheets'

const KEEP_DAYS = [
  { value: '0', label: '不按时间' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '180', label: '180 天' },
  { value: '365', label: '1 年' },
  { value: '730', label: '2 年' }
]

/** 设置 → 附件与存储：占用、本地缓存策略、归档目标与目录模板、自动规则 */
export function AttachmentsTab() {
  const [s, setS] = useState<AttachmentSettings | null>(null)
  const [stats, setStats] = useState<AttachmentStats | null>(null)
  const [targets, setTargets] = useState<ArchiveTarget[]>([])
  const [plan, setPlan] = useState<{ count: number; bytes: number } | null>(null)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [tpl, setTpl] = useState('')
  const [msg, setMsg] = useState<{ text: string; url?: string } | null>(null)

  const load = () => {
    void api.attachGetSettings().then(v => {
      setS(v)
      setTpl(v.pathTemplate)
    })
    void api.attachStats().then(setStats)
    void api.attachSuggest(90).then(g => setTargets(g.targets))
    void api.attachReleasePlan(null).then(p => setPlan({ count: p.items.length, bytes: p.bytes }))
  }
  useEffect(load, [])
  useAttachmentEvents(() => {
    void api.attachStats().then(setStats)
    void api.attachReleasePlan(null).then(p => setPlan({ count: p.items.length, bytes: p.bytes }))
  })

  const example = useMemo(
    () =>
      renderPathTemplate(tpl, {
        category: '发票收据',
        date: new Date(2026, 8, 3).getTime(),
        party: 'northwind',
        sender: 'billing@northwind.example',
        account: '工作',
        filename: 'INV-2041.pdf',
        subject: '9 月服务费发票'
      }),
    [tpl]
  )

  if (!s) return null
  const update = async (patch: Partial<AttachmentSettings>) => {
    setS({ ...s, ...patch })
    const next = await api.attachSetSettings(patch)
    setS(next)
    void api.attachReleasePlan(null).then(p => setPlan({ count: p.items.length, bytes: p.bytes }))
  }
  const toggleKeep = (c: AttachmentCategory) =>
    void update({ keepCategories: s.keepCategories.includes(c) ? s.keepCategories.filter(x => x !== c) : [...s.keepCategories, c] })

  const addProton = async () => {
    const res = await api.attachAddProton()
    if (res.ok) {
      setMsg({ text: '已添加 Proton Drive。' })
      void api.attachSuggest(90).then(g => setTargets(g.targets))
    } else setMsg({ text: '本机没有检测到 Proton Drive for macOS（需安装并登录，同步目录出现在「访达 → 位置」里）。', url: res.downloadUrl })
  }

  return (
    <div className="max-w-[640px]">
      <SectionTitle>本地占用</SectionTitle>
      <div className="grid grid-cols-3 gap-2 mt-2">
        <Stat label="附件缓存" value={stats ? fmtBytes(stats.local.bytes) : '…'} sub={stats ? `${stats.local.count} 个文件` : ''} />
        <Stat label="原文镜像（eml）" value={stats ? fmtBytes(stats.emlBytes) : '…'} sub="离线可读，不参与释放" />
        <Stat label="已归档到网盘" value={stats ? String(stats.archived.count) : '…'} sub={stats ? fmtBytes(stats.archived.bytes) : ''} />
      </div>
      {stats && stats.byAccount.length > 0 && (
        <div className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
          按账户：{stats.byAccount.map(b => `${b.label} ${fmtBytes(b.localBytes)}`).join(' · ')}
          {stats.duplicates.length > 0 && <> · 重复文件 {stats.duplicates.length} 组，可省 {fmtBytes(stats.duplicates.reduce((x, d) => x + d.wasted, 0))}</>}
          {stats.orphan.count > 0 && <> · 无记录的旧缓存 {stats.orphan.count} 个（{fmtBytes(stats.orphan.bytes)}，无法恢复，不自动删除）</>}
        </div>
      )}

      <SectionTitle>本地缓存策略</SectionTitle>
      <div className="text-xs leading-relaxed mb-1" style={{ color: 'var(--faint)' }}>
        只给建议，不会自动删除：释放前列出清单由你确认。只删 LinkTo 自己的附件缓存，并且每个文件都能从邮件服务器、本地原文镜像或网盘副本重新取回；释放后点开附件会自动重新下载。
      </div>
      <SettingRow label="保留最近" desc="更早的附件建议从本地释放">
        <Select value={String(s.keepDays)} onChange={v => void update({ keepDays: Number(v) })} options={KEEP_DAYS} />
      </SettingRow>
      <SettingRow label="总量上限" desc="超出时从最旧的开始建议释放（0 = 不限）">
        <span className="inline-flex items-center gap-1.5">
          <input
            type="number"
            min={0}
            step={0.5}
            value={s.maxCacheGB}
            onChange={e => setS({ ...s, maxCacheGB: Number(e.target.value) })}
            onBlur={e => void update({ maxCacheGB: Number(e.target.value) || 0 })}
            className="no-drag w-20 text-sm text-right rounded-[var(--r-sm)] px-2 py-1.5 outline-none border tnum"
            style={{ background: 'var(--bg-soft)', borderColor: 'var(--border)', color: 'var(--fg)' }}
          />
          <span className="text-sm" style={{ color: 'var(--muted)' }}>GB</span>
        </span>
      </SettingRow>
      <SettingRow label="已归档到网盘的可从本地释放" desc="网盘上有确认存在的副本时，本地缓存可以删">
        <Toggle checked={s.releaseArchived} onChange={v => void update({ releaseArchived: v })} />
      </SettingRow>
      <div className="py-3 border-b border-[var(--border-soft)]">
        <div className="text-sm" style={{ color: 'var(--fg)' }}>永久保留的分类</div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--faint)' }}>这些分类永远留在本地，不进释放建议；单个附件也可以在附件中心「钉住」</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {ATTACHMENT_CATEGORIES.map(c => {
            const on = s.keepCategories.includes(c.id)
            return (
              <button
                key={c.id}
                onClick={() => toggleKeep(c.id)}
                aria-pressed={on}
                className="no-drag h-7 px-2.5 rounded-[var(--r-sm)] text-xs border transition-colors"
                style={on ? { background: 'var(--selected)', borderColor: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 600 } : { borderColor: 'var(--border)', color: 'var(--muted)' }}
              >
                {c.label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="py-3 flex items-center gap-3">
        <span className="flex-1 text-sm" style={{ color: 'var(--muted)' }}>
          {plan ? (plan.count ? `按当前策略可释放 ${fmtBytes(plan.bytes)}（${plan.count} 个文件）` : '按当前策略没有需要释放的附件') : '正在计算…'}
        </span>
        <GhostBtn onClick={() => setReleaseOpen(true)} disabled={!plan?.count}>查看清单…</GhostBtn>
      </div>

      <SectionTitle>归档到网盘</SectionTitle>
      {targets.length ? (
        <div className="mt-2 rounded-[var(--r-md)] border divide-y" style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)' }}>
          {targets.map(t => (
            <label key={t.driveId} className="flex items-center gap-3 px-3.5 py-2.5 cursor-pointer" style={{ borderColor: 'var(--border-soft)' }}>
              <input
                type="radio"
                name="default-drive"
                checked={(s.defaultDriveId ?? targets.find(x => x.isProton)?.driveId ?? targets[0].driveId) === t.driveId}
                onChange={() => void update({ defaultDriveId: t.driveId })}
                style={{ accentColor: 'var(--accent)' }}
              />
              <span style={{ color: 'var(--faint)' }}><IconCloud width={15} height={15} /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm" style={{ color: 'var(--fg)' }}>{t.name}</span>
                <span className="block text-2xs truncate" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>{t.root}</span>
              </span>
              <span className="text-2xs" style={{ color: 'var(--faint)' }}>{t.kind === 'local' ? '本地同步目录' : t.kind === 'dropbox' ? 'Dropbox' : 'WebDAV'}</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--muted)' }}>
          还没有网盘。推荐 Proton Drive（端到端加密，经桌面客户端的同步目录）或 Dropbox。
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap gap-2">
        {!targets.some(t => t.isProton) && <PrimaryBtn onClick={() => void addProton()}>添加 Proton Drive</PrimaryBtn>}
        <GhostBtn onClick={() => (location.hash = '#/integrations')}>添加 Dropbox / WebDAV / 同步目录…</GhostBtn>
      </div>
      {msg && (
        <div className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
          {msg.text}
          {msg.url && (
            <button onClick={() => void api.openExternal(msg.url!)} className="ml-1 underline underline-offset-2" style={{ color: 'var(--fg)' }}>
              下载 Proton Drive
            </button>
          )}
        </div>
      )}

      <div className="mt-4 py-3 border-b border-[var(--border-soft)]">
        <div className="text-sm" style={{ color: 'var(--fg)' }}>目录模板</div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--faint)' }}>
          相对网盘根目录；变量 {'{分类} {年份} {月份} {日期} {对方} {发件人} {账户} {主题} {文件名}'}。同名不同内容自动加序号，同内容只存一份
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={tpl}
            onChange={e => setTpl(e.target.value)}
            onBlur={() => tpl !== s.pathTemplate && void update({ pathTemplate: tpl })}
            spellCheck={false}
            className="no-drag flex-1 min-w-0 h-8 px-2.5 rounded-[var(--r-sm)] text-sm outline-none border"
            style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-soft)', borderColor: 'var(--border)', color: 'var(--fg)' }}
          />
          {tpl !== DEFAULT_ATTACHMENT_PATH_TEMPLATE && (
            <GhostBtn
              onClick={() => {
                setTpl(DEFAULT_ATTACHMENT_PATH_TEMPLATE)
                void update({ pathTemplate: DEFAULT_ATTACHMENT_PATH_TEMPLATE })
              }}
            >
              恢复默认
            </GhostBtn>
          )}
        </div>
        <div className="mt-1.5 text-2xs truncate" style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)' }} title={example}>
          例：/LinkTo{example}
        </div>
      </div>

      <SectionTitle>自动规则</SectionTitle>
      <div className="text-xs leading-relaxed mb-2" style={{ color: 'var(--faint)' }}>
        这些分类的新附件到达后，自动在后台归档到指定网盘（只对设置之后到达的附件生效）。
      </div>
      {s.autoRules.map((r, i) => (
        <div key={i} className="flex items-center gap-2 py-1.5">
          <Select
            value={r.category}
            onChange={v => void update({ autoRules: s.autoRules.map((x, k) => (k === i ? { ...x, category: v as AttachmentCategory } : x)) })}
            options={ATTACHMENT_CATEGORIES.map(c => ({ value: c.id, label: c.label }))}
          />
          <span className="text-sm" style={{ color: 'var(--faint)' }}>→</span>
          <Select
            value={r.driveId}
            onChange={v => void update({ autoRules: s.autoRules.map((x, k) => (k === i ? { ...x, driveId: v } : x)) })}
            options={targets.map(t => ({ value: t.driveId, label: t.name }))}
          />
          <button
            onClick={() => void update({ autoRules: s.autoRules.filter((_, k) => k !== i) })}
            aria-label="删除规则"
            className="icon-btn w-7 h-7 inline-flex items-center justify-center"
            style={{ color: 'var(--faint)' }}
          >
            <IconClose width={12} height={12} />
          </button>
        </div>
      ))}
      <button
        onClick={() => targets[0] && void update({ autoRules: [...s.autoRules, { category: 'invoice', driveId: s.defaultDriveId ?? targets[0].driveId }] })}
        disabled={!targets.length}
        className="no-drag mt-1 text-xs inline-flex items-center gap-1 h-7 px-2 rounded-[var(--r-sm)] hover:bg-[var(--hover)] disabled:opacity-40"
        style={{ color: 'var(--fg)' }}
        title={targets.length ? undefined : '先添加一个网盘'}
      >
        <IconPlus width={12} height={12} /> 添加规则
      </button>

      <SectionTitle>分类</SectionTitle>
      <SettingRow label="AI 补充分类" desc="文件名看不出类别的附件（扫描件、image.pdf…），用已配置的 AI 按文件名、主题与对方补充判断；只发送这三项，不发送附件内容">
        <Toggle checked={s.aiAssist} onChange={v => void update({ aiAssist: v })} />
      </SettingRow>

      {releaseOpen && <ReleaseSheet onClose={() => setReleaseOpen(false)} onDone={() => load()} />}
    </div>
  )
}

function Stat(props: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[var(--r-md)] border px-3 py-2.5" style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)' }}>
      <div className="text-2xs" style={{ color: 'var(--faint)' }}>{props.label}</div>
      <div className="mt-0.5 text-md font-semibold tnum" style={{ color: 'var(--fg)' }}>{props.value}</div>
      {props.sub && <div className="text-2xs truncate" style={{ color: 'var(--faint)' }}>{props.sub}</div>}
    </div>
  )
}
