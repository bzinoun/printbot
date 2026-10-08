import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig, setConfig, type Config } from '../config.js'

export const ME = '212600000001'
export const FRIEND = '212600000002'

/** PNG 1×1 valide. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

export function tempDir(prefix = 'printbot-test-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

/** Configure l'application pour un test (variables d'env simulées). */
export function useConfig(env: Record<string, string> = {}): Config {
  const config = loadConfig({
    EVOLUTION_API_KEY: 'test-key',
    EVOLUTION_API_URL: 'http://evo.test',
    ALLOWED_NUMBERS: ME,
    JOBS_DIR: tempDir('printbot-jobs-'),
    OPENSCAD_BIN: '/nonexistent/openscad',
    ...env,
  })
  setConfig(config)
  return config
}

/** Écrit un script Node exécutable (faux binaire). */
export function fakeBin(dir: string, name: string, body: string): string {
  const file = path.join(dir, name)
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}
