/**
 * Text fields (docs/UI.md §5.1): an `<input>` in the `frame_msg_` frame on the near-black `com_bg_tile_e` body.
 * `NumberInput` adds the retail spin arrows (`ifspincontrol.txt`: `com_left_arrow` / `com_right_arrow` either side).
 * Keys typed into a field never reach the game (hud/keys.ts skips typing targets); Enter / Escape are left to the
 * owner (dialogs bind them).
 */
import type { Art } from '../art.ts'
import { el, input as makeInput } from '../dom.ts'
import { iconButton } from './button.ts'
import { nineSlice } from './nine.ts'
import { CONTROLS } from './skins.ts'

/** A whole number typed into an amount field, or null when it is not one in [min, max]. */
export function parseAmount(raw: string, min: number, max: number): number | null {
  const s = raw.trim().replace(/[,\s]/g, '')
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null
}

/** Clamps a spin step into [min, max]. */
export function stepAmount(value: number, delta: number, min: number, max: number): number {
  const v = Number.isFinite(value) ? value : min
  return Math.min(max, Math.max(min, Math.round(v + delta)))
}

export interface TextInputOptions {
  w?: number
  value?: string
  placeholder?: string
  maxLength?: number
  label?: string
  className?: string
  type?: 'text' | 'password'
}

export class TextInput {
  readonly root: HTMLElement
  readonly input: HTMLInputElement

  constructor(art: Art, opts: TextInputOptions = {}) {
    this.input = makeInput('kit-input', opts.type ?? 'text', opts.label ? { 'aria-label': opts.label } : {})
    if (opts.maxLength) this.input.maxLength = opts.maxLength
    if (opts.placeholder) this.input.placeholder = opts.placeholder
    this.input.value = opts.value ?? ''
    this.root = el('div', `kit-field ${opts.className ?? ''}`.trim(), this.input)
    if (opts.w) this.root.style.width = `${opts.w}px`
    nineSlice(this.root, art, 'field')
  }

  get value(): string {
    return this.input.value
  }

  set value(v: string) {
    this.input.value = v
  }

  focus(select = false): void {
    this.input.focus()
    if (select) this.input.select()
  }
}

export interface NumberInputOptions {
  min?: number
  max: number
  value?: number
  step?: number
  w?: number
  label?: string
  className?: string
}

export class NumberInput {
  readonly root: HTMLElement
  readonly input: HTMLInputElement
  readonly min: number
  max: number
  onChange: (value: number) => void = () => {}

  constructor(art: Art, private readonly opts: NumberInputOptions) {
    this.min = opts.min ?? 0
    this.max = opts.max
    this.input = makeInput('kit-input kit-num', 'text', { inputmode: 'numeric', ...(opts.label ? { 'aria-label': opts.label } : {}) })
    this.input.maxLength = String(Math.max(Math.abs(this.max), Math.abs(this.min))).length + 2
    const field = el('div', 'kit-field', this.input)
    nineSlice(field, art, 'field')
    const step = opts.step ?? 1
    const prev = iconButton(art, CONTROLS.spinPrev, { w: 16, h: 16, fallbackText: '◀', title: '-' }, () => this.set(stepAmount(this.value, -step, this.min, this.max), true))
    const next = iconButton(art, CONTROLS.spinNext, { w: 16, h: 16, fallbackText: '▶', title: '+' }, () => this.set(stepAmount(this.value, step, this.min, this.max), true))
    this.root = el('div', `kit-number ${opts.className ?? ''}`.trim(), prev, field, next)
    if (opts.w) this.root.style.width = `${opts.w}px`
    this.input.addEventListener('input', () => {
      const n = parseAmount(this.input.value, this.min, this.max)
      this.root.classList.toggle('invalid', n === null && this.input.value.trim() !== '')
      if (n !== null) this.onChange(n)
    })
    this.input.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        ev.preventDefault()
        this.set(stepAmount(this.value, ev.key === 'ArrowUp' ? step : -step, this.min, this.max), true)
      }
    })
    this.set(opts.value ?? this.min)
  }

  /** The typed amount, or NaN when it is not a valid one. */
  get value(): number {
    return parseAmount(this.input.value, this.min, this.max) ?? Number.NaN
  }

  set(v: number, notify = false): void {
    const n = stepAmount(v, 0, this.min, this.max)
    this.input.value = String(n)
    this.root.classList.remove('invalid')
    if (notify) this.onChange(n)
  }

  focus(select = true): void {
    this.input.focus()
    if (select) this.input.select()
  }
}
