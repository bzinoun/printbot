import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EvolutionClient } from '../providers/evolution.js'
import { sttRetry, transcribe } from '../providers/stt.js'
import { synthesize, toSpeakable, ttsEnabled } from '../providers/tts.js'
import { useConfig } from './helpers.js'

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const text = (body: string, status = 200) => new Response(body, { status })

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useConfig()
})
afterEach(() => vi.unstubAllGlobals())

const call = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i]
  return { url: String(url), init: init as RequestInit, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined }
}

// ══════════════════════════════════════════════════════════════════
describe('EvolutionClient', () => {
  const evo = () => new EvolutionClient('http://evo', 'secret', 'printbot', 1)

  it('sendText : URL, clé API, corps', async () => {
    fetchMock.mockResolvedValue(json({ key: { id: '1' } }))
    await evo().sendText('212600000001', 'Bonjour')
    const c = call()
    expect(c.url).toBe('http://evo/message/sendText/printbot')
    expect(c.init.method).toBe('POST')
    expect((c.init.headers as Record<string, string>).apikey).toBe('secret')
    expect(c.body).toEqual({ number: '212600000001', text: 'Bonjour' })
  })

  it('sendImage : base64 brut (préfixe data: retiré), PNG, légende', async () => {
    fetchMock.mockResolvedValue(json({}))
    await evo().sendImage('2126', 'data:image/png;base64,QUJD', 'Légende')
    expect(call().url).toBe('http://evo/message/sendMedia/printbot')
    expect(call().body).toMatchObject({ number: '2126', mediatype: 'image', mimetype: 'image/png', media: 'QUJD', caption: 'Légende' })
  })

  it('sendImage en JPEG (photo caméra)', async () => {
    fetchMock.mockResolvedValue(json({}))
    await evo().sendImage('2126', 'QUJD', 'Live', 'image/jpeg')
    expect(call().body).toMatchObject({ mimetype: 'image/jpeg', fileName: 'photo.jpg' })
  })

  it('sendVoice : note vocale WhatsApp', async () => {
    fetchMock.mockResolvedValue(json({}))
    await evo().sendVoice('2126', 'T0dH')
    expect(call().url).toBe('http://evo/message/sendWhatsAppAudio/printbot')
    expect(call().body).toEqual({ number: '2126', audio: 'T0dH' })
  })

  it('getMediaBase64 : demande le média du message reçu', async () => {
    fetchMock.mockResolvedValue(json({ base64: 'AAAA' }))
    expect(await evo().getMediaBase64('MSG1')).toBe('AAAA')
    expect(call().body).toMatchObject({ message: { key: { id: 'MSG1' } } })
  })

  it('réessaie sur erreur 5xx puis réussit', async () => {
    fetchMock.mockResolvedValueOnce(text('oops', 502)).mockResolvedValueOnce(json({}))
    await evo().sendText('2126', 'x')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('réessaie sur erreur réseau', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json({}))
    await evo().sendText('2126', 'x')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('ne réessaie pas sur 4xx (clé invalide…)', async () => {
    fetchMock.mockResolvedValue(text('Unauthorized', 401))
    await expect(evo().sendText('2126', 'x')).rejects.toThrow(/401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('abandonne après 3 essais', async () => {
    fetchMock.mockImplementation(async () => text('down', 503))
    await expect(evo().sendText('2126', 'x')).rejects.toThrow(/503/)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('réponse vide acceptée', async () => {
    fetchMock.mockResolvedValue(text(''))
    await expect(evo().sendText('2126', 'x')).resolves.toBeUndefined()
  })

  it('typing ne lève jamais d’erreur', async () => {
    fetchMock.mockResolvedValue(text('nope', 400))
    await expect(evo().typing('2126')).resolves.toBeUndefined()
  })

  it('getConnectionState : différents formats de réponse', async () => {
    fetchMock.mockResolvedValueOnce(json({ instance: { state: 'open' } }))
    expect(await evo().getConnectionState()).toBe('open')
    fetchMock.mockResolvedValueOnce(json({ state: 'connecting' }))
    expect(await evo().getConnectionState()).toBe('connecting')
    fetchMock.mockResolvedValueOnce(json({}))
    expect(await evo().getConnectionState()).toBe('unknown')
    expect(call(0).init.method).toBe('GET')
  })

  it('setWebhook : webhook activé sur MESSAGES_UPSERT', async () => {
    fetchMock.mockResolvedValue(json({}))
    await evo().setWebhook('http://bot/webhook')
    expect(call().url).toBe('http://evo/webhook/set/printbot')
    expect(call().body).toEqual({ webhook: { enabled: true, url: 'http://bot/webhook', byEvents: false, base64: false, events: ['MESSAGES_UPSERT'] } })
  })

  it('getQrCode : QR de connexion', async () => {
    fetchMock.mockResolvedValue(json({ base64: 'data:image/png;base64,QR', code: '2@abc' }))
    expect(await evo().getQrCode()).toEqual({ base64: 'data:image/png;base64,QR', code: '2@abc' })
    expect(call().url).toBe('http://evo/instance/connect/printbot')
    expect(call().init.method).toBe('GET')
  })

  it('createInstance : Baileys + QR + webhook MESSAGES_UPSERT', async () => {
    fetchMock.mockResolvedValue(json({}))
    await evo().createInstance('http://host.docker.internal:4100/webhook')
    expect(call().url).toBe('http://evo/instance/create')
    expect(call().body).toMatchObject({
      instanceName: 'printbot',
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      webhook: { url: 'http://host.docker.internal:4100/webhook', events: ['MESSAGES_UPSERT'] },
    })
  })
})

// ══════════════════════════════════════════════════════════════════
describe('transcribe (Groq Whisper)', () => {
  beforeEach(() => {
    useConfig({ GROQ_API_KEY: 'gsk_test', STT_LANGUAGE: 'fr' })
    sttRetry.backoffMs = 1
  })

  it('clé absente → erreur explicite sans appel réseau', async () => {
    useConfig({ GROQ_API_KEY: '' })
    await expect(transcribe('AAAA')).rejects.toThrow(/GROQ_API_KEY/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('envoie le vocal au bon modèle, en français, et nettoie le texte', async () => {
    fetchMock.mockResolvedValue(text('  Fais-moi un porte-clé.\n'))
    const audio = Buffer.from('ogg-bytes')
    expect(await transcribe(`data:audio/ogg;base64,${audio.toString('base64')}`)).toBe('Fais-moi un porte-clé.')
    const { url, init } = call()
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk_test')
    const form = init.body as FormData
    expect(form.get('model')).toBe('whisper-large-v3-turbo')
    expect(form.get('language')).toBe('fr')
    expect(form.get('response_format')).toBe('text')
    expect(Buffer.from(await (form.get('file') as Blob).arrayBuffer()).toString()).toBe('ogg-bytes')
  })

  it('langue vide → détection automatique (pas de champ language)', async () => {
    useConfig({ GROQ_API_KEY: 'gsk_test', STT_LANGUAGE: '' })
    fetchMock.mockResolvedValue(text('salam'))
    await transcribe('AAAA')
    expect((call().init.body as FormData).has('language')).toBe(false)
  })

  it('langue forcée en paramètre (darija → ar)', async () => {
    fetchMock.mockResolvedValue(text('x'))
    await transcribe('AAAA', 'ar')
    expect((call().init.body as FormData).get('language')).toBe('ar')
  })

  it('429 / 5xx → nouvel essai', async () => {
    fetchMock.mockResolvedValueOnce(text('rate', 429)).mockResolvedValueOnce(text('err', 500)).mockResolvedValueOnce(text('ok'))
    expect(await transcribe('AAAA')).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('400 → échec immédiat', async () => {
    fetchMock.mockResolvedValue(text('bad audio', 400))
    await expect(transcribe('AAAA')).rejects.toThrow(/400/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ══════════════════════════════════════════════════════════════════
describe('synthesize (ElevenLabs)', () => {
  const withVoice = (extra: Record<string, string> = {}) =>
    useConfig({ ELEVENLABS_API_KEY: 'el_key', ELEVENLABS_VOICE_ID: 'voice123', ...extra })

  it('désactivé sans clé, sans voix, ou si VOICE_REPLIES=false', async () => {
    useConfig()
    expect(ttsEnabled()).toBe(false)
    useConfig({ ELEVENLABS_API_KEY: 'k' })
    expect(ttsEnabled()).toBe(false)
    withVoice({ VOICE_REPLIES: 'false' })
    expect(ttsEnabled()).toBe(false)
    expect(await synthesize('Bonjour')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('produit une note vocale OGG/Opus en base64', async () => {
    withVoice()
    fetchMock.mockResolvedValue(new Response(Buffer.from('opus-audio')))
    const b64 = await synthesize('🧊 *Cube* ~12 min')
    expect(Buffer.from(b64 as string, 'base64').toString()).toBe('opus-audio')
    const { url, init, body } = call()
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=opus_48000_64')
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('el_key')
    expect(body).toMatchObject({ text: 'Cube environ 12 minutes', model_id: 'eleven_multilingual_v2' })
  })

  it('texte trop long tronqué à 600 caractères', async () => {
    withVoice()
    fetchMock.mockResolvedValue(new Response(Buffer.from('a')))
    await synthesize('a'.repeat(2000))
    expect(call().body.text).toHaveLength(600)
  })

  it('texte vide après nettoyage → null sans appel', async () => {
    withVoice()
    expect(await synthesize('🎉 ✅')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('erreur HTTP ou réseau → null (le bot continue sans voix)', async () => {
    withVoice()
    fetchMock.mockResolvedValueOnce(text('quota', 401))
    expect(await synthesize('Bonjour')).toBeNull()
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(await synthesize('Bonjour')).toBeNull()
  })
})

describe('toSpeakable', () => {
  it.each([
    ['*Porte-clé* _AUSIM_', 'Porte-clé AUSIM'],
    ['📐 50 × 20 × 4 mm', '50 par 20 par 4 millimètres'],
    ['6 cm', '6 centimètres'],
    ['⏱️ ~14 min', 'environ 14 minutes'],
    ['Voici ton vase.   Je lance ?', 'Voici ton vase. Je lance ?'],
  ])('%s → %s', (input, expected) => expect(toSpeakable(input)).toBe(expected))
})
