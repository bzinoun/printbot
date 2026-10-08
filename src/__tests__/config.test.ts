import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'

const base = { EVOLUTION_API_KEY: 'k' }

describe('loadConfig', () => {
  it('valeurs par défaut sûres', () => {
    const c = loadConfig(base)
    expect(c).toMatchObject({
      port: 4100,
      evolutionApiUrl: 'http://localhost:8085',
      evolutionInstance: 'printbot',
      allowedNumbers: [],
      sttLanguage: 'fr',
      voiceReplies: true,
      claudeBin: 'claude',
      claudePermissionMode: 'bypassPermissions',
      claudePrintTools: [],
      claudeTimeoutMs: 480_000,
      openscadBin: 'openscad',
    })
    expect(path.isAbsolute(c.jobsDir)).toBe(true)
  })

  it('EVOLUTION_API_KEY obligatoire', () => {
    expect(() => loadConfig({})).toThrow(/EVOLUTION_API_KEY/)
  })

  it('numéros autorisés : formats humains normalisés', () => {
    const c = loadConfig({ ...base, ALLOWED_NUMBERS: '+212 6 12-34-56-78, 33700000000 ,' })
    expect(c.allowedNumbers).toEqual(['212612345678', '33700000000'])
  })

  it('numéro invalide → erreur au démarrage (plutôt qu’un bot muet sur scène)', () => {
    expect(() => loadConfig({ ...base, ALLOWED_NUMBERS: 'badr' })).toThrow()
    expect(() => loadConfig({ ...base, ALLOWED_NUMBERS: '123' })).toThrow()
  })

  it('booléens', () => {
    expect(loadConfig({ ...base, VOICE_REPLIES: 'false' }).voiceReplies).toBe(false)
    expect(loadConfig({ ...base, VOICE_REPLIES: 'oui' }).voiceReplies).toBe(true)
    expect(loadConfig({ ...base, VOICE_REPLIES: '' }).voiceReplies).toBe(true)
  })

  it('mode de permission inconnu → erreur', () => {
    expect(() => loadConfig({ ...base, CLAUDE_PERMISSION_MODE: 'yolo' })).toThrow()
  })

  it('port invalide → erreur', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow()
  })

  it('outils d’impression en liste', () => {
    expect(loadConfig({ ...base, CLAUDE_PRINT_TOOLS: 'mcp__a, mcp__b' }).claudePrintTools).toEqual(['mcp__a', 'mcp__b'])
  })

  it('langue vide = détection automatique', () => {
    expect(loadConfig({ ...base, STT_LANGUAGE: '' }).sttLanguage).toBe('')
  })

  it('variables vides → valeurs par défaut', () => {
    const c = loadConfig({ ...base, CLAUDE_BIN: '', OPENSCAD_BIN: '', CLAUDE_TIMEOUT_MS: '' })
    expect(c.claudeBin).toBe('claude')
    expect(c.openscadBin).toBe('openscad')
    expect(c.claudeTimeoutMs).toBe(480_000)
  })
})
