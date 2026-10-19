/**
 * 中文友好检索的纯文本层（无 Electron / SQLite 依赖，可单测）：
 *  - 入库：CJK 连续片段切成重叠二元组（bigram），片段末字再补一个单字 token；拉丁词 / 数字原样交给 unicode61 分词
 *    「季度报告」→「季度 度报 报告 告」。每个汉字都是某个 token 的前缀 → 单字查询用前缀匹配即可全覆盖
 *  - 查询：CJK 片段 ≥2 字 → 二元组短语（相邻）匹配；单字 → 前缀匹配；拉丁词 / 数字 → 词前缀匹配
 * 版本号变化（切分规则调整）时索引整体重建。
 */

export const SEARCH_INDEX_VERSION = 1

/** 汉字（含扩展 A / 兼容 / 扩展 B 以后）、日文假名、韩文音节：按「字」切二元组 */
const CJK_CHAR = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯\u{20000}-\u{3134f}]/u
/** 非 CJK 的「词」字符（字母 / 数字，含带音调的拉丁字母） */
const WORD_CHAR = /[\p{L}\p{N}]/u

export function isCjkChar(ch: string): boolean {
  return CJK_CHAR.test(ch)
}

/** CJK 片段 → 二元组 + 末字单字 */
function cjkTokens(run: string[]): string[] {
  if (run.length === 1) return [run[0]]
  const out: string[] = []
  for (let i = 0; i < run.length - 1; i++) out.push(run[i] + run[i + 1])
  out.push(run[run.length - 1])
  return out
}

/**
 * 入库预处理：返回交给 FTS5 unicode61 分词的文本。
 * max > 0 时先截断到 max 个字符（正文只索引开头一段，控制索引体积）。
 */
export function segmentForIndex(text: string | null | undefined, max = 0): string {
  if (!text) return ''
  let src = String(text)
  if (max > 0 && src.length > max) src = src.slice(0, max)
  src = src.normalize('NFKC')
  const out: string[] = []
  let run: string[] = []
  let word = ''
  const flushRun = () => {
    if (run.length) {
      out.push(...cjkTokens(run))
      run = []
    }
  }
  const flushWord = () => {
    if (word) {
      out.push(word)
      word = ''
    }
  }
  for (const ch of src) {
    if (CJK_CHAR.test(ch)) {
      flushWord()
      run.push(ch)
    } else {
      flushRun()
      if (WORD_CHAR.test(ch)) word += ch
      else flushWord()
    }
  }
  flushRun()
  flushWord()
  return out.join(' ')
}

/** 查询词切片：CJK 片段与拉丁词 / 数字分开 */
export function queryPieces(term: string): { cjk: boolean; text: string }[] {
  const src = (term ?? '').normalize('NFKC').toLowerCase()
  const pieces: { cjk: boolean; text: string }[] = []
  let run = ''
  let word = ''
  for (const ch of src) {
    if (CJK_CHAR.test(ch)) {
      if (word) pieces.push({ cjk: false, text: word }), (word = '')
      run += ch
    } else {
      if (run) pieces.push({ cjk: true, text: run }), (run = '')
      if (WORD_CHAR.test(ch)) word += ch
      else if (word) pieces.push({ cjk: false, text: word }), (word = '')
    }
  }
  if (run) pieces.push({ cjk: true, text: run })
  if (word) pieces.push({ cjk: false, text: word })
  return pieces
}

/** FTS5 字符串字面量（片段只含字母数字 / CJK，仍按规范转义双引号以防万一） */
const lit = (s: string) => `"${s.replace(/"/g, '""')}"`

/** 单个查询词 → FTS5 表达式；无可检索内容（纯标点）返回 null */
export function compileTerm(term: string): string | null {
  const parts: string[] = []
  for (const p of queryPieces(term)) {
    if (p.cjk) {
      const chars = [...p.text]
      if (chars.length === 1) parts.push(`${lit(chars[0])}*`)
      else {
        const grams: string[] = []
        for (let i = 0; i < chars.length - 1; i++) grams.push(chars[i] + chars[i + 1])
        parts.push(lit(grams.join(' ')))
      }
    } else {
      parts.push(`${lit(p.text)}*`)
    }
  }
  if (!parts.length) return null
  return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`
}

export interface SearchSpec {
  /** 全字段关键词（AND） */
  terms?: string[]
  /** 发件人（姓名 / 地址） */
  sender?: string | null
  /** 收件人 / 抄送（姓名 / 地址） */
  to?: string | null
  /** 主题 */
  subject?: string | null
}

/**
 * 关键词 + from: / to: / subject: → 一条 FTS5 MATCH 表达式（全部 AND）。
 * 没有任何关键词时返回 null（调用方只按结构化条件过滤）；
 * 有输入但全部是标点等不可检索内容时返回 ''（调用方应返回空结果）。
 */
export function compileSearch(spec: SearchSpec): string | null {
  const clauses: string[] = []
  let wanted = 0
  for (const t of spec.terms ?? []) {
    if (!t || !t.trim()) continue
    wanted++
    const e = compileTerm(t)
    if (e) clauses.push(e)
  }
  const scoped: [string, string | null | undefined][] = [
    ['sender', spec.sender],
    ['recipients', spec.to],
    ['subject', spec.subject]
  ]
  for (const [col, v] of scoped) {
    if (!v || !v.trim()) continue
    wanted++
    const e = compileTerm(v)
    if (e) clauses.push(`${col} : (${e})`)
  }
  if (!wanted) return null
  // 个别纯标点的词（如误输入的「，」）忽略；全部不可检索时返回 '' → 空结果
  if (!clauses.length) return ''
  return clauses.join(' AND ')
}

/** 查询里的拉丁 / 数字片段（≥3 字符）：二元组索引按词前缀匹配，词中间的子串（如订单号尾号）退回 trigram */
export function latinSubstrings(spec: SearchSpec): string[] {
  const out: string[] = []
  for (const t of [...(spec.terms ?? []), spec.sender ?? '', spec.to ?? '', spec.subject ?? '']) {
    for (const p of queryPieces(t)) if (!p.cjk && p.text.length >= 3) out.push(p.text)
  }
  return out
}

/** 收件人 / 抄送 JSON → 「姓名 地址」文本（损坏的 JSON 忽略） */
export function addressText(...jsons: (string | null | undefined)[]): string {
  const out: string[] = []
  for (const s of jsons) {
    if (!s) continue
    try {
      const list = JSON.parse(s) as { name?: string; address?: string }[]
      if (!Array.isArray(list)) continue
      for (const a of list) {
        if (!a) continue
        if (a.name) out.push(String(a.name))
        if (a.address) out.push(String(a.address))
      }
    } catch {
      /* 忽略 */
    }
  }
  return out.join(' ')
}
