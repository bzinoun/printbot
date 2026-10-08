import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { getConfig } from './config.js'
import { logger } from './logger.js'
import { cameraEnabled, listWindows, pickWindow } from './printer/camera.js'
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

if (!cameraEnabled()) logger.warn('Caméra désactivée (pas sur macOS ou CAMERA_MODE=off) : les suivis seront envoyés sans photo')
else if (config.cameraMode === 'window')
  void listWindows().then((wins) => {
    if (!pickWindow(wins, config.cameraApp))
      logger.warn(`Caméra : fenêtre « ${config.cameraApp} » introuvable — ouvre l’app sur la vue caméra (test : npm run snapshot)`)
    else logger.info(`📷 Caméra : fenêtre « ${config.cameraApp} » trouvée`)
  })

createServer().listen(config.port, async () => {
  logger.info(`🖨️  PrintBot écoute sur http://localhost:${config.port}  (QR : /qr)`)
  logger.info(`Numéros autorisés : ${config.allowedNumbers.join(', ') || 'aucun'} · voix : ${ttsEnabled() ? 'oui' : 'non'}`)
  try {
    logger.info(`WhatsApp : ${await getEvolution().getConnectionState()}`)
  } catch {
    logger.warn(`Evolution API injoignable sur ${config.evolutionApiUrl} — lance « docker compose up -d »`)
  }
})
