#!/usr/bin/env node
/**
 * 终端启动器：列出并选择 LinkTo / Litmus / LinkTo 开发版。
 *
 *   linkto                交互选择
 *   linkto list           列出
 *   linkto linkto         直接启动安装版 LinkTo
 *   linkto litmus         直接启动 Litmus
 *   linkto dev            启动当前仓库的开发版（需要先 npm run build）
 *
 * 想在任何目录直接运行：在仓库里执行一次 npm link。
 */
import { existsSync } from 'node:fs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function versionOf(appPath) {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

function discover() {
  const apps = []
  const add = (id, name, path) => {
    if (!existsSync(path)) return
    apps.push({ id, name, path, kind: 'app', version: versionOf(path) })
  }
  add('linkto', 'LinkTo（安装版）', '/Applications/LinkTo.app')
  add('linkto-home', 'LinkTo（用户目录安装）', join(process.env.HOME ?? '', 'Applications', 'LinkTo.app'))
  add('litmus', 'Litmus（安装版）', '/Applications/Litmus.app')
  if (existsSync(join(repo, 'out', 'main', 'index.js'))) {
    apps.push({ id: 'dev', name: 'LinkTo（开发版 · 当前仓库）', path: repo, kind: 'dev', version: '' })
  }
  return apps
}

function printList(apps) {
  console.log('可用应用：')
  apps.forEach((a, i) => {
    const ver = a.version ? ' · v' + a.version : ''
    console.log('  ' + (i + 1) + ') ' + a.name + ver + (a.kind === 'dev' ? '' : '  ' + a.path))
  })
}

function launch(app) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  if (app.kind === 'dev') {
    const electron = join(repo, 'node_modules', '.bin', 'electron')
    if (!existsSync(electron)) throw new Error('没有 node_modules/.bin/electron；先在仓库执行 npm install')
    const child = spawn(electron, ['.'], { cwd: repo, env, detached: true, stdio: 'ignore' })
    child.unref()
    return
  }
  const opened = spawnSync('/usr/bin/open', ['-a', app.path], { env, stdio: 'ignore' })
  if (opened.status === 0) return
  // open -a 在少数环境下会静默失败：退回直接启动 bundle 里的可执行文件
  const exe = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(app.path, 'Contents', 'Info.plist')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
  const child = spawn(join(app.path, 'Contents', 'MacOS', exe), [], { env, detached: true, stdio: 'ignore' })
  child.unref()
}

async function choose(apps) {
  if (!process.stdin.isTTY) {
    printList(apps)
    return null
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    printList(apps)
    const answer = (await rl.question('\n选择应用 [1-' + apps.length + ']（回车取消）：')).trim()
    if (!answer) return null
    const byIndex = /^[0-9]+$/.test(answer) ? apps[Number(answer) - 1] : undefined
    return byIndex ?? apps.find(a => a.id === answer || a.name.includes(answer)) ?? null
  } finally {
    rl.close()
  }
}

const args = process.argv.slice(2)
if (args[0] === '--help' || args[0] === '-h') {
  console.log('用法：linkto [list|linkto|litmus|dev]')
  console.log('  linkto            交互选择')
  console.log('  linkto list       列出可用应用')
  console.log('  linkto linkto     启动安装版 LinkTo')
  console.log('  linkto litmus     启动 Litmus')
  console.log('  linkto dev        启动当前仓库的开发版')
  process.exit(0)
}

const apps = discover()
if (!apps.length) {
  console.error('没有找到 LinkTo 或 Litmus。')
  process.exit(1)
}
if (args[0] === 'list' || args[0] === 'ls') {
  printList(apps)
  process.exit(0)
}

let target = null
const query = args[0] === 'open' ? (args[1] ?? '') : (args[0] ?? '')
if (query) {
  target = apps.find(a => a.id === query || a.name.includes(query)) ?? null
} else {
  target = await choose(apps)
}
if (!target) {
  console.error('没有选择应用。')
  process.exit(1)
}
try {
  launch(target)
  console.log('已启动：' + target.name)
} catch (err) {
  console.error('启动失败：' + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
}
