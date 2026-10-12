// 打包 entry2.ts 为单文件后在系统 Node 下运行
const esbuild = require('esbuild')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const here = __dirname
const src = path.join(here, '..', '..')

const outfile = '/tmp/linkto-repro-bundle2.cjs'

async function main() {
  await esbuild.build({
    entryPoints: [path.join(here, 'entry2.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: 'inline',
    alias: {
      '@shared': path.join(src, 'src/shared'),
      electron: path.join(here, 'electron-stub.cjs'),
      imapflow: path.join(here, 'imap-stub.cjs')
    },
    plugins: [
      {
        name: 'stub-parse-pool',
        setup(build) {
          build.onResolve({ filter: /parse-pool$/ }, args => ({ path: path.join(here, 'parse-pool-stub.cjs') }))
        }
      }
    ]
  })
  execFileSync(process.execPath, [outfile], { stdio: 'inherit', env: process.env })
}

main().catch(err => {
  console.error('BUNDLE/RUN FAIL:', err.message)
  process.exit(2)
})