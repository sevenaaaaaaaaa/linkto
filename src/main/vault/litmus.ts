import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 寻找 Litmus 库：优先 LITMUS_VAULT，其次 ~/Documents/Litmus；必须有 Notes/ */
export function litmusVaultRoot(envPath: string | undefined, documentsDir: string): string | null {
  const candidate = (envPath ?? '').trim() || join(documentsDir, 'Litmus')
  if (!candidate) return null
  return existsSync(join(candidate, 'Notes')) ? candidate : null
}

function stampOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) +
    '-' + pad(d.getMinutes()) +
    '-' + pad(d.getSeconds()) +
    '-' + String(d.getMilliseconds()).padStart(3, '0')
  )
}

/**
 * 写一篇普通 Markdown 到 Litmus 的 Notes/Inbox（没有 Inbox 就写 Notes）。
 * Litmus 是文件真相、监听式索引；这里不依赖它的 daemon。
 */
export function writeLitmusNote(vaultRoot: string, title: string, body: string, now = Date.now()): string {
  const notes = join(vaultRoot, 'Notes')
  if (!existsSync(notes)) throw new Error('Litmus 库里没有 Notes 目录')
  const inbox = join(notes, 'Inbox')
  const dir = existsSync(inbox) ? inbox : notes
  const safeTitle = (title || '')
    .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
    .trim()
    .slice(0, 60) || '萤火密信'
  const file = join(dir, 'LinkTo ' + stampOf(new Date(now)) + ' ' + safeTitle + '.md')
  const content =
    '# ' + (title.trim() || '萤火密信') + '\n\n' +
    body + '\n\n' +
    '---\n\n' +
    '> 来源：LinkTo · 萤火密信 · ' + new Date(now).toISOString() + '\n'
  writeFileSync(file, content, 'utf8')
  return file
}
