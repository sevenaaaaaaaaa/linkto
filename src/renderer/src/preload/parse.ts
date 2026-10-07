import type { ComposeDraft } from '@shared/types'

/** 从撰写窗口 URL hash 解析预填内容（与 preload 同源，独立小函数避免依赖问题） */
export function parseComposePrefill(): Partial<ComposeDraft> | undefined {
  const m = location.hash.match(/#\/compose\?prefill=([^&]+)/)
  if (!m) return undefined
  try {
    return JSON.parse(decodeURIComponent(m[1])) as Partial<ComposeDraft>
  } catch {
    return undefined
  }
}
