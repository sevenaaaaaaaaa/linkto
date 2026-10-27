jest.mock('@react-native-async-storage/async-storage', () => {
  const mem = new Map<string, string>()
  return {
    __esModule: true,
    __mem: mem,
    default: {
      getItem: async (k: string) => mem.get(k) ?? null,
      setItem: async (k: string, v: string) => { mem.set(k, v) },
      removeItem: async (k: string) => { mem.delete(k) }
    }
  }
})

jest.mock('react-native-keychain', () => {
  let cred: { username: string; password: string; service?: string } | false = false
  return {
    getGenericPassword: async () => cred,
    setGenericPassword: async (username: string, password: string, opts?: { service?: string }) => {
      cred = { username, password, ...(opts?.service ? { service: opts.service } : {}) }
      return true
    },
    resetGenericPassword: async () => { cred = false; return true }
  }
})

jest.mock('../src/native/LinkToCore', () => ({
  linkToCore: {
    randomB64: async (n: number) => require('crypto').randomBytes(Math.max(n, 16)).toString('base64')
  }
}))

import { addVaultItem, listVault, removeVaultItem, revealVaultItem } from '../src/vault/store'

const mem = (jest.requireMock('@react-native-async-storage/async-storage') as { __mem: Map<string, string> }).__mem

describe('本机保险箱', () => {
  it('新增 / 列表不泄露 secret 正文 / 解密 / 删除', async () => {
    const note = await addVaultItem({ kind: 'note', title: '一段邮件', body: '正文备注' })
    const secret = await addVaultItem({ kind: 'secret', title: '恢复码', body: 'super-secret-code' })
    const list = await listVault()
    expect(list).toHaveLength(2)
    expect(list.find(i => i.id === secret.id)?.preview).toBe('')
    expect(list.find(i => i.id === note.id)?.preview).toContain('正文备注')
    const revealed = await revealVaultItem(secret.id)
    expect(revealed?.body).toBe('super-secret-code')
    const raw = mem.get('linkto.vault.v1') ?? ''
    expect(raw).not.toContain('super-secret-code')
    expect(raw).not.toContain('正文备注')
    expect(await removeVaultItem(secret.id)).toBe(true)
    expect(await listVault()).toHaveLength(1)
  })
})
