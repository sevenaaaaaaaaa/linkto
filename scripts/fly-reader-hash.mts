import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { READER_VERSION, canonicalReaderHtml, readerPage } from '../relay/src/worker.ts'

/**
 * 打印浏览器阅读页的版本哈希。
 *
 *   npm run fly:reader-hash
 *   npm run fly:reader-hash -- --json
 *   npm run fly:reader-hash -- --file ~/Downloads/reader.html
 *
 * 仓库源码与“浏览器另存下来的页面”必须得到同一个哈希：页面里显示哈希的位置
 * 在计算前会被还原成占位符（canonicalReaderHtml）。
 */
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const fileIdx = args.indexOf('--file')
const file = fileIdx >= 0 ? (args[fileIdx + 1] ?? '') : ''

if (fileIdx >= 0 && !file) {
  console.error('用法: node scripts/fly-reader-hash.mts [--json] [--file <保存的阅读页.html>]')
  process.exit(2)
}

let source: string
try {
  source = file ? readFileSync(file, 'utf8') : readerPage()
} catch (err) {
  console.error('读取失败:', err instanceof Error ? err.message : String(err))
  process.exit(1)
}

const canonical = canonicalReaderHtml(source)
const sha256 = createHash('sha256').update(canonical, 'utf8').digest('hex')
const bytes = Buffer.byteLength(canonical, 'utf8')

if (asJson) {
  console.log(JSON.stringify({ version: READER_VERSION, sha256, bytes, source: file ? 'file' : 'repo' }, null, 2))
} else {
  console.log('reader ' + READER_VERSION + ' sha256 ' + sha256 + (file ? ' (saved page)' : ''))
}
