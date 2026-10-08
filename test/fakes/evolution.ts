/**
 * Faux Evolution API v2 — aussi strict que le vrai sur ce qui compte pour la démo.
 *
 * Il valide chaque appel (clé API, instance, champs obligatoires, base64 brut,
 * légende ≤ 1024 caractères) et classe ce que verrait le téléphone :
 *   sendText                         → « text »
 *   sendMedia  mediatype=image       → « image »    (affichée dans la conversation)
 *   sendMedia  mediatype=document    → « document » (fichier joint : à éviter)
 *   sendMedia  mediatype=audio       → « audio_file » (fichier audio : à éviter)
 *   sendWhatsAppAudio                → « voice »    (note vocale avec onde)
 * Il simule aussi les messages entrants (webhook) et le téléchargement des médias.
 */

import { randomUUID } from 'node:crypto'
import { detectAudioFormat, detectImageFormat } from '../../src/media.js'
import { startFakeServer, type FakeRequest, type FakeResponse } from './http.js'

export type DeliveredKind = 'text' | 'image' | 'document' | 'video' | 'audio_file' | 'voice'

export interface Delivered {
  to: string
  kind: DeliveredKind
  /** Texte du message ou légende de l'image. */
  text: string
  data?: Buffer
  mimetype?: string
  fileName?: string
  /** Format réel détecté dans les octets (jpeg, png, ogg…). */
  format?: string
  at: number
}

export interface RecordedCall {
  method: string
  path: string
  body: unknown
  status: number
  error?: string
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const NUMBER = /^(\d{8,15}|[\w.-]+@(s\.whatsapp\.net|lid|g\.us))$/
export const WHATSAPP_CAPTION_LIMIT = 1024

export class FakeEvolution {
  readonly delivered: Delivered[] = []
  readonly calls: RecordedCall[] = []
  /** Médias des messages entrants, par identifiant de message. */
  private readonly incomingMedia = new Map<string, { base64: string; mimetype: string }>()
  private failures: { match: string; status: number; times: number }[] = []
  state = 'open'
  url = ''
  private closeServer: (() => Promise<void>) | null = null

  constructor(
    readonly apiKey = 'test-evo-key',
    readonly instance = 'printbot',
  ) {}

  async start(): Promise<this> {
    const srv = await startFakeServer((req) => this.handle(req))
    this.url = srv.url
    this.closeServer = srv.close
    return this
  }

  async stop(): Promise<void> {
    await this.closeServer?.()
  }

  /** Les `times` prochains appels dont le chemin contient `match` échouent avec `status`. */
  failNext(match: string, status: number, times = 1): void {
    this.failures.push({ match, status, times })
  }

  sent(kind?: DeliveredKind): Delivered[] {
    return kind ? this.delivered.filter((d) => d.kind === kind) : this.delivered
  }

  texts(): string[] {
    return this.sent('text').map((d) => d.text)
  }

  // ── Réception ────────────────────────────────────────────────

  private bad(req: FakeRequest, message: string): FakeResponse {
    this.calls.push({ method: req.method, path: req.path, body: req.json, status: 400, error: message })
    return { status: 400, body: { status: 400, error: 'Bad Request', response: { message: [message] } } }
  }

  private async handle(req: FakeRequest): Promise<FakeResponse> {
    if (req.headers.apikey !== this.apiKey) {
      this.calls.push({ method: req.method, path: req.path, body: req.json, status: 401 })
      return { status: 401, body: { status: 401, error: 'Unauthorized' } }
    }
    const failure = this.failures.find((f) => f.times > 0 && req.path.includes(f.match))
    if (failure) {
      failure.times--
      this.calls.push({ method: req.method, path: req.path, body: req.json, status: failure.status })
      return { status: failure.status, body: { error: 'injected failure' } }
    }

    const [, group, action, instance] = req.path.split('/')
    if (instance && instance !== this.instance && group !== 'instance') {
      return { status: 404, body: { error: `instance ${instance} introuvable` } }
    }
    const body = (req.json ?? {}) as Record<string, unknown>
    const route = `${req.method} /${group}/${action}`
    const ok = (payload: unknown, status = 201): FakeResponse => {
      this.calls.push({ method: req.method, path: req.path, body: req.json, status })
      return { status, body: payload }
    }

    switch (route) {
      case 'GET /instance/connectionState':
        return ok({ instance: { instanceName: this.instance, state: this.state } }, 200)
      case 'GET /instance/connect':
        return ok({ base64: 'data:image/png;base64,QR', code: '2@fake' }, 200)
      case 'POST /instance/create':
        return ok({ instance: { instanceName: body.instanceName, status: 'created' } })
      case 'POST /webhook/set':
        return ok({ webhook: body.webhook })
      case 'POST /chat/sendPresence':
        if (typeof body.number !== 'string') return this.bad(req, 'number is required')
        return ok({ presence: body.presence }, 200)

      case 'POST /chat/getBase64FromMediaMessage': {
        const id = (body.message as { key?: { id?: string } } | undefined)?.key?.id
        const media = id ? this.incomingMedia.get(id) : undefined
        if (!media) return this.bad(req, `Message ${id} introuvable ou sans média`)
        return ok({ mediaType: media.mimetype.split('/')[0], mimetype: media.mimetype, base64: media.base64 }, 200)
      }

      case 'POST /message/sendText': {
        if (typeof body.number !== 'string' || !NUMBER.test(body.number)) return this.bad(req, 'number invalide')
        if (typeof body.text !== 'string' || !body.text.trim()) return this.bad(req, 'text is required')
        this.deliver({ to: body.number, kind: 'text', text: body.text })
        return ok(this.ack(body.number))
      }

      case 'POST /message/sendMedia': {
        if (typeof body.number !== 'string' || !NUMBER.test(body.number)) return this.bad(req, 'number invalide')
        const mediatype = body.mediatype
        if (!['image', 'document', 'video', 'audio'].includes(String(mediatype))) return this.bad(req, 'mediatype invalide')
        if (typeof body.media !== 'string' || !body.media) return this.bad(req, 'media is required')
        if (body.media.startsWith('data:')) return this.bad(req, 'media : base64 brut attendu (pas de préfixe data:)')
        if (!BASE64.test(body.media)) return this.bad(req, 'media : base64 invalide')
        const caption = typeof body.caption === 'string' ? body.caption : ''
        if (caption.length > WHATSAPP_CAPTION_LIMIT) return this.bad(req, 'caption trop longue')
        const data = Buffer.from(body.media, 'base64')
        const kind: DeliveredKind = mediatype === 'image' ? 'image' : mediatype === 'audio' ? 'audio_file' : (mediatype as DeliveredKind)
        this.deliver({
          to: body.number,
          kind,
          text: caption,
          data,
          mimetype: String(body.mimetype ?? ''),
          fileName: typeof body.fileName === 'string' ? body.fileName : undefined,
          format: kind === 'audio_file' ? detectAudioFormat(data) : detectImageFormat(data),
        })
        return ok(this.ack(body.number))
      }

      case 'POST /message/sendWhatsAppAudio': {
        if (typeof body.number !== 'string' || !NUMBER.test(body.number)) return this.bad(req, 'number invalide')
        if (typeof body.audio !== 'string' || !body.audio) return this.bad(req, 'audio is required')
        if (body.audio.startsWith('data:') || !BASE64.test(body.audio)) return this.bad(req, 'audio : base64 brut attendu')
        const data = Buffer.from(body.audio, 'base64')
        this.deliver({ to: body.number, kind: 'voice', text: '', data, format: detectAudioFormat(data) })
        return ok(this.ack(body.number))
      }

      default:
        this.calls.push({ method: req.method, path: req.path, body: req.json, status: 404 })
        return { status: 404, body: { error: `route inconnue ${route}` } }
    }
  }

  private deliver(d: Omit<Delivered, 'at'>): void {
    this.delivered.push({ ...d, at: Date.now() })
  }

  private ack(number: string) {
    return { key: { remoteJid: `${number}@s.whatsapp.net`, fromMe: true, id: randomUUID().slice(0, 20).toUpperCase() }, status: 'PENDING' }
  }

  // ── Messages entrants (ce que l'utilisateur envoie depuis son téléphone) ──

  private payload(from: string, id: string, messageType: string, message: object, pushName = 'Badr') {
    return {
      event: 'messages.upsert',
      instance: this.instance,
      data: { key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false, id }, pushName, messageType, message, messageTimestamp: Math.floor(Date.now() / 1000) },
      destination: 'http://bot/webhook',
      date_time: new Date().toISOString(),
      sender: '212699999999@s.whatsapp.net',
      server_url: this.url,
      apikey: this.apiKey,
    }
  }

  private async post(botUrl: string, payload: object): Promise<void> {
    const res = await fetch(`${botUrl}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    if (!res.ok) throw new Error(`webhook ${res.status}`)
  }

  async userText(botUrl: string, from: string, text: string): Promise<string> {
    const id = randomUUID()
    await this.post(botUrl, this.payload(from, id, 'conversation', { conversation: text }))
    return id
  }

  async userVoice(botUrl: string, from: string, ogg: Buffer): Promise<string> {
    const id = randomUUID()
    this.incomingMedia.set(id, { base64: ogg.toString('base64'), mimetype: 'audio/ogg; codecs=opus' })
    await this.post(botUrl, this.payload(from, id, 'audioMessage', { audioMessage: { url: 'https://mmg.whatsapp.net/x', mimetype: 'audio/ogg; codecs=opus', seconds: 3, ptt: true } }))
    return id
  }

  async userImage(botUrl: string, from: string, jpeg: Buffer, caption?: string): Promise<string> {
    const id = randomUUID()
    this.incomingMedia.set(id, { base64: jpeg.toString('base64'), mimetype: 'image/jpeg' })
    await this.post(botUrl, this.payload(from, id, 'imageMessage', { imageMessage: { url: 'https://mmg.whatsapp.net/y', mimetype: 'image/jpeg', caption } }))
    return id
  }
}
