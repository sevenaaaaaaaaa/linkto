import assert from 'node:assert/strict'
import {
  CODE_WORDS,
  FLY_VERSION,
  FlyError,
  MAX_TTL_SECONDS,
  PBKDF2_ITERATIONS,
  WORDS,
  deriveKeyFromCode,
  flyLink,
  generateCode,
  inspectEnvelope,
  looksLikeCode,
  mboxForCode,
  normalizeCode,
  open,
  parseFlyLink,
  seal
} from '../src/main/fly/core.ts'

let passed = 0
function ok(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log('  ok  ' + name)
  } catch (err) {
    console.error('FAIL  ' + name)
    throw err
  }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return err instanceof FlyError ? err.code : 'unknown:' + String(err)
  }
  return 'no-error'
}

console.log('fly core selftest · v' + FLY_VERSION)

ok('词表是 2048 个唯一小写词，6 词口令形状正确', () => {
  assert.equal(WORDS.length, 2048)
  assert.equal(new Set(WORDS).size, 2048)
  for (const w of WORDS) assert.match(w, /^[a-z]{3,8}$/)
  const code = generateCode()
  assert.equal(code.split(' ').length, CODE_WORDS)
  assert.ok(looksLikeCode(code))
  assert.ok(!looksLikeCode('hello world'))
})

ok('口令规范化：大小写 / 全角 / 连字符 / 中文标点', () => {
  const a = 'Abandon  Ability, Able'
  assert.equal(normalizeCode(a), 'abandon ability able')
  assert.equal(normalizeCode('abandon－ability，able'), 'abandon ability able')
  assert.equal(normalizeCode('  ABANDON\nability\t able  '), 'abandon ability able')
})

ok('链接模式：256bit 密钥往返 + Unicode 正文', () => {
  const text = '今晚 21:00 老地方。带上 U 盘，别用微信。🙂\n' + 'x'.repeat(3000)
  const sealed = seal(text, { mode: 'link', ttlSeconds: 3600, now: 1_700_000_000_000 })
  const link = flyLink('https://relay.example', sealed)
  assert.match(link, /^https:\/\/relay\.example\/r\/[0-9a-f]{32}#k=[A-Za-z0-9_-]{43}$/)
  assert.ok(!link.includes('?k='))
  const parts = parseFlyLink(link)!
  assert.equal(parts.mbox, sealed.mbox)
  assert.equal(parts.keyB64, sealed.keyB64)
  assert.equal(parts.needsCode, false)
  const opened = open(sealed.envelope, { keyB64: parts.keyB64, now: 1_700_000_000_500 })
  assert.equal(opened.text, text)
  assert.equal(opened.mode, 'link')
  assert.equal(opened.mbox, sealed.mbox)
})

ok('链接 + 口令：缺口令 / 错口令都不能读', () => {
  const sealed = seal('两信道缺一不可', { mode: 'link-code', ttlSeconds: 600 })
  const link = flyLink('https://relay.example', sealed)
  assert.ok(link.endsWith('#c'))
  assert.ok(!link.includes(sealed.code!))
  const parts = parseFlyLink(link)!
  assert.equal(parts.needsCode, true)
  assert.equal(codeOf(() => open(sealed.envelope, { now: Date.now() })), 'missing-secret')
  assert.equal(codeOf(() => open(sealed.envelope, { code: generateCode() })), 'wrong-code')
  assert.equal(open(sealed.envelope, { code: sealed.code }).text, '两信道缺一不可')
})

ok('纯口令模式：口令同时决定信箱号与密钥', () => {
  const sealed = seal('只说六个词就能读', { mode: 'code', ttlSeconds: 86400 })
  assert.equal(sealed.mbox, mboxForCode(sealed.code!))
  const opened = open(sealed.envelope, { code: '  ' + sealed.code!.toUpperCase().replaceAll(' ', ' - ') })
  assert.equal(opened.text, '只说六个词就能读')
  assert.equal(opened.mode, 'code')
  assert.equal(codeOf(() => open(sealed.envelope, { code: generateCode() })), 'wrong-code')
})

ok('信封头部被篡改（信箱号 / TTL / 模式）时 AEAD 拒绝', () => {
  const sealed = seal('header is authenticated', { mode: 'link', ttlSeconds: 600 })
  const base = JSON.parse(sealed.envelope)
  for (const patch of [
    { mb: '0'.repeat(32) },
    { ttl: 601 },
    { iat: base.iat + 1 },
    { m: 'code' }
  ]) {
    const tampered = JSON.stringify({ ...base, ...patch })
    const c = codeOf(() => open(tampered, { keyB64: sealed.keyB64 }))
    assert.ok(c === 'wrong-code' || c === 'tampered' || c === 'missing-secret', 'unexpected ' + c)
  }
})

ok('密文/标签被篡改时拒绝，且不泄露明文', () => {
  const sealed = seal('tamper me', { mode: 'link', ttlSeconds: 600 })
  const base = JSON.parse(sealed.envelope)
  for (const patch of [
    { c: Buffer.from('AAAA', 'utf8').toString('base64') },
    { t: Buffer.alloc(16).toString('base64') }
  ]) {
    const c = codeOf(() => open(JSON.stringify({ ...base, ...patch }), { keyB64: sealed.keyB64 }))
    assert.equal(c, 'wrong-code')
  }
  assert.ok(!sealed.envelope.includes('tamper me'))
})

ok('过期信封拒绝打开（exp 受 AEAD 保护）', () => {
  const now = 1_700_000_000_000
  const sealed = seal('expires', { mode: 'link', ttlSeconds: 60, now })
  assert.equal(open(sealed.envelope, { keyB64: sealed.keyB64, now: now + 59_000 }).text, 'expires')
  assert.equal(codeOf(() => open(sealed.envelope, { keyB64: sealed.keyB64, now: now + 60_000 })), 'expired')
})

ok('填充档位：不同长度正文只落在有限档位，且 ct 长度等于档位', () => {
  const sizes = new Set<number>()
  for (const n of [1, 10, 100, 200, 400, 900, 3000, 8000]) {
    const sealed = seal('x'.repeat(n), { mode: 'link', ttlSeconds: 600 })
    const hdr = JSON.parse(sealed.envelope)
    const ctLen = Buffer.from(hdr.c, 'base64').length
    assert.ok([256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 49152].includes(ctLen))
    sizes.add(ctLen)
  }
  assert.ok(sizes.size <= 5, 'too many buckets: ' + [...sizes].join(','))
})

ok('TTL 被夹在 60s..7d', () => {
  const a = seal('a', { mode: 'link', ttlSeconds: 1 })
  const b = seal('b', { mode: 'link', ttlSeconds: 999_999_999 })
  assert.equal(inspectEnvelope(a.envelope).ttl, 60)
  assert.equal(inspectEnvelope(b.envelope).ttl, MAX_TTL_SECONDS)
})

ok('超长正文被拒绝', () => {
  assert.equal(codeOf(() => seal('中'.repeat(20_000), { mode: 'link', ttlSeconds: 60 })), 'too-long')
})

ok('非信封输入不会误解密', () => {
  assert.equal(codeOf(() => open('not json', { keyB64: 'x' })), 'bad-envelope')
  assert.equal(parseFlyLink('https://relay.example/foo'), null)
  assert.equal(parseFlyLink('https://relay.example/r/abc'), null)
})

ok('PBKDF2 参数与浏览器端一致', () => {
  const salt = Buffer.from('fixed-salt-for-test')
  const k1 = deriveKeyFromCode('abandon ability able about above absent', salt)
  const k2 = deriveKeyFromCode('Abandon-Ability-Able-About-Above-Absent', salt)
  assert.equal(k1.toString('hex'), k2.toString('hex'))
  assert.equal(k1.length, 32)
  console.log('      PBKDF2 iterations = ' + PBKDF2_ITERATIONS.toLocaleString())
})

console.log('\n' + passed + ' groups passed')
