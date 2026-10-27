jest.mock('@react-native-async-storage/async-storage', () => {
  const mem = new Map<string, string>()
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => mem.get(k) ?? null,
      setItem: async (k: string, v: string) => { mem.set(k, v) },
      removeItem: async (k: string) => { mem.delete(k) }
    }
  }
})

import { composeFly, openFly } from '../src/fly/relay'

jest.setTimeout(120000)

describe('萤火密信 · 真实中继', () => {
  it('link 模式写 → 读 → 二次读取失败', async () => {
    const text = 'mobile relay test ' + Date.now()
    const c = await composeFly({ text, mode: 'link', ttlSeconds: 120 })
    expect(c.ok).toBe(true)
    expect(c.link).toContain('/r/')
    expect(c.link).toContain('#k=')
    const o = await openFly(c.link!)
    expect(o.ok).toBe(true)
    expect(o.text).toBe(text)
    expect(o.burned).toBe(true)
    const again = await openFly(c.link!)
    expect(again.ok).toBe(false)
  })

  it('link-code 模式：缺口令不焚毁，口令对后焚毁', async () => {
    const text = 'mobile relay code test ' + Date.now()
    const c = await composeFly({ text, mode: 'link-code', ttlSeconds: 120 })
    expect(c.ok).toBe(true)
    expect(c.code?.split(' ')).toHaveLength(6)
    const noCode = await openFly(c.link!)
    expect(noCode.ok).toBe(false)
    expect(noCode.needsCode).toBe(true)
    const o = await openFly(c.link!, c.code)
    expect(o.ok).toBe(true)
    expect(o.text).toBe(text)
  })
})
