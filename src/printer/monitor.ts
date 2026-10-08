/**
 * Suivi d'une impression à distance, sans accès à l'état réel de l'imprimante
 * (A1 mini à Casablanca, cloud Bambu fermé aux tiers) : on se cale sur le temps.
 *
 *   lancement ── préparation (chauffe + calibration) ──▶ 📸 « Ça imprime ! »
 *             ── + durée estimée ───────────────────────▶ 🏁 « Ton objet devrait être prêt » (+ vocal)
 *
 * Chaque étape envoie une photo de la vue caméra si elle est disponible ;
 * la photo montre l'état réel (progression, temps restant) affiché par l'app.
 */

import { logger } from '../logger.js'

const log = logger.child({ module: 'monitor' })

export interface MonitorPlan {
  /** Chauffe + calibration avant le premier calque (min). */
  prepMinutes: number
  /** Durée d'impression estimée par Claude (min). */
  estMinutes?: number
  title?: string
  location?: string
}

export interface MonitorDeps {
  capture: () => Promise<Buffer | null>
  /** La caméra est-elle censée marcher ? (sinon on n'affiche pas d'avertissement) */
  cameraExpected: boolean
  sendPhoto: (jpeg: Buffer, caption: string) => Promise<void>
  sendText: (text: string) => Promise<void>
  speak?: (text: string) => Promise<void>
}

export const DEFAULT_PRINT_MINUTES = 20
/** Marge après la fin estimée (refroidissement, imprécision de l'estimation). */
export const FINISH_MARGIN_MINUTES = 1

const MIN = 60_000

export class PrintMonitor {
  readonly startedAt = Date.now()
  private timers: NodeJS.Timeout[] = []
  private stopped = false

  constructor(
    private plan: MonitorPlan,
    private deps: MonitorDeps,
  ) {}

  get estMinutes(): number {
    return Math.max(1, Math.round(this.plan.estMinutes ?? DEFAULT_PRINT_MINUTES))
  }

  /** Premier calque posé : fin de la préparation + 1 min. */
  get firstLayerAt(): number {
    return this.startedAt + (this.plan.prepMinutes + 1) * MIN
  }

  get finishAt(): number {
    return this.startedAt + (this.plan.prepMinutes + this.estMinutes + FINISH_MARGIN_MINUTES) * MIN
  }

  get active(): boolean {
    return !this.stopped
  }

  private where(): string {
    return this.plan.location ? ` à ${this.plan.location}` : ''
  }

  start(): this {
    this.schedule(this.firstLayerAt - Date.now(), () => this.firstLayer())
    this.schedule(this.finishAt - Date.now(), () => this.finish())
    return this
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  /** Ligne pour /status. */
  statusLine(now = Date.now()): string {
    if (this.stopped) return ''
    const elapsed = Math.floor((now - this.startedAt) / MIN)
    const left = Math.max(0, Math.ceil((this.finishAt - now) / MIN))
    if (now < this.startedAt + this.plan.prepMinutes * MIN) return `🔥 Préparation de l’imprimante (lancée il y a ${elapsed} min)`
    return `🖨️ Impression en cours${this.where()} — fin estimée dans ~${left} min`
  }

  private schedule(delayMs: number, step: () => Promise<void>): void {
    const t = setTimeout(() => {
      if (this.stopped) return
      step().catch((err) => log.error({ error: String(err) }, 'Étape du suivi en échec'))
    }, Math.max(0, delayMs))
    t.unref?.()
    this.timers.push(t)
  }

  private async report(caption: string): Promise<void> {
    const jpeg = await this.deps.capture().catch(() => null)
    if (this.stopped) return
    if (jpeg) return this.deps.sendPhoto(jpeg, caption)
    const note = this.deps.cameraExpected ? '\n(📷 vue caméra indisponible : vérifie l’app Bambu sur le Mac)' : ''
    return this.deps.sendText(caption + note)
  }

  private async firstLayer(): Promise<void> {
    await this.report(`📸 Ça imprime${this.where()} ! Premiers calques en cours, fin estimée dans ~${this.estMinutes} min.`)
  }

  private async finish(): Promise<void> {
    const title = this.plan.title ? `*${this.plan.title}*` : 'Ton objet'
    await this.report(`🏁 ${title} devrait être prêt${this.where()} ! Vérifie sur la photo.`)
    if (!this.stopped) await this.deps.speak?.(`Ton objet devrait être prêt${this.where()} !`)
    this.stop()
  }
}
