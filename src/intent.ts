/**
 * Classe la réponse de l'utilisateur à l'aperçu : confirmer, annuler ou modifier.
 * Volontairement déterministe (pas de LLM) : rapide et prévisible sur scène.
 *
 * Principe de sécurité : on ne confirme (= lance l'impression) que si TOUS les mots
 * du message sont des mots d'acquiescement connus. Le moindre mot inconnu
 * (« ok, fais-le en étoile ») fait basculer vers une modification.
 * Gère le français, quelques mots d'anglais et de darija.
 */

export type Reply = 'confirm' | 'cancel' | 'modify'

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Mots porteurs d'un « oui ». */
const CONFIRM_CORE = new Set([
  'oui', 'ouais', 'ouai', 'ok', 'okay', 'oki', 'accord', 'dac', 'vas', 'va', 'go', 'lance', 'lancer', 'lancez',
  'imprime', 'imprimer', 'imprimez', 'bon', 'parti', 'parfait', 'top', 'nickel', 'super', 'bien', 'excellent',
  'genial', 'cool', 'valide', 'valider', 'confirme', 'yes', 'yep', 'yeah', 'sure', 'wakha', 'iyeh', 'ayeh', 'safi',
  'yalla', 'yallah', 'allez', 'نعم', 'واخا', 'اه', 'يالاه',
])

/** Mots neutres tolérés autour d'un « oui » (« oui c'est bon, vas-y lance l'impression merci »). */
const CONFIRM_FILLER = new Set([
  'd', 'c', 'est', 'y', 'le', 'la', 'l', 'les', 'ca', 'je', 'on', 'impression', 'tres', 'merci', 'please', 'stp',
  'svp', 's', 'il', 'te', 'vous', 'plait', 'maintenant', 'tout', 'de', 'suite', 'oui', 'chef', 'bro',
])

/** Mots porteurs d'un « non ». */
const CANCEL_CORE = new Set([
  'non', 'nan', 'no', 'nope', 'annule', 'annuler', 'annulez', 'stop', 'arrete', 'arreter', 'laisse', 'tomber',
  'oublie', 'oublier', 'cancel', 'pas', 'لا',
])

const CANCEL_FILLER = new Set(['merci', 'maintenant', 'finalement', 'c', 'est', 'bon', 'ca', 'tout', 'le', 'la', 'l', 'impression'])

function allIn(words: string[], core: Set<string>, filler: Set<string>): boolean {
  return words.some((w) => core.has(w)) && words.every((w) => core.has(w) || filler.has(w))
}

export function classifyReply(raw: string): Reply {
  const words = normalize(raw).split(' ').filter(Boolean)
  if (!words.length || words.length > 10) return 'modify'
  // « non » en tête l'emporte (« non c'est bon » = non merci)
  if (CANCEL_CORE.has(words[0]) && allIn(words, CANCEL_CORE, CANCEL_FILLER)) return 'cancel'
  if (allIn(words, CONFIRM_CORE, CONFIRM_FILLER)) return 'confirm'
  if (allIn(words, CANCEL_CORE, CANCEL_FILLER)) return 'cancel'
  return 'modify'
}

export type Command = 'help' | 'status' | 'reset'

export function parseCommand(raw: string): Command | null {
  const text = raw.trim().toLowerCase()
  if (/^\/(aide|help|start)\b/.test(text)) return 'help'
  if (/^\/(status|statut|etat)\b/.test(text)) return 'status'
  if (/^\/(reset|nouveau|new|annule)\b/.test(text)) return 'reset'
  return null
}
