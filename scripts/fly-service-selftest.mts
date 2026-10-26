import assert from 'node:assert/strict'
import { FlyService } from '../src/main/fly/service'
import worker from '../relay/src/worker'

const store = new Map<string, string>()
const relayEnv: any = {
  BOX: {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) }
  }
}
const settings = new Map<string, string>([['fly.relayUrl', 'https://relay.test']])
const fetchImpl = ((input: any, init?: RequestInit) =>
  worker.fetch(new Request(String(input), init), relayEnv)) as typeof fetch
const svc = new FlyService({
  getSetting: k => settings.get(k) ?? '',
  setSetting: (k, v) => { settings.set(k, v) },
  fetchImpl
})

let passed = 0
async function ok(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('  ok  ' + name) } catch (e) { console.error('FAIL  ' + name); throw e }
}

console.log('fly service e2e selftest (service ↔ worker ↔ core)')

await ok('链接模式：写 → 读 → 二次读取失败', async () => {
  const r = await svc.compose({ text: '第一次也是最后一次阅读', mode: 'link', ttlSeconds: 600 })
  assert.equal(r.ok, true)
  assert.match(r.link!, /#k=[A-Za-z0-9_-]{43}$/)
  const o = await svc.open(r.link!)
  assert.equal(o.ok, true)
  assert.equal(o.burned, true)
  assert.equal(svc.take(o.token!), '第一次也是最后一次阅读')
  assert.equal(svc.take(o.token!), null, '取件号必须一次性')
  const again = await svc.open(r.link!)
  assert.equal(again.ok, false)
  assert.match(again.error!, /不存在|焚毁|过期/)
})

await ok('链接+口令：缺口令/错口令不焚毁，改对后仍可读', async () => {
  const r = await svc.compose({ text: '两条信道', mode: 'link-code', ttlSeconds: 600 })
  assert.equal(r.ok, true)
  assert.ok(r.link!.endsWith('#c'))
  assert.equal(r.code!.split(' ').length, 6)
  const noCode = await svc.open(r.link!)
  assert.equal(noCode.ok, false)
  assert.match(noCode.error!, /6 词口令/)
  const wrong = await svc.open(r.link!, 'apple apple apple apple apple apple')
  assert.equal(wrong.ok, false)
  assert.match(wrong.error!, /口令不对/)
  const good = await svc.open(r.link!, r.code!)
  assert.equal(good.ok, true)
  assert.equal(svc.take(good.token!), '两条信道')
})

await ok('纯口令：只需 6 个词 + 一个网址', async () => {
  const r = await svc.compose({ text: '口令即信箱', mode: 'code', ttlSeconds: 600 })
  assert.equal(r.ok, true)
  assert.equal(r.link, undefined)
  assert.equal(r.portal, 'https://relay.test/')
  const o = await svc.open(r.code!)
  assert.equal(o.ok, true)
  assert.equal(svc.take(o.token!), '口令即信箱')
  const miss = await svc.open('apple apple apple apple apple apple')
  assert.equal(miss.ok, false)
  assert.match(miss.error!, /抄错|焚毁|过期/)
})

await ok('链接被聊天软件截断时给出明确提示', async () => {
  const r = await svc.compose({ text: 'x', mode: 'link', ttlSeconds: 600 })
  const truncated = r.link!.split('#')[0]
  const o = await svc.open(truncated)
  assert.equal(o.ok, false)
  assert.match(o.error!, /链接不完整/)
})

await ok('未配置中继时写/读都有明确提示', async () => {
  const bare = new FlyService({ getSetting: () => '', setSetting: () => {}, fetchImpl })
  const r = await bare.compose({ text: 'x', mode: 'link', ttlSeconds: 60 })
  assert.equal(r.ok, false)
  assert.match(r.error!, /中继/)
  const o = await bare.open('apple apple apple apple apple apple')
  assert.equal(o.ok, false)
  assert.match(o.error!, /中继/)
})

await ok('中继返回错误信封时不泄露细节', async () => {
  const evil = new FlyService({
    getSetting: () => 'https://relay.test',
    setSetting: () => {},
    fetchImpl: (async () => new Response(JSON.stringify({ e: '{"app":"evil"}' }), { status: 200 })) as typeof fetch
  })
  const o = await evil.open('https://relay.test/r/' + 'a'.repeat(32) + '#k=' + 'A'.repeat(43))
  assert.equal(o.ok, false)
  assert.match(o.error!, /不是一封萤火密信/)
})

console.log('\n' + passed + ' service groups passed')
