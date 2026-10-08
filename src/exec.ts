/**
 * Lance une commande système avec délai maximum. Ne lève jamais d'exception :
 * le résultat dit si ça a marché, pour que le bot reste debout quoi qu'il arrive.
 */

import { spawn } from 'node:child_process'
import { logger } from './logger.js'

const log = logger.child({ module: 'exec' })

export interface CommandResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

export function runCommand(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ ok: false, code: null, stdout: '', stderr: String(err) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 120_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      log.warn({ bin, error: err.message }, 'Commande introuvable')
      resolve({ ok: false, code: null, stdout, stderr: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) log.warn({ bin, code, stderr: stderr.slice(-400) }, 'Commande en échec')
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}
