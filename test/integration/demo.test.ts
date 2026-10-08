/**
 * Tests d'intégration : la démo complète, jouée de bout en bout.
 * Vrai serveur PrintBot (webhook HTTP, machine à états, conversion d'images,
 * suivi d'impression, capture caméra) ; tout le reste est simulé.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WHATSAPP_CAPTION_LIMIT, type FakeEvolution } from '../fakes/evolution.js'
import { spokenText } from '../fakes/voice.js'
import { ME, MINUTE_MS, STRANGER, startStack, type Stack } from './stack.js'

let s: Stack
beforeEach(async () => {
  s = await startStack()
})
afterEach(async () => {
  await s.stop()
})

/**
 * Règle d'or WhatsApp, vérifiée après chaque scénario :
 * images = JPEG affichés dans la conversation, audio = notes vocales OGG,
 * jamais de fichier joint, aucune requête refusée par WhatsApp.
 */
function expectWhatsAppFriendly(evo: FakeEvolution) {
  const kinds = evo.delivered.map((d) => d.kind)
  expect(kinds, 'aucun fichier joint').not.toContain('document')
  expect(kinds, 'aucun fichier audio').not.toContain('audio_file')
  for (const img of evo.sent('image')) {
    expect(img.mimetype, 'image annoncée en JPEG').toBe('image/jpeg')
    expect(img.format, 'octets réellement JPEG').toBe('jpeg')
    expect(img.fileName).toMatch(/\.jpe?g$/)
    expect(img.text.length).toBeLessThanOrEqual(WHATSAPP_CAPTION_LIMIT)
  }
  for (const v of evo.sent('voice')) expect(v.format, 'note vocale OGG/Opus').toBe('ogg')
  const refused = evo.calls.filter((c) => c.status >= 400 && c.status !== 503)
  expect(refused, `requêtes refusées : ${JSON.stringify(refused)}`).toEqual([])
}

const images = () => s.evo.sent('image')
const voices = () => s.evo.sent('voice').map((v) => spokenText(v.data!))
const lastText = () => s.evo.texts().at(-1) ?? ''

// ══════════════════════════════════════════════════════════════════

describe('demande → aperçu', () => {
  it('message texte : accusé, aperçu 3D en JPEG affiché avec légende, puis note vocale', async () => {
    await s.text('Fais-moi un porte-clé AUSIM')
    await s.until(() => expect(voices()).toHaveLength(1))

    expect(s.evo.texts()[0]).toMatch(/^🎨/)
    expect(images()).toHaveLength(1)
    const preview = images()[0]
    expect(preview.to).toBe(ME)
    expect(preview.text).toContain('🧊 *Porte-clé AUSIM*')
    expect(preview.text).toContain('📐 50 × 20 × 4 mm')
    expect(preview.text).toContain('Réponds *oui* pour imprimer')
    // l'aperçu PNG d'OpenSCAD a bien été converti en JPEG 1080×1080
    expect(await sharp(preview.data!).metadata()).toMatchObject({ format: 'jpeg', width: 1080, height: 1080 })

    // la note vocale arrive APRÈS l'image et dit la phrase prévue par Claude
    expect(s.evo.delivered.findIndex((d) => d.kind === 'voice')).toBeGreaterThan(s.evo.delivered.findIndex((d) => d.kind === 'image'))
    expect(voices()[0]).toBe('Voici ton porte-clé AUSIM. Je lance ?')
    expect(s.eleven.spoken[0]).toMatchObject({ outputFormat: 'opus_48000_64', model: 'eleven_multilingual_v2', voiceId: 'voice_fr' })

    const [call] = s.claudeCalls()
    expect(call.prompt).toContain('DEMANDE de Badr : Fais-moi un porte-clé AUSIM')
    expect(call.args).toContain('--disallowedTools')
    expectWhatsAppFriendly(s.evo)
  })

  it('note vocale : téléchargée, transcrite en français, répétée, puis conçue', async () => {
    await s.voice('Un support de téléphone avec AUSIM gravé')
    await s.until(() => expect(images()).toHaveLength(1))

    expect(s.groq.requests).toEqual([{ model: 'whisper-large-v3-turbo', language: 'fr', fileType: 'audio/ogg', fileName: 'vocal.ogg', size: expect.any(Number) }])
    expect(s.evo.calls.some((c) => c.path.startsWith('/chat/getBase64FromMediaMessage'))).toBe(true)
    expect(s.evo.texts()[0]).toBe('🎤 _« Un support de téléphone avec AUSIM gravé »_')
    expect(s.claudeCalls()[0].prompt).toContain('Un support de téléphone avec AUSIM gravé')
    expectWhatsAppFriendly(s.evo)
  })

  it('photo d’un croquis : image transmise à Claude à l’identique, nouvel aperçu', async () => {
    const sketch = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#ffffff' } }).jpeg().toBuffer()
    await s.image(sketch, 'Fais ce dessin en 3D')
    await s.until(() => expect(images()).toHaveLength(1))

    const [call] = s.claudeCalls()
    expect(call.hasInput).toBe(true)
    expect(readFileSync(path.join(call.cwd, 'input.jpg')).equals(sketch)).toBe(true)
    expect(call.prompt).toContain('Fais ce dessin en 3D')
    expectWhatsAppFriendly(s.evo)
  })
})

describe('la démo complète, du vocal à l’objet prêt', () => {
  it('demande → modification → « oui » vocal → impression → photo « ça imprime » → photo finale', async () => {
    // 1. Demande
    await s.text('Fais-moi un porte-clé AUSIM')
    await s.until(() => expect(voices()).toHaveLength(1))

    // 2. Modification : même session Claude, nouvel aperçu agrandi
    await s.text('Oui mais plus grand')
    await s.until(() => expect(voices()).toHaveLength(2))
    expect(images()[1].text).toContain('📐 70 × 28 × 4 mm')
    expect(voices()[1]).toBe('Voilà, je l’ai agrandi. Je lance ?')
    expect(s.claudeCalls()[1].prompt).toMatch(/^MODIFICATION DEMANDÉE/)
    expect(s.claudeCalls()[1].args).toContain('--resume')

    // 3. « Oui » en vocal → impression avec le plugin autorisé
    await s.voice('Oui, vas-y.')
    await s.until(() => expect(s.evo.texts().some((t) => t.startsWith('✅'))).toBe(true))
    const printCall = s.claudeCalls()[2]
    expect(printCall.prompt).toMatch(/^CONFIRMATION/)
    expect(printCall.args).not.toContain('--disallowedTools')
    expect(s.evo.texts()).toContain('🚀 C’est parti, j’envoie à la Bambu Lab…')
    expect(s.evo.texts().find((t) => t.startsWith('✅'))).toContain('Je t’envoie des nouvelles dans ~2 min')

    // 4. Suivi : photo « ça imprime » prise dans la fenêtre Bambu Studio
    await s.until(() => expect(images().some((i) => i.text.startsWith('📸'))).toBe(true))
    const live = images().find((i) => i.text.startsWith('📸'))!
    expect(live.text).toBe('📸 Ça imprime à Casablanca ! Premiers calques en cours, fin estimée dans ~12 min.')
    expect(live.data!.equals(s.cameraJpeg)).toBe(true)

    // 5. Fin estimée : photo finale + annonce vocale
    await s.until(() => expect(images().some((i) => i.text.startsWith('🏁'))).toBe(true), (1 + 12 + 1) * MINUTE_MS + 5000)
    await s.until(() => expect(voices().at(-1)).toBe('Ton objet devrait être prêt à Casablanca !'))
    expect(images().find((i) => i.text.startsWith('🏁'))!.text).toBe('🏁 *Porte-clé AUSIM* devrait être prêt à Casablanca ! Vérifie sur la photo.')

    // Chronologie vue sur le téléphone
    const head = (t: string) => t.split(' ')[0]
    const timeline = s.evo.delivered.map((d) => (d.kind === 'voice' ? '🔊' : d.kind === 'image' ? `🖼 ${head(d.text)}` : head(d.text)))
    expect(timeline).toEqual([
      '🎨', '🖼 🧊', '🔊',                    // demande
      '✏️', '🖼 🧊', '🔊',                    // modification
      '🎤', '🚀', '✅', '🔊',                // « oui » vocal → impression
      '🖼 📸',                               // ça imprime
      '🖼 🏁', '🔊',                         // objet prêt
    ])
    expectWhatsAppFriendly(s.evo)
  })
})

describe('caméra à la demande', () => {
  it('/photo → vue en direct en JPEG affiché', async () => {
    await s.text('/photo')
    await s.until(() => expect(images()).toHaveLength(1))
    expect(images()[0].text).toBe('📷 En direct de Casablanca')
    expect(images()[0].data!.equals(s.cameraJpeg)).toBe(true)
    expect(s.claudeCalls()).toHaveLength(0)
    expectWhatsAppFriendly(s.evo)
  })

  it('« Montre-moi l’imprimante » à l’oral → photo, sans conception', async () => {
    await s.voice('Montre-moi l’imprimante.')
    await s.until(() => expect(images()).toHaveLength(1))
    expect(images()[0].text).toContain('📷 En direct de Casablanca')
    expect(s.claudeCalls()).toHaveLength(0)
    expectWhatsAppFriendly(s.evo)
  })

  it('capture énorme (écran Retina) → réduite à 1600 px avant envoi', async () => {
    const huge = await sharp({ create: { width: 3456, height: 2234, channels: 3, background: '#444444' } }).jpeg().toBuffer()
    s.cameraJpeg.fill(0)
    const { writeFileSync } = await import('node:fs')
    const { screenTools } = await import('../../src/printer/camera.js')
    writeFileSync(path.join(screenTools.tmpDir, 'camera.jpg'), huge)
    await s.text('/photo')
    await s.until(() => expect(images()).toHaveLength(1))
    expect(await sharp(images()[0].data!).metadata()).toMatchObject({ format: 'jpeg', width: 1600 })
    expectWhatsAppFriendly(s.evo)
  })
})

describe('réactivité sur scène', () => {
  it('« oui » envoyé dès l’affichage de l’aperçu, pendant que la note vocale se prépare → accepté', async () => {
    s.eleven.delayMs = 1000
    await s.text('Fais-moi un porte-clé AUSIM')
    await s.until(() => expect(images()).toHaveLength(1))
    expect(s.evo.sent('voice')).toHaveLength(0) // la note vocale n'est pas encore partie
    await s.text('oui')
    await s.until(() => expect(s.evo.texts().some((t) => t.startsWith('✅'))).toBe(true))
    expect(s.evo.texts().some((t) => t.startsWith('⏳'))).toBe(false)
    expectWhatsAppFriendly(s.evo)
  })

  it('nouvelle demande juste après « impression lancée » → acceptée', async () => {
    s.eleven.delayMs = 1000
    await s.text('Fais-moi un porte-clé AUSIM')
    await s.until(() => expect(images()).toHaveLength(1))
    await s.text('oui')
    await s.until(() => expect(s.evo.texts().some((t) => t.startsWith('✅'))).toBe(true))
    await s.text('Un petit vase maintenant')
    await s.until(() => expect(s.claudeCalls().at(-1)?.prompt).toContain('Un petit vase maintenant'))
    expect(s.evo.texts().some((t) => t.startsWith('⏳'))).toBe(false)
  })
})

describe('garde-fous', () => {
  it('deuxième impression → alerte « plateau vide » avant de relancer', async () => {
    await s.text('Fais-moi un porte-clé AUSIM')
    await s.until(() => expect(voices()).toHaveLength(1))
    await s.text('oui')
    await s.until(() => expect(s.evo.texts().some((t) => t.startsWith('✅'))).toBe(true))
    await s.text('Fais-moi un porte-clé AUSIM')
    await s.until(() => expect(images().filter((i) => i.text.startsWith('🧊'))).toHaveLength(2))
    await s.text('oui')
    await s.until(() => expect(lastText()).toContain('Le plateau doit être *vide*'))
    expect(s.claudeCalls().filter((c) => c.prompt.startsWith('CONFIRMATION'))).toHaveLength(1)
    await s.text('oui')
    await s.until(() => expect(s.claudeCalls().filter((c) => c.prompt.startsWith('CONFIRMATION'))).toHaveLength(2))
    expectWhatsAppFriendly(s.evo)
  })

  it('numéro inconnu → aucun message envoyé, Claude jamais appelé', async () => {
    await s.text('Imprime-moi un truc', STRANGER)
    await new Promise((r) => setTimeout(r, 300))
    expect(s.evo.delivered).toEqual([])
    expect(s.claudeCalls()).toEqual([])
  })

  it('impression refusée → message clair, « oui » relance', async () => {
    await s.stop()
    s = await startStack()
    await s.text('Fais-moi un porte-clé AUSIM')
    await s.until(() => expect(voices()).toHaveLength(1))
    process.env.FAKE_PRINT_FAIL = '1'
    try {
      await s.text('oui')
      await s.until(() => expect(lastText()).toContain('❌ L’impression n’est pas partie : Imprimante hors ligne'))
    } finally {
      delete process.env.FAKE_PRINT_FAIL
    }
    await s.text('oui')
    await s.until(() => expect(s.evo.texts().some((t) => t.startsWith('✅'))).toBe(true))
    expectWhatsAppFriendly(s.evo)
  })
})

describe('services capricieux', () => {
  it('WhatsApp renvoie 503 sur l’aperçu → nouvel essai, image livrée une seule fois', async () => {
    s.evo.failNext('/message/sendMedia', 503, 2)
    await s.text('Fais-moi un porte-clé AUSIM')
    await s.until(() => expect(voices()).toHaveLength(1))
    expect(images()).toHaveLength(1)
    expect(s.evo.calls.filter((c) => c.path.startsWith('/message/sendMedia')).map((c) => c.status)).toEqual([503, 503, 201])
    expectWhatsAppFriendly(s.evo)
  })

  it('WhatsApp refuse toujours l’image → la légende part en texte, la démo continue', async () => {
    s.evo.failNext('/message/sendMedia', 503, 10)
    await s.text('Fais-moi un porte-clé AUSIM')
    await s.until(() => expect(s.evo.texts().some((t) => t.includes('Porte-clé AUSIM'))).toBe(true))
    await s.text('oui')
    await s.until(() => expect(s.evo.texts().some((t) => t.startsWith('✅'))).toBe(true))
  })

  it('ElevenLabs en panne → aperçu envoyé sans vocal', async () => {
    s.eleven.down = true
    await s.text('Fais-moi un porte-clé AUSIM')
    await s.until(() => expect(images()).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 200))
    expect(s.evo.sent('voice')).toHaveLength(0)
    expectWhatsAppFriendly(s.evo)
  })

  it('Whisper en panne passagère (500 puis OK) → vocal quand même compris', async () => {
    s.groq.failures = [500]
    await s.voice('Un petit vase')
    await s.until(() => expect(images()).toHaveLength(1))
    expect(s.evo.texts()[0]).toBe('🎤 _« Un petit vase »_')
  })

  it('Whisper hors service → message clair, pas de conception', async () => {
    s.groq.failures = [500, 500, 500]
    await s.voice('Un petit vase')
    await s.until(() => expect(lastText()).toContain('écouter ton vocal'))
    expect(s.claudeCalls()).toHaveLength(0)
  })

  it('caméra introuvable (Bambu Studio fermé) → suivi en texte avec avertissement', async () => {
    const { screenTools } = await import('../../src/printer/camera.js')
    const { writeFileSync, chmodSync } = await import('node:fs')
    writeFileSync(screenTools.osascript, '#!/usr/bin/env node\nconsole.log("[]")\n')
    chmodSync(screenTools.osascript, 0o755)
    await s.text('Fais-moi un porte-clé AUSIM')
    await s.until(() => expect(voices()).toHaveLength(1))
    await s.text('oui')
    await s.until(() => expect(s.evo.texts().some((t) => t.startsWith('📸 Ça imprime'))).toBe(true))
    expect(s.evo.texts().find((t) => t.startsWith('📸'))).toContain('vue caméra indisponible')
    await s.text('/photo')
    await s.until(() => expect(lastText()).toContain('Je ne trouve pas la fenêtre Bambu Studio'))
    expectWhatsAppFriendly(s.evo)
  })
})
