/**
 * Faux Groq Whisper et faux ElevenLabs.
 *
 * Astuce de test : un « vocal » est un vrai en-tête OGG suivi du texte prononcé.
 * Le faux Whisper relit ce texte ; le faux ElevenLabs fabrique un OGG contenant
 * la phrase dite. On peut donc vérifier mot pour mot ce qui est entendu et dit.
 */

import { startFakeServer } from './http.js'

const OGG_HEADER = Buffer.from('OggS\0\x02\0\0\0\0\0\0\0\0', 'binary')

export function fakeVoiceNote(spoken: string): Buffer {
  return Buffer.concat([OGG_HEADER, Buffer.from(spoken, 'utf8')])
}

export function spokenText(ogg: Buffer): string {
  return ogg.subarray(OGG_HEADER.length).toString('utf8')
}

export class FakeGroq {
  readonly requests: { model: string; language: string | null; fileType: string; fileName: string; size: number }[] = []
  url = ''
  /** Réponses HTTP forcées (ex. [500, 500] pour deux pannes). */
  failures: number[] = []
  private close: (() => Promise<void>) | null = null

  constructor(readonly apiKey = 'gsk_test') {}

  async start(): Promise<this> {
    const srv = await startFakeServer(async (req) => {
      if (req.method !== 'POST' || req.path !== '/openai/v1/audio/transcriptions') return { status: 404, body: { error: 'not found' } }
      if (req.headers.authorization !== `Bearer ${this.apiKey}`) return { status: 401, body: { error: { message: 'Invalid API Key' } } }
      const status = this.failures.shift()
      if (status) return { status, body: { error: { message: 'injected' } } }
      const form = await new Response(req.raw, { headers: { 'content-type': String(req.headers['content-type']) } }).formData()
      const file = form.get('file') as File | null
      if (!file) return { status: 400, body: { error: { message: 'file is required' } } }
      const bytes = Buffer.from(await file.arrayBuffer())
      this.requests.push({
        model: String(form.get('model')),
        language: form.get('language') as string | null,
        fileType: file.type,
        fileName: file.name,
        size: bytes.length,
      })
      if (form.get('model') !== 'whisper-large-v3-turbo') return { status: 400, body: { error: { message: 'model not found' } } }
      return { status: 200, bytes: Buffer.from(` ${spokenText(bytes)}\n`), contentType: 'text/plain' }
    })
    this.url = `${srv.url}/openai/v1`
    this.close = srv.close
    return this
  }

  async stop(): Promise<void> {
    await this.close?.()
  }
}

export class FakeElevenLabs {
  readonly spoken: { voiceId: string; text: string; outputFormat: string | null; model: string }[] = []
  url = ''
  down = false
  /** Latence simulée de la synthèse vocale (ElevenLabs met 1 à 3 s en vrai). */
  delayMs = 0
  private close: (() => Promise<void>) | null = null

  constructor(
    readonly apiKey = 'el_test',
    readonly voiceId = 'voice_fr',
  ) {}

  async start(): Promise<this> {
    const srv = await startFakeServer(async (req) => {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
      const m = req.path.match(/^\/v1\/text-to-speech\/([^/]+)$/)
      if (req.method !== 'POST' || !m) return { status: 404, body: { detail: 'not found' } }
      if (req.headers['xi-api-key'] !== this.apiKey) return { status: 401, body: { detail: 'invalid_api_key' } }
      if (this.down) return { status: 503, body: { detail: 'service unavailable' } }
      const body = req.json as { text?: string; model_id?: string }
      if (!body?.text) return { status: 422, body: { detail: 'text is required' } }
      this.spoken.push({ voiceId: m[1], text: body.text, outputFormat: req.query.get('output_format'), model: String(body.model_id) })
      return { status: 200, bytes: fakeVoiceNote(body.text), contentType: 'audio/ogg' }
    })
    this.url = srv.url
    this.close = srv.close
    return this
  }

  async stop(): Promise<void> {
    await this.close?.()
  }
}
