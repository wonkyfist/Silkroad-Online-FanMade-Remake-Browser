/**
 * Berserk on your own screen (docs/EFFECTS.md §3.9 "Makeover"; world/features/berserk.ts drives it): a soft red edge
 * that pulses with the heartbeat, the start flash, slightly richer colours (a CSS filter on the game canvas) and the
 * bigger fire-orange numbers of your own hits (hud/effects.ts setOwnHitStyle). Plain DOM over the canvas and under the
 * HUD: nothing is drawn by the 3D renderer, so it costs no draw calls. `dispose()` removes every node and restores the
 * canvas filter.
 */
import { setOwnHitStyle } from './effects.ts'

const STYLE_ID = 'bz-screen-style'
/** The class of an own hit's number while berserk (hud/effects.ts). */
export const BERSERK_HIT_CLASS = 'bz-hit'
/** Own hits' numbers are this much bigger while berserk. */
export const BERSERK_HIT_SCALE = 1.35
/** The canvas filter of the richer colours. */
export const RICH_FILTER = 'saturate(1.14) contrast(1.04)'
/** The start flash lasts this long (ms); `reduceFlashing` keeps a quarter of it. */
export const FLASH_MS = 260

const CSS = `
.bz-edge, .bz-flash { position: absolute; inset: 0; pointer-events: none; opacity: 0; }
.bz-edge { background: radial-gradient(ellipse at center, rgba(0,0,0,0) 52%, rgba(150,18,0,0.38) 78%, rgba(120,6,0,0.78) 100%); }
.bz-flash { background: radial-gradient(ellipse at center, rgba(255,236,190,0.95) 0%, rgba(255,160,60,0.75) 45%, rgba(255,90,20,0.35) 100%); mix-blend-mode: screen; }
.hud-float.${BERSERK_HIT_CLASS} > i { filter: sepia(1) saturate(7) hue-rotate(-12deg) brightness(1.15) drop-shadow(0 0 3px rgba(255,90,0,0.9)); }
.hud-float.${BERSERK_HIT_CLASS} .hud-float-num { color: #ff9a2e; text-shadow: 0 0 4px #ff4a00, 0 1px 0 #5a1400; }
`

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return
  const s = doc.createElement('style')
  s.id = STYLE_ID
  s.textContent = CSS
  doc.head.append(s)
}

/** The flash's opacity `tMs` after the start (peak `peak`). */
export function flashOpacity(tMs: number, peak = 0.7): number {
  if (tMs < 0 || tMs >= FLASH_MS) return 0
  const u = tMs / FLASH_MS
  return peak * (u < 0.12 ? u / 0.12 : (1 - (u - 0.12) / 0.88) ** 1.6)
}

/**
 * Your own hits' numbers while you are berserk (every tier; not one of the screen effects the Options switch turns off):
 * bigger and fire-orange. `on` false gives them the retail look back.
 */
export function berserkHitNumbers(on: boolean): void {
  if (on && typeof document !== 'undefined') ensureStyle(document)
  setOwnHitStyle(on ? { className: BERSERK_HIT_CLASS, scale: BERSERK_HIT_SCALE } : null)
}

export class BerserkScreen {
  private readonly edge: HTMLElement
  private readonly flash: HTMLElement
  private flashAt = -Infinity
  private flashPeak = 0.7
  private filterWas: string | null = null
  private disposed = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    const doc = canvas.ownerDocument
    ensureStyle(doc)
    this.edge = doc.createElement('div')
    this.edge.className = 'bz-edge'
    this.flash = doc.createElement('div')
    this.flash.className = 'bz-flash'
    // Right after the canvas: over the 3D view, under the HUD that follows it.
    canvas.after(this.edge, this.flash)
  }

  /** The start flash (`reduce`: Options → Reduce flashing, a quarter of it). */
  startFlash(nowMs: number, reduce: boolean): void {
    this.flashAt = nowMs
    this.flashPeak = reduce ? 0.18 : 0.7
  }

  /** Per frame: the edge's opacity (0..1) and whether the richer colours are on. */
  update(nowMs: number, edge: number, rich: boolean): void {
    if (this.disposed) return
    this.edge.style.opacity = Math.max(0, Math.min(1, edge)).toFixed(3)
    this.flash.style.opacity = flashOpacity(nowMs - this.flashAt, this.flashPeak).toFixed(3)
    if (rich && this.filterWas === null) {
      this.filterWas = this.canvas.style.filter
      this.canvas.style.filter = RICH_FILTER
    } else if (!rich && this.filterWas !== null) {
      this.restoreFilter()
    }
  }

  private restoreFilter(): void {
    if (this.filterWas === null) return
    if (this.canvas.style.filter === RICH_FILTER) this.canvas.style.filter = this.filterWas
    this.filterWas = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.restoreFilter()
    this.edge.remove()
    this.flash.remove()
  }
}
