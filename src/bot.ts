/**
 * Orchestration PrintBot :
 *   message (texte / vocal / photo) → conception par Claude → aperçu PNG
 *   → « oui » → impression via le plugin Bambu  |  « non » → annulé  |  autre → modification
 */

import { writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { runClaude } from './claude.js'
import { getConfig } from './config.js'
import { classifyReply, parseCommand } from './intent.js'
import { clearOutputs, createJobDir, ensurePreview, readJob, readPrint, type JobInfo } from './job.js'
import { logger } from './logger.js'
import { toWhatsAppJpeg } from './media.js'
import { cameraEnabled, cameraHelp, captureLiveView, capturePhoto } from './printer/camera.js'
import { PrintMonitor } from './printer/monitor.js'
import { getEvolution } from './providers/evolution.js'
import { transcribe } from './providers/stt.js'
import { synthesize } from './providers/tts.js'
import type { Incoming } from './whatsapp.js'

const log = logger.child({ module: 'bot' })

interface Session {
  state: 'idle' | 'awaiting_confirm'
  busy: null | 'design' | 'print'
  jobDir?: string
  claudeSessionId?: string
  job?: JobInfo | null
  lastPrint?: string
  /** Suivi de la dernière impression lancée (photos, fin estimée). */
  monitor?: PrintMonitor
  /** L'avertissement « plateau vide ? » a déjà été donné pour cet aperçu. */
  plateWarned?: boolean
}

const sessions = new Map<string, Session>()
const seen = new Set<string>()

function session(id: string): Session {
  let s = sessions.get(id)
  if (!s) sessions.set(id, (s = { state: 'idle', busy: null }))
  return s
}

/**
 * Une seule imprimante, partagée par tous les numéros autorisés : l'A1 mini n'éjecte
 * pas ses pièces et personne n'est sur place pour vider le plateau.
 */
let lastPrintAt: number | null = null

export function resetAll(): void {
  for (const s of sessions.values()) s.monitor?.stop()
  sessions.clear()
  seen.clear()
  lastPrintAt = null
}

export function isAllowed(number: string): boolean {
  return getConfig().allowedNumbers.includes(number)
}

// ── Envoi ──────────────────────────────────────────────────────

async function say(to: string, text: string): Promise<void> {
  try {
    await getEvolution().sendText(to, text)
  } catch (err) {
    log.error({ error: String(err) }, 'Envoi du texte impossible')
  }
}

async function speak(to: string, text: string | undefined): Promise<void> {
  if (!text) return
  const audio = await synthesize(text)
  if (!audio) return
  try {
    await getEvolution().sendVoice(to, audio)
  } catch (err) {
    log.warn({ error: String(err) }, 'Envoi du vocal impossible')
  }
}

/** Garde l'indicateur « en train d'écrire… » allumé pendant un long traitement. */
async function withTyping<T>(to: string, work: () => Promise<T>): Promise<T> {
  const evo = getEvolution()
  void evo.typing(to)
  const timer = setInterval(() => void evo.typing(to), 7000)
  try {
    return await work()
  } finally {
    clearInterval(timer)
  }
}

// ── Messages ───────────────────────────────────────────────────

export const HELP = [
  '🖨️ *PrintBot* — je conçois et j’imprime des objets 3D sur la Bambu Lab.',
  '',
  '🎤 Envoie un *vocal* ou un message : « fais-moi un porte-clé avec mon prénom »',
  '📸 Ou une *photo* d’un croquis',
  '👀 Je t’envoie l’aperçu, tu réponds *oui* pour imprimer, *non* pour annuler, ou tu dis ce qu’il faut changer.',
  '',
  '📷 */photo* : vue en direct de l’imprimante',
  'Commandes : /status · /photo · /reset',
].join('\n')

export function formatCaption(job: JobInfo | null | undefined, fallback: string): string {
  if (!job) return `${fallback}\n\nRéponds *oui* pour imprimer, *non* pour annuler, ou dis-moi quoi changer.`
  const lines: string[] = []
  if (job.title) lines.push(`🧊 *${job.title}*`)
  if (job.summary) lines.push(job.summary)
  const meta: string[] = []
  if (job.size_mm?.length) meta.push(`📐 ${job.size_mm.map((n) => Math.round(n)).join(' × ')} mm`)
  if (job.est_print_minutes) meta.push(`⏱️ ~${Math.round(job.est_print_minutes)} min`)
  if (meta.length) lines.push(meta.join('  ·  '))
  lines.push('', 'Réponds *oui* pour imprimer, *non* pour annuler, ou dis-moi quoi changer.')
  return lines.join('\n')
}

// ── Point d'entrée ─────────────────────────────────────────────

/** Traitements en cours (pour attendre la fin du travail : tests, arrêt propre). */
const inFlight = new Set<Promise<void>>()

export function handleIncoming(msg: Incoming): Promise<void> {
  const work = handleIncomingNow(msg)
  inFlight.add(work)
  void work.finally(() => inFlight.delete(work))
  return work
}

/** Résout quand plus aucun message n'est en cours de traitement. */
export async function whenIdle(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight])
}

async function handleIncomingNow(msg: Incoming): Promise<void> {
  if (seen.has(msg.id)) return
  seen.add(msg.id)
  if (seen.size > 1000) seen.delete(seen.values().next().value as string)

  if (!isAllowed(msg.number)) {
    log.warn({ number: msg.number, name: msg.pushName }, 'Numéro non autorisé — ajoute-le à ALLOWED_NUMBERS pour qu’il puisse imprimer')
    return
  }

  try {
    await processMessage(msg)
  } catch (err) {
    // Filet de sécurité : l'utilisateur doit toujours avoir une réponse
    log.error({ error: err instanceof Error ? err.stack : String(err) }, 'Erreur interne')
    await say(msg.replyTo, '😕 Oups, j’ai eu un souci de mon côté. Tu peux renvoyer ta demande ?')
  }
}

/** Pour les tests et /status : état courant d'un numéro. */
export function getSessionState(number: string): Readonly<Session> | undefined {
  return sessions.get(number)
}

async function processMessage(msg: Incoming): Promise<void> {
  const to = msg.replyTo
  const s = session(msg.number)

  // 1. Récupérer le texte de la demande
  let text = msg.text
  let imagePath: string | undefined
  let imageBase64: string | undefined

  if (msg.kind === 'audio') {
    try {
      const audio = await withTyping(to, () => getEvolution().getMediaBase64(msg.id))
      text = await transcribe(audio)
    } catch (err) {
      log.error({ error: String(err) }, 'Vocal non transcrit')
      await say(to, '😕 Je n’ai pas réussi à écouter ton vocal. Tu peux réessayer ou l’écrire ?')
      return
    }
    if (!text) {
      await say(to, '🤔 Je n’ai rien entendu dans ce vocal, tu peux répéter ?')
      return
    }
    await say(to, `🎤 _« ${text} »_`)
  } else if (msg.kind === 'image') {
    try {
      imageBase64 = await getEvolution().getMediaBase64(msg.id)
    } catch (err) {
      log.error({ error: String(err) }, 'Photo non récupérée')
      await say(to, '😕 Je n’ai pas réussi à récupérer ta photo, tu peux la renvoyer ?')
      return
    }
    text = text || 'Reproduis l’objet (ou le croquis) de la photo jointe en version imprimable.'
  } else if (msg.kind === 'other' || !text) {
    await say(to, '🎤 Envoie-moi un vocal, un texte ou une photo pour que je t’imprime quelque chose.')
    return
  }

  // 2. Commandes
  const command = parseCommand(text)
  if (command === 'help') return say(to, HELP)
  if (command === 'status') return say(to, statusText(s))
  if (command === 'photo') return sendLivePhoto(to, s)
  if (command === 'reset') {
    s.monitor?.stop()
    sessions.delete(msg.number)
    return say(to, '🧹 C’est noté, on repart de zéro. Qu’est-ce que je t’imprime ?')
  }

  // 3. Un seul traitement à la fois
  if (s.busy) {
    await say(to, s.busy === 'print' ? '⏳ J’envoie l’impression, une seconde…' : '⏳ Je suis encore en train de concevoir, patiente un instant…')
    return
  }

  // 4. Machine à états
  if (s.state === 'awaiting_confirm' && !imageBase64) {
    const reply = classifyReply(text)
    log.info({ reply, text }, 'Réponse à l’aperçu')
    if (reply === 'confirm') {
      if (lastPrintAt !== null && !s.plateWarned) {
        s.plateWarned = true
        const at = new Date(lastPrintAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        const where = getConfig().printerLocation
        await say(
          to,
          `⚠️ Une impression a déjà été lancée à ${at}${where ? ` à ${where}` : ''}. Le plateau doit être *vide* avant d’en lancer une autre.
Si c’est bon, renvoie *oui*.`,
        )
        return
      }
      return print(to, s)
    }
    if (reply === 'cancel') {
      s.state = 'idle'
      await say(to, '👌 Pas d’impression. Dis-moi quand tu veux autre chose !')
      return
    }
    return design(to, s, text, { modify: true })
  }

  // Un « oui » / « non » isolé alors que rien n'attend de validation
  // (ex. « oui » envoyé deux fois) ne doit pas devenir une demande d'objet « oui ».
  if (!imageBase64 && classifyReply(text) !== 'modify') {
    await say(to, '🤔 Je n’ai rien en attente de validation. Qu’est-ce que je t’imprime ?')
    return
  }

  if (imageBase64) {
    s.jobDir = createJobDir(text)
    s.claudeSessionId = undefined
    imagePath = path.join(s.jobDir, 'input.jpg')
    writeFileSync(imagePath, Buffer.from(imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64, 'base64'))
  }
  return design(to, s, text, { modify: false, imagePath, name: msg.pushName })
}

function statusText(s: Session): string {
  const state = s.busy === 'design' ? '🎨 conception en cours' : s.busy === 'print' ? '🖨️ envoi à l’imprimante' : s.state === 'awaiting_confirm' ? '👀 en attente de ta validation' : '😴 prêt'
  const lines = [`État : ${state}`]
  if (s.job?.title) lines.push(`Dernier objet : ${s.job.title}`)
  if (s.lastPrint) lines.push(`Dernière impression : ${s.lastPrint}`)
  const progress = s.monitor?.statusLine()
  if (progress) lines.push(progress)
  return lines.join('\n')
}

// ── Conception ─────────────────────────────────────────────────

async function design(
  to: string,
  s: Session,
  request: string,
  opts: { modify: boolean; imagePath?: string; name?: string },
): Promise<void> {
  s.busy = 'design'
  let voiceLine: string | undefined
  try {
    if (!opts.modify && !opts.imagePath) {
      s.jobDir = createJobDir(request)
      s.claudeSessionId = undefined
    }
    const jobDir = s.jobDir as string
    clearOutputs(jobDir)

    await say(to, opts.modify ? '✏️ Je modifie le modèle…' : '🎨 Je conçois ton objet, une à deux minutes…')

    const prompt = opts.modify
      ? `MODIFICATION DEMANDÉE : ${request}\nMets à jour out/model.scad, puis régénère out/model.stl, out/preview.png et out/job.json. N'imprime pas.`
      : [
          `DEMANDE${opts.name ? ` de ${opts.name}` : ''} : ${request}`,
          opts.imagePath ? 'Une photo est jointe : input.jpg (croquis ou objet de référence).' : '',
          'Conçois le modèle, l’aperçu et job.json. N’imprime pas.',
        ]
          .filter(Boolean)
          .join('\n')

    const result = await withTyping(to, () =>
      runClaude({
        prompt,
        cwd: jobDir,
        resume: s.claudeSessionId,
        disallowedTools: getConfig().claudePrintTools,
      }),
    )
    if (result.sessionId) s.claudeSessionId = result.sessionId

    const job = readJob(jobDir)
    const preview = await ensurePreview(jobDir)

    if (result.isError && !preview) {
      await say(to, `😕 La conception a échoué : ${result.text.slice(0, 300) || 'erreur inconnue'}\nTu peux reformuler ?`)
      s.state = s.job ? 'awaiting_confirm' : 'idle'
      return
    }
    if (!preview && !job) {
      await say(to, `😕 ${result.text || 'Je n’ai pas réussi à produire le modèle.'}\nTu peux reformuler ta demande ?`)
      s.state = 'idle'
      return
    }

    s.job = job
    const caption = formatCaption(job, result.text)
    if (preview) {
      const png = await readFile(preview)
      try {
        await sendPicture(to, png, caption)
      } catch {
        await say(to, caption)
      }
    } else {
      await say(to, `${caption}\n\n(⚠️ aperçu indisponible)`)
    }
    s.state = 'awaiting_confirm'
    voiceLine = job?.say ?? caption
  } finally {
    s.busy = null
  }
  // La note vocale (1 à 3 s chez ElevenLabs) part APRÈS avoir libéré le bot :
  // un « oui » envoyé dès l'affichage de l'aperçu doit être accepté, pas refusé.
  if (voiceLine) await speak(to, voiceLine)
}

// ── Impression ─────────────────────────────────────────────────

async function print(to: string, s: Session): Promise<void> {
  if (!s.jobDir) {
    s.state = 'idle'
    await say(to, '🤔 Je n’ai aucun modèle en attente. Qu’est-ce que je t’imprime ?')
    return
  }
  s.busy = 'print'
  let voiceLine: string | undefined
  try {
    clearOutputs(s.jobDir, ['print.json'])
    await say(to, '🚀 C’est parti, j’envoie à la Bambu Lab…')

    const result = await withTyping(to, () =>
      runClaude({
        prompt:
          'CONFIRMATION : l’utilisateur a validé l’aperçu. Lance maintenant l’impression du modèle préparé dans out/ sur la Bambu Lab avec le plugin, puis écris out/print.json.',
        cwd: s.jobDir as string,
        resume: s.claudeSessionId,
      }),
    )
    if (result.sessionId) s.claudeSessionId = result.sessionId

    const info = readPrint(s.jobDir)
    const sent = info ? info.status === 'sent' : !result.isError
    const detail = info?.message || result.text

    if (sent) {
      s.state = 'idle'
      s.plateWarned = false
      lastPrintAt = Date.now()
      s.lastPrint = `${s.job?.title ?? 'objet'} (${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })})`
      const monitor = startMonitor(to, s, info?.est_minutes ?? s.job?.est_print_minutes)
      const next = Math.round((monitor.firstLayerAt - monitor.startedAt) / getConfig().minuteMs)
      await say(to, `✅ Impression lancée !${detail ? `\n${detail}` : ''}\n⏱️ Je t’envoie des nouvelles dans ~${next} min.`)
      voiceLine = `C'est parti, l'impression est lancée${info?.est_minutes ? `, environ ${Math.round(info.est_minutes)} minutes` : ''}.`
    } else {
      s.state = 'awaiting_confirm'
      await say(to, `❌ L’impression n’est pas partie : ${detail.slice(0, 300) || 'erreur inconnue'}\nRéponds *oui* pour réessayer.`)
    }
  } finally {
    s.busy = null
  }
  if (voiceLine) await speak(to, voiceLine)
}

// ── Suivi et caméra ────────────────────────────────────────────

/**
 * Envoie une image qui s'affiche dans la conversation WhatsApp (JPEG, type « image »),
 * jamais comme un fichier joint. Lève une erreur si l'envoi échoue.
 */
async function sendPicture(to: string, image: Buffer, caption: string): Promise<void> {
  const { data, mimetype } = await toWhatsAppJpeg(image)
  await getEvolution().sendImage(to, data.toString('base64'), caption, mimetype)
}

async function sendImageOrText(to: string, jpeg: Buffer, caption: string): Promise<void> {
  try {
    await sendPicture(to, jpeg, caption)
  } catch (err) {
    log.warn({ error: String(err) }, 'Envoi de la photo impossible')
    await say(to, caption)
  }
}

function startMonitor(to: string, s: Session, estMinutes?: number): PrintMonitor {
  s.monitor?.stop()
  const c = getConfig()
  s.monitor = new PrintMonitor(
    { prepMinutes: c.printPrepMinutes, estMinutes, title: s.job?.title, location: c.printerLocation || undefined, minuteMs: c.minuteMs },
    {
      capture: capturePhoto,
      cameraExpected: cameraEnabled(),
      sendPhoto: (jpeg, caption) => sendImageOrText(to, jpeg, caption),
      sendText: (text) => say(to, text),
      speak: (text) => speak(to, text),
    },
  ).start()
  return s.monitor
}

async function sendLivePhoto(to: string, s: Session): Promise<void> {
  void getEvolution().typing(to)
  const shot = await captureLiveView().catch(() => ({ jpeg: null, failure: 'capture_failed' as const }))
  if (!shot.jpeg) return say(to, cameraHelp(shot.failure))
  const where = getConfig().printerLocation
  const progress = s.monitor?.statusLine()
  await sendImageOrText(to, shot.jpeg, `📷 En direct${where ? ` de ${where}` : ''}${progress ? `\n${progress}` : ''}`)
}
