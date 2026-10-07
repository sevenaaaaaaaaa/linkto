#!/usr/bin/env node
/**
 * 对已启动的应用（--remote-debugging-port=9224）做 CDP 截图
 * 用法: node scripts/cdp-shot-only.mjs /tmp/out.png [settings]
 */
import { writeFileSync } from 'node:fs'

const OUT = process.argv[2] ?? '/tmp/mailstudio.png'
const ROUTE = process.argv[3] ?? ''
const PORT = 9224

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

async function cdp(wsUrl, commands) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const replies = []
  let id = 0
  ws.onmessage = ev => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
    if (msg.id) replies.push(msg)
  }
  for (const cmd of commands) {
    ws.send(JSON.stringify({ id: ++id, ...cmd }))
    await sleep(500)
  }
  await sleep(800)
  ws.close()
  return replies
}

const sleepMs = n => new Promise(r => setTimeout(r, n))

const main = async () => {
  let targets = []
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    try {
      targets = await getTargets()
      if (targets.some(t => t.type === 'page')) break
    } catch { /* retry */ }
  }
  const pages = targets.filter(t => t.type === 'page')
  if (!pages.length) {
    console.error('no page targets')
    process.exit(1)
  }
  if (ROUTE === 'settings') {
    const main = pages.find(p => p.url.includes('index.html'))
    if (main) {
      await cdp(main.webSocketDebuggerUrl, [
        { method: 'Runtime.evaluate', params: { expression: 'window.api.openSettings()' } }
      ])
      await sleep(2000)
    }
  }
  const shotTargets = (await getTargets()).filter(t => t.type === 'page')
  let n = 0
  for (const t of shotTargets) {
    const name = shotTargets.length > 1 ? OUT.replace(/\.png$/, `-${++n}.png`) : OUT
    const replies = await cdp(t.webSocketDebuggerUrl, [
      { method: 'Page.bringToFront', params: {} },
      { method: 'Page.captureScreenshot', params: { format: 'png' } }
    ])
    const data = replies.find(r => r.result?.data)?.result.data
    if (data) {
      writeFileSync(name, Buffer.from(data, 'base64'))
      console.error(`saved ${name} <- ${t.url.slice(0, 70)}`)
    }
  }
  process.exit(0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
