import http from 'node:http'
import worker from '../relay/src/worker.ts'

const store = new Map<string, string>()
const env: any = {
  BOX: {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
    const request = new Request('http://127.0.0.1:8787' + (req.url ?? '/'), {
      method: req.method,
      headers,
      ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {})
    })
    const response = await worker.fetch(request, env)
    const out: Record<string, string> = {}
    response.headers.forEach((v, k) => { out[k] = v })
    res.writeHead(response.status, out)
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (err) {
    console.error('relay error', err)
    res.writeHead(500).end('relay error')
  }
})
server.listen(8787, '127.0.0.1', () => console.log('fly relay listening http://127.0.0.1:8787'))
