/**
 * 跨设备引用映射（纯函数）：各设备的账户 id、邮件 id 都是本机生成的，不能直接带到另一台设备。
 *   - 账户：用「账户键」provider|email（小写）作为跨设备键
 *   - 邮件：用 Message-ID 头作为跨设备键（本机邮件 id = accountId::folder::uid，每台设备不同）
 * 推送时扫描记录里出现的本机 id（字符串值与对象键）生成 refs；拉取时按 refs 翻译回本机 id，
 * 翻译不到的保留原值（不挂接），并把 Message-ID 记在 data._xref 里，之后再推送时仍能带上。
 */
import type { VaultRefs } from './protocol'

export function accountKeyOf(a: { provider: string; email: string }): string {
  return `${String(a.provider).toLowerCase()}|${String(a.email).trim().toLowerCase()}`
}

/** 设备相关的账户：Proton Bridge / 本机回环地址 / 本机代理——凭据每台设备不同，不能直接拿来用 */
export function isDeviceBoundAccount(a: { provider: string; imap?: { host?: string } | null; smtp?: { host?: string } | null }): boolean {
  if (a.provider === 'proton') return true
  const local = (h?: string) => {
    const host = String(h ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      host === '0.0.0.0' ||
      /^127\.\d+\.\d+\.\d+$/.test(host) ||
      host === 'host.docker.internal'
    )
  }
  return local(a.imap?.host) || local(a.smtp?.host)
}

const looksLikeMessageId = (s: string) => s.includes('::') && s.length < 600

/** 遍历 data 里所有字符串值与对象键 */
function walk(v: unknown, visit: (s: string) => void, depth = 0) {
  if (depth > 40 || v == null) return
  if (typeof v === 'string') return visit(v)
  if (Array.isArray(v)) {
    for (const x of v) walk(x, visit, depth + 1)
    return
  }
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      visit(k)
      walk(x, visit, depth + 1)
    }
  }
}

export function collectRefs(
  data: unknown,
  lookup: { accountKey(id: string): string | null; messageHeader(id: string): string | null }
): VaultRefs | undefined {
  const a: Record<string, string> = {}
  const m: Record<string, string> = {}
  walk(data, s => {
    if (a[s] || m[s]) return
    const k = lookup.accountKey(s)
    if (k) {
      a[s] = k
      return
    }
    if (looksLikeMessageId(s)) {
      const h = lookup.messageHeader(s)
      if (h) m[s] = h
    }
  })
  // 之前没挂上的引用（_xref）继续带着
  const xref = (data as { _xref?: Record<string, string> } | null)?._xref
  if (xref && typeof xref === 'object') for (const [k, h] of Object.entries(xref)) if (typeof h === 'string' && !m[k]) m[k] = h
  const out: VaultRefs = {}
  if (Object.keys(a).length) out.a = a
  if (Object.keys(m).length) out.m = m
  return out.a || out.m ? out : undefined
}

/** 深度替换字符串值与对象键 */
export function replaceDeep<T>(v: T, map: Map<string, string>, depth = 0): T {
  if (!map.size || depth > 40 || v == null) return v
  if (typeof v === 'string') return (map.get(v) ?? v) as unknown as T
  if (Array.isArray(v)) return v.map(x => replaceDeep(x, map, depth + 1)) as unknown as T
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[map.get(k) ?? k] = replaceDeep(x, map, depth + 1)
    return out as T
  }
  return v
}

/** 按 refs 把远端 id 翻译成本机 id；返回翻译后的数据与没挂上的邮件引用 */
export function remapRefs<T>(
  data: T,
  refs: VaultRefs | undefined,
  resolve: { account(key: string): string | null; message(header: string): string | null }
): { data: T; unresolved: Record<string, string> } {
  const map = new Map<string, string>()
  const unresolved: Record<string, string> = {}
  for (const [remoteId, key] of Object.entries(refs?.a ?? {})) {
    const local = resolve.account(key)
    if (local && local !== remoteId) map.set(remoteId, local)
  }
  for (const [remoteId, header] of Object.entries(refs?.m ?? {})) {
    const local = resolve.message(header)
    if (local) {
      if (local !== remoteId) map.set(remoteId, local)
    } else unresolved[remoteId] = header
  }
  let out = replaceDeep(data, map)
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    const o = { ...(out as Record<string, unknown>) }
    // 之前没挂上、这次挂上了的从 _xref 里去掉
    const prev = (o._xref && typeof o._xref === 'object' ? (o._xref as Record<string, string>) : {}) as Record<string, string>
    const next: Record<string, string> = {}
    for (const [k, h] of Object.entries({ ...prev, ...unresolved })) if (!map.has(k) && !resolve.message(h)) next[k] = h
    if (Object.keys(next).length) o._xref = next
    else delete o._xref
    out = o as T
  }
  return { data: out, unresolved }
}
