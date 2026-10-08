/**
 * Réponses vocales — ElevenLabs eleven_multilingual_v2, sortie OGG/Opus
 * directement au format note vocale WhatsApp (comme AthenIA).
 * Optionnel : désactivé si la clé ou la voix ne sont pas configurées.
 */

import { getConfig } from '../config.js'
import { logger } from '../logger.js'

const log = logger.child({ module: 'tts' })

export function ttsEnabled(): boolean {
  const c = getConfig()
  return c.voiceReplies && Boolean(c.elevenLabsApiKey && c.elevenLabsVoiceId)
}

/** Nettoie un texte WhatsApp (emojis, *gras*, unités) pour qu'il se prononce bien. */
export function toSpeakable(text: string): string {
  return text
    .replace(/~\s*(?=\d)/g, 'environ ')
    .replace(/[*_~`]/g, '')
    .replace(/\p{Extended_Pictographic}|️/gu, '')
    .replace(/(\d+)\s*[×x]\s*(\d+)\s*[×x]\s*(\d+)/g, '$1 par $2 par $3')
    .replace(/(\d)\s*mm\b/g, '$1 millimètres')
    .replace(/(\d)\s*cm\b/g, '$1 centimètres')
    .replace(/(\d)\s*min\b/g, '$1 minutes')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Retourne une note vocale OGG/Opus en base64, ou null si le TTS est indisponible. */
export async function synthesize(text: string): Promise<string | null> {
  if (!ttsEnabled()) return null
  const { elevenLabsApiKey, elevenLabsVoiceId, elevenLabsApiUrl } = getConfig()
  const speakable = toSpeakable(text).slice(0, 600)
  if (!speakable) return null

  try {
    const res = await fetch(
      `${elevenLabsApiUrl.replace(/\/$/, '')}/v1/text-to-speech/${elevenLabsVoiceId}?output_format=opus_48000_64`,
      {
        method: 'POST',
        headers: { 'xi-api-key': elevenLabsApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: speakable,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2 },
        }),
      },
    )
    if (!res.ok) {
      log.warn({ status: res.status, body: (await res.text()).slice(0, 200) }, 'TTS en échec')
      return null
    }
    return Buffer.from(await res.arrayBuffer()).toString('base64')
  } catch (err) {
    log.warn({ error: String(err) }, 'TTS en échec')
    return null
  }
}
