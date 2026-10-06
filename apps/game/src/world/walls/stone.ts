/**
 * Siege of Jangan, layer 2: the geometry of broken wall stone, as plain arrays (no Babylon; view.ts turns them into
 * meshes, tests read them).
 *
 * - **Chunks** (`chunkGeometry`): a unit block with its corners knocked off (a truncated box, each corner cut by its own
 *   amount, every vertex jittered), flat shaded, so it reads as a broken lump of masonry from any side. UV0 maps the
 *   wall's own texture onto each face at the wall's texel density (cj_wall01: ≈ 17 m per repeat across, 18.7 m up; the
 *   `core` look takes the big tan base blocks of cj_wall02). UV1 is one point of the wall's lightmap (the wall's own
 *   material draws the chunk, Classic and PBR alike, and needs a lightmap coordinate).
 * - **Mound** (`moundGeometry`): the heap under a downed third, a faceted grid draped over the ground; every triangle
 *   shows its own patch of brick at its own angle, so it reads as jumbled broken brick, and the colours darken toward
 *   earth at the foot.
 * - **Beam** (`beamGeometry`): a unit timber for the scaffolding (grain along the length).
 * Every builder is seeded: the same seed gives the same arrays on every client.
 */
import { mulberry32 } from '@sro/shared'

export interface Geometry {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  uvs2: Float32Array
  colors: Float32Array
  indices: Uint32Array
}

/** cj_wall01 (brick): metres per texture repeat across (u) and up (v), measured on the cut glb's outer faces. */
export const BRICK_M = { u: 17, v: 18.7 } as const
/** The chunk's size the UVs assume (m): an instance scaled near this shows bricks at the wall's own size. */
export const CHUNK_UV_SIZE_M = 1.6

export type ChunkLook = 'brick' | 'core'

/** The 8 corners of the unit cube (±0.5), bit i of the index = the sign along axis i. */
const corner = (c: number, i: number) => ((c >> i) & 1 ? 0.5 : -0.5)

/**
 * A broken block: a unit cube whose corners are cut (by 0.12-0.38 of an edge each) and whose 24 vertices are jittered,
 * flat shaded (3 vertices per triangle). `lm` is the lightmap coordinate every vertex gets.
 */
export function chunkGeometry(seed: number, look: ChunkLook, lm: readonly [number, number] = [0.5, 0.5]): Geometry {
  const rnd = mulberry32(seed >>> 0)
  // v[c][i]: corner c moved toward its neighbour along axis i by t_c
  const v: number[][][] = []
  for (let c = 0; c < 8; c++) {
    const t = 0.12 + rnd() * 0.26
    const row: number[][] = []
    for (let i = 0; i < 3; i++) {
      const p = [corner(c, 0), corner(c, 1), corner(c, 2)]
      p[i] = p[i]! - Math.sign(p[i]!) * t
      for (let k = 0; k < 3; k++) p[k] = p[k]! + (rnd() - 0.5) * 0.09
      row.push(p)
    }
    v.push(row)
  }
  const tris: number[][][] = []
  // the six faces: an octagon of the 4 corners on that side, two cut vertices each (the in-plane axes)
  for (let a = 0; a < 3; a++) {
    for (const s of [0, 1]) {
      const b = (a + 1) % 3, c2 = (a + 2) % 3
      // the 4 corners in order around the face (in the b, c2 plane)
      const ring: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]
      const poly: number[][] = []
      for (const [sb, sc] of ring) {
        const ci = (s << a) | (sb << b) | (sc << c2)
        // entering from the previous corner along c2 or b: keep the octagon's order
        const first = sb === sc ? c2 : b
        const second = first === b ? c2 : b
        poly.push(v[ci]![first]!, v[ci]![second]!)
      }
      // order so the normal points outward (sign s along a)
      const n = polyNormal(poly)
      if ((n[a]! > 0) !== (s === 1)) poly.reverse()
      for (let k = 1; k + 1 < poly.length; k++) tris.push([poly[0]!, poly[k]!, poly[k + 1]!])
    }
  }
  // the eight corner cuts
  for (let c = 0; c < 8; c++) {
    const t = [v[c]![0]!, v[c]![1]!, v[c]![2]!]
    const n = triNormal(t[0]!, t[1]!, t[2]!)
    const out = [corner(c, 0), corner(c, 1), corner(c, 2)]
    if (n[0]! * out[0]! + n[1]! * out[1]! + n[2]! * out[2]! < 0) t.reverse()
    tris.push(t)
  }
  const uOff = rnd(), vOff = rnd()
  return flatGeometry(tris, (p, n) => {
    // planar mapping on the face's dominant axis, at the wall's texel density for a chunk of CHUNK_UV_SIZE_M
    const ax = Math.abs(n[0]!) > Math.abs(n[1]!) ? (Math.abs(n[0]!) > Math.abs(n[2]!) ? 0 : 2) : Math.abs(n[1]!) > Math.abs(n[2]!) ? 1 : 2
    const pu = ax === 0 ? p[2]! : p[0]!
    const pv = ax === 1 ? p[2]! : p[1]!
    if (look === 'core') return [uOff + pu * 0.25, 0.815 - pv * 0.3]
    return [uOff + (pu * CHUNK_UV_SIZE_M) / BRICK_M.u, vOff + (-pv * CHUNK_UV_SIZE_M) / BRICK_M.v]
  }, (p, n) => {
    // baked shading: a little darker underneath and on the lower half (dirt, contact shadow)
    const k = 0.78 + 0.22 * Math.max(0, Math.min(1, 0.5 + p[1]! + 0.3 * n[1]!))
    return [k, k * 0.98, k * 0.95]
  }, lm)
}

export interface MoundOptions {
  /** Grid cells along and across. */
  cells: [number, number]
  /** Height (m) at (u along 0..1, w across 0..1, both over the footprint); 0 at the rim. */
  height: (u: number, w: number) => number
  /** Ground height (m) at a world point, and the footprint's corner, axis and size. */
  ground: (x: number, z: number) => number
  /** World point of (u, w). */
  at: (u: number, w: number) => [number, number]
  seed: number
  lm?: readonly [number, number]
}

/**
 * The heap under a downed third: a faceted grid over the footprint, lifted by `height` over the ground (+5 cm so the
 * rim never fights the terrain). Each triangle shows a random patch of brick at a random angle (broken brick, not a
 * brick floor), and the colour darkens toward earth where the heap is thin.
 */
export function moundGeometry(o: MoundOptions): Geometry {
  const [nu, nw] = o.cells
  const rnd = mulberry32(o.seed >>> 0)
  const grid: number[][] = []
  const lift: number[] = []
  for (let j = 0; j <= nw; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, w = j / nw
      const [x, z] = o.at(u, w)
      const rim = i === 0 || j === 0 || i === nu || j === nw
      const h = rim ? 0 : Math.max(0, o.height(u, w) + (rnd() - 0.5) * 0.35)
      grid.push([x + (rim ? 0 : (rnd() - 0.5) * 0.6), o.ground(x, z) + 0.05 + h, z + (rim ? 0 : (rnd() - 0.5) * 0.6)])
      lift.push(h)
    }
  }
  const tris: number[][][] = []
  const thick: number[] = []
  const idx = (i: number, j: number) => j * (nu + 1) + i
  for (let j = 0; j < nw; j++) {
    for (let i = 0; i < nu; i++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1)
      const quad: [number, number, number][] = (i + j) % 2 ? [[a, d, c], [a, c, b]] : [[a, d, b], [b, d, c]]
      for (const [p, q, r] of quad) {
        const t = [grid[p]!, grid[q]!, grid[r]!]
        // keep every triangle facing up
        if (triNormal(t[0]!, t[1]!, t[2]!)[1]! < 0) t.reverse()
        tris.push(t)
        thick.push((lift[p]! + lift[q]! + lift[r]!) / 3)
      }
    }
  }
  let tri = -1
  let cur: { ox: number; oy: number; c: number; s: number; k: number; tint: [number, number, number] } | null = null
  return flatGeometry(tris, (p, _n, corner) => {
    if (corner === 0) {
      tri++
      const ang = rnd() * Math.PI * 2
      const r = rnd()
      // most facets broken brick, some the wall's tan core and lime, some deep in shadow
      const tint: [number, number, number] = r < 0.25 ? [1.05, 0.93, 0.76] : r < 0.4 ? [0.62, 0.6, 0.58] : [1, 1, 1]
      cur = { ox: rnd() * 4, oy: rnd() * 4, c: Math.cos(ang), s: Math.sin(ang), k: 0.55 + rnd() * 0.6, tint }
    }
    const q = cur!
    // ≈ a third of the wall's brick size: broken bricks, not whole courses
    const u = (p[0]! * q.c - p[2]! * q.s) / (BRICK_M.u * 0.35)
    const v = (p[0]! * q.s + p[2]! * q.c) / (BRICK_M.v * 0.35)
    return [q.ox + u, q.oy + v]
  }, () => {
    const h = thick[Math.max(0, tri)] ?? 0
    // thin heap: earth and mortar dust, darker; thick: the brick's own colour, each facet a little different (in the
    // shadow of the stones lying on it)
    const earth = Math.max(0, Math.min(1, 1 - h / 1.4))
    const k = cur ? cur.k : 0.8
    const shade = 0.42 + 0.36 * k
    const t = cur ? cur.tint : [1, 1, 1]
    return [shade * t[0]! * (1 - 0.12 * earth), shade * t[1]! * (1 - 0.22 * earth), shade * t[2]! * (1 - 0.36 * earth)]
  }, o.lm ?? [0.5, 0.5])
}

/** A unit beam (1 m along x, 1 × 1 across), the grain (u) along its length; scaled per instance. */
export function beamGeometry(lm: readonly [number, number] = [0.5, 0.5]): Geometry {
  const tris: number[][][] = []
  const P = (x: number, y: number, z: number) => [x - 0.5, y - 0.5, z - 0.5]
  const quads: number[][][] = [
    [P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0)],
    [P(0, 0, 1), P(0, 1, 1), P(1, 1, 1), P(1, 0, 1)],
    [P(0, 1, 0), P(1, 1, 0), P(1, 1, 1), P(0, 1, 1)],
    [P(0, 0, 0), P(0, 0, 1), P(1, 0, 1), P(1, 0, 0)],
    [P(0, 0, 0), P(0, 1, 0), P(0, 1, 1), P(0, 0, 1)],
    [P(1, 0, 0), P(1, 0, 1), P(1, 1, 1), P(1, 1, 0)],
  ]
  for (const q of quads) {
    const n = polyNormal(q)
    const c = [q[0]![0]! + q[2]![0]!, q[0]![1]! + q[2]![1]!, q[0]![2]! + q[2]![2]!]
    // outward: away from the centre
    if (n[0]! * c[0]! + n[1]! * c[1]! + n[2]! * c[2]! < 0) q.reverse()
    tris.push([q[0]!, q[1]!, q[2]!], [q[0]!, q[2]!, q[3]!])
  }
  return flatGeometry(tris, (p, n) => {
    const end = Math.abs(n[0]!) > 0.5
    return end ? [0.5 + p[1]! * 0.2, 0.5 + p[2]! * 0.2] : [p[0]! + 0.5, 0.5 + (Math.abs(n[1]!) > 0.5 ? p[2]! : p[1]!) * 0.9]
  }, (_p, n) => {
    const k = n[1]! > 0.5 ? 1 : n[1]! < -0.5 ? 0.7 : 0.88
    return [k, k, k]
  }, lm)
}

// ---- helpers --------------------------------------------------------------------------------------------------------

function sub(a: number[], b: number[]): number[] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]
}

function cross(a: number[], b: number[]): number[] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]
}

function norm(a: number[]): number[] {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1
  return [a[0]! / l, a[1]! / l, a[2]! / l]
}

/** Counter-clockwise (glTF / Babylon right-handed front face) normal of a triangle. */
export function triNormal(a: number[], b: number[], c: number[]): number[] {
  return norm(cross(sub(b, a), sub(c, a)))
}

function polyNormal(poly: number[][]): number[] {
  // Newell's method
  let x = 0, y = 0, z = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!
    x += (p[1]! - q[1]!) * (p[2]! + q[2]!)
    y += (p[2]! - q[2]!) * (p[0]! + q[0]!)
    z += (p[0]! - q[0]!) * (p[1]! + q[1]!)
  }
  return norm([x, y, z])
}

/**
 * Flat-shaded arrays of triangles (counter-clockwise from outside): 3 vertices each, the triangle's normal, `uv(p, n,
 * corner)` and `color(p, n)` per vertex, `lm` as UV1. The world scene is right-handed (three/backdrop.ts newScene), where
 * the front face is counter-clockwise, as for the glTF data.
 */
function flatGeometry(
  tris: number[][][],
  uv: (p: number[], n: number[], corner: number) => [number, number],
  color: (p: number[], n: number[]) => [number, number, number],
  lm: readonly [number, number],
): Geometry {
  const n = tris.length * 3
  const positions = new Float32Array(n * 3)
  const normals = new Float32Array(n * 3)
  const uvs = new Float32Array(n * 2)
  const uvs2 = new Float32Array(n * 2)
  const colors = new Float32Array(n * 4)
  const indices = new Uint32Array(n)
  let k = 0
  for (const t of tris) {
    const nn = triNormal(t[0]!, t[1]!, t[2]!)
    for (let c = 0; c < 3; c++) {
      const p = t[c]!
      positions.set(p, k * 3)
      normals.set(nn, k * 3)
      uvs.set(uv(p, nn, c), k * 2)
      uvs2[k * 2] = lm[0]
      uvs2[k * 2 + 1] = lm[1]
      const col = color(p, nn)
      colors[k * 4] = col[0]
      colors[k * 4 + 1] = col[1]
      colors[k * 4 + 2] = col[2]
      colors[k * 4 + 3] = 1
      k++
    }
  }
  for (let i = 0; i < n; i++) indices[i] = i
  return { positions, normals, uvs, uvs2, colors, indices }
}

/**
 * The broken face that closes a standing piece's end at a gap (the cut glbs leave their ends open). `outer` and `inner`
 * are the end's vertices on the two faces (world m, bottom to top, the notched profile); `dir` the axis direction from
 * the stone into the gap ([1, 0] along x, [0, 1] along z, signed). A ragged middle line between them (pushed in and out
 * along the axis, never at the foot or the top so the face meets the wall walk) makes it rough; the brick shows in
 * jumbled patches, darker than the faces (the inside of the wall).
 */
export function capGeometry(
  outer: readonly (readonly [number, number, number])[], inner: readonly (readonly [number, number, number])[],
  dir: readonly [number, number], seed: number, lm: readonly [number, number] = [0.5, 0.5], rows = 8,
): Geometry | null {
  if (outer.length < 2 || inner.length < 2) return null
  const rnd = mulberry32(seed >>> 0)
  const sample = (line: readonly (readonly [number, number, number])[], s: number): number[] => {
    const y0 = line[0]![1], y1 = line[line.length - 1]![1]
    const y = y0 + (y1 - y0) * s
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i]!, b = line[i + 1]!
      if (y <= b[1] || i + 2 === line.length) {
        const t = b[1] > a[1] ? Math.max(0, Math.min(1, (y - a[1]) / (b[1] - a[1]))) : 0
        return [a[0] + (b[0] - a[0]) * t, y, a[2] + (b[2] - a[2]) * t]
      }
    }
    return [...line[line.length - 1]!]
  }
  const O: number[][] = [], I: number[][] = [], M: number[][] = []
  for (let r = 0; r <= rows; r++) {
    const s = r / rows
    const o = sample(outer, s), i = sample(inner, s)
    O.push(o)
    I.push(i)
    // the middle: pushed back into the stone or out into the gap (0 at the foot and the top)
    const k = r === 0 || r === rows ? 0 : (rnd() - 0.4) * 1.6
    M.push([(o[0]! + i[0]!) / 2 + dir[0] * k, (o[1]! + i[1]!) / 2 + (r === 0 || r === rows ? 0 : (rnd() - 0.5) * 0.6), (o[2]! + i[2]!) / 2 + dir[1] * k])
  }
  const tris: number[][][] = []
  for (let r = 0; r < rows; r++) {
    for (const [a, b] of [[O, M], [M, I]] as const) tris.push([a[r]!, a[r + 1]!, b[r + 1]!], [a[r]!, b[r + 1]!, b[r]!])
  }
  // face into the gap
  const n = triNormal(tris[0]![0]!, tris[0]![1]!, tris[0]![2]!)
  if (n[0]! * dir[0] + n[2]! * dir[1] < 0) for (const t of tris) t.reverse()
  let cur = { ox: 0, oy: 0, k: 0.7 }
  return flatGeometry(tris, (p, _n, corner) => {
    if (corner === 0) cur = { ox: rnd() * 4, oy: rnd() * 4, k: 0.5 + rnd() * 0.35 }
    // planar on the cut plane (across, up) at the wall's brick size, each facet its own patch
    const across = dir[0] !== 0 ? p[2]! : p[0]!
    return [cur.ox + across / BRICK_M.u, cur.oy - p[1]! / BRICK_M.v]
  }, () => [cur.k, cur.k * 0.96, cur.k * 0.9], lm)
}
