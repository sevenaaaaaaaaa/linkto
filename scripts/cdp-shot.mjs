#!/usr/bin/env node
/**
 * 启动应用（远程调试端口）→ 等待窗口 → CDP 截图 → 退出
 * 用法: node scripts/cdp-shot.mjs out.png [settings]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'

const OUT = process.argv[2] ?? '/tmp/mailstudio.png'
const ROUTE = process.argv[3] ?? '' // 'settings' 打开设置窗口
const PORT = 9223

const userData = mkdtempSync(join(tmpdir(), 'ms-shot-'))
const appDir = new URL('..', import.meta.url).pathname

const child = spawn(
  join(appDir, 'node_modules/.bin/electron'),
  [appDir, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MAILSTUDIO_SHOT: '1' } }
)
child.stderr.on('data', d => process.stderr.write(d))

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

async function main() {
  // 等 CDP 端口就绪
  let targets = []
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      targets = await getTargets()
      if (targets.some(t => t.type === 'page')) break
    } catch { /* not ready */ }
  }
  const pages = targets.filter(t => t.type === 'page')
  if (!pages.length) {
    console.error('no page targets found')
    child.kill()
    process.exit(1)
  }
  // 若打开设置窗口，触发它
  if (ROUTE === 'settings') {
    const main = pages.find(p => p.url.includes('index.html'))
    if (main) {
      await cdp(main.webSocketDebuggerUrl, [
        { method: 'Runtime.evaluate', params: { expression: 'window.api.openSettings()' } }
      ])
      await sleep(2500)
    }
  }
  const shotTargets = (await getTargets()).filter(t => t.type === 'page')
  let n = 0
  for (const t of shotTargets) {
    const name = shotTargets.length > 1 ? `${OUT.replace(/\.png$/, '')}-${++n}.png` : OUT
    const dataURL = await cdp(t.webSocketDebuggerUrl, [
      { method: 'Page.bringToFront', params: {} },
      { method: 'Page.captureScreenshot', params: { format: 'png' } }
    ])
    const shot = dataURL.find(r => r.result?.data)?.result.data
    if (shot) {
      writeFileSync(name, Buffer.from(shot, 'base64'))
      console.error(`saved ${name} (${t.url.slice(0, 60)})`)
    }
  }
  child.kill()
  rmSync(userData, { recursive: true, force: true })
  process.exit(0)
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
    await sleep(400)
  }
  await sleep(600)
  ws.close()
  return replies
}

main().catch(err => {
  console.error(err)
  child.kill()
  process.exit(1)
})
