/**
 * The sea mask and the coast field (docs/COAST.md §5.3 step 7, §8.1). Node-free.
 *
 * The sea mask is a flood fill from the lattice border on sea sides over the pass's water surface: it never enters dry
 * playable ground and is never seeded on a land edge, so inland ground below the sea level (the town, the river beds,
 * the swamp, the ruins) is never sea; at +5 m it continues into retail water at the sea level that is connected to the
 * sea. The ocean is the sea mask minus the retail water that stays (the lake, rivers and moat inside the bounds keep
 * their own water planes), so there is never a double water layer.
 *
 * coast/field.png (RGBA8, `fieldMetresPerTexel` = 4 m, world-aligned, row 0 = north = the lattice's row 0):
 *   R  ocean mask, 255 = sea, feathered by one texel; on an ocean texel the in-bounds retail water at the sea level
 *      around it counts as sea (the two join flat, §8.1), so the ocean reaches the retail block's edge instead of
 *      fading out a texel short of it (W10R CST-H1: a sliver of dry bed between the two planes at the seam's ends);
 *   G  distance to the shoreline, 0 .. 127.5 m in 0.5 m steps (on sea texels to the nearest land, on land texels to the
 *      nearest sea);
 *   B  on sea texels the bed depth below SL, on land texels within 128 m of the sea the height above SL, both in 0.2 m
 *      steps (0 .. 51 m); 0 elsewhere;
 *   A  breaker and foam authoring (0: none yet).
 * Texel (tx, tz) samples the lattice vertex at the texel centre (column 2 tx + 1, row 2 tz + 1).
 */
import type { CoastConfig } from './config.ts'
import { CELL_M } from './lattice.ts'
import type { CoastResult } from './pass.ts'

export interface SeaMasks {
  /** The flood fill (sea plus connected retail water at the sea level). */
  sea: Uint8Array
  /** What the ocean draws over: `sea` minus retail water inside the bounds. */
  ocean: Uint8Array
}

/** The sea mask of a coast result (4-connected flood fill over the water surface, seeded on sea-side borders). */
export function seaMasks(r: CoastResult): SeaMasks {
  const { rows, cols } = r.shape
  const N = rows * cols
  const ws = r.masks.waterSurface
  const sea = new Uint8Array(N)
  const stack = new Int32Array(N)
  let top = 0
  const seed = (i: number) => {
    if (ws[i] && !sea[i] && r.landFade[i]! < 0.5) {
      sea[i] = 1
      stack[top++] = i
    }
  }
  for (let c = 0; c < cols; c++) {
    seed(c)
    seed((rows - 1) * cols + c)
  }
  for (let rr = 0; rr < rows; rr++) {
    seed(rr * cols)
    seed(rr * cols + cols - 1)
  }
  while (top > 0) {
    const i = stack[--top]!
    const c = i % cols
    const visit = (j: number) => {
      if (!sea[j] && ws[j]) {
        sea[j] = 1
        stack[top++] = j
      }
    }
    if (c > 0) visit(i - 1)
    if (c < cols - 1) visit(i + 1)
    if (i >= cols) visit(i - cols)
    if (i < N - cols) visit(i + cols)
  }
  const ocean = new Uint8Array(N)
  for (let i = 0; i < N; i++) ocean[i] = sea[i] && !(r.masks.inPlay[i] && r.masks.wetR[i]) ? 1 : 0
  return { sea, ocean }
}

export interface CoastField {
  width: number
  height: number
  rgba: Uint8Array
  metresPerTexel: number
}

/** The coast field image (see the header). */
export function coastField(r: CoastResult, cfg: CoastConfig, masks: SeaMasks): CoastField {
  const { rows, cols } = r.shape
  const mpt = cfg.ocean.fieldMetresPerTexel
  const step = Math.round(mpt / CELL_M)
  if (step < 1 || step * CELL_M !== mpt) throw new Error(`coast field: ${mpt} m per texel is not a multiple of the ${CELL_M} m lattice`)
  const width = Math.floor((cols - 1) / step)
  const height = Math.floor((rows - 1) / step)
  const n = width * height
  const at = (tx: number, tz: number) => Math.min(rows - 1, tz * step + (step >> 1)) * cols + Math.min(cols - 1, tx * step + (step >> 1))
  const ocean = new Uint8Array(n)
  const joins = new Uint8Array(n)
  const land = new Uint8Array(n)
  const h = new Float64Array(n)
  for (let tz = 0; tz < height; tz++) {
    for (let tx = 0; tx < width; tx++) {
      const i = at(tx, tz)
      const t = tz * width + tx
      ocean[t] = masks.ocean[i]!
      joins[t] = masks.ocean[i]! || (r.masks.inPlay[i] && r.masks.waterLow?.[i]) ? 1 : 0
      land[t] = r.masks.waterSurface[i] ? 0 : 1
      h[t] = r.h[i]!
    }
  }
  const toSea = distanceTo(ocean, width, height)
  const toLand = distanceTo(land, width, height)
  const SL = cfg.seaLevelM
  const rgba = new Uint8Array(n * 4)
  for (let tz = 0; tz < height; tz++) {
    for (let tx = 0; tx < width; tx++) {
      const t = tz * width + tx
      // R: the mask feathered by one texel (3 x 3 box)
      let sum = 0
      let cnt = 0
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = tx + dx
          const z = tz + dz
          if (x < 0 || z < 0 || x >= width || z >= height) continue
          sum += (ocean[t] ? joins : ocean)[z * width + x]!
          cnt++
        }
      }
      rgba[t * 4] = Math.round((255 * sum) / cnt)
      let g = 0
      let b = 0
      if (ocean[t]) {
        g = toLand[t]! * mpt
        b = (SL - h[t]!) / 0.2
      } else if (land[t]) {
        g = toSea[t]! * mpt
        if (g < 128) b = (h[t]! - SL) / 0.2
      }
      rgba[t * 4 + 1] = byte(g / 0.5)
      rgba[t * 4 + 2] = byte(b)
      rgba[t * 4 + 3] = 0
    }
  }
  return { width, height, rgba, metresPerTexel: mpt }
}

const byte = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v))

/**
 * Exact Euclidean distance (in texels) from every texel to the nearest set texel of `mask` (Felzenszwalb and
 * Huttenlocher's two-pass transform); Infinity when the mask is empty.
 */
export function distanceTo(mask: Uint8Array, width: number, height: number): Float64Array {
  const INF = 1e20
  const f = new Float64Array(Math.max(width, height))
  const d = new Float64Array(Math.max(width, height))
  const v = new Int32Array(Math.max(width, height))
  const z = new Float64Array(Math.max(width, height) + 1)
  const grid = new Float64Array(width * height)
  for (let i = 0; i < grid.length; i++) grid[i] = mask[i] ? 0 : INF
  const pass = (n: number, get: (k: number) => number, set: (k: number, val: number) => void) => {
    for (let k = 0; k < n; k++) f[k] = get(k)
    let k0 = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < n; q++) {
      let s = ((f[q]! + q * q) - (f[v[k0]!]! + v[k0]! * v[k0]!)) / (2 * q - 2 * v[k0]!)
      while (s <= z[k0]!) {
        k0--
        s = ((f[q]! + q * q) - (f[v[k0]!]! + v[k0]! * v[k0]!)) / (2 * q - 2 * v[k0]!)
      }
      k0++
      v[k0] = q
      z[k0] = s
      z[k0 + 1] = INF
    }
    k0 = 0
    for (let q = 0; q < n; q++) {
      while (z[k0 + 1]! < q) k0++
      d[q] = (q - v[k0]!) ** 2 + f[v[k0]!]!
    }
    for (let k = 0; k < n; k++) set(k, d[k]!)
  }
  for (let x = 0; x < width; x++) pass(height, k => grid[k * width + x]!, (k, val) => (grid[k * width + x] = val))
  for (let y = 0; y < height; y++) pass(width, k => grid[y * width + k]!, (k, val) => (grid[y * width + k] = val))
  const out = new Float64Array(width * height)
  for (let i = 0; i < out.length; i++) out[i] = grid[i]! >= INF / 2 ? Infinity : Math.sqrt(grid[i]!)
  return out
}
