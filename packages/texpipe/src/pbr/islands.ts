/**
 * TP-P UV islands (docs/TEXPIPE.md §3.2 "UV islands", §3.5): the part that makes character and armour maps "fit the
 * UVs" at every mip.
 *
 *   1. `rasterIslands` rasterises the TEXCOORD_0 triangles of every primitive that uses a texture into a coverage mask
 *      at the master size (conservatively: a texel counts when its centre is within half a texel of the triangle, so
 *      the bilinear footprint of every rendered texel is inside), then labels its 8-connected components: one region
 *      per island. De-lighting, height normalisation and normals then run per island (image.ts `regionBlur`), so an
 *      island never averages in its neighbour or the gutter.
 *   2. `nearestOwner` + `fillFrom` dilate every map into the gutter after each stage: each gutter texel takes the value
 *      of its nearest island texel (a multi-source breadth-first fill), so mips average an island with copies of its
 *      own border, never with the next island. Only a band of 8 texels at 2K (TEXPIPE §3.2) is filled: beyond it the
 *      atlas may hold art no converted glb samples, which `withUnclaimed` keeps and processes as regions of its own.
 *
 * Pure (no node:*): the caller reads the glbs (run.ts) and passes the triangles.
 */
import { img, type Img, type Regions, type Wrap } from './image.ts'

/** UV triangles as a flat list: u0 v0 u1 v1 u2 v2 per triangle, glTF convention (v = 0 at the top of the image). */
export type UvTriangles = Float64Array | number[]

/** Signed doubled area of a 2-D triangle. */
const area2 = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)

/** Rasterises triangles into a coverage mask (1 = covered) at w×h. A triangle is shifted by whole periods so its
 * centroid lies in [0, 1)², the way a repeating sampler reads it. */
export function rasterCoverage(tris: UvTriangles, w: number, h: number, halo = 0.5): Uint8Array {
  const cov = new Uint8Array(w * h)
  // Many primitives repeat the same UV triangle (a tree's leaf cards all map the whole texture): raster each once.
  const seen = new Set<string>()
  for (let t = 0; t + 5 < tris.length; t += 6) {
    let u0 = tris[t]!, v0 = tris[t + 1]!, u1 = tris[t + 2]!, v1 = tris[t + 3]!, u2 = tris[t + 4]!, v2 = tris[t + 5]!
    if (![u0, v0, u1, v1, u2, v2].every(Number.isFinite)) continue
    const su = Math.floor((u0 + u1 + u2) / 3), sv = Math.floor((v0 + v1 + v2) / 3)
    u0 -= su; u1 -= su; u2 -= su; v0 -= sv; v1 -= sv; v2 -= sv
    const id = [u0, v0, u1, v1, u2, v2].map(v => Math.round(v * w * 16)).join(',')
    if (seen.has(id)) continue
    seen.add(id)
    const ax = u0 * w, ay = v0 * h, bx = u1 * w, by = v1 * h, cx = u2 * w, cy = v2 * h
    let a = area2(ax, ay, bx, by, cx, cy)
    if (Math.abs(a) < 1e-9) continue
    // Edge functions with outward distance: inside when every edge distance ≥ −halo.
    const sgn = a > 0 ? 1 : -1
    a = Math.abs(a)
    const edges = [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]].map(([x0, y0, x1, y1]) => {
      const len = Math.hypot(x1! - x0!, y1! - y0!) || 1
      return [x0!, y0!, x1!, y1!, len] as const
    })
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - halo - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx) + halo + 1))
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - halo - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy) + halo + 1))
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5
        let inside = true
        for (const [ex0, ey0, ex1, ey1, len] of edges) {
          if ((sgn * area2(ex0, ey0, ex1, ey1, px, py)) / len < -halo) {
            inside = false
            break
          }
        }
        if (inside) cov[y * w + x] = 1
      }
    }
  }
  return cov
}

/** Labels the 8-connected components of a coverage mask (wrapping along the given axes) as regions. */
export function labelRegions(cov: Uint8Array, w: number, h: number, wrap: Wrap = [false, false]): Regions {
  const ids = new Int32Array(w * h).fill(-1)
  const boxes: [number, number, number, number][] = []
  const queue = new Int32Array(w * h)
  let count = 0
  for (let start = 0; start < w * h; start++) {
    if (!cov[start] || ids[start]! >= 0) continue
    const id = count++
    let head = 0, tail = 0
    queue[tail++] = start
    ids[start] = id
    let bx0 = w, by0 = h, bx1 = 0, by1 = 0
    while (head < tail) {
      const p = queue[head++]!
      const x = p % w, y = (p - x) / w
      if (x < bx0) bx0 = x
      if (y < by0) by0 = y
      if (x + 1 > bx1) bx1 = x + 1
      if (y + 1 > by1) by1 = y + 1
      for (let dy = -1; dy <= 1; dy++) {
        let ny = y + dy
        if (ny < 0 || ny >= h) {
          if (!wrap[1]) continue
          ny = (ny + h) % h
        }
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          let nx = x + dx
          if (nx < 0 || nx >= w) {
            if (!wrap[0]) continue
            nx = (nx + w) % w
          }
          const q = ny * w + nx
          if (cov[q] && ids[q]! < 0) {
            ids[q] = id
            queue[tail++] = q
          }
        }
      }
    }
    boxes.push([bx0, by0, bx1, by1])
  }
  return { w, h, ids, count, boxes }
}

/** The islands of an atlas at w×h from its UV triangles (rasterCoverage + labelRegions). */
export function rasterIslands(tris: UvTriangles, w: number, h: number): Regions {
  return labelRegions(rasterCoverage(tris, w, h), w, h)
}

/**
 * For every texel, the index of the nearest texel inside a region (itself when it is inside one), by a multi-source
 * breadth-first fill over the 8-neighbourhood; −1 everywhere when no texel is inside a region.
 */
export function nearestOwner(ids: Int32Array, w: number, h: number, wrap: Wrap = [false, false]): Int32Array {
  const owner = new Int32Array(w * h).fill(-1)
  const queue = new Int32Array(w * h)
  let head = 0, tail = 0
  for (let p = 0; p < w * h; p++) {
    if (ids[p]! >= 0) {
      owner[p] = p
      queue[tail++] = p
    }
  }
  while (head < tail) {
    const p = queue[head++]!
    const x = p % w, y = (p - x) / w
    // 4-neighbours first, then diagonals, so ties go to the straight neighbour (closer in Euclidean terms).
    for (const [dx, dy] of NEIGHBOURS) {
      let nx = x + dx, ny = y + dy
      if (nx < 0 || nx >= w) {
        if (!wrap[0]) continue
        nx = (nx + w) % w
      }
      if (ny < 0 || ny >= h) {
        if (!wrap[1]) continue
        ny = (ny + h) % h
      }
      const q = ny * w + nx
      if (owner[q]! < 0) {
        owner[q] = owner[p]!
        queue[tail++] = q
      }
    }
  }
  return owner
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]

/** Chessboard distance (texels) from every texel to the nearest texel inside a region (0 inside; −1 without any). */
export function regionDistance(ids: Int32Array, w: number, h: number): Int32Array {
  const dist = new Int32Array(w * h).fill(-1)
  const queue = new Int32Array(w * h)
  let head = 0, tail = 0
  for (let p = 0; p < w * h; p++) {
    if (ids[p]! >= 0) {
      dist[p] = 0
      queue[tail++] = p
    }
  }
  while (head < tail) {
    const p = queue[head++]!
    const x = p % w, y = (p - x) / w
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
      const q = ny * w + nx
      if (dist[q]! < 0) {
        dist[q] = dist[p]! + 1
        queue[tail++] = q
      }
    }
  }
  return dist
}

/** The gutter band dilated around the islands: 8 texels on a 2048 master (TEXPIPE §3.2), at least 2. */
export function gutterBand(w: number, h: number): number {
  return Math.max(2, Math.round((8 * Math.max(w, h)) / 2048))
}

/**
 * Atlas regions for processing: the UV islands, plus the **unclaimed art** — texels farther than `band` from every
 * island, as one more region. Only the band is a gutter (id −1, dilated from its nearest
 * island). No glb in work/out samples the unclaimed art (the upper half of the Copper Sword atlas), but a model that
 * was not converted might, so it is de-lit and derived like an island instead of being painted over.
 * `islandCount` = the number of real islands (their ids come first).
 */
export function withUnclaimed(islands: Regions, band: number): { regions: Regions; islandCount: number } {
  const { w, h } = islands
  const dist = regionDistance(islands.ids, w, h)
  const rest = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) rest[p] = islands.ids[p]! < 0 && (dist[p]! < 0 || dist[p]! > band) ? 1 : 0
  // All unclaimed art is one region (it is separated by islands anyway; many small regions with overlapping boxes
  // would multiply the blur cost).
  const ids = islands.ids.slice()
  let x0 = w, y0 = h, x1 = 0, y1 = 0, any = false
  for (let p = 0; p < w * h; p++) {
    if (!rest[p]) continue
    any = true
    ids[p] = islands.count
    const x = p % w, y = (p - x) / w
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x + 1 > x1) x1 = x + 1
    if (y + 1 > y1) y1 = y + 1
  }
  return {
    regions: { w, h, ids, count: islands.count + (any ? 1 : 0), boxes: any ? [...islands.boxes, [x0, y0, x1, y1]] : islands.boxes },
    islandCount: islands.count,
  }
}

/**
 * The dilation owner of an atlas: gutter-band texels take their nearest *island* texel; every other texel without a
 * region (a cutout's transparent matte) its nearest region texel; region texels themselves.
 */
export function atlasOwner(regions: Regions, islandCount: number): Int32Array {
  const { w, h, ids } = regions
  const all = nearestOwner(ids, w, h)
  const islandIds = new Int32Array(ids.length)
  for (let p = 0; p < ids.length; p++) islandIds[p] = ids[p]! >= 0 && ids[p]! < islandCount ? ids[p]! : -1
  const fromIsland = nearestOwner(islandIds, w, h)
  const dist = regionDistance(islandIds, w, h)
  const band = gutterBand(w, h)
  const owner = all.slice()
  for (let p = 0; p < ids.length; p++) if (ids[p]! < 0 && dist[p]! >= 0 && dist[p]! <= band && fromIsland[p]! >= 0) owner[p] = fromIsland[p]!
  return owner
}

/** Copies every texel from its owner (all channels, or only `channels`): the gutter dilation of one map. */
export function fillFrom(im: Img, owner: Int32Array, channels?: readonly number[]): Img {
  const o = img(im.w, im.h, im.c)
  o.d.set(im.d)
  const ks = channels ?? Array.from({ length: im.c }, (_, i) => i)
  for (let p = 0; p < owner.length; p++) {
    const q = owner[p]!
    if (q < 0 || q === p) continue
    for (const k of ks) o.d[p * im.c + k] = im.d[q * im.c + k]!
  }
  return o
}

/** The region id each texel takes after dilation (the owner's region; −1 without any region). */
export function dilatedIds(ids: Int32Array, owner: Int32Array): Int32Array {
  const out = new Int32Array(ids.length)
  for (let p = 0; p < ids.length; p++) out[p] = owner[p]! >= 0 ? ids[owner[p]!]! : -1
  return out
}
