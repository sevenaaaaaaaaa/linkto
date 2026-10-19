import { absUrl, escapeHtml } from './html'
import { parseXml, type XNode } from './parse'

/** OPML 导入 / 导出（纯函数）。嵌套文件夹拍平为「A / B」分组。 */

export interface OpmlEntry {
  title: string
  xmlUrl: string
  htmlUrl: string | null
  group: string | null
}

export function parseOpml(text: string): OpmlEntry[] {
  const doc = parseXml(String(text ?? '').replace(/^﻿/, ''))
  const opml = doc.children.find((c): c is XNode => typeof c !== 'string' && c.name === 'opml')
  const body = opml?.children.find((c): c is XNode => typeof c !== 'string' && c.name === 'body')
  if (!body) throw new Error('不是有效的 OPML 文件（缺少 <body>）')
  const out: OpmlEntry[] = []
  const seen = new Set<string>()
  const rec = (n: XNode, path: string[]) => {
    for (const c of n.children) {
      if (typeof c === 'string' || c.name !== 'outline') continue
      const a = c.attrs
      const title = (a.title || a.text || '').trim()
      const xml = absUrl(a.xmlurl || a.url, null)
      if (xml) {
        if (!seen.has(xml)) {
          seen.add(xml)
          out.push({ title: title || xml, xmlUrl: xml, htmlUrl: absUrl(a.htmlurl, null), group: path.length ? path.join(' / ') : null })
        }
      } else rec(c, title ? [...path, title] : path)
    }
  }
  rec(body, [])
  return out
}

export function buildOpml(entries: OpmlEntry[], title = 'LinkTo 订阅', now = new Date()): string {
  const attr = (s: string) => escapeHtml(s).replace(/'/g, '&apos;')
  const line = (e: OpmlEntry, indent: string) =>
    `${indent}<outline type="rss" text="${attr(e.title)}" title="${attr(e.title)}" xmlUrl="${attr(e.xmlUrl)}"${e.htmlUrl ? ` htmlUrl="${attr(e.htmlUrl)}"` : ''}/>`
  const groups = new Map<string, OpmlEntry[]>()
  const loose: OpmlEntry[] = []
  for (const e of entries) {
    if (e.group) groups.set(e.group, [...(groups.get(e.group) ?? []), e])
    else loose.push(e)
  }
  const body: string[] = []
  for (const [g, list] of groups) {
    body.push(`    <outline text="${attr(g)}" title="${attr(g)}">`)
    for (const e of list) body.push(line(e, '      '))
    body.push('    </outline>')
  }
  for (const e of loose) body.push(line(e, '    '))
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${attr(title)}</title>
    <dateCreated>${now.toUTCString()}</dateCreated>
  </head>
  <body>
${body.join('\n')}
  </body>
</opml>
`
}
