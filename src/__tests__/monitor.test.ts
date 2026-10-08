import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PRINT_MINUTES, PrintMonitor, type MonitorDeps } from '../printer/monitor.js'

const MIN = 60_000
const JPEG = Buffer.from('jpeg')

function deps(over: Partial<MonitorDeps> = {}) {
  const sent: { kind: 'photo' | 'text' | 'voice'; body: string }[] = []
  const d: MonitorDeps = {
    capture: vi.fn(async () => JPEG),
    cameraExpected: true,
    sendPhoto: vi.fn(async (_j: Buffer, caption: string) => void sent.push({ kind: 'photo', body: caption })),
    sendText: vi.fn(async (t: string) => void sent.push({ kind: 'text', body: t })),
    speak: vi.fn(async (t: string) => void sent.push({ kind: 'voice', body: t })),
    ...over,
  }
  return { d, sent }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-09T10:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('PrintMonitor', () => {
  it('photo « ça imprime » après la préparation, puis photo finale + vocal à la fin estimée', async () => {
    const { d, sent } = deps()
    const m = new PrintMonitor({ prepMinutes: 5, estMinutes: 12, title: 'Porte-clé AUSIM', location: 'Casablanca' }, d).start()

    await vi.advanceTimersByTimeAsync(6 * MIN - 1)
    expect(sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toEqual([{ kind: 'photo', body: '📸 Ça imprime à Casablanca ! Premiers calques en cours, fin estimée dans ~12 min.' }])

    // fin = 5 (prépa) + 12 (impression) + 1 (marge) = 18 min
    await vi.advanceTimersByTimeAsync(12 * MIN - 1)
    expect(sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sent[1]).toEqual({ kind: 'photo', body: '🏁 *Porte-clé AUSIM* devrait être prêt à Casablanca ! Vérifie sur la photo.' })
    expect(sent[2]).toEqual({ kind: 'voice', body: 'Ton objet devrait être prêt à Casablanca !' })
    expect(m.active).toBe(false)
  })

  it('durée inconnue → 20 min par défaut, sans lieu ni titre', async () => {
    const { d, sent } = deps()
    const m = new PrintMonitor({ prepMinutes: 5 }, d).start()
    expect(m.estMinutes).toBe(DEFAULT_PRINT_MINUTES)
    expect(m.finishAt - m.startedAt).toBe((5 + 20 + 1) * MIN)
    await vi.advanceTimersByTimeAsync(26 * MIN)
    expect(sent[0].body).toBe('📸 Ça imprime ! Premiers calques en cours, fin estimée dans ~20 min.')
    expect(sent[1].body).toBe('🏁 Ton objet devrait être prêt ! Vérifie sur la photo.')
  })

  it('durée arrondie et jamais nulle', () => {
    const { d } = deps()
    expect(new PrintMonitor({ prepMinutes: 0, estMinutes: 11.6 }, d).estMinutes).toBe(12)
    expect(new PrintMonitor({ prepMinutes: 0, estMinutes: 0.2 }, d).estMinutes).toBe(1)
  })

  it('caméra indisponible → texte avec avertissement', async () => {
    const { d, sent } = deps({ capture: vi.fn(async () => null) })
    new PrintMonitor({ prepMinutes: 0, estMinutes: 5 }, d).start()
    await vi.advanceTimersByTimeAsync(1 * MIN)
    expect(sent[0].kind).toBe('text')
    expect(sent[0].body).toContain('vue caméra indisponible')
  })

  it('caméra non prévue (pas un Mac) → texte sans avertissement', async () => {
    const { d, sent } = deps({ capture: vi.fn(async () => null), cameraExpected: false })
    new PrintMonitor({ prepMinutes: 0, estMinutes: 5 }, d).start()
    await vi.advanceTimersByTimeAsync(1 * MIN)
    expect(sent[0]).toEqual({ kind: 'text', body: '📸 Ça imprime ! Premiers calques en cours, fin estimée dans ~5 min.' })
  })

  it('capture qui plante → texte, le suivi continue', async () => {
    const { d, sent } = deps({ capture: vi.fn(async () => Promise.reject(new Error('boom'))) })
    new PrintMonitor({ prepMinutes: 0, estMinutes: 2 }, d).start()
    await vi.advanceTimersByTimeAsync(3 * MIN)
    expect(sent.map((s) => s.kind)).toEqual(['text', 'text', 'voice'])
  })

  it('envoi WhatsApp qui plante → pas d’exception non gérée', async () => {
    const { d } = deps({ sendPhoto: vi.fn(async () => Promise.reject(new Error('down'))) })
    new PrintMonitor({ prepMinutes: 0, estMinutes: 2 }, d).start()
    await expect(vi.advanceTimersByTimeAsync(3 * MIN)).resolves.not.toThrow()
  })

  it('stop() annule toutes les étapes à venir', async () => {
    const { d, sent } = deps()
    const m = new PrintMonitor({ prepMinutes: 5, estMinutes: 10 }, d).start()
    m.stop()
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(sent).toHaveLength(0)
    expect(m.active).toBe(false)
  })

  it('stop() pendant une capture → rien n’est envoyé', async () => {
    let release!: (b: Buffer) => void
    const { d, sent } = deps({ capture: vi.fn(() => new Promise<Buffer>((r) => (release = r))) })
    const m = new PrintMonitor({ prepMinutes: 0, estMinutes: 10 }, d).start()
    await vi.advanceTimersByTimeAsync(1 * MIN)
    m.stop()
    release(JPEG)
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(0)
  })

  it('statusLine selon la phase', async () => {
    const { d } = deps()
    const m = new PrintMonitor({ prepMinutes: 5, estMinutes: 12, location: 'Casablanca' }, d).start()
    expect(m.statusLine()).toBe('🔥 Préparation de l’imprimante (lancée il y a 0 min)')
    await vi.advanceTimersByTimeAsync(8 * MIN)
    expect(m.statusLine()).toBe('🖨️ Impression en cours à Casablanca — fin estimée dans ~10 min')
    await vi.advanceTimersByTimeAsync(20 * MIN)
    expect(m.statusLine()).toBe('')
  })

  it('les minuteries ne bloquent pas l’arrêt du processus (unref)', () => {
    const { d } = deps()
    vi.useRealTimers()
    const m = new PrintMonitor({ prepMinutes: 5, estMinutes: 10 }, d).start()
    // @ts-expect-error accès interne pour vérification
    expect(m.timers.every((t: NodeJS.Timeout) => !t.hasRef())).toBe(true)
    m.stop()
  })
})
