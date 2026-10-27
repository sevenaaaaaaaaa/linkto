import { open, seal, parseFlyLink, flyLink, normalizeCode, looksLikeCode, mboxForCode, generateCode } from '../src/fly/crypto'

const NOW = 1761600000000
const LINK = {
  envelope: '{"app":"linkto-fly","v":2,"m":"link","mb":"5b097e1dbf74fa1b701b9beeea23a8ee","i":"DsPs0_CkhGipW7zx","c":"weEPOaGGWDBCyhalDNmp1c34wno9C+EP4PG1RjLM1ha8G/b4z9oxts9C1QMmiHuZmjS9M791DIl2I5S/em2dP1yGQHuIr+oRiXpItwFcVgcON3ghPN+W7WagcUo4lruxOH2Yc1avTVIJVYGf7OGcf3lpObzfbZpOIjuFUOreTdWSYGOGq/LC16uKzwRV58JTXaJ8xPENO1NBYCbcZsMA88VbTmiI08dCz2oaA3GiwTUVcrnucKWfKQikmjnetCi34j4o0dk/Yfwow8D2fQCMXQp89UoUAvJBntTX95mR57oQ5Kbfb+OrJPj5KDed2hSHZiIzMboOYAVLNwgNCNXytA==","t":"/8WbR4bnC+yeIq3FDztzig==","iat":1761600000000,"ttl":3600}',
  keyB64: 'camtQZCSdHSyPMicqnHcXzClQ339pRkkxAyzuA75Wpk'
}
const LINK_CODE = {
  envelope: '{"app":"linkto-fly","v":2,"m":"link-code","mb":"b3a313e095006abb0bc699ee20e4e17a","s":"QeYjCXuYrYdGt3kG5SlHPQ","i":"28d18gr0NN1LL-jg","c":"uV6mI6+FcnClpplgcGqWQU61MsPrXkGoVLYRMMoLctf6pTDCnGqP4JqJTvqlzUNdeoWf8e8SsxV3pHQiwyLocDTMf7mqvxdmiejMB5oYnp7GRz74VTXBAMxLshjzCvu247Ts9s2jCYWP8bIXFO9OIDtJoKMQA2VTmm4J38vSGxT8yeAj/8dEH/qPGiUygLQR8EYAZFyh9208AX2p4LlA8ohenh6ywL0fGU7l/l2tzveCPZVX3IOqdTI2x8jtgnDBQmOX9CvxsteS0kg4iNSBBcZgBhq4Gr/5jMPFvZGTu7a0K6nekHCiUndPIZhcM7dgnCS3Lr44nq1JvHNM54fVAg==","t":"EV1uMh1bhPXyTjVb20Bcmg==","iat":1761600000000,"ttl":86400}',
  code: 'pupil review miss seven police either'
}
const CODE = {
  envelope: '{"app":"linkto-fly","v":2,"m":"code","mb":"2d9b25b0117dac059ce7b73effa99cdb","i":"-DaMCw2zbbxlGFjL","c":"8K4MjwQnh8D7WeUV/jnfkD0Z29+iNZhBAkrqrsoKCTWeZfuoYS36MG1uOpxzojr9vGsznzuq1MlgrgcDeiYzY/mDdF0Kxv6WW4o2vk9WniICmPwsH8nA/K7hIhv7t7uQ7J6OXxFsKKtJhVijevMT7lNL3tNlVYmzBqm4JTuNMMMj+FY/bpAtEfT699+MRQRubkOenZL/3ELm3M/xRm8pDcO7rnCyxr5VyZ7j824jF3UN3+aneBO9km7BZeqk0+2hzHdZd0sPI+869OBMxbndaM/u6xq2mbZp5N/RlOqiVPp5geii4APEVF4cCgZlNMMSimgMCm89ge9a/8HFGDX22w==","t":"eedVmx8ik7ESnrJhkFJo9Q==","iat":1761600000000,"ttl":3600}',
  code: 'prison inform shop chalk load walk'
}

jest.setTimeout(60000)

describe('萤火密信 v2 兼容性', () => {
  it('打开桌面端 link 信封', async () => {
    const r = await open(LINK.envelope, { keyB64: LINK.keyB64, now: NOW + 1000 })
    expect(r.text).toBe('link hello 你好')
    expect(r.mode).toBe('link')
  })

  it('打开桌面端 link-code 信封', async () => {
    const r = await open(LINK_CODE.envelope, { code: LINK_CODE.code, now: NOW + 1000 })
    expect(r.text).toBe('link-code hello 你好')
  })

  it('打开桌面端 code 信封，错误口令与过期都被拒', async () => {
    const r = await open(CODE.envelope, { code: CODE.code, now: NOW + 1000 })
    expect(r.text).toBe('code hello 你好')
    expect((await mboxForCode(CODE.code)).toUpperCase()).toBe('2D9B25B0117DAC059CE7B73EFFA99CDB')
    await expect(open(CODE.envelope, { code: 'abandon ability able about above absent', now: NOW + 1000 })).rejects.toThrow()
    await expect(open(CODE.envelope, { code: CODE.code, now: NOW + 7200_000 })).rejects.toThrow(/过期/)
  })

  it('link 模式封装/打开 roundtrip', async () => {
    const s = await seal('roundtrip 你好', { mode: 'link', ttlSeconds: 3600 })
    const r = await open(s.envelope, { keyB64: s.keyB64 })
    expect(r.text).toBe('roundtrip 你好')
    const link = flyLink('https://relay.example', s)
    const p = parseFlyLink(link)
    expect(p?.keyB64).toBe(s.keyB64)
    expect(p?.needsCode).toBe(false)
  })

  it('口令规范化 / 词数 / 链接解析', async () => {
    expect(normalizeCode('  Apple - River，Stone ')).toBe('apple river stone')
    expect(looksLikeCode('pupil review miss seven police either')).toBe(true)
    expect(looksLikeCode('only four words are here')).toBe(false)
    expect(parseFlyLink('2d9b25b0117dac059ce7b73effa99cdb')?.needsCode).toBe(true)
    expect(parseFlyLink('https://relay.example/r/2d9b25b0117dac059ce7b73effa99cdb#c')?.needsCode).toBe(true)
    expect(parseFlyLink('not a link')).toBeNull()
    const code = await generateCode()
    expect(code.split(' ')).toHaveLength(6)
  })
})
