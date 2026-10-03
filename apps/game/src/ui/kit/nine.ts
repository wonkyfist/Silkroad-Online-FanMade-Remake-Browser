/**
 * Nine-slice frames (docs/UI.md §0.4, §5.4). UI-X composes each 8-piece retail frame into one sheet
 * `<prefix>9` (columns [left | M | right], rows [top | S | bottom], edge tiles repeated) and records the slice
 * insets in `UiImage.nine`; the kit draws it with CSS `border-image` on one element. When only the eight
 * pieces exist, the older 8-element renderer (ui/frame.ts) is used. The body tile is a separate layer.
 */
import type { Art, NineInsets } from '../art.ts'
import { el } from '../dom.ts'
import { frame as pieceFrame } from '../frame.ts'
import { FRAME_PIECES, FRAMES, nineKey, resolveFrame, type FrameName, type FramePiece, type FrameSkin } from './skins.ts'

export interface NineGeometry extends NineInsets {
  /** Width of the tiled middle column / height of the tiled middle row of the composed sheet. */
  midW: number
  midH: number
  /** Sheet size. */
  width: number
  height: number
}

const MAX_TILE = 256

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}

/** Least common multiple of the tile lengths, capped (the exporter repeats tiles to fill it). */
export function tileSpan(a: number, b: number, cap = MAX_TILE): number {
  if (!(a > 0)) return Math.min(cap, Math.max(1, b))
  if (!(b > 0)) return Math.min(cap, a)
  return Math.min(cap, (a * b) / gcd(a, b))
}

/** The sheet layout and slice insets of an 8-piece frame from its piece sizes ([w, h] each). */
export function nineSliceGeometry(pieces: Record<FramePiece, readonly [number, number]>): NineGeometry {
  const w = (p: FramePiece) => pieces[p][0]
  const h = (p: FramePiece) => pieces[p][1]
  const left = Math.max(w('left_up'), w('left_side'), w('left_down'))
  const right = Math.max(w('right_up'), w('right_side'), w('right_down'))
  const top = Math.max(h('left_up'), h('mid_up'), h('right_up'))
  const bottom = Math.max(h('left_down'), h('mid_down'), h('right_down'))
  const midW = tileSpan(w('mid_up'), w('mid_down'))
  const midH = tileSpan(h('left_side'), h('right_side'))
  return { top, right, bottom, left, midW, midH, width: left + midW + right, height: top + midH + bottom }
}

/** CSS for a `border-image` frame from a sheet (the frame edges are drawn at native size, tiles repeat). */
export function borderImageCss(url: string, n: NineInsets): Record<string, string> {
  return {
    borderStyle: 'solid',
    borderWidth: `${n.top}px ${n.right}px ${n.bottom}px ${n.left}px`,
    borderImageSource: url,
    borderImageSlice: `${n.top} ${n.right} ${n.bottom} ${n.left}`,
    borderImageWidth: `${n.top}px ${n.right}px ${n.bottom}px ${n.left}px`,
    borderImageRepeat: 'repeat',
  }
}

export function frameSkin(name: FrameName | FrameSkin): FrameSkin {
  return typeof name === 'string' ? FRAMES[name] : name
}

/**
 * Makes `host` draw a frame: appends an absolutely positioned frame layer (first child, so content draws above it)
 * and returns it. `fill` overrides the skin's body tile (null = none). Without any art the layer gets `no-art` and a
 * CSS stand-in (dark body, gold rim) from the kit stylesheet.
 */
export function nineSlice(host: HTMLElement, art: Art, name: FrameName | FrameSkin, opts: { fill?: string | null; className?: string } = {}): HTMLElement {
  const skin = frameSkin(name)
  const skinName = typeof name === 'string' ? name : 'custom'
  const prefix = resolveFrame(art, skin)
  const fillKey = opts.fill === null ? undefined : (opts.fill ?? skin.fill)
  const layer = el('div', `kit-frame kit-frame-${skinName} ${opts.className ?? ''}`)
  layer.dataset.frame = prefix ?? 'none'
  const insets = prefix ? art.nine(nineKey(prefix)) : undefined
  if (fillKey && art.has(fillKey)) {
    const fill = el('div', 'kit-frame-fill')
    fill.style.backgroundImage = art.cssUrl(fillKey)
    // Under the frame's edges (their transparent parts show the body), not past the outer rim.
    const i = insets ?? { top: 8, right: 8, bottom: 8, left: 8 }
    Object.assign(fill.style, { top: `${Math.min(i.top, 8)}px`, right: `${Math.min(i.right, 8)}px`, bottom: `${Math.min(i.bottom, 8)}px`, left: `${Math.min(i.left, 8)}px` })
    layer.append(fill)
  }
  if (prefix && insets && art.has(nineKey(prefix))) {
    const edge = el('div', 'kit-frame-edge')
    Object.assign(edge.style, borderImageCss(art.cssUrl(nineKey(prefix)), insets))
    layer.append(edge)
  } else if (prefix) {
    layer.append(pieceFrame(art, prefix))
  } else {
    layer.classList.add('no-art')
  }
  host.prepend(layer)
  return layer
}

/** The piece sizes of an exported 8-piece frame (for callers that lay out against the real edges). */
export function pieceSizes(art: Art, prefix: string): Record<FramePiece, [number, number]> | undefined {
  const out = {} as Record<FramePiece, [number, number]>
  for (const p of FRAME_PIECES) {
    const s = art.size(prefix + p)
    if (!s) return undefined
    out[p] = s
  }
  return out
}
