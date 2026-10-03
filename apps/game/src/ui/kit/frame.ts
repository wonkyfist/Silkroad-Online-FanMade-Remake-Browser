/**
 * A framed box of any skin at any size (docs/UI.md §5.1): the nine-slice frame, its body tile and a body element
 * inset by the skin's content inset. Windows, sections, dialogs, fields and tooltips are all Frames.
 */
import type { Art } from '../art.ts'
import { el, type Rect } from '../dom.ts'
import { frameSkin, nineSlice } from './nine.ts'
import type { FrameName, FrameSkin } from './skins.ts'

export interface FrameOptions {
  w?: number
  h?: number
  /** Placed absolutely at this rect in its parent (native px). */
  at?: Rect
  className?: string
  /** Overrides the skin's body tile (null = none). */
  fill?: string | null
  /** Overrides the skin's body inset [top, right, bottom, left]. */
  inset?: readonly [number, number, number, number]
}

export class Frame {
  readonly root: HTMLElement
  readonly body: HTMLElement
  readonly frameLayer: HTMLElement

  constructor(art: Art, skin: FrameName | FrameSkin, opts: FrameOptions = {}) {
    const s = frameSkin(skin)
    this.root = el('div', `kit-box ${opts.className ?? ''}`.trim())
    if (opts.at) {
      const [x, y, w, h] = opts.at
      Object.assign(this.root.style, { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` })
    }
    if (opts.w) this.root.style.width = `${opts.w}px`
    if (opts.h) this.root.style.height = `${opts.h}px`
    this.body = el('div', 'kit-box-body')
    setInset(this.body, opts.inset ?? s.inset)
    this.root.append(this.body)
    this.frameLayer = nineSlice(this.root, art, skin, { fill: opts.fill })
  }
}

/** Places `e` absolutely with an inset [top, right, bottom, left] in px. */
export function setInset(e: HTMLElement, [top, right, bottom, left]: readonly [number, number, number, number]): void {
  Object.assign(e.style, { position: 'absolute', top: `${top}px`, right: `${right}px`, bottom: `${bottom}px`, left: `${left}px` })
}
