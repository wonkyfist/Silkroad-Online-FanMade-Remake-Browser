/**
 * Check boxes and radio buttons (docs/UI.md §2.4, `ifcheckbox.txt`): real inputs (keyboard, focus ring) drawn with
 * `com_checkbutton_{off,on}` / `com_radiobutton_{off,on,press}`, label to the right.
 */
import type { Art } from '../art.ts'
import { el, input as makeInput } from '../dom.ts'
import { CONTROLS } from './skins.ts'

interface ToggleOptions {
  label?: string
  checked?: boolean
  disabled?: boolean
  className?: string
  title?: string
}

abstract class Toggle {
  readonly root: HTMLLabelElement
  readonly input: HTMLInputElement
  onChange: (checked: boolean) => void = () => {}

  protected constructor(art: Art, type: 'checkbox' | 'radio', keys: { off: string; on: string; press?: string }, opts: ToggleOptions) {
    this.input = makeInput('kit-toggle-input', type, opts.label ? {} : { 'aria-label': opts.title ?? '' })
    const box = el('span', 'kit-toggle-box')
    this.root = el('label', `kit-toggle kit-${type} ${opts.className ?? ''}`.trim(), this.input, box)
    if (opts.label) this.root.append(el('span', 'kit-toggle-label kit-t-value', opts.label))
    if (opts.title) this.root.title = opts.title
    if (art.has(keys.off) && art.has(keys.on)) {
      this.root.style.setProperty('--off', art.cssUrl(keys.off))
      this.root.style.setProperty('--on', art.cssUrl(keys.on))
      this.root.style.setProperty('--press', art.cssUrl(keys.press && art.has(keys.press) ? keys.press : keys.on))
      const dis = `${keys.on}_disable`
      if (art.has(dis)) this.root.style.setProperty('--on-disable', art.cssUrl(dis))
    } else this.root.classList.add('no-art')
    this.input.checked = !!opts.checked
    this.setDisabled(!!opts.disabled)
    this.input.addEventListener('change', () => this.onChange(this.input.checked))
    // A click must not start a world click (the label sits over the canvas in the HUD).
    this.root.addEventListener('pointerdown', ev => ev.stopPropagation())
  }

  get checked(): boolean {
    return this.input.checked
  }

  set checked(v: boolean) {
    this.input.checked = v
  }

  setDisabled(v: boolean): void {
    this.input.disabled = v
    this.root.classList.toggle('disabled', v)
  }
}

export class Checkbox extends Toggle {
  constructor(art: Art, opts: ToggleOptions = {}) {
    super(art, 'checkbox', { off: CONTROLS.checkOff, on: CONTROLS.checkOn }, opts)
  }
}

export class Radio extends Toggle {
  constructor(art: Art, name: string, opts: ToggleOptions & { value?: string } = {}) {
    super(art, 'radio', { off: CONTROLS.radioOff, on: CONTROLS.radioOn, press: CONTROLS.radioPress }, opts)
    this.input.name = name
    if (opts.value !== undefined) this.input.value = opts.value
  }
}

let groups = 0

/** A set of radios with one value. */
export class RadioGroup<V extends string | number> {
  readonly root: HTMLElement
  private readonly radios: { value: V; radio: Radio }[] = []
  onChange: (value: V) => void = () => {}

  constructor(art: Art, choices: readonly { value: V; label: string }[], opts: { value?: V; vertical?: boolean; className?: string } = {}) {
    const name = `kit-radio-${++groups}`
    this.root = el('div', `kit-radio-group ${opts.vertical ? 'vertical' : ''} ${opts.className ?? ''}`.trim())
    this.root.setAttribute('role', 'radiogroup')
    for (const c of choices) {
      const radio = new Radio(art, name, { label: c.label, value: String(c.value), checked: c.value === opts.value })
      radio.onChange = on => on && this.onChange(c.value)
      this.radios.push({ value: c.value, radio })
      this.root.append(radio.root)
    }
  }

  get value(): V | undefined {
    return this.radios.find(r => r.radio.checked)?.value
  }

  set value(v: V | undefined) {
    for (const r of this.radios) r.radio.checked = r.value === v
  }
}
