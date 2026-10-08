/**
 * Serveur HTTP : webhook Evolution + page de connexion WhatsApp (QR).
 */

import express from 'express'
import { handleIncoming } from './bot.js'
import { logger } from './logger.js'
import { getEvolution } from './providers/evolution.js'
import { parseEvolutionWebhook } from './whatsapp.js'

const log = logger.child({ module: 'server' })

export function createServer() {
  const app = express()
  app.use(express.json({ limit: '25mb' }))

  // Evolution attend une réponse rapide : on accuse réception tout de suite,
  // le traitement (Claude, plusieurs minutes) continue en arrière-plan.
  const webhook: express.RequestHandler = (req, res) => {
    res.json({ ok: true })
    const messages = parseEvolutionWebhook(req.body)
    for (const msg of messages) {
      log.info({ from: msg.number, kind: msg.kind, text: msg.text?.slice(0, 80) }, 'Message reçu')
      handleIncoming(msg).catch((err) => log.error({ error: String(err) }, 'Traitement en échec'))
    }
  }
  // Evolution ajoute parfois le nom de l'événement à l'URL (/webhook/messages-upsert)
  app.post('/webhook', webhook)
  app.post('/webhook/:event', webhook)

  app.get('/health', async (_req, res) => {
    let whatsapp = 'unknown'
    try {
      whatsapp = await getEvolution().getConnectionState()
    } catch {
      whatsapp = 'unreachable'
    }
    res.json({ ok: true, whatsapp })
  })

  app.get('/qr.json', async (_req, res) => {
    try {
      const state = await getEvolution().getConnectionState().catch(() => 'unknown')
      if (state === 'open') return void res.json({ state })
      const qr = await getEvolution().getQrCode()
      res.json({ state, qr: qr.base64 ?? null })
    } catch (err) {
      res.status(502).json({ error: String(err) })
    }
  })

  app.get(['/', '/qr'], (_req, res) => {
    res.type('html').send(QR_PAGE)
  })

  return app
}

const QR_PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PrintBot · WhatsApp</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8e8e8;font:16px system-ui,sans-serif}
  main{text-align:center;padding:24px}
  img{width:320px;height:320px;background:#fff;border-radius:16px;padding:12px}
  .ok{font-size:64px}
  p{color:#9aa0a6}
</style></head>
<body><main>
  <h1>🖨️ PrintBot</h1>
  <div id="box"><p>Chargement…</p></div>
  <p>WhatsApp › Appareils connectés › Connecter un appareil</p>
</main>
<script>
async function refresh(){
  const box=document.getElementById('box')
  try{
    const r=await fetch('/qr.json'); const d=await r.json()
    if(d.state==='open'){box.innerHTML='<div class="ok">✅</div><h2>WhatsApp connecté</h2><p>Envoie un vocal au bot !</p>';return}
    box.innerHTML=d.qr?'<img alt="QR code" src="'+d.qr+'">':'<p>QR indisponible ('+(d.error||d.state)+')</p>'
  }catch(e){box.innerHTML='<p>Evolution injoignable</p>'}
  setTimeout(refresh,15000)
}
refresh()
</script></body></html>`
