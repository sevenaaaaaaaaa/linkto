#!/usr/bin/env node
/**
 * 通知策略自测：AI 不在线时，启发式把真人邮件判成 notification 也不能静默吞掉。
 * 跑：node --no-warnings --experimental-strip-types scripts/notify-policy-selftest.mts
 */
import { passesSmart, decideNotify, isNotifiableArrival, inQuietHours, planBurst } from '../src/main/notify-policy.ts'

let failed = 0
const check = (name: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failed++
    console.error(`✗ ${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  } else {
    console.log(`✓ ${name}`)
  }
}

const settings = { enabled: true, actions: [], smart: true, sound: true, perAccount: {} } as never

// 1. 智能通知：个人邮件放行
check('personal 放行', passesSmart({ accountId: 'a', category: 'personal' }), true)
// 2. AI 缺席时，启发式误判的真人邮件仍放行（本轮修复的核心）
check('notification + 真人发件人放行', passesSmart({ accountId: 'a', category: 'notification', humanSender: true }), true)
// 3. 机器通知不发
check('notification + 机器发件人不发', passesSmart({ accountId: 'a', category: 'notification' }), false)
check('notification + humanSender=false 不发', passesSmart({ accountId: 'a', category: 'notification', humanSender: false }), false)
// 4. 订阅 / 打包 / 待审仍然不打扰
check('newsletter 不发', passesSmart({ accountId: 'a', category: 'newsletter' }), false)
check('bundle 不发', passesSmart({ accountId: 'a', category: 'personal', insight: { section: 'bundle', bundle: 'newsletter' } }), false)
check('screener bundle 不发', passesSmart({ accountId: 'a', category: 'notification', humanSender: true, insight: { section: 'screener', bundle: 'screener' } }), false)
// 5. 有 AI 且判为「需要你处理」时放行
check('act 放行', passesSmart({ accountId: 'a', category: 'notification', insight: { section: 'act', bundle: null } }), true)

// 6. decideNotify 端到端：真人 notification 真的会弹
const d1 = decideNotify(settings, { accountId: 'a', category: 'notification', humanSender: true }, new Date('2026-11-25T10:00:00'))
check('端到端：真人 notification 弹窗', d1.notify, true)
const d2 = decideNotify(settings, { accountId: 'a', category: 'notification' }, new Date('2026-11-25T10:00:00'))
check('端到端：机器 notification 不弹', d2.notify, false)
const d3 = decideNotify({ enabled: false, actions: [], smart: true, sound: true } as never, { accountId: 'a', category: 'personal' }, new Date())
check('总开关关闭时不弹', d3.notify, false)

// 7. 到达判定：只有增量、未读、24h 内
check('真正到达', isNotifiableArrival({ inserted: true, inbox: true, arrival: true, seen: false, held: false, date: Date.now() - 60_000, now: Date.now() }), true)
check('回填不算到达', isNotifiableArrival({ inserted: true, inbox: true, arrival: false, seen: false, held: false, date: Date.now() - 60_000, now: Date.now() }), false)
check('被 Screener 拦下的不提醒', isNotifiableArrival({ inserted: true, inbox: true, arrival: true, seen: false, held: true, date: Date.now() - 60_000, now: Date.now() }), false)

// 8. 免打扰 / 突发合并
check('免打扰跨午夜', inQuietHours({ enabled: true, start: '22:00', end: '08:00' } as never, new Date('2026-11-25T23:30:00')), true)
check('免打扰之外', inQuietHours({ enabled: true, start: '22:00', end: '08:00' } as never, new Date('2026-11-25T12:00:00')), false)
check('超量合并', planBurst(2, [Date.now() - 1000, Date.now() - 2000], Date.now()), 'summary')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
