/**
 * The tooltip (docs/UI.md §4.8): `frame_tooltip_` rim on a dark body, 8-px padding, max 260 px wide. It shows
 * 250 ms after the first hover (at once when one is already up) and hides at once. Placement is below-right of the
 * cursor (+16, +16), flipping at the screen edges. It lives on <body>, outside the zoomed layers, and zooms itself,
 * so it always matches the HUD's scale; positions come in as viewport px (clientX / clientY).
 * Line classes are the item tooltip's (hud/items.ts TooltipLine) plus the kit's section classes.
 */
import type { TooltipLine } from '../../hud/items.ts'
import type { Art } from '../art.ts'
import { el } from '../dom.ts'
import { nineSlice } from './nine.ts'
import { rootScale } from './scale.ts'
import { CONTROLS } from './skins.ts'

export type { TooltipLine }

/** Any line a tooltip can show: today's TooltipLine classes and the section classes (UI.md §4.8). */
export interface KitTooltipLine {
  text: string
  cls: TooltipLine['cls'] | 'magic' | 'sep' | 'price' | 'warn' | 'value' | 'label' | 'next'
}

/** The style each line class maps to (tokens, see tokens.ts `.kit-tt-*`). */
export const TOOLTIP_STYLES: Record<KitTooltipLine['cls'], string> = {
  title: 'kit-tt-title',
  'title-plus': 'kit-tt-title plus',
  type: 'kit-tt-type',
  stat: 'kit-tt-stat',
  req: 'kit-tt-req',
  bad: 'kit-tt-bad',
  hint: 'kit-tt-hint',
  desc: 'kit-tt-desc',
  magic: 'kit-tt-magic',
  sep: 'kit-tt-sep',
  price: 'kit-tt-price',
  warn: 'kit-tt-warn',
  value: 'kit-tt-stat',
  label: 'kit-tt-type',
  next: 'kit-tt-next',
  // A broken item's stats (COMBAT §3.4): struck through and dimmed (I8).
  struck: 'kit-tt-stat struck',
}

export const TOOLTIP_DELAY_MS = 250
export const TOOLTIP_OFFSET = 16

/** Top-left (viewport px) for a w×h tooltip at cursor (x, y) in a vw×vh viewport: below-right, flipped at the edges. */
export function placeTooltip(x: number, y: number, w: number, h: number, vw: number, vh: number): [number, number] {
  let left = x + TOOLTIP_OFFSET
  let top = y + TOOLTIP_OFFSET
  if (left + w > vw - 4) left = Math.max(4, x - w - 12)
  if (top + h > vh - 4) top = Math.max(4, y - h - 12)
  return [Math.round(left), Math.round(top)]
}

export class Tooltip {
  readonly root: HTMLElement
  private readonly content: HTMLElement
  private timer: ReturnType<typeof setTimeout> | undefined
  private at: [number, number] = [0, 0]
  private readonly grayLine: string | null

  constructor(art: Art, private readonly opts: { delayMs?: number; parent?: HTMLElement } = {}) {
    this.content = el('div', 'kit-tooltip-content')
    this.root = el('div', 'kit-tooltip', this.content)
    nineSlice(this.root, art, 'tooltip', { fill: null })
    this.root.hidden = true
    this.grayLine = art.has(CONTROLS.grayLine) ? art.cssUrl(CONTROLS.grayLine) : null
    ;(opts.parent ?? document.body).append(this.root)
  }

  get visible(): boolean {
    return !this.root.hidden
  }

  /** Shows `lines` for the cursor at (x, y) viewport px (after the delay unless one is already up). */
  show(lines: readonly KitTooltipLine[], x: number, y: number): void {
    clearTimeout(this.timer)
    this.fill(lines)
    this.at = [x, y]
    const delay = this.opts.delayMs ?? TOOLTIP_DELAY_MS
    if (!this.root.hidden || delay <= 0) {
      this.reveal()
      return
    }
    this.timer = setTimeout(() => this.reveal(), delay)
  }

  /** Follows the cursor (viewport px). */
  move(x: number, y: number): void {
    this.at = [x, y]
    if (!this.root.hidden) this.place()
  }

  hide(): void {
    clearTimeout(this.timer)
    this.root.hidden = true
  }

  dispose(): void {
    this.hide()
    this.root.remove()
  }

  private fill(lines: readonly KitTooltipLine[]): void {
    this.content.replaceChildren(
      ...lines.map(l => {
        const d = el('div', TOOLTIP_STYLES[l.cls] ?? 'kit-tt-desc', l.cls === 'sep' ? '' : l.text)
        if (l.cls === 'sep' && this.grayLine) d.style.backgroundImage = this.grayLine
        return d
      }),
    )
  }

  private reveal(): void {
    this.root.hidden = false
    this.place()
  }

  private place(): void {
    const s = rootScale()
    const r = this.root.getBoundingClientRect()
    const [left, top] = placeTooltip(this.at[0], this.at[1], r.width, r.height, window.innerWidth, window.innerHeight)
    // The tooltip zooms itself (--ui), so its own left/top are in zoomed px.
    this.root.style.left = `${left / s}px`
    this.root.style.top = `${top / s}px`
  }
}
