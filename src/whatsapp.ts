/**
 * Normalisation des webhooks Evolution API (MESSAGES_UPSERT) en message simple.
 * Même filtrage qu'AthenIA : on ignore nos propres messages, les groupes et les statuts.
 */

export type IncomingKind = 'text' | 'audio' | 'image' | 'other'

export interface Incoming {
  id: string
  /** Destinataire à utiliser pour répondre (numéro ou JID). */
  replyTo: string
  /** Numéro de l'expéditeur, chiffres uniquement (pour la whitelist). */
  number: string
  pushName?: string
  kind: IncomingKind
  text?: string
}

interface EvolutionKey {
  remoteJid?: string
  remoteJidAlt?: string
  senderPn?: string
  fromMe?: boolean
  id?: string
}

interface EvolutionMessageData {
  key?: EvolutionKey
  pushName?: string
  messageType?: string
  message?: {
    conversation?: string
    extendedTextMessage?: { text?: string }
    audioMessage?: unknown
    imageMessage?: { caption?: string }
  }
}

const digits = (jid: string) => jid.split('@')[0].split(':')[0].replace(/\D/g, '')

export function parseEvolutionWebhook(payload: unknown): Incoming[] {
  const p = payload as { event?: string; data?: EvolutionMessageData | EvolutionMessageData[] }
  const event = (p?.event ?? '').toLowerCase().replace(/_/g, '.')
  if (event !== 'messages.upsert') return []

  const items = Array.isArray(p.data) ? p.data : p.data ? [p.data] : []
  const result: Incoming[] = []

  for (const data of items) {
    const key = data.key
    if (!key?.remoteJid || !key.id || key.fromMe) continue
    if (key.remoteJid.endsWith('@g.us') || key.remoteJid === 'status@broadcast' || key.remoteJid.endsWith('@newsletter')) continue

    // WhatsApp peut masquer le numéro derrière un identifiant @lid :
    // Evolution fournit alors le vrai numéro dans senderPn / remoteJidAlt.
    const phoneJid = [key.senderPn, key.remoteJidAlt, key.remoteJid].find((j) => j && !j.endsWith('@lid'))
    const number = digits(phoneJid ?? key.remoteJid)
    const replyTo = phoneJid ? number : key.remoteJid

    const m = data.message ?? {}
    const type = data.messageType ?? ''
    let kind: IncomingKind = 'other'
    let text: string | undefined

    if (m.conversation || m.extendedTextMessage?.text) {
      kind = 'text'
      text = m.conversation || m.extendedTextMessage?.text
    } else if (type === 'audioMessage' || m.audioMessage) {
      kind = 'audio'
    } else if (type === 'imageMessage' || m.imageMessage) {
      kind = 'image'
      text = m.imageMessage?.caption || undefined
    }

    result.push({ id: key.id, replyTo, number, pushName: data.pushName, kind, text: text?.trim() })
  }
  return result
}
