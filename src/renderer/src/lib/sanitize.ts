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

  const imgs = doc.querySelectorAll('img')
  for (const img of [...imgs]) {
    const src = img.getAttribute('src') ?? ''
    if (src.startsWith('cid:')) {
      const resolved = opts.resolveCid(src.slice(4).replace(/[<>]/g, ''))
      if (resolved) img.setAttribute('src', resolved)
      else img.removeAttribute('src')
    } else if (/^https?:/i.test(src)) {
      remoteImages++
      if (!opts.allowRemote) {
        img.setAttribute('data-ms-remote-src', src)
        img.removeAttribute('src')
        img.setAttribute('data-ms-blocked', '1')
      }
    }
  }

  // 背景图同样拦截
  if (!opts.allowRemote) {
    for (const el of all) {
      const bg = el.getAttribute('background')
      if (bg && /^https?:/i.test(bg)) el.removeAttribute('background')
      const style = el.getAttribute('style')
      if (style && /url\((['"]?)https?:/i.test(style)) {
        el.setAttribute('style', style.replace(/url\((['"]?)https?:[^)]*\)/gi, 'none'))
      }
    }
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
