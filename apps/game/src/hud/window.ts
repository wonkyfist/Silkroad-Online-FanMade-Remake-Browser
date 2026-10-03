/**
 * The HUD's window base, now a thin subclass of the kit window (docs/UI.md §6, migration step 2): every window that
 * extends it gets the retail `mframe_wnd_` chrome (36-px title strip, gold rim, close button), the cascade and the
 * zoomed-layer drag at once. The constructor shape is unchanged; the old `frame` / `fill` choices map to the main
 * skin. The body keeps its old size (width × height − 28), so the frame grows around it; the `.hud-window`,
 * `.hud-window-<id>`, `.hud-window-title` and `.hud-window-body` classes stay for the lanes' CSS and queries.
 * Position is remembered per window in localStorage (`sro.hud.<id>`), in native px of the zoomed HUD layer.
 */
import type { Art } from '../ui/art.ts'
import { Window } from '../ui/kit/window.ts'

export interface HudWindowOptions {
  id: string
  title: string
  width: number
  height: number
  /** Frame piece prefix of the old look, e.g. 'inventory/int_window_' (every window now uses the main skin). */
  frame: string
  fill?: string
  /** Default position as viewport fractions of the free space (0 = left/top, 1 = right/bottom). */
  at: [number, number]
}

/** The old title band above the body (the body used to start at y = 28 and span the full width). */
const OLD_TITLE = 28
/** The body inset inside the mframe chrome for windows laid out for the old frame [top, right, bottom, left]. */
export const LEGACY_INSET = [40, 12, 12, 12] as const

/** Outer size of a legacy window whose old size was w × h: the same body plus the mframe insets. */
export function legacyOuterSize(w: number, h: number): [number, number] {
  const [top, right, bottom, left] = LEGACY_INSET
  return [w + left + right, h - OLD_TITLE + top + bottom]
}

export class HudWindow extends Window {
  constructor(art: Art, parent: HTMLElement, opts: HudWindowOptions) {
    const [width, height] = legacyOuterSize(opts.width, opts.height)
    super(art, parent, { id: opts.id, title: opts.title, width, height, frame: 'main', at: opts.at, inset: LEGACY_INSET })
    this.root.classList.add('hud-window', `hud-window-${opts.id}`)
    this.titleStrip.classList.add('hud-window-title')
    this.body.classList.add('hud-window-body')
  }
}
