/**
 * Transcription des vocaux WhatsApp — Groq Whisper large-v3-turbo.
 * Même modèle et même stratégie de retry qu'AthenIA (providers/whisper.ts),
 * via l'API HTTP compatible OpenAI pour éviter une dépendance.
 */

import { getConfig } from '../config.js'
import { logger } from '../logger.js'

const log = logger.child({ module: 'stt' })

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
/** Réglages de retry (modifiables par les tests). */
export const sttRetry = { maxRetries: 3, backoffMs: 1500 }

export async function transcribe(audioBase64: string, language = getConfig().sttLanguage): Promise<string> {
  const { groqApiKey } = getConfig()
  if (!groqApiKey) throw new Error('GROQ_API_KEY manquant : impossible de transcrire le vocal')

  const audio = Buffer.from(audioBase64.includes(',') ? audioBase64.split(',')[1] : audioBase64, 'base64')

  let lastError: unknown
  for (let attempt = 1; attempt <= sttRetry.maxRetries; attempt++) {
    try {
      const form = new FormData()
      form.append('file', new Blob([audio], { type: 'audio/ogg' }), 'vocal.ogg')
      form.append('model', 'whisper-large-v3-turbo')
      form.append('response_format', 'text')
      if (language) form.append('language', language)

      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqApiKey}` },
        body: form,
      })
      if (!res.ok) {
        const body = await res.text()
        const err = new Error(`Groq STT ${res.status}: ${body.slice(0, 200)}`)
        if (res.status !== 429 && res.status < 500) throw Object.assign(err, { fatal: true })
        throw err
      }
      const text = (await res.text()).trim()
      log.info({ chars: text.length, attempt }, 'Vocal transcrit')
      return text
    } catch (err) {
      lastError = err
      if ((err as { fatal?: boolean }).fatal || attempt === sttRetry.maxRetries) break
      log.warn({ attempt, error: String(err) }, 'STT en échec — nouvel essai')
      await new Promise((r) => setTimeout(r, sttRetry.backoffMs * 2 ** (attempt - 1)))
    }
  }
  throw lastError
}
