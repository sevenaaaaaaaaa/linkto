import { seal, flyLink } from '../src/main/fly/core.ts'
import type { FlyMode } from '../src/main/fly/core.ts'

const mode = (process.argv[2] ?? 'link') as FlyMode
const text = process.argv[3] ?? '这是一封一次性密信。读完即焚，服务端只见过密文。'
const base = 'http://127.0.0.1:8787'
const sealed = seal(text, { mode, ttlSeconds: 900 })
const res = await fetch(base + '/api/v2/box', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ e: sealed.envelope, ttl: 900 })
})
if (!res.ok) throw new Error('post failed ' + res.status + ' ' + await res.text())
console.log(JSON.stringify({
  mode,
  link: mode === 'code' ? undefined : flyLink(base, sealed),
  code: sealed.code,
  portal: base + '/',
  mbox: sealed.mbox,
  text
}, null, 2))
