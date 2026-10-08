import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cameraEnabled,
  cameraHelp,
  captureLiveView,
  capturePhoto,
  LIST_WINDOWS_JXA,
  listWindows,
  pickWindow,
  screenTools,
  type WindowInfo,
} from '../printer/camera.js'
import { fakeBin, tempDir, useConfig } from './helpers.js'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])

const win = (o: Partial<WindowInfo>): WindowInfo => ({ id: 1, owner: 'Bambu Studio', name: '', layer: 0, w: 1200, h: 800, onscreen: true, ...o })

const saved = { ...screenTools }
afterEach(() => Object.assign(screenTools, saved))

describe('pickWindow', () => {
  it('fenêtre principale de l’app, insensible à la casse', () => {
    const wins = [win({ id: 1, owner: 'Finder' }), win({ id: 2, owner: 'bambu studio' })]
    expect(pickWindow(wins, 'Bambu Studio')?.id).toBe(2)
  })
  it('ignore infobulles, menus et barres (layer ≠ 0 ou trop petites)', () => {
    const wins = [win({ id: 1, layer: 25 }), win({ id: 2, w: 120, h: 40 }), win({ id: 3, w: 900, h: 600 })]
    expect(pickWindow(wins, 'Bambu Studio')?.id).toBe(3)
  })
  it('préfère une fenêtre visible, puis la plus grande', () => {
    const wins = [win({ id: 1, w: 2000, h: 1200, onscreen: false }), win({ id: 2, w: 800, h: 600 }), win({ id: 3, w: 1400, h: 900 })]
    expect(pickWindow(wins, 'Bambu Studio')?.id).toBe(3)
  })
  it('accepte une fenêtre hors écran si c’est la seule', () => {
    expect(pickWindow([win({ id: 7, onscreen: false })], 'Bambu Studio')?.id).toBe(7)
  })
  it('Bambu Handy si configuré', () => {
    const wins = [win({ id: 1 }), win({ id: 2, owner: 'Bambu Handy' })]
    expect(pickWindow(wins, 'Bambu Handy')?.id).toBe(2)
  })
  it('aucune fenêtre → null', () => {
    expect(pickWindow([], 'Bambu Studio')).toBeNull()
    expect(pickWindow([win({ owner: 'Safari' })], 'Bambu Studio')).toBeNull()
  })
})

describe('script JXA', () => {
  it('est du JavaScript valide (vérifié sans macOS)', () => {
    expect(() => new Function('ObjC', '$', LIST_WINDOWS_JXA)).not.toThrow()
  })
  it('interroge CoreGraphics et renvoie du JSON', () => {
    expect(LIST_WINDOWS_JXA).toContain('CGWindowListCopyWindowInfo')
    expect(LIST_WINDOWS_JXA).toContain('JSON.stringify')
  })
  it('produit le bon format avec une liste CoreGraphics simulée', () => {
    const cg = [{ kCGWindowNumber: 42, kCGWindowOwnerName: 'Bambu Studio', kCGWindowLayer: 0, kCGWindowBounds: { Width: 1440, Height: 900 }, kCGWindowIsOnscreen: 1 }]
    const ObjC = { import: () => {}, deepUnwrap: (x: unknown) => x, castRefToObject: (x: unknown) => x }
    const $ = { CGWindowListCopyWindowInfo: () => cg }
    const out = new Function('ObjC', '$', LIST_WINDOWS_JXA.replace(/\nJSON\.stringify/, '\nreturn JSON.stringify'))(ObjC, $)
    expect(JSON.parse(out)).toEqual([{ id: 42, owner: 'Bambu Studio', name: '', layer: 0, w: 1440, h: 900, onscreen: true }])
  })
})

describe('captureLiveView (faux outils macOS)', () => {
  let bin: string
  let log: string

  beforeEach(() => {
    bin = tempDir('printbot-mac-')
    log = path.join(bin, 'calls.log')
    writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}')
    const record = `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({bin: require('path').basename(process.argv[1]), args: process.argv.slice(2)}) + '\\n');`
    Object.assign(screenTools, {
      platform: 'darwin',
      tmpDir: tempDir('printbot-snap-'),
      osascript: fakeBin(bin, 'osascript', `${record}
        console.log(JSON.stringify([{id:5,owner:'Finder',name:'',layer:0,w:800,h:600,onscreen:true},
                                    {id:77,owner:'Bambu Studio',name:'A1 mini',layer:0,w:1400,h:900,onscreen:true}]))`),
      screencapture: fakeBin(bin, 'screencapture', `${record}
        const a = process.argv.slice(2); require('fs').writeFileSync(a[a.length-1], Buffer.from(${JSON.stringify([...JPEG])}))`),
      sips: fakeBin(bin, 'sips', record),
    })
    useConfig({ CAMERA_MODE: 'window', CAMERA_APP: 'Bambu Studio' })
  })

  const calls = (): { bin: string; args: string[] }[] =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []

  it('capture la fenêtre Bambu Studio par son identifiant, sans son ni ombre', async () => {
    const res = await captureLiveView()
    expect(res.jpeg?.equals(JPEG)).toBe(true)
    const shot = calls().find((c) => c.bin === 'screencapture')!
    expect(shot.args.slice(0, -1)).toEqual(['-x', '-t', 'jpg', '-o', '-l', '77'])
    expect(shot.args.at(-1)).toMatch(/\.jpg$/)
  })

  it('demande la liste des fenêtres en JXA', async () => {
    await captureLiveView()
    const osa = calls().find((c) => c.bin === 'osascript')!
    expect(osa.args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e'])
  })

  it('réduit l’image pour WhatsApp', async () => {
    await captureLiveView()
    expect(calls().find((c) => c.bin === 'sips')!.args.slice(0, 2)).toEqual(['-Z', '1600'])
  })

  it('ne laisse aucun fichier temporaire', async () => {
    await captureLiveView()
    expect(readdirSync(screenTools.tmpDir)).toEqual([])
  })

  it('mode écran entier : écran principal, sans chercher de fenêtre', async () => {
    useConfig({ CAMERA_MODE: 'screen' })
    const res = await captureLiveView()
    expect(res.jpeg).not.toBeNull()
    expect(calls().some((c) => c.bin === 'osascript')).toBe(false)
    expect(calls().find((c) => c.bin === 'screencapture')!.args).toContain('-m')
  })

  it('app non ouverte → window_not_found, aucune capture', async () => {
    useConfig({ CAMERA_APP: 'Bambu Handy' })
    expect(await captureLiveView()).toEqual({ jpeg: null, failure: 'window_not_found' })
    expect(calls().some((c) => c.bin === 'screencapture')).toBe(false)
  })

  it('screencapture en échec → capture_failed', async () => {
    screenTools.screencapture = fakeBin(bin, 'screencapture-ko', 'process.exit(1)')
    expect(await captureLiveView()).toEqual({ jpeg: null, failure: 'capture_failed' })
  })

  it('image vide (permission refusée) → capture_failed', async () => {
    screenTools.screencapture = fakeBin(bin, 'screencapture-vide', `const a=process.argv.slice(2);require('fs').writeFileSync(a[a.length-1],'')`)
    expect((await captureLiveView()).failure).toBe('capture_failed')
  })

  it('sips en échec → image non réduite mais envoyée quand même', async () => {
    screenTools.sips = fakeBin(bin, 'sips-ko', 'process.exit(3)')
    expect((await captureLiveView()).jpeg?.equals(JPEG)).toBe(true)
  })

  it('osascript en échec ou sortie illisible → liste vide', async () => {
    screenTools.osascript = fakeBin(bin, 'osascript-ko', 'process.exit(1)')
    expect(await listWindows()).toEqual([])
    screenTools.osascript = fakeBin(bin, 'osascript-bad', 'console.log("execution error")')
    expect(await listWindows()).toEqual([])
  })

  it('capturePhoto renvoie directement l’image ou null', async () => {
    expect((await capturePhoto())?.equals(JPEG)).toBe(true)
    useConfig({ CAMERA_MODE: 'off' })
    expect(await capturePhoto()).toBeNull()
  })
})

describe('disponibilité', () => {
  it('hors macOS → indisponible', async () => {
    screenTools.platform = 'linux'
    useConfig()
    expect(cameraEnabled()).toBe(false)
    expect(await captureLiveView()).toEqual({ jpeg: null, failure: 'unsupported' })
  })
  it('CAMERA_MODE=off → désactivée', async () => {
    screenTools.platform = 'darwin'
    useConfig({ CAMERA_MODE: 'off' })
    expect(cameraEnabled()).toBe(false)
    expect(await captureLiveView()).toEqual({ jpeg: null, failure: 'disabled' })
  })
  it('macOS + mode fenêtre → activée', () => {
    screenTools.platform = 'darwin'
    useConfig()
    expect(cameraEnabled()).toBe(true)
  })
})

describe('cameraHelp', () => {
  it('message adapté à chaque cause', () => {
    useConfig({ CAMERA_APP: 'Bambu Studio' })
    expect(cameraHelp('window_not_found')).toContain('Bambu Studio')
    expect(cameraHelp('capture_failed')).toContain('Enregistrement de l’écran')
    expect(cameraHelp('disabled')).toContain('CAMERA_MODE=off')
    expect(cameraHelp('unsupported')).toContain('Mac')
  })
})
