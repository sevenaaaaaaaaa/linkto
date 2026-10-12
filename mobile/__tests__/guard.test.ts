/**
 * 守卫阶梯逻辑单测（内存 Keychain 模拟）
 *
 * 策略：错 1-4 次立即失败；错 5 次锁定 15 分钟（每 5 次翻倍）；累计 15 次焚毁。
 */

// ---- react-native-keychain 内存模拟（惰性共享 Map，规避 jest.mock 提升） ----
jest.mock('react-native-keychain', () => {
  const getStore = (): Map<string, string> => {
    const g = globalThis as unknown as { __guardKv?: Map<string, string> }
    if (!g.__guardKv) g.__guardKv = new Map()
    return g.__guardKv
  }
  return {
    setGenericPassword: jest.fn(async (_u: string, v: string, opts: { service: string }) => {
      getStore().set(opts.service, v)
      return true
    }),
    getGenericPassword: jest.fn(async (opts: { service: string }) => {
      const v = getStore().get(opts.service)
      return v ? { username: 'guard', password: v, service: opts.service } : false
    }),
    resetGenericPassword: jest.fn(async (opts: { service: string }) => {
      getStore().delete(opts.service)
      return true
    })
  }
})

jest.mock('@react-native-async-storage/async-storage', () => {
  const m = new Map<string, string>()
  return {
    getItem: jest.fn(async (k: string) => m.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      m.set(k, v)
    }),
    removeItem: jest.fn(async (k: string) => {
      m.delete(k)
    })
  }
})

import * as Keychain from 'react-native-keychain'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { setupMaster, unlock, burnAll, guardState, isMitmError, BURN_AT_FAILS } from '../src/security/guard'

const asJest = AsyncStorage as unknown as { getItem: (k: string) => Promise<string | null>; setItem: (k: string, v: string) => Promise<void> }

beforeEach(async () => {
  const g = globalThis as unknown as { __guardKv?: Map<string, string> }
  if (g.__guardKv) g.__guardKv.clear()
  jest.clearAllMocks()
  await asJest.setItem('linkto.accounts.v1', JSON.stringify([{ id: 'acc-1', email: 'a@b.c', host: 'h', port: 993, secure: true }]))
  await Keychain.setGenericPassword('u', 'p', { service: 'linkto.imap.acc-1' })
})

describe('守卫阶梯焚毁', () => {
  it('设置后正确密码解锁成功', async () => {
    expect(await setupMaster('hunter2')).toBeNull()
    const r = await unlock('hunter2')
    expect(r.result).toBe('ok')
  })

  it('错 1-4 次只报错不锁定', async () => {
    await setupMaster('hunter2')
    for (let i = 0; i < 4; i++) {
      const r = await unlock('wrong')
      expect(r.result).toBe('wrong')
    }
    const gs = await guardState()
    expect(gs.fails).toBe(4)
    expect(gs.lockedUntil).toBe(0)
  })

  it('错 5 次触发 15 分钟锁定', async () => {
    await setupMaster('hunter2')
    const before = Date.now()
    for (let i = 0; i < 5; i++) await unlock('wrong')
    const gs = await guardState()
    expect(gs.lockedUntil).toBeGreaterThanOrEqual(before + 15 * 60 * 1000)
    // 锁定期内即使密码正确也拒绝
    const r = await unlock('hunter2')
    expect(r.result).toBe('locked')
  })

  it('第二轮锁定翻倍至 30 分钟（第 10 次）', async () => {
    await setupMaster('hunter2')
    for (let i = 0; i < 5; i++) await unlock('wrong') // 第 5 次 → 锁 15 分钟
    // 快进锁定结束
    const g = JSON.parse(((await Keychain.getGenericPassword({ service: 'linkto.master.guard' })) as { password: string }).password)
    g.lockUntil = Date.now() - 1
    await Keychain.setGenericPassword('u', JSON.stringify(g), { service: 'linkto.master.guard' })
    for (let i = 0; i < 4; i++) await unlock('wrong') // 第 6-9 次
    await unlock('wrong') // 第 10 次 → 第二档 30 分钟
    const gs = await guardState()
    expect(gs.lockedUntil).toBeGreaterThan(Date.now() + 29 * 60 * 1000)
  })

  it(`累计 ${BURN_AT_FAILS} 次焚毁：凭据/主密钥/守卫全部消失`, async () => {
    await setupMaster('hunter2')
    let last
    for (let i = 0; i < BURN_AT_FAILS; i++) {
      const g = await guardState()
      if (g.lockedUntil > Date.now()) {
        // 手动解锁快进（模拟等待锁定结束）
        const gr = JSON.parse(((await Keychain.getGenericPassword({ service: 'linkto.master.guard' })) as { password: string }).password)
        gr.lockUntil = 0
        await Keychain.setGenericPassword('u', JSON.stringify(gr), { service: 'linkto.master.guard' })
      }
      last = await unlock('wrong')
    }
    expect(last!.result).toBe('burned')
    expect(await Keychain.getGenericPassword({ service: 'linkto.master.key' })).toBe(false)
    expect(await Keychain.getGenericPassword({ service: 'linkto.master.guard' })).toBe(false)
    expect(await Keychain.getGenericPassword({ service: 'linkto.imap.acc-1' })).toBe(false)
    expect(await asJest.getItem('linkto.accounts.v1')).toBeNull()
  })

  it('burnAll 可独立执行（中间人触发路径）', async () => {
    await setupMaster('hunter2')
    await burnAll('mitm')
    expect(await Keychain.getGenericPassword({ service: 'linkto.master.guard' })).toBe(false)
    expect(await asJest.getItem('linkto.accounts.v1')).toBeNull()
  })
})

describe('中间人判定', () => {
  it('证书类错误命中', () => {
    expect(isMitmError('连接失败：certificate verify failed')).toBe(true)
    expect(isMitmError('连接失败：SSL handshake failed')).toBe(true)
    expect(isMitmError('连接失败：self signed certificate')).toBe(true)
  })
  it('网络/超时类错误不误判', () => {
    expect(isMitmError('连接超时')).toBe(false)
    expect(isMitmError('连接失败：ECONNREFUSED')).toBe(false)
    expect(isMitmError('登录失败：AUTHENTICATIONFAILED')).toBe(false)
    expect(isMitmError('响应超时')).toBe(false)
  })
})