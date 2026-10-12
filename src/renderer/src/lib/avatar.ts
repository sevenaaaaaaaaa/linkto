/**
 * 头像配色 —— 低彩度色相环（审计 D-3）
 * 色相由名字哈希决定（稳定），明度 / 彩度由 token 决定（--avatar-*，随明暗切换），
 * 避免高饱和纯色圆在列表里抢过未读状态的视觉权重。
 */
import type { CSSProperties } from 'react'

export function avatarHue(name: string): number {
  let h = 0
  for (const ch of name.trim()) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360
  return h
}

export function avatarStyle(name: string): CSSProperties {
  const h = avatarHue(name || '?')
  return {
    background: `oklch(var(--avatar-bg-l) var(--avatar-bg-c) ${h})`,
    color: `oklch(var(--avatar-fg-l) var(--avatar-fg-c) ${h})`
  }
}
