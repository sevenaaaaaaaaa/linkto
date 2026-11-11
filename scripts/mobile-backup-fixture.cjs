// Synthetic desktop-format fixture; never contains real accounts or credentials.
const { randomBytes, scryptSync, createCipheriv } = require('node:crypto')
const { writeFileSync } = require('node:fs')
const salt = randomBytes(16), iv = randomBytes(12)
const key = scryptSync('LinkToBackupQA9!', salt, 32, { N: 16384, r: 8, p: 1 })
const cipher = createCipheriv('aes-256-gcm', key, iv), now = Date.now()
const payload = { accounts: [{ config: { id: 'qa-desktop', provider: 'custom', email: 'qa@example.invalid', user: 'qa@example.invalid', imap: { host: 'imap.example.invalid', port: 993, secure: true }, smtp: { host: 'smtp.example.invalid', port: 465, secure: true } } }], records: [{ type: 'ins.memo', id: 'desktop-qa-note', category: 'todo', updatedAt: now, data: { title: 'Restored desktop note', createdAt: now, status: 'open', data: { content: 'Only synthetic QA content', collection: 'Desktop' } } }] }
const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()])
writeFileSync(process.argv[2], JSON.stringify({ app: 'linkto-backup', v: 2, kdf: 'scrypt', createdAt: now, hasSecrets: false, accountCount: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }))
key.fill(0)
