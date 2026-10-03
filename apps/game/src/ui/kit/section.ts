/**
 * A sub-panel (docs/UI.md §2.3 `sframe_wnd_`): a frame with a blue caption strip. Used for the Main window's pages,
 * the storage "Stored items" box, the trade halves and the key help groups.
 */
import type { Art } from '../art.ts'
import { el, type Rect } from '../dom.ts'
import { Frame } from './frame.ts'
import { setText } from './label.ts'
import { FRAMES } from './skins.ts'

export interface SectionOptions {
  caption?: string
  w?: number
  h?: number
  at?: Rect
  className?: string
  fill?: string | null
}

export class Section extends Frame {
  readonly caption: HTMLElement

  constructor(art: Art, opts: SectionOptions = {}) {
    super(art, 'section', { ...opts, className: `kit-section ${opts.className ?? ''}`, inset: FRAMES.section.inset })
    this.caption = el('div', 'kit-section-caption kit-t-caption', opts.caption ?? '')
    this.caption.style.height = `${FRAMES.section.title}px`
    this.caption.hidden = opts.caption === undefined
    this.root.append(this.caption)
  }

  setCaption(text: string): void {
    setText(this.caption, text)
    this.caption.hidden = false
  }
}
