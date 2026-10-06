/**
 * Siege of Jangan, layer 0 (docs/SIEGE.md §3.2 "Nav split"): cuts a retail wall's collision navmesh into pieces by
 * vertical planes across the wall, so each third of a segment (and each fixed piece) is its own nav instance the
 * server and the client can switch off (NavWorld.setInstanceEnabled). Pure and node-free.
 *
 * - Every triangle cell is clipped to each slab [cut k-1, cut k] along the axis (Sutherland-Hodgman), the polygon
 *   fanned back into triangles. An intersection point is computed from the edge's endpoints in a fixed order (lower
 *   vertex index first), so the two cells sharing an edge produce the same point and stay joined.
 * - Edges are rebuilt per piece from the triangles: a side used by two triangles is an inline edge (it keeps the
 *   original inline edge's flag and cell order when it lies on one; a new fan diagonal gets INLINE_FLAG), a side used
 *   by one is an outline edge: on a retail outline edge it keeps that edge's flag (blocking 3, the arch's underpass
 *   16), on a cut plane it blocks (CUT_FLAG 3): a gap's sides are walls, never a way under the next third.
 * - Pieces keep the retail instance's local frame (same position and yaw), so `instance` transforms them unchanged.
 */
import type { NavEdges, NavModel } from '@sro/nav'

/** Flag of an outline edge on a cut plane: blocks walkers coming from outside (a gap's side). */
export const CUT_FLAG = 3
/** Flag of a new inline edge (a fan diagonal inside a clipped cell): the retail interior flag. */
export const INLINE_FLAG = 4
/** Vertices closer than this (file units) are one. */
const WELD = 1e-3

/** Which local axis the wall runs along: 0 = x, 2 = z (file space). */
export type SplitAxis = 0 | 2

interface PVert {
  x: number
  y: number
  z: number
}

/** A clipped polygon vertex and the label of the edge that starts at it: an original side (0..2) or -1 (a cut). */
interface PEdge {
  v: PVert
  label: number
}

/**
 * Splits `model` at local `cuts` (sorted ascending, along `axis`) into cuts.length + 1 pieces, piece k covering
 * [cuts[k-1], cuts[k]] (-inf / +inf at the ends). An empty piece is null.
 */
export function splitNavModel(model: NavModel, axis: SplitAxis, cuts: readonly number[], keyOf: (piece: number) => string): (NavModel | null)[] {
  for (let i = 1; i < cuts.length; i++) if (!(cuts[i]! > cuts[i - 1]!)) throw new Error('nav split: cuts must ascend')
  const V = model.vertices
  const vert = (i: number): PVert => ({ x: V[i * 3]!, y: V[i * 3 + 1]!, z: V[i * 3 + 2]! })
  // original sides: vertex pair -> outline flag, or inline (cells and flag)
  const outline = new Map<string, number>()
  const inline = new Map<string, { c0: number; c1: number; flag: number }>()
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`)
  const oe = model.outline
  for (let e = 0; e < oe.flags.length; e++) outline.set(key(oe.vertices[e * 2]!, oe.vertices[e * 2 + 1]!), oe.flags[e]!)
  const ie = model.inline
  for (let e = 0; e < ie.flags.length; e++) inline.set(key(ie.vertices[e * 2]!, ie.vertices[e * 2 + 1]!), { c0: ie.cells[e * 2]!, c1: ie.cells[e * 2 + 1]!, flag: ie.flags[e]! })
  const n = model.cells.length / 3
  // per original cell and side: the side's original vertex pair
  const sideVerts = (c: number, k: number): [number, number] => [model.cells[c * 3 + k]!, model.cells[c * 3 + ((k + 1) % 3)]!]

  const out: (NavModel | null)[] = []
  for (let p = 0; p <= cuts.length; p++) {
    const lo = p === 0 ? -Infinity : cuts[p - 1]!
    const hi = p === cuts.length ? Infinity : cuts[p]!
    const b = new PieceBuilder()
    for (let c = 0; c < n; c++) {
      const ids = [model.cells[c * 3]!, model.cells[c * 3 + 1]!, model.cells[c * 3 + 2]!]
      let poly: (PEdge & { src: [number, number] | null })[] = ids.map((id, k) => ({ v: vert(id), label: k, src: [id, ids[(k + 1) % 3]!] as [number, number] }))
      // quick reject / accept on the axis
      const ax = ids.map(id => V[id * 3 + axis]!)
      if (Math.max(...ax) <= lo || Math.min(...ax) >= hi) continue
      if (lo > -Infinity) poly = clip(poly, axis, lo, 1, V)
      if (poly.length >= 3 && hi < Infinity) poly = clip(poly, axis, hi, -1, V)
      if (poly.length < 3) continue
      b.addPolygon(c, poly)
    }
    out.push(b.count ? b.build(keyOf(p), outline, inline, sideVerts) : null)
  }
  return out
}

/**
 * One Sutherland-Hodgman pass: keeps the part where sign * (v[axis] - at) >= 0. A kept piece of an original side keeps
 * its label and source pair; the new side along the plane is labelled -1.
 */
function clip<T extends PEdge & { src: [number, number] | null }>(poly: T[], axis: SplitAxis, at: number, sign: 1 | -1, V: Float32Array): T[] {
  const res: T[] = []
  const inside = (v: PVert) => sign * ((axis === 0 ? v.x : v.z) - at) >= 0
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!
    const next = poly[(i + 1) % poly.length]!
    const ci = inside(cur.v), ni = inside(next.v)
    if (ci) res.push(cur)
    if (ci !== ni) {
      const v = intersect(cur, next, axis, at, V)
      // entering: the new vertex starts the rest of the original side; leaving: it starts the cut side
      res.push({ ...cur, v, label: ci ? -1 : cur.label, src: ci ? null : cur.src } as T)
    }
  }
  return res
}

/**
 * The point where side cur -> next crosses the plane. On an original side, computed from its two original vertices in
 * index order, so both cells sharing the side get the same bits.
 */
function intersect(cur: PEdge & { src: [number, number] | null }, next: PEdge, axis: SplitAxis, at: number, V: Float32Array): PVert {
  let a: PVert = cur.v, b: PVert = next.v
  if (cur.src && cur.label >= 0) {
    const [i, j] = cur.src[0] < cur.src[1] ? cur.src : [cur.src[1], cur.src[0]]
    a = { x: V[i * 3]!, y: V[i * 3 + 1]!, z: V[i * 3 + 2]! }
    b = { x: V[j * 3]!, y: V[j * 3 + 1]!, z: V[j * 3 + 2]! }
  }
  const da = (axis === 0 ? a.x : a.z) - at
  const db = (axis === 0 ? b.x : b.z) - at
  const t = da / (da - db)
  const v = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
  if (axis === 0) v.x = at
  else v.z = at
  return v
}

class PieceBuilder {
  private readonly verts: number[] = []
  private readonly index = new Map<string, number>()
  private readonly tris: number[] = []
  /** Per triangle: the original cell. Per triangle side: label (0..2 original side, -1 cut, -2 fan diagonal). */
  private readonly origin: number[] = []
  private readonly labels: number[] = []

  get count(): number {
    return this.tris.length / 3
  }

  private vertex(v: PVert): number {
    const k = `${Math.round(v.x / WELD)},${Math.round(v.y / WELD)},${Math.round(v.z / WELD)}`
    let i = this.index.get(k)
    if (i === undefined) {
      i = this.verts.length / 3
      this.verts.push(v.x, v.y, v.z)
      this.index.set(k, i)
    }
    return i
  }

  addPolygon(cell: number, poly: readonly PEdge[]): void {
    const ids = poly.map(e => this.vertex(e.v))
    // drop repeated vertices (a clip exactly through a vertex)
    const vs: number[] = [], ls: number[] = []
    ids.forEach((id, i) => {
      if (vs.length && vs[vs.length - 1] === id) {
        // a zero-length side: the side leaving this point is the one that leaves the repeated vertex
        ls[ls.length - 1] = poly[i]!.label
        return
      }
      vs.push(id)
      ls.push(poly[i]!.label)
    })
    while (vs.length > 1 && vs[0] === vs[vs.length - 1]) {
      vs.pop()
      ls.pop()
    }
    if (vs.length < 3) return
    for (let k = 1; k + 1 < vs.length; k++) {
      const a = vs[0]!, b = vs[k]!, c = vs[k + 1]!
      if (this.area(a, b, c) < 1e-6) continue
      this.tris.push(a, b, c)
      this.origin.push(cell)
      // side a-b: the polygon's first side only for k = 1; side b-c: polygon side k; side c-a: polygon's last only at the end
      this.labels.push(k === 1 ? ls[0]! : -2, ls[k]!, k + 2 === vs.length ? ls[k + 1]! : -2)
    }
  }

  private area(a: number, b: number, c: number): number {
    const v = this.verts
    const abx = v[b * 3]! - v[a * 3]!, abz = v[b * 3 + 2]! - v[a * 3 + 2]!
    const acx = v[c * 3]! - v[a * 3]!, acz = v[c * 3 + 2]! - v[a * 3 + 2]!
    return Math.abs(abx * acz - abz * acx) / 2
  }

  build(key: string, outline: ReadonlyMap<string, number>, inline: ReadonlyMap<string, { c0: number; c1: number; flag: number }>, sideVerts: (c: number, k: number) => [number, number]): NavModel {
    const n = this.tris.length / 3
    if (this.verts.length / 3 > 0xffff || n >= 0xffff) throw new Error(`nav split ${key}: too big for 16-bit indices`)
    const sides = new Map<string, { t: number; k: number }[]>()
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < 3; k++) {
        const a = this.tris[t * 3 + k]!, b = this.tris[t * 3 + ((k + 1) % 3)]!
        const s = a < b ? `${a},${b}` : `${b},${a}`
        const list = sides.get(s)
        if (list) list.push({ t, k })
        else sides.set(s, [{ t, k }])
      }
    }
    const ov: number[] = [], oc: number[] = [], of: number[] = []
    const iv: number[] = [], ic: number[] = [], inf: number[] = []
    const origKey = (t: number, k: number): string | null => {
      const label = this.labels[t * 3 + k]!
      if (label < 0) return null
      const [a, b] = sideVerts(this.origin[t]!, label)
      return a < b ? `${a},${b}` : `${b},${a}`
    }
    for (const [s, list] of sides) {
      const [a, b] = s.split(',').map(Number) as [number, number]
      if (list.length === 1) {
        const { t, k } = list[0]!
        const ok = origKey(t, k)
        const flag = ok !== null && outline.has(ok) ? outline.get(ok)! : CUT_FLAG
        ov.push(a, b)
        oc.push(t, 0xffff)
        of.push(flag)
        continue
      }
      // two (or, on a bad mesh, more) triangles: inline between the first two
      const [p, q] = list as [{ t: number; k: number }, { t: number; k: number }]
      const ok = origKey(p.t, p.k) ?? origKey(q.t, q.k)
      const orig = ok !== null ? inline.get(ok) : undefined
      if (orig) {
        // keep the original cell order (directional flags): c0's piece first
        const pFirst = this.origin[p.t] === orig.c0 || this.origin[q.t] !== orig.c0
        iv.push(a, b)
        ic.push(pFirst ? p.t : q.t, pFirst ? q.t : p.t)
        inf.push(orig.flag)
      } else {
        iv.push(a, b)
        ic.push(p.t, q.t)
        inf.push(INLINE_FLAG)
      }
    }
    const edges = (v: number[], c: number[], f: number[]): NavEdges => ({ vertices: Uint16Array.from(v), cells: Uint16Array.from(c), flags: Uint8Array.from(f) })
    return {
      key,
      vertices: Float32Array.from(this.verts),
      cells: Uint16Array.from(this.tris),
      outline: edges(ov, oc, of),
      inline: edges(iv, ic, inf),
      events: [],
    }
  }
}

/** Total XZ area of a model's cells (file units²), for the split's conservation check. */
export function navModelArea(m: NavModel): number {
  let s = 0
  const v = m.vertices
  for (let t = 0; t < m.cells.length; t += 3) {
    const a = m.cells[t]!, b = m.cells[t + 1]!, c = m.cells[t + 2]!
    s += Math.abs((v[b * 3]! - v[a * 3]!) * (v[c * 3 + 2]! - v[a * 3 + 2]!) - (v[b * 3 + 2]! - v[a * 3 + 2]!) * (v[c * 3]! - v[a * 3]!)) / 2
  }
  return s
}
