/**
 * Crée l'instance WhatsApp dans Evolution API et branche le webhook vers PrintBot.
 * Usage : npm run setup  (Evolution doit tourner : docker compose up -d)
 */

import { getConfig } from '../src/config.js'
import { getEvolution } from '../src/providers/evolution.js'

const config = getConfig()
const evo = getEvolution()

try {
  if (await evo.instanceExists()) {
    console.log(`✅ Instance « ${config.evolutionInstance} » déjà créée`)
  } else {
    await evo.createInstance(config.webhookPublicUrl)
    console.log(`✅ Instance « ${config.evolutionInstance} » créée`)
  }
} catch (err) {
  console.error(`❌ Instance WhatsApp impossible à créer : ${err}`)
  process.exit(1)
}

try {
  await evo.setWebhook(config.webhookPublicUrl)
  console.log(`✅ Webhook → ${config.webhookPublicUrl}`)
} catch {
  console.log('ℹ️  Webhook global du docker-compose utilisé')
}

const state = await evo.getConnectionState().catch(() => 'unknown')
console.log(`📱 WhatsApp : ${state}`)
if (state !== 'open') console.log(`👉 QR code à scanner : http://localhost:${config.port}/qr (avec le téléphone du bot)`)
