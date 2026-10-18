import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { IconClose, IconCloud, IconFolder, IconChevronRight, IconCheck, IconRefresh } from '../../components/icons'
import type { ArchiveJobStatus, ArchivePreview, ArchiveTarget, ReleasePlan } from '@shared/attachments'
import { buildPathTree, type PathTreeNode } from '@shared/attachment-paths'
import { attachmentCategoryLabel, fmtBytes, RELEASE_REASON, VIA_LABEL } from './model'

/** 模态外壳：scrim + 实底面板（Esc 关闭） */
export function Sheet(props: { title: string; sub?: string; width?: number; onClose(): void; children: React.ReactNode; footer?: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [props.onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 fade-in" style={{ background: 'var(--scrim)' }} onClick={props.onClose}>
      <div
        role="dialog"
        aria-label={props.title}
        className="w-full max-h-[86vh] flex flex-col overflow-hidden pop-in"
        style={{ maxWidth: props.width ?? 640, background: 'var(--surface-strong)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-float)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 pt-4 pb-3 flex items-start gap-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex-1 min-w-0">
            <div className="text-md font-semibold" style={{ color: 'var(--fg)' }}>{props.title}</div>
            {props.sub && <div className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>{props.sub}</div>}
          </div>
          <button onClick={props.onClose} aria-label="关闭" className="icon-btn w-7 h-7 inline-flex items-center justify-center" style={{ color: 'var(--faint)' }}>
            <IconClose width={14} height={14} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">{props.children}</div>
        {props.footer && (
          <div className="shrink-0 px-5 py-3 flex items-center gap-2 border-t" style={{ borderColor: 'var(--border)', background: 'var(--bg-soft)' }}>
            {props.footer}
          </div>
        )}
      </div>
    </div>
  )
}

export function PrimaryBtn(props: { onClick(): void; disabled?: boolean; children: React.ReactNode; title?: string }) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      className="h-8 px-3.5 rounded-[var(--r-sm)] text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-40 inline-flex items-center gap-1.5"
      style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}
    >
      {props.children}
    </button>
  )
}

export function GhostBtn(props: { onClick(): void; disabled?: boolean; children: React.ReactNode; title?: string; tone?: 'danger' }) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      className="h-8 px-3 rounded-[var(--r-sm)] text-sm border transition-colors hover:bg-[var(--hover)] disabled:opacity-40 inline-flex items-center gap-1.5"
      style={{ borderColor: 'var(--border)', color: props.tone === 'danger' ? 'var(--danger-ink)' : 'var(--fg)', background: 'var(--surface-strong)' }}
    >
      {props.children}
    </button>
  )
}

function TreeRows(props: { node: PathTreeNode; depth: number; open: Set<string>; toggle(path: string): void; prefix: string }) {
  return (
    <>
      {props.node.children
        .slice()
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .map(c => {
          const path = `${props.prefix}/${c.name}`
          const isOpen = props.depth < 2 ? !props.open.has(path) : props.open.has(path)
          return (
            <div key={path}>
              <button
                onClick={() => props.toggle(path)}
                className="w-full h-7 flex items-center gap-1.5 rounded-[var(--r-xs)] hover:bg-[var(--hover)] text-left"
                style={{ paddingLeft: 6 + props.depth * 16, color: 'var(--fg)' }}
              >
                <span className="w-3 inline-flex justify-center transition-transform" style={{ color: 'var(--faint)', transform: isOpen ? 'rotate(90deg)' : 'none', opacity: c.children.length ? 1 : 0 }}>
                  <IconChevronRight width={11} height={11} />
                </span>
                <span style={{ color: 'var(--faint)' }}><IconFolder width={13} height={13} /></span>
                <span className="flex-1 min-w-0 truncate text-sm">{c.name}</span>
                <span className="text-2xs tnum shrink-0 pr-2" style={{ color: 'var(--faint)' }}>{c.count} 个 · {fmtBytes(c.bytes)}</span>
              </button>
              {isOpen && c.children.length > 0 && <TreeRows node={c} depth={props.depth + 1} open={props.open} toggle={props.toggle} prefix={path} />}
            </div>
          )
        })}
    </>
  )
}

/** 目录树预览（前两层默认展开） */
export function PathTree(props: { items: { path: string; size: number }[] }) {
  const tree = useMemo(() => buildPathTree(props.items), [props.items])
  // 记录被用户切换过的目录：前两层默认展开，更深默认收起
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const toggle = (p: string) =>
    setOpen(prev => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  if (!props.items.length) return <div className="text-xs py-3" style={{ color: 'var(--faint)' }}>没有需要上传的附件。</div>
  return <TreeRows node={tree} depth={0} open={open} toggle={toggle} prefix="" />
}

export function JobProgress(props: { job: ArchiveJobStatus; compact?: boolean }) {
  const j = props.job
  const pct = j.total ? Math.round((j.done / j.total) * 100) : 0
  const label =
    j.state === 'running' ? (j.current ? `正在归档：${j.current}` : '正在归档…') : j.state === 'paused' ? '已暂停' : j.state === 'cancelled' ? '已取消' : '归档完成'
  return (
    <div>
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
        <span className="flex-1 min-w-0 truncate">{label}</span>
        <span className="tnum shrink-0">{j.done}/{j.total}</span>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--hover-strong)' }}>
        <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: j.failed.length ? 'var(--warn)' : 'var(--accent)' }} />
      </div>
      {!props.compact && (
        <div className="mt-1.5 text-2xs tnum" style={{ color: 'var(--faint)' }}>
          上传 {j.uploaded} · 跳过 {j.skipped}（已在网盘 / 同内容）{j.failed.length ? ` · 失败 ${j.failed.length}` : ''} · {fmtBytes(j.bytesDone)} → {j.driveName}
        </div>
      )}
    </div>
  )
}

/**
 * 一键归档：选目标网盘 → 预览目录树（模板可临时改）→ 后台队列执行（进度 / 暂停 / 取消 / 失败重试）。
 * 完成后可直接进入「释放本地空间」。
 */
export function ArchiveSheet(props: {
  ids: string[]
  targets: ArchiveTarget[]
  initialDriveId: string | null
  onClose(): void
  onRelease?(ids: string[]): void
}) {
  const [driveId, setDriveId] = useState<string | null>(props.initialDriveId ?? props.targets[0]?.driveId ?? null)
  const [template, setTemplate] = useState('')
  const [preview, setPreview] = useState<ArchivePreview | null>(null)
  const [job, setJob] = useState<ArchiveJobStatus | null>(null)
  const [started, setStarted] = useState(false)

  useEffect(() => {
    void api.attachGetSettings().then(s => setTemplate(s.pathTemplate))
    void api.attachArchiveStatus().then(s => {
      if (s && (s.state === 'running' || s.state === 'paused')) {
        setJob(s)
        setStarted(true)
      }
    })
    const off = api.onEvent(ev => {
      const e = ev as { type: string; status?: ArchiveJobStatus | null }
      if (e.type === 'attachments-job') setJob(e.status ?? null)
    })
    return () => off()
  }, [])

  useEffect(() => {
    if (!driveId || !template) return
    let alive = true
    const t = window.setTimeout(() => {
      void api.attachArchivePreview(driveId, props.ids, template).then(p => alive && setPreview(p))
    }, 200)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [driveId, template, props.ids])

  const uploads = useMemo(() => (preview?.items ?? []).filter(i => i.action === 'upload' || i.action === 'download-upload'), [preview])
  const needDownload = uploads.filter(i => i.action === 'download-upload').length
  const byCat = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of uploads) m.set(i.category, (m.get(i.category) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [uploads])
  const target = props.targets.find(t => t.driveId === driveId)

  const start = async () => {
    if (!driveId) return
    setStarted(true)
    // 同内容的也排进队列：不重复上传，只登记到已有副本（附件卡同样显示「已在 xx」）
    const ids = (preview?.items ?? []).filter(i => i.action !== 'skip-archived').map(i => i.id)
    setJob(await api.attachArchiveStart(driveId, ids))
  }

  const done = job && (job.state === 'done' || job.state === 'cancelled')
  return (
    <Sheet
      title={started ? '归档到网盘' : '归档预览'}
      sub={started ? undefined : `${props.ids.length} 个附件 · 按目录模板分门别类保存`}
      width={680}
      onClose={props.onClose}
      footer={
        !started ? (
          <>
            <span className="flex-1 text-xs" style={{ color: 'var(--muted)' }}>
              {preview ? `上传 ${uploads.length} 个（${fmtBytes(preview.uploadBytes)}）${preview.skipCount ? ` · 跳过 ${preview.skipCount} 个已在网盘或同内容` : ''}${needDownload ? ` · 其中 ${needDownload} 个需先从邮箱下载` : ''}` : '正在生成预览…'}
            </span>
            <GhostBtn onClick={props.onClose}>取消</GhostBtn>
            <PrimaryBtn onClick={() => void start()} disabled={!uploads.length || !driveId}>
              <IconCloud width={14} height={14} /> 开始归档
            </PrimaryBtn>
          </>
        ) : (
          <>
            <span className="flex-1 text-xs" style={{ color: 'var(--muted)' }}>{done ? '可以关闭此窗口' : '在后台进行：关闭窗口不会中断'}</span>
            {job?.state === 'running' && <GhostBtn onClick={() => void api.attachArchiveControl('pause').then(setJob)}>暂停</GhostBtn>}
            {job?.state === 'paused' && <GhostBtn onClick={() => void api.attachArchiveControl('resume').then(setJob)}>继续</GhostBtn>}
            {job && !done && <GhostBtn tone="danger" onClick={() => void api.attachArchiveControl('cancel').then(setJob)}>取消任务</GhostBtn>}
            {job && job.failed.length > 0 && done && (
              <GhostBtn onClick={() => void api.attachArchiveControl('retry').then(setJob)}>
                <IconRefresh width={13} height={13} /> 重试失败的 {job.failed.length} 个
              </GhostBtn>
            )}
            {done && props.onRelease && job && job.uploaded + job.skipped > 0 && (
              <GhostBtn onClick={() => props.onRelease?.(props.ids)}>释放本地空间…</GhostBtn>
            )}
            <PrimaryBtn onClick={props.onClose}>{done ? '完成' : '后台运行'}</PrimaryBtn>
          </>
        )
      }
    >
      {!started ? (
        <div className="flex flex-col gap-4">
          {props.targets.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {props.targets.map(t => (
                <button
                  key={t.driveId}
                  onClick={() => setDriveId(t.driveId)}
                  className="h-7 px-2.5 rounded-[var(--r-sm)] text-xs border inline-flex items-center gap-1.5 transition-colors"
                  style={
                    t.driveId === driveId
                      ? { background: 'var(--selected)', borderColor: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 600 }
                      : { borderColor: 'var(--border)', color: 'var(--muted)' }
                  }
                >
                  <IconCloud width={12} height={12} /> {t.name}
                </button>
              ))}
            </div>
          )}
          <label className="block">
            <span className="text-2xs caps" style={{ color: 'var(--faint)' }}>目录模板</span>
            <input
              value={template}
              onChange={e => setTemplate(e.target.value)}
              spellCheck={false}
              className="mt-1 w-full h-8 px-2.5 rounded-[var(--r-sm)] text-sm outline-none border focus:border-[var(--border-strong)]"
              style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-soft)', borderColor: 'var(--border)', color: 'var(--fg)' }}
            />
            <span className="mt-1 block text-2xs" style={{ color: 'var(--faint)' }}>
              可用变量：{'{分类} {年份} {月份} {日期} {对方} {发件人} {账户} {主题} {文件名}'} · 同名不同内容自动加序号，同内容只存一份
            </span>
          </label>
          {byCat.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {byCat.map(([c, n]) => (
                <span key={c} className="text-2xs h-5 px-1.5 rounded-[var(--r-xs)] inline-flex items-center tnum" style={{ background: 'var(--hover)', color: 'var(--muted)' }}>
                  {attachmentCategoryLabel(c)} {n}
                </span>
              ))}
            </div>
          )}
          <div className="rounded-[var(--r-md)] border p-1.5" style={{ borderColor: 'var(--border)' }}>
            <div className="px-2 pt-1 pb-1.5 text-2xs truncate" style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)' }} title={target?.root}>
              {target?.name} · {target?.root}
            </div>
            <PathTree key={`${driveId}|${template}`} items={uploads.map(u => ({ path: u.target, size: u.size }))} />
          </div>
        </div>
      ) : job ? (
        <div className="flex flex-col gap-4">
          <JobProgress job={job} />
          {job.state === 'done' && !job.failed.length && (
            <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--ok-ink)' }}>
              <IconCheck width={14} height={14} /> 已按目录结构保存到 {job.driveName}，附件卡会显示「已在 {job.driveName}」
            </div>
          )}
          {job.failed.length > 0 && (
            <div className="rounded-[var(--r-md)] p-3" style={{ background: 'var(--danger-soft)' }}>
              <div className="text-xs font-medium" style={{ color: 'var(--danger-ink)' }}>{job.failed.length} 个失败</div>
              <div className="mt-1.5 flex flex-col gap-1 max-h-[180px] overflow-y-auto">
                {job.failed.map(f => (
                  <div key={f.id} className="text-2xs" style={{ color: 'var(--danger-ink)' }}>
                    <span className="font-medium">{f.filename}</span>：{f.error}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-sm" style={{ color: 'var(--muted)' }}>正在启动…</div>
      )}
    </Sheet>
  )
}

/**
 * 释放本地空间：先列清单（原因 + 可从哪里恢复），用户勾选确认后执行。
 * ids 为空 = 按缓存策略给建议；非空 = 用户手动选的附件。
 */
export function ReleaseSheet(props: { ids?: string[] | null; onClose(): void; onDone?(msg: string): void }) {
  const [plan, setPlan] = useState<ReleasePlan | null>(null)
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)

  useEffect(() => {
    void api.attachReleasePlan(props.ids ?? null).then(setPlan)
  }, [props.ids])

  const chosen = (plan?.items ?? []).filter(i => !unchecked.has(i.id))
  const bytes = chosen.reduce((s, i) => s + i.size, 0)

  const run = async () => {
    setBusy(true)
    const res = await api.attachRelease(chosen.map(i => i.id))
    setBusy(false)
    const msg = `已释放 ${fmtBytes(res.bytes)}（${res.released} 个文件）${res.skipped.length ? `，${res.skipped.length} 个未释放` : ''}`
    setResult(msg)
    props.onDone?.(msg)
  }

  return (
    <Sheet
      title="释放本地空间"
      sub="只删除 LinkTo 自己缓存的附件文件；每个都能从邮件服务器、本地原文或网盘重新取回，点开时自动重新下载"
      width={640}
      onClose={props.onClose}
      footer={
        result ? (
          <>
            <span className="flex-1 text-xs" style={{ color: 'var(--ok-ink)' }}>{result}</span>
            <PrimaryBtn onClick={props.onClose}>完成</PrimaryBtn>
          </>
        ) : (
          <>
            <span className="flex-1 text-xs tnum" style={{ color: 'var(--muted)' }}>
              {plan ? `已选 ${chosen.length} 个 · ${fmtBytes(bytes)}` : '正在计算…'}
            </span>
            <GhostBtn onClick={props.onClose}>取消</GhostBtn>
            <PrimaryBtn onClick={() => void run()} disabled={!chosen.length || busy}>
              {busy ? '正在释放…' : `删除本地缓存 ${fmtBytes(bytes)}`}
            </PrimaryBtn>
          </>
        )
      }
    >
      {!plan ? (
        <div className="text-sm" style={{ color: 'var(--faint)' }}>正在计算…</div>
      ) : (
        <div className="flex flex-col gap-3">
          {!plan.items.length && (
            <div className="text-sm py-2" style={{ color: 'var(--muted)' }}>
              {props.ids?.length ? '所选附件都不满足释放条件（见下方原因）。' : '按当前缓存策略，没有需要释放的附件。'}
            </div>
          )}
          {plan.items.length > 0 && (
            <div className="rounded-[var(--r-md)] border divide-y" style={{ borderColor: 'var(--border)' }}>
              {plan.items.map(i => {
                const on = !unchecked.has(i.id)
                return (
                  <label key={i.id} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-[var(--hover)]" style={{ borderColor: 'var(--border-soft)' }}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setUnchecked(prev => {
                          const next = new Set(prev)
                          if (next.has(i.id)) next.delete(i.id)
                          else next.add(i.id)
                          return next
                        })
                      }
                      className="shrink-0"
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-sm" style={{ color: on ? 'var(--fg)' : 'var(--faint)' }}>{i.filename}</span>
                      <span className="block text-2xs mt-0.5" style={{ color: 'var(--faint)' }}>
                        {attachmentCategoryLabel(i.category)} · {RELEASE_REASON[i.reason]} · 可从{i.via.map(v => VIA_LABEL[v]).join(' / ')}恢复
                      </span>
                    </span>
                    <span className="text-xs tnum shrink-0" style={{ color: 'var(--muted)' }}>{fmtBytes(i.size)}</span>
                  </label>
                )
              })}
            </div>
          )}
          {plan.skipped.length > 0 && (
            <div>
              <button onClick={() => setShowSkipped(s => !s)} className="text-xs hover:underline" style={{ color: 'var(--muted)' }}>
                {showSkipped ? '收起' : '查看'} {plan.skipped.length} 个不会释放的附件
              </button>
              {showSkipped && (
                <div className="mt-2 flex flex-col gap-1">
                  {plan.skipped.map(s => (
                    <div key={s.id} className="text-2xs flex gap-2" style={{ color: 'var(--faint)' }}>
                      <span className="truncate flex-1 min-w-0">{s.filename}</span>
                      <span className="shrink-0">{s.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Sheet>
  )
}
