import { parseMime, parseContentType, wrapHtml } from '../src/imap/MimeLite'

const b64 = (s: string) => btoa(s)
const latin1 = (s: string) => Array.from(new TextEncoder().encode(s), b => String.fromCharCode(b)).join('')

describe('MIME 解析', () => {
  it('text/plain UTF-8', () => {
    const raw = [
      'From: A <a@b.c>',
      'Subject: Hi',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      latin1('你好\r\n世界')
    ].join('\r\n')
    const m = parseMime(raw)
    expect(m.text).toContain('你好')
    expect(m.html).toBeNull()
  })

  it('multipart/alternative 取 HTML，base64 解码', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'plain fallback',
      '--B',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64('<p>HTML <b>body</b></p>'),
      '--B--',
      ''
    ].join('\r\n')
    const m = parseMime(raw)
    expect(m.html).toContain('<b>body</b>')
    expect(m.text).toContain('plain fallback')
  })

  it('multipart/mixed 收集附件元数据且不把附件当正文', () => {
    const raw = [
      'Content-Type: multipart/mixed; boundary="M"',
      '',
      '--M',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'see attachment',
      '--M',
      'Content-Type: application/pdf; name="a.pdf"',
      'Content-Disposition: attachment; filename="a.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      b64('%PDF-1.4 demo'),
      '--M--',
      ''
    ].join('\r\n')
    const m = parseMime(raw)
    expect(m.text).toContain('see attachment')
    expect(m.attachments).toHaveLength(1)
    expect(m.attachments[0].filename).toBe('a.pdf')
    expect(m.attachments[0].contentType).toBe('application/pdf')
  })

  it('quoted-printable + charset', () => {
    const raw = [
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'caf=C3=A9'
    ].join('\r\n')
    expect(parseMime(raw).text).toContain('café')
  })

  it('Content-Type 参数与 HTML 消毒/CSP', () => {
    const ct = parseContentType('multipart/mixed; boundary="x y"')
    expect(ct.params.boundary).toBe('x y')
    const wrapped = wrapHtml('<p onclick="x()">hi</p><script>alert(1)</script>', { showImages: false })
    expect(wrapped).not.toContain('onclick')
    expect(wrapped).not.toContain('<script>')
    expect(wrapped).toContain("img-src data:")
  })
})
