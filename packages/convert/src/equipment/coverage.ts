/**
 * Body-vs-armour coverage in the shared bind pose (pure; any consistent space, glTF metres by default).
 *
 * gap test: a hidden body vertex is covered when the line through it along its normal meets a visible surface
 * (the item or a body part that stays visible) within `range` in either direction. A miss means the part was
 * hidden where nothing replaces it: a hole in the character.
 * poke-through test: a visible body vertex that lies outside an item surface by more than `tolerance` while the
 * closest item point is inside a triangle (not on an open edge such as a sleeve cuff) and within `near`.
 */

export interface MeshGeometry {
  name: string
  positions: ArrayLike<number>
  normals: ArrayLike<number>
  indices: ArrayLike<number>
}

export type V = [number, number, number]

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

export interface Tri {
  a: V
  b: V
  c: V
  /** Unit face normal from the stored (counter-clockwise front) winding. */
  n: V
  min: V
  max: V
}

function at(a: ArrayLike<number>, i: number): V {
  return [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!]
}

export function triangles(meshes: readonly MeshGeometry[]): Tri[] {
  const out: Tri[] = []
  for (const m of meshes) {
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
      const a = at(m.positions, m.indices[t]!)
      const b = at(m.positions, m.indices[t + 1]!)
      const c = at(m.positions, m.indices[t + 2]!)
      const n = cross(sub(b, a), sub(c, a))
      const l = Math.hypot(...n)
      if (!(l > 0)) continue
      out.push({
        a, b, c, n: [n[0] / l, n[1] / l, n[2] / l],
        min: [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])],
        max: [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])],
      })
    }
  }
  return out
}

/** Signed distance t (smallest |t|, |t| <= range) at which o + t d meets a triangle, or null. */
function rayHit(o: V, d: V, tris: readonly Tri[], range: number): number | null {
  let best: number | null = null
  const lo: V = [0, 0, 0]
  const hi: V = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    lo[k] = o[k]! - Math.abs(d[k]!) * range - 1e-6
    hi[k] = o[k]! + Math.abs(d[k]!) * range + 1e-6
  }
  for (const tri of tris) {
    if (tri.max[0] < lo[0] || tri.max[1] < lo[1] || tri.max[2] < lo[2]) continue
    if (tri.min[0] > hi[0] || tri.min[1] > hi[1] || tri.min[2] > hi[2]) continue
    const e1 = sub(tri.b, tri.a)
    const e2 = sub(tri.c, tri.a)
    const pv = cross(d, e2)
    const det = dot(e1, pv)
    if (Math.abs(det) < 1e-14) continue
    const inv = 1 / det
    const tv = sub(o, tri.a)
    const u = dot(tv, pv) * inv
    if (u < -1e-4 || u > 1 + 1e-4) continue
    const qv = cross(tv, e1)
    const v = dot(d, qv) * inv
    if (v < -1e-4 || u + v > 1 + 1e-4) continue
    const t = dot(e2, qv) * inv
    if (Math.abs(t) <= range && (best === null || Math.abs(t) < Math.abs(best))) best = t
  }
  return best
}

/** Nearest-surface tolerance of the gap test (m). */
export const GAP_NEAR = 0.015

export interface GapReport {
  mesh: string
  vertices: number
  /** Vertices checked (above the ground cut). */
  checked: number
  gaps: number
  /** Largest |t| of a hit: how far the replacing surface is from the body. */
  maxOffset: number
  gapVertices: number[]
}

/**
 * Gap test for one hidden body part. A vertex whose normal line misses still counts as covered when a visible
 * surface lies within `near` of it. Vertices below `groundY` are skipped: sole edges at floor level whose
 * normals graze along the ground cannot be seen.
 */
export function gapReport(hidden: MeshGeometry, visible: readonly Tri[], range = 0.1, groundY = 0.005, near = GAP_NEAR): GapReport {
  const n = hidden.positions.length / 3
  let checked = 0
  let maxOffset = 0
  const gapVertices: number[] = []
  for (let i = 0; i < n; i++) {
    const p = at(hidden.positions, i)
    if (p[1] < groundY) continue
    checked++
    const d = at(hidden.normals, i)
    const l = Math.hypot(...d)
    if (!(l > 0)) continue
    const t = rayHit(p, [d[0] / l, d[1] / l, d[2] / l], visible, range)
    if (t === null) {
      // Tips of thin parts (finger ends a glove stops just short of) have a surface right next to them.
      if (Math.abs(signedDistance(p, visible).d) > near) gapVertices.push(i)
    } else maxOffset = Math.max(maxOffset, Math.abs(t))
  }
  return { mesh: hidden.name, vertices: n, checked, gaps: gapVertices.length, maxOffset, gapVertices }
}

function closestOnTriangle(p: V, a: V, b: V, c: V): { q: V; interior: boolean } {
  const ab = sub(b, a)
  const ac = sub(c, a)
  const ap = sub(p, a)
  const d1 = dot(ab, ap)
  const d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return { q: a, interior: false }
  const bp = sub(p, b)
  const d3 = dot(ab, bp)
  const d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return { q: b, interior: false }
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    return { q: [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]], interior: false }
  }
  const cp = sub(p, c)
  const d5 = dot(ab, cp)
  const d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return { q: c, interior: false }
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return { q: [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]], interior: false }
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return { q: [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])], interior: false }
  }
  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  return { q: [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w], interior: true }
}

/** Signed distance of p to the closest triangle (positive in front), and whether that point is interior. */
export function signedDistance(p: V, tris: readonly Tri[]): { d: number; interior: boolean } {
  let best = Infinity
  let sign = 1
  let interior = false
  for (const tri of tris) {
    const { q, interior: inside } = closestOnTriangle(p, tri.a, tri.b, tri.c)
    const d = Math.hypot(...sub(p, q))
    if (d < best - 1e-9) {
      best = d
      sign = Math.sign(dot(sub(p, q), tri.n)) || 1
      interior = inside
    }
  }
  return { d: best * sign, interior }
}

export interface PokeReport {
  mesh: string
  vertices: number
  /** Vertices under (behind) the item surface within `near`: hidden by the item anyway. */
  under: number
  poke: number
  pokeVertices: number[]
}

export function pokeReport(visible: MeshGeometry, items: readonly Tri[], tolerance = 0.002, near = 0.02): PokeReport {
  const n = visible.positions.length / 3
  let under = 0
  const pokeVertices: number[] = []
  for (let i = 0; i < n; i++) {
    const { d, interior } = signedDistance(at(visible.positions, i), items)
    if (d <= tolerance && d >= -near * 5) under++
    else if (interior && d > tolerance && d < near) pokeVertices.push(i)
  }
  return { mesh: visible.name, vertices: n, under, poke: pokeVertices.length, pokeVertices }
}
