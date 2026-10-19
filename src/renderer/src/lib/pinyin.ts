import { useEffect, useState } from 'react'
import { matchText, type PinyinHit, type PinyinKey } from '@shared/pinyin-match'
import { api } from './api'

/**
 * 渲染进程的拼音匹配：拼音数据由主进程（pinyin-pro）生成，经 IPC pinyinKeys 批量取回并缓存；
 * 匹配规则见 shared/pinyin-match（全拼 / 首字母 / 混合，多音字多候选）。
 */

const HAN = /\p{Script=Han}/u
const cache = new Map<string, PinyinKey | null>()
const inflight = new Set<string>()

/** 预取一批文本的拼音键（只取含汉字、尚未缓存的） */
export async function ensurePinyin(texts: string[], asNames = false): Promise<boolean> {
  const missing = [...new Set(texts.filter(t => t && HAN.test(t) && !cache.has(cacheKey(t, asNames)) && !inflight.has(cacheKey(t, asNames))))]
  if (!missing.length) return false
  for (const t of missing) inflight.add(cacheKey(t, asNames))
  try {
    const keys = await api.pinyinKeys(missing, asNames)
    missing.forEach((t, i) => cache.set(cacheKey(t, asNames), keys?.[i] ?? null))
    return true
  } catch {
    return false
  } finally {
    for (const t of missing) inflight.delete(cacheKey(t, asNames))
  }
}

const cacheKey = (t: string, asNames: boolean) => (asNames ? 'n:' : 't:') + t

/** 文本是否匹配查询：子串优先，纯字母查询再试拼音（拼音键未取回时只做子串匹配） */
export function pinyinMatch(query: string, text: string, asNames = false): PinyinHit | null {
  return matchText(query, text, HAN.test(text) ? cache.get(cacheKey(text, asNames)) ?? null : null)
}

/** 组件里用：texts 变化时预取拼音键，取回后返回值 +1 触发重算 */
export function usePinyin(texts: string[], asNames = false): number {
  const [ver, setVer] = useState(0)
  const sig = texts.join('\u0001')
  useEffect(() => {
    let alive = true
    void ensurePinyin(texts, asNames).then(changed => {
      if (alive && changed) setVer(v => v + 1)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, asNames])
  return ver
}
