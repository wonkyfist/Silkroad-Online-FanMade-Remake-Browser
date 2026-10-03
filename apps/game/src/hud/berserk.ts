/**
 * The Berserk gauge (docs/SYSTEMS_COMBAT.md §5.3, docs/UI.md §4.2 player frame; lane BZ), drawn into
 * `PlayerFrame.berserkHost` (M1, decision D17) with the retail ifplayerminiinfo.txt rects (frame-relative):
 *  - five orbs `pmi_jahwan` 8×8 at GDR_PMI_CIRCLE0..4 (hud-layout BERSERK_ORBS), lit up to `stats.hwan`; a new point
 *    flashes its orb;
 *  - a full gauge: the frame glow `pmi_jahwan_glow` (-4,-3,220,80) and the face glow `pmi_jahwan_face` (15,7,48,48)
 *    pulse, and the Berserk button `pmi_jahwan_button` (16,-5,20,20) appears (a click = Tab);
 *  - while berserk: the `pmi_jahwan_burn` flames (a 16×28 sheet of 15 frames) burn on the orbs, the face glows and a
 *    countdown ring runs around the portrait.
 * The host sits at BERSERK_HOST (-4,-6) of the frame, so every frame-relative rect is shifted by (4,6) here.
 */
import { HWAN_MAX } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, place, type Rect } from '../ui/dom.ts'
import { iconButton, type KitButton } from '../ui/kit/button.ts'
import { BERSERK_HOST, BERSERK_ORBS } from './hud-layout.ts'

export const ART = {
  orb: 'playerminiinfo/pmi_jahwan',
  glow: 'playerminiinfo/pmi_jahwan_glow',
  face: 'playerminiinfo/pmi_jahwan_face',
  burn: 'playerminiinfo/pmi_jahwan_burn',
  button: 'playerminiinfo/pmi_jahwan_button',
} as const

/** Frame-relative rects of ifplayerminiinfo.txt (docs/UI.md §4.2). */
export const FRAME_GLOW: Rect = [-4, -3, 220, 80]
export const FACE_GLOW: Rect = [15, 7, 48, 48]
export const BUTTON: Rect = [16, -5, 20, 20]
/** One flame of the burn sheet (128×64: 8 columns × 2 rows of 16×28, 15 frames used). */
export const BURN_FRAME = { w: 16, h: 28, cols: 8, frames: 15 } as const
/** How long a newly lit orb flashes (ms). */
export const ORB_FLASH_MS = 700

/** A frame-relative rect in the host's space (the host sits at BERSERK_HOST of the frame). */
export function hostRect([x, y, w, h]: Rect): Rect {
  return [x - BERSERK_HOST.x, y - BERSERK_HOST.y, w, h]
}

/** The five orb rects in the host's space. */
export function orbRects(): Rect[] {
  return BERSERK_ORBS.map(o => hostRect([o.x, o.y, o.w, o.h]))
}

/** A flame over orb `r`: centred on it, its foot at the orb's bottom edge. */
export function burnRect(r: Rect): Rect {
  return [r[0] + r[2] / 2 - BURN_FRAME.w / 2, r[1] + r[3] - BURN_FRAME.h + 2, BURN_FRAME.w, BURN_FRAME.h]
}

/** Berserk timing of the own character: ends at `until` (server ms), `total` ms long. */
export interface BerserkTimer {
  until: number
  total: number
}

/** What the gauge shows for `points` (0..HWAN_MAX) and an optional running Berserk. */
export interface GaugeView {
  lit: number
  full: boolean
  active: boolean
  /** Countdown left, 0..1 (1 = just started). */
  left: number
}

export function gaugeView(points: number, timer: BerserkTimer | null, now: number): GaugeView {
  const lit = Math.max(0, Math.min(HWAN_MAX, Math.floor(Number.isFinite(points) ? points : 0)))
  const active = !!timer && timer.until > now
  const left = active && timer!.total > 0 ? Math.max(0, Math.min(1, (timer!.until - now) / timer!.total)) : 0
  return { lit: active ? 0 : lit, full: !active && lit >= HWAN_MAX, active, left }
}

/** Seconds left of a running Berserk (rounded up), for the tooltip. */
export function secondsLeft(timer: BerserkTimer | null, now: number): number {
  return timer ? Math.max(0, Math.ceil((timer.until - now) / 1000)) : 0
}

const burnKeyframes = (): string => {
  const { w, h, cols, frames } = BURN_FRAME
  const stops: string[] = []
  for (let i = 0; i < frames; i++) stops.push(`${((i * 100) / frames).toFixed(3)}% { background-position: ${-(i % cols) * w}px ${-Math.floor(i / cols) * h}px; }`)
  return `@keyframes bz-burn { ${stops.join(' ')} }`
}

const CSS = `
.bz-orb { background: no-repeat 0 0; opacity: 0.001; transition: opacity 0.2s; pointer-events: auto; }
.bz-orb.no-art { border-radius: 50%; background: radial-gradient(circle at 35% 35%, #ffd0f0, #f0409a 55%, #8a0c4c); }
.bz-orb.lit { opacity: 1; }
.bz-orb.flash { animation: bz-flash ${ORB_FLASH_MS}ms ease-out; }
@keyframes bz-flash { 0% { transform: scale(2.2); filter: brightness(2.6); } 60% { transform: scale(1.2); filter: brightness(1.5); } 100% { transform: scale(1); filter: none; } }
.bz-glow, .bz-face { background: no-repeat 0 0; mix-blend-mode: screen; opacity: 0; transition: opacity 0.3s; }
.bz-glow { background-position: -1px -1px; }
.bz-face.no-art { border-radius: 50%; box-shadow: 0 0 10px 4px rgba(255, 80, 170, 0.8) inset; }
.bz-host.full .bz-glow, .bz-host.full .bz-face { animation: bz-pulse 1.1s ease-in-out infinite alternate; }
.bz-host.active .bz-face { opacity: 1; animation: bz-flicker 0.35s steps(2) infinite; }
@keyframes bz-pulse { from { opacity: 0.25; } to { opacity: 1; } }
@keyframes bz-flicker { from { filter: brightness(1); } to { filter: brightness(1.35); } }
.bz-burn { background: no-repeat 0 0; display: none; mix-blend-mode: screen; }
.bz-host.active .bz-burn { display: block; animation: bz-burn 0.9s steps(1) infinite; }
.bz-burn.no-art { background: radial-gradient(ellipse at 50% 80%, rgba(255, 120, 190, 0.9), rgba(255, 40, 120, 0) 70%); }
${burnKeyframes()}
.bz-button { pointer-events: auto; z-index: 3; }
.bz-button[hidden] { display: none; }
.bz-host.full .bz-button { animation: bz-pulse 0.8s ease-in-out infinite alternate; }
.bz-ring { position: absolute; overflow: visible; pointer-events: none; display: none; }
.bz-host.active .bz-ring { display: block; }
.bz-ring circle { fill: none; stroke-width: 3; }
.bz-ring .bz-ring-back { stroke: rgba(40, 0, 20, 0.55); }
.bz-ring .bz-ring-left { stroke: #ff4fa8; filter: drop-shadow(0 0 2px #ff7cc4); transform: rotate(-90deg); transform-origin: 50% 50%; }
`
let injected = false
function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const s = document.createElement('style')
  s.dataset.owner = 'bz-berserk'
  s.textContent = CSS
  document.head.append(s)
}

const SVG = 'http://www.w3.org/2000/svg'
/** The countdown ring: around the portrait, 2 px outside it. */
const RING_R = 27

/** The five orbs, glows, flames, button and countdown ring inside `PlayerFrame.berserkHost`. */
export class BerserkGauge {
  readonly root: HTMLElement
  readonly button: KitButton
  private readonly orbs: HTMLElement[] = []
  private readonly flames: HTMLElement[] = []
  private readonly ringLeft: SVGCircleElement
  private readonly circumference = 2 * Math.PI * RING_R
  private shown: GaugeView = { lit: 0, full: false, active: false, left: 0 }
  private points = 0
  private tip = ''
  private timer: BerserkTimer | null = null
  private readonly flashTimers = new Map<number, ReturnType<typeof setTimeout>>()

  constructor(art: Art, host: HTMLElement, onActivate: () => void) {
    ensureStyles()
    this.root = el('div', 'bz-host')
    place(this.root, [0, 0, BERSERK_HOST.w, BERSERK_HOST.h])
    const bg = (e: HTMLElement, key: string) => {
      if (art.has(key)) e.style.backgroundImage = art.cssUrl(key)
      else e.classList.add('no-art')
      return e
    }
    const glow = bg(place(el('div', 'bz-glow'), hostRect(FRAME_GLOW)), ART.glow)
    const face = bg(place(el('div', 'bz-face'), hostRect(FACE_GLOW)), ART.face)
    const [fx, fy, fw, fh] = hostRect(FACE_GLOW)
    const size = 2 * RING_R + 6
    const ring = document.createElementNS(SVG, 'svg')
    ring.setAttribute('class', 'bz-ring')
    ring.setAttribute('width', String(size))
    ring.setAttribute('height', String(size))
    ring.setAttribute('viewBox', `0 0 ${size} ${size}`)
    Object.assign(ring.style, { left: `${fx + fw / 2 - size / 2}px`, top: `${fy + fh / 2 - size / 2}px` })
    const circle = (cls: string) => {
      const c = document.createElementNS(SVG, 'circle')
      c.setAttribute('class', cls)
      c.setAttribute('cx', String(size / 2))
      c.setAttribute('cy', String(size / 2))
      c.setAttribute('r', String(RING_R))
      ring.append(c)
      return c
    }
    circle('bz-ring-back')
    this.ringLeft = circle('bz-ring-left')
    this.ringLeft.setAttribute('stroke-dasharray', this.circumference.toFixed(2))
    this.root.append(glow, face, ring)
    for (const r of orbRects()) {
      const flame = bg(place(el('div', 'bz-burn'), burnRect(r)), ART.burn)
      const orb = bg(place(el('div', 'bz-orb'), r), ART.orb)
      this.flames.push(flame)
      this.orbs.push(orb)
      this.root.append(flame, orb)
    }
    // Flames of neighbouring orbs start on different frames, so they do not flicker in step.
    this.flames.forEach((f, i) => (f.style.animationDelay = `${-i * 0.23}s`))
    this.button = iconButton(art, ART.button, { title: t('bz.button'), fallbackText: '!', className: 'bz-button', sfx: 'ui.click' }, () => onActivate())
    place(this.button, hostRect(BUTTON))
    this.button.hidden = true
    this.root.append(this.button)
    host.append(this.root)
    this.render(0)
  }

  /** New points (0..HWAN_MAX) and/or the own Berserk timer; `now` = server ms. */
  set(points: number, timer: BerserkTimer | null, now: number): void {
    const before = this.shown.active ? 0 : this.points
    this.points = points
    this.timer = timer
    const v = this.render(now)
    // Each newly lit orb flashes (a point gained; not the refill after a relog, which starts from 0 too).
    if (!v.active) for (let i = before; i < v.lit; i++) this.flash(i)
  }

  /** Per frame (or a few times a second): the countdown ring and the end of the timer. */
  tick(now: number): void {
    if (this.timer) this.render(now)
  }

  get view(): GaugeView {
    return this.shown
  }

  private render(now: number): GaugeView {
    const v = gaugeView(this.points, this.timer, now)
    const was = this.shown
    this.shown = v
    if (v.lit !== was.lit || v.active !== was.active) this.orbs.forEach((o, i) => o.classList.toggle('lit', v.active || i < v.lit))
    if (v.full !== was.full) this.root.classList.toggle('full', v.full)
    if (v.active !== was.active) this.root.classList.toggle('active', v.active)
    this.button.hidden = !v.full
    this.ringLeft.setAttribute('stroke-dashoffset', (this.circumference * (1 - v.left)).toFixed(2))
    const tip = v.active ? t('bz.activeTip', { seconds: secondsLeft(this.timer, now) }) : t('bz.gaugeTip', { points: v.lit, max: HWAN_MAX })
    if (tip !== this.tip) {
      this.tip = tip
      for (const o of this.orbs) o.title = tip
    }
    return v
  }

  private flash(i: number): void {
    const orb = this.orbs[i]
    if (!orb) return
    clearTimeout(this.flashTimers.get(i))
    orb.classList.remove('flash')
    void orb.offsetWidth // restart the animation
    orb.classList.add('flash')
    this.flashTimers.set(i, setTimeout(() => orb.classList.remove('flash'), ORB_FLASH_MS))
  }

  dispose(): void {
    for (const h of this.flashTimers.values()) clearTimeout(h)
    this.flashTimers.clear()
    this.root.remove()
  }
}
