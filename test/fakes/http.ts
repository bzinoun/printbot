import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: http.IncomingHttpHeaders
  raw: Buffer
  json: unknown
}

export interface FakeResponse {
  status: number
  body?: unknown
  /** Corps binaire (prioritaire sur body). */
  bytes?: Buffer
  contentType?: string
}

export type Handler = (req: FakeRequest) => FakeResponse | Promise<FakeResponse>

/** Petit serveur HTTP de test : lit le corps, appelle le handler, renvoie JSON ou binaire. */
export async function startFakeServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks)
    const u = new URL(req.url ?? '/', 'http://fake')
    let json: unknown
    if ((req.headers['content-type'] ?? '').includes('application/json') && raw.length) {
      try {
        json = JSON.parse(raw.toString('utf8'))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"invalid json"}')
        return
      }
    }
    try {
      const out = await handler({ method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: req.headers, raw, json })
      if (out.bytes) {
        res.writeHead(out.status, { 'Content-Type': out.contentType ?? 'application/octet-stream' }).end(out.bytes)
      } else {
        res.writeHead(out.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.body ?? {}))
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(err) }))
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.close(() => r())
        server.closeAllConnections()
      }),
  }
}
