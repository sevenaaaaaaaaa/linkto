/** 邮件 HTML 安全处理：去脚本/表单/事件属性，处理内嵌图与远程图 */
export interface SanitizeResult {
  html: string
  remoteImages: number
}

export function sanitizeEmailHtml(
  html: string,
  opts: {
    allowRemote: boolean
    resolveCid(cid: string): string | null
    onRemoteBlocked?(src: string): void
  }
): SanitizeResult {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  let remoteImages = 0

  doc.querySelectorAll('script, iframe, object, embed, link, meta, form, base, frame, frameset').forEach(el => el.remove())

  const all = doc.querySelectorAll('*')
  for (const el of all) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) el.removeAttribute(attr.name)
      else if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name)
      }
    }
  }

  const isRemote = (url: string) => /^(https?:)?\/\//i.test(url.trim())
  const remoteUrlRe = /url\((['"]?)((?:https?:)?\/\/[^)]+)\)/gi
  const absolute = (url: string) => (url.startsWith('//') ? `https:${url}` : url)

  const imgs = doc.querySelectorAll('img')
  for (const img of [...imgs]) {
    const src = (img.getAttribute('src') ?? '').trim()
    if (src.startsWith('cid:')) {
      const resolved = opts.resolveCid(src.slice(4).replace(/[<>]/g, ''))
      if (resolved) img.setAttribute('src', resolved)
      else img.removeAttribute('src')
      continue
    }

    // 懒加载图片：很多营销邮件把真实地址放在 data-src / data-original，src 只是占位图
    const lazy = ['data-src', 'data-original', 'data-lazy-src', 'data-url']
      .map(attr => img.getAttribute(attr)?.trim() ?? '')
      .find(url => isRemote(url))
    const effective = isRemote(src) ? src : lazy ?? src

    if (isRemote(effective)) {
      remoteImages++
      if (opts.allowRemote) {
        img.setAttribute('src', absolute(effective))
        img.removeAttribute('data-ms-blocked')
      } else {
        img.setAttribute('data-ms-remote-src', absolute(effective))
        img.removeAttribute('src')
        img.setAttribute('data-ms-blocked', '1')
      }
    } else if (opts.allowRemote && src.startsWith('data:')) {
      // data: 内嵌图直接可用
      img.setAttribute('src', src)
    }

    const srcset = img.getAttribute('srcset')
    if (srcset && /(^|,)\s*((https?:)?\/\/)/i.test(srcset)) {
      remoteImages++
      if (!opts.allowRemote) {
        img.setAttribute('data-ms-remote-srcset', srcset)
        img.removeAttribute('srcset')
      } else {
        img.setAttribute('srcset', srcset.replace(/(^|,\s*)\/\//g, '$1https://'))
      }
    }
  }

  // <picture><source srcset> 同样处理
  for (const source of [...doc.querySelectorAll('source[srcset]')]) {
    const srcset = source.getAttribute('srcset') ?? ''
    if (!/(^|,)\s*((https?:)?\/\/)/i.test(srcset)) continue
    remoteImages++
    if (!opts.allowRemote) source.removeAttribute('srcset')
    else source.setAttribute('srcset', srcset.replace(/(^|,\s*)\/\//g, '$1https://'))
  }

  // 背景图 / 内联样式里的远程资源：同样计数，避免“静默消失”
  for (const el of all) {
    const bg = el.getAttribute('background')
    if (bg && isRemote(bg)) {
      remoteImages++
      if (!opts.allowRemote) {
        el.setAttribute('data-ms-remote-bg', absolute(bg))
        el.removeAttribute('background')
      } else if (bg.startsWith('//')) {
        el.setAttribute('background', absolute(bg))
      }
    }
    const style = el.getAttribute('style')
    if (!style) continue
    const matches = [...style.matchAll(remoteUrlRe)]
    if (!matches.length) continue
    remoteImages += matches.length
    if (!opts.allowRemote) el.setAttribute('style', style.replace(remoteUrlRe, 'none'))
  }

  // <style> 里的远程背景（营销邮件常用）也计数；不允许时改成 none
  for (const styleEl of [...doc.querySelectorAll('style')]) {
    const css = styleEl.textContent ?? ''
    // @font-face 的 woff2 不是图片：只统计背景类远程资源，避免误报
    const withoutFonts = css.replace(/@font-face\s*{[^}]*}/gi, '')
    const matches = [...withoutFonts.matchAll(remoteUrlRe)]
    if (!matches.length) continue
    remoteImages += matches.length
    if (!opts.allowRemote) styleEl.textContent = css.replace(remoteUrlRe, 'none')
  }

  return { html: doc.body?.innerHTML ?? '', remoteImages }
}

/** 点击已加载的远程图占位 */
export function activateRemoteImages(root: HTMLElement) {
  root.querySelectorAll('img[data-ms-remote-src]').forEach(img => {
    img.setAttribute('src', img.getAttribute('data-ms-remote-src')!)
    img.removeAttribute('data-ms-blocked')
  })
}

/** 纯文本 → HTML（回复引用等场景） */
export function textToHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => `<p>${escapeHtml(line) || '<br>'}</p>`)
    .join('')
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
