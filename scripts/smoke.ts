/**
 * Test de bout en bout sans WhatsApp ni imprimante :
 * faux serveur Evolution + faux Claude, vrai serveur PrintBot.
 * Usage : npm run smoke
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'

const ME = '212600000001'
const tmp = mkdtempSync(path.join(tmpdir(), 'printbot-smoke-'))
const claudeLog = path.join(tmp, 'claude.log')

// ── Faux Evolution ────────────────────────────────────────────
const calls: { path: string; body: any }[] = []
const evo = express().use(express.json({ limit: '25mb' }))
evo.post('/chat/getBase64FromMediaMessage/:i', (_req, res) => res.json({ base64: Buffer.from('fake-ogg').toString('base64') }))
evo.post('/chat/sendPresence/:i', (_req, res) => res.json({}))
evo.post(/.*/, (req, res) => {
  calls.push({ path: req.path, body: req.body })
  res.json({ key: { id: 'out-' + calls.length } })
})
evo.get('/instance/connectionState/:i', (_req, res) => res.json({ instance: { state: 'open' } }))
const evoServer = evo.listen(0)
const evoPort = (evoServer.address() as { port: number }).port

// ── Environnement PrintBot ────────────────────────────────────
Object.assign(process.env, {
  EVOLUTION_API_URL: `http://127.0.0.1:${evoPort}`,
  EVOLUTION_API_KEY: 'test',
  EVOLUTION_INSTANCE: 'printbot',
  ALLOWED_NUMBERS: ME,
  GROQ_API_KEY: '',
  ELEVENLABS_API_KEY: '',
  CLAUDE_BIN: path.resolve('test/fake-claude.mjs'),
  CLAUDE_PRINT_TOOLS: 'mcp__bambu__print',
  JOBS_DIR: path.join(tmp, 'jobs'),
  OPENSCAD_BIN: 'openscad',
  FAKE_CLAUDE_LOG: claudeLog,
  LOG_LEVEL: 'warn',
})

const { createServer } = await import('../src/server.js')
const bot = createServer().listen(0)
const botPort = (bot.address() as { port: number }).port

let n = 0
async function send(message: object, messageType = 'conversation', from = ME) {
  await fetch(`http://127.0.0.1:${botPort}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'messages.upsert', instance: 'printbot', data: { key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false, id: `in-${++n}` }, pushName: 'Badr', messageType, message } }),
  })
}

async function waitFor(pred: () => boolean, label: string) {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > 15000) throw new Error(`Timeout : ${label}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const texts = () => calls.filter((c) => c.path.includes('sendText')).map((c) => c.body.text as string)
const media = () => calls.filter((c) => c.path.includes('sendMedia'))
let failures = 0
function check(ok: boolean, label: string) {
  console.log(`${ok ? '✅' : '❌'} ${label}`)
  if (!ok) failures++
}

// 1. Demande
await send({ conversation: 'Fais-moi un porte-clé AUSIM' })
await waitFor(() => media().length === 1, 'aperçu 1')
check(texts().some((t) => t.startsWith('🎨')), 'accusé « je conçois »')
check(media()[0].body.caption.includes('Porte-clé AUSIM') && media()[0].body.caption.includes('50 × 20 × 4 mm'), 'aperçu envoyé avec légende')

// 2. Pendant la conception, un message est mis en attente → ici déjà fini, on modifie
await send({ conversation: 'Oui mais plus grand' })
await waitFor(() => media().length === 2, 'aperçu 2')
check(texts().some((t) => t.startsWith('✏️')), 'modification détectée')
check(media()[1].body.caption.includes('70 × 28 × 4 mm'), 'nouvel aperçu après modification')

// 3. Confirmation
await send({ conversation: 'Oui vas-y' })
await waitFor(() => texts().some((t) => t.startsWith('✅')), 'impression')
check(texts().some((t) => t.startsWith('🚀')), 'accusé « j’envoie à la Bambu »')
check(texts().some((t) => t.includes('P1S')), 'confirmation d’impression relayée')

// 4. Garde-fous côté Claude
const runs = readFileSync(claudeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
check(runs.length === 3, `3 appels Claude (${runs.length})`)
check(runs[0].args.includes('--disallowedTools') && !runs[0].args.includes('--resume'), 'conception : impression interdite, nouvelle session')
check(runs[1].args.includes('--resume') && runs[1].prompt.startsWith('MODIFICATION'), 'modification : reprise de session')
check(runs[2].args.includes('--resume') && !runs[2].args.includes('--disallowedTools') && runs[2].prompt.startsWith('CONFIRMATION'), 'impression : reprise de session, plugin autorisé')

// 5. Vocal sans clé Groq → message d'erreur propre
const before = texts().length
await send({ audioMessage: { seconds: 3 } }, 'audioMessage')
await waitFor(() => texts().length > before, 'erreur vocal')
check(texts().at(-1)!.includes('vocal'), 'vocal non transcrit → message clair')

// 6. Numéro inconnu → ignoré
const count = calls.length
await send({ conversation: 'imprime un truc' }, 'conversation', '33700000000')
await new Promise((r) => setTimeout(r, 500))
check(calls.length === count, 'numéro non autorisé ignoré')

// 7. Commandes
await send({ conversation: '/status' })
await waitFor(() => texts().at(-1)!.startsWith('État'), 'status')
check(texts().at(-1)!.includes('Porte-clé AUSIM'), '/status résume le dernier objet')

console.log(failures ? `\n${failures} échec(s)` : '\nTout est vert 🎉')
bot.close()
evoServer.close()
process.exit(failures ? 1 : 0)
