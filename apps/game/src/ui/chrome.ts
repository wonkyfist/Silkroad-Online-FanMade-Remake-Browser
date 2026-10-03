/** Shared pieces of the outer screens: letterbox bars, title captions, modal dialogs. */
import type { Art } from './art.ts'
import { el } from './dom.ts'

/** Top and bottom ornamental bars (1600x172 textures, stretched to the viewport width). */
export function bars(art: Art, top: string, bottom: string): HTMLElement[] {
  const mk = (key: string, cls: string) => {
    const d = el('div', `bar ${cls}`)
    if (art.has(key)) d.style.backgroundImage = art.cssUrl(key)
    else d.classList.add('no-art')
    return d
  }
  return [mk(top, 'bar-top'), mk(bottom, 'bar-bottom')]
}

/**
 * The screen caption on the top bar, where the original shows its text-characterselect / text-custom art
 * (gold small capitals). Live text in the English font; the art itself carries Vietnamese text.
 */
export function caption(text: string): HTMLElement {
  return el('div', 'caption', el('span', 'caption-text', text))
}

/** Anchors a native-size element at a viewport fraction; it scales with --ui. */
export function anchor<T extends HTMLElement>(e: T, x: number, y: number, origin: 'center' | 'top' | 'bottom' = 'center'): T {
  e.classList.add('anchored', `origin-${origin}`)
  e.style.left = `${x * 100}%`
  e.style.top = `${y * 100}%`
  return e
}

export interface DialogButton {
  label: string
  primary?: boolean
  onClick: () => void
}

/**
 * Modal window drawn on an original warning texture. Returns the root; remove() closes it.
 * Buttons use the 76x32 warning_button art.
 */
export function dialog(art: Art, opts: { key?: string; w: number; h: number; title?: string; body: (HTMLElement | string)[]; buttons: DialogButton[]; buttonsY?: number }): HTMLElement {
  const key = opts.key ?? 'outer/warning_delete'
  const shade = el('div', 'modal-shade')
  const win = art.window(key, 'dialog', opts.w, opts.h)
  if (opts.title) win.append(el('div', 'dialog-title', opts.title))
  const body = el('div', 'dialog-body', ...opts.body)
  win.append(body)
  const row = el('div', 'dialog-buttons')
  if (opts.buttonsY !== undefined) row.style.top = `${opts.buttonsY}px`
  for (const b of opts.buttons) {
    const btn = art.button(b.label, { key: 'outer/warning_button', className: b.primary ? 'primary' : '' })
    btn.addEventListener('click', b.onClick)
    row.append(btn)
  }
  win.append(row)
  shade.append(anchor(win, 0.5, 0.5))
  return shade
}
