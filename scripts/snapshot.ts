/**
 * Vérifie la « caméra » avant la démo : trouve la fenêtre de l'app Bambu,
 * la photographie et enregistre snapshot.jpg. Usage : npm run snapshot
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { getConfig } from '../src/config.js'
import { cameraHelp, captureLiveView, listWindows, pickWindow, screenTools } from '../src/printer/camera.js'

const { cameraApp, cameraMode } = getConfig()
console.log(`Mode : ${cameraMode} · application : ${cameraApp}`)

if (screenTools.platform !== 'darwin') {
  console.error('❌ La capture ne fonctionne que sur macOS.')
  process.exit(1)
}

if (cameraMode === 'window') {
  const windows = await listWindows()
  const apps = [...new Set(windows.filter((w) => w.layer === 0).map((w) => w.owner))].sort()
  const win = pickWindow(windows, cameraApp)
  if (!win) {
    console.error(`❌ Aucune fenêtre « ${cameraApp} ». Applications ouvertes : ${apps.join(', ') || '(aucune)'}`)
    console.error('   Ouvre l’app, onglet Appareil avec la vue caméra, ou change CAMERA_APP dans .env')
    process.exit(1)
  }
  console.log(`✅ Fenêtre trouvée : #${win.id} « ${win.name || win.owner} » ${win.w}×${win.h}${win.onscreen ? '' : ' (hors écran)'}`)
}

const shot = await captureLiveView()
if (!shot.jpeg) {
  console.error(`❌ ${cameraHelp(shot.failure)}`)
  process.exit(1)
}
const out = path.resolve('snapshot.jpg')
writeFileSync(out, shot.jpeg)
console.log(`✅ Capture enregistrée : ${out} (${Math.round(shot.jpeg.length / 1024)} Ko)`)
console.log('👀 Ouvre-la : si tu ne vois que le fond d’écran, autorise « Enregistrement de l’écran » pour ton terminal')
console.log('   (Réglages système › Confidentialité et sécurité › Enregistrement de l’écran), puis relance le terminal.')
