import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { isLocalHostname, isPrivateAddress } from '@shared/net-ip'

export { isLocalHostname, isPrivateAddress, isPrivateV4, isPrivateV6, looksPrivateHost } from '@shared/net-ip'

/**
 * 订阅抓取的内网地址防护（SSRF）：订阅地址 / 全文链接 / 重定向目标都来自外部内容，
 * 不能让它们打到本机或局域网服务（路由器后台、本地开发服务、云厂商元数据 169.254.169.254 …）。
 *  - 主机名是 localhost / *.localhost → 拒绝
 *  - 主机名是 IP 字面量 → 直接判定；是域名 → 解析出全部地址，任何一个落在内网 / 保留网段都拒绝
 *  - 真正建连时还会在 socket 的 lookup 里再判一次（见 fetch.ts 的 guardedFetch），防 DNS 重绑定
 * 开发 / 测试开关：环境变量 LINKTO_FEEDS_ALLOW_PRIVATE=1 时放行（本地 mock 订阅用），默认关闭。
 * 分享中心的 Webhook（用户自己填的地址）不走这里。
 */

export function allowPrivateFeeds(): boolean {
  return process.env.LINKTO_FEEDS_ALLOW_PRIVATE === '1'
}

export class BlockedAddressError extends Error {
  constructor(public readonly host: string, public readonly address?: string) {
    super(address && address !== host ? `不能访问内网或本机地址（${host} → ${address}）` : `不能访问内网或本机地址（${host}）`)
    this.name = 'BlockedAddressError'
  }
}

export type Resolver = (host: string) => Promise<string[]>

export const systemResolver: Resolver = host =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, list: LookupAddress[]) => (err ? reject(err) : resolve(list.map(a => a.address))))
  })

/**
 * 判定一个 http(s) 地址能否抓取：返回 null = 放行，否则返回拒绝原因。
 * 解析失败交给后面的真正请求去报「找不到这个网站」，这里不拦。
 */
export async function checkPublicUrl(raw: string, resolver: Resolver = systemResolver, allowPrivate = allowPrivateFeeds()): Promise<BlockedAddressError | null> {
  if (allowPrivate) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (isLocalHostname(host)) return new BlockedAddressError(host)
  if (isIP(host)) return isPrivateAddress(host) ? new BlockedAddressError(host) : null
  let addrs: string[]
  try {
    addrs = await resolver(host)
  } catch {
    return null
  }
  const bad = addrs.find(isPrivateAddress)
  return bad ? new BlockedAddressError(host, bad) : null
}

/**
 * 给 http.request 用的 lookup：建连时解析出的地址再判一次（防 DNS 重绑定：预检时是公网、连接时变成内网）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function guardedLookup(hostname: string, options: any, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  const opts = typeof options === 'object' && options ? options : {}
  dnsLookup(hostname, { ...opts, all: true, verbatim: true }, (err, list: LookupAddress[]) => {
    if (err) return callback(err, '', 0)
    if (!allowPrivateFeeds()) {
      const bad = list.find(a => isPrivateAddress(a.address))
      if (bad) return callback(Object.assign(new BlockedAddressError(hostname, bad.address), { code: 'EBLOCKED' }), '', 0)
    }
    if (opts.all) return callback(null, list)
    const first = list[0]
    if (!first) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '', 0)
    callback(null, first.address, first.family)
  })
}
