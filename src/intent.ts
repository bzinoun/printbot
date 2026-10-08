/**
 * Classe la réponse de l'utilisateur à l'aperçu : confirmer, annuler ou modifier.
 * Volontairement déterministe (pas de LLM) : rapide et prévisible sur scène.
 * Gère le français, quelques mots d'anglais et de darija.
 */

export type Reply = 'confirm' | 'cancel' | 'modify'

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/[^a-z0-9؀-ۿ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const CONFIRM = [
  'oui', 'ouais', 'ouai', 'ok', 'okay', 'oki', 'd accord', 'dac', 'vas y', 'vas-y', 'va y', 'go', 'lance', 'lance le',
  'lance la', 'imprime', 'imprime le', 'imprime la', 'c est bon', 'c est parti', 'c est parfait', 'c est top',
  'c est nickel', 'c est super', 'tres bien', 'excellent', 'parfait', 'valide', 'je valide',
  'top', 'nickel', 'super', 'yes', 'yep', 'yeah', 'sure', 'wakha', 'iyeh', 'ayeh', 'safi', 'yallah', 'yalla',
  'نعم', 'واخا', 'اه', 'يالاه',
]

const CANCEL = [
  'non', 'nan', 'no', 'nope', 'annule', 'annuler', 'stop', 'arrete', 'laisse tomber', 'oublie', 'pas maintenant',
  'لا',
]

/** Mots qui signalent une demande de changement, même après un « oui » ou un « non ». */
const CHANGE_WORDS =
  /\b(mais|plus|moins|change|changer|modifie|modifier|ajoute|ajouter|enleve|enlever|retire|remplace|agrandi|agrandis|reduis|reduire|grand|petit|large|epais|fin|texte|ecris|couleur|trou|rond|carre|tourne|version|refais|plutot|sans)\b/

function matchesStart(text: string, words: string[]): boolean {
  return words.some((w) => text === w || text.startsWith(w + ' '))
}

export function classifyReply(raw: string): Reply {
  const text = normalize(raw)
  if (!text) return 'modify'
  const wordCount = text.split(' ').length

  if (CHANGE_WORDS.test(text)) return 'modify'
  if (wordCount <= 6 && matchesStart(text, CONFIRM)) return 'confirm'
  if (/\b(lance|lancer|lances) (l )?impression\b/.test(text) || /\bvas[ -]?y\b/.test(text)) return 'confirm'
  if (wordCount <= 4 && matchesStart(text, CANCEL)) return 'cancel'
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
