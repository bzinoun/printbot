/**
 * Configuration — lue une seule fois depuis l'environnement (.env).
 */

import path from 'node:path'
import { z } from 'zod'

const csv = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'oui'].includes(v.toLowerCase())

const ConfigSchema = z.object({
  port: z.number().int().positive(),

  evolutionApiUrl: z.string().url(),
  evolutionApiKey: z.string().min(1, 'EVOLUTION_API_KEY manquant'),
  evolutionInstance: z.string().min(1),
  webhookPublicUrl: z.string().url(),

  allowedNumbers: z.array(z.string().regex(/^\d{6,15}$/, 'ALLOWED_NUMBERS : chiffres uniquement')),

  groqApiKey: z.string(),
  sttLanguage: z.string(),

  elevenLabsApiKey: z.string(),
  elevenLabsVoiceId: z.string(),
  voiceReplies: z.boolean(),

  claudeBin: z.string().min(1),
  claudeModel: z.string(),
  claudePermissionMode: z.enum(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']),
  claudePluginDir: z.string(),
  claudePrintTools: z.array(z.string()),
  claudeTimeoutMs: z.number().int().positive(),

  openscadBin: z.string().min(1),
  jobsDir: z.string().min(1),

  cameraMode: z.enum(['window', 'screen', 'off']),
  cameraApp: z.string().min(1),
  printerLocation: z.string(),
  printPrepMinutes: z.number().min(0),
})

export type Config = z.infer<typeof ConfigSchema>

let cached: Config | null = null

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    port: Number(env.PORT ?? 4100),

    evolutionApiUrl: env.EVOLUTION_API_URL ?? 'http://localhost:8085',
    evolutionApiKey: env.EVOLUTION_API_KEY ?? '',
    evolutionInstance: env.EVOLUTION_INSTANCE ?? 'printbot',
    webhookPublicUrl: env.WEBHOOK_PUBLIC_URL ?? 'http://host.docker.internal:4100/webhook',

    allowedNumbers: csv(env.ALLOWED_NUMBERS).map((n) => n.replace(/\D/g, '')),

    groqApiKey: env.GROQ_API_KEY ?? '',
    sttLanguage: env.STT_LANGUAGE ?? 'fr',

    elevenLabsApiKey: env.ELEVENLABS_API_KEY ?? '',
    elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID ?? '',
    voiceReplies: bool(env.VOICE_REPLIES, true),

    claudeBin: env.CLAUDE_BIN || 'claude',
    claudeModel: env.CLAUDE_MODEL ?? '',
    claudePermissionMode: env.CLAUDE_PERMISSION_MODE || 'bypassPermissions',
    claudePluginDir: env.CLAUDE_PLUGIN_DIR ?? '',
    claudePrintTools: csv(env.CLAUDE_PRINT_TOOLS),
    claudeTimeoutMs: Number(env.CLAUDE_TIMEOUT_MS || 480_000),

    openscadBin: env.OPENSCAD_BIN || 'openscad',
    jobsDir: path.resolve(env.JOBS_DIR || './jobs'),

    cameraMode: env.CAMERA_MODE || 'window',
    cameraApp: env.CAMERA_APP || 'Bambu Studio',
    printerLocation: env.PRINTER_LOCATION ?? '',
    printPrepMinutes: Number(env.PRINT_PREP_MINUTES || 5),
  })
}

export function getConfig(): Config {
  if (!cached) cached = loadConfig()
  return cached
}

/** Pour les tests : force une configuration. */
export function setConfig(config: Config): void {
  cached = config
}
