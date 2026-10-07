#!/usr/bin/env node
/** 检查渲染进程控制台错误与 DOM 状态 */
const PORT = 9224
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getTargets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
}

const main = async () => {
  const pages = (await getTargets()).filter(t => t.type === 'page')
  const wsUrl = pages[0]?.webSocketDebuggerUrl
  if (!wsUrl) return console.error('no page')
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const logs = []
  ws.onmessage = ev => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}')
    if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown' || msg.method === 'Log.entryAdded') {
      logs.push(JSON.stringify(msg.params).slice(0, 500))
    }
  }
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable', params: {} }))
  ws.send(JSON.stringify({ id: 2, method: 'Log.enable', params: {} }))
  await sleep(1500)
  ws.send(JSON.stringify({
    id: 3,
    method: 'Runtime.evaluate',
    params: { expression: `JSON.stringify({root: document.getElementById('root')?.innerHTML.length ?? -1, scripts: document.scripts.length, title: document.title})` }
  }))
  await sleep(1200)
  console.log('--- console/exceptions ---')
  for (const l of logs.slice(0, 12)) console.log(l)
  process.exit(0)
}
main()
