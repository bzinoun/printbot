/**
 * « Caméra » à distance : l'A1 mini est à Casablanca, hors du réseau local.
 * L'app Bambu (Studio ou Handy) affiche le direct via le cloud sur ce Mac :
 * on photographie sa fenêtre avec les outils intégrés à macOS.
 *
 *   osascript (JXA + CoreGraphics) → identifiant de la fenêtre
 *   screencapture -l <id>           → image de la fenêtre, même cachée derrière une autre
 *   sips -Z 1600                    → taille raisonnable pour WhatsApp
 *
 * Pré-requis : autoriser « Enregistrement de l'écran » pour le terminal qui lance le bot.
 */

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getConfig } from '../config.js'
import { runCommand } from '../exec.js'
import { logger } from '../logger.js'

const log = logger.child({ module: 'camera' })

/** Outils système (remplaçables dans les tests). */
export const screenTools = {
  osascript: 'osascript',
  screencapture: 'screencapture',
  sips: 'sips',
  platform: process.platform as string,
  tmpDir: os.tmpdir(),
}

export interface WindowInfo {
  id: number
  owner: string
  name: string
  layer: number
  w: number
  h: number
  onscreen: boolean
}

/**
 * Liste les fenêtres via CoreGraphics. 16 = kCGWindowListExcludeDesktopElements
 * (inclut aussi les fenêtres hors écran), 0 = kCGNullWindowID.
 */
export const LIST_WINDOWS_JXA = `ObjC.import('CoreGraphics');
var raw = $.CGWindowListCopyWindowInfo(16, 0);
var wins = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
JSON.stringify(wins.map(function (w) {
  var b = w.kCGWindowBounds || {};
  return { id: w.kCGWindowNumber, owner: w.kCGWindowOwnerName || '', name: w.kCGWindowName || '',
           layer: w.kCGWindowLayer || 0, w: b.Width || 0, h: b.Height || 0, onscreen: !!w.kCGWindowIsOnscreen };
}));`

export function cameraEnabled(): boolean {
  return screenTools.platform === 'darwin' && getConfig().cameraMode !== 'off'
}

export async function listWindows(): Promise<WindowInfo[]> {
  const res = await runCommand(screenTools.osascript, ['-l', 'JavaScript', '-e', LIST_WINDOWS_JXA], { timeoutMs: 15_000 })
  if (!res.ok) return []
  try {
    const parsed = JSON.parse(res.stdout.trim())
    return Array.isArray(parsed) ? parsed : []
  } catch {
    log.warn({ stdout: res.stdout.slice(0, 200) }, 'Liste des fenêtres illisible')
    return []
  }
}

/**
 * Choisit la fenêtre principale de l'app : bon propriétaire, fenêtre normale (layer 0),
 * assez grande (pas une infobulle), visible de préférence, puis la plus grande.
 */
export function pickWindow(windows: WindowInfo[], app: string): WindowInfo | null {
  const wanted = app.toLowerCase()
  const candidates = windows.filter(
    (w) => w.owner?.toLowerCase().includes(wanted) && w.layer === 0 && w.w >= 300 && w.h >= 200,
  )
  candidates.sort((a, b) => Number(b.onscreen) - Number(a.onscreen) || b.w * b.h - a.w * a.h)
  return candidates[0] ?? null
}

export type CaptureFailure = 'unsupported' | 'disabled' | 'window_not_found' | 'capture_failed'

export interface CaptureResult {
  jpeg: Buffer | null
  failure?: CaptureFailure
}

/** Photographie le direct de l'imprimante. Ne lève jamais d'exception. */
export async function captureLiveView(): Promise<CaptureResult> {
  const { cameraMode, cameraApp } = getConfig()
  if (screenTools.platform !== 'darwin') return { jpeg: null, failure: 'unsupported' }
  if (cameraMode === 'off') return { jpeg: null, failure: 'disabled' }

  const file = path.join(screenTools.tmpDir, `printbot-camera-${Date.now()}-${process.pid}.jpg`)
  const args = ['-x', '-t', 'jpg']

  if (cameraMode === 'window') {
    const win = pickWindow(await listWindows(), cameraApp)
    if (!win) {
      log.warn({ app: cameraApp }, 'Fenêtre de l’app Bambu introuvable — est-elle ouverte (et pas réduite) ?')
      return { jpeg: null, failure: 'window_not_found' }
    }
    args.push('-o', '-l', String(win.id))
  } else {
    args.push('-m')
  }
  args.push(file)

  try {
    const shot = await runCommand(screenTools.screencapture, args, { timeoutMs: 20_000 })
    if (!shot.ok || !existsSync(file) || statSync(file).size === 0) return { jpeg: null, failure: 'capture_failed' }
    // Écran Retina → images énormes : on réduit (sans bloquer si sips échoue)
    await runCommand(screenTools.sips, ['-Z', '1600', file], { timeoutMs: 20_000 })
    return { jpeg: readFileSync(file) }
  } finally {
    rmSync(file, { force: true })
  }
}

/** Version simple pour le bot : l'image, ou null. */
export async function capturePhoto(): Promise<Buffer | null> {
  try {
    return (await captureLiveView()).jpeg
  } catch (err) {
    log.error({ error: String(err) }, 'Capture impossible')
    return null
  }
}

export function cameraHelp(failure?: CaptureFailure): string {
  const { cameraApp } = getConfig()
  switch (failure) {
    case 'window_not_found':
      return `📷 Je ne trouve pas la fenêtre ${cameraApp}. Ouvre-la sur le Mac du bot (onglet Appareil, vue caméra) sans la réduire.`
    case 'capture_failed':
      return '📷 La capture a échoué. Vérifie l’autorisation « Enregistrement de l’écran » du terminal dans les Réglages macOS.'
    case 'disabled':
      return '📷 La caméra est désactivée (CAMERA_MODE=off).'
    default:
      return '📷 La caméra n’est disponible que lorsque le bot tourne sur un Mac.'
  }
}
