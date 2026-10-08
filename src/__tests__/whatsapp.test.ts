import { describe, expect, it } from 'vitest'
import { parseEvolutionWebhook } from '../whatsapp.js'

const upsert = (data: unknown, event = 'messages.upsert') => ({ event, instance: 'printbot', data })
const key = (remoteJid: string, extra: object = {}) => ({ remoteJid, fromMe: false, id: 'ID1', ...extra })

describe('parseEvolutionWebhook — types de messages', () => {
  it('texte long (extendedTextMessage, ex. avec aperçu de lien)', () => {
    const [m] = parseEvolutionWebhook(upsert({ key: key('2126@s.whatsapp.net'), messageType: 'extendedTextMessage', message: { extendedTextMessage: { text: '  un vase  ' } } }))
    expect(m).toMatchObject({ kind: 'text', text: 'un vase' })
  })

  it('vocal détecté par messageType ou par le contenu', () => {
    expect(parseEvolutionWebhook(upsert({ key: key('2126@s.whatsapp.net'), messageType: 'audioMessage' }))[0].kind).toBe('audio')
    expect(parseEvolutionWebhook(upsert({ key: key('2126@s.whatsapp.net'), message: { audioMessage: {} } }))[0].kind).toBe('audio')
  })

  it('photo sans légende', () => {
    const [m] = parseEvolutionWebhook(upsert({ key: key('2126@s.whatsapp.net'), messageType: 'imageMessage', message: { imageMessage: { caption: '' } } }))
    expect(m).toMatchObject({ kind: 'image', text: undefined })
  })

  it('sticker, réaction… → other', () => {
    const [m] = parseEvolutionWebhook(upsert({ key: key('2126@s.whatsapp.net'), messageType: 'stickerMessage', message: { stickerMessage: {} } }))
    expect(m.kind).toBe('other')
  })

  it('message sans contenu → other', () => {
    expect(parseEvolutionWebhook(upsert({ key: key('2126@s.whatsapp.net') }))[0].kind).toBe('other')
  })
})

describe('parseEvolutionWebhook — identité de l’expéditeur', () => {
  it('suffixe d’appareil (:12) retiré du numéro', () => {
    const [m] = parseEvolutionWebhook(upsert({ key: key('212600000001:12@s.whatsapp.net'), message: { conversation: 'x' } }))
    expect(m.number).toBe('212600000001')
  })

  it('@lid + remoteJidAlt → vrai numéro', () => {
    const [m] = parseEvolutionWebhook(upsert({ key: key('99887766@lid', { remoteJidAlt: '212600000001@s.whatsapp.net' }), message: { conversation: 'x' } }))
    expect(m).toMatchObject({ number: '212600000001', replyTo: '212600000001' })
  })

  it('@lid sans numéro alternatif → on répond au JID lid (et la whitelist le refusera)', () => {
    const [m] = parseEvolutionWebhook(upsert({ key: key('99887766@lid'), message: { conversation: 'x' } }))
    expect(m).toMatchObject({ number: '99887766', replyTo: '99887766@lid' })
  })

  it('nom affiché transmis', () => {
    const [m] = parseEvolutionWebhook(upsert({ key: key('2126@s.whatsapp.net'), pushName: 'Badr', message: { conversation: 'x' } }))
    expect(m.pushName).toBe('Badr')
  })
})

describe('parseEvolutionWebhook — filtrage', () => {
  it.each([
    ['groupe', key('120363@g.us')],
    ['statut', key('status@broadcast')],
    ['chaîne', key('1203@newsletter')],
    ['mon propre message', key('2126@s.whatsapp.net', { fromMe: true })],
    ['sans id', { remoteJid: '2126@s.whatsapp.net' }],
    ['sans remoteJid', { id: 'x' }],
  ])('%s → ignoré', (_label, k) => {
    expect(parseEvolutionWebhook(upsert({ key: k, message: { conversation: 'x' } }))).toEqual([])
  })

  it('événement autre que messages.upsert → ignoré', () => {
    expect(parseEvolutionWebhook(upsert({ key: key('2126@s.whatsapp.net') }, 'send.message'))).toEqual([])
  })

  it('charges utiles absurdes → tableau vide, jamais d’exception', () => {
    for (const p of [null, undefined, 42, 'x', {}, { event: 'messages.upsert' }, { event: 'messages.upsert', data: null }, { event: 'messages.upsert', data: { key: null } }])
      expect(parseEvolutionWebhook(p)).toEqual([])
  })

  it('lot de plusieurs messages', () => {
    const data = [
      { key: { ...key('2126@s.whatsapp.net'), id: 'A' }, message: { conversation: 'a' } },
      { key: { ...key('120363@g.us'), id: 'B' }, message: { conversation: 'b' } },
      { key: { ...key('2127@s.whatsapp.net'), id: 'C' }, message: { conversation: 'c' } },
    ]
    expect(parseEvolutionWebhook(upsert(data)).map((m) => m.id)).toEqual(['A', 'C'])
  })
})
