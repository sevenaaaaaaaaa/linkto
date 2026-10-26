import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { seal, open, flyLink } from '../src/main/fly/core.ts'
import worker, { canonicalReaderHtml } from '../relay/src/worker.ts'

function makeEnv() {
  const store = new Map<string, string>()
  return {
    store,
    env: {
      BOX: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => { store.set(k, v) },
        delete: async (k: string) => { store.delete(k) }
      }
    } as any
  }
}

const { env } = makeEnv()
const origin = 'https://relay.test'
let passed = 0
async function ok(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('  ok  ' + name) } catch (e) { console.error('FAIL  ' + name); throw e }
}
async function call(path: string, init?: RequestInit) {
  return worker.fetch(new Request(origin + path, init), env)
}

console.log('relay v2 selftest')

const sealed = seal('中继只应看到密文。这是一封一次性密信。', { mode: 'link', ttlSeconds: 600 })
const body = JSON.stringify({ e: sealed.envelope, ttl: 600 })

await ok('投递 → 读取 → 客户端解密 → 焚毁', async () => {
  const post = await call('/api/v2/box', { method: 'POST', body, headers: { 'content-type': 'application/json' } })
  assert.equal(post.status, 200)
  const get = await call('/api/v2/box/' + sealed.mbox)
  assert.equal(get.status, 200)
  const data = await get.json() as { e: string }
  assert.equal(data.e, sealed.envelope)
  assert.equal(open(data.e, { keyB64: sealed.keyB64 }).text, '中继只应看到密文。这是一封一次性密信。')
  const del = await call('/api/v2/box/' + sealed.mbox, { method: 'DELETE' })
  assert.equal(del.status, 200)
  assert.equal((await call('/api/v2/box/' + sealed.mbox)).status, 404)
})

await ok('重复投递同一信箱被拒（不覆盖已存在密文）', async () => {
  const s = seal('x', { mode: 'link', ttlSeconds: 600 })
  const b = JSON.stringify({ e: s.envelope, ttl: 600 })
  assert.equal((await call('/api/v2/box', { method: 'POST', body: b })).status, 200)
  assert.equal((await call('/api/v2/box', { method: 'POST', body: b })).status, 409)
})

await ok('读取次数上限 8 次，超限即删', async () => {
  const s = seal('attempts', { mode: 'code', ttlSeconds: 600 })
  const b = JSON.stringify({ e: s.envelope, ttl: 600 })
  assert.equal((await call('/api/v2/box', { method: 'POST', body: b })).status, 200)
  for (let i = 0; i < 8; i++) assert.equal((await call('/api/v2/box/' + s.mbox)).status, 200)
  assert.equal((await call('/api/v2/box/' + s.mbox)).status, 410)
  assert.equal((await call('/api/v2/box/' + s.mbox)).status, 404)
})

await ok('非法信封 / 非法信箱号被拒', async () => {
  assert.equal((await call('/api/v2/box', { method: 'POST', body: JSON.stringify({ e: '{"app":"x"}' }) })).status, 400)
  assert.equal((await call('/api/v2/box/abc')).status, 400)
  assert.equal((await call('/api/v2/box/' + 'f'.repeat(32))).status, 404)
})

await ok('浏览器阅读页：无外部资源、内联脚本可编译、CSP 生效', async () => {
  const res = await call('/r/' + sealed.mbox)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/)
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  const html = await res.text()
  assert.ok(html.includes('一次性密信'))
  assert.ok(!/https?:\/\//.test(html), 'reader must not reference external URLs')
  assert.ok(!html.includes(sealed.envelope))
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(m)
  new Function(m![1])
})

await ok('阅读页版本哈希：meta、页面、头部三者一致且可复核', async () => {
  const meta = (await (await call('/api/v2/meta')).json()) as { reader?: { version?: string; sha256?: string; bytes?: number } }
  assert.equal(meta.reader?.version, '2.0.0')
  assert.match(meta.reader?.sha256 ?? '', /^[0-9a-f]{64}$/)
  assert.ok((meta.reader?.bytes ?? 0) > 1000)

  const res = await call('/r/' + 'a'.repeat(32))
  const html = await res.text()
  assert.equal(res.headers.get('x-fly-reader-sha256'), meta.reader!.sha256)
  assert.equal(res.headers.get('x-fly-reader-version'), '2.0.0')
  assert.ok(html.includes(meta.reader!.sha256!))
  assert.ok(html.includes('复制哈希'))

  // 用户把页面另存后，本地规范化再算一次，应得到同一个值
  const again = createHash('sha256').update(canonicalReaderHtml(html), 'utf8').digest('hex')
  assert.equal(again, meta.reader!.sha256)

  // 任何字节改动都会改变哈希（恶意中继无法“既改页面又保持同一哈希”）
  const tampered = html.replace('</body>', '<script>steal()</script></body>')
  const changed = createHash('sha256').update(canonicalReaderHtml(tampered), 'utf8').digest('hex')
  assert.notEqual(changed, meta.reader!.sha256)
})

await ok('阅读页包含与客户端一致的 KDF/AAD 参数', async () => {
  const html = await (await call('/')).text()
  assert.ok(html.includes("'linkto-fly/code/v2'"))
  assert.ok(html.includes("'linkto-fly/mbox/v2'"))
  assert.ok(html.includes('600000'))
  assert.ok(html.includes("additionalData: aad(h)"))
})

console.log('\n' + passed + ' relay groups passed')
