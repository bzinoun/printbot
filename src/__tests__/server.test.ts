import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConfig } from './helpers.js'

const h = vi.hoisted(() => ({
  handleIncoming: vi.fn(async (_msg: unknown) => {}),
  evo: {
    getConnectionState: vi.fn(async () => 'open'),
    getQrCode: vi.fn(async () => ({ base64: 'data:image/png;base64,QR' })),
  },
}))
vi.mock('../bot.js', () => ({ handleIncoming: h.handleIncoming }))
vi.mock('../providers/evolution.js', () => ({ getEvolution: () => h.evo }))

const { createServer } = await import('../server.js')

let server: Server
let base: string

beforeEach(async () => {
  useConfig()
  vi.clearAllMocks()
  h.handleIncoming.mockImplementation(async () => {})
  h.evo.getConnectionState.mockImplementation(async () => 'open')
  server = createServer().listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(() => new Promise((r) => server.close(r)))

const upsert = (text: string, id = 'M1') => ({
  event: 'messages.upsert',
  instance: 'printbot',
  data: { key: { remoteJid: '212600000001@s.whatsapp.net', fromMe: false, id }, messageType: 'conversation', message: { conversation: text } },
})
const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('webhook', () => {
  it('transmet le message au bot et répond 200', async () => {
    const res = await post('/webhook', upsert('Bonjour'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(h.handleIncoming).toHaveBeenCalledWith(expect.objectContaining({ id: 'M1', number: '212600000001', kind: 'text', text: 'Bonjour' }))
  })

  it('répond immédiatement même si le traitement dure (Claude = minutes)', async () => {
    h.handleIncoming.mockImplementation(() => new Promise(() => {}))
    const started = Date.now()
    const res = await post('/webhook', upsert('un vase'))
    expect(res.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('accepte l’URL suffixée par l’événement', async () => {
    await post('/webhook/messages-upsert', upsert('x'))
    expect(h.handleIncoming).toHaveBeenCalledTimes(1)
  })

  it('ignore les autres événements', async () => {
    const res = await post('/webhook', { event: 'connection.update', data: { state: 'open' } })
    expect(res.status).toBe(200)
    expect(h.handleIncoming).not.toHaveBeenCalled()
  })

  it('une erreur du bot ne fait pas tomber le serveur', async () => {
    h.handleIncoming.mockRejectedValueOnce(new Error('boom'))
    await post('/webhook', upsert('a', 'A'))
    const res = await post('/webhook', upsert('b', 'B'))
    expect(res.status).toBe(200)
    expect(h.handleIncoming).toHaveBeenCalledTimes(2)
  })

  it('JSON invalide → 400, sans appel au bot', async () => {
    const res = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' })
    expect(res.status).toBe(400)
    expect(h.handleIncoming).not.toHaveBeenCalled()
  })

  it('accepte un gros média en base64 (jusqu’à 25 Mo)', async () => {
    const res = await post('/webhook', { ...upsert('x'), padding: 'A'.repeat(5_000_000) })
    expect(res.status).toBe(200)
  })
})

describe('santé et QR', () => {
  it('/health : état WhatsApp', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, whatsapp: 'open' })
  })

  it('/health : Evolution injoignable', async () => {
    h.evo.getConnectionState.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, whatsapp: 'unreachable' })
  })

  it('/qr.json : déjà connecté → pas de QR', async () => {
    expect(await (await fetch(`${base}/qr.json`)).json()).toEqual({ state: 'open' })
    expect(h.evo.getQrCode).not.toHaveBeenCalled()
  })

  it('/qr.json : pas connecté → QR', async () => {
    h.evo.getConnectionState.mockResolvedValue('close')
    expect(await (await fetch(`${base}/qr.json`)).json()).toEqual({ state: 'close', qr: 'data:image/png;base64,QR' })
  })

  it('/qr.json : QR indisponible → 502', async () => {
    h.evo.getConnectionState.mockResolvedValue('close')
    h.evo.getQrCode.mockRejectedValueOnce(new Error('instance absente'))
    const res = await fetch(`${base}/qr.json`)
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: string }).error).toContain('instance absente')
  })

  it('/qr : page HTML', async () => {
    const res = await fetch(`${base}/qr`)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('PrintBot')
  })
})
