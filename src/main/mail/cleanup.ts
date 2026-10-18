import type { MailStore } from '../db'
import type { AppStore } from '../store'
import { DEFAULT_GENERAL } from '../store'

interface CleanupDeps {
  appStore: AppStore
  store: MailStore
  archive(messageId: string): Promise<void>
  onChanged(): void
}

/** 跑一轮定期整理，返回归档封数（由自动任务调度器每小时调用；天数都为 0 时什么也不做） */
export function createCleanupRunner(deps: CleanupDeps): () => Promise<{ moved: number; enabled: boolean }> {
  let running = false
  return async () => {
    const g = deps.appStore.get('general', DEFAULT_GENERAL)
    const enabled = !!((g.cleanupNewsletterDays ?? 0) > 0 || (g.cleanupNotificationDays ?? 0) > 0)
    if (running) return { moved: 0, enabled }
    running = true
    let moved = 0
    try {
      const plans: ['newsletter' | 'notification', number | undefined][] = [
        ['newsletter', g.cleanupNewsletterDays],
        ['notification', g.cleanupNotificationDays]
      ]
      for (const [kind, days] of plans) {
        if (!days || days <= 0) continue
        for (const id of deps.store.listCleanupCandidates(kind, Date.now() - days * 864e5, 200)) {
          try {
            await deps.archive(id)
            moved++
          } catch {
            /* 单封失败（离线等）留到下一轮 */
          }
        }
      }
      if (moved) deps.onChanged()
    } finally {
      running = false
    }
    return { moved, enabled }
  }
}

/**
 * 定期整理：每小时把「已读、未加旗标、未置顶」且超过设定天数的订阅 / 通知邮件归档。
 * 只动收件箱，归档走与手动归档相同的通路（服务器同步移动）；天数为 0 时不运行。
 * （主进程已改由自动任务调度器调用 createCleanupRunner；保留此入口兼容旧调用方）
 */
export function startCleanup(deps: CleanupDeps) {
  const run = createCleanupRunner(deps)
  setTimeout(() => void run(), 90_000)
  return setInterval(() => void run(), 3600_000)
}
