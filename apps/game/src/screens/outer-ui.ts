/**
 * Shared pieces of the outer screens (login, server list, character select / create, loading), rebuilt on the UI kit
 * (docs/UI.md §4.7, lane UI-O): the retail outer buttons with live text that grows instead of clipping, the
 * warning dialogs laid out at their resinfo rects, retail-looking input boxes, labels that shrink to fit fixed
 * plates, a tooltip-framed name tag and the server list's retail scroll lane (server_up / server_mov / server_down).
 * Everything is in native px inside the `.anchored` outer windows, which scale with --ui.
 */
import type { Art } from '../ui/art.ts'
import { anchor } from '../ui/chrome.ts'
import { el, place, type Rect } from '../ui/dom.ts'
import { button, iconButton, nineSlice, textWidth, type KitButton } from '../ui/kit/index.ts'

/** outer/button (91x40): Connect, Select, Start, Create... `slice` keeps the rims when a long label grows it. */
export const OUTER_BUTTON = { key: 'outer/button', w: 91, h: 40, slice: 12 } as const
/** outer/warning_button (76x32): the buttons of the warning_create / warning_delete dialogs. */
export const WARNING_BUTTON = { key: 'outer/warning_button', w: 76, h: 32, slice: 10 } as const
/** outer/man_* and outer/woman_* (72x28): the text window beside the gem (man: gem left, woman: gem right). */
export const SEX_PLATE = { w: 72, h: 28, textW: 44 } as const
/** The 12-px basic face (FontIndex 0), the font of every outer label. */
export const OUTER_FONT = "'SRO Basic', Tahoma, Verdana, sans-serif"

export interface OuterButtonOptions {
  skin?: { key: string; w: number; h: number; slice: number }
  primary?: boolean
  title?: string
  sfx?: string
  className?: string
}

/** A retail outer button with a live label; it grows (rims kept) rather than clip a long translation. */
export function outerButton(art: Art, label: string, opts: OuterButtonOptions = {}, onClick?: (ev: MouseEvent) => void): KitButton {
  const skin = opts.skin ?? OUTER_BUTTON
  const b = button(art, { label, skin, primary: opts.primary, title: opts.title, sfx: opts.sfx, className: `outer-btn ${opts.className ?? ''}`.trim() }, onClick)
  b.style.minWidth = `${skin.w}px`
  return b
}

/** Disables or enables several kit buttons at once (busy states). */
export function setDisabled(buttons: readonly KitButton[], disabled: boolean): void {
  for (const b of buttons) b.setDisabled(disabled)
}

/**
 * The largest of `sizes` (px) at which `text` fits `maxW` in the basic face; the smallest when none fits.
 * Used for labels on fixed plates (the man / woman buttons), so "Female" never clips.
 */
export function fitFontSize(text: string, maxW: number, sizes: readonly number[] = [12, 11, 10], family = OUTER_FONT): number {
  for (const s of sizes) if (textWidth(text, `${s}px ${family}`) <= maxW) return s
  return sizes[sizes.length - 1] ?? 12
}

/** Thumb left (px) of step `v` of `n` on a retail slider whose thumb travels `range` px from `x0`. */
export function sliderThumbX(v: number, n: number, x0: number, range: number): number {
  const i = Math.min(Math.max(Math.round(v), 0), Math.max(0, n - 1))
  return x0 + Math.round((range * i) / Math.max(1, n - 1))
}

/** The step of `n` whose thumb (`thumbW` wide) is centred nearest to the pointer x. */
export function sliderStepAt(x: number, n: number, x0: number, range: number, thumbW: number): number {
  if (n <= 1) return 0
  const f = (x - x0 - thumbW / 2) / range
  return Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))))
}

/** Sets a label's text and the font size that fits it in `maxW` px. */
export function fitLabel(label: HTMLElement, text: string, maxW: number): void {
  label.textContent = text
  label.style.fontSize = `${fitFontSize(text, maxW)}px`
  label.title = text
}

/**
 * A black input box with the 1-px gold rim of the login_window art's own boxes (drawn where the art has a narrower
 * box or none). `rect` is the edit rect; the rim sits 4 px left and 1 px above it, as in the art.
 */
export function outerBox(rect: Rect, className = ''): HTMLElement {
  const [x, y, w, h] = rect
  return place(el('div', `outer-box ${className}`.trim()), [x - 4, y - 1, w + 9, h + 2])
}

export interface OuterDialogButton {
  label: string
  primary?: boolean
  onClick: () => void
}

export interface OuterDialogOptions {
  /** outer/warning_delete (344x192) or outer/warning_create (248x128). */
  key: string
  w: number
  h: number
  title?: string
  /** Title rect in the art (resinfo GDR_STA_WNAME etc.). */
  titleRect?: Rect
  body: (Node | string)[]
  bodyRect: Rect
  buttons: OuterDialogButton[]
  /** One [x, y] per button (resinfo rects of the warning dialogs). */
  at: [number, number][]
}

/** A modal on a retail warning texture, laid out at its resinfo rects; remove() the result to close it. */
export function outerDialog(art: Art, opts: OuterDialogOptions): HTMLElement {
  const shade = el('div', 'modal-shade outer-modal')
  const win = art.window(opts.key, 'outer-dialog', opts.w, opts.h)
  if (opts.title) {
    const title = place(el('div', 'outer-dialog-title kit-t-title', opts.title), opts.titleRect ?? [4, 18, opts.w - 8, 15])
    title.title = opts.title
    win.append(title)
  }
  win.append(place(el('div', 'outer-dialog-body', ...opts.body), opts.bodyRect))
  opts.buttons.forEach((spec, i) => {
    const b = outerButton(art, spec.label, { skin: WARNING_BUTTON, primary: spec.primary, className: spec.primary ? 'primary' : '' }, spec.onClick)
    const [x, y] = opts.at[i] ?? [0, 0]
    win.append(place(b, [x, y, 0, 0]))
  })
  shade.append(anchor(win, 0.5, 0.5))
  return shade
}

/** A name tag on the tooltip frame (frame_tooltip_), for the plates over the characters on character select. */
export function framedTag(art: Art, className: string, ...children: (Node | string)[]): HTMLElement {
  const tag = el('div', `outer-tag ${className}`.trim())
  nineSlice(tag, art, 'tooltip', { fill: null })
  tag.append(el('span', 'outer-tag-text', ...children))
  return tag
}

/**
 * The server list's retail scroll lane (pstitle.txt GDR_VSC_UNITY_SERVER: server_up, the server_mov thumb,
 * server_down, 20 px wide) driving a native-overflow list. Pointer maths use the lane's on-screen rect, so it is
 * right at any --ui.
 */
export class OuterScroll {
  readonly root: HTMLElement
  private readonly lane: HTMLElement
  private readonly thumb: HTMLElement
  private readonly offs: (() => void)[] = []
  private raf = 0

  constructor(art: Art, private readonly list: HTMLElement, rect: Rect) {
    const [, , w, h] = rect
    this.root = place(el('div', 'outer-scroll'), rect)
    const step = (d: number) => () => this.list.scrollBy({ top: d * 20 })
    const up = iconButton(art, 'outer/server_up', { w, h: 20, fallbackText: '▲', sfx: 'none', className: 'outer-scroll-up' }, step(-1))
    const down = iconButton(art, 'outer/server_down', { w, h: 20, fallbackText: '▼', sfx: 'none', className: 'outer-scroll-down' }, step(1))
    this.lane = place(el('div', 'outer-scroll-lane'), [0, 20, w, h - 40])
    this.thumb = el('div', 'outer-scroll-thumb')
    if (art.has('outer/server_mov')) {
      this.thumb.style.setProperty('--img', art.cssUrl('outer/server_mov'))
      this.thumb.style.setProperty('--img-focus', art.cssUrl(art.has('outer/server_mov_focus') ? 'outer/server_mov_focus' : 'outer/server_mov'))
      this.thumb.style.setProperty('--img-press', art.cssUrl(art.has('outer/server_mov_press') ? 'outer/server_mov_press' : 'outer/server_mov'))
    } else this.thumb.classList.add('no-art')
    this.lane.append(this.thumb)
    this.root.append(up, this.lane, down)

    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement, type: K, fn: (ev: HTMLElementEventMap[K]) => void) => {
      t.addEventListener(type, fn)
      this.offs.push(() => t.removeEventListener(type, fn))
    }
    on(this.list, 'scroll', () => this.refresh())
    // Click in the lane: page towards the pointer. Drag the thumb: follow the pointer.
    on(this.lane, 'pointerdown', ev => {
      if (ev.target === this.thumb) return
      const r = this.thumb.getBoundingClientRect()
      this.list.scrollBy({ top: (ev.clientY < r.top ? -1 : 1) * this.list.clientHeight * 0.9 })
    })
    on(this.thumb, 'pointerdown', ev => {
      ev.preventDefault()
      ev.stopPropagation()
      this.thumb.setPointerCapture(ev.pointerId)
      this.thumb.classList.add('pressed')
      const laneRect = this.lane.getBoundingClientRect()
      const scale = laneRect.height / Math.max(1, this.lane.offsetHeight)
      const grab = ev.clientY - this.thumb.getBoundingClientRect().top
      const move = (e: PointerEvent) => {
        const free = this.lane.offsetHeight - this.thumb.offsetHeight
        if (free <= 0) return
        const top = (e.clientY - laneRect.top - grab) / scale
        this.list.scrollTop = (Math.min(free, Math.max(0, top)) / free) * (this.list.scrollHeight - this.list.clientHeight)
      }
      const upFn = () => {
        this.thumb.classList.remove('pressed')
        this.thumb.removeEventListener('pointermove', move)
        this.thumb.removeEventListener('pointerup', upFn)
        this.thumb.removeEventListener('pointercancel', upFn)
      }
      this.thumb.addEventListener('pointermove', move)
      this.thumb.addEventListener('pointerup', upFn)
      this.thumb.addEventListener('pointercancel', upFn)
    })
    this.refresh()
  }

  /** Re-places the thumb (after the list content changed). */
  refresh(): void {
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(() => {
      const range = this.list.scrollHeight - this.list.clientHeight
      const free = this.lane.offsetHeight - this.thumb.offsetHeight
      const f = range > 0.5 ? Math.min(1, Math.max(0, this.list.scrollTop / range)) : 0
      this.thumb.style.top = `${Math.round(free * f)}px`
      this.root.classList.toggle('fits', !(range > 0.5))
    })
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    for (const off of this.offs.splice(0)) off()
  }
}
