/**
 * Gauges (docs/UI.md §5.2): the retail fill art at native size, clipped by the value (`clip-path: inset(0 X 0 0)`,
 * never stretched), with optional text over it. Segmented mode draws the 2009 EXP band: n segments, segment i
 * filled `clamp(f·n − i, 0, 1)`.
 */
import type { Art } from '../art.ts'
import { el } from '../dom.ts'
import { GAUGES, type GaugeName } from './skins.ts'

export interface GaugeOptions {
  w?: number
  h?: number
  text?: 'none' | 'value' | 'percent'
  /** Segmented band: n segments of the fill's width, `pitch` px apart, the first at x0. */
  segments?: { n: number; pitch: number; x0: number }
  /** CSS colour for the no-art stand-in. */
  color?: string
  className?: string
}

/** 0..1, safe for max ≤ 0 and non-finite input. */
export function fraction(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value / max))
}

/** The fill of each of n segments for a fraction f (0..1). */
export function segmentFills(f: number, n: number): number[] {
  const x = Math.min(1, Math.max(0, Number.isFinite(f) ? f : 0)) * n
  return Array.from({ length: n }, (_, i) => Math.min(1, Math.max(0, x - i)))
}

/** The right-hand clip of a fill at fraction f, as a CSS `clip-path`. */
export function clipFor(f: number): string {
  return `inset(0 ${((1 - Math.min(1, Math.max(0, f))) * 100).toFixed(3)}% 0 0)`
}

export function gaugeText(value: number, max: number, mode: 'none' | 'value' | 'percent'): string {
  if (mode === 'none') return ''
  if (mode === 'percent') return `${(fraction(value, max) * 100).toFixed(2)}%`
  return `${Math.max(0, Math.round(value)).toLocaleString('en-US')} / ${Math.max(0, Math.round(max)).toLocaleString('en-US')}`
}

export class Gauge {
  readonly root: HTMLElement
  private readonly fills: HTMLElement[] = []
  private readonly label: HTMLElement | null
  private value = 0
  private max = 1

  constructor(art: Art, fill: GaugeName | string, private readonly opts: GaugeOptions = {}) {
    const key = fill in GAUGES ? GAUGES[fill as GaugeName] : fill
    const size = art.size(key)
    const fw = size?.[0] ?? opts.w ?? 100
    const fh = size?.[1] ?? opts.h ?? 8
    const seg = opts.segments
    const w = opts.w ?? (seg ? seg.x0 + seg.pitch * (seg.n - 1) + fw : fw)
    const h = opts.h ?? fh
    this.root = el('div', `kit-gauge ${opts.className ?? ''}`.trim())
    this.root.style.width = `${w}px`
    this.root.style.height = `${h}px`
    const has = art.has(key)
    if (!has) this.root.classList.add('no-art')
    if (opts.color) this.root.style.setProperty('--gauge-color', opts.color)
    const make = (x: number, width: number) => {
      const f = el('div', 'kit-gauge-fill')
      Object.assign(f.style, { left: `${x}px`, width: `${width}px`, height: `${Math.min(fh, h)}px`, top: `${Math.max(0, Math.floor((h - fh) / 2))}px` })
      if (has) f.style.backgroundImage = art.cssUrl(key)
      this.root.append(f)
      this.fills.push(f)
    }
    if (seg) for (let i = 0; i < seg.n; i++) make(seg.x0 + seg.pitch * i, fw)
    else make(0, has ? fw : w)
    this.label = opts.text && opts.text !== 'none' ? el('div', 'kit-gauge-text kit-t-gauge') : null
    if (this.label) this.root.append(this.label)
    this.set(0, 1)
  }

  get fraction(): number {
    return fraction(this.value, this.max)
  }

  set(value: number, max: number): void {
    this.value = value
    this.max = max
    const f = fraction(value, max)
    if (this.opts.segments) {
      const parts = segmentFills(f, this.opts.segments.n)
      this.fills.forEach((e, i) => (e.style.clipPath = clipFor(parts[i]!)))
    } else {
      this.fills[0]!.style.clipPath = clipFor(f)
    }
    if (this.label) this.label.textContent = gaugeText(value, max, this.opts.text ?? 'none')
    this.root.setAttribute('aria-valuenow', String(Math.round(f * 100)))
  }

  /** Overrides the text over the gauge (e.g. "1,234 / 2,000 (61%)"). */
  setText(text: string): void {
    if (this.label) this.label.textContent = text
  }
}
