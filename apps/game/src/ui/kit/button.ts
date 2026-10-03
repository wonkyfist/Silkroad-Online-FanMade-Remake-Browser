/**
 * Buttons (docs/UI.md §5.3): real `<button>`s with the retail skins and their states, normal / `_focus` (hover) /
 * `_press` / `_disable`, each falling back to the base art when the variant is missing. A label wider than the skin
 * grows the button: its ends keep their native size (border-image slice) and the middle stretches.
 * Disabled buttons get `aria-disabled="true"` and eat clicks (they stay focusable for the tooltip).
 */
import type { Art } from '../art.ts'
import { el } from '../dom.ts'
import { fitWidth, textWidth } from './measure.ts'
import { BUTTONS, variant, type ButtonName, type ButtonSkin } from './skins.ts'

export interface ButtonOptions {
  label: string
  skin?: ButtonName | ButtonSkin
  minWidth?: number
  /** Fixed width (native px); the label is ellipsised if it does not fit. */
  width?: number
  primary?: boolean
  disabled?: boolean
  title?: string
  /** data-sfx: the click cue (`ui.<sfx>`), 'none' for silence. */
  sfx?: string
  className?: string
}

export type KitButton = HTMLButtonElement & {
  setDisabled(v: boolean): void
  setLabel(s: string): void
  readonly isDisabled: boolean
}

/** Sets the art variables of a stateful skin on `e` (--img, --img-focus, --img-press, --img-disable). */
export function applyStates(e: HTMLElement, art: Art, key: string): boolean {
  if (!art.has(key)) {
    e.classList.add('no-art')
    return false
  }
  e.classList.remove('no-art')
  e.style.setProperty('--img', art.cssUrl(key))
  e.style.setProperty('--img-focus', art.cssUrl(variant(art, key, '_focus')))
  e.style.setProperty('--img-press', art.cssUrl(variant(art, key, '_press')))
  if (art.has(`${key}_disable`)) e.style.setProperty('--img-disable', art.cssUrl(`${key}_disable`))
  else e.classList.add('kit-no-disable-art')
  return true
}

export function button(art: Art, opts: ButtonOptions, onClick?: (ev: MouseEvent) => void): KitButton {
  const skin: ButtonSkin = typeof opts.skin === 'object' ? opts.skin : BUTTONS[opts.skin ?? 'std']
  const b = el('button', `kit-btn ${opts.primary ? 'primary' : ''} ${opts.className ?? ''}`.trim()) as KitButton
  b.type = 'button'
  if (typeof opts.skin === 'string') b.classList.add(`kit-btn-${opts.skin}`)
  const label = el('span', 'kit-btn-label')
  b.append(label)
  b.style.height = `${skin.h}px`
  b.style.setProperty('--slice', String(skin.slice))
  applyStates(b, art, skin.key)
  if (opts.sfx) b.dataset.sfx = opts.sfx
  if (opts.title) b.title = opts.title
  let disabled = false
  const size = () => {
    const min = Math.max(skin.w, opts.minWidth ?? 0)
    b.style.width = `${opts.width ?? fitWidth(min, textWidth(label.textContent ?? ''))}px`
  }
  Object.defineProperty(b, 'isDisabled', { get: () => disabled })
  b.setLabel = (s: string) => {
    label.textContent = s
    size()
  }
  b.setDisabled = (v: boolean) => {
    disabled = v
    b.classList.toggle('disabled', v)
    if (v) b.setAttribute('aria-disabled', 'true')
    else b.removeAttribute('aria-disabled')
  }
  b.setLabel(opts.label)
  b.setDisabled(!!opts.disabled)
  b.addEventListener('click', ev => {
    if (disabled) {
      ev.preventDefault()
      ev.stopImmediatePropagation()
      return
    }
    onClick?.(ev)
  })
  return b
}

/**
 * A button drawn by one art key at its native size (close, plus/minus, money, arrows, underbar buttons), with the
 * same state rules. `fallbackText` is shown when the art is missing.
 */
export function iconButton(art: Art, key: string, opts: { title?: string; fallbackText?: string; w?: number; h?: number; sfx?: string; className?: string } = {}, onClick?: (ev: MouseEvent) => void): KitButton {
  const size = art.size(key)
  const w = opts.w ?? size?.[0] ?? 16
  const h = opts.h ?? size?.[1] ?? 16
  return button(art, { label: art.has(key) ? '' : (opts.fallbackText ?? ''), skin: { key, w, h, slice: 0 }, width: w, title: opts.title, sfx: opts.sfx, className: `kit-icon-btn ${opts.className ?? ''}` }, onClick)
}
