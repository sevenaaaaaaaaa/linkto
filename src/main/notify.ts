import { Notification } from 'electron'
import { execFile } from 'child_process'
import type { MailBundle, MailSection, NotificationSettings } from '@shared/types'
import { decideNotify, planBurst, BURST_WINDOW_MS } from './notify-policy'

export interface NewMailInfo {
  accountId: string
  messageId: string
  subject: string
  from: string
  category: string
}

/** 一次通知投递的结果（测试通知回传给设置页） */
export interface NotifyResult {
  ok: boolean
  /** native = 系统通知（UNUserNotificationCenter）；applescript = 兜底（宿主显示为「脚本编辑器」） */
  via: 'native' | 'applescript' | 'none'
  error?: string
}

/** 攒批窗口：同一轮同步里到达的邮件几毫秒内连续入队，稍等片刻再统一决定单条 / 汇总 */
const FLUSH_DELAY_MS = 1200
/** 等待系统回报 'show' 的上限；超时视为已投递（不再盲目弹 AppleScript 造成重复） */
const SHOW_TIMEOUT_MS = 4000

/** 新邮件系统通知（含 Canary 式快捷操作按钮） */
export class Notifier {
  private pending: NewMailInfo[] = []
  private flushTimer: NodeJS.Timeout | null = null
  /** 近期弹出时间戳（突发合并用） */
  private recent: number[] = []
  /** 已通知过的邮件，避免「新邮件」与规则「通知我」重复弹出 */
  private notified = new Set<string>()
  /** macOS 上 Notification 对象被 GC 后 click/action 回调会丢失：保留引用直到关闭 */
  private live = new Set<Notification>()
  /** 最近一次系统通知失败原因（如 macOS 未授权） */
  lastError: string | null = null

  constructor(
    private getSettings: () => NotificationSettings,
    private handlers: {
      markRead(messageId: string): Promise<void>
      trash(messageId: string): Promise<void>
      flag(messageId: string): Promise<void>
      archive(messageId: string): Promise<void>
      /** 聚焦主窗口；带 messageId 时打开该邮件 */
      focus(messageId?: string): void
      reply(accountId: string, messageId: string): void
      /** 通知时刻的邮件理解与 snooze 状态（智能通知 / 稍后处理判断用） */
      describe?(messageId: string): {
        insight: { section: MailSection; bundle: MailBundle | null } | null
        snoozedUntil: number | null
        seen: boolean
      } | null
    }
  ) {}

  /**
   * 新邮件进入通知队列。force（规则「通知我」）立即弹出并跳过过滤。
   * 第二个参数保留兼容旧调用，未使用。
   */
  notify(info: NewMailInfo, _unreadTotal = 0, force = false) {
    if (force) {
      if (info.messageId && this.notified.has(info.messageId)) return
      const d = decideNotify(this.getSettings(), { accountId: info.accountId, category: info.category }, new Date(), true)
      this.remember(info.messageId)
      void this.showMail(info, d.notify ? d.silent : false)
      return
    }
    this.pending.push(info)
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY_MS)
  }

  /** 设置页「发送测试通知」：跳过所有过滤，回传真实投递结果 */
  async test(): Promise<NotifyResult> {
    const s = this.getSettings()
    return this.post({
      title: '测试通知',
      body: '这是一条来自林可兔的通知测试',
      silent: !s.sound,
      actions: [],
      onClick: () => this.handlers.focus()
    })
  }

  private flush() {
    this.flushTimer = null
    const s = this.getSettings()
    const now = new Date()
    const batch = this.pending.splice(0)
    const accepted: { info: NewMailInfo; silent: boolean }[] = []
    for (const info of batch) {
      if (this.notified.has(info.messageId)) continue
      const meta = this.handlers.describe?.(info.messageId) ?? null
      // 攒批期间已在别处读过（如用户正开着窗口），不再打扰
      if (meta?.seen) continue
      const d = decideNotify(
        s,
        { accountId: info.accountId, category: info.category, insight: meta?.insight ?? null, snoozedUntil: meta?.snoozedUntil ?? null },
        now
      )
      if (d.notify) accepted.push({ info, silent: d.silent })
    }
    if (!accepted.length) return
    const t = now.getTime()
    this.recent = this.recent.filter(x => t - x < BURST_WINDOW_MS)
    const plan = planBurst(accepted.length, this.recent, t)
    for (const a of accepted) this.remember(a.info.messageId)
    if (plan === 'summary') {
      this.recent.push(t)
      const senders = [...new Set(accepted.map(a => a.info.from).filter(Boolean))]
      const body = senders.slice(0, 3).join('、') + (senders.length > 3 ? ` 等 ${senders.length} 位发件人` : '')
      void this.post({
        title: `收到 ${accepted.length} 封新邮件`,
        body: body || '点击查看收件箱',
        silent: accepted.every(a => a.silent),
        actions: [],
        onClick: () => this.handlers.focus()
      })
      return
    }
    for (const a of accepted) {
      this.recent.push(t)
      void this.showMail(a.info, a.silent)
    }
  }

  private remember(messageId: string) {
    if (!messageId) return
    this.notified.add(messageId)
    // 只需防近期重复：超过上限丢弃最早的
    if (this.notified.size > 500) {
      const first = this.notified.values().next().value
      if (first !== undefined) this.notified.delete(first)
    }
  }

  private showMail(info: NewMailInfo, silent: boolean): Promise<NotifyResult> {
    const s = this.getSettings()
    const active = s.actions.filter(a => a !== 'none' && ACTION_LABEL[a])
    return this.post({
      title: info.from || '新邮件',
      subtitle: info.subject || '（无主题）',
      body: '',
      silent,
      actions: active.map(a => ACTION_LABEL[a]),
      onClick: () => this.handlers.focus(info.messageId),
      onAction: index => {
        const action = active[index]
        if (action) void this.runAction(action, info).catch(err => console.error('[notify] action failed:', err))
        else this.handlers.focus(info.messageId)
      }
    })
  }

  /**
   * 投递一条通知：优先系统通知；'failed'（未授权 / 应用签名无效等）时降级为 AppleScript 通知
   * （经通知中心，宿主显示为「脚本编辑器」，无操作按钮、点击不能定位邮件）。
   */
  private post(o: {
    title: string
    subtitle?: string
    body: string
    silent: boolean
    actions: string[]
    onClick: () => void
    onAction?: (index: number) => void
  }): Promise<NotifyResult> {
    if (!Notification.isSupported()) {
      return this.appleScriptNotify(o.title, o.subtitle, o.body, 'Notification.isSupported() = false')
    }
    const n = new Notification({
      title: o.title,
      subtitle: o.subtitle,
      body: o.body,
      silent: o.silent,
      actions: o.actions.map(text => ({ type: 'button' as const, text }))
    })
    this.live.add(n)
    if (this.live.size > 50) {
      const oldest = this.live.values().next().value
      if (oldest) this.live.delete(oldest)
    }
    n.on('click', () => {
      this.live.delete(n)
      o.onClick()
    })
    n.on('action', (details, legacyIndex) => {
      this.live.delete(n)
      const index = typeof details?.actionIndex === 'number' ? details.actionIndex : legacyIndex
      o.onAction?.(index)
    })
    n.on('close', () => this.live.delete(n))
    return new Promise<NotifyResult>(resolve => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ ok: true, via: 'native' })
      }, SHOW_TIMEOUT_MS)
      n.on('show', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.lastError = null
        resolve({ ok: true, via: 'native' })
      })
      n.on('failed', (_e, error) => {
        this.live.delete(n)
        console.error('[notify] system notification failed:', error)
        this.lastError = String(error || '系统通知失败')
        if (settled) return
        settled = true
        clearTimeout(timer)
        void this.appleScriptNotify(o.title, o.subtitle, o.body, this.lastError).then(resolve)
      })
      n.show()
    })
  }

  /** AppleScript 兜底：display notification 走系统通知中心（宿主为 Script Editor） */
  private appleScriptNotify(title: string, subtitle: string | undefined, body: string, reason: string): Promise<NotifyResult> {
    if (process.platform !== 'darwin') return Promise.resolve({ ok: false, via: 'none', error: reason })
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const text = body || subtitle || ''
    const sub = body ? (subtitle ?? '') : ''
    const script = `display notification "${esc(text)}" with title "${esc(title)}" subtitle "${esc(sub)}"`
    return new Promise(resolve => {
      execFile('osascript', ['-e', script], err => {
        if (err) resolve({ ok: false, via: 'none', error: `${reason}；AppleScript 兜底也失败：${err.message}` })
        else resolve({ ok: false, via: 'applescript', error: reason })
      })
    })
  }

  private async runAction(action: string, info: NewMailInfo) {
    switch (action) {
      case 'markRead':
        await this.handlers.markRead(info.messageId)
        break
      case 'delete':
        await this.handlers.trash(info.messageId)
        break
      case 'archive':
        await this.handlers.archive(info.messageId)
        break
      case 'flag':
        await this.handlers.flag(info.messageId)
        break
      case 'reply':
        this.handlers.reply(info.accountId, info.messageId)
        break
    }
  }
}

const ACTION_LABEL: Record<string, string> = {
  markRead: '标为已读',
  reply: '回复',
  delete: '删除',
  archive: '归档',
  flag: '标记'
}
