import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { detectAudioFormat, detectImageFormat, MAX_IMAGE_SIZE, toWhatsAppJpeg } from '../media.js'

const img = (w: number, h: number, alpha = false) =>
  sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : '#3366aa' } })

describe('detectImageFormat / detectAudioFormat', () => {
  it('reconnaît les formats par leur signature', async () => {
    expect(detectImageFormat(await img(4, 4).jpeg().toBuffer())).toBe('jpeg')
    expect(detectImageFormat(await img(4, 4).png().toBuffer())).toBe('png')
    expect(detectImageFormat(await img(4, 4).webp().toBuffer())).toBe('webp')
    expect(detectImageFormat(Buffer.from('GIF89a…'))).toBe('gif')
    expect(detectImageFormat(Buffer.from('pas une image'))).toBe('unknown')
    expect(detectImageFormat(Buffer.alloc(0))).toBe('unknown')
  })

  it('audio : OGG (note vocale), MP3, WAV', () => {
    expect(detectAudioFormat(Buffer.from('OggS\0\x02rest'))).toBe('ogg')
    expect(detectAudioFormat(Buffer.from('ID3\x04rest'))).toBe('mp3')
    expect(detectAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3')
    expect(detectAudioFormat(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBe('wav')
    expect(detectAudioFormat(Buffer.from('????'))).toBe('unknown')
  })
})

describe('toWhatsAppJpeg', () => {
  it('aperçu OpenSCAD (PNG) → JPEG, mêmes dimensions', async () => {
    const out = await toWhatsAppJpeg(await img(1080, 1080).png().toBuffer())
    expect(out.mimetype).toBe('image/jpeg')
    expect(detectImageFormat(out.data)).toBe('jpeg')
    expect(await sharp(out.data).metadata()).toMatchObject({ width: 1080, height: 1080, format: 'jpeg' })
  })

  it('transparence aplatie sur blanc (pas de fond noir dans WhatsApp)', async () => {
    const out = await toWhatsAppJpeg(await img(8, 8, true).png().toBuffer())
    const { data } = await sharp(out.data).raw().toBuffer({ resolveWithObject: true })
    expect(data[0]).toBeGreaterThan(240)
    expect(data[1]).toBeGreaterThan(240)
    expect(data[2]).toBeGreaterThan(240)
  })

  it('capture Retina énorme → réduite à 1600 px, proportions gardées', async () => {
    const out = await toWhatsAppJpeg(await img(3456, 2234).jpeg().toBuffer())
    const meta = await sharp(out.data).metadata()
    expect(meta.width).toBe(MAX_IMAGE_SIZE)
    expect(meta.height).toBe(Math.round((2234 * MAX_IMAGE_SIZE) / 3456))
  })

  it('JPEG déjà raisonnable → envoyé tel quel (pas de recompression)', async () => {
    const jpeg = await img(800, 600).jpeg().toBuffer()
    const out = await toWhatsAppJpeg(jpeg)
    expect(out.data).toBe(jpeg)
    expect(out.mimetype).toBe('image/jpeg')
  })

  it('WebP → JPEG', async () => {
    const out = await toWhatsAppJpeg(await img(20, 20).webp().toBuffer())
    expect(detectImageFormat(out.data)).toBe('jpeg')
  })

  it('fichier corrompu → renvoyé tel quel, sans exception', async () => {
    const junk = Buffer.from('ceci n’est pas une image')
    await expect(toWhatsAppJpeg(junk)).resolves.toEqual({ data: junk, mimetype: 'image/jpeg' })
    const brokenPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('tronqué')])
    await expect(toWhatsAppJpeg(brokenPng)).resolves.toEqual({ data: brokenPng, mimetype: 'image/png' })
  })
})
