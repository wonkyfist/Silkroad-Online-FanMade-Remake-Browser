/**
 * The minimap tile redraw of a touched region (WE-D; docs/WORLD_EDITOR.md §4.3, §6.2 step 2, F8). Node-free and
 * deterministic.
 *
 * The client's minimap tile (256 x 256, north-up, 0.75 m per pixel) has the ground and every object baked in. After
 * the edits:
 * - **Inside the footprint of a dropped placement** (a delete, the old end of a move; ../coast/placements.ts
 *   `dropFootprint`, the coast's rule for C9's drops: the model's bounds grown by 1.5 m), never the retail pixel: it
 *   shows the gone object. Our render of the ground after the edits is drawn there instead.
 * - **Where the ground moved** (> CHANGE_TOL_M) **or was painted**, within CHANGE_DILATE_PX of it: the retail pixel
 *   times the ratio of our render after to our render before (per channel), so the hill shade follows the new ground
 *   and a painted tile takes its colour while the retail detail (and the objects still standing) stays; across the
 *   dilation band the change fades into the untouched pixels.
 * - **Added placements** (adds, the new end of a move) are drawn on top: vegetation as a dark disc of its crown, other
 *   objects as their footprint in the coast's prop colour.
 * Our render = the mean colours of the four corner tiles (bilinear) x a hill shade from the north-west (1 on flat
 * ground), scaled per channel to the tile's own retail pixels outside every change (so it sits at the retail tone).
 * Outside the changes every pixel stays bit for bit; a region with nothing to redraw gives null.
 */
import { CHANGE_DILATE_PX, CHANGE_TOL_M, MINIMAP_SIZE, PROP_RGB } from '../coast/minimap.ts'
import type { DropFootprint } from '../coast/placements.ts'
import type { EditsImage } from '../edits-hook.ts'
import type { LatticeHeight } from './shadows.ts'

const CELLS = 96
const G = CELLS + 1
/** Vegetation discs on the minimap (the retail tiles' dark tree blobs). */
export const VEGETATION_RGB: readonly [number, number, number] = [46, 62, 36]

/** A texture word on the global lattice (undefined outside the export). */
export type LatticeWord = (ggx: number, ggz: number) => number | undefined

export interface MinimapAdd {
  /** Footprint corners in absolute region units (x east, z north), as DropFootprint. */
  corners: ReadonlyArray<readonly [number, number]>
  /** Centre (region units) and crown radius (m) for vegetation. */
  centre: readonly [number, number]
  radiusM: number
  vegetation: boolean
}

export interface MinimapRedrawInput {
  rx: number
  rz: number
  /** The region's current tile (retail or the coast's), RGBA, row 0 = north. */
  current: EditsImage
  heightBefore: LatticeHeight
  heightAfter: LatticeHeight
  wordBefore: LatticeWord
  wordAfter: LatticeWord
  /** A tile's mean colour (sRGB 0..255), or null when unknown. */
  tileColour(id: number): readonly [number, number, number] | null
  dropped: readonly DropFootprint[]
  added: readonly MinimapAdd[]
}

/** The redrawn tile, or null when nothing in the region changed. */
export function redrawMinimap(input: MinimapRedrawInput): EditsImage | null {
  const S = MINIMAP_SIZE
  const { rx, rz } = input
  const cur = toSize(input.current, S)
  const hb = new Float64Array(G * G)
  const ha = new Float64Array(G * G)
  const wb = new Int32Array(G * G)
  const wa = new Int32Array(G * G)
  const changedV = new Uint8Array(G * G)
  let anyChange = false
  for (let gz = 0; gz < G; gz++) {
    for (let gx = 0; gx < G; gx++) {
      const i = gz * G + gx
      const ggx = rx * CELLS + gx
      const ggz = rz * CELLS + gz
      hb[i] = input.heightBefore(ggx, ggz) ?? NaN
      ha[i] = input.heightAfter(ggx, ggz) ?? NaN
      wb[i] = input.wordBefore(ggx, ggz) ?? -1
      wa[i] = input.wordAfter(ggx, ggz) ?? -1
      if (Math.abs(ha[i]! - hb[i]!) > CHANGE_TOL_M || wa[i] !== wb[i]) {
        changedV[i] = 1
        anyChange = true
      }
    }
  }
  const gone = polygonMask(input.dropped, rx, rz)
  const adds = input.added.filter(a => a.corners.some(([x]) => x > rx) && a.corners.some(([x]) => x < rx + 1) &&
    a.corners.some(([, z]) => z > rz) && a.corners.some(([, z]) => z < rz + 1))
  if (!anyChange && !gone && !adds.length) return null

  // the change mask at pixel resolution, then its dilation weights
  const step = CELLS / S
  const core = new Uint8Array(S * S)
  for (let r = 0; r < S; r++) {
    const fz = CELLS - (r + 0.5) * step
    const iz = Math.min(Math.floor(fz), CELLS - 1)
    for (let c = 0; c < S; c++) {
      const fx = (c + 0.5) * step
      const ix = Math.min(Math.floor(fx), CELLS - 1)
      if (changedV[iz * G + ix] || changedV[iz * G + ix + 1] || changedV[(iz + 1) * G + ix] || changedV[(iz + 1) * G + ix + 1]) core[r * S + c] = 1
    }
  }
  const weight = dilate(core, S, CHANGE_DILATE_PX)

  // our render before and after (null where a tile colour is unknown)
  const render = (h: Float64Array, words: Int32Array, fx: number, fz: number, out: number[]): boolean => {
    const ix = Math.min(Math.floor(fx), CELLS - 1)
    const iz = Math.min(Math.floor(fz), CELLS - 1)
    const tx = fx - ix
    const tz = fz - iz
    out[0] = out[1] = out[2] = 0
    const corners: Array<[number, number]> = [[iz * G + ix, (1 - tx) * (1 - tz)], [iz * G + ix + 1, tx * (1 - tz)],
      [(iz + 1) * G + ix, (1 - tx) * tz], [(iz + 1) * G + ix + 1, tx * tz]]
    for (const [k, wgt] of corners) {
      const col = words[k]! >= 0 ? input.tileColour(words[k]! & 0x3ff) : null
      if (!col) return false
      out[0] += col[0] * wgt
      out[1] += col[1] * wgt
      out[2] += col[2] * wgt
    }
    const s = shade(h, ix, iz)
    out[0] *= s
    out[1] *= s
    out[2] *= s
    return true
  }

  // per-channel gain: the retail pixels over our render before, outside every change
  const sumR = [0, 0, 0]
  const sumO = [0, 0, 0]
  const px = [0, 0, 0]
  for (let r = 0; r < S; r += 2) {
    for (let c = 0; c < S; c += 2) {
      const p = r * S + c
      if (weight[p]! > 0 || (gone && gone[p])) continue
      if (!render(hb, wb, (c + 0.5) * step, CELLS - (r + 0.5) * step, px)) continue
      for (let k = 0; k < 3; k++) {
        sumR[k] += cur.rgba[p * 4 + k]!
        sumO[k] += px[k]!
      }
    }
  }
  const gain = sumO.map((o, k) => (o > 0 ? Math.min(4, Math.max(0.25, sumR[k]! / o)) : 1))
  // the fallback ground colour (no tile colour): the tile's own mean
  const mean = [0, 0, 0]
  for (let p = 0; p < S * S; p++) for (let k = 0; k < 3; k++) mean[k] += cur.rgba[p * 4 + k]! / (S * S)

  const rgba = Uint8Array.from(cur.rgba)
  const before = [0, 0, 0]
  const after = [0, 0, 0]
  let changedPx = 0
  for (let r = 0; r < S; r++) {
    const fz = CELLS - (r + 0.5) * step
    for (let c = 0; c < S; c++) {
      const p = r * S + c
      const o = p * 4
      const fx = (c + 0.5) * step
      if (gone && gone[p]) {
        const ok = render(ha, wa, fx, fz, after)
        for (let k = 0; k < 3; k++) rgba[o + k] = clamp8(ok ? after[k]! * gain[k]! : mean[k]!)
        rgba[o + 3] = 255
        changedPx++
        continue
      }
      const m = weight[p]!
      if (!(m > 0)) continue
      if (!render(hb, wb, fx, fz, before) || !render(ha, wa, fx, fz, after)) continue
      for (let k = 0; k < 3; k++) {
        const ratio = before[k]! > 0 ? Math.min(5, Math.max(0.2, after[k]! / before[k]!)) : 1
        const v = cur.rgba[o + k]!
        rgba[o + k] = clamp8(v * (1 - m) + v * ratio * m)
      }
      rgba[o + 3] = 255
      changedPx++
    }
  }
  for (const a of adds) changedPx += drawAdd(rgba, a, rx, rz)
  if (!changedPx) return null
  return { width: S, height: S, rgba }
}

const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)))

/** Hill shade at a lattice cell from the north-west, 1 on flat ground. */
function shade(h: Float64Array, ix: number, iz: number): number {
  const k = iz * G + ix
  const h00 = h[k]!, h10 = h[k + 1]!, h01 = h[k + G]!, h11 = h[k + G + 1]!
  if (![h00, h10, h01, h11].every(Number.isFinite)) return 1
  // the cell's slope (m per m): east and north
  const se = ((h10 - h00) + (h11 - h01)) / 4
  const sn = ((h01 - h00) + (h11 - h10)) / 4
  // normal (-se, 1, -sn); light from the north-west and above: (-1, 1.5, 1) in (east, up, north)
  const len = Math.hypot(se, 1, sn)
  const l = Math.hypot(1, 1.5, 1)
  const dot = (se * 1 + 1.5 - sn * 1) / (len * l)
  return Math.max(0.6, Math.min(1.3, dot / (1.5 / l)))
}

/** Pixels (row 0 = north) inside any footprint quad, or null when none touches the region. */
function polygonMask(fps: ReadonlyArray<{ corners: ReadonlyArray<readonly [number, number]> }>, rx: number, rz: number): Uint8Array | null {
  const S = MINIMAP_SIZE
  let out: Uint8Array | null = null
  for (const f of fps) {
    const pts = f.corners.map(([cx, cz]) => [(cx - rx) * S, (rz + 1 - cz) * S] as const)
    const c0 = Math.max(0, Math.floor(Math.min(...pts.map(q => q[0]))))
    const c1 = Math.min(S, Math.ceil(Math.max(...pts.map(q => q[0]))))
    const r0 = Math.max(0, Math.floor(Math.min(...pts.map(q => q[1]))))
    const r1 = Math.min(S, Math.ceil(Math.max(...pts.map(q => q[1]))))
    if (c0 >= c1 || r0 >= r1) continue
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        if (!insideConvex(pts, c + 0.5, r + 0.5)) continue
        out ??= new Uint8Array(S * S)
        out[r * S + c] = 1
      }
    }
  }
  return out
}

function insideConvex(pts: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let pos = false
  let neg = false
  for (let k = 0; k < pts.length; k++) {
    const [ax, ay] = pts[k]!
    const [bx, by] = pts[(k + 1) % pts.length]!
    const cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
    if (cr > 0) pos = true
    else if (cr < 0) neg = true
    if (pos && neg) return false
  }
  return true
}

/** An add on the tile; returns the pixels drawn. */
function drawAdd(rgba: Uint8Array, a: MinimapAdd, rx: number, rz: number): number {
  const S = MINIMAP_SIZE
  let n = 0
  if (a.vegetation) {
    const cx = (a.centre[0] - rx) * S
    const cy = (rz + 1 - a.centre[1]) * S
    const rad = Math.max(1.5, a.radiusM / (192 / S))
    for (let r = Math.max(0, Math.floor(cy - rad - 1)); r < Math.min(S, Math.ceil(cy + rad + 1)); r++) {
      for (let c = Math.max(0, Math.floor(cx - rad - 1)); c < Math.min(S, Math.ceil(cx + rad + 1)); c++) {
        const d = Math.hypot(c + 0.5 - cx, r + 0.5 - cy)
        const cover = Math.max(0, Math.min(1, rad + 0.5 - d))
        if (!(cover > 0)) continue
        const o = (r * S + c) * 4
        for (let k = 0; k < 3; k++) rgba[o + k] = clamp8(rgba[o + k]! * (1 - 0.85 * cover) + VEGETATION_RGB[k]! * 0.85 * cover)
        n++
      }
    }
    return n
  }
  const mask = polygonMask([a], rx, rz)
  if (!mask) return 0
  for (let p = 0; p < S * S; p++) {
    if (!mask[p]) continue
    const o = p * 4
    for (let k = 0; k < 3; k++) rgba[o + k] = PROP_RGB[k]!
    rgba[o + 3] = 255
    n++
  }
  return n
}

/** 1 on the core, fading to 0 over `px` pixels (Chebyshev), as the coast's dilation band. */
function dilate(core: Uint8Array, S: number, px: number): Float32Array {
  const out = new Float32Array(S * S)
  for (let r = 0; r < S; r++) {
    for (let c = 0; c < S; c++) {
      if (!core[r * S + c]) continue
      for (let dr = -px; dr <= px; dr++) {
        const rr = r + dr
        if (rr < 0 || rr >= S) continue
        for (let dc = -px; dc <= px; dc++) {
          const cc = c + dc
          if (cc < 0 || cc >= S) continue
          const wgt = 1 - Math.max(Math.abs(dr), Math.abs(dc)) / (px + 1)
          const k = rr * S + cc
          if (wgt > out[k]!) out[k] = wgt
        }
      }
    }
  }
  return out
}

/** The image at S x S (nearest; the retail tiles are 256 already). */
function toSize(img: EditsImage, S: number): EditsImage {
  if (img.width === S && img.height === S) return img
  const rgba = new Uint8Array(S * S * 4)
  for (let r = 0; r < S; r++) {
    const sr = Math.min(img.height - 1, Math.floor(((r + 0.5) * img.height) / S))
    for (let c = 0; c < S; c++) {
      const sc = Math.min(img.width - 1, Math.floor(((c + 0.5) * img.width) / S))
      rgba.set(img.rgba.subarray((sr * img.width + sc) * 4, (sr * img.width + sc) * 4 + 4), (r * S + c) * 4)
    }
  }
  return { width: S, height: S, rgba }
}
