import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { AccountWorker, folderIdOf } from '../src/main/mail/sync-engine'
import { MailStore } from '../src/main/db'
import { OAuthService } from '../src/main/oauth'
import { SyncCodec } from '../mobile/src/workbench/sync-codec'
import { KeyRing, encodeMessage, decodeMessage, parseHeaderBlock } from '../src/main/todo-sync/protocol'
import { syncRound } from '../src/main/todo-sync/engine'
import { randomBytes } from 'node:crypto'
import { ACCOUNT_PROVIDER_CHOICES, PROVIDER_PRESETS, microsoftProviderFor, presetFor } from '../src/shared/presets'
import { FakeImapFlow, setServer, mkMailbox, addMsg, server } from './restore-repro/imap-stub.cjs'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
const test = async (name: string, run: () => void | Promise<void>) => { await run(); console.log(`PASS ${name}`) }

// The old restore fixture omits mailbox UIDVALIDITY and clears selection on release.
// Match real IMAP selection semantics here without changing its existing tests.
Object.defineProperty(FakeImapFlow.prototype, 'mailbox', { get() {
  const mb = server.mailboxes[this.currentPath]
  return mb ? { uidValidity: BigInt(mb.uidValidity), uidNext: mb.uidNext, exists: mb.msgs.length } : false
} })
FakeImapFlow.prototype.getMailboxLock = async function(path: string) {
  assert.ok(server.mailboxes[path], `missing fixture mailbox ${path}`)
  this.currentPath = path
  return { release() {} }
}

function fixture(screenerEnabled = false) {
  setServer({ folders: [{ path: 'INBOX' }, { path: 'Archive', specialUse: '\\Archive' }], mailboxes: {}, connLog: [] })
  mkMailbox('INBOX', 11)
  mkMailbox('Archive', 22)
  const db = new DatabaseSync(':memory:')
  db.exec(MailStore.SCHEMA)
  db.exec('ALTER TABLE messages ADD COLUMN pinned INTEGER DEFAULT 0')
  db.exec('ALTER TABLE messages ADD COLUMN pinned_order INTEGER')
  const store = new MailStore(db)
  const changes: string[] = []
  const arrivals: string[] = []
  const heldArrivals: string[] = []
  const notifications: string[] = []
  const appStore = { get: (_: string, defaults: unknown) => ({ ...(defaults as object), screenerEnabled }), loadSecret: () => 'secret-pass' }
  const worker = new AccountWorker(
    { id: 'a', email: 'test@example.com', name: 'test', user: 'test@example.com' },
    { host: '127.0.0.1', port: 1143, secure: false }, store, appStore as never,
    { status() {}, progress() {}, changed: id => changes.push(id ?? ''), newMail: (_, id) => notifications.push(id), arrived: (_, id, __, held) => { arrivals.push(id); if (held) heldArrivals.push(id) } }
  )
  const internal = worker as any
  const client = new FakeImapFlow({ auth: { pass: 'secret-pass' } })
  client.usable = true
  internal.client = client
  internal.lastActivity = Date.now()
  // Keep body parsing outside the scope of these protocol/envelope tests.
  internal.enqueueBody = () => {}
  const add = (path = 'INBOX', subject = 'verification code', address = 'noreply@example.com') => addMsg(path, {
    subject, date: Date.now(), flags: [], from: { address }
  })
  const cleanup = () => { worker.stop(); db.close() }
  return { worker, internal, client, store, db, changes, arrivals, heldArrivals, notifications, add, cleanup }
}

async function main() {
  await test('provider priority and one Microsoft entry', () => {
    assert.deepEqual(ACCOUNT_PROVIDER_CHOICES.slice(0, 13).map(p => p.key),
      ['proton', 'gmail', 'outlook', 'icloud', 'custom', '163', 'qq', 'yahoo', 'naver', 'aol', 'exmail', 'agentmail', 'agent'])
    assert.equal(ACCOUNT_PROVIDER_CHOICES.filter(p => ['outlook', 'hotmail', 'office365'].includes(p.key)).length, 1)
    assert.equal(new Set(PROVIDER_PRESETS.map(p => p.key)).size, PROVIDER_PRESETS.length)
  })
  await test('domain detection, Microsoft tenants, regional servers and AgentMail', () => {
    for (const domain of ['hotmail.com', 'live.cn', 'msn.com', 'outlook.com.cn', 'hotmail.co.jp']) assert.equal(presetFor(`a@${domain}`).key, 'outlook')
    assert.equal(presetFor(' A@ACME.ONMICROSOFT.COM ').key, 'office365')
    assert.equal(presetFor('a@evilonmicrosoft.com').key, 'custom')
    assert.equal(presetFor('a@onmicrosoft.com.evil.com').key, 'custom')
    assert.equal(presetFor('a@yeah.net').imap?.host, 'imap.yeah.net')
    assert.equal(presetFor('a@foxmail.com').key, 'qq')
    assert.equal(presetFor('a@yahoo.co.jp').imap?.host, 'imap.mail.yahoo.co.jp')
    assert.equal(presetFor('a@naver.com').smtp?.port, 587)
    assert.equal(presetFor('a@aol.com').imap?.host, 'imap.aol.com')
    assert.equal(presetFor('a@agentmail.to').imap?.host, 'imap.agentmail.to')
    assert.equal(microsoftProviderFor('a@company.com', '9188040d-6c67-4c5b-b112-36a304b66dad'), 'outlook')
    assert.equal(microsoftProviderFor('a@outlook.com', 'organization-tenant'), 'office365')
    assert.equal(microsoftProviderFor('a@live.com'), 'outlook')
    assert.equal(PROVIDER_PRESETS.find(p => p.key === 'outlook')?.smtp?.host, 'smtp-mail.outlook.com')
  })
  await test('partial OAuth settings keep credentials for the other provider', () => {
    const oauth = new OAuthService({ get: () => ({ google: { clientId: 'google-id', clientSecret: 'google-secret' } }) } as never)
    assert.equal(oauth.clients().google?.clientId, 'google-id')
    assert.equal(typeof oauth.clients().ms?.clientId, 'string')
  })
  await test('manual receive waits for IMAP, merges repeated clicks, persists and classifies mail', async () => {
    const f = fixture()
    try {
      f.add()
      await f.internal.syncAllFolders()
      const uid = f.add()
      let completed = false
      const pending = f.worker.receiveNow()
      assert.equal(f.worker.receiveNow(), pending)
      void pending.then(() => { completed = true })
      await Promise.resolve()
      assert.equal(completed, false, 'must not report success when only queued')
      await f.internal.syncInbox(false)
      await pending
      const row = f.store.getMessageRow(`a::INBOX::${uid}`)
      assert.equal(row?.category, 'notification')
      assert.ok(f.arrivals.includes(`a::INBOX::${uid}`))
      assert.ok(f.changes.length > 0)
    } finally { f.cleanup() }
  })
  await test('click during an in-flight inbox check waits for the next check', async () => {
    const f = fixture()
    try {
      f.add()
      await f.internal.syncAllFolders()
      const entered = deferred(), release = deferred()
      const search = f.client.search.bind(f.client)
      f.client.search = async (...args: any[]) => { entered.resolve(); await release.promise; return search(...args) }
      const cycle = f.internal.syncInbox(false)
      await entered.promise
      const pending = f.worker.receiveNow()
      let completed = false
      void pending.then(() => { completed = true })
      release.resolve()
      await cycle
      assert.equal(completed, false)
      f.client.search = search
      await f.internal.syncInbox(false)
      await pending
    } finally { f.cleanup() }
  })
  await test('manual receive finishes before slow historical backfill', async () => {
    const f = fixture()
    try {
      f.add()
      const entered = deferred(), release = deferred()
      f.internal.backfill = async () => { entered.resolve(); await release.promise }
      const pending = f.worker.receiveNow()
      const full = f.internal.syncAllFolders()
      await entered.promise
      await pending
      assert.equal(f.store.listFolderUids(folderIdOf('a', 'INBOX')).length, 1)
      release.resolve()
      await full
    } finally { f.cleanup() }
  })
  await test('full sync checks inbox again between folders when new receive is requested', async () => {
    const f = fixture()
    try {
      f.add()
      const backfill = f.internal.backfill.bind(f.internal)
      let pending: Promise<void> | undefined
      f.internal.backfill = async (path: string, ...args: any[]) => {
        await backfill(path, ...args)
        if (path === 'INBOX') { f.add(); pending = f.worker.receiveNow() }
      }
      await f.internal.syncAllFolders()
      await pending
      assert.equal(f.store.listFolderUids(folderIdOf('a', 'INBOX')).length, 2)
      assert.equal(f.internal.receiving, null)
    } finally { f.cleanup() }
  })
  await test('stale Bridge connection is discarded and stop rejects pending receive', async () => {
    const f = fixture()
    try {
      f.internal.lastActivity = Date.now() - 31_000
      const pending = f.worker.receiveNow()
      const rejected = assert.rejects(pending, /停用|更新/)
      assert.equal(f.client.usable, false)
      assert.equal(f.internal.kickRequested, true)
      f.worker.stop()
      await rejected
      assert.equal(f.internal.receiving, null)
    } finally { f.cleanup() }
  })
  await test('live loop reports connection failure to receive instead of false success', async () => {
    const f = fixture()
    try {
      f.internal.client = null
      f.internal.connect = async () => { throw new Error('ECONNREFUSED') }
      const pending = f.worker.receiveNow()
      f.worker.start()
      await assert.rejects(pending, /Bridge/)
    } finally { f.cleanup() }
  })
  await test('Screener does not register first sync, historical backfill or UIDVALIDITY rebuild', async () => {
    const f = fixture(true)
    try {
      for (let i = 0; i < 353; i++) f.add('INBOX', `historical ${i}`, `old-${i}@example.com`)
      await f.internal.syncAllFolders()
      assert.equal(f.store.listFolderUids(folderIdOf('a', 'INBOX')).length, 353)
      assert.equal(f.store.screenerPendingCount(), 0)
      assert.equal(f.store.screenerHeldMailCount(), 0)
      server.mailboxes.INBOX.uidValidity++
      await f.internal.syncAllFolders()
      assert.equal(f.store.listFolderUids(folderIdOf('a', 'INBOX')).length, 353)
      assert.equal(f.store.screenerPendingCount(), 0)
      assert.equal(f.store.getMessages({ scope: 'unified', limit: 1000, offset: 0 }).total, 353)
    } finally { f.cleanup() }
  })
  await test('manual receive preserves pending/deny filtering and emits changes even if visible total stays the same', async () => {
    const f = fixture(true)
    try {
      f.add('INBOX', 'initial', 'known@example.com')
      await f.internal.syncAllFolders()
      const before = f.store.getMessages({ scope: 'unified', limit: 1000, offset: 0 }).total
      const changedBefore = f.changes.length
      const pendingUid = f.add('INBOX', 'new sender', 'New@Example.com')
      const pending = f.worker.receiveNow()
      await f.internal.syncInbox(false)
      await pending
      assert.equal(f.store.getMessages({ scope: 'unified', limit: 1000, offset: 0 }).total, before)
      assert.equal(f.store.screenerHeldMailCount('a'), 1)
      assert.ok(f.changes.length > changedBefore)
      assert.ok(f.heldArrivals.includes(`a::INBOX::${pendingUid}`))
      assert.ok(!f.notifications.includes(`a::INBOX::${pendingUid}`))
      const repeatedUid = f.add('INBOX', 'same pending sender', 'NEW@example.com')
      f.store.setSenderStatus('denied@example.com', 'deny')
      const deniedUid = f.add('INBOX', 'rejected sender', 'Denied@Example.com')
      await f.internal.syncInbox(false)
      assert.ok(f.heldArrivals.includes(`a::INBOX::${repeatedUid}`))
      assert.ok(f.heldArrivals.includes(`a::INBOX::${deniedUid}`))
      assert.equal(f.store.screenerHeldMailCount('a'), 2, 'denied mail is not pending review')
      assert.equal(f.store.unreadCounts().find(c => c.accountId === 'a')?.unread, before, 'mixed-case blocked senders must not inflate badge')
      assert.equal(f.store.approveAllPending('a'), 1)
      assert.equal(f.store.screenerHeldMailCount('a'), 0)
      assert.equal(f.store.senderScreeningStatus('denied@example.com'), 'deny')
      assert.equal(f.store.getMessages({ scope: 'unified', limit: 1000, offset: 0 }).total, before + 2)
    } finally { f.cleanup() }
  })
  await test('pending count, review list and release honor selected account; no-argument API stays compatible', async () => {
    const f = fixture(true)
    try {
      const insert = f.db.prepare(`INSERT INTO messages (id, account_id, folder_id, folder_path, uid, from_addr, date) VALUES (?,?,?,'INBOX',?,?,?)`)
      insert.run('a::INBOX::1', 'a', 'a::INBOX', 1, 'One@example.com', Date.now())
      insert.run('b::INBOX::1', 'b', 'b::INBOX', 1, 'Two@example.com', Date.now())
      f.store.setSenderStatus('one@example.com', 'pending')
      f.store.setSenderStatus('two@example.com', 'pending')
      assert.equal(f.store.screenerHeldMailCount(), 2)
      assert.equal(f.store.screenerHeldMailCount('a'), 1)
      assert.equal(f.store.getMessages({ scope: 'screener', accountId: 'a', limit: 1000, offset: 0 }).total, 1)
      assert.equal(f.store.approveAllPending('a'), 1)
      assert.equal(f.store.senderScreeningStatus('two@example.com'), 'pending')
      assert.equal(f.store.approveAllPending(), 1)
      assert.equal(f.store.screenerHeldMailCount(), 0)
    } finally { f.cleanup() }
  })
  await test('historical repair only releases old pending senders, preserves recent pending and explicit deny', async () => {
    const f = fixture(true)
    try {
      const now = Date.now()
      const insert = f.db.prepare(`INSERT INTO messages (id, account_id, folder_id, folder_path, uid, from_addr, date) VALUES (?,'a','a::INBOX','INBOX',?,?,?)`)
      insert.run('old', 1, 'Old@example.com', now - 2 * 864e5)
      insert.run('recent', 2, 'Recent@example.com', now)
      insert.run('denied', 3, 'Denied@example.com', now - 2 * 864e5)
      f.store.setSenderStatus('old@example.com', 'pending')
      f.store.setSenderStatus('recent@example.com', 'pending')
      f.store.setSenderStatus('denied@example.com', 'deny')
      assert.equal(f.store.repairBackfilledScreening(), 1)
      assert.equal(f.store.senderScreeningStatus('old@example.com'), 'allow')
      assert.equal(f.store.senderScreeningStatus('recent@example.com'), 'pending')
      assert.equal(f.store.senderScreeningStatus('denied@example.com'), 'deny')
      assert.equal(f.store.repairBackfilledScreening(), 0)
    } finally { f.cleanup() }
  })
  await test('desktop ↔ mobile encrypted task/note codecs interoperate and reject tampering', async () => {
    const ring = new KeyRing('a-shared-test-passphrase')
    const codec = new SyncCodec('a-shared-test-passphrase', async n => new Uint8Array(randomBytes(n)))
    try {
      const desktop = { v: 1, id: 'desktop-todo', title: '从邮件整理报告', status: 'open', dueAt: null, createdAt: 1, updatedAt: 10, data: { minutes: 45, updatedAt: 10 } }
      const encoded = await encodeMessage(desktop, { keyring: ring })
      assert.equal(await codec.wireId(desktop.id), encoded.wireId)
      const received = await codec.decode(encoded.raw.toString('utf8'))
      assert.equal(received.title, desktop.title)
      assert.equal(received.kind, 'todo')
      const mobile = { ...received, id: 'mobile-note', kind: 'memo' as const, title: '手机随手记', data: { updatedAt: 20, content: '想法与邮件放在一起', collection: '项目跟进' } }
      const raw = await codec.encode(mobile)
      const decoded = await decodeMessage(Buffer.from(raw), ring)
      assert.equal(decoded.kind, 'memo')
      assert.equal(decoded.data.content, mobile.data.content)
      assert.equal(decoded.data.collection, mobile.data.collection)
      await assert.rejects(decodeMessage(Buffer.from(raw.replace('X-LinkTo-Memo:', 'X-LinkTo-Todo:')), ring), /类型/)
      const wrong = new SyncCodec('incorrect-passphrase', async n => new Uint8Array(randomBytes(n)))
      try { await assert.rejects(wrong.decode(raw), /口令|损坏/) } finally { await wrong.clear() }
    } finally { await codec.clear() }
  })
  await test('real sync engine and SQLite receive mobile memo edits and preserve removal tombstones', async () => {
    const f = fixture()
    const ring = new KeyRing('shared-mailbox-test')
    const codec = new SyncCodec('shared-mailbox-test', async n => new Uint8Array(randomBytes(n)))
    try {
      const remote = new Map<number, Buffer>()
      let uid = 0
      const transport = {
        ensureFolder: async () => 'LinkTo-Sync',
        fetchHeaders: async () => [...remote].map(([id, raw]) => ({ uid: id, headers: parseHeaderBlock(raw.toString().split('\r\n\r\n')[0]) })),
        download: async (_: string, id: number) => remote.get(id) ?? null,
        append: async (_: string, raw: Buffer) => { remote.set(++uid, raw) },
        remove: async (_: string, ids: number[]) => { ids.forEach(id => remote.delete(id)) }
      }
      const local = { list: () => f.store.listTodosForSync(true), upsert: (item: any) => f.store.upsertTodoFromSync(item), hasAccount: () => false, hasMessage: () => false }
      const note = { id: 'phone-note', kind: 'memo' as const, title: '待回信的想法', status: 'open' as const, dueAt: null, createdAt: 1, data: { content: '手机写下的内容', collection: '项目跟进', updatedAt: 100 } }
      remote.set(++uid, Buffer.from(await codec.encode(note)))
      await syncRound({ transport, local, keyring: ring, now: 200 })
      assert.equal(f.store.getInsight(note.id)?.kind, 'memo')
      assert.equal(f.store.getInsight(note.id)?.data.content, note.data.content)
      assert.equal(f.store.getInsight(note.id)?.data.collection, note.data.collection)
      const updated = { ...note, status: 'dismissed' as const, data: { ...note.data, updatedAt: 300 } }
      remote.set(++uid, Buffer.from(await codec.encode(updated)))
      await syncRound({ transport, local, keyring: ring, now: 400 })
      assert.equal(f.store.getInsight(note.id)?.status, 'dismissed')
      assert.equal(f.store.listTodosForSync().length, 0, 'memo must not leak into desktop task integrations')
      assert.equal(remote.size, 1, 'duplicate versions are cleaned by desktop sync')
    } finally { f.cleanup(); await codec.clear() }
  })
  await test('enabling encryption rewrites legacy plaintext notes and local edits advance a remote clock', async () => {
    const f = fixture()
    const ring = new KeyRing('migration-shared-passphrase')
    try {
      const now = Date.now(), remote = new Map<number, Buffer>()
      let uid = 0
      const item = { v: 1, kind: 'memo' as const, id: 'legacy-note', title: '旧随手记', status: 'open', dueAt: null, createdAt: now, updatedAt: now, data: { content: '需要加密', updatedAt: now } }
      remote.set(++uid, (await encodeMessage(item, { keyring: null })).raw)
      const transport = {
        ensureFolder: async () => 'LinkTo-Sync',
        fetchHeaders: async () => [...remote].map(([id, raw]) => ({ uid: id, headers: parseHeaderBlock(raw.toString().split('\r\n\r\n')[0]) })),
        download: async (_: string, id: number) => remote.get(id) ?? null,
        append: async (_: string, raw: Buffer) => { remote.set(++uid, raw) },
        remove: async (_: string, ids: number[]) => { ids.forEach(id => remote.delete(id)) }
      }
      const local = { list: () => f.store.listTodosForSync(true), upsert: (row: any) => f.store.upsertTodoFromSync(row), hasAccount: () => false, hasMessage: () => false }
      await syncRound({ transport, local, keyring: ring, now })
      assert.equal(remote.size, 1)
      assert.match([...remote.values()][0].toString(), /X-LinkTo-Encrypted: 1/)
      assert.equal((await decodeMessage([...remote.values()][0], ring)).data.content, item.data.content)
      const future = now + 60_000
      f.store.updateInsight(item.id, { data: { updatedAt: future } })
      f.store.updateInsight(item.id, { status: 'done' })
      assert.ok(Number(f.store.getInsight(item.id)?.data.updatedAt) > future)
    } finally { f.cleanup() }
  })
  console.log('All mail and mobile sync regression checks passed')
}

main().catch(err => { console.error(err); process.exitCode = 1 })
