import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { parseChecksums, checksumFor } from '../src/main/update-checksums.ts'
import { INSTALL_SCRIPT } from '../src/main/update-install-script.ts'

let passed = 0
function ok(name: string, fn: () => void) {
  try { fn(); passed++; console.log('  ok  ' + name) } catch (e) { console.error('FAIL  ' + name); throw e }
}

const sample = [
  'cb3ff58f72e16f778b9fb5c6379b4e539f5fbf8dec57bba2c370438f771883f8  LinkTo-0.5.0-arm64.dmg',
  '11a8c636112e516e76c307919e68311ba3246eb21a500c12a116bff0cbd396f6  LinkTo.Setup.0.5.0.exe',
  '',
  'not a checksum line',
  '# comment'
].join('\n')

console.log('update selftest')

ok('解析 SHA256SUMS.txt', () => {
  const map = parseChecksums(sample)
  assert.equal(map.size, 2)
  assert.equal(map.get('LinkTo-0.5.0-arm64.dmg')?.length, 64)
  assert.equal(map.get('LinkTo.Setup.0.5.0.exe')?.length, 64)
})

ok('本地空格名 / GitHub 点名可互换', () => {
  assert.equal(
    checksumFor(sample, 'LinkTo Setup 0.5.0.exe'),
    '11a8c636112e516e76c307919e68311ba3246eb21a500c12a116bff0cbd396f6'
  )
  assert.equal(checksumFor(sample, 'LinkTo.Setup.0.5.0.exe')?.length, 64)
  assert.equal(checksumFor(sample, 'missing.dmg'), null)
})

ok('安装脚本语法正确（sh -n）', () => {
  assert.ok(INSTALL_SCRIPT.includes('LINKTO_UPDATE_TEST'))
  assert.ok(INSTALL_SCRIPT.includes('bundle mismatch'))
  assert.ok(INSTALL_SCRIPT.includes('restoring'))
  writeFileSync('/tmp/linkto-update-install-selftest.sh', INSTALL_SCRIPT)
  execFileSync('sh', ['-n', '/tmp/linkto-update-install-selftest.sh'])
})

console.log('\n' + passed + ' update groups passed')
