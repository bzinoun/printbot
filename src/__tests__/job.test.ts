import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearOutputs, createJobDir, ensurePreview, readJob, readPrint, slugify } from '../job.js'
import { fakeBin, PNG, tempDir, useConfig } from './helpers.js'

let jobsDir: string
beforeEach(() => {
  jobsDir = tempDir('printbot-jobs-')
  useConfig({ JOBS_DIR: jobsDir })
})

function jobWith(files: Record<string, string | Buffer>): string {
  const dir = createJobDir('test')
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, 'out', name), content)
  return dir
}

describe('slugify', () => {
  it('accents, ponctuation, longueur', () => {
    expect(slugify('Été : porte-clé « AUSIM » !!')).toBe('ete-porte-cle-ausim')
    expect(slugify('a'.repeat(100))).toHaveLength(40)
    expect(slugify('🎉🎉')).toBe('objet')
    expect(slugify('../../etc/passwd')).toBe('etc-passwd')
  })
})

describe('createJobDir', () => {
  it('crée le dossier, out/ et request.txt dans JOBS_DIR', () => {
    const dir = createJobDir('Un porte-clé')
    expect(path.dirname(dir)).toBe(jobsDir)
    expect(path.basename(dir)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-un-porte-cle$/)
    expect(existsSync(path.join(dir, 'out'))).toBe(true)
    expect(readFileSync(path.join(dir, 'request.txt'), 'utf8')).toBe('Un porte-clé\n')
  })

  it('une demande malveillante ne sort pas de JOBS_DIR', () => {
    const dir = createJobDir('../../../tmp/evil')
    expect(dir.startsWith(jobsDir + path.sep)).toBe(true)
  })
})

describe('readJob / readPrint', () => {
  it('lit un job.json valide et garde les champs inconnus', () => {
    const dir = jobWith({ 'job.json': JSON.stringify({ title: 'Cube', size_mm: [1, 2, 3], extra: 'ok' }) })
    expect(readJob(dir)).toMatchObject({ title: 'Cube', size_mm: [1, 2, 3], extra: 'ok' })
  })
  it('fichier absent → null', () => {
    expect(readJob(jobWith({}))).toBeNull()
    expect(readPrint(jobWith({}))).toBeNull()
  })
  it('JSON cassé → null (pas d’exception)', () => {
    expect(readJob(jobWith({ 'job.json': '{"title": "Cube",' }))).toBeNull()
  })
  it('types incorrects → null', () => {
    expect(readJob(jobWith({ 'job.json': JSON.stringify({ size_mm: '50x20' }) }))).toBeNull()
  })
  it('print.json sans status → null', () => {
    expect(readPrint(jobWith({ 'print.json': JSON.stringify({ message: 'x' }) }))).toBeNull()
    expect(readPrint(jobWith({ 'print.json': JSON.stringify({ status: 'sent', est_minutes: 9 }) }))).toMatchObject({ status: 'sent', est_minutes: 9 })
  })
})

describe('clearOutputs', () => {
  it('efface aperçu, job.json et print.json mais garde le modèle', () => {
    const dir = jobWith({ 'preview.png': PNG, 'job.json': '{}', 'print.json': '{}', 'model.scad': 'cube(1);' })
    clearOutputs(dir)
    expect(existsSync(path.join(dir, 'out', 'preview.png'))).toBe(false)
    expect(existsSync(path.join(dir, 'out', 'job.json'))).toBe(false)
    expect(existsSync(path.join(dir, 'out', 'print.json'))).toBe(false)
    expect(existsSync(path.join(dir, 'out', 'model.scad'))).toBe(true)
  })
  it('liste ciblée, et pas d’erreur si les fichiers n’existent pas', () => {
    const dir = jobWith({ 'preview.png': PNG })
    clearOutputs(dir, ['print.json'])
    expect(existsSync(path.join(dir, 'out', 'preview.png'))).toBe(true)
  })
})

describe('ensurePreview', () => {
  let binDir: string
  let logFile: string
  /** Faux OpenSCAD : écrit un PNG à l'emplacement -o et journalise ses arguments. */
  const fakeOpenscad = (exitCode = 0) =>
    fakeBin(
      binDir,
      'openscad',
      `const fs=require('fs');const a=process.argv.slice(2);
       fs.appendFileSync(process.env.LOG_FILE,JSON.stringify({a,cwd:process.cwd()})+'\\n');
       if(${exitCode}===0) fs.writeFileSync(a[a.indexOf('-o')+1],Buffer.from('png'));
       process.exit(${exitCode})`,
    )
  const calls = () =>
    existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []

  beforeEach(() => {
    binDir = tempDir('printbot-scad-')
    logFile = path.join(binDir, 'calls.log')
    process.env.LOG_FILE = logFile
    // les faux binaires sont en CommonJS
    writeFileSync(path.join(binDir, 'package.json'), '{"type":"commonjs"}')
  })

  it('aperçu déjà produit par Claude → réutilisé, OpenSCAD non appelé', async () => {
    useConfig({ JOBS_DIR: jobsDir, OPENSCAD_BIN: fakeOpenscad() })
    const dir = jobWith({ 'preview.png': PNG, 'model.scad': 'cube(1);' })
    expect(await ensurePreview(dir)).toBe(path.join(dir, 'out', 'preview.png'))
    expect(calls()).toHaveLength(0)
  })

  it('aperçu vide (0 octet) → re-rendu', async () => {
    useConfig({ JOBS_DIR: jobsDir, OPENSCAD_BIN: fakeOpenscad() })
    const dir = jobWith({ 'preview.png': '', 'model.scad': 'cube(1);' })
    expect(await ensurePreview(dir)).not.toBeNull()
    expect(calls()).toHaveLength(1)
  })

  it('rend model.scad en priorité, avec les bons réglages', async () => {
    useConfig({ JOBS_DIR: jobsDir, OPENSCAD_BIN: fakeOpenscad() })
    const dir = jobWith({ 'a-brouillon.scad': 'sphere(1);', 'model.scad': 'cube(1);' })
    const preview = await ensurePreview(dir)
    expect(preview).toBe(path.join(dir, 'out', 'preview.png'))
    const [{ a }] = calls()
    expect(a.at(-1)).toBe(path.join(dir, 'out', 'model.scad'))
    expect(a).toEqual(expect.arrayContaining(['--imgsize=1080,1080', '--viewall', '--autocenter', '--colorscheme=Tomorrow Night']))
  })

  it('seulement un STL → enveloppe OpenSCAD qui l’importe', async () => {
    useConfig({ JOBS_DIR: jobsDir, OPENSCAD_BIN: fakeOpenscad() })
    const dir = jobWith({ 'Model.STL': 'solid x' })
    expect(await ensurePreview(dir)).not.toBeNull()
    const wrapper = path.join(dir, 'out', '_preview_wrapper.scad')
    expect(readFileSync(wrapper, 'utf8')).toBe('import("Model.STL");\n')
    expect(calls()[0].a.at(-1)).toBe(wrapper)
  })

  it('aucun modèle → null', async () => {
    useConfig({ JOBS_DIR: jobsDir, OPENSCAD_BIN: fakeOpenscad() })
    expect(await ensurePreview(jobWith({ 'job.json': '{}' }))).toBeNull()
    expect(calls()).toHaveLength(0)
  })

  it('OpenSCAD en échec → null', async () => {
    useConfig({ JOBS_DIR: jobsDir, OPENSCAD_BIN: fakeOpenscad(1) })
    expect(await ensurePreview(jobWith({ 'model.scad': 'cube(1);' }))).toBeNull()
  })

  it('OpenSCAD introuvable → null, sans exception', async () => {
    useConfig({ JOBS_DIR: jobsDir, OPENSCAD_BIN: '/nonexistent/openscad' })
    expect(await ensurePreview(jobWith({ 'model.scad': 'cube(1);' }))).toBeNull()
  })

  it('dossier out/ absent → null', async () => {
    const dir = path.join(jobsDir, 'vide')
    mkdirSync(dir)
    expect(await ensurePreview(dir)).toBeNull()
  })
})
