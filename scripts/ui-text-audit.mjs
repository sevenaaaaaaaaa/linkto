#!/usr/bin/env node
/**
 * 文字预算审计：跑在已启动的应用上，用 CDP 逐元素量「文字有没有被容器吃掉」。
 *
 * 为什么要有它：这个项目的页面密度高，文案一长就会折行、被固定高度切掉，肉眼很难逐个页面查。
 * 规则只有两条，机器能判，不靠感觉：
 *   1) 直接装文字的盒子，如果 overflow 是 hidden/clip，又没有 line-clamp / ellipsis 兜底，
 *      而滚动高度大于可视高度 —— 就是被硬切（B 级证据：实测 scrollHeight > clientHeight）。
 *   2) 叶子文本块渲染超过 4 行且超过 80 字 —— 记为「密度告警」，摘要类卡片不该长成正文。
 *
 * 用法：
 *   1. 启动带调试口的应用：
 *        env -u ELECTRON_RUN_AS_NODE npx electron-vite dev --remoteDebuggingPort 9224
 *   2. npm run ui:audit            # 默认 1440 / 1280 / 960 三档
 *      npm run ui:audit -- --w 960 # 只测一档
 *   3. 退出码 0 = 无硬切；1 = 有硬切（会被 CI / 自己判红）
 *
 * 注意：应用主进程永远 loadFile(out/renderer/index.html)，所以改完渲染层要先 npm run build 再跑本审计。
 */
import { argv } from 'node:process'

const PORT = Number(process.env.UI_AUDIT_PORT ?? 9224)
const views = ['mail', 'todo', 'projects', 'agent', 'kb', 'insights', 'attachments', 'finance', 'life', 'feeds', 'trace']
const argW = argv.indexOf('--w')
const widths = argW > -1 ? [Number(argv[argW + 1])] : [1440, 1280, 960]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function pageTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  const list = await res.json()
  return list.find(t => t.type === 'page' && t.url.includes('index.html'))
}

/** 在页面里跑的检查：返回 { clipped, dense } */
const DETECT = () => {
  const clipped = []
  const dense = []
  const seen = new Set()
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue
    const rect = el.getBoundingClientRect()
    if (rect.width < 6 || rect.height < 6) continue
    if (rect.bottom < 0 || rect.top > innerHeight) continue
    const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).filter(Boolean).join(' ')
    if (!own) continue
    const key = el.tagName + '|' + own.slice(0, 24) + '|' + Math.round(rect.width)
    if (seen.has(key)) continue
    seen.add(key)

    const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none'
    const ellipsis = cs.textOverflow === 'ellipsis'
    const hardY = /(hidden|clip)/.test(cs.overflowY) && !clamp && !ellipsis && el.scrollHeight - el.clientHeight > 4
    const spillX = /visible/.test(cs.overflowX) && el.scrollWidth - el.clientWidth > 4
    if (hardY || spillX) {
      clipped.push({
        why: hardY ? 'hard-cut' : 'spill-x',
        txt: own.slice(0, 48),
        box: Math.round(rect.width) + 'x' + Math.round(rect.height),
        scrollH: el.scrollHeight,
        clientH: el.clientHeight,
        cls: String(el.className || '').slice(0, 60)
      })
      continue
    }

    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5
    const lines = rect.height / lh
    if (lines > 4 && own.length > 80) {
      dense.push({ txt: own.slice(0, 48), box: Math.round(rect.width) + 'x' + Math.round(rect.height), lines: Math.round(lines), chars: own.length })
    }
  }
  return { clipped, dense }
}

const main = async () => {
  let page = null
  for (let i = 0; i < 20 && !page; i++) {
    try { page = await pageTarget() } catch { /* 应用还没起来 */ }
    if (!page) await sleep(500)
  }
  if (!page) {
    console.error(`连不上 CDP（127.0.0.1:${PORT}）。先启动应用：env -u ELECTRON_RUN_AS_NODE npx electron-vite dev --remoteDebuggingPort ${PORT}`)
    process.exit(2)
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}) => new Promise(res => { const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params })) })
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    return r.result?.result?.value
  }

  let failures = 0
  let warnings = 0
  for (const w of widths) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: Math.round(w * 0.78), deviceScaleFactor: 1, mobile: false })
    await sleep(500)
    for (const v of views) {
      await evaluate(`location.hash = '#/${v}'`)
      await sleep(1000)
      const out = await evaluate(`(${DETECT.toString()})()`)
      if (!out) continue
      if (out.clipped.length) {
        failures += out.clipped.length
        console.log(`\n✗ ${v} @${w}  硬切 ${out.clipped.length} 处`)
        for (const c of out.clipped) console.log(`   [${c.why}] ${c.box} scrollH=${c.scrollH} clientH=${c.clientH} :: ${c.txt}`)
      }
      if (out.dense.length) {
        warnings += out.dense.length
        console.log(`\n! ${v} @${w}  密度告警 ${out.dense.length} 处（摘要里出现正文段落）`)
        for (const d of out.dense) console.log(`   ${d.chars}字 ${d.box} ${d.lines}行 :: ${d.txt}`)
      }
    }
  }

  await send('Emulation.clearDeviceMetricsOverride', {})
  await evaluate(`location.hash = '#/mail'`)
  ws.close()

  console.log(`\n结果：硬切 ${failures} 处，密度告警 ${warnings} 处（${widths.join('/')} 宽 × ${views.length} 个视图）`)
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(2) })
