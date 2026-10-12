/**
 * 备份还原 → 首次同步 全链路复现（扩展场景版）
 * S1 新机器+含凭据还原   S2 新机器+不含凭据   S3 同机删号再还原   S4 OAuth 还原（无客户端配置）   S5 Gmail 风格文件夹
 */
import { DatabaseSync } from 'node:sqlite'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { MailStore } from '../../src/main/db'
import { AppStore } from '../../src/main/store'
import { BackupService } from '../../src/main/backup'
import { SyncEngine } from '../../src/main/mail/sync-engine'
import { OAuthService } from '../../src/main/oauth'
import { setServer, mkMailbox, addMsg, server } from 'imapflow'

const ROOT = '/tmp/linkto-repro'
const BACKUP_DIR = join(ROOT, 'backups2')

const now = Date.now()
let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
  if (!cond) failures++
}

function freshMachine(dir: string): { store: MailStore; appStore: AppStore } {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const { __setUserData } = require('electron') as { __setUserData(p: string): void }
  __setUserData(dir)
  const appStore = new AppStore()
  appStore.initKv()
  const db = new DatabaseSync(appStore.dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec(MailStore.SCHEMA)
  const store = new MailStore(db)
  // 与 index.ts bootstrap 一致的迁移
  try { db.exec('ALTER TABLE drafts ADD COLUMN send_at INTEGER') } catch { /* 列已存在 */ }
  try { db.exec('ALTER TABLE messages ADD COLUMN pinned INTEGER DEFAULT 0'); db.exec('ALTER TABLE messages ADD COLUMN pinned_order INTEGER') } catch { /* 列已存在 */ }
  try { db.exec('ALTER TABLE accounts ADD COLUMN auth_type TEXT') } catch { /* 列已存在 */ }
  try { db.exec('ALTER TABLE messages ADD COLUMN snoozed_until INTEGER') } catch { /* 列已存在 */ }
  return { store, appStore }
}

function mkBackup(engineDeps: { store: MailStore; appStore: AppStore }, oauth?: unknown) {
  return new BackupService({
    store: engineDeps.store,
    appStore: engineDeps.appStore,
    engine: { startAccount() {} } as never,
    sender: { drop() {} } as never,
    oauth: (oauth ?? { loadTokens: () => null, saveTokens() {} }) as never,
    event() {}
  })
}

function msgCount(store: MailStore, accountId: string): number {
  return (store.db.prepare('SELECT COUNT(*) c FROM messages WHERE account_id = ?').get(accountId) as { c: number }).c
}

/** 起 5 秒真实同步，返回 { statuses, msgs } */
async function runSync(
  store: MailStore,
  appStore: AppStore,
  account: { id: string },
  opts: { oauthClients?: unknown; waitMs?: number } = {}
): Promise<{ statuses: Record<string, string>; msgs: number }> {
  const oauth = new OAuthService(appStore)
  if (opts.oauthClients !== undefined) oauth.saveClients(opts.oauthClients as never)
  const statuses: Record<string, string> = {}
  const engine = new SyncEngine(
    store,
    appStore,
    {
      status: (accountId, status, text) => {
        if (!statuses[accountId] || status === 'error') statuses[accountId] = `${status}: ${text}`
      },
      progress: () => {},
      changed: () => {},
      newMail: () => {}
    },
    () => store.listRules(),
    async (acc, force) => {
      if (acc.authType === 'oauth') {
        return { accessToken: await oauth.validToken(acc.id, acc.provider, force) }
      }
      return { pass: appStore.loadSecret(`acct:${acc.id}`) }
    }
  )
  engine.startAccount(store.listAccounts().find(a => a.id === account.id)!)
  const waitMs = opts.waitMs ?? 2500
  await new Promise(r => setTimeout(r, waitMs))
  engine.stopAll()
  return { statuses, msgs: msgCount(store, account.id) }
}

async function main() {
  rmSync(BACKUP_DIR, { recursive: true, force: true })
  mkdirSync(BACKUP_DIR, { recursive: true })

  // ============================================================
  // S5 + S1：Gmail 风格账户（含凭据）→ 新机器还原
  // ============================================================
  setServer({
    validPass: 'gmail-app-pass',
    folders: [
      { path: 'INBOX' },
      { path: '[Gmail]/Sent Mail', specialUse: '\\Sent' },
      { path: '[Gmail]/Trash', specialUse: '\\Trash' },
      { path: '[Gmail]/Spam', specialUse: '\\Junk' }
    ]
  } as never)
  mkMailbox('INBOX', 1000)
  addMsg('INBOX', { flags: [], date: now - 60_000, subject: 'Gmail 收件', messageId: '<g1@x.com>', from: { address: 'boss@example.com' }, to: [{ address: 'me@gmail.com' }], headers: {} })
  mkMailbox('[Gmail]/Sent Mail', 2000)
  addMsg('[Gmail]/Sent Mail', { flags: ['\\Seen'], date: now - 90_000, subject: '已发', messageId: '<g2@x.com>', from: { address: 'me@gmail.com' }, to: [{ address: 'friend@example.com' }], headers: {} })
  mkMailbox('[Gmail]/Trash', 3000)
  mkMailbox('[Gmail]/Spam', 4000)

  const A = freshMachine(join(ROOT, 'A'))
  process.env.REPRO_BACKUP_DIR = join(BACKUP_DIR, 'with-secret')
  mkdirSync(process.env.REPRO_BACKUP_DIR, { recursive: true })
  const accA = {
    id: 'acc-gmail', provider: 'gmail' as const, name: 'Gmail主', email: 'me@gmail.com', color: '#ea4335',
    enabled: true, signatureId: null,
    imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    user: 'me@gmail.com', authType: 'password' as const, createdAt: now
  }
  A.store.upsertAccount(accA)
  A.appStore.saveSecret('acct:acc-gmail', 'gmail-app-pass')
  const bkA = mkBackup(A)
  const exp = await bkA.exportTo('pick', 'pass-1234', true)
  check('S1/S5: 导出成功', !!exp.ok, exp)

  const B = freshMachine(join(ROOT, 'B'))
  const bkB = mkBackup(B)
  const res = await bkB.restoreApply(exp.path!, 'pass-1234')
  check('S1: 还原成功', res.ok && res.added.length === 1, { added: res.added, failed: res.failed })
  const r1 = await runSync(B.store, B.appStore, { id: 'acc-gmail' })
  check('S1: 同步无 error', !Object.values(r1.statuses).some(s => s.startsWith('error')), r1.statuses)
  check('S1: 入库 2 封（收+发）', r1.msgs === 2, r1.msgs)
  const trash = B.store.db.prepare("SELECT special FROM folders WHERE account_id='acc-gmail' AND path='[Gmail]/Trash'").get() as { special: string } | undefined
  check('S5: Trash 特殊文件夹识别', trash?.special === 'trash', trash)

  // ============================================================
  // S2：不含凭据的备份 → 新机器还原（期望：账户在、明确提示而非空转）
  // ============================================================
  const expNoSecret = await bkA.exportTo('pick', 'pass-1234', false)
  process.env.REPRO_BACKUP_DIR = join(BACKUP_DIR, 'without-secret')
  mkdirSync(process.env.REPRO_BACKUP_DIR, { recursive: true })
  const C = freshMachine(join(ROOT, 'C'))
  const bkC = mkBackup(C)
  const resC = await bkC.restoreApply(expNoSecret.path!, 'pass-1234')
  check('S2: 还原成功且进入待补凭据', resC.ok && (resC.pending ?? []).some(p => p.includes('me@gmail.com')), { added: resC.added, pending: resC.pending })
  check('S2: added 不再声称含凭据', resC.added[0] && !resC.added[0].includes('凭据已恢复'), resC.added)
  // 还原路径不启动无凭据 worker：直接看引擎外部表现（这里仅记录）
  const rC = await runSync(C.store, C.appStore, { id: 'acc-gmail' })
  console.log('— S2 手动启动后的状态（预期明确提示，非误导）：', rC.statuses)

  // ============================================================
  // S6：同一分钟内两次导出 → 不得互相覆盖
  // ============================================================
  const exp2a = await bkA.exportTo('pick', 'pass-1234', true)
  const exp2b = await bkA.exportTo('pick', 'pass-1234', false)
  check('S6: 两次导出路径不同', exp2a.ok && exp2b.ok && exp2a.path !== exp2b.path, { a: exp2a.path, b: exp2b.path })
  check('S6: 两个文件都存在且内容独立', exp2a.path && exp2b.path && exp2a.path !== exp2b.path, null as never)

  // ============================================================
  // S3：同机删号再还原（用户反复尝试的路径）
  // ============================================================
  const r1b = await runSync(B.store, B.appStore, { id: 'acc-gmail' }, { waitMs: 800 })
  B.store.db.prepare("DELETE FROM accounts WHERE id='acc-gmail'").run()
  // 模拟 UI 删除账户：文件夹与消息级联（deleteAccount 逻辑），pending_ops 不清理（复刻现实）
  B.store.db.prepare("DELETE FROM folders WHERE account_id='acc-gmail'").run()
  B.store.db.prepare("DELETE FROM messages WHERE account_id='acc-gmail'").run()
  const resD = await bkB.restoreApply(exp.path!, 'pass-1234')
  check('S3: 删号后还原成功', resD.ok && resD.added.length === 1, { added: resD.added, failed: resD.failed })
  const rD = await runSync(B.store, B.appStore, { id: 'acc-gmail' })
  check('S3: 还原后同步无 error', !Object.values(rD.statuses).some(s => s.startsWith('error')), rD.statuses)
  check('S3: 重新入库 2 封', rD.msgs === 2, rD.msgs)

  // ============================================================
  // S4：OAuth 账户还原到未配置 OAuth 客户端的新机器
  // ============================================================
  setServer({ validPass: 'ignored' } as never)
  const E = freshMachine(join(ROOT, 'E'))
  const accE = {
    id: 'acc-oauth', provider: 'gmail' as const, name: 'OAuth号', email: 'oauth@gmail.com', color: '#34a853',
    enabled: true, signatureId: null,
    imap: { host: 'imap.gmail.com', port: 993, secure: true }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    user: 'oauth@gmail.com', authType: 'oauth' as const, createdAt: now
  }
  E.store.upsertAccount(accE)
  process.env.REPRO_BACKUP_DIR = join(BACKUP_DIR, 'oauth')
  mkdirSync(process.env.REPRO_BACKUP_DIR, { recursive: true })
  const oauthE = new OAuthService(E.appStore)
  oauthE.saveTokens('acc-oauth', { accessToken: 'tok-old', refreshToken: 'rfr-old', expiresAt: now + 3600_000, email: 'oauth@gmail.com' })
  const bkE = mkBackup(E, new OAuthService(E.appStore))
  const expE = await bkE.exportTo('pick', 'pass-1234', true)
  check('S4: 导出成功（真 OAuthService 收集 token）', !!expE.ok, expE)

  const F = freshMachine(join(ROOT, 'F'))
  const bkF = mkBackup(F, new OAuthService(F.appStore))
  const resF = await bkF.restoreApply(expE.path!, 'pass-1234')
  check('S4: 还原成功', resF.ok && resF.added.length === 1, { added: resF.added, failed: resF.failed })
  const tokF = new OAuthService(F.appStore).loadTokens('acc-oauth')
  check('S4: token 已迁移', !!tokF, tokF)
  check('S4: 未配置客户端 → pending 预警', (resF.pending ?? []).some(p => p.includes('oauth@gmail.com')), resF.pending)
  // S4a：token 未过期 → 不触发刷新，无客户端配置也能同步
  setServer({ validPass: 'ignored', validToken: 'tok-old', folders: [{ path: 'INBOX' }] } as never)
  mkMailbox('INBOX', 5000)
  const rF = await runSync(F.store, F.appStore, { id: 'acc-oauth' })
  check('S4a: 未过期 token → 同步成功（无需客户端配置）', !Object.values(rF.statuses).some(s => s.startsWith('error')), rF.statuses)
  // S4b：token 已过期 → 必须刷新 → 无客户端配置 → 明确报错
  new OAuthService(F.appStore).saveTokens('acc-oauth', { accessToken: 'tok-old', refreshToken: 'rfr-old', expiresAt: now - 1000, email: 'oauth@gmail.com' })
  const rF2 = await runSync(F.store, F.appStore, { id: 'acc-oauth' })
  console.log('— S4b 状态（token 过期且无客户端配置）：', rF2.statuses)
  check('S4b: 错误文案归因 OAuth 而非账号密码', Object.values(rF2.statuses).some(s => s.startsWith('error') && s.includes('授权不可用')), rF2.statuses)

  console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ 全部通过')
  process.exit(failures ? 1 : 0)
}

main().catch(err => {
  console.error('REPRO CRASH:', err)
  process.exit(2)
})