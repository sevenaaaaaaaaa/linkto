/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipcMain } from 'electron'
import type { Rule } from '@shared/types'
import type { JobDef } from '../jobs/scheduler'
import { RuleSuggestService, type RuleSuggestDeps } from './service'

export { RuleSuggestService } from './service'

let service: RuleSuggestService | null = null

/** 规则建议服务（未初始化时为 null）：IPC / 自动任务 / Agent 工具共用 */
export function ruleSuggestService(): RuleSuggestService | null {
  return service
}

/** 初始化：服务 + IPC（ruleSuggestions / ruleSuggestionAccept / ruleSuggestionDismiss / ruleSuggestReadSignal）。操作记录钩子在 ipc.ts，不依赖这里 */
export function initRuleSuggest(deps: RuleSuggestDeps): RuleSuggestService {
  const svc = new RuleSuggestService(deps)
  service = svc
  const handlers: Record<string, (...args: any[]) => unknown> = {
    ruleSuggestions: () => svc.list(),
    ruleSuggestionAccept: (id: string, opts?: { rule?: Omit<Rule, 'id' | 'order' | 'enabled'>; applyExisting?: boolean }) => svc.accept(String(id), opts ?? {}),
    ruleSuggestionDismiss: (id: string, forever?: boolean) => svc.dismiss(String(id), !!forever),
    // 阅读停留信号（打开后马上关掉、没读）：渲染端判定后上报，只记元数据
    ruleSuggestReadSignal: (sig: { messageId: string; verdict: 'noRead' | 'read'; dwellMs?: number }) => svc.readSignal(sig ?? ({} as never))
  }
  for (const [method, handler] of Object.entries(handlers)) {
    ipcMain.handle(`api:${method}`, async (_e, ...args) => {
      try {
        return await handler(...args)
      } catch (err) {
        console.error(`[ipc:${method}]`, err)
        throw err
      }
    })
  }
  return svc
}

/** 自动任务「规则建议」：每天一次，纯规则（不用 AI），从你反复的手动操作里找可以自动化的习惯 */
export function ruleSuggestJob(): JobDef {
  return {
    id: 'rule-suggest',
    name: '规则建议',
    description: '每天看一眼你最近 30 天反复做的手动操作（总把某类邮件归档 / 移到某个文件夹 / 加旗标…），整理成可以一键创建的规则建议；你接受前不会建规则、不会动邮件',
    category: 'learn',
    ai: 'none',
    cadence: { kind: 'daily', at: '09:30' },
    defaultEnabled: true,
    preferIdle: { minIdleSec: 60, maxDelayMs: 3 * 3_600_000 },
    run: async ctx => {
      const svc = ruleSuggestService()
      if (!svc) return { summary: '规则建议模块尚未就绪' }
      const r = svc.run(ctx.now)
      const n = r.created.length
      return {
        summary: n ? `发现 ${n} 条可以自动化的习惯` : r.open ? `${r.open} 条建议等你处理，没有新的` : '没有发现足够稳定的习惯',
        activity: n
          ? {
              source: 'job',
              title: `发现 ${n} 条可以自动化的习惯`,
              detail: `${r.created.map(s => `· ${s.title}`).join('\n')}\n在收件箱顶部或「设置 → 自动化 → 建议的规则」里一键创建。`,
              refs: [],
              stats: { ruleSuggestions: n }
            }
          : null
      }
    }
  }
}
