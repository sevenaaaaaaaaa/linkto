import { sha256Hex } from '../src/security/sha256'

describe('sha256（守卫验证器基础，向量取自 node:crypto）', () => {
  it('空串', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
  it('abc', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('1000 个 a（多块）', () => {
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3')
  })
  it('多字节中文', () => {
    expect(sha256Hex('林可兔幽灵信守卫')).toBe('24c7f0b9cf0ed1d60222dc84ca7ed16fc5d8ccea161ef6bc6231df008d6ed235')
  })
})