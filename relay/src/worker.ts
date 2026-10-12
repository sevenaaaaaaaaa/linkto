/**
 * LinkTo 幽灵信匿名中继（Phase B）
 *
 * 伪装：对外表现为一个普通的「笔记/待办同步 API」。
 * 真实作用：为端到端加密信封提供「取走即焚」的暂存柜。
 *
 * 设计承诺（可在自部署时审计验证）：
 *  - 只存密文：服务端无法解出任何内容（信封为 X25519 + AES-256-GCM 双因子包裹）
 *  - GET 即焚：收取接口一次性返回并立即删除，不留副本
 *  - 不记日志：不落访问日志、不做身份关联；folder 键是随机公钥哈希
 *  - 自动过期：72 小时未取即焚（防止死信堆积）
 *
 * 部署：见 relay/README.md（Cloudflare Workers + KV，一条命令）
 */

export interface Env {
  BOX: KVNamespace
}

const TTL_SECONDS = 72 * 3600
const MAX_CONTENT = 128 * 1024 // 单封密文上限（信封实际 ~2-8KB）
const MAX_ITEMS = 32 // 单 folder 积压上限，超收直接丢弃（防滥用塞柜）

interface ItemBody {
  client?: string
  v?: number
  item?: { id?: string; folder?: string; content?: string; meta?: Record<string, unknown> }
}

const FOLDER_RE = /^[0-9a-f]{16}$/

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (req.method === 'POST' && url.pathname === '/api/v1/items') {
      let body: ItemBody
      try {
        body = (await req.json()) as ItemBody
      } catch {
        return json({ error: 'bad json' }, 400)
      }
      const folder = body.item?.folder ?? ''
      const content = body.item?.content ?? ''
      if (!FOLDER_RE.test(folder)) return json({ error: 'bad folder' }, 400)
      if (!content || content.length > MAX_CONTENT) return json({ error: 'bad content' }, 400)
      const existing = ((await env.BOX.get(folder)) ?? '')
      const parts = existing ? existing.split('\u0000') : []
      if (parts.length >= MAX_ITEMS) return json({ error: 'full' }, 429)
      parts.push(content)
      await env.BOX.put(folder, parts.join('\u0000'), { expirationTtl: TTL_SECONDS })
      // 应答伪装成笔记写入成功
      return json({ ok: true, item: { id: body.item?.id, rev: Math.random().toString(36).slice(2, 10) } })
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/items') {
      const folder = url.searchParams.get('folder') ?? ''
      if (!FOLDER_RE.test(folder)) return json({ error: 'bad folder' }, 400)
      const raw = await env.BOX.get(folder)
      if (!raw) return json({ ok: true, items: [] })
      await env.BOX.delete(folder) // 取走即焚
      return json({
        ok: true,
        items: raw.split('\u0000').map(content => ({ content, read_at: Date.now() }))
      })
    }

    return json({ error: 'not found' }, 404)
  }
}