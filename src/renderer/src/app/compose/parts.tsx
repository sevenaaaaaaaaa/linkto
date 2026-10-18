import { useEffect, useRef } from 'react'
import { api, fmtSize } from '../../lib/api'
import { IconClose, IconSparkles } from '../../components/icons'
import type { SendIssue } from './send-check'
import type { AiJob } from './ai'
import { REWRITE_STYLES } from './ai'
import type { ComposeRewriteStyle } from '@shared/ipc'

/* ---------- 附件胶囊 ---------- */

const EXT_KIND: [RegExp, string][] = [
  [/^(png|jpe?g|gif|webp|heic|svg|bmp|tiff?)$/, 'img'],
  [/^pdf$/, 'pdf'],
  [/^(docx?|pages|rtf|txt|md|odt)$/, 'doc'],
  [/^(xlsx?|numbers|csv|ods)$/, 'sheet'],
  [/^(pptx?|key|odp)$/, 'slide'],
  [/^(zip|rar|7z|tar|gz|tgz|dmg)$/, 'zip'],
  [/^(mp4|mov|avi|mkv|mp3|wav|m4a)$/, 'media']
]

function extOf(name: string): string {
  const m = name.match(/\.([a-z0-9]{1,6})$/i)
  return m ? m[1].toLowerCase() : ''
}

/** 类型图标：一张折角纸 + 扩展名（不同类型用不同语义色的细节，颜色全部来自 token） */
export function FileGlyph({ name }: { name: string }) {
  const ext = extOf(name)
  const kind = EXT_KIND.find(([re]) => re.test(ext))?.[1] ?? 'file'
  return (
    <span className="att-glyph" data-kind={kind} aria-hidden>
      <span className="att-glyph-ext">{(ext || 'file').slice(0, 4)}</span>
    </span>
  )
}

export function AttachmentChips(props: {
  items: { path: string; name: string; size: number }[]
  onRemove(i: number): void
  limit: number
}) {
  const total = props.items.reduce((s, a) => s + (a.size || 0), 0)
  const over = total > props.limit
  return (
    <div className="cmp-attachments">
      <div className="flex flex-wrap gap-1.5">
        {props.items.map((a, i) => (
          <span key={a.path} className="att-chip" title={a.path}>
            <FileGlyph name={a.name} />
            <span className="att-name truncate">{a.name}</span>
            <span className="att-size tnum">{fmtSize(a.size || 0)}</span>
            <button type="button" className="att-x" aria-label={`移除附件 ${a.name}`} onClick={() => props.onRemove(i)}>
              <IconClose width={10} height={10} />
            </button>
          </span>
        ))}
      </div>
      <div className="att-total" data-over={over ? '' : undefined}>
        {props.items.length} 个附件 · 共 <span className="tnum">{fmtSize(total)}</span>
        {over && (
          <span>
            ，超过 20 MB：多数邮箱单封上限 25 MB，附件编码后体积还会增大约三分之一，可能被退信。建议改用网盘链接或分几封发送。
          </span>
        )}
      </div>
    </div>
  )
}

/* ---------- AI：菜单 / 要点输入 / 结果预览 ---------- */

export function AiMenu(props: {
  ready: boolean
  reason?: string
  bodyEmpty: boolean
  selectionChars: number
  canSubject: boolean
  onRewrite(style: ComposeRewriteStyle): void
  onPoints(): void
  onSubject(): void
  onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // 点 AI 按钮本身由按钮切换，不在这里关
      const t = e.target as HTMLElement
      if (!ref.current?.contains(t) && !t.closest?.('[data-ai-trigger]')) closeRef.current()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  if (!props.ready) {
    return (
      <div ref={ref} className="cmp-pop ai-menu pop-in" role="dialog" aria-label="AI 写作">
        <AiUnavailable reason={props.reason} />
      </div>
    )
  }
  return (
    <div ref={ref} className="cmp-pop ai-menu pop-in" role="menu" aria-label="AI 写作" onMouseDown={e => e.preventDefault()}>
      <div className="ai-menu-head">
        {props.bodyEmpty ? '正文还是空的' : props.selectionChars > 0 ? `作用于：选中的 ${props.selectionChars} 个字` : '作用于：全文'}
      </div>
      {props.bodyEmpty ? (
        <button type="button" role="menuitem" className="ai-menu-item" onClick={props.onPoints}>
          <span className="flex-1">用要点写…</span>
          <span className="ai-menu-hint">几句要点 → 完整邮件</span>
        </button>
      ) : (
        REWRITE_STYLES.map(s => (
          <button key={s.id} type="button" role="menuitem" className="ai-menu-item" onClick={() => props.onRewrite(s.id)}>
            <span className="flex-1">{s.label}</span>
            <span className="ai-menu-hint">{s.hint}</span>
          </button>
        ))
      )}
      {(!props.bodyEmpty || props.canSubject) && <div className="ai-menu-sep" />}
      {!props.bodyEmpty && (
        <button type="button" role="menuitem" className="ai-menu-item" onClick={props.onPoints}>
          <span className="flex-1">用要点写…</span>
          <span className="ai-menu-hint">结果可插到下方</span>
        </button>
      )}
      {props.canSubject && (
        <button type="button" role="menuitem" className="ai-menu-item" onClick={props.onSubject}>
          <span className="flex-1">AI 起主题</span>
          <span className="ai-menu-hint">根据正文</span>
        </button>
      )}
    </div>
  )
}

export function AiUnavailable({ reason, compact }: { reason?: string; compact?: boolean }) {
  return (
    <div className={compact ? 'ai-off ai-off-compact' : 'ai-off'}>
      <div className="ai-off-title">AI 还没准备好{reason ? `：${reason}` : ''}</div>
      {!compact && <p className="ai-off-text">在设置里接入云端 API 或本地模型后，就能在撰写窗里用要点写信、润色、翻译和起主题。</p>}
      <button type="button" className={compact ? 'cmp-btn cmp-btn-sm' : 'cmp-btn cmp-btn-primary'} onClick={() => void api.openSettings('ai')}>
        去设置 AI
      </button>
    </div>
  )
}

export function PointsPanel(props: {
  value: string
  onChange(v: string): void
  onSubmit(): void
  onCancel(): void
  context: string[]
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <div className="ai-card" data-state="input">
      <div className="ai-card-head">
        <IconSparkles width={13} height={13} />
        <span>用要点写</span>
        <span className="ai-card-sub">写几句要点，AI 写成完整邮件</span>
      </div>
      <textarea
        ref={ref}
        value={props.value}
        onChange={e => props.onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            e.stopPropagation()
            if (props.value.trim()) props.onSubmit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            props.onCancel()
          }
        }}
        rows={4}
        className="ai-points selectable"
        placeholder={'例如：\n周四评审会改到 15:00\n请带上 Q4 推广数据\n会后我来发纪要'}
      />
      <div className="ai-card-foot">
        <span className="ai-card-ctx truncate">{props.context.length ? `会参考：${props.context.join(' · ')}` : ''}</span>
        <button type="button" className="cmp-btn" onClick={props.onCancel}>取消</button>
        <button type="button" className="cmp-btn cmp-btn-primary" disabled={!props.value.trim()} onClick={props.onSubmit}>
          生成 <kbd className="cmp-kbd-inline">⌘↩</kbd>
        </button>
      </div>
    </div>
  )
}

export function AiResult(props: {
  job: AiJob
  output: string
  bodyEmpty: boolean
  onReplace(): void
  onBelow(): void
  onDiscard(): void
  onStop(): void
  onRetry(): void
}) {
  const { job } = props
  const done = !job.streaming
  const failed = done && !!job.error && !props.output
  const scope = job.kind === 'points' ? '' : job.range ? '（选中文字）' : '（全文）'
  return (
    <div className="ai-card" data-state={failed ? 'error' : done ? 'done' : 'streaming'} aria-live="polite">
      <div className="ai-card-head">
        <IconSparkles width={13} height={13} />
        <span>
          {job.label}
          {scope}
        </span>
        <span className="ai-card-sub">{job.streaming ? '生成中…' : failed ? '没能完成' : 'AI 生成 · 请核对后使用'}</span>
      </div>
      {job.kind === 'rewrite' && job.source && !failed && (
        <div className="ai-diff">
          <div className="ai-diff-label">原文</div>
          <div className="ai-diff-src selectable">{job.source}</div>
          <div className="ai-diff-label">改写</div>
        </div>
      )}
      {failed ? (
        <div className="ai-error">{job.error}</div>
      ) : (
        <div className="ai-out selectable">
          {props.output}
          {job.streaming && <span className="ai-caret" aria-hidden />}
        </div>
      )}
      <div className="ai-card-foot">
        {failed && /设置|接入|API Key|模型/.test(job.error ?? '') && (
          <button type="button" className="cmp-btn" onClick={() => void api.openSettings('ai')}>去设置 AI</button>
        )}
        <span className="flex-1" />
        {job.streaming ? (
          <button type="button" className="cmp-btn" onClick={props.onStop}>停止</button>
        ) : failed ? (
          <>
            <button type="button" className="cmp-btn" onClick={props.onDiscard}>关闭</button>
            <button type="button" className="cmp-btn cmp-btn-primary" onClick={props.onRetry}>重试</button>
          </>
        ) : (
          <>
            <button type="button" className="cmp-btn" onClick={props.onDiscard}>放弃</button>
            {job.kind === 'points' && <button type="button" className="cmp-btn" onClick={props.onRetry}>重新生成</button>}
            {!(job.kind === 'points' && props.bodyEmpty) && (
              <button type="button" className="cmp-btn" disabled={!props.output} onClick={props.onBelow}>插入下方</button>
            )}
            <button type="button" className="cmp-btn cmp-btn-primary" disabled={!props.output} onClick={props.onReplace}>
              {job.kind === 'points' ? (props.bodyEmpty ? '放入正文' : '替换全文') : '替换'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/* ---------- 浮层：发送前检查 / 关闭提示 / 快捷键 ---------- */

export function Modal(props: { children: React.ReactNode; onClose(): void; onSubmit?(): void; label: string; width?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const cb = useRef(props)
  cb.current = props
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    // 窗口级捕获：不论焦点在哪，Esc 关闭、⌘↩ 提交；浮层打开时其余快捷键不再生效
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cb.current.onClose()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        e.stopPropagation()
        cb.current.onSubmit?.()
      } else if ((e.metaKey || e.ctrlKey) && !['c', 'v', 'x', 'a', 'z'].includes(e.key.toLowerCase())) {
        e.stopPropagation()
      }
      // 焦点在浮层外时拉回浮层，键盘输入不落到背后的字段
      if (ref.current && !ref.current.contains(document.activeElement)) {
        ref.current.querySelector<HTMLElement>('[data-autofocus]')?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      prev?.focus?.()
    }
  }, [])
  return (
    <div className="cmp-modal-wrap" role="presentation" onMouseDown={e => e.target === e.currentTarget && props.onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={props.label} className="cmp-modal pop-in" style={{ width: props.width ?? 380 }}>
        {props.children}
      </div>
    </div>
  )
}

export function SendCheckDialog(props: {
  issues: SendIssue[]
  onBack(): void
  onSendAnyway(): void
  fixes: Partial<Record<SendIssue['key'], { label: string; run(): void }>>
  scheduleLabel?: string
}) {
  const blocking = props.issues.some(i => i.tone === 'block')
  return (
    <Modal label="发送前检查" onClose={props.onBack} onSubmit={blocking ? undefined : props.onSendAnyway}>
      <div>
        <div className="cmp-modal-title">{blocking ? '还发不出去' : props.issues.length ? '发送前确认一下' : '都处理好了'}</div>
        <ul className="chk-list">
          {props.issues.map(i => {
            const fix = props.fixes[i.key]
            return (
              <li key={i.key} className="chk-item" data-tone={i.tone}>
                <span className="chk-dot" aria-hidden />
                <span className="flex-1 min-w-0">
                  <span className="chk-title">{i.title}</span>
                  {i.detail && <span className="chk-detail">{i.detail}</span>}
                </span>
                {fix && (
                  <button type="button" className="cmp-btn cmp-btn-sm" onClick={fix.run}>
                    {fix.label}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
        <div className="cmp-modal-foot">
          <button type="button" className="cmp-btn" data-autofocus onClick={props.onBack}>
            返回修改
          </button>
          {!blocking && (
            <button type="button" className="cmp-btn cmp-btn-primary" onClick={props.onSendAnyway}>
              {props.issues.length ? (props.scheduleLabel ? `仍要${props.scheduleLabel}` : '仍要发送') : (props.scheduleLabel ?? '发送')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}

export function ClosePrompt(props: { onSave(): void; onDiscard(): void; onCancel(): void }) {
  return (
    <Modal label="关闭撰写窗" onClose={props.onCancel} onSubmit={props.onSave} width={360}>
      <div className="cmp-modal-title">还有修改没保存</div>
      <p className="cmp-modal-text">保存为草稿后关闭，还是直接关闭？</p>
      <div className="cmp-modal-foot">
        <button type="button" className="cmp-btn" onClick={props.onDiscard}>不保存</button>
        <span className="flex-1" />
        <button type="button" className="cmp-btn" onClick={props.onCancel}>继续编辑</button>
        <button type="button" className="cmp-btn cmp-btn-primary" data-autofocus onClick={props.onSave}>存草稿并关闭</button>
      </div>
    </Modal>
  )
}

export const SHORTCUTS: [string, string][] = [
  ['⌘ ↩', '发送（先做发送前检查）'],
  ['⌘ S', '保存草稿'],
  ['⌘ ⇧ A', '添加附件'],
  ['⌘ ⇧ C', '显示 / 隐藏抄送'],
  ['⌘ ⇧ B', '显示 / 隐藏密送'],
  ['⌘ J', 'AI 写作'],
  ['↩ / , / ;', '把输入的地址变成胶囊'],
  ['⌫', '删除最后一个收件人'],
  ['Esc', '关闭联想 / 浮层'],
  ['⌘ /', '显示本帮助']
]

export function ShortcutHelp(props: { onClose(): void }) {
  return (
    <Modal label="快捷键" onClose={props.onClose} width={340}>
      <div className="cmp-modal-title">快捷键</div>
      <dl className="kbd-list">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="kbd-row">
            <dt>
              <kbd className="cmp-kbd">{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="cmp-modal-foot">
        <button type="button" className="cmp-btn" data-autofocus onClick={props.onClose}>知道了</button>
      </div>
    </Modal>
  )
}

export function Toast(props: { text: string; action?: { label: string; run(): void }; onClose(): void }) {
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose
  useEffect(() => {
    const t = setTimeout(() => closeRef.current(), 6000)
    return () => clearTimeout(t)
  }, [props.text])
  return (
    <div className="cmp-toast sonar-rise" role="status">
      <span>{props.text}</span>
      {props.action && (
        <button
          type="button"
          className="cmp-toast-action"
          onClick={() => {
            props.action!.run()
            props.onClose()
          }}
        >
          {props.action.label}
        </button>
      )}
    </div>
  )
}
