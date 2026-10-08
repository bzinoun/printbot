/**
 * Crée l'instance WhatsApp dans Evolution API et branche le webhook vers PrintBot.
 * Usage : npm run setup  (Evolution doit tourner : docker compose up -d)
 */

import { getConfig } from '../src/config.js'
import { getEvolution } from '../src/providers/evolution.js'

const config = getConfig()
const evo = getEvolution()

try {
  await evo.createInstance(config.webhookPublicUrl)
  console.log(`✅ Instance « ${config.evolutionInstance} » créée`)
} catch (err) {
  const msg = String(err)
  if (/already|in use|existe/i.test(msg)) console.log(`ℹ️  Instance « ${config.evolutionInstance} » déjà existante`)
  else {
    console.error(`❌ Création impossible : ${msg}`)
    process.exit(1)
  }
}

try {
  await evo.setWebhook(config.webhookPublicUrl)
  console.log(`✅ Webhook → ${config.webhookPublicUrl}`)
} catch (err) {
  console.warn(`⚠️  Webhook d'instance non configuré (le webhook global du docker-compose suffit) : ${err}`)
}

const state = await evo.getConnectionState().catch(() => 'unknown')
console.log(`📱 WhatsApp : ${state}`)
if (state !== 'open') console.log(`👉 Lance « npm start » puis ouvre http://localhost:${config.port}/qr pour scanner le QR code`)
