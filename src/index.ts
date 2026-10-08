import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { getConfig } from './config.js'
import { logger } from './logger.js'
import { getEvolution } from './providers/evolution.js'
import { ttsEnabled } from './providers/tts.js'
import { createServer } from './server.js'

const config = getConfig()
mkdirSync(config.jobsDir, { recursive: true })

function check(bin: string, args: string[]): boolean {
  const r = spawnSync(bin, args, { stdio: 'ignore' })
  return r.status === 0
}

// Vérifications de démarrage : mieux vaut le savoir maintenant que sur scène.
if (!config.allowedNumbers.length) logger.warn('ALLOWED_NUMBERS est vide : le bot ignorera tous les messages')
if (!config.groqApiKey) logger.warn('GROQ_API_KEY manquant : les vocaux ne seront pas transcrits')
if (!check(config.claudeBin, ['--version'])) logger.error(`Claude Code introuvable (${config.claudeBin})`)
if (!check(config.openscadBin, ['--version'])) logger.warn(`OpenSCAD introuvable (${config.openscadBin}) : pas d'aperçu de secours`)
if (config.claudePermissionMode !== 'bypassPermissions' && config.claudePermissionMode !== 'dontAsk')
  logger.warn(`CLAUDE_PERMISSION_MODE=${config.claudePermissionMode} : les outils non autorisés seront refusés en mode headless`)

createServer().listen(config.port, async () => {
  logger.info(`🖨️  PrintBot écoute sur http://localhost:${config.port}  (QR : /qr)`)
  logger.info(`Numéros autorisés : ${config.allowedNumbers.join(', ') || 'aucun'} · voix : ${ttsEnabled() ? 'oui' : 'non'}`)
  try {
    logger.info(`WhatsApp : ${await getEvolution().getConnectionState()}`)
  } catch {
    logger.warn(`Evolution API injoignable sur ${config.evolutionApiUrl} — lance « docker compose up -d »`)
  }
})
