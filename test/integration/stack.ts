/**
 * Monte toute la démo en local, sans rien de réel :
 *   faux WhatsApp (Evolution) ⇄ VRAI serveur PrintBot ⇄ faux Claude / Whisper / ElevenLabs
 *   + faux outils macOS pour la « caméra » (fenêtre Bambu Studio).
 * Le temps du suivi est accéléré : 1 « minute » = 40 ms.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { vi } from 'vitest'
import { resetAll, whenIdle } from '../../src/bot.js'
import { loadConfig, setConfig } from '../../src/config.js'
import { screenTools } from '../../src/printer/camera.js'
import { sttRetry } from '../../src/providers/stt.js'
import { createServer } from '../../src/server.js'
import { FakeEvolution } from '../fakes/evolution.js'
import { FakeElevenLabs, FakeGroq } from '../fakes/voice.js'

export const ME = '212612345678'
export const STRANGER = '33700000000'
export const MINUTE_MS = 40

const here = path.dirname(fileURLToPath(import.meta.url))

export interface ClaudeCall {
  args: string[]
  prompt: string
  cwd: string
  hasInput: boolean
}

export interface Stack {
  evo: FakeEvolution
  groq: FakeGroq
  eleven: FakeElevenLabs
  botUrl: string
  /** Image que renvoie la « caméra » (capture de la fenêtre Bambu Studio). */
  cameraJpeg: Buffer
  claudeCalls: () => ClaudeCall[]
  text: (t: string, from?: string) => Promise<string>
  voice: (spoken: string, from?: string) => Promise<string>
  image: (jpeg: Buffer, caption?: string) => Promise<string>
  /** Attend une condition sur ce que le téléphone a reçu. */
  until: (check: () => void, timeoutMs?: number) => Promise<void>
  stop: () => Promise<void>
}

function fakeTool(dir: string, name: string, body: string): string {
  const file = path.join(dir, name)
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

export async function startStack(env: Record<string, string> = {}): Promise<Stack> {
  const [evo, groq, eleven] = await Promise.all([new FakeEvolution().start(), new FakeGroq().start(), new FakeElevenLabs().start()])

  const tmp = mkdtempSync(path.join(tmpdir(), 'printbot-int-'))
  const claudeLog = path.join(tmp, 'claude.log')

  // « Caméra » : faux osascript (liste des fenêtres) + faux screencapture (vraie image JPEG)
  const cameraJpeg = await sharp({ create: { width: 1280, height: 800, channels: 3, background: '#2b2b2b' } }).jpeg({ quality: 80 }).toBuffer()
  const cameraFile = path.join(tmp, 'camera.jpg')
  writeFileSync(cameraFile, cameraJpeg)
  writeFileSync(path.join(tmp, 'package.json'), '{"type":"commonjs"}')
  Object.assign(screenTools, {
    platform: 'darwin',
    tmpDir: tmp,
    osascript: fakeTool(tmp, 'osascript', `console.log(JSON.stringify([{id:4242,owner:'Bambu Studio',name:'A1 mini',layer:0,w:1280,h:800,onscreen:true}]))`),
    screencapture: fakeTool(tmp, 'screencapture', `const a=process.argv.slice(2);require('fs').copyFileSync(${JSON.stringify(cameraFile)},a[a.length-1])`),
    sips: fakeTool(tmp, 'sips', ''),
  })

  process.env.FAKE_CLAUDE_LOG = claudeLog
  setConfig(
    loadConfig({
      EVOLUTION_API_URL: evo.url,
      EVOLUTION_API_KEY: evo.apiKey,
      EVOLUTION_INSTANCE: evo.instance,
      ALLOWED_NUMBERS: ME,
      GROQ_API_KEY: groq.apiKey,
      GROQ_API_URL: groq.url,
      STT_LANGUAGE: 'fr',
      ELEVENLABS_API_KEY: eleven.apiKey,
      ELEVENLABS_VOICE_ID: eleven.voiceId,
      ELEVENLABS_API_URL: eleven.url,
      CLAUDE_BIN: path.resolve(here, '../fakes/claude.mjs'),
      CLAUDE_PRINT_TOOLS: 'mcp__bambu__print_file',
      JOBS_DIR: path.join(tmp, 'jobs'),
      OPENSCAD_BIN: '/nonexistent/openscad',
      CAMERA_MODE: 'window',
      CAMERA_APP: 'Bambu Studio',
      PRINTER_LOCATION: 'Casablanca',
      PRINT_PREP_MINUTES: '1',
      PRINTBOT_MINUTE_MS: String(MINUTE_MS),
      PRINTBOT_RETRY_MS: '10',
      ...env,
    }),
  )
  sttRetry.backoffMs = 5
  resetAll()

  const server: Server = createServer().listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const botUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const { fakeVoiceNote } = await import('../fakes/voice.js')

  return {
    evo,
    groq,
    eleven,
    botUrl,
    cameraJpeg,
    claudeCalls: () =>
      existsSync(claudeLog) ? readFileSync(claudeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ClaudeCall) : [],
    text: (t, from = ME) => evo.userText(botUrl, from, t),
    voice: (spoken, from = ME) => evo.userVoice(botUrl, from, fakeVoiceNote(spoken)),
    image: (jpeg, caption) => evo.userImage(botUrl, ME, jpeg, caption),
    until: (check, timeoutMs = 10_000) => vi.waitFor(check, { timeout: timeoutMs, interval: 15 }),
    stop: async () => {
      await whenIdle()
      resetAll()
      await new Promise((r) => {
        server.close(r)
        server.closeAllConnections()
      })
      await Promise.all([evo.stop(), groq.stop(), eleven.stop()])
    },
  }
}
