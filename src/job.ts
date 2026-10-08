/**
 * Dossier de job : création, lecture de job.json / print.json, rendu de l'aperçu.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { getConfig } from './config.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'job' })

const JobSchema = z
  .object({
    title: z.string().optional(),
    summary: z.string().optional(),
    size_mm: z.array(z.number()).optional(),
    est_print_minutes: z.number().optional(),
    say: z.string().optional(),
  })
  .passthrough()

export type JobInfo = z.infer<typeof JobSchema>

const PrintSchema = z
  .object({
    status: z.string(),
    message: z.string().optional(),
    est_minutes: z.number().optional(),
  })
  .passthrough()

export type PrintInfo = z.infer<typeof PrintSchema>

export function slugify(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'objet'
  )
}

export function createJobDir(request: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(getConfig().jobsDir, `${stamp}-${slugify(request)}`)
  mkdirSync(path.join(dir, 'out'), { recursive: true })
  writeFileSync(path.join(dir, 'request.txt'), request + '\n')
  return dir
}

function readJson<T>(file: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(file)) return null
  try {
    return schema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch (err) {
    log.warn({ file, error: String(err) }, 'JSON illisible')
    return null
  }
}

export const readJob = (dir: string) => readJson(path.join(dir, 'out', 'job.json'), JobSchema)
export const readPrint = (dir: string) => readJson(path.join(dir, 'out', 'print.json'), PrintSchema)

/** Supprime les sorties d'une itération précédente pour ne jamais envoyer un aperçu périmé. */
export function clearOutputs(dir: string, files = ['preview.png', 'job.json', 'print.json']): void {
  for (const f of files) rmSync(path.join(dir, 'out', f), { force: true })
}

function run(bin: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      log.warn({ bin, error: err.message }, 'Commande introuvable')
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) log.warn({ bin, code, stderr: stderr.slice(-400) }, 'Commande en échec')
      resolve(code === 0)
    })
  })
}

const usable = (file: string) => existsSync(file) && statSync(file).size > 0

/**
 * Garantit un aperçu PNG : celui de Claude s'il existe, sinon rendu OpenSCAD
 * du .scad (ou d'un .stl importé). Retourne le chemin, ou null.
 */
export async function ensurePreview(dir: string): Promise<string | null> {
  const out = path.join(dir, 'out')
  const preview = path.join(out, 'preview.png')
  if (usable(preview)) return preview

  const files = existsSync(out) ? readdirSync(out) : []
  const scad = files.find((f) => f === 'model.scad') ?? files.find((f) => f.endsWith('.scad'))
  const stl = files.find((f) => f.toLowerCase().endsWith('.stl'))

  let source: string | null = null
  if (scad) source = path.join(out, scad)
  else if (stl) {
    source = path.join(out, '_preview_wrapper.scad')
    writeFileSync(source, `import("${stl}");\n`)
  }
  if (!source) return null

  log.info({ source }, 'Rendu de l’aperçu par PrintBot (Claude ne l’a pas produit)')
  const ok = await run(
    getConfig().openscadBin,
    ['-o', preview, '--imgsize=1080,1080', '--viewall', '--autocenter', '--colorscheme=Tomorrow Night', source],
    out,
  )
  return ok && usable(preview) ? preview : null
}
