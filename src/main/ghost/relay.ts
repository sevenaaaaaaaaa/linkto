import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { fingerprintOf } from './envelope'

/**
 * 幽灵信「匿名中继」通道（Phase B 落地，信封 ch='relay'）
 *
 * 伪装模型（对网关可见的部分）：
 *  - 出站 = 一条普通 HTTPS POST，形如第三方笔记/待办同步 API（application/json）
 *  - 载荷字段全部中性命名：folder（收件人指纹 hex）/ content（密文 base64）/ pad（随机长度填充）
 *  - 网关看不到：收发件人邮箱、主题、正文、任何 SMTP/IMAP 特征
 *  - 中继本身只见密文 + 收件人指纹（指纹是随机公钥哈希，不关联现实身份）
 *
 * 取走即焚：GET 即返回并删除（服务端 one-time），中继不留副本。
 */

const PAD_MIN = 256
const PAD_MAX = 2048

function folderOf(spkiB64: string): string {
  // 服务器路由键 = 公钥哈希前 16 hex（与 UI 指纹同源不同长）
  return createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').slice(0, 16)
}

/** 投递一封密文到中继（伪装为笔记同步写入） */
export async function relaySend(relayBase: string, recipientSpkiB64: string, envelopeJson: string): Promise<void> {
  const base = relayBase.replace(/\/+$/, '')
  const body = {
    client: 'notes',
    v: 1,
    item: {
      id: randomUUID(),
      folder: folderOf(recipientSpkiB64),
      content: Buffer.from(envelopeJson, 'utf8').toString('base64'),
      meta: { p: randomBytes(PAD_MIN + Math.floor(Math.random() * (PAD_MAX - PAD_MIN))).toString('hex') }
    }
  }
  const res = await fetch(`${base}/api/v1/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`中继投递失败：HTTP ${res.status}`)
}

/** 从中继拉取发往本机幽灵身份的密文（GET 即取走即焚，服务端不留副本） */
export async function relayPoll(relayBase: string, mySpkiB64: string): Promise<string[]> {
  const base = relayBase.replace(/\/+$/, '')
  const res = await fetch(`${base}/api/v1/items?folder=${folderOf(mySpkiB64)}`, {
    headers: { accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`中继收取失败：HTTP ${res.status}`)
  const data = (await res.json()) as { items?: Array<{ content?: string }> }
  return (data.items ?? [])
    .map(i => {
      try {
        return Buffer.from(i.content ?? '', 'base64').toString('utf8')
      } catch {
        return ''
      }
    })
    .filter(s => s.startsWith('{'))
}

/** 用指纹的紧凑 hex 形式做对外交换的「中继地址」（发信时对方填这串即可） */
export function relayFingerprint(spkiB64: string): string {
  return createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest('hex').slice(0, 16)
}

export { fingerprintOf }