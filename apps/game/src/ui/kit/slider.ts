/**
 * A slider (docs/UI.md §2.4, `ifsliderctrl.txt`): `com_left_bigarrow` (24×24) at (2,2), the track, the
 * `com_scroll_button` thumb, `com_right_bigarrow` at the right; retail width 151. `role="slider"` with the arrow
 * keys; `onInput` follows the drag, `onChange` fires on release (a live UI-scale drag would move the window away).
 */
import type { Art } from '../art.ts'
import { el } from '../dom.ts'
import { iconButton } from './button.ts'
import { CONTROLS } from './skins.ts'

export const SLIDER_W = 151
const ARROW = 24
const THUMB = 16

/** The value at a track ratio (0..1), snapped to `step` and clamped. */
export function sliderValue(ratio: number, min: number, max: number, step: number): number {
  const r = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0))
  const raw = min + r * (max - min)
  const snapped = step > 0 ? min + Math.round((raw - min) / step) * step : raw
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(6))
}

/** The track ratio (0..1) of a value. */
export function sliderRatio(value: number, min: number, max: number): number {
  return max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0
}

export interface SliderOptions {
  min: number
  max: number
  step?: number
  value?: number
  w?: number
  label?: string
  className?: string
}

export class Slider {
  readonly root: HTMLElement
  private readonly track: HTMLElement
  private readonly thumb: HTMLElement
  private v: number
  onInput: (value: number) => void = () => {}
  onChange: (value: number) => void = () => {}

  constructor(art: Art, private readonly opts: SliderOptions) {
    const w = opts.w ?? SLIDER_W
    this.v = opts.value ?? opts.min
    const step = opts.step ?? 1
    const prev = iconButton(art, CONTROLS.sliderPrev, { w: ARROW, h: ARROW, fallbackText: '◀', sfx: 'none', className: 'kit-slider-prev' }, () => this.set(this.v - step, true))
    const next = iconButton(art, CONTROLS.sliderNext, { w: ARROW, h: ARROW, fallbackText: '▶', sfx: 'none', className: 'kit-slider-next' }, () => this.set(this.v + step, true))
    this.thumb = el('div', 'kit-slider-thumb')
    if (art.has(CONTROLS.scrollThumb)) {
      this.thumb.style.setProperty('--img', art.cssUrl(CONTROLS.scrollThumb))
      this.thumb.style.setProperty('--img-press', art.cssUrl(art.has(`${CONTROLS.scrollThumb}_press`) ? `${CONTROLS.scrollThumb}_press` : CONTROLS.scrollThumb))
    } else this.thumb.classList.add('no-art')
    this.track = el('div', 'kit-slider-track', this.thumb)
    this.root = el('div', `kit-slider ${opts.className ?? ''}`.trim(), prev, this.track, next)
    this.root.style.width = `${w}px`
    this.root.tabIndex = 0
    this.root.setAttribute('role', 'slider')
    if (opts.label) this.root.setAttribute('aria-label', opts.label)
    this.root.setAttribute('aria-valuemin', String(opts.min))
    this.root.setAttribute('aria-valuemax', String(opts.max))
    this.root.addEventListener('keydown', ev => {
      const d = ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? step : ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -step : 0
      if (!d) return
      ev.preventDefault()
      ev.stopPropagation()
      this.set(this.v + d, true)
    })
    this.track.addEventListener('pointerdown', ev => this.drag(ev))
    this.paint()
  }

  get value(): number {
    return this.v
  }

  /** Sets the value; `notify` fires onInput and onChange. */
  set(value: number, notify = false): void {
    const { min, max, step } = this.opts
    const v = sliderValue(sliderRatio(value, min, max), min, max, step ?? 1)
    const changed = v !== this.v
    this.v = v
    this.paint()
    if (notify && changed) {
      this.onInput(v)
      this.onChange(v)
    }
  }

  private paint(): void {
    const r = sliderRatio(this.v, this.opts.min, this.opts.max)
    this.thumb.style.left = `calc((100% - ${THUMB}px) * ${r.toFixed(4)})`
    this.root.setAttribute('aria-valuenow', String(this.v))
  }

  private drag(ev: PointerEvent): void {
    if (ev.button !== 0) return
    ev.preventDefault()
    this.root.focus()
    const { min, max, step } = this.opts
    const at = (x: number) => {
      const r = this.track.getBoundingClientRect()
      // On-screen px: the thumb's half width scales with the track (any zoom).
      const k = this.track.clientWidth > 0 ? r.width / this.track.clientWidth : 1
      const half = (THUMB / 2) * k
      const v = sliderValue((x - r.left - half) / Math.max(1, r.width - 2 * half), min, max, step ?? 1)
      if (v !== this.v) {
        this.v = v
        this.paint()
        this.onInput(v)
      }
    }
    const start = this.v
    at(ev.clientX)
    this.thumb.classList.add('pressed')
    this.track.setPointerCapture(ev.pointerId)
    const move = (e: PointerEvent) => at(e.clientX)
    const up = () => {
      this.thumb.classList.remove('pressed')
      this.track.removeEventListener('pointermove', move)
      this.track.removeEventListener('pointerup', up)
      this.track.removeEventListener('pointercancel', up)
      if (this.v !== start) this.onChange(this.v)
    }
    this.track.addEventListener('pointermove', move)
    this.track.addEventListener('pointerup', up)
    this.track.addEventListener('pointercancel', up)
  }
}
