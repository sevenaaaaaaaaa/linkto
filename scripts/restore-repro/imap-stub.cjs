// 假 IMAP 服务器 + 假 ImapFlow：只实现 sync-engine.ts 实际用到的接口
const server = {
  folders: [], // [{ path, specialUse? }]
  mailboxes: {}, // path -> { uidValidity, uidNext, msgs: [...] }
  validPass: 'secret-pass',
  validToken: null,
  connLog: []
}

function setServer(cfg) {
  Object.assign(server, cfg)
}

function addMsg(path, m) {
  const mb = server.mailboxes[path]
  if (!mb) throw new Error('no mailbox ' + path)
  const uid = mb.uidNext++
  mb.msgs.push({ uid, ...m })
  return uid
}

function mkMailbox(path, uidValidity) {
  server.mailboxes[path] = { uidValidity, uidNext: 1, msgs: [] }
}

function parseUidRange(s, max) {
  const out = []
  for (const part of String(s).split(',')) {
    const [a, b] = part.split(':')
    const ai = parseInt(a, 10)
    if (!b || b === '*') {
      for (const m of max.msgs) if (m.uid >= ai) out.push(m.uid)
      if (out.length === 0 && max.msgs.length) {
        const mx = Math.max(...max.msgs.map(m => m.uid))
        if (mx >= ai) out.push(mx)
      }
    } else {
      const bi = parseInt(b, 10)
      for (const m of max.msgs) if (m.uid >= ai && m.uid <= bi) out.push(m.uid)
    }
  }
  return [...new Set(out)].sort((x, y) => x - y)
}

class FakeImapFlow {
  constructor(opts) {
    this.opts = opts
    this.usable = false
    this.currentPath = null
    server.connLog.push(`connect user=${opts.auth?.user} ${opts.auth?.pass ? 'pass=***' : 'token'}`)
  }
  on(ev, cb) {
    if (ev === 'exists') this._existsCb = cb
  }
  async connect() {
    const okPass = this.opts.auth?.pass === server.validPass
    const okToken = server.validToken != null && this.opts.auth?.accessToken === server.validToken
    if (!okPass && !okToken) {
      throw new Error(
        `AUTHENTICATIONFAILED — pass=${this.opts.auth?.pass} token=${this.opts.auth?.accessToken}`
      )
    }
    this.usable = true
  }
  close() {
    this.usable = false
  }
  async list() {
    return server.folders
  }
  async status(p, _q) {
    const mb = server.mailboxes[p]
    if (!mb) throw new Error('NONEXISTENT: ' + p)
    return { uidValidity: BigInt(mb.uidValidity), uidNext: mb.uidNext }
  }
  get mailbox() {
    const mb = this.currentPath && server.mailboxes[this.currentPath]
    if (!mb) return false
    return { uidNext: mb.uidNext, exists: mb.msgs.length }
  }
  async getMailboxLock(p, _opts) {
    const mb = server.mailboxes[p]
    if (!mb) throw new Error('NONEXISTENT: ' + p)
    this.currentPath = p
    return { release: () => (this.currentPath = null) }
  }
  async search(query, _opts) {
    const mb = this.currentPath && server.mailboxes[this.currentPath]
    if (!mb) return []
    if (query.uid) return parseUidRange(query.uid, mb)
    if (query.seen === false) return mb.msgs.filter(m => !m.flags.includes('\\Seen')).map(m => m.uid)
    return mb.msgs.map(m => m.uid)
  }
  async *fetch(range, q, _opts) {
    const mb = this.currentPath && server.mailboxes[this.currentPath]
    if (!mb) return
    const uids = parseUidRange(range, mb)
    for (const m of mb.msgs.filter(x => uids.includes(x.uid))) {
      yield {
        uid: m.uid,
        flags: new Set(m.flags),
        size: m.size ?? 1024,
        internalDate: new Date(m.date ?? Date.now()),
        envelope: {
          subject: m.subject ?? '',
          messageId: m.messageId ?? null,
          inReplyTo: m.inReplyTo ?? null,
          date: new Date(m.date ?? Date.now()),
          from: m.from ? [m.from] : undefined,
          to: m.to ?? [],
          cc: m.cc ?? [],
          replyTo: undefined
        },
        headers: new Map(Object.entries(m.headers ?? {})),
        bodyStructure: null
      }
    }
  }
  async messageFlagsAdd(uidStr, add, _o) {
    const mb = server.mailboxes[this.currentPath]
    const uid = parseInt(uidStr, 10)
    const m = mb.msgs.find(x => x.uid === uid)
    if (!m) throw new Error('no such message ' + uidStr)
    m.flags = [...new Set([...m.flags, ...add])]
  }
  async messageFlagsRemove(uidStr, remove, _o) {
    const mb = server.mailboxes[this.currentPath]
    const uid = parseInt(uidStr, 10)
    const m = mb.msgs.find(x => x.uid === uid)
    if (!m) throw new Error('no such message ' + uidStr)
    m.flags = m.flags.filter(f => !remove.includes(f))
  }
  async messageMove(uidStr, target, _o) {
    const src = server.mailboxes[this.currentPath]
    const dst = server.mailboxes[target]
    if (!dst) throw new Error('TRYCREATE: ' + target)
    const uid = parseInt(uidStr, 10)
    const i = src.msgs.findIndex(x => x.uid === uid)
    const [m] = src.msgs.splice(i, 1)
    dst.msgs.push({ ...m, uid: dst.uidNext++ })
  }
  async messageDelete(uidStr, _o) {
    const mb = server.mailboxes[this.currentPath]
    const uid = parseInt(uidStr, 10)
    const i = mb.msgs.findIndex(x => x.uid === uid)
    if (i >= 0) mb.msgs.splice(i, 1)
  }
  async append(path, buf, flags) {
    const mb = server.mailboxes[path]
    if (!mb) throw new Error('TRYCREATE: ' + path)
    mb.msgs.push({ uid: mb.uidNext++, flags: flags ?? [], raw: String(buf) })
  }
  async download(uidStr, _part, _o) {
    const mb = server.mailboxes[this.currentPath]
    const uid = parseInt(uidStr, 10)
    const m = mb.msgs.find(x => x.uid === uid)
    if (!m) return null
    const raw = Buffer.from(
      `From: ${m.from?.address ?? 'x@y.com'}\r\nSubject: ${m.subject ?? ''}\r\n\r\nstub body\r\n`,
      'utf8'
    )
    async function* gen() {
      yield raw
    }
    return { content: gen() }
  }
}

module.exports = { FakeImapFlow, setServer, addMsg, mkMailbox, server }
module.exports.ImapFlow = FakeImapFlow
module.exports.default = FakeImapFlow