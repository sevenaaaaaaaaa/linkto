/**
 * 发布校验清单解析（纯函数，便于在 Node 里单测）
 *
 * SHA256SUMS.txt 由 scripts/lib/release-hashes.sh 生成，格式：
 *   <64 hex>  <GitHub 上的资产名>
 * GitHub 会把资产名里的空格转成点，所以这里同时接受原名与点名。
 */

export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s{1,2}(.+?)\s*$/.exec(raw.trim())
    if (!m) continue
    out.set(m[2], m[1].toLowerCase())
  }
  return out
}

export function checksumFor(text: string, assetName: string): string | null {
  const map = parseChecksums(text)
  const direct = map.get(assetName)
  if (direct) return direct
  // 兼容：本地文件用空格、GitHub 资产用点
  const dotted = assetName.replaceAll(' ', '.')
  const spaced = assetName.replaceAll('.', ' ')
  return map.get(dotted) ?? map.get(spaced) ?? null
}
