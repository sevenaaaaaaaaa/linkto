import { pinyin } from 'pinyin-pro'
import type { PinyinKey } from '@shared/pinyin-match'

/**
 * 拼音键生成（只在主进程用 pinyin-pro；渲染进程经 IPC pinyinKeys 取结果，用 shared/pinyin-match 做匹配）。
 *  - 人名：surname 模式，姓氏多音字按姓氏读（曾 zeng、单 shan、解 xie、区 ou、仇 qiu…）
 *  - 其他文本（项目名、命令名）：按词判断多音字
 * 每个汉字另附全部候选读音，读音判断不准时（如「银行」）用户按另一种读法输入也能命中。
 */

const HAN = /\p{Script=Han}/u
const WORD = /[\p{L}\p{N}]/u

/** 小表兜底：常见姓氏多音字（pinyin-pro 的姓氏模式已处理，这里保证首选读音） */
const SURNAME_FIX: Record<string, string> = { 曾: 'zeng', 单: 'shan', 解: 'xie', 区: 'ou', 仇: 'qiu', 朴: 'piao', 查: 'zha', 盖: 'ge', 尉: 'yu', 乐: 'yue', 缪: 'miao', 覃: 'qin', 翟: 'zhai' }

const cache = new Map<string, PinyinKey>()
const altCache = new Map<string, string[]>()
const CACHE_MAX = 20_000

function alternatives(ch: string): string[] {
  let a = altCache.get(ch)
  if (!a) {
    try {
      a = [...new Set(pinyin(ch, { toneType: 'none', type: 'array', multiple: true }).map(s => s.toLowerCase()).filter(s => /^[a-zü]+$/.test(s)).map(s => s.replace(/ü/g, 'v')))]
    } catch {
      a = []
    }
    altCache.set(ch, a)
  }
  return a
}

/** 文本 → 拼音键（带缓存）。name = 按人名处理（姓氏读音） */
export function pinyinKey(text: string, name = false): PinyinKey {
  const ck = (name ? 'n:' : 't:') + text
  const hit = cache.get(ck)
  if (hit) return hit
  const tokens: string[][] = []
  const spans: [number, number][] = []
  const chars = [...text]
  let primary: string[] = []
  if (chars.some(c => HAN.test(c))) {
    try {
      const all = pinyin(text, { toneType: 'none', type: 'all', surname: name ? 'head' : 'off' })
      primary = all.map(x => (x.isZh ? String(x.pinyin).toLowerCase().replace(/ü/g, 'v') : ''))
    } catch {
      primary = []
    }
  }
  // pinyin-pro 的 type:'all' 逐字返回（与 chars 一一对应）；对不齐时退回逐字读音
  const aligned = primary.length === chars.length
  let offset = 0
  let firstHan = true
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    const start = offset
    offset += c.length
    if (HAN.test(c)) {
      const alts = alternatives(c)
      let main = aligned && primary[i] ? primary[i] : alts[0] ?? ''
      if (name && firstHan && SURNAME_FIX[c]) main = SURNAME_FIX[c]
      firstHan = false
      const cands = [...new Set([main, ...alts].filter(Boolean))]
      if (cands.length) {
        tokens.push(cands)
        spans.push([start, offset])
      }
      continue
    }
    if (WORD.test(c)) {
      // 拉丁字母 / 数字：连续的一段算一个「音节」
      const prev = spans.length ? spans[spans.length - 1] : null
      const prevTok = tokens.length ? tokens[tokens.length - 1] : null
      if (prev && prevTok && prev[1] === start && prevTok.length === 1 && !HAN.test(chars[i - 1] ?? '')) {
        prevTok[0] += c.toLowerCase()
        prev[1] = offset
      } else {
        tokens.push([c.toLowerCase()])
        spans.push([start, offset])
      }
    }
  }
  const key: PinyinKey = { tokens, spans }
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(ck, key)
  return key
}

/** 批量（IPC pinyinKeys 用）：只返回含汉字文本的键，其余为 null（纯拉丁文本直接子串匹配即可） */
export function pinyinKeys(texts: string[], name = false): (PinyinKey | null)[] {
  return texts.map(t => (typeof t === 'string' && HAN.test(t) ? pinyinKey(t.slice(0, 200), name) : null))
}
