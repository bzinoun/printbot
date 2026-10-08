import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeResult, ClaudeRun } from '../claude.js'
import { FRIEND, ME, PNG, useConfig } from './helpers.js'

// ── Doublures : WhatsApp, Claude, Whisper, ElevenLabs ─────────────
const h = vi.hoisted(() => {
  const sent: { type: 'text' | 'image' | 'voice'; to: string; body: string }[] = []
  return {
    sent,
    evo: {
      sendText: vi.fn(async (to: string, text: string) => void sent.push({ type: 'text', to, body: text })),
      sendImage: vi.fn(async (to: string, _b64: string, caption = '', _mime?: string) => void sent.push({ type: 'image', to, body: caption })),
      sendVoice: vi.fn(async (to: string, b64: string) => void sent.push({ type: 'voice', to, body: b64 })),
      typing: vi.fn(async () => {}),
      getMediaBase64: vi.fn(async () => Buffer.from('media').toString('base64')),
    },
    runClaude: vi.fn<(run: ClaudeRun) => Promise<ClaudeResult>>(),
    camera: { enabled: false },
    capturePhoto: vi.fn<() => Promise<Buffer | null>>(async () => null),
    captureLiveView: vi.fn<() => Promise<{ jpeg: Buffer | null; failure?: string }>>(async () => ({ jpeg: null, failure: 'unsupported' })),
    transcribe: vi.fn<(b64: string) => Promise<string>>(),
    synthesize: vi.fn<(text: string) => Promise<string | null>>(async () => null),
  }
})

vi.mock('../providers/evolution.js', () => ({ getEvolution: () => h.evo }))
vi.mock('../claude.js', () => ({ runClaude: h.runClaude }))
vi.mock('../providers/stt.js', () => ({ transcribe: h.transcribe }))
vi.mock('../providers/tts.js', () => ({ synthesize: h.synthesize }))
vi.mock('../printer/camera.js', () => ({
  cameraEnabled: () => h.camera.enabled,
  capturePhoto: h.capturePhoto,
  captureLiveView: h.captureLiveView,
  cameraHelp: (failure?: string) => `HELP:${failure}`,
}))

const { handleIncoming, resetAll, getSessionState, formatCaption, HELP } = await import('../bot.js')

// ── Faux Claude ───────────────────────────────────────────────────
const JOB = {
  title: 'Porte-clé AUSIM',
  summary: 'Plaque avec AUSIM en relief',
  size_mm: [50.4, 20, 4],
  est_print_minutes: 12.3,
  say: 'Voici ton porte-clé. Je lance ?',
}

interface FakeOptions {
  job?: object | null
  preview?: boolean
  print?: object | null
  isError?: boolean
  text?: string
  onCall?: (run: ClaudeRun) => void
}

function fakeClaude(o: FakeOptions = {}) {
  h.runClaude.mockImplementation(async (run) => {
    o.onCall?.(run)
    const out = path.join(run.cwd, 'out')
    mkdirSync(out, { recursive: true })
    if (run.prompt.startsWith('CONFIRMATION')) {
      const print = o.print === undefined ? { status: 'sent', message: 'Lancé sur la P1S', est_minutes: 12 } : o.print
      if (print) writeFileSync(path.join(out, 'print.json'), JSON.stringify(print))
    } else {
      if (o.preview ?? true) writeFileSync(path.join(out, 'preview.png'), PNG)
      const job = o.job === undefined ? JOB : o.job
      if (job) writeFileSync(path.join(out, 'job.json'), JSON.stringify(job))
    }
    return { sessionId: 'sess-1', text: o.text ?? 'Voilà.', isError: o.isError ?? false, durationMs: 1 }
  })
}

let n = 0
const textMsg = (text: string, number = ME) =>
  handleIncoming({ id: `m${++n}`, replyTo: number, number, pushName: 'Badr', kind: 'text', text })
const audioMsg = (number = ME) => handleIncoming({ id: `m${++n}`, replyTo: number, number, kind: 'audio' })
const imageMsg = (caption?: string) => handleIncoming({ id: `m${++n}`, replyTo: ME, number: ME, kind: 'image', text: caption })

const texts = () => h.sent.filter((s) => s.type === 'text').map((s) => s.body)
const images = () => h.sent.filter((s) => s.type === 'image').map((s) => s.body)
const lastText = () => texts().at(-1) ?? ''
const state = (number = ME) => getSessionState(number)

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  useConfig({ CLAUDE_PRINT_TOOLS: 'mcp__bambu__print', ALLOWED_NUMBERS: `${ME},${FRIEND}` })
  resetAll()
  h.sent.length = 0
  vi.clearAllMocks()
  h.evo.sendText.mockImplementation(async (to: string, text: string) => void h.sent.push({ type: 'text', to, body: text }))
  h.evo.getMediaBase64.mockImplementation(async () => Buffer.from('media').toString('base64'))
  h.synthesize.mockResolvedValue(null)
  h.camera.enabled = false
  h.capturePhoto.mockImplementation(async () => null)
  h.captureLiveView.mockImplementation(async () => ({ jpeg: null, failure: 'unsupported' }))
  fakeClaude()
})

// ══════════════════════════════════════════════════════════════════

describe('conception', () => {
  it('accuse réception, conçoit sans pouvoir imprimer, envoie l’aperçu et attend la validation', async () => {
    await textMsg('Fais-moi un porte-clé AUSIM')

    expect(texts()[0]).toMatch(/^🎨/)
    expect(h.runClaude).toHaveBeenCalledTimes(1)
    const run = h.runClaude.mock.calls[0][0]
    expect(run.prompt).toContain('DEMANDE de Badr : Fais-moi un porte-clé AUSIM')
    expect(run.prompt).toContain('N’imprime pas')
    expect(run.resume).toBeUndefined()
    expect(run.disallowedTools).toEqual(['mcp__bambu__print'])
    expect(readFileSync(path.join(run.cwd, 'request.txt'), 'utf8')).toContain('porte-clé AUSIM')

    expect(images()).toHaveLength(1)
    expect(images()[0]).toContain('Porte-clé AUSIM')
    expect(images()[0]).toContain('50 × 20 × 4 mm')
    expect(images()[0]).toContain('~12 min')
    expect(images()[0]).toContain('*oui*')

    expect(state()?.state).toBe('awaiting_confirm')
    expect(state()?.busy).toBeNull()
    expect(state()?.claudeSessionId).toBe('sess-1')
  })

  it('envoie la phrase « say » en vocal quand la voix est configurée', async () => {
    h.synthesize.mockResolvedValue('b2dn')
    await textMsg('un vase')
    expect(h.synthesize).toHaveBeenCalledWith(JOB.say)
    expect(h.sent.at(-1)).toMatchObject({ type: 'voice', body: 'b2dn' })
  })

  it('envoi du vocal en échec → l’aperçu reste valide', async () => {
    h.synthesize.mockResolvedValue('b2dn')
    h.evo.sendVoice.mockRejectedValueOnce(new Error('415'))
    await textMsg('un vase')
    expect(images()).toHaveLength(1)
    expect(state()?.state).toBe('awaiting_confirm')
  })

  it('sans voix configurée, aucun vocal n’est envoyé', async () => {
    await textMsg('un vase')
    expect(h.evo.sendVoice).not.toHaveBeenCalled()
  })

  it('aperçu absent (OpenSCAD indisponible) → légende en texte avec avertissement', async () => {
    fakeClaude({ preview: false })
    await textMsg('un vase')
    expect(images()).toHaveLength(0)
    expect(lastText()).toContain('Porte-clé AUSIM')
    expect(lastText()).toContain('aperçu indisponible')
    expect(state()?.state).toBe('awaiting_confirm')
  })

  it('envoi de l’image en échec → repli sur la légende en texte', async () => {
    h.evo.sendImage.mockRejectedValueOnce(new Error('413'))
    await textMsg('un vase')
    expect(lastText()).toContain('Porte-clé AUSIM')
    expect(state()?.state).toBe('awaiting_confirm')
  })

  it('aperçu sans job.json → légende de repli avec le texte de Claude', async () => {
    fakeClaude({ job: null, text: 'Voici un vase torsadé.' })
    await textMsg('un vase')
    expect(images()[0]).toContain('Voici un vase torsadé.')
    expect(images()[0]).toContain('*oui*')
  })

  it('Claude en erreur sans rien produire → message clair, retour au repos', async () => {
    fakeClaude({ isError: true, preview: false, job: null, text: 'quota dépassé' })
    await textMsg('un vase')
    expect(lastText()).toContain('La conception a échoué')
    expect(lastText()).toContain('quota dépassé')
    expect(state()?.state).toBe('idle')
    expect(state()?.busy).toBeNull()
  })

  it('Claude sans erreur mais sans fichiers → demande de reformuler', async () => {
    fakeClaude({ preview: false, job: null, text: 'Je ne comprends pas.' })
    await textMsg('blabla')
    expect(lastText()).toContain('reformuler')
    expect(state()?.state).toBe('idle')
  })

  it('Claude en erreur mais aperçu produit → l’aperçu est quand même proposé', async () => {
    fakeClaude({ isError: true, text: 'timeout' })
    await textMsg('un vase')
    expect(images()).toHaveLength(1)
    expect(state()?.state).toBe('awaiting_confirm')
  })
})

describe('validation de l’aperçu', () => {
  beforeEach(async () => {
    await textMsg('Fais-moi un porte-clé AUSIM')
    h.sent.length = 0
    h.runClaude.mockClear()
  })

  it('« oui » → impression en reprenant la session, avec le plugin autorisé', async () => {
    await textMsg('Oui vas-y')
    expect(texts()[0]).toMatch(/^🚀/)
    const run = h.runClaude.mock.calls[0][0]
    expect(run.prompt).toMatch(/^CONFIRMATION/)
    expect(run.resume).toBe('sess-1')
    expect(run.disallowedTools).toBeUndefined()
    expect(lastText()).toContain('✅ Impression lancée')
    expect(lastText()).toContain('Lancé sur la P1S')
    expect(state()?.state).toBe('idle')
    expect(state()?.lastPrint).toContain('Porte-clé AUSIM')
  })

  it('« oui » → annonce vocale avec la durée', async () => {
    h.synthesize.mockResolvedValue('b2dn')
    await textMsg('ok')
    expect(h.synthesize).toHaveBeenCalledWith(expect.stringContaining('12 minutes'))
  })

  it('« non » → annulé, sans appeler Claude', async () => {
    await textMsg('non merci')
    expect(h.runClaude).not.toHaveBeenCalled()
    expect(lastText()).toContain('Pas d’impression')
    expect(state()?.state).toBe('idle')
  })

  it('demande de changement → modification dans le même dossier et la même session', async () => {
    const firstDir = state()?.jobDir as string
    let previewExistedDuringCall = true
    fakeClaude({
      job: { ...JOB, size_mm: [70, 28, 4] },
      onCall: (run) => (previewExistedDuringCall = existsSync(path.join(run.cwd, 'out', 'preview.png'))),
    })
    await textMsg('Oui mais plus grand')

    const run = h.runClaude.mock.calls[0][0]
    expect(run.prompt).toMatch(/^MODIFICATION DEMANDÉE : Oui mais plus grand/)
    expect(run.resume).toBe('sess-1')
    expect(run.cwd).toBe(firstDir)
    expect(run.disallowedTools).toEqual(['mcp__bambu__print'])
    // l'ancien aperçu est effacé avant : jamais d'aperçu périmé envoyé
    expect(previewExistedDuringCall).toBe(false)
    expect(texts()[0]).toMatch(/^✏️/)
    expect(images()[0]).toContain('70 × 28 × 4 mm')
    expect(state()?.state).toBe('awaiting_confirm')
  })

  it('« ok, fais-le en étoile » est une modification, pas une impression', async () => {
    await textMsg('ok, fais-le en étoile')
    expect(h.runClaude.mock.calls[0][0].prompt).toMatch(/^MODIFICATION/)
  })

  it('modification en échec → on garde l’ancien modèle en attente', async () => {
    fakeClaude({ isError: true, preview: false, job: null, text: 'erreur' })
    await textMsg('ajoute un trou')
    expect(lastText()).toContain('La conception a échoué')
    expect(state()?.state).toBe('awaiting_confirm')
  })

  it('impression refusée (print.json en erreur) → reste en attente, « oui » relance', async () => {
    fakeClaude({ print: { status: 'error', message: 'Imprimante hors ligne' } })
    await textMsg('oui')
    expect(lastText()).toContain('❌')
    expect(lastText()).toContain('Imprimante hors ligne')
    expect(state()?.state).toBe('awaiting_confirm')

    fakeClaude()
    await textMsg('oui')
    expect(lastText()).toContain('✅ Impression lancée')
    expect(h.runClaude).toHaveBeenCalledTimes(2)
  })

  it('pas de print.json mais Claude OK → considéré comme lancé', async () => {
    fakeClaude({ print: null, text: 'C’est parti.' })
    await textMsg('oui')
    expect(lastText()).toContain('✅ Impression lancée')
    expect(lastText()).toContain('C’est parti.')
  })

  it('pas de print.json et Claude en erreur → échec signalé', async () => {
    fakeClaude({ print: null, isError: true, text: 'plugin absent' })
    await textMsg('oui')
    expect(lastText()).toContain('❌')
    expect(lastText()).toContain('plugin absent')
    expect(state()?.state).toBe('awaiting_confirm')
  })

  it('un ancien print.json ne fait jamais croire à un succès', async () => {
    writeFileSync(path.join(state()?.jobDir as string, 'out', 'print.json'), JSON.stringify({ status: 'sent' }))
    fakeClaude({ print: null, isError: true, text: 'plugin absent' })
    await textMsg('oui')
    expect(lastText()).toContain('❌')
  })

  it('nouvelle demande après une impression → nouveau dossier, nouvelle session', async () => {
    const firstDir = state()?.jobDir
    await textMsg('oui')
    h.runClaude.mockClear()
    await textMsg('un vase géométrique')
    const run = h.runClaude.mock.calls[0][0]
    expect(run.cwd).not.toBe(firstDir)
    expect(run.resume).toBeUndefined()
    expect(run.prompt).toMatch(/^DEMANDE/)
  })
})

describe('« oui » / « non » sans rien en attente', () => {
  it.each(['oui', 'Lance', 'non'])('« %s » ne déclenche ni conception ni impression', async (t) => {
    await textMsg(t)
    expect(h.runClaude).not.toHaveBeenCalled()
    expect(lastText()).toContain('rien en attente')
  })

  it('« oui » envoyé deux fois après l’impression → pas de deuxième impression', async () => {
    await textMsg('un vase')
    await textMsg('oui')
    await textMsg('oui')
    expect(h.runClaude).toHaveBeenCalledTimes(2) // conception + 1 impression
    expect(lastText()).toContain('rien en attente')
  })
})

describe('concurrence', () => {
  it('message pendant la conception → « patiente », pas de deuxième appel Claude', async () => {
    const gate = deferred<void>()
    h.runClaude.mockImplementationOnce(async (run) => {
      await gate.promise
      mkdirSync(path.join(run.cwd, 'out'), { recursive: true })
      writeFileSync(path.join(run.cwd, 'out', 'preview.png'), PNG)
      return { sessionId: 'sess-1', text: 'ok', isError: false, durationMs: 1 }
    })
    const first = textMsg('un vase')
    await vi.waitFor(() => expect(h.runClaude).toHaveBeenCalledTimes(1))
    await textMsg('plus grand')
    expect(lastText()).toContain('patiente')
    await textMsg('oui')
    expect(lastText()).toContain('patiente')
    gate.resolve()
    await first
    expect(h.runClaude).toHaveBeenCalledTimes(1)
    expect(state()?.state).toBe('awaiting_confirm')
  })

  it('message pendant l’impression → « une seconde »', async () => {
    await textMsg('un vase')
    const gate = deferred<void>()
    h.runClaude.mockImplementationOnce(async () => {
      await gate.promise
      return { sessionId: 'sess-1', text: 'ok', isError: false, durationMs: 1 }
    })
    const printing = textMsg('oui')
    await vi.waitFor(() => expect(state()?.busy).toBe('print'))
    await textMsg('oui')
    expect(lastText()).toContain('J’envoie l’impression')
    gate.resolve()
    await printing
    expect(h.runClaude).toHaveBeenCalledTimes(2)
  })

  it('deux vocaux simultanés → une seule conception', async () => {
    h.transcribe.mockResolvedValue('un porte-clé')
    const gate = deferred<void>()
    h.runClaude.mockImplementation(async (run) => {
      await gate.promise
      mkdirSync(path.join(run.cwd, 'out'), { recursive: true })
      writeFileSync(path.join(run.cwd, 'out', 'preview.png'), PNG)
      return { sessionId: 'sess-1', text: 'ok', isError: false, durationMs: 1 }
    })
    const both = Promise.all([audioMsg(), audioMsg()])
    await vi.waitFor(() => expect(texts().some((t) => t.includes('patiente'))).toBe(true))
    gate.resolve()
    await both
    expect(h.runClaude).toHaveBeenCalledTimes(1)
  })

  it('deux numéros autorisés → sessions indépendantes', async () => {
    await textMsg('un vase', ME)
    await textMsg('un cube', FRIEND)
    expect(state(ME)?.jobDir).not.toBe(state(FRIEND)?.jobDir)
    await textMsg('oui', FRIEND)
    expect(state(FRIEND)?.state).toBe('idle')
    expect(state(ME)?.state).toBe('awaiting_confirm')
  })
})

describe('vocaux', () => {
  it('transcrit, renvoie ce qui a été compris, puis conçoit', async () => {
    h.transcribe.mockResolvedValue('un support de téléphone')
    await audioMsg()
    expect(h.evo.getMediaBase64).toHaveBeenCalled()
    expect(texts()[0]).toBe('🎤 _« un support de téléphone »_')
    expect(h.runClaude.mock.calls[0][0].prompt).toContain('un support de téléphone')
  })

  it('vocal « oui » sur un aperçu → impression', async () => {
    await textMsg('un vase')
    h.transcribe.mockResolvedValue('Oui, vas-y.')
    await audioMsg()
    expect(h.runClaude.mock.calls[1][0].prompt).toMatch(/^CONFIRMATION/)
  })

  it('transcription en échec → message clair, sans Claude', async () => {
    h.transcribe.mockRejectedValue(new Error('Groq 500'))
    await audioMsg()
    expect(lastText()).toContain('écouter ton vocal')
    expect(h.runClaude).not.toHaveBeenCalled()
  })

  it('téléchargement du vocal en échec → même message', async () => {
    h.evo.getMediaBase64.mockRejectedValueOnce(new Error('404'))
    await audioMsg()
    expect(lastText()).toContain('écouter ton vocal')
  })

  it('vocal vide → « rien entendu »', async () => {
    h.transcribe.mockResolvedValue('')
    await audioMsg()
    expect(lastText()).toContain('rien entendu')
    expect(h.runClaude).not.toHaveBeenCalled()
  })
})

describe('photos', () => {
  it('nouveau job avec input.jpg, mentionné dans le prompt', async () => {
    await imageMsg('Fais ce dessin en 3D')
    const run = h.runClaude.mock.calls[0][0]
    expect(readFileSync(path.join(run.cwd, 'input.jpg')).toString()).toBe('media')
    expect(run.prompt).toContain('Fais ce dessin en 3D')
    expect(run.prompt).toContain('input.jpg')
    expect(run.resume).toBeUndefined()
  })

  it('sans légende → consigne par défaut', async () => {
    await imageMsg()
    expect(h.runClaude.mock.calls[0][0].prompt).toContain('photo jointe')
  })

  it('photo pendant une attente de validation → nouveau job (pas une modification)', async () => {
    await textMsg('un vase')
    const firstDir = state()?.jobDir
    await imageMsg('plutôt ça')
    const run = h.runClaude.mock.calls[1][0]
    expect(run.prompt).toMatch(/^DEMANDE/)
    expect(run.cwd).not.toBe(firstDir)
    expect(run.resume).toBeUndefined()
  })

  it('photo non récupérée → message', async () => {
    h.evo.getMediaBase64.mockRejectedValueOnce(new Error('404'))
    await imageMsg()
    expect(lastText()).toContain('récupérer ta photo')
    expect(h.runClaude).not.toHaveBeenCalled()
  })
})

describe('filtrage', () => {
  it('numéro non autorisé → aucune réponse, aucun appel', async () => {
    await textMsg('imprime un truc', '33700000000')
    expect(h.sent).toHaveLength(0)
    expect(h.runClaude).not.toHaveBeenCalled()
  })

  it('message en double (même id) → traité une seule fois', async () => {
    const msg = { id: 'dup', replyTo: ME, number: ME, kind: 'text' as const, text: 'un vase' }
    await handleIncoming(msg)
    await handleIncoming(msg)
    expect(h.runClaude).toHaveBeenCalledTimes(1)
  })

  it('autre type de message (sticker…) → rappel de l’usage', async () => {
    await handleIncoming({ id: 'st', replyTo: ME, number: ME, kind: 'other' })
    expect(lastText()).toContain('Envoie-moi un vocal')
  })
})

describe('commandes', () => {
  it('/aide', async () => {
    await textMsg('/aide')
    expect(lastText()).toBe(HELP)
  })

  it('/status selon l’état', async () => {
    await textMsg('/status')
    expect(lastText()).toContain('prêt')
    await textMsg('un vase')
    await textMsg('/status')
    expect(lastText()).toContain('en attente de ta validation')
    expect(lastText()).toContain('Porte-clé AUSIM')
    await textMsg('oui')
    await textMsg('/status')
    expect(lastText()).toContain('Dernière impression')
  })

  it('/reset efface la session : un « oui » ensuite n’imprime rien', async () => {
    await textMsg('un vase')
    await textMsg('/reset')
    expect(lastText()).toContain('repart de zéro')
    await textMsg('oui')
    expect(h.runClaude).toHaveBeenCalledTimes(1)
    expect(lastText()).toContain('rien en attente')
  })

  it('les commandes répondent même pendant une conception', async () => {
    const gate = deferred<void>()
    h.runClaude.mockImplementationOnce(async () => {
      await gate.promise
      return { sessionId: 's', text: '', isError: true, durationMs: 1 }
    })
    const busy = textMsg('un vase')
    await vi.waitFor(() => expect(state()?.busy).toBe('design'))
    await textMsg('/status')
    expect(lastText()).toContain('conception en cours')
    gate.resolve()
    await busy
  })
})

describe('robustesse', () => {
  it('erreur inattendue → message d’excuse, et le bot reste utilisable', async () => {
    h.runClaude.mockRejectedValueOnce(new Error('crash'))
    await textMsg('un vase')
    expect(lastText()).toContain('Oups')
    expect(state()?.busy).toBeNull()
    await textMsg('un vase')
    expect(images()).toHaveLength(1)
  })

  it('WhatsApp en panne pendant l’envoi des textes → pas de plantage', async () => {
    h.evo.sendText.mockRejectedValue(new Error('down'))
    await expect(textMsg('un vase')).resolves.toBeUndefined()
    expect(state()?.state).toBe('awaiting_confirm')
  })
})

describe('formatCaption', () => {
  it('sans job → texte de Claude + consigne', () => {
    expect(formatCaption(null, 'Voilà')).toBe('Voilà\n\nRéponds *oui* pour imprimer, *non* pour annuler, ou dis-moi quoi changer.')
  })
  it('job partiel → seulement les infos présentes', () => {
    const c = formatCaption({ title: 'Cube' }, '')
    expect(c).toContain('🧊 *Cube*')
    expect(c).not.toContain('📐')
    expect(c).not.toContain('⏱️')
  })
  it('arrondit les dimensions et la durée', () => {
    const c = formatCaption({ size_mm: [50.4, 19.6, 4], est_print_minutes: 11.6 }, '')
    expect(c).toContain('50 × 20 × 4 mm')
    expect(c).toContain('~12 min')
  })
})

// ══════════════════════════════════════════════════════════════════
describe('après l’impression : suivi à distance et caméra', () => {
  let JPEG: Buffer
  beforeAll(async () => {
    JPEG = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#335577' } }).jpeg().toBuffer()
  })
  const lastImageCall = () => h.evo.sendImage.mock.calls.at(-1)!

  beforeEach(() => {
    useConfig({ ALLOWED_NUMBERS: `${ME},${FRIEND}`, PRINTER_LOCATION: 'Casablanca', PRINT_PREP_MINUTES: '5' })
  })

  async function designAndPrint(number = ME) {
    await textMsg('un porte-clé', number)
    await textMsg('oui', number)
  }

  it('annonce les prochaines nouvelles et démarre le suivi', async () => {
    await designAndPrint()
    expect(lastText()).toContain('✅ Impression lancée')
    expect(lastText()).toContain('nouvelles dans ~6 min')
    expect(state()?.monitor?.active).toBe(true)
  })

  it('photo « ça imprime » puis photo finale + vocal, au bon moment (horloge simulée)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      h.capturePhoto.mockResolvedValue(JPEG)
      h.synthesize.mockResolvedValue('b2dn')
      await designAndPrint()
      const before = h.evo.sendImage.mock.calls.length

      await vi.advanceTimersByTimeAsync(6 * 60_000)
      await vi.waitFor(() => expect(h.evo.sendImage.mock.calls.length).toBe(before + 1))
      expect(lastImageCall()[1]).toBe(JPEG.toString('base64'))
      expect(lastImageCall()[2]).toContain('📸 Ça imprime à Casablanca')
      expect(lastImageCall()[3]).toBe('image/jpeg')

      // print.json annonce 12 min → fin à 5 + 12 + 1 = 18 min
      await vi.advanceTimersByTimeAsync(12 * 60_000)
      await vi.waitFor(() => expect(lastImageCall()[2]).toContain('🏁 *Porte-clé AUSIM* devrait être prêt à Casablanca'))
      await vi.waitFor(() => expect(state()?.monitor?.active).toBe(false))
      expect(h.synthesize).toHaveBeenLastCalledWith('Ton objet devrait être prêt à Casablanca !')
      expect(state()?.monitor?.active).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('/photo : vue en direct en JPEG', async () => {
    h.captureLiveView.mockResolvedValue({ jpeg: JPEG })
    await textMsg('/photo')
    expect(lastImageCall()[2]).toBe('📷 En direct de Casablanca')
    expect(lastImageCall()[3]).toBe('image/jpeg')
    expect(h.runClaude).not.toHaveBeenCalled()
  })

  it('/photo pendant une impression : progression dans la légende', async () => {
    await designAndPrint()
    h.captureLiveView.mockResolvedValue({ jpeg: JPEG })
    await textMsg('/photo')
    expect(lastImageCall()[2]).toContain('🔥 Préparation de l’imprimante')
  })

  it('/photo sans caméra → explication de la cause', async () => {
    h.captureLiveView.mockResolvedValue({ jpeg: null, failure: 'window_not_found' })
    await textMsg('/photo')
    expect(lastText()).toBe('HELP:window_not_found')
  })

  it('/photo : capture qui plante → explication, pas de crash', async () => {
    h.captureLiveView.mockRejectedValue(new Error('boom'))
    await textMsg('/photo')
    expect(lastText()).toBe('HELP:capture_failed')
  })

  it('vocal « Montre-moi l’imprimante » → photo, pas de conception', async () => {
    h.transcribe.mockResolvedValue('Montre-moi l’imprimante.')
    h.captureLiveView.mockResolvedValue({ jpeg: JPEG })
    await audioMsg()
    expect(h.captureLiveView).toHaveBeenCalled()
    expect(h.runClaude).not.toHaveBeenCalled()
  })

  it('/photo marche aussi pendant une attente de validation, sans la casser', async () => {
    await textMsg('un vase')
    h.captureLiveView.mockResolvedValue({ jpeg: JPEG })
    await textMsg('photo')
    expect(state()?.state).toBe('awaiting_confirm')
    await textMsg('oui')
    expect(lastText()).toContain('✅ Impression lancée')
  })

  it('/status affiche la progression', async () => {
    await designAndPrint()
    await textMsg('/status')
    expect(lastText()).toContain('🔥 Préparation de l’imprimante')
  })

  it('/reset arrête le suivi', async () => {
    await designAndPrint()
    const monitor = state()?.monitor
    await textMsg('/reset')
    expect(monitor?.active).toBe(false)
  })
})

describe('plateau à distance : une seule pièce à la fois', () => {
  it('deuxième impression → avertissement « plateau vide », puis « oui » confirme', async () => {
    await textMsg('un porte-clé')
    await textMsg('oui')
    await textMsg('un vase')
    expect(h.runClaude).toHaveBeenCalledTimes(3)

    await textMsg('oui')
    expect(lastText()).toContain('Le plateau doit être *vide*')
    expect(h.runClaude).toHaveBeenCalledTimes(3)

    await textMsg('oui')
    expect(h.runClaude).toHaveBeenCalledTimes(4)
    expect(lastText()).toContain('✅ Impression lancée')
  })

  it('l’avertissement revient pour chaque nouvelle impression', async () => {
    await textMsg('a'); await textMsg('oui')
    await textMsg('b'); await textMsg('oui'); await textMsg('oui')
    await textMsg('c'); await textMsg('oui')
    expect(lastText()).toContain('plateau doit être *vide*')
  })

  it('« non » après l’avertissement → annulé', async () => {
    await textMsg('a'); await textMsg('oui')
    await textMsg('b'); await textMsg('oui')
    await textMsg('non')
    expect(lastText()).toContain('Pas d’impression')
    expect(h.runClaude).toHaveBeenCalledTimes(3)
  })

  it('une seule imprimante : l’impression d’un autre numéro compte aussi', async () => {
    await textMsg('a', FRIEND)
    await textMsg('oui', FRIEND)
    await textMsg('b', ME)
    await textMsg('oui', ME)
    expect(lastText()).toContain('plateau doit être *vide*')
  })

  it('une impression échouée ne compte pas', async () => {
    await textMsg('a')
    fakeClaude({ print: { status: 'error', message: 'hors ligne' } })
    await textMsg('oui')
    fakeClaude()
    await textMsg('oui')
    expect(lastText()).toContain('✅ Impression lancée')
  })

  it('nouvelle impression → l’ancien suivi est arrêté', async () => {
    await textMsg('a'); await textMsg('oui')
    const first = state()?.monitor
    await textMsg('b'); await textMsg('oui'); await textMsg('oui')
    expect(first?.active).toBe(false)
    expect(state()?.monitor?.active).toBe(true)
  })
})
