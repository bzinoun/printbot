import { describe, expect, it } from 'vitest'
import { classifyReply, parseCommand } from '../intent.js'
import { parseEvolutionWebhook } from '../whatsapp.js'
import { parseClaudeOutput } from '../claude.js'
import { toSpeakable } from '../providers/tts.js'
import { slugify } from '../job.js'

describe('classifyReply', () => {
  it.each([
    'Oui', 'oui !', 'Ok', 'vas-y', 'Vas y lance', "C'est parfait", 'go', 'Lance l’impression', 'imprime-le',
    'Wakha', 'yes please', 'Oui, c’est bon', 'واخا',
  ])('confirme « %s »', (t) => expect(classifyReply(t)).toBe('confirm'))

  it.each(['Non', 'non merci', 'annule', 'Stop', 'laisse tomber', 'لا'])('annule « %s »', (t) =>
    expect(classifyReply(t)).toBe('cancel'),
  )

  it.each([
    'Oui mais plus grand',
    'non, fais-le plus petit',
    'Ajoute un trou pour une clé',
    'Change le texte en AUSIM 2026',
    'plutôt en forme de cœur',
    'Je voudrais une version ronde',
    'fais un support de téléphone',
  ])('modifie « %s »', (t) => expect(classifyReply(t)).toBe('modify'))
})

describe('parseCommand', () => {
  it('reconnaît les commandes', () => {
    expect(parseCommand('/reset')).toBe('reset')
    expect(parseCommand('/status')).toBe('status')
    expect(parseCommand('/aide')).toBe('help')
    expect(parseCommand('reset')).toBeNull()
  })
})

describe('parseEvolutionWebhook', () => {
  const base = (data: object) => ({ event: 'messages.upsert', instance: 'printbot', data })

  it('texte simple', () => {
    const [m] = parseEvolutionWebhook(
      base({ key: { remoteJid: '212600000001@s.whatsapp.net', fromMe: false, id: 'A1' }, pushName: 'Badr', messageType: 'conversation', message: { conversation: 'Bonjour' } }),
    )
    expect(m).toMatchObject({ id: 'A1', number: '212600000001', replyTo: '212600000001', kind: 'text', text: 'Bonjour', pushName: 'Badr' })
  })

  it('vocal', () => {
    const [m] = parseEvolutionWebhook(
      base({ key: { remoteJid: '212600000001@s.whatsapp.net', id: 'A2' }, messageType: 'audioMessage', message: { audioMessage: { seconds: 4 } } }),
    )
    expect(m.kind).toBe('audio')
  })

  it('photo avec légende', () => {
    const [m] = parseEvolutionWebhook(
      base({ key: { remoteJid: '212600000001@s.whatsapp.net', id: 'A3' }, messageType: 'imageMessage', message: { imageMessage: { caption: 'Fais ça' } } }),
    )
    expect(m).toMatchObject({ kind: 'image', text: 'Fais ça' })
  })

  it('identifiant @lid → vrai numéro via senderPn', () => {
    const [m] = parseEvolutionWebhook(
      base({ key: { remoteJid: '9988776655@lid', senderPn: '212600000001@s.whatsapp.net', id: 'A4' }, message: { conversation: 'hey' } }),
    )
    expect(m).toMatchObject({ number: '212600000001', replyTo: '212600000001' })
  })

  it('ignore nos messages, les groupes et les autres événements', () => {
    expect(parseEvolutionWebhook(base({ key: { remoteJid: '2126@s.whatsapp.net', fromMe: true, id: 'B1' }, message: { conversation: 'x' } }))).toEqual([])
    expect(parseEvolutionWebhook(base({ key: { remoteJid: '1203@g.us', id: 'B2' }, message: { conversation: 'x' } }))).toEqual([])
    expect(parseEvolutionWebhook({ event: 'messages.update', data: {} })).toEqual([])
    expect(parseEvolutionWebhook({ event: 'MESSAGES_UPSERT', data: { key: { remoteJid: '2126@s.whatsapp.net', id: 'B3' }, message: { conversation: 'x' } } })).toHaveLength(1)
  })
})

describe('parseClaudeOutput', () => {
  it('lit le résultat JSON', () => {
    const out = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Voilà !', session_id: 'abc', total_cost_usd: 0.12 })
    expect(parseClaudeOutput(out)).toEqual({ sessionId: 'abc', text: 'Voilà !', isError: false, costUsd: 0.12 })
  })
  it('signale une sortie illisible', () => {
    expect(parseClaudeOutput('boom').isError).toBe(true)
  })
  it('détecte une erreur', () => {
    const out = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '', session_id: 'x' })
    expect(parseClaudeOutput(out).isError).toBe(true)
  })
})

describe('toSpeakable', () => {
  it('rend le texte prononçable', () => {
    expect(toSpeakable('🧊 *Porte-clé* 📐 50 × 20 × 4 mm · ⏱️ ~12 min')).toBe('Porte-clé 50 par 20 par 4 millimètres · environ 12 minutes')
  })
})

describe('slugify', () => {
  it('fabrique un nom de dossier', () => {
    expect(slugify('Fais-moi un porte-clé « AUSIM » !')).toBe('fais-moi-un-porte-cle-ausim')
  })
})
