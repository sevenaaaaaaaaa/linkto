/**
 * LinkTo 萤火密信中继 v2 + 幽灵信中继 v1（兼容保留）
 *
 * 对外仍然伪装成一个普通的「笔记/待办同步 API」。v2 的变化：
 *  - 信箱号是每封信随机生成的 16B（32 hex），不是收件人公钥哈希：服务端无法把多封信
 *    关联到同一个人，也无法反查任何身份（没有身份可查）。
 *  - 只存密文信封，读后由客户端确认焚毁；同一信箱最多读取 8 次，超限即删。
 *  - 邮件正文在客户端按固定档位填充后加密，服务端连“信有多长”都只能看到档位。
 *  - / 与 /r/<id> 提供零安装的浏览器阅读页：密钥只存在于 URL fragment，永不发给服务端。
 *
 * 诚实边界：
 *  - Cloudflare KV 是最终一致的，「严格一次性」在跨 POP 并发读取时是尽力而为；
 *    需要强一致一次性可换 Durable Object（见 README）。
 *  - 阅读页 JS 由中继提供，因而中继运营方理论上可替换页面窃取 fragment 中的密钥。
 *    高敏感场景请用桌面端（客户端代码在本地，不经中继）。
 *  - 中继仍能看到访问时间、IP、密文大小档位；它看不到内容、收件人、发件人。
 */

export interface Env {
  BOX: KVNamespace
}

const V1_TTL_SECONDS = 72 * 3600
const V1_MAX_CONTENT = 128 * 1024
const V1_MAX_ITEMS = 32

const V2_MAX_ENVELOPE = 96 * 1024
const V2_MAX_ATTEMPTS = 8
const V2_MAX_TTL = 7 * 24 * 3600
const V2_MIN_TTL = 60

const FOLDER_RE = /^[0-9a-f]{16}$/
const MBOX_RE = /^[0-9a-f]{32}$/

interface ItemBody {
  client?: string
  v?: number
  item?: { id?: string; folder?: string; content?: string; meta?: Record<string, unknown> }
}

interface BoxBody {
  e?: unknown
  ttl?: unknown
}

interface StoredBox {
  e: string
  n: number
  exp: number
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  })
}

// ---------------------------------------------------------------------------
// v2：随机信箱 · 读后即焚
// ---------------------------------------------------------------------------

async function putBox(req: Request, env: Env): Promise<Response> {
  let body: BoxBody
  try {
    body = (await req.json()) as BoxBody
  } catch {
    return json({ error: 'bad json' }, 400)
  }
  const e = typeof body.e === 'string' ? body.e : ''
  if (!e || e.length > V2_MAX_ENVELOPE) return json({ error: 'bad envelope' }, 400)

  let h: { app?: unknown; v?: unknown; mb?: unknown; iat?: unknown; ttl?: unknown }
  try {
    h = JSON.parse(e)
  } catch {
    return json({ error: 'bad envelope' }, 400)
  }
  if (h.app !== 'linkto-fly' || h.v !== 2 || typeof h.mb !== 'string' || !MBOX_RE.test(h.mb)) {
    return json({ error: 'bad envelope' }, 400)
  }

  const ttl = Math.max(V2_MIN_TTL, Math.min(V2_MAX_TTL, Math.floor(Number(body.ttl) || 0)))
  const exp = Date.now() + ttl * 1000
  const key = 'v2:' + h.mb
  if (await env.BOX.get(key)) return json({ error: 'exists' }, 409)

  const stored: StoredBox = { e, n: 0, exp }
  // 多留 5 分钟给已发出的读取请求；到点自动删
  await env.BOX.put(key, JSON.stringify(stored), { expirationTtl: Math.min(ttl + 300, V2_MAX_TTL + 300) })
  return json({ ok: true, rev: Math.random().toString(36).slice(2, 10) })
}

async function getBox(id: string, env: Env): Promise<Response> {
  if (!MBOX_RE.test(id)) return json({ error: 'bad id' }, 400)
  const key = 'v2:' + id
  const raw = await env.BOX.get(key)
  if (!raw) return json({ error: 'gone' }, 404)

  let stored: StoredBox
  try {
    stored = JSON.parse(raw) as StoredBox
  } catch {
    await env.BOX.delete(key)
    return json({ error: 'gone' }, 404)
  }
  if (!stored || typeof stored.e !== 'string') {
    await env.BOX.delete(key)
    return json({ error: 'gone' }, 404)
  }
  if (stored.exp <= Date.now()) {
    await env.BOX.delete(key)
    return json({ error: 'gone' }, 404)
  }
  if (stored.n >= V2_MAX_ATTEMPTS) {
    await env.BOX.delete(key)
    return json({ error: 'gone' }, 410)
  }

  const next: StoredBox = { ...stored, n: stored.n + 1 }
  const remaining = Math.max(60, Math.ceil((stored.exp - Date.now()) / 1000) + 300)
  await env.BOX.put(key, JSON.stringify(next), { expirationTtl: Math.min(remaining, V2_MAX_TTL + 300) })
  return json({ e: stored.e })
}

async function burnBox(id: string, env: Env): Promise<Response> {
  if (!MBOX_RE.test(id)) return json({ error: 'bad id' }, 400)
  await env.BOX.delete('v2:' + id)
  return json({ ok: true })
}

// ---------------------------------------------------------------------------
// 浏览器阅读页（零安装）：密钥只在 fragment，永不进入请求
// ---------------------------------------------------------------------------

/** 阅读页构建版本；页面、/api/v2/meta 与发布说明里的值必须一致 */
export const READER_VERSION = '2.0.0'

/** 页面里显示哈希的位置先用占位符，计算哈希时再替换 —— 避免“哈希包含自身” */
export const READER_HASH_PLACEHOLDER = '__FLY_READER_HASH__'

export interface ReaderDigest {
  version: string
  sha256: string
  /** 规范化后的页面字节数（不含被替换进来的哈希本身） */
  bytes: number
}

/**
 * 把页面里显示的 64 位十六进制哈希还原成占位符。
 * 这样“仓库里的源码”和“浏览器另存下来的页面”会得到同一个哈希。
 */
export function canonicalReaderHtml(html: string): string {
  return html.replace(/(<code id="reader-hash">)[0-9a-f]{64}(<\/code>)/, '$1' + READER_HASH_PLACEHOLDER + '$2')
}

let readerDigestPromise: Promise<ReaderDigest> | null = null

/** 阅读页源码哈希（SHA-256）。同一份源码在任何中继部署上应得到同一个值。 */
export function readerDigest(): Promise<ReaderDigest> {
  if (!readerDigestPromise) {
    readerDigestPromise = (async () => {
      const canonical = canonicalReaderHtml(readerPage())
      const bytes = new TextEncoder().encode(canonical)
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
      return { version: READER_VERSION, sha256, bytes: bytes.length }
    })()
  }
  return readerDigestPromise
}

/** 返回实际要发出的页面 + 对应的哈希；页面里显示哈希，便于与发布说明核对。 */
export async function readerDocument(): Promise<{ html: string; digest: ReaderDigest }> {
  const digest = await readerDigest()
  return { html: readerPage().replace(READER_HASH_PLACEHOLDER, digest.sha256), digest }
}

export function readerPage(): string {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>一次性密信</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: #0c1110; color: #e8ece9;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .card {
    width: min(620px, 100%); background: #121918; border: 1px solid rgba(255,255,255,.08);
    border-radius: 20px; padding: 28px; box-shadow: 0 24px 80px rgba(0,0,0,.5);
  }
  .brand { display: flex; align-items: center; gap: 8px; font-size: 12px; letter-spacing: .12em; color: #7f8c86; text-transform: uppercase; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #9fe870; box-shadow: 0 0 12px #9fe870; }
  h1 { font-size: 22px; margin: 18px 0 6px; font-weight: 600; letter-spacing: -.01em; }
  p.sub { margin: 0 0 22px; color: #93a09a; font-size: 13px; }
  label { display: block; font-size: 12px; color: #93a09a; margin-bottom: 8px; }
  input {
    width: 100%; padding: 13px 14px; font-size: 16px; color: #eef2ef; background: #0b100f;
    border: 1px solid rgba(255,255,255,.12); border-radius: 12px; outline: none; letter-spacing: .04em;
  }
  input:focus { border-color: #6f8f7f; }
  button {
    width: 100%; margin-top: 14px; padding: 13px 16px; font-size: 15px; font-weight: 600;
    color: #0c1110; background: #d8e6dc; border: 0; border-radius: 12px; cursor: pointer;
  }
  button:disabled { opacity: .45; cursor: default; }
  .note { margin-top: 16px; font-size: 11.5px; line-height: 1.7; color: #6f7b76; }
  .status { margin-top: 14px; font-size: 12.5px; color: #e6a6a0; min-height: 18px; }
  .status.ok { color: #9fe870; }
  pre {
    margin: 20px 0 0; padding: 18px; background: #0b100f; border: 1px solid rgba(255,255,255,.08);
    border-radius: 12px; white-space: pre-wrap; word-break: break-word; font-size: 15px; line-height: 1.85;
    max-height: 62vh; overflow: auto; user-select: none;
  }
  .burned { margin-top: 16px; font-size: 12px; color: #9fe870; }
  .hidden { display: none !important; }
  .foot { margin-top: 22px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,.07); font-size: 11px; color: #5f6b66; line-height: 1.8; }
  .build { margin-top: 8px; }
  .build code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; color: #9fe870; word-break: break-all; user-select: text; }
  .hash-btn {
    width: auto; display: inline-block; margin: 6px 0 0; padding: 2px 7px; border-radius: 6px;
    border: 1px solid rgba(255,255,255,.14); background: transparent; color: #93a09a; font-size: 10px; cursor: pointer;
  }
  .hash-btn:hover { background: rgba(255,255,255,.06); }
  @media (prefers-reduced-motion: no-preference) { .card { animation: in .28s cubic-bezier(.32,.72,0,1); } }
  @keyframes in { from { opacity: 0; transform: translateY(8px) scale(.99); } }
</style>
</head>
<body>
<main class="card">
  <div class="brand"><span class="dot"></span> LinkTo · 萤火密信</div>
  <h1 id="title">这是一封一次性密信</h1>
  <p class="sub" id="sub">读完即焚。服务端只保存密文，且只能被读取一次。</p>

  <div id="form">
    <label for="code" id="codeLabel">6 词口令（口头或当面传来）</label>
    <input id="code" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="apple river stone …">
    <button id="open">打开并焚毁</button>
  </div>

  <div class="status" id="status"></div>
  <pre id="out" class="hidden"></pre>
  <div id="burned" class="burned hidden">密文已在服务端删除。本页关闭后不可再看。</div>

  <div class="note" id="note">密钥只在你的浏览器里使用，不会随请求发送到服务器。</div>
  <div class="foot">
    本页由中继直接提供。若你不信任该中继，请改用 LinkTo 桌面端打开同一条链接——客户端代码在本地，不经中继。
    <div class="build">
      reader <span id="reader-version">${READER_VERSION}</span> · sha256
      <code id="reader-hash">${READER_HASH_PLACEHOLDER}</code>
      <button id="copy-hash" class="hash-btn" type="button">复制哈希</button>
    </div>
    <div class="build">把上面的 sha256 与发布说明里的值对比；不一致就不要输入口令。</div>
  </div>
</main>
<script>
(function () {
  'use strict'
  var APP = 'linkto-fly', VER = 2, ITER = 600000
  var FIXED_SALT = new TextEncoder().encode('linkto-fly/code/v2')
  var MBOX_LABEL = new TextEncoder().encode('linkto-fly/mbox/v2')
  var params = new URLSearchParams(location.hash.slice(1))
  var keyB64 = params.get('k')
  var parts = location.pathname.split('/').filter(Boolean)
  var id = (parts[0] === 'r' && parts[1]) ? parts[1] : null
  var cached = null
  var busy = false

  var $ = function (s) { return document.querySelector(s) }
  var statusEl = $('#status'), outEl = $('#out'), burnedEl = $('#burned'), formEl = $('#form')

  function setStatus(msg, ok) {
    statusEl.textContent = msg || ''
    statusEl.className = 'status' + (ok ? ' ok' : '')
  }

  function b64ToBytes(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/')
    while (s.length % 4) s += '='
    var bin = atob(s)
    var out = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0') }).join('')
  }
  function norm(s) {
    return (s || '').normalize('NFKC').toLowerCase().trim().split(/[\s\-_,，、.;；:：/|]+/).filter(Boolean).join(' ')
  }
  async function deriveKey(code, salt) {
    var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(norm(code)), 'PBKDF2', false, ['deriveBits'])
    var bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: ITER, hash: 'SHA-256' }, base, 256)
    return new Uint8Array(bits)
  }
  async function mboxFor(key) {
    var k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return hex(await crypto.subtle.sign('HMAC', k, MBOX_LABEL)).slice(0, 32)
  }
  function aad(h) {
    return new TextEncoder().encode([APP, String(VER), h.m, h.mb, h.s || '', String(h.iat), String(h.ttl)].join('|'))
  }
  async function decrypt(envJson, key) {
    var h = JSON.parse(envJson)
    if (h.app !== APP || h.v !== VER) throw new Error('bad envelope')
    var ct = b64ToBytes(h.c), tag = b64ToBytes(h.t)
    var both = new Uint8Array(ct.length + tag.length)
    both.set(ct, 0); both.set(tag, ct.length)
    var k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(h.i), additionalData: aad(h), tagLength: 128 }, k, both)
    var payload = JSON.parse(new TextDecoder().decode(pt))
    if (typeof payload.t !== 'string' || typeof payload.exp !== 'number') throw new Error('bad payload')
    if (payload.exp <= Date.now()) throw new Error('expired')
    return payload.t
  }
  async function fetchBox(mbox) {
    var res = await fetch('/api/v2/box/' + mbox, { headers: { accept: 'application/json' } })
    if (res.status === 404 || res.status === 410) throw new Error('gone')
    if (!res.ok) throw new Error('http ' + res.status)
    var data = await res.json()
    if (typeof data.e !== 'string') throw new Error('bad response')
    return data.e
  }
  async function burn(mbox) {
    try {
      var res = await fetch('/api/v2/box/' + mbox, { method: 'DELETE' })
      return !!res.ok
    } catch (e) {
      return false // TTL 兜底
    }
  }

  function showText(text, burned) {
    formEl.classList.add('hidden')
    outEl.textContent = text
    outEl.classList.remove('hidden')
    burnedEl.classList.remove('hidden')
    $('#title').textContent = '密信已打开'
    $('#sub').textContent = '以下内容只存在于本页内存。'
    if (burned) {
      setStatus('已读 · 服务端密文已焚毁', true)
      burnedEl.textContent = '密文已在服务端删除。本页关闭后不可再看。'
    } else {
      setStatus('已读 · 焚毁未确认，将按有效期自动删除', true)
      burnedEl.textContent = '服务端焚毁未确认。密文仍受有效期约束，到期自动删除。'
    }
    if (location.hash) history.replaceState(null, '', location.pathname)
  }

  async function run() {
    if (busy) return
    var codeEl = document.getElementById('code')
    var code = codeEl ? codeEl.value : ''
    var needCode = !keyB64
    if (needCode && norm(code).split(' ').filter(Boolean).length !== 6) {
      setStatus('口令是 6 个词，用空格分开')
      return
    }
    busy = true
    $('#open').disabled = true
    setStatus(needCode ? '派生密钥中…（约 0.3 秒）' : '读取中…')
    try {
      var mbox = id, key = null, env = cached, derived = false
      if (needCode && !mbox) {
        key = await deriveKey(code, FIXED_SALT)
        mbox = await mboxFor(key)
        derived = true
      }
      if (!mbox || !/^[0-9a-f]{32}$/.test(mbox)) throw new Error('bad id')
      if (!env) {
        env = await fetchBox(mbox)
        cached = env
      }
      if (!keyB64) {
        var h = JSON.parse(env)
        if (!(derived && !h.s)) key = await deriveKey(code, h.s ? b64ToBytes(h.s) : FIXED_SALT)
      } else {
        key = b64ToBytes(keyB64)
      }
      var text = await decrypt(env, key)
      var burned = await burn(mbox)
      showText(text, burned)
      key = null; keyB64 = null; cached = null
    } catch (err) {
      var msg = String(err && err.message || err)
      if (msg === 'gone') setStatus('这封密信不存在、已被读取焚毁，或已过期')
      else if (msg === 'expired') setStatus('这封密信已过期')
      else if (!needCode) setStatus('密文校验失败：链接可能被改动过')
      else setStatus('口令不对，请检查 6 个词后重试（密信尚未焚毁）')
      keyB64 = params.get('k')
    } finally {
      busy = false
      $('#open').disabled = false
    }
  }

  if (!keyB64 && !id) {
    $('#sub').textContent = '输入发送方口头告你的 6 个词。口令同时决定信箱与密钥，服务端无法反查。'
  } else if (keyB64) {
    $('#code').classList.add('hidden')
    $('#codeLabel').classList.add('hidden')
    $('#sub').textContent = '链接里已带密钥。点击打开后，服务端密文立即焚毁。'
  } else {
    $('#sub').textContent = '这封信需要链接 + 6 词口令两条信道同时具备。'
  }
  $('#open').addEventListener('click', run)
  var codeInput = document.getElementById('code')
  if (codeInput) codeInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') run() })
  document.addEventListener('copy', function (e) { e.preventDefault() })
  document.addEventListener('cut', function (e) { e.preventDefault() })
  document.addEventListener('contextmenu', function (e) { e.preventDefault() })
  var copyHashBtn = document.getElementById('copy-hash')
  if (copyHashBtn) copyHashBtn.addEventListener('click', function () {
    var el = document.getElementById('reader-hash')
    var h = el ? el.textContent : ''
    if (h && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(h).then(function () {
        copyHashBtn.textContent = '已复制'
      }, function () {})
    }
  })
})()
</script>
</body>
</html>`
}

function htmlResponse(html: string, digest: ReaderDigest): Response {
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'x-fly-reader-version': digest.version,
      'x-fly-reader-sha256': digest.sha256,
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  })
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    // ---- v2 ----
    if (req.method === 'POST' && path === '/api/v2/box') return putBox(req, env)
    if (req.method === 'GET' && path.startsWith('/api/v2/box/')) return getBox(path.slice('/api/v2/box/'.length), env)
    if (req.method === 'DELETE' && path.startsWith('/api/v2/box/')) return burnBox(path.slice('/api/v2/box/'.length), env)

    /** 阅读页版本 / 哈希：供应用、发布脚本与用户核对（不含任何秘密） */
    if (req.method === 'GET' && path === '/api/v2/meta') {
      return json({ app: 'linkto-fly', v: 2, reader: await readerDigest() })
    }

    if (req.method === 'GET' && (path === '/' || path === '/r' || /^\/r\/[0-9a-f]{32}$/.test(path))) {
      const { html, digest } = await readerDocument()
      return htmlResponse(html, digest)
    }

    // ---- v1（兼容：旧版幽灵信信封） ----
    if (req.method === 'POST' && path === '/api/v1/items') {
      let body: ItemBody
      try {
        body = (await req.json()) as ItemBody
      } catch {
        return json({ error: 'bad json' }, 400)
      }
      const folder = body.item?.folder ?? ''
      const content = body.item?.content ?? ''
      if (!FOLDER_RE.test(folder)) return json({ error: 'bad folder' }, 400)
      if (!content || content.length > V1_MAX_CONTENT) return json({ error: 'bad content' }, 400)
      const existing = (await env.BOX.get(folder)) ?? ''
      const parts = existing ? existing.split('\u0000') : []
      if (parts.length >= V1_MAX_ITEMS) return json({ error: 'full' }, 429)
      parts.push(content)
      await env.BOX.put(folder, parts.join('\u0000'), { expirationTtl: V1_TTL_SECONDS })
      return json({ ok: true, item: { id: body.item?.id, rev: Math.random().toString(36).slice(2, 10) } })
    }

    if (req.method === 'GET' && path === '/api/v1/items') {
      const folder = url.searchParams.get('folder') ?? ''
      if (!FOLDER_RE.test(folder)) return json({ error: 'bad folder' }, 400)
      const raw = await env.BOX.get(folder)
      if (!raw) return json({ ok: true, items: [] })
      await env.BOX.delete(folder)
      return json({ ok: true, items: raw.split('\u0000').map(content => ({ content, read_at: Date.now() })) })
    }

    return json({ error: 'not found' }, 404)
  }
}
