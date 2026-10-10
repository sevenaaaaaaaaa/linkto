/**
 * Liquid Glass 真折射滤镜（依据 Apple WWDC25《Meet Liquid Glass》规范与社区实现：
 * - Lensing：边缘弯折背景光线，中心保持清晰 —— 用 feDisplacementMap + 预生成位移图实现
 * - 位移图编码：R/G 通道 = 像素采样偏移向量（中性灰 128 = 不偏移），边缘带内位移最强
 * - 变体：#lg-lens（常规）/#lg-lens-thick（浮层 morph 变厚：更强折射 + 更深散射）
 * - 仅 Chromium（Electron）支持 backdrop-filter: url()，检测通过才启用，否则纯 blur 降级
 */

let initialized = false

/** 圆角矩形 SDF（中心在原点，d<0 在内部） */
function roundedRectSDF(px: number, py: number, halfW: number, halfH: number, r: number): number {
  const qx = Math.abs(px) - (halfW - r)
  const qy = Math.abs(py) - (halfH - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r
}

/** 生成位移图：边缘带内位移最强，方向沿法向向外（放大镜效应），中心中性 */
function buildDisplacementMap(size = 512, bezel = 56, radius = 64): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x - half + 0.5
      const py = y - half + 0.5
      const d = roundedRectSDF(px, py, half, half, radius)
      const i = (y * size + x) * 4
      if (d <= 0 && d > -bezel) {
        // 边缘带内：t=1 于边界，衰减到带深处为 0
        const t = Math.pow(1 + d / bezel, 1.7)
        // 法向：角区用 (qx,qy) 方向，直边区取轴向
        const qx = Math.abs(px) - (half - radius)
        const qy = Math.abs(py) - (half - radius)
        let nx: number
        let ny: number
        if (qx > 0 && qy > 0) {
          const len = Math.hypot(qx, qy) || 1
          nx = (qx / len) * Math.sign(px || 1)
          ny = (qy / len) * Math.sign(py || 1)
        } else {
          // 距四边最近的轴
          const dx = half - Math.abs(px)
          const dy = half - Math.abs(py)
          if (dx < dy) {
            nx = Math.sign(px || 1)
            ny = 0
          } else {
            nx = 0
            ny = Math.sign(py || 1)
          }
        }
        const off = t * 127
        img.data[i] = Math.round(128 + nx * off)
        img.data[i + 1] = Math.round(128 + ny * off)
        img.data[i + 2] = 128
      } else {
        img.data[i] = 128
        img.data[i + 1] = 128
        img.data[i + 2] = 128
      }
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

/** 注入全局滤镜；不满足条件（非 Chromium backdrop-filter 场景）则跳过 */
export function initLiquidGlass(): void {
  if (initialized) return
  initialized = true
  try {
    if (!CSS.supports('backdrop-filter', 'blur(1px)')) return
    const map = buildDisplacementMap()
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.setAttribute('style', 'position:absolute;pointer-events:none')
    svg.innerHTML = `
      <filter id="lg-lens" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="soft"/>
        <feImage href="${map}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map"/>
        <feDisplacementMap in="soft" in2="map" scale="34" xChannelSelector="R" yChannelSelector="G" result="disp"/>
        <feColorMatrix in="disp" type="saturate" values="1.75" result="sat"/>
        <feComponentTransfer in="sat" result="out">
          <feFuncR type="linear" slope="1.06"/>
          <feFuncG type="linear" slope="1.06"/>
          <feFuncB type="linear" slope="1.06"/>
        </feComponentTransfer>
      </filter>
      <filter id="lg-lens-thick" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="4.5" result="soft"/>
        <feImage href="${map}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map"/>
        <feDisplacementMap in="soft" in2="map" scale="58" xChannelSelector="R" yChannelSelector="G" result="disp"/>
        <feColorMatrix in="disp" type="saturate" values="1.85" result="sat"/>
        <feComponentTransfer in="sat" result="out">
          <feFuncR type="linear" slope="1.08"/>
          <feFuncG type="linear" slope="1.08"/>
          <feFuncB type="linear" slope="1.08"/>
        </feComponentTransfer>
      </filter>
    `
    document.body.appendChild(svg)
    document.documentElement.classList.add('lg-refract')
  } catch {
    /* 滤镜不可用时保持纯 blur 降级，无感知 */
  }
}