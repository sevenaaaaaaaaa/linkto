import type { MailStore } from '../db'
import type { AppStore } from '../store'
import { DEFAULT_GENERAL } from '../store'

/**
 * 定期整理：每小时把「已读、未加旗标、未置顶」且超过设定天数的订阅 / 通知邮件归档。
 * 只动收件箱，归档走与手动归档相同的通路（服务器同步移动）；天数为 0 时不运行。
 */
export function startCleanup(deps: {
  appStore: AppStore
  store: MailStore
  archive(messageId: string): Promise<void>
  onChanged(): void
}) {
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      const g = deps.appStore.get('general', DEFAULT_GENERAL)
      let moved = 0
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
  }
  setTimeout(() => void run(), 90_000)
  return setInterval(() => void run(), 3600_000)
}
