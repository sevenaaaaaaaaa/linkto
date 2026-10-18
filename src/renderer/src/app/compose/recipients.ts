import type { Address } from '@shared/types'

/** 地址格式校验（宽松：本地部分 @ 域名.后缀） */
const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:".]{2,}$/

export function isValidEmail(address: string): boolean {
  return EMAIL_RE.test(address.trim())
}

/**
 * 把一段文本解析成地址列表：支持 `名字 <a@b.com>`、`"Li, Wei" <a@b.com>`、裸地址，
 * 以逗号 / 分号（含全角）/ 空白 / 换行分隔。
 */
export function parseRecipients(text: string): Address[] {
  const out: Address[] = []
  const re = /(?:"([^"]*)"|([^,;，；<>"\n]*?))\s*<([^<>\s]+)>|([^\s,;，；<>"]+)/g
  for (const m of text.matchAll(re)) {
    if (m[3]) {
      const name = (m[1] ?? m[2] ?? '').trim()
      out.push(name ? { name, address: m[3].trim() } : { address: m[3].trim() })
    } else if (m[4]) {
      out.push({ address: m[4].replace(/^mailto:/i, '').trim() })
    }
  }
  return out.filter(a => a.address)
}

/** 胶囊编辑时还原成可编辑文本 */
export function recipientText(a: Address): string {
  return a.name ? `${a.name} <${a.address}>` : a.address
}

/** 合并去重（按地址，大小写不敏感） */
export function mergeRecipients(list: Address[], add: Address[]): Address[] {
  const seen = new Set(list.map(a => a.address.toLowerCase()))
  const next = [...list]
  for (const a of add) {
    const k = a.address.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    next.push(a)
  }
  return next
}
