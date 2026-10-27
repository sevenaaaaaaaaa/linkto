import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { litmusVaultRoot, writeLitmusNote } from '../src/main/vault/litmus.ts'

let passed = 0
function ok(name: string, fn: () => void) {
  try { fn(); passed++; console.log('  ok  ' + name) } catch (e) { console.error('FAIL  ' + name); throw e }
}

console.log('vault / litmus selftest')

const root = mkdtempSync(join(tmpdir(), 'litmus-test-'))
mkdirSync(join(root, 'Notes', 'Inbox'), { recursive: true })

ok('识别 Litmus 库（必须有 Notes/）', () => {
  assert.equal(litmusVaultRoot(root, '/tmp/none'), root)
  const empty = mkdtempSync(join(tmpdir(), 'litmus-empty-'))
  assert.equal(litmusVaultRoot(empty, '/tmp/none'), null)
  rmSync(empty, { recursive: true, force: true })
})

ok('写入 Notes/Inbox 的普通 Markdown', () => {
  const file = writeLitmusNote(root, 'GitHub 恢复码', 'abc-123\n第二行', 1_700_000_000_000)
  const content = readFileSync(file, 'utf8')
  assert.match(file, /\/Notes\/Inbox\/LinkTo .*GitHub 恢复码\.md$/)
  assert.ok(content.startsWith('# GitHub 恢复码'))
  assert.ok(content.includes('abc-123\n第二行'))
  assert.ok(content.includes('来源：LinkTo · 萤火密信'))
  assert.equal(readdirSync(join(root, 'Notes', 'Inbox')).length, 1)
})

ok('文件名去掉路径分隔符，避免越界', () => {
  const file = writeLitmusNote(root, '../evil/title', 'x', 1_700_000_000_001)
  assert.ok(!file.includes('/evil/'))
  assert.match(file, /LinkTo .*evil title\.md$/)
})

rmSync(root, { recursive: true, force: true })
console.log('\n' + passed + ' vault groups passed')
