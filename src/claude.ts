/**
 * Exécution de Claude Code en mode headless (`claude -p`).
 *
 * Le prompt passe par stdin (évite les problèmes d'échappement et les options
 * variadiques qui avaleraient l'argument). Sortie JSON → session_id réutilisé
 * avec --resume pour les modifications et la confirmation d'impression.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getConfig } from './config.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'claude' })

const PROMPT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prompts/designer.md')

export interface ClaudeRun {
  prompt: string
  cwd: string
  /** Reprendre une session existante (modification / confirmation). */
  resume?: string
  /** Outils interdits pour cet appel (ex : outils d'impression pendant la conception). */
  disallowedTools?: string[]
}

export interface ClaudeResult {
  sessionId?: string
  text: string
  isError: boolean
  costUsd?: number
  durationMs: number
}

export function buildClaudeArgs(run: ClaudeRun, systemPrompt: string): string[] {
  const c = getConfig()
  const args = ['-p', '--output-format', 'json', '--permission-mode', c.claudePermissionMode]
  args.push('--append-system-prompt', systemPrompt)
  if (c.claudeModel) args.push('--model', c.claudeModel)
  if (c.claudePluginDir) args.push('--plugin-dir', c.claudePluginDir)
  if (run.resume) args.push('--resume', run.resume)
  if (run.disallowedTools?.length) args.push('--disallowedTools', run.disallowedTools.join(','))
  return args
}

/** Extrait l'objet résultat de la sortie JSON de `claude -p --output-format json`. */
export function parseClaudeOutput(stdout: string): Omit<ClaudeResult, 'durationMs'> {
  const trimmed = stdout.trim()
  const candidates = [trimmed, ...trimmed.split('\n').reverse()]
  for (const candidate of candidates) {
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue
    try {
      const parsed = JSON.parse(candidate)
      const obj = Array.isArray(parsed) ? parsed.findLast((e) => e?.type === 'result') : parsed
      if (!obj) continue
      return {
        sessionId: obj.session_id,
        text: String(obj.result ?? '').trim(),
        isError: Boolean(obj.is_error) || (obj.subtype && obj.subtype !== 'success'),
        costUsd: obj.total_cost_usd,
      }
    } catch {
      /* ligne non JSON, on continue */
    }
  }
  return { text: trimmed.slice(-500), isError: true }
}

/**
 * Si PrintBot est lancé depuis un terminal où Claude Code tourne déjà, ces variables
 * rattacheraient chaque job à la session parente (et peuvent désactiver les MCP des
 * plugins). On les retire pour que chaque job ait sa propre session propre.
 */
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS',
  'CLAUDE_PID',
]

export function childEnv(openscadBin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENSCAD_BIN: openscadBin }
  for (const name of INHERITED_SESSION_VARS) delete env[name]
  return env
}

export function runClaude(run: ClaudeRun): Promise<ClaudeResult> {
  const c = getConfig()
  const systemPrompt = readFileSync(PROMPT_FILE, 'utf8')
  const args = buildClaudeArgs(run, systemPrompt)
  const started = Date.now()

  log.info({ cwd: run.cwd, resume: run.resume, prompt: run.prompt.slice(0, 120) }, 'Appel Claude')

  return new Promise((resolve) => {
    const child = spawn(c.claudeBin, args, {
      cwd: run.cwd,
      env: childEnv(c.openscadBin),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))

    const timer = setTimeout(() => {
      log.error({ timeoutMs: c.claudeTimeoutMs }, 'Claude trop long — arrêt')
      child.kill('SIGTERM')
    }, c.claudeTimeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ text: `Impossible de lancer Claude Code (${err.message})`, isError: true, durationMs: Date.now() - started })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      const durationMs = Date.now() - started
      const parsed = parseClaudeOutput(stdout)
      if (code !== 0 && !parsed.sessionId) {
        log.error({ code, stderr: stderr.slice(-800) }, 'Claude a échoué')
        resolve({ ...parsed, text: parsed.text || stderr.slice(-300), isError: true, durationMs })
        return
      }
      log.info({ durationMs, costUsd: parsed.costUsd, isError: parsed.isError, sessionId: parsed.sessionId }, 'Claude terminé')
      resolve({ ...parsed, durationMs })
    })

    child.stdin.end(run.prompt)
  })
}
