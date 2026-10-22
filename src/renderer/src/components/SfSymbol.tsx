import type { CSSProperties, ReactNode, SVGProps } from 'react'
import { useSystemSymbol } from '../lib/system-symbols'

type P = SVGProps<SVGSVGElement> & {
  name: string
  fallback?: ReactNode
}

/**
 * SF Symbol 作为 CSS mask 渲染：currentColor 着色，自动跟随主题 / 明暗 / 选中态。
 * 拿不到系统符号时渲染传入的 fallback SVG。
 */
export function SfSymbol(props: P) {
  const url = useSystemSymbol(props.name)
  if (!url) return <>{props.fallback ?? null}</>
  const { name: _name, fallback: _fallback, width = 16, height = 16, style, className } = props
  const maskStyle: CSSProperties = {
    width,
    height,
    display: 'inline-block',
    flexShrink: 0,
    backgroundColor: 'currentColor',
    WebkitMaskImage: `url("${url}")`,
    maskImage: `url("${url}")`,
    WebkitMaskSize: 'contain',
    maskSize: 'contain',
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
    ...style
  }
  return <span aria-hidden="true" className={className} style={maskStyle} />
}
