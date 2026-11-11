// Hermetic mail regression tests: real worker + SQLite, in-memory IMAP, no user accounts.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const outfile = resolve('out/mail-selftest.cjs')
await build({
  entryPoints: ['scripts/mail-selftest.mts'], outfile, bundle: true, platform: 'node', format: 'cjs',
  alias: { '@shared': resolve('src/shared'), imapflow: resolve('scripts/restore-repro/imap-stub.cjs') },
  plugins: [{
    name: 'mail-test-runtime',
    setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mail-test' }))
      build.onLoad({ filter: /.*/, namespace: 'mail-test' }, () => ({ contents: `
        export const app = { getVersion: () => 'test' };
        export const safeStorage = {};
        export const shell = { openExternal: async () => {} };
      ` }))
      build.onResolve({ filter: /parse-pool$/ }, () => ({ path: resolve('scripts/restore-repro/parse-pool-stub.cjs') }))
    }
  }],
  logLevel: 'warning'
})
execFileSync(process.execPath, ['--no-warnings', outfile], { stdio: 'inherit' })
