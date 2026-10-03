/**
 * The in-game window (docs/UI.md §4.6, §5.3): the `mframe_wnd_` frame with its 36-px title strip (live title,
 * the whole strip is the drag handle), `com_windowclose` at (w − 28, 10), and a body inset (44, 16, 16, 16).
 * Sizes and positions are native px inside the zoomed layer (`.hud-root`, zoom: var(--ui)); pointer deltas are
 * divided by the layer's zoom. A window with no remembered position (`sro.hud.<id>`) opens cascaded from the last
 * opened window (+24, +24), or at `at` (viewport fractions of the free space) when none is open. The most recently
 * touched window is on top (`z` is used to close the top window on Esc).
 */
import { gameAudio } from '../../audio/index.ts'
import { t } from '../../i18n/index.ts'
import type { Art } from '../art.ts'
import { el, Listeners } from '../dom.ts'
import { iconButton, type KitButton } from './button.ts'
import { setInset } from './frame.ts'
import { setText } from './label.ts'
import { frameSkin, nineSlice } from './nine.ts'
import { clampWindow, layerScale, layerViewport, openPosition } from './scale.ts'
import { CONTROLS, type FrameName } from './skins.ts'

export interface WindowOptions {
  /** Remembered position key `sro.hud.<id>`; also the class `kit-window-<id>`. */
  id: string
  /** Live text (i18n). */
  title: string
  /** Outer size, native px. */
  width: number
  height: number
  /** Frame skin (default 'main'). */
  frame?: FrameName
  /** Body tile override (null = none). */
  fill?: string | null
  /** Default position as fractions of the free space (0 = left/top, 1 = right/bottom); default: cascade / centre. */
  at?: [number, number]
  /** Show the close button (default true). */
  closable?: boolean
  /** A bottom-right grip resizes the window (GM window). */
  resizable?: { minW: number; minH: number }
  /** Body inset override [top, right, bottom, left]. */
  inset?: readonly [number, number, number, number]
  className?: string
}

export const CLOSE_AT: readonly [number, number] = [28, 10]
const Z_BASE = 100
let zTop = Z_BASE
const openWindows = new Set<Window>()
let lastOpened: Window | null = null

/** The open window on top (Esc closes it), if any. */
export function topWindow(): Window | null {
  let top: Window | null = null
  for (const w of openWindows) if (!top || w.z > top.z) top = w
  return top
}

/** Every open kit window (for tests of the cascade and the Esc rule). */
export function openKitWindows(): readonly Window[] {
  return [...openWindows]
}

export class Window {
  readonly root: HTMLElement
  readonly body: HTMLElement
  readonly titleStrip: HTMLElement
  readonly closeButton: KitButton | null
  protected readonly ls = new Listeners()
  private x = 0
  private y = 0
  private w: number
  private h: number
  /** A remembered or dragged position (else the window cascades on open). */
  private placed = false
  private openState = false
  onClose: (() => void) | null = null

  constructor(protected readonly art: Art, parent: HTMLElement, protected readonly opts: WindowOptions) {
    const skinName = opts.frame ?? 'main'
    const skin = frameSkin(skinName)
    this.w = opts.width
    this.h = opts.height
    this.root = el('div', `kit-window kit-window-${opts.id} ${opts.className ?? ''}`.trim())
    this.root.dataset.window = opts.id
    this.root.style.width = `${this.w}px`
    this.root.style.height = `${this.h}px`
    this.root.hidden = true
    this.root.setAttribute('role', 'dialog')
    const strip = skin.title ?? 26
    this.titleStrip = el('div', 'kit-window-title kit-t-title', opts.title)
    this.titleStrip.style.height = `${strip}px`
    this.titleStrip.style.lineHeight = `${strip}px`
    this.root.setAttribute('aria-label', opts.title)
    this.body = el('div', 'kit-window-body')
    setInset(this.body, opts.inset ?? skin.inset)
    this.root.append(this.titleStrip, this.body)
    nineSlice(this.root, art, skinName, { fill: opts.fill })
    this.closeButton = null
    if (opts.closable !== false) {
      const close = iconButton(art, CONTROLS.close, { w: 16, h: 16, title: t('hud.close'), fallbackText: '×', sfx: 'none', className: 'kit-window-close' }, () => this.close())
      close.setAttribute('aria-label', t('hud.close'))
      close.style.left = `${this.w - CLOSE_AT[0]}px`
      close.style.top = `${Math.max(2, Math.round((strip - 16) / 2))}px`
      this.root.append(close)
      this.closeButton = close
    }
    if (opts.resizable) this.setupResize(opts.resizable)
    this.ls.on(this.root, 'pointerdown', () => this.raise())
    // Clicks inside a window never reach the world (no click-to-move through windows).
    this.ls.on(this.root, 'contextmenu', ev => ev.preventDefault())
    this.setupDrag(this.titleStrip)
    this.ls.on(window, 'resize', () => this.openState && this.applyPosition())
    this.load()
    parent.append(this.root)
  }

  get isOpen(): boolean {
    return this.openState
  }

  get id(): string {
    return this.opts.id
  }

  /** Native px position in the layer. */
  get position(): [number, number] {
    return [this.x, this.y]
  }

  get size(): [number, number] {
    return [this.w, this.h]
  }

  open(): void {
    if (this.openState) return
    const prev = lastOpened && lastOpened !== this && lastOpened.isOpen ? lastOpened : null
    this.openState = true
    this.root.hidden = false
    if (!this.placed) {
      const [x, y] = openPosition([this.w, this.h], this.viewport(), { prev: prev ? prev.position : null, at: this.opts.at })
      this.x = x
      this.y = y
    }
    this.applyPosition()
    openWindows.add(this)
    lastOpened = this
    this.raise()
    this.onOpen()
    gameAudio()?.ui('ui.windowOpen')
  }

  close(): void {
    if (!this.openState) return
    this.openState = false
    this.root.hidden = true
    openWindows.delete(this)
    if (lastOpened === this) lastOpened = topWindow()
    this.onClose?.()
    gameAudio()?.ui('ui.windowClose')
  }

  toggle(): void {
    if (this.openState) this.close()
    else this.open()
  }

  /** Stacking order stamp (larger = on top); used to close the top window on Esc. */
  get z(): number {
    return Number(this.root.style.zIndex) || 0
  }

  raise(): void {
    if (this.z === zTop && zTop > Z_BASE) return
    this.root.style.zIndex = String(++zTop)
  }

  setTitle(text: string): void {
    setText(this.titleStrip, text)
    this.root.setAttribute('aria-label', text)
  }

  /** Moves the window (native px); `remember` saves it as the window's position. */
  moveTo(x: number, y: number, remember = false): void {
    this.x = x
    this.y = y
    this.placed = true
    this.applyPosition()
    if (remember) this.save()
  }

  /** Changes the outer size (native px). */
  resize(w: number, h: number): void {
    this.w = Math.round(w)
    this.h = Math.round(h)
    this.root.style.width = `${this.w}px`
    this.root.style.height = `${this.h}px`
    if (this.closeButton) this.closeButton.style.left = `${this.w - CLOSE_AT[0]}px`
    this.applyPosition()
  }

  protected onOpen(): void {}

  dispose(): void {
    if (this.openState) {
      openWindows.delete(this)
      if (lastOpened === this) lastOpened = null
    }
    this.ls.clear()
    this.root.remove()
  }

  /** The layer's size in native px (the viewport divided by the layer's zoom). */
  private viewport(): [number, number] {
    return layerViewport(this.root.parentElement)
  }

  private load(): void {
    let saved: { x?: unknown; y?: unknown } = {}
    try {
      saved = JSON.parse(localStorage.getItem(`sro.hud.${this.opts.id}`) ?? '{}') as { x?: unknown; y?: unknown }
    } catch {
      saved = {}
    }
    if (typeof saved.x === 'number' && typeof saved.y === 'number' && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      this.x = saved.x
      this.y = saved.y
      this.placed = true
    }
  }

  private save(): void {
    try {
      localStorage.setItem(`sro.hud.${this.opts.id}`, JSON.stringify({ x: this.x, y: this.y }))
    } catch {
      // storage blocked: the position is simply not remembered
    }
  }

  private applyPosition(): void {
    const [vw, vh] = this.viewport()
    ;[this.x, this.y] = clampWindow(this.x, this.y, this.w, vw, vh)
    this.root.style.left = `${this.x}px`
    this.root.style.top = `${this.y}px`
  }

  private setupDrag(handle: HTMLElement): void {
    let drag: { id: number; sx: number; sy: number; x: number; y: number; s: number } | null = null
    this.ls.on(handle, 'pointerdown', ev => {
      if (ev.button !== 0) return
      drag = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, x: this.x, y: this.y, s: layerScale(this.root.parentElement) }
      handle.setPointerCapture(ev.pointerId)
      ev.preventDefault()
    })
    this.ls.on(handle, 'pointermove', ev => {
      if (!drag || ev.pointerId !== drag.id) return
      // clientX is viewport px; the window lives in native px (zoomed layer).
      this.x = drag.x + (ev.clientX - drag.sx) / drag.s
      this.y = drag.y + (ev.clientY - drag.sy) / drag.s
      this.placed = true
      this.applyPosition()
    })
    const end = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.id) return
      drag = null
      this.save()
    }
    this.ls.on(handle, 'pointerup', end)
    this.ls.on(handle, 'pointercancel', end)
  }

  private setupResize(limits: { minW: number; minH: number }): void {
    const grip = el('div', 'kit-window-grip')
    this.root.append(grip)
    let drag: { id: number; sx: number; sy: number; w: number; h: number; s: number } | null = null
    this.ls.on(grip, 'pointerdown', ev => {
      if (ev.button !== 0) return
      drag = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, w: this.w, h: this.h, s: layerScale(this.root.parentElement) }
      grip.setPointerCapture(ev.pointerId)
      ev.preventDefault()
      ev.stopPropagation()
    })
    this.ls.on(grip, 'pointermove', ev => {
      if (!drag || ev.pointerId !== drag.id) return
      this.resize(Math.max(limits.minW, drag.w + (ev.clientX - drag.sx) / drag.s), Math.max(limits.minH, drag.h + (ev.clientY - drag.sy) / drag.s))
    })
    const end = (ev: PointerEvent) => {
      if (drag && ev.pointerId === drag.id) drag = null
    }
    this.ls.on(grip, 'pointerup', end)
    this.ls.on(grip, 'pointercancel', end)
  }
}
