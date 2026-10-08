/**
 * Client Evolution API — envoi/réception WhatsApp.
 * Repris d'AthenIA (apps/negotiation-bot/src/providers/evolution.ts), simplifié.
 */

import { getConfig } from '../config.js'
import { logger } from '../logger.js'

const log = logger.child({ module: 'evolution' })

const RETRIES = 3

function stripDataUri(b64: string): string {
  return b64.includes(',') ? b64.split(',')[1] : b64
}

export class EvolutionClient {
  constructor(
    private baseUrl = getConfig().evolutionApiUrl,
    private apiKey = getConfig().evolutionApiKey,
    private instance = getConfig().evolutionInstance,
    private retryBaseMs = 1000,
  ) {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let lastError: unknown
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
          body: body ? JSON.stringify(body) : undefined,
        })
        if (!res.ok) {
          const text = await res.text()
          const err = new Error(`Evolution API ${res.status} sur ${path}: ${text.slice(0, 300)}`)
          // 4xx = erreur définitive, inutile de réessayer
          if (res.status < 500) throw Object.assign(err, { fatal: true })
          throw err
        }
        const text = await res.text()
        return (text ? JSON.parse(text) : {}) as T
      } catch (err) {
        lastError = err
        if ((err as { fatal?: boolean }).fatal || attempt === RETRIES) break
        await new Promise((r) => setTimeout(r, this.retryBaseMs * 2 ** (attempt - 1)))
      }
    }
    log.error({ path, error: String(lastError) }, 'Appel Evolution en échec')
    throw lastError
  }

  async sendText(to: string, text: string): Promise<void> {
    await this.request('POST', `/message/sendText/${this.instance}`, { number: to, text })
  }

  async sendImage(to: string, imageBase64: string, caption = '', mimetype: 'image/png' | 'image/jpeg' = 'image/png'): Promise<void> {
    await this.request('POST', `/message/sendMedia/${this.instance}`, {
      number: to,
      mediatype: 'image',
      mimetype,
      media: stripDataUri(imageBase64),
      fileName: mimetype === 'image/jpeg' ? 'photo.jpg' : 'apercu.png',
      caption,
    })
  }

  /** Note vocale WhatsApp (OGG/Opus en base64). */
  async sendVoice(to: string, oggBase64: string): Promise<void> {
    await this.request('POST', `/message/sendWhatsAppAudio/${this.instance}`, {
      number: to,
      audio: stripDataUri(oggBase64),
    })
  }

  /** Affiche « en train d'écrire… » chez l'utilisateur (best effort). */
  async typing(to: string, ms = 8000): Promise<void> {
    try {
      await this.request('POST', `/chat/sendPresence/${this.instance}`, {
        number: to,
        presence: 'composing',
        delay: ms,
      })
    } catch {
      /* purement cosmétique */
    }
  }

  /** Télécharge le média (vocal, photo) d'un message reçu, en base64. */
  async getMediaBase64(messageId: string): Promise<string> {
    const result = await this.request<{ base64: string }>(
      'POST',
      `/chat/getBase64FromMediaMessage/${this.instance}`,
      { message: { key: { id: messageId } }, convertToMp4: false },
    )
    return result.base64
  }

  async createInstance(webhookUrl: string): Promise<unknown> {
    return this.request('POST', '/instance/create', {
      instanceName: this.instance,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      webhook: {
        url: webhookUrl,
        byEvents: false,
        base64: false,
        events: ['MESSAGES_UPSERT'],
      },
    })
  }

  async setWebhook(webhookUrl: string): Promise<unknown> {
    return this.request('POST', `/webhook/set/${this.instance}`, {
      webhook: {
        enabled: true,
        url: webhookUrl,
        byEvents: false,
        base64: false,
        events: ['MESSAGES_UPSERT'],
      },
    })
  }

  async getQrCode(): Promise<{ base64?: string; code?: string }> {
    return this.request('GET', `/instance/connect/${this.instance}`)
  }

  async getConnectionState(): Promise<string> {
    const res = await this.request<{ instance?: { state?: string }; state?: string }>(
      'GET',
      `/instance/connectionState/${this.instance}`,
    )
    return res.instance?.state ?? res.state ?? 'unknown'
  }
}

let client: EvolutionClient | null = null
export function getEvolution(): EvolutionClient {
  if (!client) client = new EvolutionClient()
  return client
}
