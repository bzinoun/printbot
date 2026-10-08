import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildClaudeArgs, childEnv, parseClaudeOutput, runClaude } from '../claude.js'
import { fakeBin, tempDir, useConfig } from './helpers.js'

describe('buildClaudeArgs', () => {
  it('options minimales : headless, JSON, permissions, consignes', () => {
    useConfig()
    const args = buildClaudeArgs({ prompt: 'x', cwd: '/tmp' }, 'CONSIGNES')
    expect(args.slice(0, 5)).toEqual(['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions'])
    expect(args).toContain('--append-system-prompt')
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('CONSIGNES')
    expect(args).not.toContain('--resume')
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--plugin-dir')
    expect(args).not.toContain('--disallowedTools')
    // le prompt passe par stdin, jamais en argument
    expect(args).not.toContain('x')
  })

  it('modèle, plugin, reprise de session et outils interdits', () => {
    useConfig({ CLAUDE_MODEL: 'sonnet', CLAUDE_PLUGIN_DIR: '/plugins/bambu', CLAUDE_PERMISSION_MODE: 'dontAsk' })
    const args = buildClaudeArgs({ prompt: 'x', cwd: '/tmp', resume: 'sess-9', disallowedTools: ['mcp__a', 'mcp__b'] }, 'S')
    const after = (flag: string) => args[args.indexOf(flag) + 1]
    expect(after('--permission-mode')).toBe('dontAsk')
    expect(after('--model')).toBe('sonnet')
    expect(after('--plugin-dir')).toBe('/plugins/bambu')
    expect(after('--resume')).toBe('sess-9')
    expect(after('--disallowedTools')).toBe('mcp__a,mcp__b')
  })

  it('liste d’outils interdits vide → pas d’option', () => {
    useConfig()
    expect(buildClaudeArgs({ prompt: 'x', cwd: '/', disallowedTools: [] }, 'S')).not.toContain('--disallowedTools')
  })
})

describe('childEnv', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('retire les variables qui rattacheraient Claude à une session parente', () => {
    Object.assign(process.env, {
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'parent',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: '1',
      CLAUDE_PID: '42',
      ANTHROPIC_API_KEY: 'sk-garde',
      PATH_TEST: 'garde',
    })
    const env = childEnv('/bin/openscad')
    for (const v of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS', 'CLAUDE_PID'])
      expect(env[v]).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBe('sk-garde')
    expect(env.PATH_TEST).toBe('garde')
    expect(env.OPENSCAD_BIN).toBe('/bin/openscad')
    // l'environnement du bot lui-même n'est pas modifié
    expect(process.env.CLAUDE_CODE_SESSION_ID).toBe('parent')
  })
})

describe('parseClaudeOutput', () => {
  it('résultat JSON unique', () => {
    expect(parseClaudeOutput('{"type":"result","is_error":false,"result":" ok ","session_id":"s"}')).toMatchObject({ text: 'ok', sessionId: 's', isError: false })
  })
  it('lignes parasites avant le JSON', () => {
    const out = 'Warning: something\n{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s"}\n'
    expect(parseClaudeOutput(out)).toMatchObject({ text: 'ok', sessionId: 's', isError: false })
  })
  it('format tableau de messages', () => {
    const out = JSON.stringify([{ type: 'system' }, { type: 'assistant' }, { type: 'result', is_error: false, result: 'fini', session_id: 'z' }])
    expect(parseClaudeOutput(out)).toMatchObject({ text: 'fini', sessionId: 'z', isError: false })
  })
  it('sous-type d’échec (max turns…) → erreur', () => {
    expect(parseClaudeOutput('{"type":"result","subtype":"error_max_turns","is_error":false,"session_id":"s"}').isError).toBe(true)
  })
  it('sortie vide ou illisible → erreur', () => {
    expect(parseClaudeOutput('').isError).toBe(true)
    expect(parseClaudeOutput('{pas du json').isError).toBe(true)
  })
})

describe('runClaude (avec un faux binaire claude)', () => {
  let dir: string
  let cwd: string
  const saved = { ...process.env }

  beforeEach(() => {
    dir = tempDir('printbot-bin-')
    cwd = tempDir('printbot-cwd-')
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('envoie le prompt par stdin, dans le dossier du job, avec un env nettoyé', async () => {
    const bin = fakeBin(
      dir,
      'claude',
      `let p='';process.stdin.on('data',d=>p+=d);process.stdin.on('end',()=>{
        process.stdout.write(JSON.stringify({type:'result',is_error:false,session_id:'abc',
          result: JSON.stringify({prompt:p,cwd:process.cwd(),sess:process.env.CLAUDE_CODE_SESSION_ID??null,
            scad:process.env.OPENSCAD_BIN,args:process.argv.slice(2)})}))})`,
    )
    useConfig({ CLAUDE_BIN: bin, OPENSCAD_BIN: '/opt/openscad' })
    process.env.CLAUDE_CODE_SESSION_ID = 'parent'

    const res = await runClaude({ prompt: 'Fais un « cube » avec $HOME et "guillemets"', cwd, resume: 'r1' })
    expect(res.isError).toBe(false)
    expect(res.sessionId).toBe('abc')
    const seen = JSON.parse(res.text)
    expect(seen.prompt).toBe('Fais un « cube » avec $HOME et "guillemets"')
    expect(realpathSync(seen.cwd)).toBe(realpathSync(cwd))
    expect(seen.sess).toBeNull()
    expect(seen.scad).toBe('/opt/openscad')
    expect(seen.args).toContain('--resume')
    // les consignes de prompts/designer.md sont bien chargées
    expect(seen.args.find((a: string) => a.includes('PrintBot'))).toBeTruthy()
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('timeout → processus arrêté, erreur signalée', async () => {
    const bin = fakeBin(dir, 'claude', `setTimeout(()=>{},60000)`)
    useConfig({ CLAUDE_BIN: bin, CLAUDE_TIMEOUT_MS: '300' })
    const started = Date.now()
    const res = await runClaude({ prompt: 'x', cwd })
    expect(res.isError).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('binaire introuvable → erreur explicite, pas de plantage', async () => {
    useConfig({ CLAUDE_BIN: path.join(dir, 'absent') })
    const res = await runClaude({ prompt: 'x', cwd })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('Impossible de lancer Claude Code')
  })

  it('code de sortie non nul → stderr remonté', async () => {
    const bin = fakeBin(dir, 'claude', `process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('Not logged in');process.exit(1)})`)
    useConfig({ CLAUDE_BIN: bin })
    const res = await runClaude({ prompt: 'x', cwd })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('Not logged in')
  })

  it('JSON is_error → erreur, session conservée', async () => {
    const bin = fakeBin(dir, 'claude', `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'result',is_error:true,result:'boom',session_id:'s2'})))`)
    useConfig({ CLAUDE_BIN: bin })
    const res = await runClaude({ prompt: 'x', cwd })
    expect(res).toMatchObject({ isError: true, text: 'boom', sessionId: 's2' })
  })

  it('le fichier de consignes existe', () => {
    expect(existsSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prompts/designer.md'))).toBe(true)
  })
})
