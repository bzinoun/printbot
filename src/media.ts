/**
 * Formats des médias WhatsApp.
 *
 * Pour qu'une image s'affiche DANS la conversation (et pas comme un fichier joint),
 * elle doit partir en « image » au format JPEG. Les aperçus OpenSCAD sont des PNG :
 * on les convertit ici. Les notes vocales doivent être en OGG/Opus.
 */

import sharp from 'sharp'
import { logger } from './logger.js'

const log = logger.child({ module: 'media' })

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'unknown'
export type AudioFormat = 'ogg' | 'mp3' | 'wav' | 'unknown'

/** Taille maximale d'une image envoyée (WhatsApp recompresse au-delà). */
export const MAX_IMAGE_SIZE = 1600

export function detectImageFormat(buf: Buffer): ImageFormat {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif'
  return 'unknown'
}

export function detectAudioFormat(buf: Buffer): AudioFormat {
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') return 'ogg'
  if (buf.length >= 3 && (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return 'mp3'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav'
  return 'unknown'
}

export interface WhatsAppImage {
  data: Buffer
  mimetype: 'image/jpeg' | 'image/png'
}

/**
 * Prépare une image pour un affichage dans la conversation : JPEG, ≤ 1600 px,
 * transparence aplatie sur blanc. Un JPEG déjà raisonnable passe tel quel.
 * En cas d'échec de conversion, l'image d'origine est renvoyée (jamais d'exception).
 */
export async function toWhatsAppJpeg(input: Buffer): Promise<WhatsAppImage> {
  const format = detectImageFormat(input)
  try {
    if (format === 'jpeg') {
      const meta = await sharp(input).metadata()
      if ((meta.width ?? 0) <= MAX_IMAGE_SIZE && (meta.height ?? 0) <= MAX_IMAGE_SIZE) return { data: input, mimetype: 'image/jpeg' }
    }
    const data = await sharp(input)
      .rotate()
      .resize({ width: MAX_IMAGE_SIZE, height: MAX_IMAGE_SIZE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer()
    return { data, mimetype: 'image/jpeg' }
  } catch (err) {
    log.warn({ format, error: String(err) }, 'Conversion JPEG impossible — envoi de l’image d’origine')
    return { data: input, mimetype: format === 'png' ? 'image/png' : 'image/jpeg' }
  }
}
