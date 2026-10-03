/**
 * Portions ported from Tidewater (github.com/dgreenheck/tidewater, `SurfFoam.js` at `4811ba4`), MIT licence, Copyright (c)
 * 2026 DRG Software Solutions LLC. See THIRD_PARTY_NOTICES.md.
 *
 * The foam lace (docs/COAST.md §8.8): a tileable RGBA8 texture, generated once at load (no asset). Written from COAST
 * §8.8's description of `SurfFoam.js`' `makeLaceTexture` (the upstream source was not re-read for this lane):
 * - R: the distance to the nearest bubble strand (0 on a strand, 1 far from every strand): two jittered Voronoi
 *   networks (the cell walls are the strands between the bubbles);
 * - G: small bubbles along the strands;
 * - B: a mottling (tileable value noise, three octaves);
 * - A: a random value per bubble cell.
 * Thresholding R by the foam amount turns a dense mat (amount 1) into foam with holes, then lace, then single strands
 * as the foam decays (shore/chunks.ts). Deterministic (a fixed seed, integer hashing): the same bytes every run; the
 * cell lattices wrap at the tile, so the texture tiles. Generated in row slices so no load frame stalls
 * (shore/index.ts); LACE_TILE_M per tile in the world.
 */

/**
 * Metres of sea per lace tile (COAST §8.8 names 3.5 m; at 3.5 m the half-metre cells read as a net from the
 * third-person camera's 2–5 m over the swash, so the look check took 2.2 m).
 */
export const LACE_TILE_M = 2.2
/** The texture size (texels per side). */
export const LACE_SIZE = 512
/** Cells per tile of the coarse and the fine strand network, and of the bubbles. */
const COARSE = 7
const FINE = 13
const BUBBLES = 41
const SEED = 0x51ea

/** Integer hash → [0, 1). */
function hashU(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x1b873593)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** A wrapped n-cell lattice: one jittered feature point per cell (cell units inside the cell) and a value per cell. */
interface Lattice {
  n: number
  px: Float32Array
  py: Float32Array
  value: Float32Array
}

const lattices = new Map<string, Lattice>()

function lattice(n: number, s: number): Lattice {
  const key = `${n}/${s}`
  let l = lattices.get(key)
  if (l) return l
  const px = new Float32Array(n * n), py = new Float32Array(n * n), value = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      px[j * n + i] = 0.12 + 0.76 * hashU(i, j, s)
      py[j * n + i] = 0.12 + 0.76 * hashU(i, j, s + 101)
      value[j * n + i] = hashU(i, j, s + 31)
    }
  }
  l = { n, px, py, value }
  lattices.set(key, l)
  return l
}

/** F1, F2 (cell units) and the nearest cell's index at (u, v) in [0, 1) on a wrapped lattice. */
function worley(u: number, v: number, l: Lattice, out: { f1: number; f2: number; id: number }): void {
  const n = l.n
  const x = u * n, y = v * n
  const ci = Math.floor(x), cj = Math.floor(y)
  let f1 = Infinity, f2 = Infinity, id = 0
  for (let dj = -1; dj <= 1; dj++) {
    const j = cj + dj
    const wj = j < 0 ? j + n : j >= n ? j - n : j
    for (let di = -1; di <= 1; di++) {
      const i = ci + di
      const wi = i < 0 ? i + n : i >= n ? i - n : i
      const k = wj * n + wi
      const dx = i + l.px[k]! - x, dy = j + l.py[k]! - y
      const d2 = dx * dx + dy * dy
      if (d2 < f1) {
        f2 = f1
        f1 = d2
        id = k
      } else if (d2 < f2) f2 = d2
    }
  }
  out.f1 = Math.sqrt(f1)
  out.f2 = Math.sqrt(f2)
  out.id = id
}

/** Tileable value noise of period n cells (the lattice's values). */
function valueNoise(u: number, v: number, l: Lattice): number {
  const n = l.n
  const x = u * n, y = v * n
  const i = Math.floor(x), j = Math.floor(y)
  const fx = x - i, fy = y - j
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
  const i1 = i + 1 >= n ? 0 : i + 1, j1 = j + 1 >= n ? 0 : j + 1
  const val = l.value
  const a = val[j * n + i]!, b = val[j * n + i1]!, c = val[j1 * n + i]!, d = val[j1 * n + i1]!
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/**
 * Fills rows [row0, row1) of an RGBA8 lace texture of `size`² (the whole texture by default). The rows are
 * independent, so a caller may fill them in slices; the result does not depend on the slicing.
 */
export function fillLace(data: Uint8Array, size = LACE_SIZE, row0 = 0, row1 = size): void {
  const coarse = lattice(COARSE, SEED), fine = lattice(FINE, SEED + 7), bubbles = lattice(BUBBLES, SEED + 13)
  const m1 = lattice(4, SEED + 21), m2 = lattice(9, SEED + 23), m3 = lattice(19, SEED + 29)
  const a = { f1: 0, f2: 0, id: 0 }
  const b = { f1: 0, f2: 0, id: 0 }
  const c = { f1: 0, f2: 0, id: 0 }
  for (let y = row0; y < row1; y++) {
    const v = (y + 0.5) / size
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size
      worley(u, v, coarse, a)
      worley(u, v, fine, b)
      worley(u, v, bubbles, c)
      // Distance to the cell walls (F2 − F1, cell units), the coarse network the stronger.
      // The coarse walls are strong, the fine ones fade in and out with the mottling: holes of varied sizes.
      const e1 = (a.f2 - a.f1) * 1.6
      const e2 = (b.f2 - b.f1) * 2.2
      const n2 = valueNoise(u, v, m2)
      const r = clamp01(Math.min(e1, e2 + 0.05 + 0.5 * n2))
      // Small bubbles: the fine lattice's discs, only near a strand.
      const disc = clamp01((0.32 - c.f1) / 0.14)
      const g = disc * clamp01(1 - r / 0.45)
      const m = 0.5 * valueNoise(u, v, m1) + 0.3 * valueNoise(u, v, m2) + 0.2 * valueNoise(u, v, m3)
      const o = (y * size + x) * 4
      data[o] = Math.round(r * 255)
      data[o + 1] = Math.round(g * 255)
      data[o + 2] = Math.round(clamp01(m) * 255)
      data[o + 3] = Math.round(coarse.value[a.id]! * 255)
    }
  }
}

/** The whole lace texture (tests, and a caller that need not slice). */
export function makeLace(size = LACE_SIZE): Uint8Array {
  const data = new Uint8Array(size * size * 4)
  fillLace(data, size)
  return data
}

/**
 * Fills the lace in slices of `rows` rows, one slice per `schedule` callback (a macrotask by default), and resolves
 * with the bytes. `isCancelled` stops it (the world was disposed).
 */
export function makeLaceSliced(
  size = LACE_SIZE,
  rows = 16,
  isCancelled: () => boolean = () => false,
  schedule: (fn: () => void) => void = fn => void setTimeout(fn, 0),
): Promise<Uint8Array | null> {
  const data = new Uint8Array(size * size * 4)
  return new Promise(resolve => {
    let row = 0
    const step = () => {
      if (isCancelled()) {
        resolve(null)
        return
      }
      const end = Math.min(size, row + rows)
      fillLace(data, size, row, end)
      row = end
      if (row >= size) resolve(data)
      else schedule(step)
    }
    schedule(step)
  })
}
