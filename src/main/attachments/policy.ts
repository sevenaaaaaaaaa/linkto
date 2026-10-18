import type { AttachmentCategory, AttachmentSettings, ReleasePlan, ReleasePlanItem, ReleaseReason } from '@shared/attachments'

/**
 * 本地缓存释放：策略（该不该释放）与安全判定（能不能释放）分开，都是纯函数。
 *
 * 安全红线——只有同时满足以下全部条件的文件才允许删除：
 *  1. 文件位于 LinkTo 自己的附件缓存目录内（路径规范化后前缀匹配，拒绝 .. / 软链逃逸由调用方 realpath 后传入）
 *  2. 不是内联图片、不是幽灵信信封（.lkghost 由幽灵信模块按路径读取）
 *  3. 至少有一条可恢复来源：
 *     - eml：本地 eml 原文镜像存在（离线即可重新解析出附件）
 *     - imap：原邮件仍在本地库、账户存在且启用、所在文件夹不是废纸篓 / 垃圾邮件（这两处服务器可能自动清空）
 *     - cloud：网盘上有已确认的副本（本地同步目录 = 文件存在且哈希一致；远端网盘 = 执行前再探测一次）
 */

export interface SafetyInput {
  /** 规范化后的缓存文件绝对路径 */
  path: string
  /** 规范化后的附件缓存目录绝对路径 */
  cacheDir: string
  fileExists: boolean
  filename: string
  inline: boolean
  messageExists: boolean
  accountEnabled: boolean
  folderSpecial: string | null
  emlMirror: boolean
  cloudVerified: boolean
}

export interface SafetyResult {
  safe: boolean
  via: ('eml' | 'imap' | 'cloud')[]
  reason: string
}

function isInside(path: string, dir: string): boolean {
  if (!path || !dir) return false
  const d = dir.replace(/[/\\]+$/, '')
  if (path === d) return false
  if (!path.startsWith(d)) return false
  const next = path.charAt(d.length)
  if (next !== '/' && next !== '\\') return false
  // 不允许任何 .. 段（调用方应传规范化路径，这里再兜一层）
  return !/(^|[/\\])\.\.([/\\]|$)/.test(path.slice(d.length))
}

export function releaseSafety(i: SafetyInput): SafetyResult {
  if (!isInside(i.path, i.cacheDir)) return { safe: false, via: [], reason: '文件不在 LinkTo 附件缓存目录内' }
  if (!i.fileExists) return { safe: false, via: [], reason: '本地没有缓存文件' }
  if (i.inline) return { safe: false, via: [], reason: '内联图片（正文渲染需要）' }
  if (i.filename.toLowerCase().endsWith('.lkghost')) return { safe: false, via: [], reason: '幽灵信信封' }
  const via: SafetyResult['via'] = []
  if (i.emlMirror) via.push('eml')
  if (i.messageExists && i.accountEnabled && i.folderSpecial !== 'trash' && i.folderSpecial !== 'junk') via.push('imap')
  if (i.cloudVerified) via.push('cloud')
  if (!via.length) {
    if (!i.messageExists) return { safe: false, via, reason: '原邮件已不在本地库，且网盘没有副本' }
    if (!i.accountEnabled) return { safe: false, via, reason: '账户已停用，且没有本地原文镜像或网盘副本' }
    return { safe: false, via, reason: '原邮件在废纸篓 / 垃圾邮件，服务器可能清空，且没有网盘副本' }
  }
  return { safe: true, via, reason: '' }
}

export interface PolicyItem {
  id: string
  filename: string
  size: number
  date: number
  category: AttachmentCategory
  cached: boolean
  pinned: boolean
  /** 网盘上有已确认副本 */
  archived: boolean
}

/**
 * 按策略挑出「建议释放」的候选（未做安全判定）：
 * - 钉住的、永久保留分类的、本地没缓存的一律不进候选
 * - 早于 keepDays 天 → old；已归档且开启 releaseArchived → archived
 * - 总量超过 maxCacheGB → 从最旧的开始补足到上限以下（quota）
 * manualIds 非空时：只考虑这些（用户手动选择的释放），钉住 / 保留分类仍然排除
 */
export function planReleaseCandidates(
  items: PolicyItem[],
  s: Pick<AttachmentSettings, 'keepDays' | 'maxCacheGB' | 'releaseArchived' | 'keepCategories'>,
  now: number,
  manualIds?: string[] | null
): { candidates: { item: PolicyItem; reason: ReleaseReason }[]; kept: { item: PolicyItem; reason: string }[] } {
  const kept: { item: PolicyItem; reason: string }[] = []
  const candidates: { item: PolicyItem; reason: ReleaseReason }[] = []
  const keep = new Set(s.keepCategories ?? [])
  const manual = manualIds && manualIds.length ? new Set(manualIds) : null
  const pool = items.filter(i => i.cached && (!manual || manual.has(i.id)))
  const eligible: PolicyItem[] = []
  for (const it of pool) {
    if (it.pinned) kept.push({ item: it, reason: '已钉住' })
    else if (keep.has(it.category)) kept.push({ item: it, reason: '永久保留的分类' })
    else eligible.push(it)
  }
  if (manual) {
    for (const it of eligible) candidates.push({ item: it, reason: 'manual' })
    return { candidates, kept }
  }
  const chosen = new Set<string>()
  const cutoff = s.keepDays > 0 ? now - s.keepDays * 864e5 : null
  for (const it of eligible) {
    if (cutoff !== null && it.date && it.date < cutoff) {
      candidates.push({ item: it, reason: 'old' })
      chosen.add(it.id)
    } else if (s.releaseArchived && it.archived) {
      candidates.push({ item: it, reason: 'archived' })
      chosen.add(it.id)
    }
  }
  if (s.maxCacheGB > 0) {
    const limit = s.maxCacheGB * 1024 ** 3
    // 所有本地缓存（含保留的）都计入占用；只能从可释放的里面腾
    let used = pool.reduce((sum, i) => sum + i.size, 0) - candidates.reduce((sum, c) => sum + c.item.size, 0)
    const rest = eligible.filter(i => !chosen.has(i.id)).sort((a, b) => a.date - b.date)
    for (const it of rest) {
      if (used <= limit) break
      candidates.push({ item: it, reason: 'quota' })
      used -= it.size
    }
  }
  return { candidates, kept }
}

/** 把候选 + 安全判定合成最终清单 */
export function assembleReleasePlan(
  candidates: { item: PolicyItem; reason: ReleaseReason }[],
  kept: { item: PolicyItem; reason: string }[],
  safety: (id: string) => SafetyResult,
  includeKept = false
): ReleasePlan {
  const items: ReleasePlanItem[] = []
  const skipped: ReleasePlan['skipped'] = []
  for (const c of candidates) {
    const s = safety(c.item.id)
    if (s.safe) items.push({ id: c.item.id, filename: c.item.filename, size: c.item.size, date: c.item.date, category: c.item.category, reason: c.reason, via: s.via })
    else skipped.push({ id: c.item.id, filename: c.item.filename, size: c.item.size, reason: s.reason })
  }
  if (includeKept) for (const k of kept) skipped.push({ id: k.item.id, filename: k.item.filename, size: k.item.size, reason: k.reason })
  items.sort((a, b) => b.size - a.size)
  return { items, bytes: items.reduce((s, i) => s + i.size, 0), skipped }
}
