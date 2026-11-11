jest.mock('react-native-tcp-socket', () => ({ __esModule: true, default: {} }))
import TcpSocket from 'react-native-tcp-socket'
import { SmtpLite } from '../src/smtp/SmtpLite'

function server(startTls: boolean) {
  const writes: Array<{ encrypted: boolean; line: string }> = []
  const socket = (encrypted: boolean) => {
    const listeners = new Map<string, (...args: any[]) => void>()
    const emit = (data: string) => { void Promise.resolve().then(() => listeners.get('data')?.(data)) }
    const result = {
      setTimeout: jest.fn(), destroy: jest.fn(),
      on: (event: string, handler: (...args: any[]) => void) => {
        listeners.set(event, handler)
        if (event === 'data' && !encrypted) emit('220 smtp.example.com ready\r\n')
        return result
      },
      removeListener: (event: string) => listeners.delete(event),
      write: (raw: string) => {
        const line = raw.trim()
        writes.push({ encrypted, line })
        if (line.startsWith('EHLO')) emit('250-server\r\n' + (startTls && !encrypted ? '250-STARTTLS\r\n' : '') + '250 AUTH XOAUTH2\r\n')
        else if (line === 'STARTTLS') emit('220 begin TLS\r\n')
        else if (line.startsWith('AUTH XOAUTH2')) emit('235 authenticated\r\n')
        else if (line.startsWith('MAIL') || line.startsWith('RCPT') || line === '.') emit('250 accepted\r\n')
        else if (line === 'DATA') emit('354 continue\r\n')
      }
    }
    return result
  }
  const plain = socket(false), tls = socket(true)
  ;(TcpSocket as any).createConnection = (_: unknown, cb: () => void) => { void Promise.resolve().then(cb); return plain }
  ;(TcpSocket as any).TLSSocket = jest.fn(function () { return tls })
  return writes
}

test('STARTTLS consumes multiline replies and authenticates only on the upgraded socket', async () => {
  const writes = server(true)
  const smtp = new SmtpLite()
  await smtp.connect({ host: 'smtp.example.com', port: 587, secure: false, user: 'me@example.com', pass: '', accessToken: 'private-token' })
  await smtp.send({ from: 'me@example.com', to: ['you@example.com'], subject: '邮件', text: '内容' })
  expect(writes.filter(w => !w.encrypted).map(w => w.line)).toEqual(['EHLO linkto.mobile', 'STARTTLS'])
  expect(writes.some(w => w.encrypted && w.line.startsWith('AUTH XOAUTH2 '))).toBe(true)
  expect(writes.some(w => w.encrypted && w.line === '.')).toBe(true)
  await smtp.close()
})

test('a server without STARTTLS never receives credentials', async () => {
  const writes = server(false)
  const smtp = new SmtpLite()
  await expect(smtp.connect({ host: 'smtp.example.com', port: 587, secure: false, user: 'me@example.com', pass: 'private' })).rejects.toThrow('未提供 STARTTLS')
  expect(writes.map(w => w.line)).toEqual(['EHLO linkto.mobile'])
  await smtp.close()
})
