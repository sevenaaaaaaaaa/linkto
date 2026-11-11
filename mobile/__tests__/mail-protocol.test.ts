jest.mock('react-native-tcp-socket', () => ({ __esModule: true, default: {} }))
import { ImapLite } from '../src/imap/ImapLite'

function client(server: (command: string, tag: string) => string) {
  const imap = new ImapLite()
  const internal = imap as any
  const commands: string[] = []
  internal.sock = { write: (raw: string) => {
    commands.push(raw.trim())
    const [tag, ...command] = raw.trim().split(' ')
    void Promise.resolve().then(() => {
      const response = server(command.join(' '), tag)
      // Split a literal and subsequent response across packets as real IMAP does.
      const boundary = Math.max(1, Math.floor(response.length / 2))
      internal.feed(response.slice(0, boundary)); internal.feed(response.slice(boundary))
    })
  } }
  return { imap, commands }
}
test('UID search/fetch and literal parsing return the requested message after sequence renumbering', async () => {
  const header = 'From: Alice <alice@example.com>\r\nSubject: right message\r\nMessage-ID: <right@example.com>\r\n'
  const { imap, commands } = client((command, tag) => {
    if (command.startsWith('SELECT')) return `* 1 EXISTS\r\n${tag} OK selected\r\n`
    if (command === 'UID SEARCH UNDELETED') return `* SEARCH 70\r\n${tag} OK search\r\n`
    if (command.startsWith('UID FETCH 70 ')) return `* 1 FETCH (UID 70 FLAGS () BODY[HEADER] {${header.length}}\r\n${header})\r\n${tag} OK fetched\r\n`
    throw new Error(command)
  })
  const messages = await imap.fetchEnvelopes('INBOX')
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ uid: 70, subject: 'right message', messageId: '<right@example.com>' })
  expect(commands.some(c => /UID FETCH 70/.test(c))).toBe(true)
})
test('flag changes select the correct mailbox and address the UID', async () => {
  const { imap, commands } = client((_, tag) => `${tag} OK done\r\n`)
  await imap.markSeen('Archive', 70)
  expect(commands[0]).toContain('SELECT "Archive"')
  expect(commands[1]).toContain('UID STORE 70 +FLAGS.SILENT')
})
test('server search errors never appear as an empty successful inbox', async () => {
  const { imap } = client((command, tag) => command.startsWith('SELECT') ? `${tag} OK done\r\n` : `${tag} NO unavailable\r\n`)
  await expect(imap.fetchEnvelopes('INBOX')).rejects.toThrow('邮件列表获取失败')
})

test('an empty search never fetches invalid UID zero', async () => {
  const { imap, commands } = client((command, tag) => command.startsWith('SELECT') ? `${tag} OK selected\r\n` : `* SEARCH\r\n${tag} OK done\r\n`)
  expect(await imap.fetchEnvelopes('INBOX')).toEqual([])
  expect(commands.some(c => c.includes('FETCH'))).toBe(false)
})
test('fetch errors preserve the distinction from an empty inbox', async () => {
  const { imap } = client((command, tag) => {
    if (command.startsWith('SELECT')) return `${tag} OK selected\r\n`
    if (command === 'UID SEARCH UNDELETED') return `* SEARCH 70\r\n${tag} OK done\r\n`
    return `${tag} NO unavailable\r\n`
  })
  await expect(imap.fetchEnvelopes('INBOX')).rejects.toThrow('邮件信封获取失败')
})

test('MOVE returns the new UID for undo and never expunges unrelated mail', async () => {
  const { imap, commands } = client((command, tag) => command.startsWith('UID MOVE') ? `${tag} OK [COPYUID 5 70 901] moved\r\n` : `${tag} OK selected\r\n`)
  expect(await imap.moveMessage('INBOX', 70, 'Archive')).toBe(901)
  expect(commands.some(c => /EXPUNGE/.test(c))).toBe(false)
})
test('legacy MOVE fallback copies and expunges only the selected UID', async () => {
  const { imap, commands } = client((command, tag) => command.startsWith('UID MOVE') ? `${tag} BAD unsupported\r\n` : command.startsWith('UID COPY') ? `${tag} OK [COPYUID 5 70 902] copied\r\n` : `${tag} OK done\r\n`)
  expect(await imap.moveMessage('INBOX', 70, 'Trash')).toBe(902)
  expect(commands.some(c => c.endsWith('UID EXPUNGE 70'))).toBe(true)
  expect(commands.some(c => /^A\d+ EXPUNGE/.test(c))).toBe(false)
})
test('special-use folder beats an unrelated folder with an archive-like name', async () => {
  const { imap } = client((_, tag) => `* LIST (\\HasNoChildren) "/" "Project Archive"\r\n* LIST (\\Trash) "/" "Deleted Items"\r\n${tag} OK done\r\n`)
  expect(await imap.actionFolder('trash')).toBe('Deleted Items')
})
