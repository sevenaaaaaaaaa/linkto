#!/usr/bin/env node
/** 模拟点击刷新列表 → 选中邮件 → 截图列表和阅读窗 */
const PORT = 9224
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fs = require('node:fs')

async function getTargets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
}

async function cdpEval(expression, waitMs = 1200) {
  const pages = (await getTargets()).filter(t => t.type === 'page' && t.url.includes('index.html'))
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let result
  ws.onmessage = ev => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}')
    if (msg.id === 1) result = msg.result?.result?.value
  }
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  await sleep(waitMs)
  ws.close()
  return result
}

async function shot(out) {
  const pages = (await getTargets()).filter(t => t.type === 'page' && t.url.includes('index.html'))
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let data
  let step = 0
  ws.onmessage = ev => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}')
    if (msg.id === 2) data = msg.result?.data
  }
  ws.send(JSON.stringify({ id: 1, method: 'Page.bringToFront', params: {} }))
  await sleep(300)
  ws.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: { format: 'png' } }))
  await sleep(1500)
  ws.close()
  fs.writeFileSync(out, Buffer.from(data, 'base64'))
  console.log('saved', out)
}

const main = async () => {
  // 点击侧栏「统一收件箱」触发重新加载
  console.log('click inbox:', await cdpEval(`(() => {
    const btns = [...document.querySelectorAll('button')]
    const inbox = btns.find(b => b.textContent.includes('统一收件箱'))
    inbox?.click()
    return !!inbox
  })()`))
  await shot('/tmp/ms-list.png')

  // 点击第一封邮件
  console.log('click mail:', await cdpEval(`(() => {
    const rows = [...document.querySelectorAll('.flex-1.overflow-y-auto > div')].filter(r => r.textContent.includes('王小明'))
    rows[0]?.click()
    return rows.length
  })()`, 2000))
  await shot('/tmp/ms-reader.png')

  // 搜索测试
  console.log('search:', await cdpEval(`(() => {
    const input = document.querySelector('input[placeholder="搜索邮件"]')
    if (!input) return 'no input'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '推广')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return 'ok'
  })()`, 2000))
  await shot('/tmp/ms-search.png')
  process.exit(0)
}
main()
