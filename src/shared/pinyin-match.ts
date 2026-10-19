/**
 * 拼音匹配（纯函数，主进程 / 渲染进程共用；拼音数据由主进程生成后经 IPC 传来）：
 *  - 全拼：wang / wangxiaoming / xiaoming
 *  - 首字母：wxm / xm
 *  - 混合 / 部分音节：wangxm / wxming / zhxm（每个字可以用其读音的任意前缀，从任意字开始连续匹配）
 * 多音字：每个字带若干候选读音（首个为按上下文 / 姓氏规则判断的常用读音），任一候选命中即可。
 */

/** 文本的拼音键：tokens[i] 是第 i 个「音节」的候选读音（小写），spans[i] 是它在原文里的字符区间 [start, end) */
export interface PinyinKey {
  tokens: string[][]
  spans: [number, number][]
}

export interface PinyinHit {
  /** 命中区间（原文字符下标，[start, end)），用于高亮 */
  start: number
  end: number
  /** 匹配质量：0 = 从第一个字起的全拼前缀，1 = 从第一个字起（含首字母 / 部分音节），2 = 从中间的字起 */
  rank: number
}

/** 查询是否适合做拼音匹配：只含字母（允许空格 / ' 分隔，会被忽略） */
export function isPinyinQuery(q: string): boolean {
  const s = q.trim()
  return s.length > 0 && /^[a-zA-Z' ]+$/.test(s) && /[a-zA-Z]/.test(s)
}

/**
 * q 能否从某个音节起，被「连续若干音节各自读音的非空前缀」依次拼出。
 * 返回最好的一处命中；不命中返回 null。
 */
export function matchPinyin(query: string, key: PinyinKey | null | undefined): PinyinHit | null {
  if (!key || !key.tokens.length) return null
  const q = query.toLowerCase().replace(/[' ]/g, '')
  if (!q || !/^[a-z]+$/.test(q)) return null
  const n = key.tokens.length
  let best: PinyinHit | null = null
  for (let start = 0; start < n; start++) {
    // 记忆化 DFS：从音节 i、查询位置 j 出发能否消费完查询；返回结束音节下标（不含），-1 = 不行
    const memo = new Map<number, number>()
    const dfs = (i: number, j: number): number => {
      if (j === q.length) return i
      if (i >= n) return -1
      const k = i * 1000 + j
      const m = memo.get(k)
      if (m !== undefined) return m
      let res = -1
      for (const syl of key.tokens[i]) {
        // 优先尝试更长的前缀（整音节），再到首字母
        for (let len = Math.min(syl.length, q.length - j); len >= 1 && res < 0; len--) {
          if (q.startsWith(syl.slice(0, len), j)) res = dfs(i + 1, j + len)
        }
        if (res >= 0) break
      }
      memo.set(k, res)
      return res
    }
    const end = dfs(start, 0)
    if (end < 0) continue
    // 全拼判断：查询恰好等于这些音节首选读音的拼接前缀
    const fullPrefix = key.tokens
      .slice(start, end)
      .map(t => t[0] ?? '')
      .join('')
    const rank = start === 0 ? (fullPrefix.startsWith(q) ? 0 : 1) : 2
    const hit: PinyinHit = { start: key.spans[start][0], end: key.spans[end - 1][1], rank }
    if (!best || hit.rank < best.rank) best = hit
    if (best.rank === 0) break
  }
  return best
}

/**
 * 通用「文本是否匹配查询」：先子串（不区分大小写），查询是纯字母时再试拼音。
 * 返回命中区间（子串命中 rank = -1，比任何拼音命中都靠前）。
 */
export function matchText(query: string, text: string, key?: PinyinKey | null): PinyinHit | null {
  const q = query.trim()
  if (!q) return { start: 0, end: 0, rank: -1 }
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i >= 0) return { start: i, end: i + q.length, rank: -1 }
  if (key && isPinyinQuery(q)) return matchPinyin(q, key)
  return null
}
