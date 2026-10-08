import { describe, expect, it } from 'vitest'
import { classifyReply, normalize, parseCommand } from '../intent.js'

/**
 * Règle d'or : en cas de doute, on NE lance PAS l'impression.
 * Une impression lancée par erreur sur scène coûte plus cher qu'une modification inutile.
 */

describe('classifyReply — confirmations', () => {
  it.each([
    'oui', 'Oui !', 'OUI', 'ouais', 'ok', 'OK.', 'okay', "d'accord", 'dac', 'vas-y', 'Vas y', 'go', 'go go go',
    'lance', 'Lance-le', "Lance l'impression", 'imprime', 'imprime-le', 'Imprime ça', "c'est bon", "C'est parfait",
    "c'est parti", 'parfait', 'top', 'nickel', 'super', 'très bien', 'excellent', 'valide', 'je valide', 'yes',
    'yes please', 'yep', 'Wakha', 'wakha safi', 'yallah', 'Allez vas-y', "Oui, c'est bon, vas-y lance l'impression merci",
    "oui s'il te plaît", 'Oui. Vas-y.', 'واخا', 'نعم', 'oui oui', 'ok merci', 'Oui chef',
  ])('« %s » → confirm', (t) => expect(classifyReply(t)).toBe('confirm'))
})

describe('classifyReply — annulations', () => {
  it.each([
    'non', 'Non.', 'nan', 'no', 'nope', 'non merci', 'annule', "Annule l'impression", 'stop', 'arrête',
    'laisse tomber', 'oublie', 'pas maintenant', "non c'est bon", 'finalement non', 'لا',
  ])('« %s » → cancel', (t) => expect(classifyReply(t)).toBe('cancel'))
})

describe('classifyReply — modifications (jamais d’impression)', () => {
  it.each([
    'Oui mais plus grand',
    'ok, fais-le en étoile',
    'Ok mets AUSIM en plus gros',
    'oui ajoute un trou',
    'Imprime un cube',
    'lance un vase',
    'non, plus petit',
    'non fais-le rond',
    'Change le texte en AUSIM 2026',
    'plutôt en forme de cœur',
    'Je voudrais une version ronde',
    'fais un support de téléphone',
    'oui mais en rouge',
    'Parfait mais enlève le trou',
    'c’est pas mal',
    'hmm',
    '',
    '   ',
    '🤔',
    'oui '.repeat(11),
  ])('« %s » → modify', (t) => expect(classifyReply(t)).toBe('modify'))
})

describe('normalize', () => {
  it('accents, apostrophes, ponctuation, tirets', () => {
    expect(normalize("  C’est TRÈS bien, vas-y !  ")).toBe('c est tres bien vas y')
  })
  it('garde l’arabe', () => {
    expect(normalize('واخا!')).toBe('واخا')
  })
})

describe('parseCommand', () => {
  it.each([
    ['/aide', 'help'], ['/help', 'help'], ['/start', 'help'],
    ['/status', 'status'], ['/statut', 'status'], ['/etat', 'status'], ['  /STATUS  ', 'status'],
    ['/reset', 'reset'], ['/nouveau', 'reset'], ['/annule', 'reset'],
  ])('%s → %s', (t, cmd) => expect(parseCommand(t)).toBe(cmd))

  it.each(['reset', 'status', 'oui', '/inconnu', 'imprime /reset'])('« %s » n’est pas une commande', (t) =>
    expect(parseCommand(t)).toBeNull(),
  )
})
