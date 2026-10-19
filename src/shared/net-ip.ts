/**
 * IP 段判定（纯函数，主进程 / 渲染端共用、可单测）：内网 / 本机 / 保留网段。
 * 订阅抓取的 SSRF 防护（main/feeds/net-guard.ts）与分享设置里 Webhook 的内网地址提示都用它。
 */

/** IPv4 → 32 位整数；不是合法点分十进制返回 null */
export function v4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n >>> 0
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], // 「本网络」
  ['10.0.0.0', 8], // 私有
  ['100.64.0.0', 10], // 运营商级 NAT
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地（含云元数据 169.254.169.254）
  ['172.16.0.0', 12], // 私有
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // 文档用 TEST-NET-1
  ['192.88.99.0', 24], // 6to4 中继（已废弃）
  ['192.168.0.0', 16], // 私有
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4] // 保留 + 广播 255.255.255.255
]

function inV4Block(n: number, base: string, bits: number): boolean {
  const b = v4ToInt(base)!
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((n & mask) >>> 0) === ((b & mask) >>> 0)
}

export function isPrivateV4(ip: string): boolean {
  const n = v4ToInt(ip)
  if (n == null) return true // 解析不了的按不安全处理
  return V4_BLOCKS.some(([b, bits]) => inV4Block(n, b, bits))
}

/** IPv6 → 8 个 16 位分组（支持 :: 压缩与末尾内嵌 IPv4）；非法返回 null */
export function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '')
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  // 末尾内嵌 IPv4（::ffff:127.0.0.1）→ 换成两个十六进制分组
  const lastColon = s.lastIndexOf(':')
  const maybeV4 = s.slice(lastColon + 1)
  if (maybeV4.includes('.')) {
    const n = v4ToInt(maybeV4)
    if (n == null) return null
    s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (h: string) => (h ? h.split(':').map(x => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)) : [])
  const head = parse(halves[0])
  const rest = halves.length === 2 ? parse(halves[1]) : []
  if ([...head, ...rest].some(x => Number.isNaN(x))) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const fill = 8 - head.length - rest.length
  if (fill < 1) return null
  return [...head, ...new Array(fill).fill(0), ...rest]
}

export function isPrivateV6(ip: string): boolean {
  const g = v6Groups(ip)
  if (!g) return true
  const embeddedV4 = (hi: number, lo: number) => `${hi >>> 8}.${hi & 255}.${lo >>> 8}.${lo & 255}`
  // :: 未指定 / ::1 回环
  if (g.slice(0, 7).every(x => x === 0) && (g[7] === 0 || g[7] === 1)) return true
  // ::ffff:a.b.c.d（IPv4 映射）/ ::a.b.c.d（旧式兼容）→ 按内嵌 IPv4 判
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateV4(embeddedV4(g[6], g[7]))
  // 64:ff9b::/96 NAT64 → 内嵌 IPv4
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isPrivateV4(embeddedV4(g[6], g[7]))
  // 2002::/16 6to4 → 第 2、3 组是 IPv4
  if (g[0] === 0x2002) return isPrivateV4(embeddedV4(g[1], g[2]))
  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 唯一本地
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 链路本地
  if ((g[0] & 0xffc0) === 0xfec0) return true // fec0::/10 站点本地（已废弃）
  if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8 组播
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // 2001:db8::/32 文档用
  if (g[0] === 0x0100 && g.slice(1, 4).every(x => x === 0)) return true // 100::/64 丢弃
  return false
}

/** 地址是否属于内网 / 本机 / 保留网段 */
export function isPrivateAddress(ip: string): boolean {
  const v = ipVersion(ip)
  if (v === 4) return isPrivateV4(ip)
  if (v === 6) return isPrivateV6(ip)
  return true
}

/** 4 / 6 = 合法 IP 字面量；0 = 不是（是域名或非法） */
export function ipVersion(raw: string): 0 | 4 | 6 {
  const ip = String(raw ?? '').replace(/^\[|\]$/g, '')
  if (v4ToInt(ip) != null) return 4
  if (ip.includes(':') && v6Groups(ip) != null) return 6
  return 0
}

/**
 * 不解析 DNS 的快速判定（渲染端提示用）：主机名是 localhost 或内网 IP 字面量，
 * 或是常见的局域网后缀（.local / .lan / .internal / .home.arpa）
 */
export function looksPrivateHost(host: string): boolean {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!h) return false
  if (isLocalHostname(h)) return true
  if (ipVersion(h)) return isPrivateAddress(h)
  return /\.(local|lan|internal|intranet|corp|home\.arpa)$/.test(h) || !h.includes('.')
}

/** 主机名本身就是本机：localhost / *.localhost / localhost.localdomain */
export function isLocalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === 'localhost.localdomain' || h === 'ip6-localhost' || h === 'ip6-loopback'
}
