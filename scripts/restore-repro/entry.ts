/**
 * 备份还原 → 首次同步 全链路复现：
 * 机器 A（加账户+备份）→ 机器 B（全新数据目录还原 + SyncEngine 首次同步）
 * 全部使用真实代码：BackupService / MailStore / AppStore / SyncEngine / AccountWorker
 * 仅替换 electron（dialog/safeStorage/app）、imapflow（假服务器）、parse-pool（正文解析）。
 */
import { DatabaseSync } from 'node:sqlite'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { MailStore } from '../../src/main/db'
import { AppStore } from '../../src/main/store'
import { BackupService } from '../../src/main/backup'
import { SyncEngine } from '../../src/main/mail/sync-engine'
import { setServer, mkMailbox, addMsg } from 'imapflow'

const ROOT = '/tmp/linkto-repro'
const BACKUP_DIR = join(ROOT, 'backups')

const now = Date.now()
let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
  if (!cond) failures++
}

function freshMachine(dir: string): { store: MailStore; appStore: AppStore } {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  // electron-stub 的 userData 指向该目录（AppStore 在 userData/mail-studio 下建库）
  const { __setUserData } = require('electron') as { __setUserData(p: string): void }
  __setUserData(dir)
  const appStore = new AppStore()
  appStore.initKv()
  const db = new DatabaseSync(appStore.dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec(MailStore.SCHEMA)
  const store = new MailStore(db)
  // 与 index.ts bootstrap 完全一致的迁移（schema 迁移散落在这里是隐患，但先如实复刻）
  try {
    db.exec('ALTER TABLE drafts ADD COLUMN send_at INTEGER')
  } catch { /* 列已存在 */ }
  try {
    db.exec('ALTER TABLE messages ADD COLUMN pinned INTEGER DEFAULT 0')
    db.exec('ALTER TABLE messages ADD COLUMN pinned_order INTEGER')
  } catch { /* 列已存在 */ }
  try {
    db.exec('ALTER TABLE accounts ADD COLUMN auth_type TEXT')
  } catch { /* 列已存在 */ }
  try {
    db.exec('ALTER TABLE messages ADD COLUMN snoozed_until INTEGER')
  } catch { /* 列已存在 */ }
  return { store, appStore }
}

async function main() {
  rmSync(BACKUP_DIR, { recursive: true, force: true })
  mkdirSync(BACKUP_DIR, { recursive: true })

  // ---------- 假 IMAP 服务器：一个 QQ 风格账户 ----------
  setServer({
    validPass: 'auth-code-123',
    folders: [
      { path: 'INBOX' },
      { path: 'Sent Messages', specialUse: '\\Sent' },
      { path: '其他文件夹', specialUse: undefined }
    ]
  } as never)
  mkMailbox('INBOX', 111)
  addMsg('INBOX', {
    flags: [],
    date: now - 60_000,
    subject: '老板：开会',
    messageId: '<m1@x.com>',
    from: { name: '老板', address: 'boss@example.com' },
    to: [{ address: 'demo@qq.com' }],
    headers: {}
  })
  addMsg('INBOX', {
    flags: [],
    date: now - 30_000,
    subject: '[Newsletter] Weekly',
    messageId: '<m2@x.com>',
    from: { address: 'news@shop.com' },
    to: [{ address: 'demo@qq.com' }],
    headers: { 'list-unsubscribe': '<mailto:unsub@shop.com>' }
  })
  addMsg('INBOX', {
    flags: ['\\Seen'],
    date: now - 20_000,
    subject: '我自己发的',
    messageId: '<m3@x.com>',
    from: { address: 'demo@qq.com' },
    to: [{ address: 'friend@example.com' }],
    headers: {}
  })
  mkMailbox('Sent Messages', 222)
  addMsg('Sent Messages', {
    flags: ['\\Seen'],
    date: now - 80_000,
    subject: 'Re: 你好',
    messageId: '<s1@x.com>',
    from: { address: 'demo@qq.com' },
    to: [{ name: '朋友', address: 'friend@example.com' }],
    headers: {}
  })
  mkMailbox('其他文件夹', 333)

  // ---------- 机器 A：加账户、造数据、导出备份 ----------
  const A = freshMachine(join(ROOT, 'machineA'))
  const accA = {
    id: 'acc-a1',
    provider: 'qq' as const,
    name: '演示QQ',
    email: 'demo@qq.com',
    color: '#3b82f6',
    enabled: true,
    signatureId: null,
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    user: 'demo@qq.com',
    authType: 'password' as const,
    createdAt: now
  }
  A.store.upsertAccount(accA)
  A.appStore.saveSecret('acct:acc-a1', 'auth-code-123')

  const backupA = new BackupService({
    store: A.store,
    appStore: A.appStore,
    engine: { startAccount() {} } as never,
    sender: { drop() {} } as never,
    oauth: { loadTokens: () => null, saveTokens() {} } as never,
    event() {}
  })
  const exp = await backupA.exportTo('pick', 'pass-1234', true)
  check('A: 导出备份成功', !!exp.ok, exp)

  // ---------- 机器 B：全新机器，解密还原，启动真实同步引擎 ----------
  const B = freshMachine(join(ROOT, 'machineB'))
  const backupB = new BackupService({
    store: B.store,
    appStore: B.appStore,
    engine: { startAccount() {} } as never,
    sender: { drop() {} } as never,
    oauth: { loadTokens: () => null, saveTokens() {} } as never,
    event() {}
  })
  const path = exp.path!
  const res = await backupB.restoreApply(path, 'pass-1234')
  check('B: 还原成功', res.ok, { added: res.added, skipped: res.skipped, failed: res.failed })
  check('B: 凭据已还原', B.appStore.loadSecret('acct:acc-a1') === 'auth-code-123')

  const restored = B.store.listAccounts()[0]
  check('B: 账户行完整', !!restored && restored.imap.host === 'imap.qq.com' && restored.authType === 'password', restored)

  // 真实 SyncEngine + 真实 AccountWorker（假 IMAP 服务器）
  const statuses: Record<string, string> = {}
  const engine = new SyncEngine(B.store, B.appStore, {
    status: (accountId, status, text) => {
      statuses[accountId] = `${status}: ${text}`
      if (status === 'error') console.log(`   ⚠️ 状态错误 [${accountId}] ${text}`)
    },
    progress: () => {},
    changed: () => {},
    newMail: (accountId, messageId, subject) => console.log(`   📨 new-mail ${subject} (${messageId.split('::').pop()})`)
  }, () => [], async (account, _force) => ({ pass: B.appStore.loadSecret(`acct:${account.id}`) }))
  engine.startAccount(restored)

  // 等首次同步完成（轮询 messages 数）
  let n = 0
  for (; n < 100; n++) {
    await new Promise(r => setTimeout(r, 100))
    const msgs = (B.store.db.prepare('SELECT COUNT(*) c FROM messages WHERE account_id = ?').get(restored.id) as { c: number }).c
    if (msgs >= 3) break
  }
  await new Promise(r => setTimeout(r, 1500))
  engine.stopAll()

  console.log('— 状态：', statuses)
  const msgs = (B.store.db.prepare('SELECT COUNT(*) c FROM messages WHERE account_id = ?').get(restored.id) as { c: number }).c
  const folders = B.store.db.prepare('SELECT path, last_sync_uid, uid_validity FROM folders WHERE account_id = ?').all(restored.id)
  const screening = B.store.db.prepare('SELECT addr, status FROM sender_screening').all()
  check('B: 首次同步入库 3 封', msgs === 3, msgs)
  check('B: 状态不是 error', !Object.values(statuses).some(s => s.startsWith('error')), statuses)
  check('B: INBOX last_sync_uid 推进', folders.some(f => f.path === 'INBOX' && f.last_sync_uid > 0), folders)
  console.log('— sender_screening:', screening)

  // ---------- 场景2：口令错误 ----------
  const C = freshMachine(join(ROOT, 'machineC'))
  const backupC = new BackupService({
    store: C.store,
    appStore: C.appStore,
    engine: { startAccount() {} } as never,
    sender: { drop() {} } as never,
    oauth: { loadTokens: () => null, saveTokens() {} } as never,
    event() {}
  })
  const bad = await backupC.restoreApply(path, 'wrong-pass')
  check('C: 口令错误 → 优雅失败', bad.ok === false && !!bad.error, bad)

  console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ 全部通过')
  process.exit(failures ? 1 : 0)
}

main().catch(err => {
  console.error('REPRO CRASH:', err)
  process.exit(2)
})