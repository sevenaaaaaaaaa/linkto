/**
 * KDF 版本化测试：伪原生模块注入
 *
 * v2 = PBKDF2-HMAC-SHA256（原生）；v1 = 单轮 SHA-256（旧版降级）。
 * 覆盖：v2 设置/解锁、v1 → v2 无感升级迁移、v2 守卫在无原生环境不可解锁（防降级绕过）。
 */

jest.mock('../src/native/LinkToCore', () => {
  const shaMod = jest.requireActual('../src/security/sha256')
  const mockFakePbkdf2 = (pw: string, salt: string, iters: number) => `pbkdf2v2(${pw}|${salt}|${iters})`
  let mockNative = true
  return {
    linkToCore: {
      sha256Hex: (msg: string) => Promise.resolve(shaMod.sha256Hex(msg)),
      randomB64: (len: number) => Promise.resolve('x'.repeat(len)),
      pbkdf2Hex: (pw: string, salt: string, iters: number) =>
        Promise.resolve(mockNative ? mockFakePbkdf2(pw, salt, iters) : null),
      haptic: () => Promise.resolve(true),
      hasNative: () => mockNative,
      __setNative: (v: boolean) => {
        mockNative = v
      },
      __fakePbkdf2: mockFakePbkdf2
    }
  }
})

// ---- 与 guard.test.ts 相同的内存 Keychain / AsyncStorage 模拟 ----
jest.mock('react-native-keychain', () => {
  const getStore = (): Map<string, string> => {
    const g = globalThis as unknown as { __kdfKv?: Map<string, string> }
    if (!g.__kdfKv) g.__kdfKv = new Map()
    return g.__kdfKv
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
import { setupMaster, unlock } from '../src/security/guard'
import { linkToCore } from '../src/native/LinkToCore'

const core = linkToCore as unknown as {
  __setNative: (v: boolean) => void
  __fakePbkdf2: (pw: string, salt: string, iters: number) => string
}

const GUARD_SERVICE = 'linkto.master.guard'

async function readGuard(): Promise<Record<string, unknown>> {
  const r = (await Keychain.getGenericPassword({ service: GUARD_SERVICE })) as { password: string }
  return JSON.parse(r.password)
}

async function writeGuard(g: Record<string, unknown>): Promise<void> {
  await Keychain.setGenericPassword('u', JSON.stringify(g), { service: GUARD_SERVICE })
}

beforeEach(async () => {
  const g = globalThis as unknown as { __kdfKv?: Map<string, string> }
  if (g.__kdfKv) g.__kdfKv.clear()
  jest.clearAllMocks()
  core.__setNative(true)
})

describe('守卫 KDF 版本化（原生 PBKDF2）', () => {
  it('有原生能力时设置 → v2 验证器，正确密码解锁', async () => {
    expect(await setupMaster('hunter2')).toBeNull()
    const g = await readGuard()
    expect(g.v).toBe(2)
    expect(g.verifier).toBe(core.__fakePbkdf2('hunter2', g.salt as string, 60000))
    const r = await unlock('hunter2')
    expect(r.result).toBe('ok')
  })

  it('v1 旧版守卫：正确密码解锁后无感升级到 v2', async () => {
    const { sha256Hex } = jest.requireActual('../src/security/sha256') as { sha256Hex(msg: string): string }
    const salt = 'oldsalt'
    const g1 = { v: 1, salt, verifier: sha256Hex(`${salt}||linkto-guard-v1||hunter2`), fails: 0, lockUntil: 0, lockRound: 0 }
    await writeGuard(g1)
    const r = await unlock('hunter2')
    expect(r.result).toBe('ok')
    const g = await readGuard()
    expect(g.v).toBe(2)
    expect(g.verifier).toBe(core.__fakePbkdf2('hunter2', salt, 60000))
  })

  it('v2 守卫在原生能力消失时不降级放行（拒绝而非误解锁）', async () => {
    expect(await setupMaster('hunter2')).toBeNull()
    core.__setNative(false) // 模拟极端降级（原生模块丢失）
    const r = await unlock('hunter2')
    expect(r.result).toBe('wrong') // 走 v1 推导 ≠ v2 验证器 → 不放行
    const g = await readGuard()
    expect(g.v).toBe(2)
    expect(g.verifier).toBe(core.__fakePbkdf2('hunter2', g.salt as string, 60000)) // 验证器未被改写
  })
})