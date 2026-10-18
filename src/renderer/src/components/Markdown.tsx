import { Fragment, type ReactNode } from 'react'

/**
 * AI 输出的轻量 Markdown 渲染：模型普遍输出 Markdown，按纯文本显示会露出 ** ## - 等标记。
 * 只生成 React 元素、不用 innerHTML（AI 内容视为不可信）；流式输出中未闭合的语法按原文显示。
 * 支持：标题、段落、有序/无序列表（两级缩进）、引用、代码块、分隔线、表格、粗体/斜体/删除线/行内代码/链接。
 */

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: { text: string; depth: number }[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'hr' }
  | { kind: 'table'; head: string[]; rows: string[][] }

const LIST_ITEM = /^(\s*)([-*+•]|\d+[.)、])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

const splitRow = (line: string) =>
  line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    if (/^\s*```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    const h = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length, text: h[2] })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]))
      blocks.push({ kind: 'table', head, rows })
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ kind: 'quote', lines: body })
      continue
    }
    const li = LIST_ITEM.exec(line)
    if (li) {
      const ordered = /\d/.test(li[2])
      const items: { text: string; depth: number }[] = []
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i])
        if (m) {
          items.push({ text: m[3], depth: m[1].replace(/\t/g, '  ').length >= 2 ? 1 : 0 })
          i++
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          // 列表项的续行
          items[items.length - 1].text += ' ' + lines[i++].trim()
        } else break
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|#{1,6}\s|>)/.test(lines[i]) &&
      !LIST_ITEM.test(lines[i])
    ) {
      para.push(lines[i++])
    }
    if (para.length) blocks.push({ kind: 'para', lines: para })
    else i++
  }
  return blocks
}

// ---------- 行内 ----------

type Inline = { t: 'text' | 'strong' | 'em' | 'del' | 'code'; v: string } | { t: 'link'; v: string; href: string }

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(~~[^~\n]+?~~)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\))|(\*[^*\s][^*\n]*?\*|(?<![\w])_[^_\s][^_\n]*?_(?![\w]))/g

function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push({ t: 'text', v: text.slice(last, m.index) })
    const s = m[0]
    if (m[1]) out.push({ t: 'code', v: s.slice(1, -1) })
    else if (m[2]) out.push({ t: 'strong', v: s.slice(2, -2) })
    else if (m[3]) out.push({ t: 'del', v: s.slice(2, -2) })
    else if (m[4]) out.push({ t: 'link', v: s.slice(1, s.indexOf('](')), href: m[5] })
    else out.push({ t: 'em', v: s.slice(1, -1) })
    last = m.index! + s.length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

function renderInline(text: string): ReactNode {
  return parseInline(text).map((n, k) => {
    switch (n.t) {
      case 'strong':
        return <strong key={k} className="font-semibold" style={{ color: 'var(--fg)' }}>{renderInline(n.v)}</strong>
      case 'em':
        return <em key={k}>{n.v}</em>
      case 'del':
        return <del key={k}>{n.v}</del>
      case 'code':
        return (
          <code key={k} className="px-1 py-px rounded text-[0.92em] font-mono" style={{ background: 'var(--hover)' }}>
            {n.v}
          </code>
        )
      case 'link':
        return (
          <a key={k} href={n.href} target="_blank" rel="noreferrer" className="underline underline-offset-2" style={{ color: 'var(--accent-ink)' }}>
            {n.v}
          </a>
        )
      default:
        return <Fragment key={k}>{n.v}</Fragment>
    }
  })
}

const HEADING_CLASS = ['', 'text-md font-semibold', 'text-md font-semibold', 'text-sm font-semibold', 'text-sm font-semibold', 'text-sm font-medium', 'text-sm font-medium']

/** 渲染 AI 输出的 Markdown；颜色继承外层，适配明暗与主题预设 */
export function Markdown(props: { text: string; className?: string }) {
  const blocks = parseMarkdown(props.text)
  return (
    <div className={`md-ai space-y-2 ${props.className ?? ''}`}>
      {blocks.map((b, k) => {
        switch (b.kind) {
          case 'heading':
            return (
              <div key={k} className={`${HEADING_CLASS[b.level]} pt-1`} style={{ color: 'var(--fg)' }}>
                {renderInline(b.text)}
              </div>
            )
          case 'para':
            return (
              <p key={k}>
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {renderInline(l)}
                  </Fragment>
                ))}
              </p>
            )
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul'
            // 子项挂到上一条顶层项下面，避免占用外层编号
            const groups: { text: string; children: string[] }[] = []
            for (const it of b.items) {
              if (it.depth && groups.length) groups[groups.length - 1].children.push(it.text)
              else groups.push({ text: it.text, children: [] })
            }
            return (
              <Tag key={k} className={`space-y-1 pl-5 ${b.ordered ? 'list-decimal' : 'list-disc'} marker:text-[var(--faint)]`}>
                {groups.map((g, j) => (
                  <li key={j}>
                    {renderInline(g.text)}
                    {g.children.length > 0 && (
                      <ul className="mt-1 space-y-1 pl-4 list-[circle]">
                        {g.children.map((c, x) => (
                          <li key={x}>{renderInline(c)}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </Tag>
            )
          }
          case 'quote':
            return (
              <blockquote key={k} className="pl-3 border-l-2" style={{ borderColor: 'var(--border-strong)', color: 'var(--muted)' }}>
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {renderInline(l)}
                  </Fragment>
                ))}
              </blockquote>
            )
          case 'code':
            return (
              <pre key={k} className="text-xs font-mono rounded-[var(--r-sm)] px-3 py-2 overflow-x-auto whitespace-pre" style={{ background: 'var(--hover)' }}>
                {b.text}
              </pre>
            )
          case 'hr':
            return <hr key={k} style={{ borderColor: 'var(--border-soft)' }} />
          case 'table':
            return (
              <div key={k} className="overflow-x-auto">
                <table className="text-xs border-collapse">
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} className="text-left font-semibold px-2 py-1 border-b" style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}>
                          {renderInline(c)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, x) => (
                          <td key={x} className="px-2 py-1 border-b align-top" style={{ borderColor: 'var(--border-soft)' }}>
                            {renderInline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        }
      })}
    </div>
  )
}

// ---------- 转邮件 HTML（AI 起草的回复放进撰写窗） ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inlineHtml(text: string): string {
  return parseInline(text)
    .map(n => {
      switch (n.t) {
        case 'strong':
          return `<strong>${inlineHtml(n.v)}</strong>`
        case 'em':
          return `<em>${esc(n.v)}</em>`
        case 'del':
          return `<del>${esc(n.v)}</del>`
        case 'code':
          return `<code>${esc(n.v)}</code>`
        case 'link':
          return `<a href="${esc(n.href)}">${esc(n.v)}</a>`
        default:
          return esc(n.v)
      }
    })
    .join('')
}

/** Markdown → 邮件正文 HTML（转义所有原文，只输出受控标签） */
export function markdownToHtml(src: string): string {
  return parseMarkdown(src)
    .map(b => {
      switch (b.kind) {
        case 'heading':
          return `<p><strong>${inlineHtml(b.text)}</strong></p>`
        case 'para':
          return `<p>${b.lines.map(inlineHtml).join('<br>')}</p>`
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul'
          return `<${tag}>${b.items.map(it => `<li>${inlineHtml(it.text)}</li>`).join('')}</${tag}>`
        }
        case 'quote':
          return `<blockquote>${b.lines.map(inlineHtml).join('<br>')}</blockquote>`
        case 'code':
          return `<pre>${esc(b.text)}</pre>`
        case 'hr':
          return '<hr>'
        case 'table':
          return `<table><tr>${b.head.map(c => `<th>${inlineHtml(c)}</th>`).join('')}</tr>${b.rows
            .map(r => `<tr>${r.map(c => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`)
            .join('')}</table>`
      }
    })
    .join('')
}
