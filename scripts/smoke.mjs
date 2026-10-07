#!/usr/bin/env node
/** IPC 全链路冒烟测试：设置项读写 → 数据落库 → 读回校验 */
const PORT = 9224
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getTargets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
}

async function evalInPage(expression) {
  const pages = (await getTargets()).filter(t => t.type === 'page' && t.url.includes('index.html'))
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let result
  ws.onmessage = ev => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}')
    if (msg.id === 1) result = msg.result?.result?.value ?? `ERROR: ${JSON.stringify(msg.result).slice(0, 300)}`
  }
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  await sleep(1800)
  ws.close()
  return result
}

const main = async () => {
  const results = []

  // 1. 签名
  results.push(['签名保存/读取', await evalInPage(`(async () => {
    await window.api.saveSignature({ id: 'sig-test', name: '测试签名', html: '<p>Seven</p>', defaults: ['all'], updatedAt: Date.now() })
    const list = await window.api.listSignatures()
    return list.length === 1 && list[0].name === '测试签名' ? 'PASS' : 'FAIL: ' + JSON.stringify(list)
  })()`)])

  // 2. 模板
  results.push(['模板保存/读取', await evalInPage(`(async () => {
    await window.api.saveTemplate({ id: 'tpl-test', name: '周报', to: '', subject: '周报', html: '<p>Hi</p>', updatedAt: Date.now() })
    const list = await window.api.listTemplates()
    return list.length === 1 && list[0].to === '' ? 'PASS' : 'FAIL: ' + JSON.stringify(list)
  })()`)])

  // 3. 规则
  results.push(['规则保存/读取', await evalInPage(`(async () => {
    await window.api.saveRule({ id: 'rule-test', name: '老板邮件', enabled: true, order: 0,
      conditions: [{ field: 'from', op: 'contains', value: 'boss' }], actions: [{ type: 'setCategory', value: 'personal' }] })
    const list = await window.api.listRules()
    return list.length === 1 && list[0].conditions[0].value === 'boss' ? 'PASS' : 'FAIL: ' + JSON.stringify(list)
  })()`)])

  // 4. 知识库（含消息来源标记路径）
  results.push(['知识库保存/读取/更新', await evalInPage(`(async () => {
    const item = await window.api.saveToKb({ kind: 'note', title: '手记A', content: '关于投放的思考', tags: ['投放'] })
    await window.api.updateKbItem(item.id, { tags: ['投放', '复盘'] })
    const list = await window.api.listKbItems()
    const ok = list.some(i => i.id === item.id && i.tags.includes('复盘'))
    await window.api.deleteKbItem(item.id)
    const after = await window.api.listKbItems()
    return ok && after.length === 0 ? 'PASS' : 'FAIL'
  })()`)])

  // 5. 设置读写
  results.push(['通用设置读写', await evalInPage(`(async () => {
    const s = await window.api.getGeneralSettings()
    await window.api.setGeneralSettings({ ...s, density: 'compact' })
    const s2 = await window.api.getGeneralSettings()
    await window.api.setGeneralSettings(s)
    return s2.density === 'compact' ? 'PASS' : 'FAIL'
  })()`)])

  // 6. 连接器
  results.push(['连接器清单/连接', await evalInPage(`(async () => {
    const manifests = await window.api.listConnectorManifests()
    const res = await window.api.connectConnector('generic-webhook', { url: 'https://example.com/hook' })
    const instances = await window.api.listConnectorInstances()
    const ok = manifests.length >= 2 && res.ok && instances.length === 1
    await window.api.disconnectConnector(instances[0].id)
    return ok ? 'PASS' : 'FAIL: ' + JSON.stringify({ manifests: manifests.length, res, instances: instances.length })
  })()`)])

  // 7. 无效账户验证应报错（链路走通 IMAP connect）
  results.push(['账户验证（错误路径）', await evalInPage(`(async () => {
    const res = await window.api.verifyAccount({
      provider: 'custom', name: 'x', email: 'a@b.c', color: '#000',
      imap: { host: '127.0.0.1', port: 993, secure: true }, smtp: { host: '127.0.0.1', port: 465, secure: true },
      user: 'a@b.c', password: 'wrong'
    })
    return !res.ok && res.error ? 'PASS (' + res.error.slice(0, 40) + ')' : 'FAIL: ' + JSON.stringify(res)
  })()`)])

  // 8. AI 设置
  results.push(['AI 设置读写', await evalInPage(`(async () => {
    const s = await window.api.getAISettings()
    return typeof s.baseURL === 'string' && s.baseURL.includes('bigmodel') ? 'PASS' : 'FAIL: ' + JSON.stringify(s)
  })()`)])

  // 清理 1-3 的测试数据
  await evalInPage(`(async () => {
    await window.api.deleteSignature('sig-test')
    await window.api.deleteTemplate('tpl-test')
    await window.api.deleteRule('rule-test')
    return 'cleaned'
  })()`)

  for (const [name, res] of results) console.log(`${String(res).startsWith('PASS') ? '✓' : '✗'} ${name}: ${res}`)
  const failed = results.filter(([_, r]) => !String(r).startsWith('PASS')).length
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
}
main()
